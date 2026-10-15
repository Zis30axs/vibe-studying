import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readdir, unlink } from 'node:fs/promises'
import { z } from 'zod'
import { AtomicJsonStore, readJsonFile } from './atomic-json-store'
import { embeddingScopeSchema, type EmbeddingScope } from '../shared/embeddings'
import {
  knowledgeChunkIdSchema,
  type KnowledgeEvidence,
  type KnowledgeHit,
} from '../shared/knowledge'

export const embeddingTextHash = (text: string) => createHash('sha256').update(text).digest('hex')
export const embeddingFingerprint = (baseUrl: string, model: string) =>
  embeddingTextHash(JSON.stringify(['openai-embeddings', baseUrl, model]))
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u)
export const embeddingVectorSchema = z
  .array(z.number().finite().min(-1e20).max(1e20))
  .min(1)
  .max(4096)
  .refine((vector) => vector.some((number) => number !== 0), 'Embedding 向量不能全为零')
const entrySchema = z.strictObject({
  chunkId: knowledgeChunkIdSchema,
  pageNumber: z.number().int().min(1).max(1500),
  textSha256: hashSchema,
  vector: embeddingVectorSchema,
})
const indexSchema = z
  .strictObject({
    version: z.literal(1),
    fingerprint: hashSchema,
    subject: embeddingScopeSchema.shape.subject,
    documentId: embeddingScopeSchema.shape.documentId,
    dimensions: z.number().int().min(1).max(4096),
    entries: z.array(entrySchema).max(128),
  })
  .refine(
    (value) =>
      new Set(value.entries.map((entry) => entry.chunkId)).size === value.entries.length &&
      value.entries.every(
        (entry) =>
          entry.vector.length === value.dimensions &&
          entry.chunkId.startsWith(`${value.documentId}:p${entry.pageNumber}:`),
      ),
  )
type StoredIndex = z.infer<typeof indexSchema>

function cosine(a: number[], b: number[]) {
  let dot = 0,
    aa = 0,
    bb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    aa += a[i] ** 2
    bb += b[i] ** 2
  }
  return dot / Math.sqrt(aa * bb)
}
/** Derived vectors only: no textbook text, answers, labels, or credentials are persisted here. */
export class KnowledgeVectorIndex {
  private stores = new Map<string, AtomicJsonStore<StoredIndex>>()
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private directory: string) {}
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation)
    this.queue = result.catch(() => undefined)
    return result
  }
  clear(scope: EmbeddingScope): Promise<void> {
    return this.serialize(() => this.clearInternal(scope))
  }
  private async clearInternal(scope: EmbeddingScope): Promise<void> {
    embeddingScopeSchema.parse(scope)
    const prefix = `${scope.subject}-${scope.documentId}-`
    try {
      const names = await readdir(join(this.directory, 'knowledge-vectors'))
      for (const name of names) {
        if (!name.startsWith(prefix) || !/^[a-z]+-[a-f0-9]{64}-[a-f0-9]{64}\.json$/u.test(name))
          continue
        const fingerprint = name.slice(prefix.length, -5)
        let current: StoredIndex
        try {
          current = indexSchema.parse(
            await readJsonFile(join(this.directory, 'knowledge-vectors', name)),
          )
        } catch {
          await this.discard(scope, fingerprint)
          continue
        }
        if (
          current.subject !== scope.subject ||
          current.documentId !== scope.documentId ||
          current.fingerprint !== fingerprint
        ) {
          await this.discard(scope, fingerprint)
          continue
        }
        const store = this.store(scope, fingerprint, current.dimensions)
        await store.update((value) => ({
          ...value,
          entries: value.entries.filter(
            (entry) => entry.pageNumber < scope.startPage || entry.pageNumber > scope.endPage,
          ),
        }))
      }
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'))
        throw new Error('本地向量索引无法清除，请关闭其他占用后重试。')
    }
  }
  private async discard(scope: EmbeddingScope, fingerprint: string) {
    const key = `${scope.subject}-${scope.documentId}-${fingerprint}`
    this.stores.delete(key)
    try {
      await unlink(join(this.directory, 'knowledge-vectors', `${key}.json`))
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'))
        throw new Error('本地向量索引无法失效，已停用向量检索。')
    }
  }
  private store(scope: EmbeddingScope, fingerprint: string, dimensions: number) {
    embeddingScopeSchema.parse(scope)
    hashSchema.parse(fingerprint)
    const key = `${scope.subject}-${scope.documentId}-${fingerprint}`
    let store = this.stores.get(key)
    if (!store) {
      store = new AtomicJsonStore(
        join(this.directory, 'knowledge-vectors', `${key}.json`),
        indexSchema,
        () => ({
          version: 1,
          fingerprint,
          subject: scope.subject,
          documentId: scope.documentId,
          dimensions,
          entries: [],
        }),
      )
      this.stores.set(key, store)
    }
    return store
  }
  put(
    scope: EmbeddingScope,
    fingerprint: string,
    evidence: KnowledgeEvidence[],
    vectors: number[][],
    isCurrent: () => boolean = () => true,
  ) {
    return this.serialize(() => this.putInternal(scope, fingerprint, evidence, vectors, isCurrent))
  }
  private async putInternal(
    scope: EmbeddingScope,
    fingerprint: string,
    evidence: KnowledgeEvidence[],
    vectors: number[][],
    isCurrent: () => boolean,
  ) {
    if (!evidence.length || evidence.length !== vectors.length)
      throw new Error('Embedding 索引输入不完整。')
    const parsed = z.array(embeddingVectorSchema).min(1).max(3).parse(vectors)
    const dimensions = parsed[0].length
    if (
      parsed.some((vector) => vector.length !== dimensions) ||
      evidence.some(
        (item) =>
          item.subject !== scope.subject ||
          item.documentId !== scope.documentId ||
          item.pageNumber < scope.startPage ||
          item.pageNumber > scope.endPage,
      )
    )
      throw new Error('Embedding 索引范围或维度不一致。')
    let store = this.store(scope, fingerprint, dimensions)
    // Corrupt derived data can be discarded; original knowledge and learning records are never touched.
    try {
      const existing = await store.load()
      if (
        existing.subject !== scope.subject ||
        existing.documentId !== scope.documentId ||
        existing.fingerprint !== fingerprint
      )
        throw new Error('Index identity mismatch')
    } catch {
      await this.discard(scope, fingerprint)
      store = this.store(scope, fingerprint, dimensions)
    }
    try {
      await store.update((current) => {
        if (!isCurrent()) throw new Error('Index canceled')
        return {
          ...current,
          dimensions,
          entries: [
            ...(current.dimensions === dimensions
              ? current.entries.filter(
                  (entry) => !evidence.some((item) => item.chunkId === entry.chunkId),
                )
              : []),
            ...evidence.map((item, i) => ({
              chunkId: item.chunkId,
              pageNumber: item.pageNumber,
              textSha256: embeddingTextHash(item.text),
              vector: parsed[i],
            })),
          ].slice(-128),
        }
      })
      if (!isCurrent()) {
        await this.discard(scope, fingerprint)
        throw new Error('Index canceled')
      }
    } catch {
      throw new Error('本地向量索引无法保存；原教材和学习记录未修改。')
    }
  }
  search(
    scope: EmbeddingScope,
    fingerprint: string,
    query: number[],
    resolveChunks: (ids: string[]) => Promise<KnowledgeEvidence[]>,
  ): Promise<{ hits: KnowledgeHit[]; valid: boolean }> {
    // Validate before any invalidation path can derive a filename from caller input.
    const safeScope = embeddingScopeSchema.parse(scope)
    const safeFingerprint = hashSchema.parse(fingerprint)
    return this.serialize(() =>
      this.searchInternal(safeScope, safeFingerprint, query, resolveChunks),
    )
  }
  private async searchInternal(
    scope: EmbeddingScope,
    fingerprint: string,
    query: number[],
    resolveChunks: (ids: string[]) => Promise<KnowledgeEvidence[]>,
  ): Promise<{ hits: KnowledgeHit[]; valid: boolean }> {
    const vector = embeddingVectorSchema.parse(query)
    let state: StoredIndex
    const invalid = async () => {
      await this.discard(scope, fingerprint).catch(() => undefined)
      return { hits: [], valid: false }
    }
    try {
      state = await this.store(scope, fingerprint, vector.length).load()
    } catch {
      return invalid()
    }
    if (
      state.fingerprint !== fingerprint ||
      state.subject !== scope.subject ||
      state.documentId !== scope.documentId ||
      state.dimensions !== vector.length
    )
      return invalid()
    if (!state.entries.length) return { hits: [], valid: false }
    const hits: KnowledgeHit[] = []
    for (const entry of state.entries.filter(
      (candidate) =>
        candidate.pageNumber >= scope.startPage && candidate.pageNumber <= scope.endPage,
    )) {
      // Resolve one at a time through the original source integrity check and authorization boundary.
      let current: KnowledgeEvidence[]
      try {
        current = await resolveChunks([entry.chunkId])
      } catch {
        return invalid()
      }
      const item = current[0]
      if (
        !item ||
        item.chunkId !== entry.chunkId ||
        item.documentId !== scope.documentId ||
        item.subject !== scope.subject ||
        item.pageNumber !== entry.pageNumber ||
        embeddingTextHash(item.text) !== entry.textSha256
      )
        return invalid()
      hits.push({ ...item, score: Math.max(0, cosine(vector, entry.vector)) })
    }
    const positive = hits
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId))
      .slice(0, 15)
    return { hits: positive, valid: positive.length > 0 }
  }
}
