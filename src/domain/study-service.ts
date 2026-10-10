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
  private cloudReviewPending = false
  private readonly store: AtomicJsonStore<StudyState>
  constructor(
    userDataDirectory: string,
    readonly bank: QuestionBankAdapter,
    readonly agent: AgentAdapter,
    private readonly cloudAgent?: AgentAdapter,
    private readonly modelReviewer?: (revision: number) => Promise<AgentAdapter>,
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

  async saveDraft(questionId: string, input: AnswerDraft): Promise<void> {
    const question = await this.bank.get(idSchema.parse(questionId))
    const draft = validateAnswer(question, input)
    await this.store.update((state) => ({
      ...state,
      drafts: { ...state.drafts, [question.id]: draft },
    }))
  }

  async submitAnswer(
    questionId: string,
    input: AnswerDraft,
    options?: SubmissionOptions,
  ): Promise<Attempt> {
    // Capture at entry, before bank/configuration awaits can yield to another task.
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
        ? { argument: { version: draft.argument.version, roots: draft.argument.roots }, blocks: [] }
        : {}),
    })
    let review
    try {
      review = reviewSchema.parse(
        await (cloud ? selectedCloud! : this.agent).review(
          reviewQuestion,
          reviewDraft,
          cloud ? { syllabus: settings.syllabus } : undefined,
        ),
      )
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
    }
    await this.store.update((state) => ({
      version: 1,
      drafts: { ...state.drafts, [question.id]: draft },
      attempts: [...state.attempts, attempt],
    }))
    return attempt
  }
}
