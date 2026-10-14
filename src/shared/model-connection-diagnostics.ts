/** Fixed diagnostic vocabulary. Never expose error messages, causes, addresses or headers. */
export const connectionStages = [
  'dns',
  'tls',
  'connect',
  'proxy',
  'security',
  'http',
  'response',
] as const
export type ConnectionStage = (typeof connectionStages)[number]
export const connectionCodes = [
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_FAIL',
  'DNS_LOOKUP_FAILED',
  'DNS_NO_ADDRESS',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION',
  'ENDPOINT_INVALID',
  'PROXY_CONFIG_INVALID',
  'PROXY_UNSUPPORTED',
  'PROXY_UNAVAILABLE',
  'PROXY_AUTH_REQUIRED',
  'PROXY_CONNECT_FAILED',
  'INVALID_HTTP_RESPONSE',
] as const
export type ConnectionCode = (typeof connectionCodes)[number]
export interface ModelConnectionDetails {
  stage: ConnectionStage
  networkCode?: ConnectionCode
  httpStatus?: number
}
export const connectionStageLabels: Record<ConnectionStage, string> = {
  dns: 'DNS 解析',
  tls: 'TLS 安全连接',
  connect: '建立连接',
  proxy: '代理连接',
  security: '目标地址安全检查',
  http: 'HTTP 响应',
  response: '读取响应',
}
export function safeConnectionCode(value: unknown): ConnectionCode | undefined {
  return typeof value === 'string' && (connectionCodes as readonly string[]).includes(value)
    ? (value as ConnectionCode)
    : undefined
}
export function sanitizeConnectionDetails(value: unknown): ModelConnectionDetails | undefined {
  if (!value || typeof value !== 'object') return
  const input = value as Record<string, unknown>
  if (!(connectionStages as readonly unknown[]).includes(input.stage)) return
  const networkCode = safeConnectionCode(input.networkCode)
  return {
    stage: input.stage as ConnectionStage,
    ...(networkCode ? { networkCode } : {}),
    ...(Number.isInteger(input.httpStatus) &&
    Number(input.httpStatus) >= 100 &&
    Number(input.httpStatus) <= 599
      ? { httpStatus: Number(input.httpStatus) }
      : {}),
  }
}
