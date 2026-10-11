import { z } from 'zod'
import type { ModelProtocol } from '../shared/types'
import {
  ModelTransportError,
  protocolSchema,
  secureFetch,
  validateBaseUrl,
} from './model-transport'

export interface RemoteModel {
  id: string
  name?: string
}
export interface ModelDiagnosticConfig {
  protocol: ModelProtocol
  baseUrl: string
  model: string
}
export interface ModelDiagnosticOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  signal?: AbortSignal
}
const messages = {
  auth: '身份验证失败，请检查 API Key 和服务访问权限。',
  not_found: '服务接口或模型不存在，请检查 Base URL、协议和 Model ID。',
  model: '服务不接受当前模型或请求参数，请检查 Model ID 和所选协议。',
  rate_limit: '请求受限或额度不足，请稍后重试或检查服务额度。',
  timeout: '模型请求超时，请稍后重试。',
  network: '无法连接模型服务，请检查网络和 Base URL。',
  invalid_response: '服务返回格式无效或未生成有效响应，请检查所选协议。',
  cancelled: '请求已取消。',
  invalid_config: '模型配置无效，请检查公开 HTTPS Base URL、协议和 Model ID。',
  incomplete_list: '模型列表过大或分页未完成，未使用不完整结果。请手动填写 Model ID。',
} as const
export type ModelDiagnosticErrorCode = keyof typeof messages
/** Only these fixed messages, never provider errors, are safe to display to the renderer. */
export class ModelDiagnosticError extends ModelTransportError {
  constructor(readonly code: ModelDiagnosticErrorCode) {
    super(messages[code])
    this.name = 'ModelDiagnosticError'
  }
}

const modelId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/)
const modelName = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[^\u0000-\u001f\u007f]*$/)
const MAX_BYTES = 262144
const MAX_MODELS = 500
const MAX_PAGES = 5
const PROBE = 'Reply with OK.'
const PROBE_TOKENS = 32

function validatedConfig(config: ModelDiagnosticConfig, requireModel: boolean) {
  try {
    return {
      protocol: protocolSchema.parse(config.protocol),
      baseUrl: validateBaseUrl(config.baseUrl),
      // Fetching models must work before the user has chosen a model.
      model: requireModel ? modelId.parse(config.model) : '',
    }
  } catch {
    throw new ModelDiagnosticError('invalid_config')
  }
}
function headersFor(protocol: ModelProtocol, key: string): Record<string, string> {
  if (!key || key.length > 4096 || /[\r\n\u0000]/.test(key)) throw new ModelDiagnosticError('auth')
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Accept-Encoding': 'identity',
  }
  if (protocol === 'anthropic') {
    headers['x-api-key'] = key
    headers['anthropic-version'] = '2023-06-01'
  } else if (protocol === 'gemini') headers['x-goog-api-key'] = key
  else headers.Authorization = `Bearer ${key}`
  return headers
}

function containsSecret(value: unknown, key: string): boolean {
  const pending: unknown[] = [value]
  while (pending.length) {
    const item = pending.pop()
    if (typeof item === 'string' && item.includes(key)) return true
    if (item && typeof item === 'object') {
      // Inspect decoded values, including keys that JSON.stringify would escape.
      for (const [name, child] of Object.entries(item)) {
        if (name.includes(key)) return true
        pending.push(child)
      }
    }
  }
  return false
}

async function boundedJson(response: Response, signal: AbortSignal, key: string): Promise<unknown> {
  if (!response.body) throw new ModelDiagnosticError('invalid_response')
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    void response.body.cancel().catch(() => {})
    throw new ModelDiagnosticError('invalid_response')
  }
  const reader = response.body.getReader()
  const abortReader = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener('abort', abortReader, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    if (signal.aborted) throw new ModelDiagnosticError('cancelled')
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BYTES) throw new ModelDiagnosticError('invalid_response')
      chunks.push(value)
    }
    if (signal.aborted) throw new ModelDiagnosticError('cancelled')
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    // A hostile compatible endpoint must not reflect credentials into model names or results.
    if (containsSecret(value, key)) throw new ModelDiagnosticError('invalid_response')
    return value
  } finally {
    signal.removeEventListener('abort', abortReader)
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

async function requestJson(
  url: string,
  init: RequestInit,
  key: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<unknown> {
  if (signal.aborted) throw new ModelDiagnosticError('cancelled')
  let response: Response
  try {
    response = await fetchImpl(url, { ...init, redirect: 'error', signal })
  } catch {
    throw new ModelDiagnosticError('network')
  }
  if (signal.aborted || response.redirected || !response.ok) {
    void response.body?.cancel().catch(() => {})
    if (signal.aborted) throw new ModelDiagnosticError('cancelled')
    if (response.redirected || (response.status >= 300 && response.status < 400))
      throw new ModelDiagnosticError('network')
    const code = [401, 403].includes(response.status)
      ? 'auth'
      : response.status === 404
        ? 'not_found'
        : response.status === 429
          ? 'rate_limit'
          : [400, 422].includes(response.status)
            ? 'model'
            : 'network'
    throw new ModelDiagnosticError(code)
  }
  return boundedJson(response, signal, key)
}

/** A single deadline covers every page as well as stalled fetches and response bodies. */
async function withDeadline<T>(
  options: ModelDiagnosticOptions,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.min(60000, Math.max(1, options.timeoutMs!))
    : 30000
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancel = () => {}
  let failure: ModelDiagnosticError | undefined
  const interrupted = new Promise<never>((_, reject) => {
    const stop = (code: 'cancelled' | 'timeout') => {
      failure ??= new ModelDiagnosticError(code)
      controller.abort()
      reject(failure)
    }
    cancel = () => stop('cancelled')
    options.signal?.addEventListener('abort', cancel, { once: true })
    timer = setTimeout(() => stop('timeout'), timeoutMs)
    if (options.signal?.aborted) cancel()
  })
  try {
    return await Promise.race([interrupted, run(controller.signal)])
  } catch (error) {
    if (failure) throw failure
    if (error instanceof ModelDiagnosticError) throw error
    throw new ModelDiagnosticError('invalid_response')
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', cancel)
    controller.abort()
  }
}

// Endpoint contracts: platform.claude.com/docs/en/api/models/list,
// ai.google.dev/api/models, developers.openai.com/api/reference/resources/models/methods/list.
export async function listRemoteModels(
  config: ModelDiagnosticConfig,
  key: string,
  options: ModelDiagnosticOptions = {},
): Promise<RemoteModel[]> {
  const { protocol, baseUrl } = validatedConfig(config, false)
  const headers = headersFor(protocol, key)
  return withDeadline(options, async (signal) => {
    const models = new Map<string, RemoteModel>()
    const cursors = new Set<string>()
    let cursor = ''
    let count = 0
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(baseUrl + '/models')
      if (protocol === 'gemini') {
        url.searchParams.set('pageSize', '100')
        if (cursor) url.searchParams.set('pageToken', cursor)
      } else if (protocol === 'anthropic') {
        url.searchParams.set('limit', '100')
        if (cursor) url.searchParams.set('after_id', cursor)
      }
      const raw = await requestJson(
        url.href,
        { method: 'GET', headers },
        key,
        options.fetchImpl ?? secureFetch,
        signal,
      )
      let entries: RemoteModel[]
      let next: string | undefined
      if (protocol === 'gemini') {
        const result = z
          .object({
            models: z.array(
              z.object({
                name: z
                  .string()
                  .regex(/^models\//)
                  .max(127),
                displayName: modelName.optional(),
                supportedGenerationMethods: z.array(z.string().max(100)).max(30),
              }),
            ),
            nextPageToken: z.string().max(2048).optional(),
          })
          .parse(raw)
        count += result.models.length
        entries = result.models
          .filter((model) => model.supportedGenerationMethods.includes('generateContent'))
          .map((model) => ({
            id: modelId.parse(model.name.slice(7)),
            ...(model.displayName ? { name: model.displayName } : {}),
          }))
        next = result.nextPageToken
      } else {
        const result = z
          .object({
            data: z.array(z.object({ id: modelId, display_name: modelName.optional() })),
            has_more: z.boolean().optional(),
            last_id: z.string().min(1).max(2048).nullable().optional(),
          })
          .parse(raw)
        count += result.data.length
        entries = result.data.map((model) => ({
          id: model.id,
          ...(model.display_name ? { name: model.display_name } : {}),
        }))
        if (result.has_more) {
          // OpenAI's models endpoint does not define pagination; do not guess a proxy's contract.
          if (protocol !== 'anthropic') throw new ModelDiagnosticError('incomplete_list')
          if (!result.last_id) throw new ModelDiagnosticError('invalid_response')
          next = result.last_id
        }
      }
      if (count > MAX_MODELS) throw new ModelDiagnosticError('incomplete_list')
      for (const model of entries) if (!models.has(model.id)) models.set(model.id, model)
      if (!next) return [...models.values()]
      if (cursors.has(next) || page === MAX_PAGES - 1 || count === MAX_MODELS)
        throw new ModelDiagnosticError('incomplete_list')
      cursors.add(next)
      cursor = next
    }
    throw new ModelDiagnosticError('incomplete_list')
  })
}

const outputText = z.string().max(MAX_BYTES)
const tokenCount = z.number().int().nonnegative()
/** A tiny probe may exhaust its token budget, but refusals, empty and tool-only replies fail. */
function validateProbe(protocol: ModelProtocol, raw: unknown): void {
  let generated = false
  if (protocol === 'anthropic') {
    const value = z
      .object({
        type: z.literal('message').optional(),
        role: z.literal('assistant').optional(),
        stop_reason: z.enum(['end_turn', 'max_tokens']),
        content: z.array(z.object({ type: z.literal('text'), text: outputText })).max(20),
      })
      .parse(raw)
    generated = value.content.some((part) => part.text.trim())
  } else if (protocol === 'gemini') {
    const value = z
      .object({
        promptFeedback: z.object({ blockReason: z.never().optional() }).optional(),
        candidates: z
          .array(
            z.object({
              finishReason: z.enum(['STOP', 'MAX_TOKENS']),
              content: z
                .object({
                  role: z.literal('model').optional(),
                  parts: z
                    .array(z.object({ text: outputText }))
                    .max(20)
                    .optional(),
                })
                .optional(),
            }),
          )
          .length(1),
        usageMetadata: z.object({ thoughtsTokenCount: tokenCount.optional() }).optional(),
      })
      .parse(raw)
    const candidate = value.candidates[0]
    generated =
      Boolean(candidate.content?.parts?.some((part) => part.text.trim())) ||
      (candidate.finishReason === 'MAX_TOKENS' &&
        (value.usageMetadata?.thoughtsTokenCount ?? 0) > 0)
  } else if (protocol === 'openai-responses') {
    const value = z
      .object({
        object: z.literal('response').optional(),
        status: z.enum(['completed', 'incomplete']),
        error: z.null().optional(),
        incomplete_details: z
          .object({ reason: z.literal('max_output_tokens') })
          .nullable()
          .optional(),
        output: z
          .array(
            z.union([
              z.object({
                type: z.literal('message'),
                role: z.literal('assistant').optional(),
                status: z.enum(['completed', 'incomplete']).optional(),
                content: z
                  .array(z.object({ type: z.literal('output_text'), text: outputText }))
                  .max(20),
              }),
              z.object({ type: z.literal('reasoning'), id: z.string().min(1).max(200) }),
            ]),
          )
          .max(20),
        usage: z.object({ output_tokens: tokenCount }).optional(),
      })
      .parse(raw)
    if (value.status === 'incomplete' && value.incomplete_details?.reason !== 'max_output_tokens')
      throw new ModelDiagnosticError('invalid_response')
    generated =
      value.output.some(
        (item) => item.type === 'message' && item.content.some((part) => part.text.trim()),
      ) ||
      (value.status === 'incomplete' && (value.usage?.output_tokens ?? 0) > 0)
  } else {
    const value = z
      .object({
        object: z.literal('chat.completion').optional(),
        choices: z
          .array(
            z.object({
              finish_reason: z.enum(['stop', 'length']),
              message: z.object({
                role: z.literal('assistant').optional(),
                content: outputText.nullable(),
                refusal: z.null().optional(),
                tool_calls: z.array(z.unknown()).max(0).optional(),
                function_call: z.never().optional(),
              }),
            }),
          )
          .length(1),
        usage: z.object({ completion_tokens: tokenCount }).optional(),
      })
      .parse(raw)
    const choice = value.choices[0]
    generated =
      Boolean(choice.message.content?.trim()) ||
      (choice.finish_reason === 'length' && (value.usage?.completion_tokens ?? 0) > 0)
  }
  if (!generated) throw new ModelDiagnosticError('invalid_response')
}

export async function testModelConnection(
  config: ModelDiagnosticConfig,
  key: string,
  options: ModelDiagnosticOptions = {},
): Promise<{ latencyMs: number }> {
  const { protocol, baseUrl, model } = validatedConfig(config, true)
  const headers = { ...headersFor(protocol, key), 'Content-Type': 'application/json' }
  let path: string
  let body: unknown
  if (protocol === 'anthropic') {
    path = '/messages'
    body = {
      model,
      max_tokens: PROBE_TOKENS,
      stream: false,
      messages: [{ role: 'user', content: PROBE }],
    }
  } else if (protocol === 'gemini') {
    path = `/models/${encodeURIComponent(model)}:generateContent`
    body = {
      contents: [{ role: 'user', parts: [{ text: PROBE }] }],
      generationConfig: { maxOutputTokens: PROBE_TOKENS },
    }
  } else if (protocol === 'openai-responses') {
    path = '/responses'
    body = { model, input: PROBE, max_output_tokens: PROBE_TOKENS, store: false, stream: false }
  } else {
    path = '/chat/completions'
    // Match the app's Chat transport, including compatible providers such as DeepSeek:
    // https://api-docs.deepseek.com/api/create-chat-completion/
    // A different token field can falsely pass a model that actual app calls cannot use.
    // Send one bounded probe; do not retry with alternate parameters.
    body = {
      model,
      messages: [{ role: 'user', content: PROBE }],
      max_tokens: PROBE_TOKENS,
      stream: false,
    }
  }
  return withDeadline(options, async (signal) => {
    const start = performance.now()
    const value = await requestJson(
      baseUrl + path,
      { method: 'POST', headers, body: JSON.stringify(body) },
      key,
      options.fetchImpl ?? secureFetch,
      signal,
    )
    validateProbe(protocol, value)
    return { latencyMs: Math.max(0, Math.round(performance.now() - start)) }
  })
}
