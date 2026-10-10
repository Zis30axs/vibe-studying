import { z } from 'zod'
import { lookup } from 'node:dns'
import { isIP } from 'node:net'
import { request } from 'node:https'
import { Readable } from 'node:stream'
import type { ModelProtocol } from '../shared/types'

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
const secureFetch: typeof fetch = async (input, init) =>
  new Promise((resolve, reject) => {
    const req = request(
      String(input),
      {
        method: 'POST',
        headers: init?.headers as Record<string, string>,
        signal: init?.signal ?? undefined,
        lookup: (hostname, options, callback) =>
          lookup(hostname, { all: true }, (error, addresses) => {
            if (error || !addresses.length || addresses.some((a) => !isPublicAddress(a.address))) {
              callback(new Error('Endpoint unavailable'), [], undefined)
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
          resolve(
            new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, {
              status: response.statusCode ?? 500,
              headers,
            }),
          )
        } catch {
          response.destroy()
          reject(new Error('Invalid HTTP response'))
        }
      },
    )
    req.on('error', reject)
    req.end(init?.body as string)
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
/** Only fixed, credential-free messages created by this transport may cross review boundaries. */
export class ModelTransportError extends Error {}
export class ModelTransport {
  constructor(
    private config: { protocol: ModelProtocol; baseUrl: string; model: string },
    private key: string,
    private fetchImpl: typeof fetch = secureFetch,
    private timeoutMs = 60000,
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
  async json(system: string, data: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!this.key) throw new ModelTransportError('请先在模型设置中填写 API Key。')
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
    let failed = '模型返回格式无效，或响应被拒绝。请稍后重试。'
    let cancel: () => void = () => {}
    const aborted = new Promise<never>((_, reject) => {
      cancel = () => {
        controller.abort()
        reject(new Error())
      }
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) cancel()
    })
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        failed = '模型请求超时，请重试。'
        controller.abort()
        reject(new Error())
      }, this.timeoutMs)
    })
    try {
      return await Promise.race([
        aborted,
        deadline,
        (async () => {
          const response = await this.fetchImpl(baseUrl + path, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            redirect: 'error',
            signal: controller.signal,
          })
          if (!response.ok || response.redirected || !response.body) {
            failed =
              response.status === 401
                ? '模型身份验证失败，请检查 API Key。'
                : response.status === 429
                  ? '模型请求过于频繁，请稍后重试。'
                  : '模型服务暂时不可用。'
            void response.body?.cancel()
            throw new Error()
          }
          if (Number(response.headers.get('content-length')) > 262144) {
            void response.body.cancel()
            throw new Error()
          }
          const reader = response.body.getReader()
          let size = 0
          const chunks: Uint8Array[] = []
          const abortReader = () => {
            void reader.cancel().catch(() => {})
          }
          controller.signal.addEventListener('abort', abortReader, { once: true })
          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              size += value.byteLength
              if (size > 262144) throw new Error()
              chunks.push(value)
            }
          } finally {
            controller.signal.removeEventListener('abort', abortReader)
            void reader.cancel().catch(() => {})
            reader.releaseLock()
          }
          if (controller.signal.aborted) throw new Error()
          const bytes = new Uint8Array(size)
          let offset = 0
          for (const chunk of chunks) {
            bytes.set(chunk, offset)
            offset += chunk.length
          }
          const raw = extract(
            protocol,
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
          )
          const parsed: unknown = JSON.parse(raw)
          if (JSON.stringify(parsed).includes(this.key)) throw new Error()
          if (controller.signal.aborted) throw new Error()
          return parsed
        })(),
      ])
    } catch {
      throw new ModelTransportError(signal?.aborted ? '请求已取消。' : failed)
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', cancel)
      controller.abort()
    }
  }
}
