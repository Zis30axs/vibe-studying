import { randomUUID } from 'node:crypto'
import {
  generationRequestSchema,
  generatedQuestion,
  questionFingerprint,
  geographyGenerationPrompt,
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
import { ModelTransport } from './model-transport'
import { ModelToolTransport } from './model-tool-transport'
import {
  ModelProfileStore,
  modelMetadataSchema,
  modelKeySchema,
  type ModelSecretStorage,
} from './model-profile-store'
import { listRemoteModels, testModelConnection, ModelDiagnosticError } from './model-diagnostics'
import { ModelDebugStore } from './model-debug'
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
  ModelProfileInput,
  ModelRoleInput,
  ModelProfileDeleteInput,
  ModelRole,
  ModelDiagnosticInput,
  ModelDiagnosticResult,
  ModuleReviewRequest,
  ModuleReviewResult,
} from '../shared/types'
import {
  MODULE_REVIEW_PROMPT,
  validateModuleReviewRequest,
  validateModuleReviewResult,
} from '../domain/module-review'

/** Profiles and secrets stay in the main process; renderer receives metadata only. */
export class ModelService {
  private profiles: ModelProfileStore
  private debug = new ModelDebugStore()
  private cancellationListeners = new Set<() => void>()
  /** Trusted main-process clients only; never exposed through the renderer API. */
  onCancelAll(listener: () => void): () => void {
    this.cancellationListeners.add(listener)
    return () => {
      this.cancellationListeners.delete(listener)
    }
  }
  async agentTransport(revision: number, role: ModelRole = 'parent') {
    await this.queue
    const { config, key } = await this.profiles.resolve(role, revision)
    return {
      config,
      transport: new ModelToolTransport(
        config,
        key,
        this.options.fetchImpl,
        this.options.timeoutMs,
        this.debug.record,
      ),
    }
  }
  async agentJson(
    role: ModelRole,
    revision: number,
    system: string,
    data: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const { transport } = await this.snapshot(revision, role)
    if (signal.aborted) throw new Error('Agent 任务已取消。')
    const result = await transport.json(system, data, signal)
    await this.queue
    if (signal.aborted || (await this.profiles.getConfig(role)).revision !== revision)
      throw new Error('任务已取消或模型配置已更改。')
    return result
  }
  async agentReview(
    revision: number,
    question: Question,
    draft: import('../shared/types').AnswerDraft,
    signal: AbortSignal,
  ) {
    const { config, transport } = await this.snapshot(revision, 'parent')
    if (signal.aborted) throw new Error('Agent 任务已取消。')
    return new ModelAgent(`${config.protocol} · ${config.model}`, transport, signal).review(
      question,
      draft,
    )
  }
  getModelDebug() {
    return this.debug.getState()
  }
  setModelDebugEnabled(enabled: boolean) {
    return this.debug.setEnabled(enabled)
  }
  clearModelDebug() {
    return this.debug.clear()
  }
  modelDebugText() {
    return this.debug.copyText()
  }
  private pending = new Map<string, AbortController>()
  private generation: { id: string; controller: AbortController } | undefined
  private generationCount = 0
  private gradingEpoch = 0
  private generatedPreviews = new Map<string, Question>()
  private accepting = new Set<string>()
  private deferredDiscards = new Set<string>()
  private acceptQueue: Promise<unknown> = Promise.resolve()
  private queue: Promise<unknown> = Promise.resolve()
  constructor(
    directory: string,
    private options: {
      secureStorage?: ModelSecretStorage
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
    this.profiles = new ModelProfileStore(directory, options)
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
  async getConfig(role: ModelRole = 'parent'): Promise<ModelConfig> {
    await this.queue
    return this.profiles.getConfig(role)
  }
  async getProfiles() {
    await this.queue
    return this.profiles.getProfiles()
  }
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.queue.then(async () => {
      const result = await operation()
      this.cancelAll()
      for (const token of this.generatedPreviews.keys())
        if (!this.accepting.has(token)) this.generatedPreviews.delete(token)
      return result
    })
    this.queue = work.catch(() => {})
    return work
  }
  saveConfig(input: ModelConfigInput): Promise<ModelConfig> {
    return this.mutate(() => this.profiles.saveConfig(input))
  }
  saveProfile(input: ModelProfileInput) {
    return this.mutate(() => this.profiles.saveProfile(input))
  }
  assignProfiles(input: ModelRoleInput) {
    return this.mutate(() => this.profiles.assignProfiles(input))
  }
  deleteProfile(input: ModelProfileDeleteInput) {
    return this.mutate(() => this.profiles.deleteProfile(input))
  }
  private async snapshot(revision: number, role: ModelRole = 'parent') {
    await this.queue
    const { config, key } = await this.profiles.resolve(role, revision)
    return {
      config,
      transport: new ModelTransport(
        config,
        key,
        this.options.fetchImpl,
        this.options.timeoutMs,
        this.debug.record,
      ),
    }
  }
  async reviewer(revision: number) {
    const epoch = this.gradingEpoch
    const { config, transport } = await this.snapshot(revision)
    const name = `${config.protocol} · ${config.model}`
    return {
      name,
      review: async (...args: Parameters<ModelAgent['review']>) => {
        const id = `grading:${randomUUID()}`
        const controller = new AbortController()
        this.pending.set(id, controller)
        try {
          await this.queue
          if (
            controller.signal.aborted ||
            epoch !== this.gradingEpoch ||
            (await this.profiles.getConfig()).revision !== revision
          )
            throw new Error('模型设置已更改，请重新确认本次发送。')
          const result = await new ModelAgent(name, transport, controller.signal).review(...args)
          await this.queue
          if (
            controller.signal.aborted ||
            epoch !== this.gradingEpoch ||
            (await this.profiles.getConfig()).revision !== revision
          )
            throw new Error('模型设置已更改；旧审阅结果未保存，请重新确认。')
          return result
        } finally {
          this.pending.delete(id)
        }
      },
    }
  }
  async diagnoseModel(input: ModelDiagnosticInput): Promise<ModelDiagnosticResult> {
    let parsed: ModelDiagnosticInput
    try {
      parsed = modelMetadataSchema
        .extend({
          model: z.string().trim().max(120),
          requestId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
          expectedRevision: z.number().int().nonnegative(),
          profileId: z
            .string()
            .regex(/^[A-Za-z0-9_-]{1,80}$/)
            .optional(),
          apiKey: modelKeySchema.optional(),
          kind: z.enum(['list', 'test']),
        })
        .strict()
        .parse(input)
    } catch {
      throw new Error('请检查协议、接口地址、模型名称和 API Key。')
    }
    const id = `diagnostic:${parsed.requestId}`
    if ([...this.pending.keys()].some((key) => key.startsWith('diagnostic:')))
      throw new Error('已有连接检查进行中，请等待或取消。')
    const controller = new AbortController()
    this.pending.set(id, controller)
    try {
      await this.queue
      const key = await this.profiles.diagnosticKey(parsed)
      if (controller.signal.aborted) throw new Error('请求已取消。')
      const options = {
        fetchImpl: this.options.fetchImpl,
        timeoutMs: this.options.timeoutMs,
        signal: controller.signal,
      }
      const result =
        parsed.kind === 'list'
          ? { models: await listRemoteModels(parsed, key, options) }
          : await testModelConnection(parsed, key, options)
      await this.queue
      if (
        controller.signal.aborted ||
        (await this.profiles.getConfig()).revision !== parsed.expectedRevision
      )
        throw new Error('设置已更改，旧连接检查结果已丢弃。')
      return result
    } catch (error) {
      if (error instanceof ModelDiagnosticError)
        return { error: { code: error.code, message: error.message } }
      throw error
    } finally {
      this.pending.delete(id)
    }
  }
  cancelModelDiagnostic(id: string) {
    if (typeof id === 'string') this.pending.get(`diagnostic:${id}`)?.abort()
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
      const { transport } = await this.snapshot(parsed.configRevision, 'child')
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
      const context = transport.createDebugContext()
      const started = Date.now()
      const raw = await transport.json(ADVISOR_PROMPT, data, controller.signal, context)
      await this.queue
      if (controller.signal.aborted) throw new Error('请求已取消。')
      if ((await this.getConfig()).revision !== parsed.configRevision)
        throw new Error('模型设置已更改，请重新确认本次发送。')
      return validateAdvisorResult(raw, parsed.requestId, evidence, (paths) =>
        transport.reportSchemaFailure(paths, Date.now() - started, context),
      )
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
      const { transport } = await this.snapshot(parsed.configRevision, 'child')
      if (controller.signal.aborted) throw new Error('请求已取消。')
      const question = await this.resolveQuestion(parsed.questionId)
      if (question.subject === 'math') throw new Error('该题不支持文科模块检查。')
      if (controller.signal.aborted) throw new Error('请求已取消。')
      const data = buildModuleAdvisorContext(question, parsed)
      await this.queue
      if (
        controller.signal.aborted ||
        (await this.profiles.getConfig()).revision !== parsed.configRevision
      )
        throw new Error('模型设置已更改，请重新确认本次发送。')
      const context = transport.createDebugContext()
      const started = Date.now()
      const raw = await transport.json(MODULE_REVIEW_PROMPT, data, controller.signal, context)
      // A non-cooperative transport or configuration write must never deliver stale edits.
      await this.queue
      const config = await this.getConfig()
      if (controller.signal.aborted) throw new Error('请求已取消。')
      if (config.revision !== parsed.configRevision)
        throw new Error('模型设置已更改，请重新确认本次发送。')
      return validateModuleReviewResult(raw, parsed, (paths) =>
        transport.reportSchemaFailure(paths, Date.now() - started, context),
      )
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
      const context = transport.createDebugContext()
      const started = Date.now()
      const raw = await transport.json(
        geographyGenerationPrompt(parsed),
        {
          syllabus: parsed.syllabus,
          chapter: parsed.chapter,
          difficulty: parsed.difficulty,
          ...(parsed.mode === 'terrain' ? { mode: 'terrain' } : {}),
        },
        controller.signal,
        context,
      )
      await this.queue
      if (controller.signal.aborted) throw new Error('请求已取消。')
      if ((await this.getConfig()).revision !== parsed.configRevision)
        throw new Error('模型设置已更改，请重新确认本次发送。')
      const question = generatedQuestion(raw, parsed, config, (paths) =>
        transport.reportSchemaFailure(paths, Date.now() - started, context),
      )
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
  cancelGrading(): void {
    this.gradingEpoch += 1
    for (const [id, controller] of this.pending) if (id.startsWith('grading:')) controller.abort()
  }
  cancelAll(): void {
    this.gradingEpoch += 1
    this.generation?.controller.abort()
    for (const controller of this.pending.values()) controller.abort()
    for (const listener of this.cancellationListeners) {
      try {
        listener()
      } catch {
        /* One observer must not block other cancellations. */
      }
    }
  }
}
