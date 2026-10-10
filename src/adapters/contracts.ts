import type { AnswerDraft, Attempt, Question } from '../shared/types'
import type { QuestionScope } from '../domain/schemas'

export type Review = Pick<
  Attempt,
  'score' | 'maxScore' | 'feedback' | 'explanation' | 'rubric' | 'reviewer'
>
export interface QuestionBankAdapter {
  readonly name: string
  list(scope?: QuestionScope): Promise<Question[]>
  get(questionId: string, scope?: QuestionScope): Promise<Question>
}
export interface AgentAdapter {
  readonly name: string
  review(question: Question, draft: AnswerDraft): Promise<Review>
}
