import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { AnswerDraft, Attempt, StudyState } from '../shared/types'
import type { AgentAdapter, QuestionBankAdapter } from '../adapters/contracts'
import { AtomicJsonStore } from '../adapters/atomic-json-store'
import { idSchema, reviewSchema, studyStateSchema, validateAnswer } from './schemas'

export class StudyService {
  private readonly store: AtomicJsonStore<StudyState>
  constructor(
    userDataDirectory: string,
    readonly bank: QuestionBankAdapter,
    readonly agent: AgentAdapter,
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

  async submitAnswer(questionId: string, input: AnswerDraft): Promise<Attempt> {
    const question = await this.bank.get(idSchema.parse(questionId))
    const draft = validateAnswer(question, input, true)
    const review = reviewSchema.parse(await this.agent.review(question, draft))
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
