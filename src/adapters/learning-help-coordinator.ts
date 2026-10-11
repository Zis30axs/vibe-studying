import {
  emptyDraft,
  type AnswerDraft,
  type ModuleReviewResult,
  type ModuleReviewSuggestion,
} from '../shared/types'
import type { HelpKind, LearningSnapshot } from '../shared/learning-graph'
import type { StudyService } from '../domain/study-service'
import { applyModuleSuggestion } from '../domain/module-review'
import { checkpointAcceptedEdit } from '../domain/argument-revisions'
import { draftSchema, idSchema } from '../domain/schemas'

interface ActiveHelp {
  canceled: boolean
  branchId?: string
  snapshot?: LearningSnapshot
  questionId: string
  result?: ModuleReviewResult
}
/** Local-only full drafts never enter a cloud request through this coordinator. */
export class LearningHelpCoordinator {
  private readonly requests = new Map<string, ActiveHelp>()
  constructor(private readonly service: StudyService) {}
  async run<T>(
    input: {
      requestId: string
      questionId: string
      kind: HelpKind
      draft?: AnswerDraft
      prompt: string
    },
    operation: () => Promise<T>,
    detail: (result: T) => string,
  ): Promise<T> {
    idSchema.parse(input.requestId)
    if (this.requests.has(input.requestId)) throw new Error('求助请求 ID 已使用，请重新请求')
    // Bounded in-memory receipt cache; never evict a pending or actionable request silently.
    if (this.requests.size >= 2000) throw new Error('本次会话的求助记录已满，请重新启动后继续')
    const active: ActiveHelp = { canceled: false, questionId: input.questionId }
    this.requests.set(input.requestId, active)
    let captured = input.draft ? structuredClone(input.draft) : undefined
    try {
      if (this.service.graph && !captured) {
        const question = await this.service.bank.get(idSchema.parse(input.questionId))
        captured = (await this.service.loadState()).drafts[question.id] ?? emptyDraft(question.kind)
      }
      if (this.service.graph && captured) {
        active.snapshot = await this.service.captureSnapshot(input.questionId, captured)
        active.branchId = (
          await this.service.graph.beginHelp({
            snapshotId: active.snapshot!.id,
            requestId: input.requestId,
            kind: input.kind,
          })
        ).id
      }
      if (active.canceled) throw new Error('求助已取消')
      const result = await operation()
      if (active.canceled) throw new Error('求助已取消')
      if (active.branchId)
        await this.service.graph!.receiveHelp(active.branchId, {
          prompt: input.prompt,
          response: detail(result),
        })
      if (input.kind === 'module-review')
        active.result = structuredClone(result as ModuleReviewResult)
      return result
    } catch (error) {
      if (active.branchId)
        await (
          active.canceled
            ? this.service.graph!.cancelHelp(active.branchId)
            : this.service.graph!.failHelp(active.branchId)
        ).catch(() => undefined)
      throw error
    }
  }
  cancel(requestId: string): void {
    const active = this.requests.get(requestId)
    if (active) active.canceled = true
  }
  cancelAll(): void {
    for (const active of this.requests.values()) active.canceled = true
  }
  async reject(requestId: string): Promise<void> {
    const active = this.requests.get(idSchema.parse(requestId))
    if (active?.branchId) await this.service.graph!.rejectHelp(active.branchId)
  }
  async acceptModule(input: {
    requestId: string
    suggestionId: string
    expectedDraft: AnswerDraft
  }): Promise<AnswerDraft> {
    const active = this.requests.get(idSchema.parse(input.requestId))
    const suggestion: ModuleReviewSuggestion | undefined = active?.result?.suggestions.find(
      (item) => item.id === idSchema.parse(input.suggestionId),
    )
    if (
      !active?.snapshot?.draft.argument ||
      !active.branchId ||
      active.canceled ||
      !suggestion?.edit
    )
      throw new Error('建议已失效，请重新检查模块')
    if (
      JSON.stringify(draftSchema.parse(input.expectedDraft)) !==
      JSON.stringify(active.snapshot.draft)
    )
      throw new Error('作答已变化，请重新检查模块')
    const edited = applyModuleSuggestion(active.snapshot.draft.argument, suggestion)
    const next: AnswerDraft = {
      ...active.snapshot.draft,
      argument: checkpointAcceptedEdit(
        active.snapshot.draft.argument,
        edited.roots,
        `接受建议：${suggestion.reason.slice(0, 55)}`,
      ),
    }
    await this.service.applyLearningEdit(active.questionId, {
      branchId: active.branchId,
      expectedSnapshotId: active.snapshot.id,
      draft: next,
    })
    return structuredClone(next)
  }
}
