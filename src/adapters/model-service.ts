import { randomUUID } from 'node:crypto'
import {
  generationRequestSchema,
  generatedQuestion,
  questionFingerprint,
  GEOGRAPHY_GENERATION_PROMPT,
} from './question-generator'
import { studentQuestionProjection } from '../domain/student-question'
import { buildAdvisorContext, buildModuleAdvisorContext } from './review-contexts'
import { questionSchema } from '../domain/schemas'
import {
  ADVISOR_PROMPT,
  advisorRequestSchema,
  validateAdvisorEvidence,
  validateAdvisorResult,
} from '../domain/advisor'
import type { KnowledgeEvidence } from '../shared/knowledge'
import { z } from 'zod'
import { join } from 'node:path'
import { AtomicJsonStore } from './atomic-json-store'
import { ModelTransport, protocolSchema, validateBaseUrl } from './model-transport'
import { ModelAgent } from './model-agent'
import type {
  Question,
  GenerateGeographyRequest,
  GeneratedQuestionPreview,
  StudentQuestion,
  AdvisorRequest,
  AdvisorResult,
  ModelConfig,
  ModelConfigInput,
  ModuleReviewRequest,
  ModuleReviewResult,
} from '../shared/types'
import {
  MODULE_REVIEW_PROMPT,
  validateModuleReviewRequest,
  validateModuleReviewResult,
} from '../domain/module-review'

const storedSchema = z.strictObject({
  protocol: protocolSchema,
  baseUrl: z.string().transform(validateBaseUrl),
  model: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/),
  revision: z.number().int().nonnegative(),
})
const inputSchema = storedSchema
  .omit({ revision: true })
  .extend({
    apiKey: z
      .string()
      .trim()
      .max(4096)
      .regex(/^[^\r\n]*$/)
      .optional(),
    clearApiKey: z.boolean().optional(),
  })
  .strict()
/** Non-secret metadata on disk; keys live only in this process and are never returned. */
export class ModelService {
  private store: AtomicJsonStore<z.infer<typeof storedSchema>>
  private key: string
  private keyTarget: string | undefined
  private pending = new Map<string, AbortController>()
  private generation: { id: string; controller: AbortController } | undefined
  private generationCount = 0
  private generatedPreviews = new Map<string, Question>()
  private accepting = new Set<string>()
  private deferredDiscards = new Set<string>()
  private acceptQueue: Promise<unknown> = Promise.resolve()
  private queue: Promise<unknown> = Promise.resolve()
  constructor(
    directory: string,
    private options: {
      apiKey?: string
      model?: string
      fetchImpl?: typeof fetch
      timeoutMs?: number
      listQuestions?: () => Promise<Question[]>
      persistGenerated?: (question: Question) => Promise<unknown>
      resolveQuestion?: (id: string) => Question | undefined | Promise<Question | undefined>
      resolveKnowledgeChunks?: (
        chunkIds: string[],
      ) => KnowledgeEvidence[] | Promise<KnowledgeEvidence[]>
    } = {},
  ) {
    this.key = options.apiKey?.trim() ?? ''
    this.keyTarget = this.key ? 'openai-chat|https://api.deepseek.com' : undefined
    this.store = new AtomicJsonStore(join(directory, 'model-config.json'), storedSchema, () => ({
      protocol: 'openai-chat',
      baseUrl: 'https://api.deepseek.com',
      model:
        options.model && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(options.model)
          ? options.model
          : 'deepseek-flash',
      revision: 0,
    }))
  }
  private async resolveQuestion(id: string): Promise<Question> {
    try {
      const question = questionSchema.parse(await this.options.resolveQuestion?.(id))
      if (question.id !== id) throw new Error()
      return question
    } catch {
      throw new Error('题目不存在或不在允许范围内；未发送到模型服务。')
    }
  }
  private target(config: { protocol: string; baseUrl: string }) {
    return `${config.protocol}|${config.baseUrl}`
  }
  async getConfig(): Promise<ModelConfig> {
    const config = await this.store.load()
    return { ...config, configured: Boolean(this.key) && this.keyTarget === this.target(config) }
  }
  saveConfig(input: ModelConfigInput): Promise<ModelConfig> {
    const work = this.queue.then(async () => {
      let parsed: z.infer<typeof inputSchema>
      try {
        parsed = inputSchema.parse(input)
      } catch {
        throw new Error('模型设置无效，请检查协议、Base URL、模型名称和 API Key。')
      }
      const { apiKey, clearApiKey, ...metadata } = parsed
      const previous = await this.store.load()
      const next = await this.store.update((value) => ({
        ...metadata,
        revision: value.revision + 1,
      }))
      if (this.target(previous) !== this.target(next) || clearApiKey) {
        this.key = ''
        this.keyTarget = undefined
      }
      if (apiKey && !clearApiKey) {
        this.key = apiKey
        this.keyTarget = this.target(next)
      }
      this.cancelAll()
      // Configuration changes invalidate previews not already being explicitly saved.
      for (const token of this.generatedPreviews.keys())
        if (!this.accepting.has(token)) this.generatedPreviews.delete(token)
      return this.getConfig()
    })
    this.queue = work.catch(() => {})
    return work
  }
  private async snapshot(revision: number) {
    await this.queue
    const config = await this.getConfig()
    if (revision !== config.revision) throw new Error('模型设置已更改，请重新确认本次发送。')
    if (!config.configured)
      throw new Error('请先在模型设置中填写 API Key；密钥仅在本次运行中有效。')
    return {
      config,
      transport: new ModelTransport(
        config,
        this.key,
        this.options.fetchImpl,
        this.options.timeoutMs,
      ),
    }
  }
  async reviewer(revision: number) {
    const { config, transport } = await this.snapshot(revision)
    return new ModelAgent(`${config.protocol} · ${config.model}`, transport)
  }
  async askAdvisor(input: AdvisorRequest): Promise<AdvisorResult> {
    let parsed: z.infer<typeof advisorRequestSchema>
    try {
      parsed = advisorRequestSchema.parse(input)
    } catch {
      throw new Error('请确认选中文本和本次发送范围。')
    }
    if (this.pending.size >= 3) throw new Error('已有顾问请求进行中，请稍后重试。')
    if (this.pending.has(parsed.requestId)) throw new Error('该提示请求已在进行中。')
    const controller = new AbortController()
    this.pending.set(parsed.requestId, controller)
    try {
      const { transport } = await this.snapshot(parsed.configRevision)
      if (controller.signal.aborted) throw new Error('请求已取消。')
      const question = await this.resolveQuestion(parsed.questionId)
      if (controller.signal.aborted) throw new Error('请求已取消。')
      const chunkIds = parsed.knowledgeChunkIds ?? []
      let evidence: KnowledgeEvidence[] = []
      if (chunkIds.length) {
        try {
          evidence = validateAdvisorEvidence(
            await this.options.resolveKnowledgeChunks?.(chunkIds),
            chunkIds,
          )
        } catch {
          throw new Error('教材摘录已失效，请在知识库重新选择并确认。')
        }
        // The trusted resolver, not renderer-supplied subject labels, decides isolation.
        evidence = validateAdvisorEvidence(evidence, chunkIds, question.subject)
      }
      // A pending local resolution may outlive cancellation or a destination change.
      await this.queue
      if (controller.signal.aborted) throw new Error('请求已取消。')
      if ((await this.getConfig()).revision !== parsed.configRevision)
        throw new Error('模型设置已更改，请重新确认本次发送。')
      const data = buildAdvisorContext(question, parsed, evidence)
      const raw = await transport.json(ADVISOR_PROMPT, data, controller.signal)
      await this.queue
      if (controller.signal.aborted) throw new Error('请求已取消。')
      if ((await this.getConfig()).revision !== parsed.configRevision)
        throw new Error('模型设置已更改，请重新确认本次发送。')
      return validateAdvisorResult(raw, parsed.requestId, evidence)
    } finally {
      this.pending.delete(parsed.requestId)
    }
  }
  async reviewModules(input: ModuleReviewRequest): Promise<ModuleReviewResult> {
    const parsed = validateModuleReviewRequest(input)
    if (this.pending.size >= 3) throw new Error('已有模型请求进行中，请稍后重试。')
    // Separate namespaces prevent a module cancellation from canceling a selection hint.
    const pendingId = `modules:${parsed.requestId}`
    if (this.pending.has(pendingId)) throw new Error('该模块检查已在进行中。')
    const controller = new AbortController()
    this.pending.set(pendingId, controller)
    try {
      const { transport } = await this.snapshot(parsed.configRevision)
      if (controller.signal.aborted) throw new Error('请求已取消。')
      const question = await this.resolveQuestion(parsed.questionId)
      if (question.subject === 'math') throw new Error('该题不支持文科模块检查。')
      if (controller.signal.aborted) throw new Error('请求已取消。')
      const data = buildModuleAdvisorContext(question, parsed)
      const raw = await transport.json(MODULE_REVIEW_PROMPT, data, controller.signal)
      // A non-cooperative transport or configuration write must never deliver stale edits.
      await this.queue
      const config = await this.getConfig()
      if (controller.signal.aborted) throw new Error('请求已取消。')
      if (config.revision !== parsed.configRevision)
        throw new Error('模型设置已更改，请重新确认本次发送。')
      return validateModuleReviewResult(raw, parsed)
    } finally {
      this.pending.delete(pendingId)
    }
  }
  getGenerationStatus() {
    return { used: this.generationCount, limit: 5, pending: this.generatedPreviews.size }
  }
  async generateGeographyQuestion(
    input: GenerateGeographyRequest,
  ): Promise<GeneratedQuestionPreview> {
    const result = generationRequestSchema.safeParse(input)
    if (!result.success) throw new Error('请确认课程范围、章节、难度和本次发送授权。')
    const parsed = result.data
    if (this.generation) throw new Error('已有出题请求进行中，请等待或取消。')
    if (this.generatedPreviews.size >= 3) throw new Error('请先使用或丢弃已有预览题目。')
    if (this.generationCount >= 5) throw new Error('本次运行最多生成 5 次，请使用已有题目。')
    if (!this.options.listQuestions || !this.options.persistGenerated)
      throw new Error('当前题库不支持保存生成题目。')
    const controller = new AbortController()
    this.generation = { id: parsed.requestId, controller }
    try {
      const { config, transport } = await this.snapshot(parsed.configRevision)
      if (controller.signal.aborted) throw new Error('请求已取消。')
      // Charge the session quota exactly once at dispatch, including failed/cancelled requests.
      this.generationCount += 1
      const raw = await transport.json(
        GEOGRAPHY_GENERATION_PROMPT,
        {
          syllabus: parsed.syllabus,
          chapter: parsed.chapter,
          difficulty: parsed.difficulty,
        },
        controller.signal,
      )
      await this.queue
      if (controller.signal.aborted) throw new Error('请求已取消。')
      if ((await this.getConfig()).revision !== parsed.configRevision)
        throw new Error('模型设置已更改，请重新确认本次发送。')
      const question = generatedQuestion(raw, parsed, config)
      const bank = await this.options.listQuestions()
      if (controller.signal.aborted) throw new Error('请求已取消。')
      const fingerprint = questionFingerprint(question)
      if (
        [...bank, ...this.generatedPreviews.values()].some(
          (q) => questionFingerprint(q) === fingerprint,
        )
      )
        throw new Error('生成内容与已有题目重复，未保存；不会自动重试。')
      const token = randomUUID()
      this.generatedPreviews.set(token, question)
      return { requestId: parsed.requestId, token, question: studentQuestionProjection(question) }
    } finally {
      this.generation = undefined
    }
  }
  acceptGeneratedQuestion(token: string): Promise<StudentQuestion> {
    if (
      typeof token !== 'string' ||
      !this.generatedPreviews.has(token) ||
      this.accepting.has(token)
    )
      return Promise.reject(new Error('预览不存在或已被处理，请重新生成。'))
    this.accepting.add(token)
    const work = this.acceptQueue
      .then(async () => {
        const question = this.generatedPreviews.get(token)
        if (!question || !this.options.listQuestions || !this.options.persistGenerated)
          throw new Error('预览不存在或已被丢弃。')
        const fingerprint = questionFingerprint(question)
        if (
          (await this.options.listQuestions()).some((q) => questionFingerprint(q) === fingerprint)
        )
          throw new Error('该题内容已存在，未重复保存。')
        await this.options.persistGenerated(question)
        this.generatedPreviews.delete(token)
        return studentQuestionProjection(question)
      })
      .finally(() => {
        this.accepting.delete(token)
        if (this.deferredDiscards.delete(token)) this.generatedPreviews.delete(token)
      })
    this.acceptQueue = work.catch(() => {})
    return work
  }
  rejectGeneratedQuestion(token: string): void {
    if (typeof token !== 'string') return
    // Finish an already-authorized write, but do not strand a failed preview on unmount.
    if (this.accepting.has(token)) this.deferredDiscards.add(token)
    else this.generatedPreviews.delete(token)
  }
  cancelQuestionGeneration(id: string): void {
    if (typeof id === 'string' && this.generation?.id === id) this.generation.controller.abort()
  }
  cancelModuleReview(id: string): void {
    if (typeof id === 'string') this.pending.get(`modules:${id}`)?.abort()
  }
  cancelAdvisor(id: string): void {
    if (typeof id === 'string') this.pending.get(id)?.abort()
  }
  cancelAll(): void {
    this.generation?.controller.abort()
    for (const controller of this.pending.values()) controller.abort()
  }
}
