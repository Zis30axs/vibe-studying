import type { LearningGraphService } from '../adapters/learning-graph-service'
import type { AcceptLearningHelp, LearningSnapshot } from '../shared/learning-graph'
import { randomUUID } from 'node:crypto'
import { studentQuestionProjection } from './student-question'
import { join } from 'node:path'
import type { AnswerDraft, Attempt, StudyState, SubmissionOptions } from '../shared/types'
import type { AgentAdapter, QuestionBankAdapter } from '../adapters/contracts'
import { AtomicJsonStore } from '../adapters/atomic-json-store'
import {
  idSchema,
  reviewSchema,
  studyStateSchema,
  submissionOptionsSchema,
  validateAnswer,
} from './schemas'

/** A reviewer receives an isolated snapshot, never mutable workspace objects. */
function immutableCopy<T>(value: T): T {
  const copy = structuredClone(value)
  const freeze = (item: unknown): void => {
    if (!item || typeof item !== 'object' || Object.isFrozen(item)) return
    for (const child of Object.values(item)) freeze(child)
    Object.freeze(item)
  }
  freeze(copy)
  return copy
}

export class StudyService {
  private draftWriteQueue: Promise<unknown> = Promise.resolve()
  private cloudReviewPending = false
  private cloudCancelEpoch = 0
  cancelCloudReview(): void {
    this.cloudCancelEpoch += 1
  }
  private readonly store: AtomicJsonStore<StudyState>
  constructor(
    userDataDirectory: string,
    readonly bank: QuestionBankAdapter,
    readonly agent: AgentAdapter,
    private readonly cloudAgent?: AgentAdapter,
    private readonly modelReviewer?: (revision: number) => Promise<AgentAdapter>,
    readonly graph?: LearningGraphService,
  ) {
    this.store = new AtomicJsonStore(
      join(userDataDirectory, 'study-state.json'),
      studyStateSchema,
      () => ({ version: 1, drafts: {}, attempts: [] }),
    )
  }

  loadState(): Promise<StudyState> {
    return this.store.load()
  }

  /** Capture the real full draft, even when the cloud prompt only contains a selection. */
  async captureSnapshot(
    questionId: string,
    input: AnswerDraft,
  ): Promise<LearningSnapshot | undefined> {
    if (!this.graph) return undefined
    const captured = structuredClone(input)
    const question = await this.bank.get(idSchema.parse(questionId))
    const draft = validateAnswer(question, captured)
    await this.draftWriteQueue
    const state = await this.store.load()
    const existing =
      state.drafts[question.id] ||
      state.attempts.some((attempt) => attempt.questionId === question.id)
    return this.graph.capture({
      questionId: question.id,
      subject: question.subject,
      draft,
      initialOrigin: existing ? 'unknown' : 'independent',
    })
  }

  saveDraft(questionId: string, input: AnswerDraft): Promise<void> {
    const captured = structuredClone(input)
    const operation = this.draftWriteQueue.then(async () => {
      const question = await this.bank.get(idSchema.parse(questionId))
      const draft = validateAnswer(question, captured)
      if (this.graph) {
        // Never turn ordinary typing into commits or let an unavailable optional ledger lose work.
        const previous = await this.store.load()
        await this.graph
          .ensureBaseline({
            questionId: question.id,
            subject: question.subject,
            draft,
            initialOrigin:
              previous.drafts[question.id] ||
              previous.attempts.some((attempt) => attempt.questionId === question.id)
                ? 'unknown'
                : 'independent',
          })
          .catch(() => undefined)
      }
      await this.store.update((state) => ({
        ...state,
        drafts: { ...state.drafts, [question.id]: draft },
      }))
    })
    this.draftWriteQueue = operation.catch(() => undefined)
    return operation
  }

  async restoreLearningSnapshot(input: {
    snapshotId: string
    expectedHeadId: string
  }): Promise<LearningSnapshot> {
    if (!this.graph) throw new Error('学习图尚未启用')
    const graph = await this.graph.load()
    const target = graph.snapshots.find(
      (snapshot) => snapshot.id === idSchema.parse(input.snapshotId),
    )
    if (!target) throw new Error('找不到要恢复的作答快照')
    const question = await this.bank.get(target.questionId)
    if (question.subject !== target.subject) throw new Error('当前题目与历史学科不一致，不能恢复')
    const draft = validateAnswer(question, target.draft)
    await this.draftWriteQueue
    const current = (await this.store.load()).drafts[target.questionId]
    // Preserve any typed work since the last help/submit checkpoint before restoring.
    const checkpoint = await this.graph.capture({
      questionId: target.questionId,
      subject: target.subject,
      draft: current ?? target.draft,
      expectedHeadId: idSchema.parse(input.expectedHeadId),
    })
    return this.graph.capture(
      {
        questionId: target.questionId,
        subject: target.subject,
        draft,
        mode: 'restore',
        restoreSnapshotId: target.id,
        expectedHeadId: checkpoint.id,
      },
      async (next) => {
        await this.store.update((state) => {
          if (JSON.stringify(state.drafts[target.questionId]) !== JSON.stringify(current))
            throw new Error('草稿已更新，请刷新后再恢复')
          return { ...state, drafts: { ...state.drafts, [target.questionId]: next } }
        })
      },
    )
  }

  /** A real accepted edit is persisted under the same graph CAS that validates its base. */
  async applyLearningEdit(
    questionId: string,
    input: AcceptLearningHelp,
  ): Promise<LearningSnapshot> {
    if (!this.graph) throw new Error('学习图尚未启用')
    const question = await this.bank.get(idSchema.parse(questionId))
    const draft = validateAnswer(question, structuredClone(input.draft))
    const graph = await this.graph.load()
    const base = graph.snapshots.find((snapshot) => snapshot.id === input.expectedSnapshotId)
    if (!base || base.questionId !== question.id || base.subject !== question.subject)
      throw new Error('修改不能应用到其他题目')
    await this.draftWriteQueue
    return this.graph.acceptHelp({ ...input, draft }, async (next, previous) => {
      await this.store.update((state) => {
        const current = state.drafts[question.id]
        if (current && JSON.stringify(current) !== JSON.stringify(previous))
          throw new Error('本机草稿已变化，请重新确认修改')
        return { ...state, drafts: { ...state.drafts, [question.id]: next } }
      })
    })
  }

  async submitAnswer(
    questionId: string,
    input: AnswerDraft,
    options?: SubmissionOptions,
  ): Promise<Attempt> {
    // Capture at entry, before bank/configuration awaits can yield to another task.
    const epoch = this.cloudCancelEpoch
    const submitted = structuredClone(input)
    const settings = submissionOptionsSchema.parse(options ?? { provider: 'local' })
    const cloud = settings.provider !== 'local'
    const configurable = settings.provider === 'cloud'
    let selectedCloud = this.cloudAgent
    if (cloud && !settings.cloudConsent)
      throw new Error('请先确认将本题与本次作答发送给所选模型评阅。')
    if (configurable) {
      if (!this.modelReviewer || settings.configRevision === undefined)
        throw new Error('请先配置模型并确认本次发送。')
      selectedCloud = await this.modelReviewer(settings.configRevision)
    }
    if (cloud && !selectedCloud) throw new Error('DeepSeek 尚未配置；可选择本地规则评阅。')
    if (cloud && this.cloudReviewPending) throw new Error('已有云端评阅进行中，请勿重复提交。')
    const question = await this.bank.get(idSchema.parse(questionId))
    const draft = validateAnswer(question, submitted, true)
    // Local practice remains usable when the optional provenance ledger is full/unreadable.
    // AI dispatch requires a reliable real branch and therefore surfaces that failure.
    const learningSnapshot = await this.captureSnapshot(question.id, draft).catch((error) => {
      if (cloud) throw error
      return undefined
    })
    // Freeze the provenance of the answer actually composed before grading feedback exists.
    // Successful feedback affects later attempts in this lineage, never this submitted answer.
    const submissionAssistance =
      learningSnapshot && this.graph
        ? await this.graph.assistance(learningSnapshot.id).catch((error) => {
            if (cloud) throw error
            return undefined
          })
        : undefined
    // Preserve this answer even if a cloud request fails. No failed review becomes an attempt.
    if (cloud) await this.saveDraft(question.id, draft)
    if (cloud && this.cloudReviewPending) throw new Error('已有云端评阅进行中，请勿重复提交。')
    if (cloud) this.cloudReviewPending = true
    const questionSnapshot = studentQuestionProjection(question)
    const reviewQuestion = immutableCopy(question)
    const reviewDraft = immutableCopy({
      ...draft,
      // Revision history and canvas layout are workspace metadata, not grading evidence.
      ...(draft.argument
        ? {
            argument: {
              version: draft.argument.version,
              roots: draft.argument.roots,
              ...(draft.argument.groups ? { groups: draft.argument.groups } : {}),
            },
            blocks: [],
          }
        : {}),
    })
    let review
    let helpBranchId: string | undefined
    try {
      if (cloud && this.graph && learningSnapshot) {
        helpBranchId = (
          await this.graph.beginHelp({
            snapshotId: learningSnapshot.id,
            requestId: `review-${randomUUID()}`,
            kind: 'submission-review',
          })
        ).id
      }
      if (cloud && epoch !== this.cloudCancelEpoch) throw new Error('审查已取消；作答已保留。')
      review = reviewSchema.parse(
        await (cloud ? selectedCloud! : this.agent).review(
          reviewQuestion,
          reviewDraft,
          cloud ? { syllabus: settings.syllabus } : undefined,
        ),
      )
      if (cloud && epoch !== this.cloudCancelEpoch)
        throw new Error('审查已取消；结果未保存，作答已保留。')
      if (review.maxScore !== question.maxScore) throw new Error('评阅器返回了不一致的满分')
    } catch (error) {
      if (helpBranchId) {
        await (
          epoch !== this.cloudCancelEpoch
            ? this.graph!.cancelHelp(helpBranchId)
            : this.graph!.failHelp(helpBranchId)
        ).catch(() => undefined)
      }
      throw error
    } finally {
      if (cloud) this.cloudReviewPending = false
    }
    if (review.maxScore !== question.maxScore) throw new Error('评阅器返回了不一致的满分')
    const attempt: Attempt = {
      ...review,
      id: randomUUID(),
      questionId: question.id,
      questionSnapshot,
      submittedAt: new Date().toISOString(),
      draft,
      ...(submissionAssistance ? { assistance: submissionAssistance } : {}),
    }
    try {
      await this.store.update((state) => {
        if (cloud && epoch !== this.cloudCancelEpoch)
          throw new Error('审查已取消；结果未保存，作答已保留。')
        return {
          version: 1,
          drafts: { ...state.drafts, [question.id]: draft },
          attempts: [...state.attempts, attempt],
        }
      })
    } catch (error) {
      if (helpBranchId)
        await (
          epoch !== this.cloudCancelEpoch
            ? this.graph!.cancelHelp(helpBranchId)
            : this.graph!.failHelp(helpBranchId)
        ).catch(() => undefined)
      throw error
    }
    // The durable successful Attempt is the completion boundary. Late cancellation before
    // that boundary cannot record received assistance; afterward it cannot erase history.
    if (helpBranchId)
      await this.graph!.receiveHelp(helpBranchId, {
        prompt: '评阅本次作答',
        response: review.feedback,
      }).catch(() => undefined)
    if (this.graph && learningSnapshot) {
      // Attempt is already durably saved. A supplementary graph-link failure must not turn
      // it into a reported failed submission or tempt the learner to submit twice.
      await this.graph
        .submission({
          attemptId: attempt.id,
          snapshotId: learningSnapshot.id,
          assistance: attempt.assistance,
        })
        .catch(() => undefined)
    }
    return attempt
  }
}
