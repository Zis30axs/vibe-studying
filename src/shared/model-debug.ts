import {
  sanitizeConnectionDetails,
  type ModelConnectionDetails,
} from './model-connection-diagnostics'
import type { ModelProtocol } from './types'

export const MODEL_DEBUG_LIMIT = 80
export const modelDebugStages = [
  'request',
  'http',
  'response',
  'envelope',
  'json',
  'schema',
] as const
export type ModelDebugStage = (typeof modelDebugStages)[number]
export const modelDebugCategories = [
  'ok',
  'auth',
  'rate_limit',
  'network',
  'timeout',
  'cancelled',
  'http',
  'parse',
  'truncated',
  'refusal',
  'envelope',
  'schema',
  'credential_reflection',
  'response_too_large',
] as const
export type ModelDebugCategory = (typeof modelDebugCategories)[number]

/** Only allowlisted metadata may cross this boundary. Never attach requests, replies or errors. */
export interface ModelDebugContext {
  readonly requestId: string
}
export interface ModelDebugEvent extends ModelDebugContext {
  stage: ModelDebugStage
  category: ModelDebugCategory
  elapsedMs: number
  protocol: ModelProtocol
  model: string
  httpStatus?: number
  operation?: 'model_list' | 'connection_test'
  connection?: ModelConnectionDetails
  schemaPaths?: string[]
}
export interface ModelDebugRecord extends ModelDebugEvent {
  id: number
}
export interface ModelDebugState {
  enabled: boolean
  limit: number
  records: ModelDebugRecord[]
}
export type ModelDebugRecorder = (event: ModelDebugEvent) => void
export interface ModelDebugApi {
  getModelDebug(): Promise<ModelDebugState>
  setModelDebugEnabled(enabled: boolean): Promise<ModelDebugState>
  clearModelDebug(): Promise<ModelDebugState>
  copyModelDebug(): Promise<void>
}

const fieldNames = new Set([
  'stop_reason',
  'content',
  'type',
  'text',
  'promptFeedback',
  'blockReason',
  'candidates',
  'finishReason',
  'parts',
  'status',
  'error',
  'output',
  'choices',
  'finish_reason',
  'message',
  'refusal',
  'tool_calls',
  'function_call',
  'feedback',
  'explanation',
  'groups',
  'memberIds',
  'partial',
  'rubric',
  'id',
  'earned',
  'score',
  'maxScore',
  'reviewer',
  'label',
  'possible',
  'hint',
  'requestId',
  'modules',
  'groups',
  'memberIds',
  'partial',
  'moduleId',
  'suggestions',
  'evidence',
  'citations',
  'evidenceStatus',
  'chunkId',
  'confirmations',
  'summary',
  'priority',
  'reason',
  'edit',
  'operation',
  'baseText',
  'start',
  'end',
  'expectedText',
  'replacement',
  'title',
  'prompt',
  'figure',
  'version',
  'kind',
  'description',
  'points',
  'x',
  'y',
  'segments',
  'from',
  'to',
  'arrows',
  'polylines',
  'polygons',
  'labels',
  'grid',
  'step',
  'keywords',
])

/** Dynamic record keys, provider values and Zod messages must never become diagnostic paths. */
export function safeModelDebugPaths(paths: readonly (readonly PropertyKey[])[]): string[] {
  const safe: string[] = []
  for (const path of paths.slice(0, 12)) {
    const parts = path
      .slice(0, 8)
      .map((part) =>
        typeof part === 'number'
          ? '[*]'
          : typeof part === 'string' && fieldNames.has(part)
            ? part
            : '[field]',
      )
    const value = parts.length ? parts.join('.').replaceAll('.[', '[') : '$'
    if (!safe.includes(value)) safe.push(value)
  }
  return safe
}

/** A configured model ID is useful metadata, but cannot be a URL or credential. */
export function safeModelDebugModel(model: unknown, secret?: string): string {
  if (
    typeof model !== 'string' ||
    !/^[^\u0000-\u001f\u007f]{1,120}$/.test(model) ||
    model.includes('://') ||
    /(?:^|[/:-])(?:sk-|AIza|Bearer|ghp_|github_pat_|eyJ)/i.test(model) ||
    (secret && model.includes(secret))
  )
    return '[redacted]'
  return model
}

/** Revalidate formatted paths at the storage boundary instead of trusting callback callers. */
export function sanitizeModelDebugEvent(input: ModelDebugEvent): ModelDebugEvent | undefined {
  if (
    !input ||
    typeof input !== 'object' ||
    !modelDebugStages.includes(input.stage) ||
    !modelDebugCategories.includes(input.category) ||
    !['anthropic', 'gemini', 'openai-responses', 'openai-chat'].includes(input.protocol) ||
    typeof input.requestId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId)
  )
    return
  const schemaPaths = Array.isArray(input.schemaPaths)
    ? input.schemaPaths.slice(0, 12).map((path) => {
        if (typeof path !== 'string' || path.length > 160) return '[field]'
        if (path === '$') return '$'
        const parts = path
          .replaceAll('[*]', '.[*]')
          .replaceAll('[field]', '.[field]')
          .split('.')
          .filter(Boolean)
        return safeModelDebugPaths([parts.map((part) => (part === '[*]' ? 0 : part))])[0]
      })
    : undefined
  const connection = sanitizeConnectionDetails(input.connection)
  return {
    requestId: input.requestId,
    stage: input.stage,
    category: input.category,
    elapsedMs: Number.isFinite(input.elapsedMs)
      ? Math.round(Math.max(0, Math.min(600000, input.elapsedMs)))
      : 0,
    protocol: input.protocol,
    model: safeModelDebugModel(input.model),
    ...(input.operation === 'model_list' || input.operation === 'connection_test'
      ? { operation: input.operation }
      : {}),
    ...(connection ? { connection } : {}),
    ...(Number.isInteger(input.httpStatus) && input.httpStatus! >= 100 && input.httpStatus! <= 599
      ? { httpStatus: input.httpStatus }
      : {}),
    ...(schemaPaths?.length ? { schemaPaths: [...new Set(schemaPaths)] } : {}),
  }
}
