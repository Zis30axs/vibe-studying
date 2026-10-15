import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { AtomicJsonStore } from './atomic-json-store'
import type { ModelSecretStorage } from './model-profile-store'
import type { LocalKnowledgeLibrary } from './knowledge-library'
import { secureFetch } from './model-transport'
import { containsCredentialText } from './credential-reflection'
import {
  KnowledgeVectorIndex,
  embeddingFingerprint,
  embeddingTextHash,
  embeddingVectorSchema,
} from './knowledge-vector-index'
import {
  EMBEDDING_DIAGNOSTIC_TEXT,
  embeddingBaseUrlSchema,
  embeddingConfigInputSchema,
  embeddingPrepareSchema,
  embeddingScopeSchema,
  type EmbeddingConfig,
  type EmbeddingConfigInput,
  type EmbeddingDiagnostic,
  type EmbeddingPrepareInput,
  type EmbeddingPreview,
  type EmbeddingResult,
  type EmbeddingScope,
} from '../shared/embeddings'
import {
  knowledgeSearchInputSchema,
  type KnowledgeEvidence,
  type KnowledgeSearchInput,
} from '../shared/knowledge'
import { modelIdSchema } from '../shared/model-id'

const keySchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .regex(/^[^\u0000-\u001f\u007f]*$/u)
const stateSchema = z.strictObject({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  enabled: z.boolean(),
  baseUrl: embeddingBaseUrlSchema,
  model: modelIdSchema,
  encryptedApiKey: z.string().max(32768).optional(),
})
type State = z.infer<typeof stateSchema>
const confirmationSchema = z.strictObject({
  previewId: z.string().uuid(),
  cloudConsent: z.literal(true),
})
const diagnosticSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  cloudConsent: z.literal(true),
})
const stale = () => new EmbeddingError('Embedding 设置或教材内容已更改，请重新预览并确认本次操作。')
const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_INPUT_BYTES = 20000
export class EmbeddingError extends Error {}
class EmbeddingFailure extends EmbeddingError {}
async function readResponse(response: Response, signal: AbortSignal): Promise<string> {
  const declared = response.headers.get('content-length')
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES))
    throw new EmbeddingFailure('Embedding 返回内容过大。')
  const reader = response.body?.getReader()
  if (!reader) throw new EmbeddingFailure('Embedding 返回内容为空。')
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      if (signal.aborted) throw new EmbeddingFailure('Embedding 请求已取消。')
      const { value, done } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_RESPONSE_BYTES) throw new EmbeddingFailure('Embedding 返回内容过大。')
      chunks.push(value)
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    void reader.cancel().catch(() => undefined)
  }
}

/** Main-process provider boundary. Preparation/local retrieval never sends network requests. */
export class EmbeddingService {
  private store: AtomicJsonStore<State>
  private vectors: KnowledgeVectorIndex
  private session: { key: string; baseUrl: string } | undefined
  private previews = new Map<
    string,
    { preview: EmbeddingPreview; input: EmbeddingPrepareInput; evidence: KnowledgeEvidence[] }
  >()
  private queryCache = new Map<string, number[]>()
  private running = new Set<AbortController>()
  private epoch = 0
  constructor(
    directory: string,
    private options: {
      library: Pick<LocalKnowledgeLibrary, 'resolveChunks' | 'search'>
      secureStorage?: ModelSecretStorage
      fetchImpl?: typeof fetch
      timeoutMs?: number
      now?: () => number
    },
  ) {
    this.store = new AtomicJsonStore(join(directory, 'embedding-config.json'), stateSchema, () => ({
      version: 1,
      revision: 0,
      enabled: false,
      baseUrl: 'https://api.openai.com/v1',
      model: 'text-embedding-3-small',
    }))
    this.vectors = new KnowledgeVectorIndex(directory)
  }
  private now() {
    return this.options.now?.() ?? Date.now()
  }
  private available() {
    try {
      return !!this.options.secureStorage?.isAvailable()
    } catch {
      return false
    }
  }
  private async state() {
    try {
      return await this.store.load()
    } catch {
      throw new EmbeddingError('无法读取 Embedding 设置；请保留原配置并恢复备份。')
    }
  }
  private secret(state: State): { key: string; keyStatus: EmbeddingConfig['keyStatus'] } {
    if (this.session?.baseUrl === state.baseUrl)
      return { key: this.session.key, keyStatus: 'session' }
    if (!state.encryptedApiKey) return { key: '', keyStatus: 'missing' }
    if (!this.available()) return { key: '', keyStatus: 'locked' }
    try {
      const envelope = z
        .strictObject({
          kind: z.literal('examcraft-embedding'),
          baseUrl: z.string(),
          apiKey: keySchema,
        })
        .parse(JSON.parse(this.options.secureStorage!.decryptString(state.encryptedApiKey)))
      if (envelope.baseUrl !== state.baseUrl) throw new EmbeddingError()
      return { key: envelope.apiKey, keyStatus: 'saved' }
    } catch {
      return { key: '', keyStatus: 'locked' }
    }
  }
  async getConfig(): Promise<EmbeddingConfig> {
    const state = await this.state(),
      secret = this.secret(state)
    return {
      enabled: state.enabled,
      baseUrl: state.baseUrl,
      model: state.model,
      revision: state.revision,
      configured: !!secret.key,
      keyStatus: secret.keyStatus,
      secureStorageAvailable: this.available(),
    }
  }
  async saveConfig(raw: unknown): Promise<EmbeddingConfig> {
    const parsed = embeddingConfigInputSchema.safeParse(raw)
    if (!parsed.success) throw new EmbeddingError('Embedding 设置无效，请检查地址、模型和密钥。')
    const input = parsed.data
    let sessionChange: { key: string; baseUrl: string } | null | undefined
    try {
      await this.store.update((previous) => {
        if (previous.revision !== input.expectedRevision) throw stale()
        const existingKey = this.secret(previous).key
        const key = input.clearApiKey
          ? ''
          : input.apiKey || (previous.baseUrl === input.baseUrl ? existingKey : '')
        if (
          key &&
          (containsCredentialText(input.baseUrl, key) || containsCredentialText(input.model, key))
        )
          throw new EmbeddingFailure('Embedding 地址或模型不能包含 API Key。')
        const next: State = {
          version: 1,
          revision: previous.revision + 1,
          enabled: input.enabled,
          baseUrl: input.baseUrl,
          model: input.model,
        }
        if (previous.baseUrl === next.baseUrl && !input.clearApiKey && previous.encryptedApiKey)
          next.encryptedApiKey = previous.encryptedApiKey
        if (previous.baseUrl !== next.baseUrl || input.clearApiKey) sessionChange = null
        if (input.apiKey && !input.clearApiKey) {
          if (input.persistApiKey) {
            if (!this.available())
              throw new EmbeddingFailure('系统安全存储不可用，密钥未保存；可选择仅本次会话使用。')
            try {
              next.encryptedApiKey = this.options.secureStorage!.encryptString(
                JSON.stringify({
                  kind: 'examcraft-embedding',
                  baseUrl: next.baseUrl,
                  apiKey: input.apiKey,
                }),
              )
              if (
                !next.encryptedApiKey ||
                next.encryptedApiKey === input.apiKey ||
                next.encryptedApiKey.length % 4 !== 0 ||
                !/^[A-Za-z0-9+/]+={0,2}$/u.test(next.encryptedApiKey)
              )
                throw new EmbeddingError()
            } catch {
              throw new EmbeddingFailure('系统无法加密 Embedding 密钥；不会保存明文。')
            }
            sessionChange = null
          } else {
            delete next.encryptedApiKey
            sessionChange = { key: input.apiKey, baseUrl: next.baseUrl }
          }
        }
        return next
      })
    } catch (error) {
      if (
        error instanceof EmbeddingFailure ||
        (error instanceof Error && error.message === stale().message)
      )
        throw error
      throw new EmbeddingError('Embedding 设置无法保存；原配置未覆盖。')
    }
    if (sessionChange !== undefined) this.session = sessionChange ?? undefined
    this.epoch++
    this.previews.clear()
    this.queryCache.clear()
    for (const controller of this.running) controller.abort()
    return this.getConfig()
  }
  private async resolve(revision: number) {
    const state = await this.state()
    if (state.revision !== revision) throw stale()
    const secret = this.secret(state)
    if (!state.enabled || !secret.key)
      throw new EmbeddingError(
        secret.keyStatus === 'locked'
          ? 'Embedding 密钥暂时无法解锁，请重新输入。'
          : '请先启用并配置独立的 Embedding API Key；关键词检索仍可使用。',
      )
    return { state, key: secret.key }
  }
  private async request(
    revision: number,
    input: string[],
    epoch = this.epoch,
  ): Promise<number[][]> {
    const { state, key } = await this.resolve(revision)
    if (this.epoch !== epoch) throw stale()
    if (
      !input.length ||
      input.length > 3 ||
      input.some((text) => !text.trim()) ||
      Buffer.byteLength(JSON.stringify(input)) > MAX_INPUT_BYTES
    )
      throw new EmbeddingFailure('Embedding 输入超出本次允许的范围。')
    const controller = new AbortController()
    this.running.add(controller)
    const endpoint = state.baseUrl.endsWith('/embeddings')
      ? state.baseUrl
      : `${state.baseUrl}/embeddings`
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort: (() => void) | undefined
    const canceled = new Promise<never>((_, reject) => {
      abort = () => reject(new EmbeddingFailure('Embedding 请求已取消或超时。'))
      controller.signal.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15000)
    })
    try {
      return await Promise.race([
        canceled,
        (async () => {
          const response = await (this.options.fetchImpl ?? secureFetch)(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
            body: JSON.stringify({ model: state.model, input, encoding_format: 'float' }),
            redirect: 'error',
            signal: controller.signal,
          })
          if (!response.ok || response.redirected) {
            void response.body?.cancel().catch(() => undefined)
            throw new EmbeddingFailure(
              [401, 403].includes(response.status)
                ? 'Embedding 凭据被拒绝，请检查独立 API Key。'
                : response.status === 429
                  ? 'Embedding 请求过于频繁，请稍后重试。'
                  : 'Embedding 服务返回错误，请检查地址与模型。',
            )
          }
          const raw = await readResponse(response, controller.signal)
          if (containsCredentialText(raw, key))
            throw new EmbeddingFailure('Embedding 响应未通过安全检查。')
          let envelope: { data: { index: number; embedding: number[] }[] }
          try {
            envelope = z
              .object({
                data: z
                  .array(
                    z.object({
                      index: z.number().int().nonnegative(),
                      embedding: embeddingVectorSchema,
                    }),
                  )
                  .length(input.length),
              })
              .parse(JSON.parse(raw))
          } catch {
            throw new EmbeddingFailure('Embedding 响应格式、数量或向量无效。')
          }
          const ordered = envelope.data.sort((a, b) => a.index - b.index)
          if (
            ordered.some(
              (item, i) =>
                item.index !== i || item.embedding.length !== ordered[0].embedding.length,
            )
          )
            throw new EmbeddingFailure('Embedding 响应序号或向量维度不一致。')
          if (controller.signal.aborted || (await this.state()).revision !== revision) throw stale()
          return ordered.map((item) => item.embedding)
        })(),
      ])
    } catch (error) {
      if (error instanceof EmbeddingFailure) throw error
      throw new EmbeddingFailure('Embedding 连接失败；请检查网络、地址和接口兼容性。')
    } finally {
      clearTimeout(timer)
      if (abort) controller.signal.removeEventListener('abort', abort)
      controller.abort()
      this.running.delete(controller)
    }
  }
  async diagnose(raw: unknown): Promise<EmbeddingDiagnostic> {
    const input = diagnosticSchema.safeParse(raw)
    if (!input.success)
      throw new EmbeddingError('连接诊断需要确认将固定测试句发送至 Embedding 服务。')
    const started = this.now()
    try {
      const vectors = await this.request(input.data.expectedRevision, [EMBEDDING_DIAGNOSTIC_TEXT])
      return {
        ok: true,
        dimensions: vectors[0].length,
        latencyMs: Math.max(0, this.now() - started),
      }
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof EmbeddingFailure
            ? error.message
            : 'Embedding 设置已更改或尚未配置，请重新确认。',
      }
    }
  }
  private async evidence(input: EmbeddingPrepareInput) {
    if (input.kind === 'search' && !input.chunkIds.length) {
      // Even a query with no keyword hit must recheck the canonical document/subject/pages/source.
      await this.options.library.search({
        subject: input.subject,
        documentId: input.documentId,
        startPage: input.startPage,
        endPage: input.endPage,
        query: input.query!,
        limit: 1,
      })
      return []
    }
    const evidence = await this.options.library.resolveChunks(input.chunkIds)
    if (
      evidence.length !== input.chunkIds.length ||
      evidence.some(
        (item, i) =>
          item.chunkId !== input.chunkIds[i] ||
          item.subject !== input.subject ||
          item.documentId !== input.documentId ||
          item.pageNumber < input.startPage ||
          item.pageNumber > input.endPage,
      )
    )
      throw new EmbeddingError('教材片段不在本次学科、文档和页码授权范围。')
    return evidence
  }
  async prepare(raw: unknown): Promise<EmbeddingPreview> {
    const epoch = this.epoch
    const parsed = embeddingPrepareSchema.safeParse(raw)
    if (!parsed.success)
      throw new EmbeddingError('Embedding 操作范围无效，请重新选择至多三个教材片段。')
    const input = parsed.data
    const { state } = await this.resolve(input.expectedRevision)
    const evidence = await this.evidence(input)
    if ((await this.state()).revision !== input.expectedRevision || this.epoch !== epoch)
      throw stale()
    const preview: EmbeddingPreview = {
      previewId: randomUUID(),
      kind: input.kind,
      baseUrl: state.baseUrl,
      model: state.model,
      revision: state.revision,
      subject: input.subject,
      documentId: input.documentId,
      startPage: input.startPage,
      endPage: input.endPage,
      expiresAt: new Date(this.now() + 5 * 60000).toISOString(),
      texts:
        input.kind === 'search'
          ? [{ text: input.query!, sha256: embeddingTextHash(input.query!) }]
          : evidence.map((item) => ({
              chunkId: item.chunkId,
              pageNumber: item.pageNumber,
              text: item.text,
              sha256: embeddingTextHash(item.text),
            })),
    }
    // Small, expiring, main-process tickets bind consent to the exact payload and destination.
    for (const [id, entry] of this.previews)
      if (Date.parse(entry.preview.expiresAt) <= this.now()) this.previews.delete(id)
    if (this.previews.size >= 20) this.previews.delete(this.previews.keys().next().value!)
    this.previews.set(preview.previewId, {
      preview: structuredClone(preview),
      input: structuredClone(input),
      evidence: structuredClone(evidence),
    })
    return structuredClone(preview)
  }
  private cacheKey(scope: EmbeddingScope, fingerprint: string, query: string) {
    return embeddingTextHash(
      JSON.stringify([
        scope.subject,
        scope.documentId,
        scope.startPage,
        scope.endPage,
        fingerprint,
        query,
      ]),
    )
  }
  async confirm(raw: unknown): Promise<EmbeddingResult> {
    const epoch = this.epoch
    const parsed = confirmationSchema.safeParse(raw)
    if (!parsed.success) throw new EmbeddingError('请明确确认发送本次预览内容。')
    const ticket = this.previews.get(parsed.data.previewId)
    this.previews.delete(parsed.data.previewId)
    if (!ticket || Date.parse(ticket.preview.expiresAt) <= this.now()) throw stale()
    const { state } = await this.resolve(ticket.input.expectedRevision)
    const current = await this.evidence(ticket.input)
    if (
      this.epoch !== epoch ||
      current.some(
        (item, i) => embeddingTextHash(item.text) !== embeddingTextHash(ticket.evidence[i].text),
      )
    )
      throw stale()
    const fingerprint = embeddingFingerprint(state.baseUrl, state.model)
    const scope: EmbeddingScope = {
      subject: ticket.input.subject,
      documentId: ticket.input.documentId,
      startPage: ticket.input.startPage,
      endPage: ticket.input.endPage,
    }
    try {
      const vectors = await this.request(
        state.revision,
        ticket.preview.texts.map((item) => item.text),
        epoch,
      )
      const afterRequest = await this.evidence(ticket.input)
      if (
        afterRequest.some(
          (item, i) => embeddingTextHash(item.text) !== embeddingTextHash(current[i].text),
        ) ||
        (await this.state()).revision !== state.revision ||
        this.epoch !== epoch
      )
        throw stale()
      if (ticket.input.kind === 'index') {
        await this.vectors.put(
          scope,
          fingerprint,
          afterRequest,
          vectors,
          () => this.epoch === epoch,
        )
        if (this.epoch !== epoch) throw stale()
        return { mode: 'indexed', indexedCount: current.length }
      }
      const cacheKey = this.cacheKey(ticket.input, fingerprint, ticket.input.query!)
      if (this.queryCache.size >= 100) this.queryCache.delete(this.queryCache.keys().next().value!)
      this.queryCache.set(cacheKey, vectors[0])
      return this.searchLocal({
        documentId: ticket.input.documentId,
        subject: ticket.input.subject,
        startPage: ticket.input.startPage,
        endPage: ticket.input.endPage,
        query: ticket.input.query!,
        limit: 15,
      })
    } catch (error) {
      if (this.epoch !== epoch) throw stale()
      if (ticket.input.kind === 'index') throw error
      return this.keyword(
        {
          documentId: ticket.input.documentId,
          subject: ticket.input.subject,
          startPage: ticket.input.startPage,
          endPage: ticket.input.endPage,
          query: ticket.input.query!,
          limit: 15,
        },
        error instanceof EmbeddingFailure ? error.message : '向量检索暂不可用，已使用本地关键词。',
      )
    }
  }
  private async keyword(
    input: KnowledgeSearchInput,
    fallbackReason: string,
  ): Promise<EmbeddingResult> {
    return { mode: 'keyword', hits: await this.options.library.search(input), fallbackReason }
  }
  async searchLocal(raw: unknown): Promise<EmbeddingResult> {
    const input = knowledgeSearchInputSchema.parse(raw)
    let config: EmbeddingConfig
    try {
      config = await this.getConfig()
    } catch {
      return this.keyword(input, 'Embedding 设置不可用，已使用本地关键词。')
    }
    if (
      !config.enabled ||
      !input.subject ||
      input.startPage === undefined ||
      input.endPage === undefined
    )
      return this.keyword(input, '本地关键词检索，无需 Embedding API。')
    const scope = {
      subject: input.subject,
      documentId: input.documentId,
      startPage: input.startPage,
      endPage: input.endPage,
    }
    if (!embeddingScopeSchema.safeParse(scope).success)
      return this.keyword(input, '本地关键词检索。')
    const fingerprint = embeddingFingerprint(config.baseUrl, config.model)
    const query = this.queryCache.get(this.cacheKey(scope, fingerprint, input.query))
    if (!query) return this.keyword(input, '本次查询尚未获准生成向量，已使用本地关键词。')
    const result = await this.vectors.search(scope, fingerprint, query, (ids) =>
      this.options.library.resolveChunks(ids),
    )
    return result.valid
      ? { mode: 'vector', hits: result.hits.slice(0, input.limit ?? 15) }
      : this.keyword(input, '本地向量索引缺失、过期或不兼容，已使用关键词。')
  }
  async clearIndex(raw: unknown): Promise<void> {
    const scope = embeddingScopeSchema.parse(raw)
    this.epoch++
    this.previews.clear()
    this.queryCache.clear()
    for (const controller of this.running) controller.abort()
    await this.vectors.clear(scope)
  }
  cancelAll(): void {
    this.epoch++
    this.previews.clear()
    this.queryCache.clear()
    for (const controller of this.running) controller.abort()
  }
}
