export type Subject = 'politics' | 'geography'
export type QuestionKind = 'choice' | 'politics' | 'geography'
export type BlockCategory = 'principle' | 'material' | 'analysis' | 'conclusion'
export interface AnswerBlock {
  id: string
  category: BlockCategory
  label: string
  text: string
}
export interface RubricItem {
  id: string
  label: string
  keywords: string[]
  points: number
}
export interface Question {
  id: string
  subject: Subject
  kind: QuestionKind
  title: string
  prompt: string
  source: string
  tags: string[]
  maxScore: number
  explanation: string
  choices?: { id: string; text: string }[]
  correctAnswer?: string
  blocks?: AnswerBlock[]
  rubric?: RubricItem[]
}
export interface GeoPoint {
  id: string
  x: number
  y: number
  label: string
}
export interface GeoLine {
  id: string
  from: string
  to: string
}
export interface GeoDrawing {
  points: GeoPoint[]
  lines: GeoLine[]
  mode: 'cartesian' | 'geographic'
}
export interface AnswerDraft {
  choiceId?: string
  text: string
  blocks: AnswerBlock[]
  drawing: GeoDrawing
}
export interface RubricResult {
  id: string
  label: string
  earned: number
  possible: number
  feedback: string
}
export interface Attempt {
  id: string
  questionId: string
  submittedAt: string
  draft: AnswerDraft
  score: number
  maxScore: number
  feedback: string
  explanation: string
  rubric: RubricResult[]
  reviewer: string
}
export interface StudyState {
  version: 1
  drafts: Record<string, AnswerDraft>
  attempts: Attempt[]
}
export interface SubmissionOptions {
  provider: 'local' | 'deepseek'
  cloudConsent?: boolean
  syllabus?: string
}
export interface Capabilities {
  questionBank: string
  reviewer: string
  mcp: string
  deepseek?: { configured: boolean; model: string; endpoint: string; error?: string }
}
export interface ExamCraftApi {
  listQuestions(): Promise<Question[]>
  loadState(): Promise<StudyState>
  saveDraft(questionId: string, draft: AnswerDraft): Promise<void>
  submitAnswer(
    questionId: string,
    draft: AnswerDraft,
    options?: SubmissionOptions,
  ): Promise<Attempt>
  importQuestionBank(): Promise<{ count: number; canceled: boolean }>
  getCapabilities(): Promise<Capabilities>
}
export const emptyDraft = (): AnswerDraft => ({
  text: '',
  blocks: [],
  drawing: { points: [], lines: [], mode: 'cartesian' },
})
