import { z } from 'zod'

/** A grant authorizes a data category, never automatically selects data for a request. */
export const modelConsentScopes = [
  'grading',
  'generation',
  'advisor',
  'modules',
  'reference',
  'knowledge',
  'agent',
  'agent_answer',
  'agent_reference',
  'agent_knowledge',
  'agent_web',
  'web_public',
] as const
export type ModelConsentScope = (typeof modelConsentScopes)[number]
export interface ModelConsentGrantInput {
  baseUrl: string
  scopes: ModelConsentScope[]
}
export interface ModelConsentRevokeInput {
  baseUrl?: string
  scopes?: ModelConsentScope[]
}
export interface ModelConsentGrant extends ModelConsentGrantInput {
  grantedAt: string
}
export interface ModelConsentsState {
  version: 1
  revision: number
  grants: ModelConsentGrant[]
}
export interface ModelConsentApi {
  getModelConsents(): Promise<ModelConsentsState>
  grantModelConsent(input: ModelConsentGrantInput): Promise<ModelConsentsState>
  revokeModelConsent(input: ModelConsentRevokeInput): Promise<ModelConsentsState>
}

export const modelConsentDescriptions: Record<ModelConsentScope, string> = {
  grading:
    'AI 批改：当前题目、参考答案和评分依据、答案文字与模块、作图、数学函数与参数/测量，以及本次提供的考纲',
  generation: 'AI 出题：本次选择的考纲、章节和难度',
  advisor: '选区顾问：选中文字和必要的当前题目信息',
  modules: '模块审查：选中模块、逻辑结构、分组标签及成员关系和当前题目信息',
  reference: '额外参考：顾问或模块审查所需的本题解析和评分依据',
  knowledge: '教材摘录：每次明确选中的同学科摘录、书名和物理 PDF 页码',
  agent:
    'Agent 工作台：本次任务、选定范围内的题目信息和已启用工具的有限计算结果；工具结果会回传给主模型',
  agent_answer:
    'Agent 作答上下文：本次明确选中的当前答卷快照，包括正文、模块、绘图和数学参数；不含历史答卷',
  agent_reference:
    'Agent 参考访问：本次明确允许的题目解析、评分依据及评阅结果；这些结果也会回传给主模型',
  agent_web:
    'Agent 公开网络资料：本次明确确认的公开检索范围、来源链接和短摘录；可发送给已选择的主模型及实际参与的子模型',
  web_public:
    '公开资料检索：向 Tavily 发送本次明确确认的公开学科、章节、地区与年份；安全抓取会访问确认的公开来源网址，不附带答卷、教材正文或模型密钥',
  agent_knowledge:
    'Agent 教材检索：每次明确选定的教材和物理 PDF 页码范围内，由工具检索得到的有限摘录、书名和页码；结果会回传给主模型',
}

/** Browser-safe counterpart of the transport's endpoint validation. Path remains part
 * of the recipient identity; model and role deliberately do not. DNS is checked by
 * the transport, never by the consent UI or persistence layer. */
export function canonicalModelConsentBaseUrl(input: string): string {
  try {
    const url = new URL(input)
    if (
      input.length > 300 ||
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.port && url.port !== '443') ||
      /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) ||
      url.hostname.includes(':') ||
      !url.hostname.includes('.') ||
      /(^|\.)(localhost|local|internal|test|invalid|example|lan|home|metadata|onion)$/.test(
        url.hostname,
      ) ||
      !/^[a-z0-9.-]+$/.test(url.hostname) ||
      !/^\/[A-Za-z0-9/_-]*$/.test(url.pathname)
    )
      throw new Error()
    return url.href.replace(/\/$/, '')
  } catch {
    throw new Error('请输入公开服务的 HTTPS Base URL，不含认证信息、查询参数或内网地址。')
  }
}
const receiverSchema = z.string().transform((value, ctx) => {
  try {
    return canonicalModelConsentBaseUrl(value)
  } catch {
    ctx.addIssue({ code: 'custom', message: '无效的授权接收方地址。' })
    return z.NEVER
  }
})
const scopesSchema = z
  .array(z.enum(modelConsentScopes))
  .min(1)
  .max(modelConsentScopes.length)
  .refine((scopes) => new Set(scopes).size === scopes.length, '授权数据范围不可重复。')
  .transform((scopes) => modelConsentScopes.filter((scope) => scopes.includes(scope)))
export const modelConsentGrantSchema = z.strictObject({
  baseUrl: receiverSchema,
  scopes: scopesSchema,
})
export const modelConsentRevokeSchema = z.strictObject({
  baseUrl: receiverSchema.optional(),
  scopes: scopesSchema.optional(),
})
export const modelConsentsStateSchema = z
  .strictObject({
    version: z.literal(1),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    grants: z
      .array(modelConsentGrantSchema.extend({ grantedAt: z.iso.datetime() }).strict())
      .max(100),
  })
  .refine(
    (state) => new Set(state.grants.map((grant) => grant.baseUrl)).size === state.grants.length,
    '授权接收方不可重复。',
  )
export function emptyModelConsents(): ModelConsentsState {
  return { version: 1, revision: 0, grants: [] }
}
export function hasModelConsent(
  state: ModelConsentsState | null | undefined,
  baseUrl: string,
  scopes: readonly ModelConsentScope[],
): boolean {
  if (!state || !scopes.length || scopes.some((scope) => !modelConsentScopes.includes(scope)))
    return false
  let receiver: string
  try {
    receiver = canonicalModelConsentBaseUrl(baseUrl)
  } catch {
    return false
  }
  const grant = state.grants.find((item) => item.baseUrl === receiver)
  return Boolean(grant && scopes.every((scope) => grant.scopes.includes(scope)))
}
export function withoutModelConsents(
  state: ModelConsentsState,
  input: ModelConsentRevokeInput,
): ModelConsentsState {
  return {
    ...state,
    grants: state.grants.flatMap((grant) => {
      if (input.baseUrl && grant.baseUrl !== input.baseUrl) return [grant]
      if (!input.scopes) return []
      const scopes = grant.scopes.filter((scope) => !input.scopes!.includes(scope))
      return scopes.length ? [{ ...grant, scopes }] : []
    }),
  }
}
