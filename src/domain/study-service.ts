import { randomUUID } from 'node:crypto'
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

export class StudyService {
  private cloudReviewPending = false
  private readonly store: AtomicJsonStore<StudyState>
  constructor(
    userDataDirectory: string,
    readonly bank: QuestionBankAdapter,
    readonly agent: AgentAdapter,
    private readonly cloudAgent?: AgentAdapter,
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
    const settings = submissionOptionsSchema.parse(options ?? { provider: 'local' })
    const cloud = settings.provider === 'deepseek'
    if (cloud && !settings.cloudConsent)
      throw new Error('请先确认将本题与本次作答发送给 DeepSeek 评阅。')
    if (cloud && !this.cloudAgent) throw new Error('DeepSeek 尚未配置；可选择本地规则评阅。')
    if (cloud && this.cloudReviewPending)
      throw new Error('已有 DeepSeek 评阅进行中，请勿重复提交。')
    const question = await this.bank.get(idSchema.parse(questionId))
    const draft = validateAnswer(question, input, true)
    // Preserve this answer even if a cloud request fails. No failed review becomes an attempt.
    if (cloud) await this.saveDraft(question.id, draft)
    if (cloud && this.cloudReviewPending)
      throw new Error('已有 DeepSeek 评阅进行中，请勿重复提交。')
    if (cloud) this.cloudReviewPending = true
    let review
    try {
      review = reviewSchema.parse(
        await (cloud ? this.cloudAgent! : this.agent).review(
          question,
          draft,
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
