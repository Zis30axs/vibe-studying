import type { AnswerDraft, Question, Subject } from './types'
import type { KnowledgeEvidence, KnowledgeSearchInput } from './knowledge'
import type { WebResearchResult, WebResearchScope, WebResearchSource } from './web-research'
import type { Review } from '../adapters/contracts'
import type { AdvisorContext, Immutable, ModuleAdvisorContext } from '../adapters/review-contexts'
import type {
  AdvisorResult,
  ModuleReviewResult,
  AdvisorRequest,
  ModuleReviewRequest,
} from './types'

export const AGENT_TOOL_NAMES = [
  'list_questions',
  'get_question',
  'search_knowledge',
  'resolve_knowledge',
  'web_search',
  'web_fetch',
  'math_plot',
  'math_measure',
  'geography_measure',
  'terrain_calculate',
  'review_answer',
  'advise_selection',
  'review_modules',
  'generate_question',
  'propose_answer_edit',
  'propose_question',
] as const
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number]
export interface AgentToolConsent {
  reference: boolean
  knowledge: boolean
}
/** Main-process authority only. Never construct this from a model tool argument.
 * The factory takes its own immutable copy; tools can only narrow this scope. */
export interface AgentToolContext {
  subject: Subject
  mode: 'learner' | 'review' | 'create'
  questionIds: string[]
  currentQuestionId?: string
  answer?: AnswerDraft
  includeReference: boolean
  knowledge?: { documentId: string; startPage: number; endPage: number }
  /** Only the immutable, user-confirmed public search labels. Never private task text. */
  web?: { scope: WebResearchScope; consent: boolean }
  allowedTools: AgentToolName[]
  parentConsent: AgentToolConsent
  childConsent: AgentToolConsent
}
export type AgentToolProposal =
  | {
      kind: 'answer-edit'
      questionId: string
      expectedText: string
      replacement: string
      reason: string
    }
  | { kind: 'question'; question: Question }
export interface AgentToolAdapters {
  getQuestion(questionId: string): Promise<Question>
  searchKnowledge?(input: KnowledgeSearchInput): Promise<KnowledgeEvidence[]>
  /** Main-process canonical library lookup only; never accept model-authored evidence. */
  resolveKnowledge?(chunkIds: string[]): Promise<KnowledgeEvidence[]>
  /** Verify the current index association and canonical source digests within this scope.
   * Persisted index metadata grants no authority and must never be returned as evidence. */
  resolveKnowledgeIndex?(input: {
    nodeId: string
    documentId: string
    startPage: number
    endPage: number
    subject: Subject
  }): Promise<KnowledgeEvidence[]>
  /** Bind all roles to one owning session, which enforces URL scope and aggregate budgets. */
  webSearch?(input: { year?: number }): Promise<WebResearchResult>
  webFetch?(input: { sourceId: string }): Promise<WebResearchResult>
  /** Main-process source inventory only. No model-authored citations may be inserted here. */
  getWebSources?(): WebResearchSource[]
  /** Bounded delegation. The owning AgentService enforces aggregate model/tool quotas. */
  reviewAnswer?(input: { question: Question; draft: AnswerDraft }): Promise<Review>
  adviseSelection?(
    context: Immutable<AdvisorContext>,
    metadata: { request: AdvisorRequest; evidence: KnowledgeEvidence[] },
  ): Promise<AdvisorResult>
  reviewModules?(
    context: Immutable<ModuleAdvisorContext>,
    metadata: { request: ModuleReviewRequest },
  ): Promise<ModuleReviewResult>
  generateQuestion?(input: {
    subject: Subject
    topic: string
    difficulty: '基础' | '进阶' | '挑战'
    mode?: 'schematic' | 'terrain'
  }): Promise<Question>
  /** Session-only staging. This callback MUST NOT write a draft, bank, or submission. */
  onProposal?(proposal: AgentToolProposal): Promise<{ proposalId: string }>
}
export interface AgentToolExecutionResult {
  output: unknown
  isError?: boolean
}
