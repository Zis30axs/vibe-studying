import { z } from 'zod'
import { subjects, subjectLabel } from './subjects'
import type { Subject } from './types'

export const WEB_RESEARCH_ENDPOINT = 'https://api.tavily.com'
export const WEB_RESEARCH_LIMITS = {
  searches: 2,
  fetches: 2,
  resultsPerSearch: 5,
  excerptCharacters: 1200,
  responseBytes: 256 * 1024,
} as const

/** Browser-safe syntax gate. The main transport separately pins and validates DNS. */
export function canonicalPublicResearchUrl(input: string): string {
  try {
    if (typeof input !== 'string' || input.length > 2048 || /[\\\s\u0000-\u001f\u007f]/.test(input))
      throw new Error()
    const url = new URL(input)
    const host = url.hostname.toLowerCase()
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      (url.port && url.port !== '443') ||
      !host.includes('.') ||
      host.endsWith('.') ||
      !/^[a-z0-9.-]+$/.test(host) ||
      /^[0-9.]+$/.test(host) ||
      host.length > 253 ||
      host
        .split('.')
        .some(
          (label) => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'),
        ) ||
      /(^|\.)(localhost|local|internal|test|invalid|example|lan|home|metadata|onion|arpa)$/.test(
        host,
      )
    )
      throw new Error()
    const decodedPath = decodeURIComponent(url.pathname)
    if (
      /[\u0000-\u001f\u007f]/.test(decodedPath) ||
      /(?:api[_-]?key|access[_-]?token|bearer|password|credential|secret)[=/:-]/i.test(decodedPath)
    )
      throw new Error()
    for (const [name, value] of url.searchParams) {
      if (
        /(?:key|token|auth|password|secret|credential|signature|session|cookie|code|redirect|callback)/i.test(
          name,
        ) ||
        /[\u0000-\u001f\u007f]/.test(name + value) ||
        value.length > 120 ||
        /(?:bearer|tvly-|sk-)[A-Za-z0-9_.-]{8,}/i.test(value)
      )
        throw new Error()
    }
    return url.href
  } catch {
    throw new Error('仅允许不含密钥、认证信息或内网地址的公开 HTTPS 网页。')
  }
}

export const publicResearchUrlSchema = z.string().transform((value, ctx) => {
  try {
    return canonicalPublicResearchUrl(value)
  } catch {
    ctx.addIssue({ code: 'custom', message: '仅允许不含认证信息的公开 HTTPS 网页。' })
    return z.NEVER
  }
})

/** User-confirmed public labels only. Never derive these fields from private work. */
export interface WebResearchScope {
  subject: Subject
  topic: string
  region: string
  years: number[]
  approvedUrls: string[]
}
const publicLabel = (length: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(length)
    .regex(/^[\p{L}\p{M}\p{N} ()（）·,，、-]+$/u)
export const webResearchScopeSchema = z.strictObject({
  subject: z.enum(subjects),
  topic: publicLabel(80),
  region: publicLabel(40),
  years: z.array(z.number().int().min(1990).max(2100)).min(1).max(5),
  approvedUrls: z.array(publicResearchUrlSchema).max(3),
})
export interface WebResearchRunRequest {
  provider: 'tavily'
  scope: WebResearchScope
  configRevision: number
  consent: boolean
}
export const webResearchRunRequestSchema = z.strictObject({
  provider: z.literal('tavily'),
  scope: webResearchScopeSchema,
  configRevision: z.number().int().nonnegative(),
  consent: z.boolean(),
})
export interface WebResearchConfig {
  provider: 'tavily'
  revision: number
  configured: boolean
  keyStatus: 'saved' | 'session' | 'missing' | 'locked'
  secureStorageAvailable: boolean
}
export interface WebResearchConfigInput {
  provider: 'tavily'
  apiKey?: string
  persistApiKey: boolean
  clearApiKey?: boolean
  expectedRevision: number
}
export interface WebResearchApi {
  getWebResearchConfig(): Promise<WebResearchConfig>
  saveWebResearchConfig(input: WebResearchConfigInput): Promise<WebResearchConfig>
}
export interface WebResearchSource {
  sourceId: string
  title: string
  url: string
  excerpt: string
  retrievedAt: string | null
  retrieved: boolean
  /** Merely a year mentioned by this untrusted source, not exam/publication verification. */
  yearEvidence: { year: number; evidence: string }[]
  provenance: 'tavily-search' | 'direct-fetch' | 'user-approved-url'
  untrusted: true
  verification: 'unverified'
}
export interface WebResearchBudget {
  searchesUsed: number
  searchesLimit: number
  fetchesUsed: number
  fetchesLimit: number
  /** Local request-count estimate; cancellation may still incur provider charges. */
  estimatedSearchCredits: number
  reportedCredits: number | null
}
export interface WebResearchResult {
  sources: WebResearchSource[]
  budget: WebResearchBudget
  untrusted: true
}
export interface WebResearchSession {
  search(input: { year?: number }, signal?: AbortSignal): Promise<WebResearchResult>
  fetch(input: { sourceId: string }, signal?: AbortSignal): Promise<WebResearchResult>
  getSources(): WebResearchSource[]
  getBudget(): WebResearchBudget
}

/** Identical browser preview and main-process query. Caller has already confirmed scope. */
export function buildWebResearchQuery(scope: WebResearchScope, year?: number): string {
  const parsed = webResearchScopeSchema.safeParse(scope)
  if (!parsed.success || (year !== undefined && !parsed.data.years.includes(year)))
    throw new Error('公开检索范围无效。')
  const value = parsed.data
  const years = year === undefined ? [...new Set(value.years)].sort().join(' ') : String(year)
  return `${subjectLabel[value.subject]} ${value.topic} ${value.region} ${years} 历年试题 考点 公开资料`
}
export const webResearchSourceFieldsSchema = z.strictObject({
  sourceId: z.string().regex(/^web-[a-f0-9-]{36}-[0-9]{1,2}$/),
  title: z.string().max(200),
  url: publicResearchUrlSchema,
  excerpt: z.string().max(WEB_RESEARCH_LIMITS.excerptCharacters),
  retrievedAt: z.string().datetime().nullable(),
  retrieved: z.boolean(),
  yearEvidence: z
    .array(
      z.strictObject({ year: z.number().int().min(1990).max(2100), evidence: z.string().max(160) }),
    )
    .max(5),
  provenance: z.enum(['tavily-search', 'direct-fetch', 'user-approved-url']),
  untrusted: z.literal(true),
  verification: z.literal('unverified'),
})
export const webResearchSourceSchema = webResearchSourceFieldsSchema.superRefine((source, ctx) => {
  if (
    source.retrieved
      ? !source.retrievedAt || source.provenance === 'user-approved-url'
      : source.retrievedAt !== null ||
        source.provenance !== 'user-approved-url' ||
        source.excerpt !== '' ||
        source.yearEvidence.length > 0
  )
    ctx.addIssue({ code: 'custom', message: '来源检索状态不一致。' })
})
export const webResearchBudgetSchema = z.strictObject({
  searchesUsed: z.number().int().min(0).max(WEB_RESEARCH_LIMITS.searches),
  searchesLimit: z.literal(WEB_RESEARCH_LIMITS.searches),
  fetchesUsed: z.number().int().min(0).max(WEB_RESEARCH_LIMITS.fetches),
  fetchesLimit: z.literal(WEB_RESEARCH_LIMITS.fetches),
  estimatedSearchCredits: z.number().int().min(0).max(WEB_RESEARCH_LIMITS.searches),
  reportedCredits: z.number().min(0).max(100).nullable(),
})
export const webResearchResultSchema = z.strictObject({
  sources: z.array(webResearchSourceSchema).max(15),
  budget: webResearchBudgetSchema,
  untrusted: z.literal(true),
})
