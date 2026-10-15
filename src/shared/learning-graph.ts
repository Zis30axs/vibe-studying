import { z } from 'zod'
import type { AnswerDraft, Subject } from './types'

export const assistanceStatuses = ['independent', 'referenced-ai', 'adopted-ai', 'unknown'] as const
export type AssistanceStatus = (typeof assistanceStatuses)[number]
export const assistanceLabels: Record<AssistanceStatus, string> = {
  independent: '独立作答',
  'referenced-ai': '参考过 AI',
  'adopted-ai': '采纳过 AI 修改',
  unknown: '来源未记录',
}
const graphId = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
  .refine((value) => !['__proto__', 'prototype', 'constructor'].includes(value))
export const submissionAssistanceSchema = z.strictObject({
  version: z.literal(1),
  snapshotId: graphId,
  status: z.enum(assistanceStatuses),
  helpBranchIds: z.array(graphId).max(2000),
  /** An assisted record can still have unknown history preceding this installation. */
  unknownHistory: z.boolean(),
})
export type SubmissionAssistance = z.infer<typeof submissionAssistanceSchema>
export const helpKinds = [
  'selection',
  'module-review',
  'submission-review',
  'geography-generation',
  'agent',
] as const
export type HelpKind = (typeof helpKinds)[number]
export const helpKindLabels: Record<HelpKind, string> = {
  selection: '选区求助',
  'module-review': '模块建议',
  'submission-review': 'AI 评阅',
  'geography-generation': 'AI 出题',
  agent: 'Agent 求助',
}
export const traceTools = [
  'list_skills',
  'run_skill',
  'web_search',
  'web_fetch',
  'math_plot',
  'math_measure',
  'geometry_calculate',
  'generate_geometry_question',
  'geography_measure',
  'terrain_calculate',
  'review_answer',
  'advise_selection',
  'review_modules',
  'generate_question',
  'propose_answer_edit',
  'propose_question',
  'list_questions',
  'get_question',
  'search_formulas',
  'get_formula',
  'get_draft',
  'get_attempts',
  'search_knowledge',
  'resolve_knowledge',
  'read_knowledge',
  'propose_answer',
  'propose_argument',
  'delegate',
  'other',
] as const
export type LearningToolName = (typeof traceTools)[number]
export type HelpState = 'pending' | 'received' | 'failed' | 'canceled' | 'rejected' | 'merged'
export interface LearningScope {
  questionId: string
  subject: Subject
}
export interface LearningSnapshot extends LearningScope {
  id: string
  parentId: string | null
  lineageId: string
  createdAt: number
  draft: AnswerDraft
  origin: 'independent' | 'unknown'
  reason: 'edit' | 'baseline' | 'independent' | 'restore' | 'merge'
  restoredFromSnapshotId?: string
  mergedBranchId?: string
  argumentRevisionId?: string
}
export interface LearningHelpBranch {
  id: string
  snapshotId: string
  requestId: string
  kind: HelpKind
  createdAt: number
}
export interface LearningToolTrace {
  /** Never raw arguments, tool output, filenames, endpoint, or model configuration. */
  tool: LearningToolName
  outcome: 'completed' | 'failed' | 'canceled'
}
export type LearningEvent =
  | {
      id: string
      createdAt: number
      type: 'help-received' | 'help-failed' | 'help-canceled' | 'help-rejected'
      branchId: string
      detail?: { prompt?: string; response: string; truncated?: boolean }
    }
  | { id: string; createdAt: number; type: 'help-merged'; branchId: string; snapshotId: string }
  | { id: string; createdAt: number; type: 'tool'; branchId: string; trace: LearningToolTrace }
  | {
      id: string
      createdAt: number
      type: 'submission'
      snapshotId: string
      attemptId: string
      assistance: SubmissionAssistance
    }
export interface LearningGraphState {
  version: 1
  snapshots: LearningSnapshot[]
  branches: LearningHelpBranch[]
  events: LearningEvent[]
  heads: Record<string, string>
}
export interface CaptureLearningSnapshot extends LearningScope {
  draft: AnswerDraft
  /** Omission permits a normal serialized save; supply for compare-and-swap UI actions. */
  expectedHeadId?: string | null
  mode?: 'continue' | 'independent' | 'restore'
  restoreSnapshotId?: string
  /** Trusted host sets unknown when migrating an already existing draft. */
  initialOrigin?: 'independent' | 'unknown'
}
export interface BeginLearningHelp {
  snapshotId: string
  requestId: string
  kind: HelpKind
}
export interface AcceptLearningHelp {
  branchId: string
  expectedSnapshotId: string
  draft: AnswerDraft
}
export interface LearningGraphApi {
  getLearningGraph(): Promise<LearningGraphState>
  restoreLearningSnapshot(input: {
    snapshotId: string
    expectedHeadId: string
  }): Promise<LearningSnapshot>
  acceptModuleSuggestion(input: {
    requestId: string
    suggestionId: string
    expectedDraft: AnswerDraft
  }): Promise<AnswerDraft>
  rejectLearningHelp(requestId: string): Promise<void>
}
