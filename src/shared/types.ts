export type Subject = 'chinese' | 'math' | 'english' | 'politics' | 'history' | 'geography'
export type QuestionKind = 'choice' | Subject
export type BlockCategory = 'principle' | 'material' | 'analysis' | 'conclusion'
export type ArgumentContainerKind = 'cause' | 'contrast' | 'point'
export type ArgumentKind = BlockCategory | ArgumentContainerKind
export interface ArgumentNode {
  id: string
  kind: ArgumentKind
  text: string
  /** Only cause, contrast, and point containers may have children. */
  children: ArgumentNode[]
}
export interface ArgumentDocument {
  version: 1
  roots: ArgumentNode[]
}
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
export interface MathParameters {
  a: number
  b: number
  c: number
}
export interface MathWorkbenchState {
  drawing: GeoDrawing
  expression: string
  parameters: MathParameters
  measurement: string[]
}
export const emptyMathState = (): MathWorkbenchState => ({
  drawing: { points: [], lines: [], mode: 'cartesian' },
  expression: 'a*x^2+b*x+c',
  parameters: { a: 1, b: 0, c: 0 },
  measurement: [],
})
export interface AnswerDraft {
  choiceId?: string
  math?: MathWorkbenchState
  text: string
  blocks: AnswerBlock[]
  drawing: GeoDrawing
  /** Optional so existing version-1 drafts and attempt snapshots remain readable. */
  argument?: ArgumentDocument
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
  math: emptyMathState(),
  text: '',
  blocks: [],
  drawing: { points: [], lines: [], mode: 'cartesian' },
})
