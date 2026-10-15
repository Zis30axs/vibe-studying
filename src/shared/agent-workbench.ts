import type { FormulaReferenceReceipt } from './formula-tools'
import type { WebResearchRunRequest, WebResearchBudget, WebResearchSource } from './web-research'
import type { AnswerDraft, StudentQuestion, Subject } from './types'
import type { AgentToolName, AgentToolProposal } from './agent-tool-context'

export const AGENT_BUDGET = Object.freeze({
  modelRequests: 3,
  toolCalls: 6,
  delegatedCalls: 2,
  timeoutMs: 120000,
  sessionRequests: 30,
})
export interface AgentRunRequest {
  runId: string
  task: string
  subject: Subject
  mode: 'learner' | 'review' | 'create'
  questionIds: string[]
  currentQuestionId?: string
  answer?: AnswerDraft
  /** Local provenance baseline only. Never included in a model payload unless answer is selected. */
  localDraft?: AnswerDraft
  includeReference: boolean
  knowledge?: { documentId: string; startPage: number; endPage: number }
  allowedTools: AgentToolName[]
  configRevision: number
  parentConsent: boolean
  childConsent: boolean
  web?: WebResearchRunRequest
}
export interface AgentRunEvent {
  sequence: number
  kind: 'model' | 'tool' | 'delegate' | 'finish'
  status: 'running' | 'complete' | 'failed' | 'cancelled'
  tool?: AgentToolName
  role?: 'parent' | 'child'
  elapsedMs: number
}
export interface AgentProposalPreview {
  proposalId: string
  proposal: AgentToolProposal
}
export interface AgentRunState {
  skillReceipts?: { skillId: import('./agent-skills').AgentSkillId; version: string }[]
  runId: string
  status: 'running' | 'complete' | 'failed' | 'cancelled'
  startedAt: number
  elapsedMs: number
  modelRequests: number
  toolCalls: number
  delegatedCalls: number
  sessionRequests: number
  budget: typeof AGENT_BUDGET
  events: AgentRunEvent[]
  text: string
  message: string
  proposals: AgentProposalPreview[]
  /** Host-built receipts for bundled formulas actually returned by tools, never model citations. */
  formulaReferences?: FormulaReferenceReceipt[]
  web?: { budget: WebResearchBudget; sources: WebResearchSource[] }
}
export interface AgentWorkbenchApi {
  startAgentRun(request: AgentRunRequest): Promise<AgentRunState>
  getAgentRun(runId: string): Promise<AgentRunState | null>
  cancelAgentRun(runId: string): Promise<void>
  acceptAgentProposal(input: {
    runId: string
    proposalId: string
    currentQuestionId?: string
    currentAnswer?: AnswerDraft
  }): Promise<
    | { kind: 'question'; question: StudentQuestion }
    | { kind: 'answer-edit'; questionId: string; expectedText: string; replacement: string }
  >
  discardAgentProposal(input: { runId: string; proposalId: string }): Promise<void>
}
