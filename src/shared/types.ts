import type { GeoboardState } from './geoboard-types'
import type { EmbeddingApi } from './embeddings'
import type { GeometryScene } from './geometry'
import type { ReviewKnowledgeApi } from './review-knowledge'
import type { WebResearchApi } from './web-research'
import type { LearningGraphApi } from './learning-graph'
import type { SubmissionAssistance } from './learning-graph'
import type { TerrainExercise } from './terrain'
import type { AgentWorkbenchApi } from './agent-workbench'
import type { AppearanceApi } from './appearance'
import type { ModelDebugApi } from './model-debug'
import type { ModelConsentApi } from './model-consent'
import type { KnowledgeApi } from './knowledge'
import type { GitHubDisplayProfile } from './github-profile'
import type { QuestionResearchOrigin, QuestionResearchSource } from './question-research'
import type { ModelNetworkConfig } from './model-network'
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
export interface ArgumentPosition {
  x: number
  y: number
}
export interface ArgumentCanvas {
  /** Visual coordinates do not determine answer order or logical parentage. */
  positions: Record<string, ArgumentPosition>
  viewport: { x: number; y: number; zoom: number }
}
export interface ArgumentGroup {
  id: string
  /** Optional student-authored label, never an inferred subquestion number. */
  label: string
  /** Ordered, flat membership; independent of logical parentage and answer order. */
  memberIds: string[]
}
export interface ArgumentSnapshot {
  roots: ArgumentNode[]
  groups?: ArgumentGroup[]
  canvas?: ArgumentCanvas
}
export interface ArgumentRevision {
  id: string
  parentId: string | null
  label: string
  createdAt: number
  source: 'manual' | 'ai'
  /** Explicit snapshot shape prevents recursive timeline copies. */
  snapshot: ArgumentSnapshot
}
export interface ArgumentRevisions {
  headId: string
  nodes: ArgumentRevision[]
}
export interface ArgumentDocument {
  version: 1
  roots: ArgumentNode[]
  groups?: ArgumentGroup[]
  /** Missing on legacy documents; a deterministic layout is generated on first edit. */
  canvas?: ArgumentCanvas
  revisions?: ArgumentRevisions
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
/** Bounded declarative schematic; never a factual or authoritative map. */
export interface GeographyFigure {
  version: 1
  kind: 'schematic'
  title: string
  description: string
  points: { id: string; x: number; y: number; label?: string }[]
  segments: { id: string; from: string; to: string }[]
  arrows: { id: string; from: string; to: string }[]
  polylines: { id: string; points: string[] }[]
  polygons: { id: string; points: string[] }[]
  labels: { id: string; x: number; y: number; text: string }[]
  grid?: { step: number }
}
export interface QuestionProvenance {
  kind: 'ai-generated'
  model: string
  protocol: ModelProtocol
  generatedAt: string
  verified: false
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
  figure?: GeographyFigure
  /** Bounded numerical geometry, with no answer or metric fields. */
  geometry?: GeometryScene
  terrain?: TerrainExercise
  provenance?: QuestionProvenance
  /** Host-assigned generation/source labels. These never verify authenticity as a past exam. */
  researchOrigin?: QuestionResearchOrigin
  researchSources?: QuestionResearchSource[]
  choices?: { id: string; text: string }[]
  correctAnswer?: string
  blocks?: AnswerBlock[]
  rubric?: RubricItem[]
}
/** Public question data available before submission. Reference blocks and grading keys
 * deliberately do not cross the renderer boundary. This allowlist must remain explicit. */
export type StudentQuestion = Pick<
  Question,
  | 'id'
  | 'subject'
  | 'kind'
  | 'title'
  | 'prompt'
  | 'source'
  | 'tags'
  | 'maxScore'
  | 'choices'
  | 'figure'
  | 'geometry'
  | 'terrain'
  | 'provenance'
  | 'researchOrigin'
  | 'researchSources'
>
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
export interface GeoMapPreferences {
  layer: 'outline' | 'terrain' | 'admin1'
  longitude: number
  latitude: number
  zoom: number
  showGrid: boolean
  showLabels?: boolean
}
export interface GeoDrawing {
  points: GeoPoint[]
  lines: GeoLine[]
  mode: 'cartesian' | 'geographic'
  /** Optional offline map view; older coordinate-only drawings remain unchanged. */
  map?: GeoMapPreferences
}
export interface MathParameters {
  a: number
  b: number
  c: number
}
export interface MathWorkbenchState {
  /** Optional, independently undoable 2-D constructions; absent on legacy drafts. */
  geoboard?: GeoboardState
  geometry?: GeometryScene
  rightAngles?: { id: string; vertex: string; from: string; to: string }[]
  drawing: GeoDrawing
  expression: string
  parameters: MathParameters
  measurement: string[]
  /** Optional canvas preferences preserve old drafts and historical snapshots unchanged. */
  snapStep?: number
  showProjections?: boolean
  projectionColor?: string
}
export const emptyMathState = (): MathWorkbenchState => ({
  drawing: { points: [], lines: [], mode: 'cartesian' },
  expression: 'a*x^2+b*x+c',
  parameters: { a: 1, b: 0, c: 0 },
  measurement: [],
  snapStep: 1,
  showProjections: true,
  projectionColor: '#b8c0c8',
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
  /** Immutable provenance at this real submission; absent on legacy records. */
  assistance?: SubmissionAssistance
  /** Student-safe question snapshot keeps imported/generated figures stable in history. */
  questionSnapshot?: StudentQuestion
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
export type ModelProtocol = 'anthropic' | 'gemini' | 'openai-responses' | 'openai-chat'
export type ModelRole = 'parent' | 'child'
export interface ModelConfig {
  protocol: ModelProtocol
  baseUrl: string
  model: string
  /** Omitted by older clients; defaults to a public HTTPS direct connection. */
  network?: ModelNetworkConfig
  revision: number
  configured: boolean
  profileId?: string
  profileName?: string
}
export interface ModelConfigInput {
  protocol: ModelProtocol
  baseUrl: string
  model: string
  network?: ModelNetworkConfig
  apiKey?: string
  clearApiKey?: boolean
}
export type ModelKeyStatus = 'saved' | 'session' | 'missing' | 'locked'
export interface ModelProfile extends ModelConfig {
  profileId: string
  profileName: string
  keyStatus: ModelKeyStatus
}
export interface ModelProfilesState {
  revision: number
  profiles: ModelProfile[]
  roles: Record<ModelRole, string>
  secureStorageAvailable: boolean
}
export interface ModelProfileInput extends ModelConfigInput {
  profileId?: string
  profileName: string
  /** Explicit choice: persist only via OS encryption; never plaintext fallback. */
  persistApiKey: boolean
  expectedRevision: number
}
export interface ModelRoleInput {
  roles: Record<ModelRole, string>
  expectedRevision: number
}
export interface ModelProfileDeleteInput {
  profileId: string
  expectedRevision: number
}
export interface ModelDiagnosticInput {
  requestId: string
  expectedRevision: number
  profileId?: string
  protocol: ModelProtocol
  baseUrl: string
  model: string
  network?: ModelNetworkConfig
  apiKey?: string
  kind: 'list' | 'test'
}
export interface ModelDiagnosticResult {
  error?: {
    code: string
    message: string
    details?: import('./model-connection-diagnostics').ModelConnectionDetails
  }
  models?: { id: string; name?: string }[]
  latencyMs?: number
}
export interface AdvisorRequest {
  requestId: string
  selectedText: string
  source: 'question' | 'material' | 'answer' | 'argument'
  questionId: string
  includeReference: boolean
  cloudConsent: boolean
  configRevision: number
  /** Only stable local IDs cross IPC. The main process resolves exact source text. */
  knowledgeChunkIds?: string[]
}
export interface AdvisorCitation {
  chunkId: string
  documentId: string
  documentTitle: string
  /** Physical, 1-based PDF page; not a printed textbook page label. */
  pageNumber: number
}
export interface AdvisorResult {
  requestId: string
  hint: string
  citations: AdvisorCitation[]
  evidenceStatus: 'not-requested' | 'supported' | 'insufficient'
}
export interface ModuleReviewSpan {
  moduleId: string
  /** UTF-16 offsets into the exact module text. */
  start: number
  end: number
  expectedText: string
}
export interface ModuleReviewEdit {
  operation: 'replace'
  baseText: string
  start: number
  end: number
  expectedText: string
  replacement: string
}
export interface ModuleReviewSuggestion {
  id: string
  moduleId: string
  priority: 'must-fix' | 'optional' | 'uncertain'
  reason: string
  evidence: string
  edit?: ModuleReviewEdit
}
export interface ModuleReviewRequest {
  requestId: string
  cloudConsent: boolean
  configRevision: number
  scope: 'selected' | 'all'
  questionId: string
  includeReference: boolean
  /** Logical scope only. No canvas, revision history, or final answer. */
  roots: ArgumentNode[]
  groups?: (ArgumentGroup & { partial: boolean })[]
  selectedSpans?: ModuleReviewSpan[]
}
export interface ModuleReviewResult {
  requestId: string
  configRevision: number
  summary: string
  confirmations: { moduleId: string; text: string }[]
  suggestions: ModuleReviewSuggestion[]
}
export interface SubmissionOptions {
  provider: 'local' | 'deepseek' | 'cloud'
  configRevision?: number
  cloudConsent?: boolean
  syllabus?: string
}
export interface Capabilities {
  questionBank: string
  reviewer: string
  mcp: string
  model?: ModelConfig
  deepseek?: { configured: boolean; model: string; endpoint: string; error?: string }
}
export interface GenerateGeographyRequest {
  mode?: 'schematic' | 'terrain'
  requestId: string
  syllabus: string
  chapter: string
  difficulty: '基础' | '进阶' | '挑战'
  cloudConsent: boolean
  configRevision: number
}
export interface GeneratedQuestionPreview {
  requestId: string
  token: string
  question: StudentQuestion
}
export interface ExamCraftApi
  extends
    EmbeddingApi,
    ReviewKnowledgeApi,
    WebResearchApi,
    KnowledgeApi,
    ModelConsentApi,
    ModelDebugApi,
    AppearanceApi,
    AgentWorkbenchApi,
    LearningGraphApi {
  cancelModelReview(): Promise<void>
  getGenerationStatus(): Promise<{ used: number; limit: number; pending: number }>
  generateGeographyQuestion(
    input: GenerateGeographyRequest,
    localContext?: { questionId: string; draft: AnswerDraft },
  ): Promise<GeneratedQuestionPreview>
  acceptGeneratedQuestion(token: string): Promise<StudentQuestion>
  rejectGeneratedQuestion(token: string): Promise<void>
  cancelQuestionGeneration(requestId: string): Promise<void>
  getGitHubProfile(): Promise<GitHubDisplayProfile | null>
  setGitHubProfile(username: string): Promise<GitHubDisplayProfile>
  clearGitHubProfile(): Promise<void>
  getModelConfig(role?: ModelRole): Promise<ModelConfig>
  getModelProfiles(): Promise<ModelProfilesState>
  diagnoseModel(input: ModelDiagnosticInput): Promise<ModelDiagnosticResult>
  cancelModelDiagnostic(requestId: string): Promise<void>
  saveModelProfile(input: ModelProfileInput): Promise<ModelProfilesState>
  assignModelProfiles(input: ModelRoleInput): Promise<ModelProfilesState>
  deleteModelProfile(input: ModelProfileDeleteInput): Promise<ModelProfilesState>
  saveModelConfig(input: ModelConfigInput): Promise<ModelConfig>
  askAdvisor(input: AdvisorRequest, localDraft?: AnswerDraft): Promise<AdvisorResult>
  cancelAdvisor(requestId: string): Promise<void>
  reviewModules(input: ModuleReviewRequest, localDraft?: AnswerDraft): Promise<ModuleReviewResult>
  cancelModuleReview(requestId: string): Promise<void>
  listQuestions(): Promise<StudentQuestion[]>
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
export const emptyDraft = (kind?: string): AnswerDraft => ({
  math: emptyMathState(),
  text: '',
  blocks: [],
  drawing: { points: [], lines: [], mode: kind === 'geography' ? 'geographic' : 'cartesian' },
})
