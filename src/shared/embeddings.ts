import { z } from 'zod'
import { modelIdSchema } from './model-id'
import {
  knowledgeChunkIdSchema,
  knowledgeDocumentIdSchema,
  knowledgeSubjectSchema,
  type KnowledgeHit,
  type KnowledgeSearchInput,
} from './knowledge'

/** A separately configured provider. No chat profile or chat credential is inherited. */
export interface EmbeddingConfig {
  enabled: boolean
  baseUrl: string
  model: string
  revision: number
  configured: boolean
  keyStatus: 'session' | 'saved' | 'missing' | 'locked'
  secureStorageAvailable: boolean
}
export const EMBEDDING_DIAGNOSTIC_TEXT = 'ExamCraft embedding connection diagnostic.'
export function canonicalEmbeddingBaseUrl(raw: string): string {
  try {
    if (raw.length > 300 || raw !== raw.trim() || /[\u0000-\u0020\u007f\\]/u.test(raw))
      throw new Error()
    const url = new URL(raw)
    if (url.username || url.password || url.search || url.hash || !url.hostname) throw new Error()
    const loopback = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/u.test(raw)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error()
    return url.href.replace(/\/$/u, '')
  } catch {
    throw new Error(
      'Embedding 地址须为 HTTPS，或本机 localhost / 127.0.0.1 / [::1] HTTP；不能含凭据、查询或片段。',
    )
  }
}
export const embeddingBaseUrlSchema = z.string().transform((raw, context) => {
  try {
    return canonicalEmbeddingBaseUrl(raw)
  } catch {
    context.addIssue({
      code: 'custom',
      message: 'Embedding 地址须为 HTTPS 或明确的本机 HTTP，且不能包含凭据、查询或片段。',
    })
    return z.NEVER
  }
})
export const embeddingConfigInputSchema = z.strictObject({
  enabled: z.boolean(),
  baseUrl: embeddingBaseUrlSchema,
  model: modelIdSchema,
  apiKey: z
    .string()
    .trim()
    .max(4096)
    .regex(/^[^\u0000-\u001f\u007f]*$/u)
    .optional(),
  clearApiKey: z.boolean().optional(),
  persistApiKey: z.boolean().default(false),
  expectedRevision: z.number().int().nonnegative(),
})
export type EmbeddingConfigInput = z.input<typeof embeddingConfigInputSchema>
export const embeddingScopeSchema = z
  .strictObject({
    subject: knowledgeSubjectSchema,
    documentId: knowledgeDocumentIdSchema,
    startPage: z.number().int().min(1).max(1500),
    endPage: z.number().int().min(1).max(1500),
  })
  .refine((v) => v.startPage <= v.endPage && v.endPage - v.startPage < 100)
export type EmbeddingScope = z.infer<typeof embeddingScopeSchema>
export const embeddingPrepareSchema = embeddingScopeSchema
  .safeExtend({
    kind: z.enum(['index', 'search']),
    chunkIds: z
      .array(knowledgeChunkIdSchema)
      .max(3)
      .refine((ids) => new Set(ids).size === ids.length),
    query: z.string().trim().min(1).max(300).optional(),
    expectedRevision: z.number().int().nonnegative(),
  })
  .refine((v) => (v.kind === 'search' ? !!v.query : v.chunkIds.length > 0))
export type EmbeddingPrepareInput = z.infer<typeof embeddingPrepareSchema>
export interface EmbeddingPreview {
  previewId: string
  kind: 'index' | 'search'
  baseUrl: string
  model: string
  revision: number
  subject: EmbeddingScope['subject']
  documentId: string
  startPage: number
  endPage: number
  expiresAt: string
  /** Only these exact displayed strings will be transmitted after confirmation. */
  texts: { chunkId?: string; pageNumber?: number; text: string; sha256: string }[]
}
export interface EmbeddingResult {
  mode: 'indexed' | 'vector' | 'keyword'
  indexedCount?: number
  hits?: KnowledgeHit[]
  fallbackReason?: string
}
export interface EmbeddingDiagnostic {
  ok: boolean
  dimensions?: number
  latencyMs?: number
  error?: string
}
export interface EmbeddingApi {
  getEmbeddingConfig(): Promise<EmbeddingConfig>
  saveEmbeddingConfig(input: EmbeddingConfigInput): Promise<EmbeddingConfig>
  diagnoseEmbedding(input: {
    expectedRevision: number
    cloudConsent: true
  }): Promise<EmbeddingDiagnostic>
  prepareEmbedding(input: EmbeddingPrepareInput): Promise<EmbeddingPreview>
  confirmEmbedding(input: { previewId: string; cloudConsent: true }): Promise<EmbeddingResult>
  searchEmbeddingLocal(input: KnowledgeSearchInput): Promise<EmbeddingResult>
  clearEmbeddingIndex(input: EmbeddingScope): Promise<void>
}
