import { safeConnectionCode } from '../shared/model-connection-diagnostics'
import { containsCredentialText } from './credential-reflection'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { lookup } from 'node:dns'
import { isIP } from 'node:net'
import { request } from 'node:https'
import { Readable } from 'node:stream'
import type { ModelProtocol } from '../shared/types'
import {
  safeModelDebugModel,
  safeModelDebugPaths,
  sanitizeModelDebugEvent,
  type ModelDebugCategory,
  type ModelDebugContext,
  type ModelDebugEvent,
  type ModelDebugRecorder,
  type ModelDebugStage,
} from '../shared/model-debug'

export const protocolSchema = z.enum(['anthropic', 'gemini', 'openai-responses', 'openai-chat'])
export function validateBaseUrl(input: string): string {
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
      isIP(url.hostname) ||
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
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number)
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && [0, 168].includes(b)) ||
      (a === 198 && [18, 19, 51].includes(b)) ||
      (a === 203 && b === 0)
    )
  }
  // Only globally routable unicast; reject mapped IPv4, local, documentation and multicast ranges.
  return isIP(address) === 6 && /^[23]/i.test(address) && !/^2001:(db8|0|10|20):/i.test(address)
}
/** DNS validation occurs in the actual connection lookup, avoiding check/use rebinding. */
export const secureFetch: typeof fetch = async (input, init) =>
  new Promise((resolve, reject) => {
    const req = request(
      String(input),
      {
        method: init?.method ?? 'POST',
        headers: init?.headers as Record<string, string>,
        signal: init?.signal ?? undefined,
        lookup: (hostname, options, callback) =>
          lookup(hostname, { all: true }, (error, addresses) => {
            if (error || !addresses.length || addresses.some((a) => !isPublicAddress(a.address))) {
              const code = error
                ? (safeConnectionCode(error.code) ?? 'DNS_LOOKUP_FAILED')
                : !addresses.length
                  ? 'DNS_NO_ADDRESS'
                  : 'ENDPOINT_NOT_PUBLIC'
              callback(Object.assign(new Error('Endpoint unavailable'), { code }), [], undefined)
              return
            }
            if (options.all) callback(null, addresses)
            else callback(null, addresses[0].address, addresses[0].family)
          }),
      },
      (response) => {
        try {
          const headers = new Headers()
          for (const [key, value] of Object.entries(response.headers))
            if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
          if ([204, 205, 304].includes(response.statusCode ?? 0)) response.resume()
          resolve(
            new Response(
              [204, 205, 304].includes(response.statusCode ?? 0)
                ? null
                : (Readable.toWeb(response) as ReadableStream<Uint8Array>),
              {
                status: response.statusCode ?? 500,
                headers,
              },
            ),
          )
        } catch {
          response.destroy()
          reject(
            Object.assign(new Error('Invalid HTTP response'), { code: 'INVALID_HTTP_RESPONSE' }),
          )
        }
      },
    )
    req.on('error', reject)
    req.end(init?.method?.toUpperCase() === 'GET' ? undefined : (init?.body as string))
  })
const text = z.string().trim().min(1).max(100000)
function extract(protocol: ModelProtocol, value: unknown): string {
  if (protocol === 'anthropic')
    return z
      .object({
        stop_reason: z.literal('end_turn'),
        content: z
          .array(z.object({ type: z.literal('text'), text }))
          .min(1)
          .max(20),
      })
      .parse(value)
      .content.map((x) => x.text)
      .join('\n')
  if (protocol === 'gemini') {
    const result = z
      .object({
        promptFeedback: z.object({ blockReason: z.never().optional() }).optional(),
        candidates: z
          .array(
            z.object({
              finishReason: z.literal('STOP'),
              content: z.object({ parts: z.array(z.strictObject({ text })).min(1).max(20) }),
            }),
          )
          .length(1),
      })
      .parse(value)
    return result.candidates[0].content.parts.map((x) => x.text).join('\n')
  }
  if (protocol === 'openai-responses') {
    const result = z
      .object({
        status: z.literal('completed'),
        error: z.null().optional(),
        output: z
          .array(
            z.object({
              type: z.literal('message'),
              status: z.literal('completed').optional(),
              content: z
                .array(z.object({ type: z.literal('output_text'), text }))
                .min(1)
                .max(20),
            }),
          )
          .min(1)
          .max(20),
      })
      .parse(value)
    return result.output.flatMap((x) => x.content.map((c) => c.text)).join('\n')
  }
  return z
    .object({
      choices: z
        .array(
          z.object({
            finish_reason: z.literal('stop'),
            message: z.object({
              content: text,
              refusal: z.null().optional(),
              tool_calls: z.array(z.unknown()).max(0).optional(),
              function_call: z.never().optional(),
            }),
          }),
        )
        .length(1),
    })
    .parse(value).choices[0].message.content
}
const transportMessages = {
  auth: '模型身份验证失败，请检查 API Key 和访问权限。',
  rate_limit: '模型请求受限或额度不足，请稍后重试或检查服务额度。',
  network: '无法连接模型服务，请检查网络和接口地址。',
  timeout: '模型请求超时，请稍后重试。',
  cancelled: '请求已取消。',
  http: '模型服务拒绝了请求，请检查接口地址、模型名称和所选协议。',
  parse: '模型返回的 JSON 格式无效；可开启 Debug 查看失败阶段后手动重试。',
  truncated: '模型响应因输出长度限制而截断；请缩短本次内容，或更换支持更长输出的模型。',
  refusal: '模型服务明确拒绝或过滤了本次响应；请检查本次内容或更换模型。',
  envelope: '模型响应结构与所选协议不符；请核对协议、接口地址和模型名称。',
  schema: '模型评阅失败：评分字段或评分项不符合要求；作答已保留。',
  credential_reflection: '模型响应包含敏感认证信息，已拦截；请检查模型服务。',
  response_too_large: '模型响应超过安全大小限制，已停止读取；请减少本次内容。',
} satisfies Record<Exclude<ModelDebugCategory, 'ok'>, string>

/** Only fixed, credential-free messages created by this transport may cross review boundaries. */
export class ModelTransportError extends Error {
  constructor(
    message: string,
    readonly code: string = 'unknown',
  ) {
    super(message)
    this.name = 'ModelTransportError'
  }
}
export class TransportFailure extends ModelTransportError {
  constructor(
    readonly category: Exclude<ModelDebugCategory, 'ok'>,
    readonly schemaPaths?: string[],
  ) {
    super(transportMessages[category], category)
  }
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value.slice(0, 20) : []
}
/** Use documented sentinel values only. Never infer a provider's reason from arbitrary error text. */
export function checkEnvelopeOutcome(protocol: ModelProtocol, raw: unknown): void {
  const value = object(raw)
  if (protocol === 'anthropic') {
    if (value.stop_reason === 'max_tokens') throw new TransportFailure('truncated')
    if (
      value.stop_reason === 'refusal' ||
      array(value.content).some((item) => object(item).type === 'refusal')
    )
      throw new TransportFailure('refusal')
  } else if (protocol === 'gemini') {
    const blockReason = object(value.promptFeedback).blockReason
    if (
      typeof blockReason === 'string' &&
      blockReason &&
      blockReason !== 'BLOCK_REASON_UNSPECIFIED'
    )
      throw new TransportFailure('refusal')
    for (const candidate of array(value.candidates)) {
      const reason = object(candidate).finishReason
      if (reason === 'MAX_TOKENS') throw new TransportFailure('truncated')
      if (
        typeof reason === 'string' &&
        [
          'SAFETY',
          'RECITATION',
          'BLOCKLIST',
          'PROHIBITED_CONTENT',
          'SPII',
          'IMAGE_SAFETY',
        ].includes(reason)
      )
        throw new TransportFailure('refusal')
    }
  } else if (protocol === 'openai-responses') {
    const reason = object(value.incomplete_details).reason
    if (value.status === 'incomplete' && reason === 'max_output_tokens')
      throw new TransportFailure('truncated')
    if (value.status === 'incomplete' && reason === 'content_filter')
      throw new TransportFailure('refusal')
    if (
      array(value.output).some((item) =>
        array(object(item).content).some((part) => object(part).type === 'refusal'),
      )
    )
      throw new TransportFailure('refusal')
  } else {
    for (const choice of array(value.choices)) {
      const result = object(choice)
      const refusal = object(result.message).refusal
      if (result.finish_reason === 'length') throw new TransportFailure('truncated')
      if (
        result.finish_reason === 'content_filter' ||
        (typeof refusal === 'string' && refusal.length > 0)
      )
        throw new TransportFailure('refusal')
    }
  }
}
/** JSON.stringify alone misses secrets escaped inside string values and object keys. */
export function containsSecret(value: unknown, secret: string): boolean {
  if (!secret) return false
  const pending = [value]
  while (pending.length) {
    const current = pending.pop()
    if (typeof current === 'string' && containsCredentialText(current, secret)) return true
    if (current && typeof current === 'object') {
      for (const [key, child] of Object.entries(current)) {
        if (containsCredentialText(key, secret)) return true
        pending.push(child)
      }
    }
  }
  return false
}

/** Shared byte-limited, fatal-UTF8 reader for JSON and native-tool transports. */
export async function readBoundedModelResponse(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (!response.body) throw new TransportFailure('envelope')
  if (Number(response.headers.get('content-length')) > 262144) {
    void response.body.cancel().catch(() => {})
    throw new TransportFailure('response_too_large')
  }
  const reader = response.body.getReader()
  let size = 0
  const chunks: Uint8Array[] = []
  const abortReader = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener('abort', abortReader, { once: true })
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 262144) throw new TransportFailure('response_too_large')
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof TransportFailure) throw error
    throw new TransportFailure('network')
  } finally {
    signal.removeEventListener('abort', abortReader)
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  let envelope: unknown
  try {
    envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new TransportFailure('parse')
  }
  return envelope
}

export class ModelTransport {
  constructor(
    private config: { protocol: ModelProtocol; baseUrl: string; model: string },
    private key: string,
    private fetchImpl: typeof fetch = secureFetch,
    private timeoutMs = 60000,
    private debug?: ModelDebugRecorder,
  ) {
    this.config = {
      protocol: protocolSchema.parse(config.protocol),
      baseUrl: validateBaseUrl(config.baseUrl),
      model: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/)
        .parse(config.model),
    }
    this.timeoutMs = Number.isFinite(timeoutMs) ? Math.min(60000, Math.max(1, timeoutMs)) : 60000
  }
  private record(event: Omit<ModelDebugEvent, 'protocol' | 'model'>): void {
    if (!this.debug) return
    // Sanitize before the callback as well as at the store boundary. Neither receives raw data.
    const safe = sanitizeModelDebugEvent({
      ...event,
      protocol: this.config.protocol,
      model: safeModelDebugModel(this.config.model, this.key),
    })
    if (safe) {
      try {
        this.debug(safe)
      } catch {
        /* Diagnostics must never affect a paid request. */
      }
    }
  }
  createDebugContext(): ModelDebugContext {
    return { requestId: randomUUID() }
  }
  reportSchemaFailure(
    paths: readonly (readonly PropertyKey[])[],
    elapsedMs = 0,
    context = this.createDebugContext(),
  ): void {
    this.record({
      requestId: context.requestId,
      stage: 'schema',
      category: 'schema',
      elapsedMs,
      schemaPaths: safeModelDebugPaths(paths),
    })
  }
  async json(
    system: string,
    data: unknown,
    signal?: AbortSignal,
    context = this.createDebugContext(),
  ): Promise<unknown> {
    const started = Date.now()
    let stage: ModelDebugStage = 'request'
    let httpStatus: number | undefined
    if (!this.key) {
      this.record({ requestId: context.requestId, stage, category: 'auth', elapsedMs: 0 })
      throw new ModelTransportError('请先在模型设置中填写 API Key。', 'auth')
    }
    const { protocol, baseUrl, model } = this.config
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Accept-Encoding': 'identity',
    }
    const user = JSON.stringify(data)
    let path: string, body: unknown
    if (protocol === 'anthropic') {
      path = '/messages'
      headers['x-api-key'] = this.key
      headers['anthropic-version'] = '2023-06-01'
      body = { model, max_tokens: 8192, system, messages: [{ role: 'user', content: user }] }
    } else if (protocol === 'gemini') {
      path = `/models/${encodeURIComponent(model)}:generateContent`
      headers['x-goog-api-key'] = this.key
      body = {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 8192 },
      }
    } else if (protocol === 'openai-responses') {
      path = '/responses'
      headers.Authorization = `Bearer ${this.key}`
      body = {
        model,
        store: false,
        instructions: system,
        input: user,
        max_output_tokens: 8192,
        text: { format: { type: 'json_object' } },
      }
    } else {
      path = '/chat/completions'
      headers.Authorization = `Bearer ${this.key}`
      body = {
        model,
        stream: false,
        max_tokens: 8192,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }
    }
    const controller = new AbortController()
    let timeout: ReturnType<typeof setTimeout> | undefined
    let interruption: TransportFailure | undefined
    let cancel: () => void = () => {}
    const interrupted = new Promise<never>((_, reject) => {
      const stop = (category: 'cancelled' | 'timeout') => {
        interruption ??= new TransportFailure(category)
        controller.abort()
        reject(interruption)
      }
      cancel = () => stop('cancelled')
      signal?.addEventListener('abort', cancel, { once: true })
      timeout = setTimeout(() => stop('timeout'), this.timeoutMs)
      if (signal?.aborted) cancel()
    })
    try {
      const result = await Promise.race([
        interrupted,
        (async () => {
          if (controller.signal.aborted) throw interruption
          let response: Response
          try {
            response = await this.fetchImpl(baseUrl + path, {
              method: 'POST',
              headers,
              body: JSON.stringify(body),
              redirect: 'error',
              signal: controller.signal,
            })
          } catch {
            throw new TransportFailure('network')
          }
          if (controller.signal.aborted) {
            void response.body?.cancel().catch(() => {})
            throw interruption
          }
          stage = 'http'
          httpStatus = response.status
          if (!response.ok || response.redirected) {
            void response.body?.cancel().catch(() => {})
            throw new TransportFailure(
              [401, 403].includes(response.status)
                ? 'auth'
                : response.status === 429
                  ? 'rate_limit'
                  : response.redirected || (response.status >= 300 && response.status < 400)
                    ? 'network'
                    : 'http',
            )
          }
          stage = 'response'
          const envelope = await readBoundedModelResponse(response, controller.signal)
          if (controller.signal.aborted) throw interruption
          stage = 'envelope'
          // Also inspect ignored envelope fields: a malicious endpoint may reflect a credential there.
          if (containsSecret(envelope, this.key))
            throw new TransportFailure('credential_reflection')
          checkEnvelopeOutcome(protocol, envelope)
          let raw: string
          try {
            raw = extract(protocol, envelope)
          } catch (error) {
            throw new TransportFailure(
              'envelope',
              error instanceof z.ZodError
                ? safeModelDebugPaths(error.issues.map((issue) => issue.path))
                : undefined,
            )
          }
          stage = 'json'
          let parsed: unknown
          try {
            parsed = JSON.parse(raw)
          } catch {
            throw new TransportFailure('parse')
          }
          if (containsSecret(parsed, this.key)) throw new TransportFailure('credential_reflection')
          if (controller.signal.aborted) throw interruption
          return parsed
        })(),
      ])
      this.record({
        requestId: context.requestId,
        stage,
        category: 'ok',
        elapsedMs: Date.now() - started,
        httpStatus,
      })
      return result
    } catch (error) {
      const failure =
        interruption ??
        (error instanceof TransportFailure ? error : new TransportFailure('network'))
      this.record({
        requestId: context.requestId,
        stage,
        category: failure.category,
        elapsedMs: Date.now() - started,
        httpStatus,
        schemaPaths: failure.schemaPaths,
      })
      throw failure
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', cancel)
      controller.abort()
    }
  }
}
