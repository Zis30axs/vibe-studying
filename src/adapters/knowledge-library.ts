import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { z } from 'zod'
import {
  chosenKnowledgeChunkIdsSchema,
  knowledgeDocumentIdSchema,
  knowledgeDocumentSchema,
  knowledgeImportOptionsSchema,
  knowledgeSaveScopesInputSchema,
  knowledgeSearchInputSchema,
  knowledgeUpdateMetadataInputSchema,
  MAX_KNOWLEDGE_CHUNK_TEXT,
  MAX_KNOWLEDGE_DOCUMENTS,
  MAX_KNOWLEDGE_PAGE_TEXT,
  MAX_KNOWLEDGE_PAGES,
  MAX_KNOWLEDGE_PDF_BYTES,
  MAX_KNOWLEDGE_TEXT,
  type KnowledgeDocument,
  type KnowledgeEvidence,
  type KnowledgeHit,
  type KnowledgeImportResult,
  type KnowledgeImportOptions,
} from '../shared/knowledge'

const MAX_INDEX_BYTES = MAX_KNOWLEDGE_TEXT * 6 + 100_000
export const KNOWLEDGE_IMPORT_TIMEOUT_MS = 60_000
const extractedPagesSchema = z
  .array(z.string().max(MAX_KNOWLEDGE_PAGE_TEXT))
  .min(1)
  .max(MAX_KNOWLEDGE_PAGES)
  .refine((pages) => pages.reduce((sum, text) => sum + text.length, 0) <= MAX_KNOWLEDGE_TEXT)
const textIndexSchema = z.strictObject({
  version: z.literal(1),
  documentId: knowledgeDocumentIdSchema,
  pages: extractedPagesSchema,
})
const extractionMessageSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), pages: extractedPagesSchema }),
  z.strictObject({ ok: z.literal(false), code: z.string().max(80) }),
])

const errorMessages: Record<string, string> = {
  PDF_CANCELED: '已取消 PDF 导入',
  PDF_INVALID: '无法读取此 PDF，文件可能已损坏或格式不受支持',
  PDF_ENCRYPTED: '暂不支持加密或需要密码的 PDF，请先自行导出未加密副本',
  PDF_SIZE_LIMIT: 'PDF 文件不能超过 50 MiB',
  PDF_PAGE_LIMIT: 'PDF 不能超过 1500 页',
  PDF_TEXT_LIMIT: 'PDF 文本量超出安全上限，请拆分文件后重试',
  PDF_TIMEOUT: 'PDF 解析超时，请拆分文件或换用较小的 PDF',
  PDF_WORKER_FAILED: 'PDF 解析进程无法完成，请重试或换用其他 PDF',
  PDF_NOT_FOUND: '找不到这份本地 PDF，请重新导入',
  PDF_STORAGE_INVALID: '本地 PDF 数据损坏或不完整，请保留原文件并重新检查',
}
export class KnowledgeLibraryError extends Error {
  constructor(readonly code: string) {
    super(errorMessages[code] ?? '无法处理本地 PDF')
    this.name = 'KnowledgeLibraryError'
  }
}
function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new KnowledgeLibraryError('PDF_CANCELED')
}
function isMissing(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
}

/** Worker termination bounds both cancellation latency and pathological parser execution. */
export function extractKnowledgePdf(
  bytes: Uint8Array,
  options: { workerPath: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<string[]> {
  abortIfNeeded(options.signal)
  return new Promise((resolveResult, reject) => {
    const copy = new Uint8Array(bytes)
    const worker = new Worker(options.workerPath, {
      workerData: copy,
      transferList: [copy.buffer],
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
    })
    let settled = false
    const finish = (error?: Error, pages?: string[]) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      void worker.terminate().catch(() => undefined)
      if (error) reject(error)
      else resolveResult(pages!)
    }
    const onAbort = () => finish(new KnowledgeLibraryError('PDF_CANCELED'))
    const timer = setTimeout(
      () => finish(new KnowledgeLibraryError('PDF_TIMEOUT')),
      options.timeoutMs ?? KNOWLEDGE_IMPORT_TIMEOUT_MS,
    )
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) onAbort()
    worker.once('message', (message: unknown) => {
      const parsed = extractionMessageSchema.safeParse(message)
      if (!parsed.success) return finish(new KnowledgeLibraryError('PDF_WORKER_FAILED'))
      if (!parsed.data.ok) return finish(new KnowledgeLibraryError(parsed.data.code))
      finish(undefined, parsed.data.pages)
    })
    worker.once('error', () => finish(new KnowledgeLibraryError('PDF_WORKER_FAILED')))
    worker.once('exit', () => {
      if (!settled) finish(new KnowledgeLibraryError('PDF_WORKER_FAILED'))
    })
  })
}

async function readBounded(path: string, max: number): Promise<Uint8Array> {
  // lstat also rejects links on platforms that do not expose O_NOFOLLOW.
  if (!(await lstat(path)).isFile()) throw new KnowledgeLibraryError('PDF_STORAGE_INVALID')
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size < 1 || info.size > max)
      throw new KnowledgeLibraryError('PDF_STORAGE_INVALID')
    const bytes = Buffer.alloc(info.size + 1)
    let length = 0
    while (length < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, length, bytes.byteLength - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length !== info.size) throw new KnowledgeLibraryError('PDF_STORAGE_INVALID')
    return bytes.subarray(0, length)
  } finally {
    await handle.close()
  }
}
async function writePrivate(path: string, data: Uint8Array | string) {
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
}
function splitChunks(text: string): string[] {
  const chunks: string[] = []
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + MAX_KNOWLEDGE_CHUNK_TEXT, text.length)
    // Do not split a UTF-16 surrogate pair. Chunk IDs depend only on stored page text.
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--
    const chunk = text.slice(start, end).trim()
    if (chunk) chunks.push(chunk)
    start = end
  }
  return chunks
}
function normalized(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/\s+/gu, '')
}
function queryTerms(query: string): string[] {
  const words = [
    ...query
      .normalize('NFKC')
      .toLocaleLowerCase('zh-CN')
      .matchAll(/[\p{Script=Han}]+|[\p{L}\p{N}]+/gu),
  ].map((match) => match[0])
  return [
    ...new Set(
      words.flatMap((word) => {
        if (/^\p{Script=Han}+$/u.test(word) && word.length > 2)
          return [
            word,
            ...Array.from({ length: word.length - 1 }, (_, index) => word.slice(index, index + 2)),
          ]
        return [word]
      }),
    ),
  ].slice(0, 100)
}

/** A local, bounded, content-addressed library. Renderer data never chooses a file path. */
export class LocalKnowledgeLibrary {
  private readonly root: string
  private readonly workerPath: string
  private queue: Promise<unknown> = Promise.resolve()
  constructor(userDataPath: string, options: { workerPath?: string; timeoutMs?: number } = {}) {
    this.root = join(userDataPath, 'knowledge-library')
    this.workerPath = options.workerPath ?? resolve('dist-electron/knowledge-pdf-worker.cjs')
    this.timeoutMs = options.timeoutMs
  }
  private readonly timeoutMs?: number
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation).catch((error: unknown) => {
      // Do not expose native filesystem errors/absolute profile paths over IPC.
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        !(error instanceof KnowledgeLibraryError)
      )
        throw new KnowledgeLibraryError('PDF_STORAGE_INVALID')
      throw error
    })
    this.queue = result.catch(() => undefined)
    return result
  }
  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    if (!(await lstat(this.root)).isDirectory())
      throw new KnowledgeLibraryError('PDF_STORAGE_INVALID')
  }
  private async directory(id: string): Promise<string> {
    knowledgeDocumentIdSchema.parse(id)
    await this.ensureRoot()
    const path = join(this.root, id)
    try {
      if (!(await lstat(path)).isDirectory()) throw new KnowledgeLibraryError('PDF_STORAGE_INVALID')
    } catch (error) {
      if (isMissing(error)) throw new KnowledgeLibraryError('PDF_NOT_FOUND')
      throw error
    }
    return path
  }
  private async document(id: string): Promise<KnowledgeDocument> {
    const path = await this.directory(id)
    try {
      const document = knowledgeDocumentSchema.parse(
        JSON.parse(
          Buffer.from(await readBounded(join(path, 'document.json'), 100_000)).toString('utf8'),
        ),
      )
      if (document.id !== id) throw new Error('Identity mismatch')
      return document
    } catch {
      throw new KnowledgeLibraryError('PDF_STORAGE_INVALID')
    }
  }
  private async pages(document: KnowledgeDocument): Promise<string[]> {
    const path = await this.directory(document.id)
    try {
      const index = textIndexSchema.parse(
        JSON.parse(
          Buffer.from(await readBounded(join(path, 'text.json'), MAX_INDEX_BYTES)).toString('utf8'),
        ),
      )
      if (
        index.documentId !== document.id ||
        index.pages.length !== document.pageCount ||
        index.pages.filter((page) => page.trim()).length !== document.textPageCount
      )
        throw new Error('Index mismatch')
      return index.pages
    } catch {
      throw new KnowledgeLibraryError('PDF_STORAGE_INVALID')
    }
  }
  private async listInternal(): Promise<KnowledgeDocument[]> {
    await this.ensureRoot()
    const ids = (await readdir(this.root, { withFileTypes: true }))
      .filter((entry) => knowledgeDocumentIdSchema.safeParse(entry.name).success)
      .map((entry) => entry.name)
    if (ids.length > MAX_KNOWLEDGE_DOCUMENTS) throw new KnowledgeLibraryError('PDF_STORAGE_INVALID')
    const documents = await Promise.all(ids.map((id) => this.document(id)))
    return documents.sort(
      (a, b) => b.importedAt.localeCompare(a.importedAt) || a.id.localeCompare(b.id),
    )
  }
  list(): Promise<KnowledgeDocument[]> {
    return this.serialize(() => this.listInternal())
  }
  importBytes(
    title: string,
    bytes: Uint8Array,
    options: KnowledgeImportOptions & { signal?: AbortSignal } = {},
  ): Promise<KnowledgeImportResult> {
    const safeTitle = z.string().trim().min(1).max(200).parse(title)
    const { signal, ...metadataInput } = options
    const metadata = knowledgeImportOptionsSchema.parse(metadataInput)
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength < 5 ||
      bytes.byteLength > MAX_KNOWLEDGE_PDF_BYTES
    )
      return Promise.reject(new KnowledgeLibraryError('PDF_SIZE_LIMIT'))
    // Copy at the trusted boundary: callers cannot change the bytes after hashing.
    const source = new Uint8Array(bytes)
    return this.serialize(async () => {
      abortIfNeeded(signal)
      if (Buffer.from(source.subarray(0, 5)).toString('ascii') !== '%PDF-')
        throw new KnowledgeLibraryError('PDF_INVALID')
      const id = createHash('sha256').update(source).digest('hex')
      const documents = await this.listInternal()
      const existing = documents.find((document) => document.id === id)
      if (existing) {
        // Verify the existing source and index before declaring deduplication successful.
        await this.bytesInternal(existing)
        await this.pages(existing)
        abortIfNeeded(signal)
        // Deduplication never silently changes the existing book's subject or metadata.
        return { canceled: false, document: existing, duplicate: true }
      }
      if (documents.length >= MAX_KNOWLEDGE_DOCUMENTS) throw new Error('知识库最多保存 100 份 PDF')
      const pages = await extractKnowledgePdf(source, {
        workerPath: this.workerPath,
        signal,
        timeoutMs: this.timeoutMs,
      })
      abortIfNeeded(signal)
      const document = knowledgeDocumentSchema.parse({
        id,
        title: safeTitle,
        ...metadata,
        byteLength: source.byteLength,
        pageCount: pages.length,
        textPageCount: pages.filter((page) => page.trim()).length,
        importedAt: new Date().toISOString(),
        scopes: [],
      })
      const staging = join(this.root, `.import-${randomUUID()}`)
      await mkdir(staging, { mode: 0o700 })
      try {
        await writePrivate(join(staging, 'source.pdf'), source)
        await writePrivate(
          join(staging, 'text.json'),
          JSON.stringify({ version: 1, documentId: id, pages }),
        )
        await writePrivate(join(staging, 'document.json'), JSON.stringify(document))
        abortIfNeeded(signal)
        // This rename is the commit point. Late cancellation must not hide saved work.
        await rename(staging, join(this.root, id))
        return { canceled: false, document, duplicate: false }
      } finally {
        await rm(staging, { recursive: true, force: true })
      }
    })
  }
  private async bytesInternal(document: KnowledgeDocument): Promise<Uint8Array> {
    const path = await this.directory(document.id)
    const bytes = await readBounded(join(path, 'source.pdf'), MAX_KNOWLEDGE_PDF_BYTES)
    if (
      bytes.byteLength !== document.byteLength ||
      createHash('sha256').update(bytes).digest('hex') !== document.id
    )
      throw new KnowledgeLibraryError('PDF_STORAGE_INVALID')
    return new Uint8Array(bytes)
  }
  getBytes(id: string): Promise<Uint8Array> {
    knowledgeDocumentIdSchema.parse(id)
    return this.serialize(async () => this.bytesInternal(await this.document(id)))
  }
  search(input: unknown): Promise<KnowledgeHit[]> {
    const request = knowledgeSearchInputSchema.parse(input)
    return this.serialize(async () => {
      const document = await this.document(request.documentId)
      if (request.subject && request.subject !== document.subject)
        throw new Error('所选教材与检索学科不一致，请重新选择教材')
      const scope = request.scopeId
        ? document.scopes.find((candidate) => candidate.id === request.scopeId)
        : undefined
      if (request.scopeId && !scope) throw new Error('找不到所选章节，请重新选择')
      const start = scope?.startPage ?? request.startPage ?? 1
      const end = scope?.endPage ?? request.endPage ?? document.pageCount
      if (start > document.pageCount || end > document.pageCount)
        throw new Error('检索页码超出文档范围')
      const pages = await this.pages(document)
      const phrase = normalized(request.query)
      const terms = queryTerms(request.query)
      if (!terms.length) return []
      const hits: KnowledgeHit[] = []
      for (let page = start; page <= end; page++) {
        splitChunks(pages[page - 1]).forEach((text, chunk) => {
          const searchable = normalized(text)
          const score =
            (searchable.includes(phrase) ? 100 : 0) +
            terms.reduce(
              (sum, term) => sum + (searchable.includes(term) ? Math.min(term.length, 20) : 0),
              0,
            )
          if (score > 0)
            hits.push({
              chunkId: `${document.id}:p${page}:c${chunk + 1}`,
              documentId: document.id,
              documentTitle: document.title,
              subject: document.subject,
              pageNumber: page,
              text,
              score,
            })
        })
      }
      return hits
        .sort(
          (a, b) =>
            b.score - a.score || a.pageNumber - b.pageNumber || a.chunkId.localeCompare(b.chunkId),
        )
        .slice(0, request.limit ?? 15)
    })
  }
  saveScopes(input: unknown): Promise<KnowledgeDocument> {
    const request = knowledgeSaveScopesInputSchema.parse(input)
    return this.serialize(async () => {
      const document = knowledgeDocumentSchema.parse({
        ...(await this.document(request.documentId)),
        scopes: request.scopes,
      })
      await this.writeMetadata(document)
      return document
    })
  }
  private async writeMetadata(document: KnowledgeDocument): Promise<void> {
    const directory = await this.directory(document.id)
    const temporary = join(directory, `document.${randomUUID()}.tmp`)
    try {
      await writePrivate(temporary, JSON.stringify(document))
      await rename(temporary, join(directory, 'document.json'))
    } finally {
      await rm(temporary, { force: true })
    }
  }
  updateDocumentMetadata(input: unknown): Promise<KnowledgeDocument> {
    const { documentId, ...metadata } = knowledgeUpdateMetadataInputSchema.parse(input)
    return this.serialize(async () => {
      const previous = await this.document(documentId)
      const document = knowledgeDocumentSchema.parse({
        ...previous,
        ...Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined)),
        // Editing a version label alone must not carry over its old verification claim.
        editionConfirmed:
          metadata.editionConfirmed ??
          (metadata.edition !== undefined && metadata.edition !== previous.edition
            ? false
            : previous.editionConfirmed),
      })
      // Only document.json changes: source bytes, extracted text, scopes and IDs remain intact.
      await this.writeMetadata(document)
      return document
    })
  }
  resolveChunks(input: string[]): Promise<KnowledgeEvidence[]> {
    const ids = chosenKnowledgeChunkIdsSchema.parse(input)
    return this.serialize(async () => {
      const cache = new Map<string, { document: KnowledgeDocument; pages: string[] }>()
      const evidence: KnowledgeEvidence[] = []
      for (const chunkId of ids) {
        const [documentId, physical, chunk] = chunkId.split(':')
        let source = cache.get(documentId)
        if (!source) {
          const document = await this.document(documentId)
          source = { document, pages: await this.pages(document) }
          cache.set(documentId, source)
        }
        const pageNumber = Number(physical.slice(1))
        const text = splitChunks(source.pages[pageNumber - 1] ?? '')[Number(chunk.slice(1)) - 1]
        if (!text) throw new Error('引用的 PDF 片段不存在，请重新检索选择')
        evidence.push({
          chunkId,
          documentId,
          documentTitle: source.document.title,
          subject: source.document.subject,
          pageNumber,
          text,
        })
      }
      return evidence
    })
  }
}
