import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type {
  NativeToolTurn,
  ToolCall,
  ToolContinuation,
  ToolDefinition,
  ToolResult,
} from '../shared/agent-tools'
import type { ModelProtocol } from '../shared/types'
import {
  safeModelDebugModel,
  sanitizeModelDebugEvent,
  type ModelDebugEvent,
  type ModelDebugRecorder,
  type ModelDebugStage,
} from '../shared/model-debug'
import {
  checkEnvelopeOutcome,
  containsSecret,
  protocolSchema,
  readBoundedModelResponse,
  secureFetch,
  TransportFailure,
  validateBaseUrl,
} from './model-transport'

export const TOOL_TRANSPORT_LIMITS = Object.freeze({
  callsPerTurn: 6,
  definitions: 18, // Sixteen existing tools plus two read-only bundled formula tools.
  argumentBytes: 32768,
  resultBytes: 65536,
  continuationBytes: 262144,
  finalTextBytes: 32768,
  turns: 8,
  totalCalls: 32,
})
const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\s\u0000-\u001f\u007f]+$/)
const name = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/)
const providerText = z.string().max(32768)
const signature = z.string().min(1).max(65536)
const parameters = z.record(z.string(), z.unknown())
const anthropicBlock = z.union([
  z.strictObject({
    type: z.literal('text'),
    text: providerText,
    citations: z.array(z.never()).optional().nullable(),
  }),
  z.strictObject({ type: z.literal('tool_use'), id, name, input: parameters }),
])
const geminiPart = z.union([
  z.strictObject({
    text: providerText,
    thought: z.literal(false).optional(),
    thoughtSignature: signature.optional(),
  }),
  z.strictObject({
    functionCall: z.strictObject({ id: id.optional(), name, args: parameters.optional() }),
    thought: z.literal(false).optional(),
    thoughtSignature: signature.optional(),
  }),
  z.strictObject({ thoughtSignature: signature }),
])
const responsesItem = z.union([
  z.strictObject({
    type: z.literal('message'),
    id: id.optional(),
    role: z.literal('assistant').optional(),
    status: z.literal('completed').optional(),
    phase: z.enum(['commentary', 'final_answer']).optional(),
    content: z
      .array(
        z.strictObject({
          type: z.literal('output_text'),
          text: providerText,
          annotations: z.array(z.never()).optional(),
          logprobs: z.array(z.never()).optional(),
        }),
      )
      .min(1)
      .max(20),
  }),
  z.strictObject({
    type: z.literal('function_call'),
    id: id.optional(),
    call_id: id,
    name,
    arguments: z.string().max(TOOL_TRANSPORT_LIMITS.argumentBytes),
    status: z.literal('completed').optional(),
  }),
  z.strictObject({
    type: z.literal('reasoning'),
    id,
    summary: z
      .array(z.strictObject({ type: z.literal('summary_text'), text: providerText }))
      .max(20),
    content: z
      .array(z.strictObject({ type: z.literal('reasoning_text'), text: providerText }))
      .max(20)
      .optional(),
    encrypted_content: signature.nullable().optional(),
    status: z.literal('completed').optional(),
  }),
])
const chatCall = z.strictObject({
  id,
  type: z.literal('function'),
  function: z.strictObject({
    name,
    arguments: z.string().max(TOOL_TRANSPORT_LIMITS.argumentBytes),
  }),
})

/** Reject non-JSON values, excessive structure and cycles before serialization or retention. */
function boundedJson(value: unknown, maxBytes: number): string {
  const pending: { value: unknown; depth: number; exit?: boolean }[] = [{ value, depth: 0 }]
  const ancestors = new Set<object>()
  let nodes = 0
  while (pending.length) {
    const current = pending.pop()!
    if (current.exit) {
      ancestors.delete(current.value as object)
      continue
    }
    if (++nodes > 20000 || current.depth > 32) throw new TransportFailure('response_too_large')
    if (
      current.value === null ||
      typeof current.value === 'boolean' ||
      typeof current.value === 'string'
    )
      continue
    if (typeof current.value === 'number' && Number.isFinite(current.value)) continue
    if (!current.value || typeof current.value !== 'object') throw new TransportFailure('envelope')
    if (ancestors.has(current.value)) throw new TransportFailure('envelope')
    ancestors.add(current.value)
    pending.push({ value: current.value, depth: current.depth, exit: true })
    if (
      !Array.isArray(current.value) &&
      ![Object.prototype, null].includes(Object.getPrototypeOf(current.value))
    )
      throw new TransportFailure('envelope')
    for (const [key, child] of Object.entries(current.value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key))
        throw new TransportFailure('envelope')
      pending.push({ value: child, depth: current.depth + 1 })
    }
  }
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw new TransportFailure('envelope')
  }
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes)
    throw new TransportFailure('response_too_large')
  return serialized
}

interface PendingCall extends ToolCall {
  /** Gemini may omit its wire ID; local IDs must not be invented on the wire. */
  readonly wireId?: string
}
interface Session {
  system: string
  tools: ToolDefinition[]
  history: unknown[]
  seenIds: Set<string>
  seenItemIds: Set<string>
  pending: PendingCall[]
  turns: number
  totalCalls: number
}
interface ParsedTurn {
  calls: PendingCall[]
  text: string
  append: unknown[]
  itemIds: string[]
}

/**
 * Native client-side tools only. Continuations are single-use main-process capabilities;
 * neither provider state nor reasoning/signatures are returned to UI, logs or disk.
 * Wire formats verified against official function-calling documentation:
 * https://developers.openai.com/api/docs/guides/function-calling
 * https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls
 * https://ai.google.dev/api/generate-content#FunctionCall
 */
export class ModelToolTransport {
  private continuations = new WeakMap<ToolContinuation, Session>()
  constructor(
    private config: { protocol: ModelProtocol; baseUrl: string; model: string },
    private key: string,
    private fetchImpl: typeof fetch = secureFetch,
    private timeoutMs = 60000,
    private debug?: ModelDebugRecorder,
  ) {
    try {
      this.config = {
        protocol: protocolSchema.parse(config.protocol),
        baseUrl: validateBaseUrl(config.baseUrl),
        model: z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/)
          .parse(config.model),
      }
    } catch {
      throw new TransportFailure('envelope')
    }
    this.timeoutMs = Number.isFinite(timeoutMs) ? Math.min(60000, Math.max(1, timeoutMs)) : 60000
  }
  private guard(value: unknown, maxBytes: number): string {
    const serialized = boundedJson(value, maxBytes)
    if (containsSecret(value, this.key)) throw new TransportFailure('credential_reflection')
    return serialized
  }
  private record(event: Omit<ModelDebugEvent, 'protocol' | 'model'>): void {
    if (!this.debug) return
    const safe = sanitizeModelDebugEvent({
      ...event,
      protocol: this.config.protocol,
      model: safeModelDebugModel(this.config.model, this.key),
    })
    if (safe) {
      try {
        this.debug(safe)
      } catch {
        /* Diagnostics cannot affect a request. */
      }
    }
  }
  async start(
    system: string,
    data: unknown,
    tools: readonly ToolDefinition[],
    signal?: AbortSignal,
  ): Promise<NativeToolTurn> {
    let definitions: ToolDefinition[]
    try {
      definitions = z
        .array(
          z.strictObject({
            name,
            description: z.string().min(1).max(4000),
            inputSchema: parameters,
          }),
        )
        .min(1)
        .max(TOOL_TRANSPORT_LIMITS.definitions)
        .parse(tools)
      if (
        new Set(definitions.map((tool) => tool.name)).size !== definitions.length ||
        definitions.some((tool) => tool.inputSchema.type !== 'object')
      )
        throw new Error()
      if (typeof system !== 'string' || !system.trim() || system.length > 32768) throw new Error()
    } catch {
      throw new TransportFailure('envelope')
    }
    definitions = JSON.parse(this.guard(definitions, 65536)) as ToolDefinition[]
    this.guard(system, 65536)
    const user = this.guard(data, 65536)
    const history: unknown[] =
      this.config.protocol === 'gemini'
        ? [{ role: 'user', parts: [{ text: user }] }]
        : [{ role: 'user', content: user }]
    return this.request(
      {
        system,
        tools: definitions,
        history,
        seenIds: new Set(),
        seenItemIds: new Set(),
        pending: [],
        turns: 0,
        totalCalls: 0,
      },
      signal,
    )
  }
  async continue(
    continuation: ToolContinuation,
    results: readonly ToolResult[],
    signal?: AbortSignal,
  ): Promise<NativeToolTurn> {
    const session = this.continuations.get(continuation)
    if (!session) throw new TransportFailure('envelope')
    // Consume before any await so concurrent callers cannot replay a paid request.
    this.continuations.delete(continuation)
    if (!Array.isArray(results) || results.length !== session.pending.length)
      throw new TransportFailure('envelope')
    const outputs = results.map((result, index) => {
      const call = session.pending[index]
      if (
        !result ||
        result.callId !== call.id ||
        (result.isError !== undefined && typeof result.isError !== 'boolean') ||
        Object.keys(result).some((key) => !['callId', 'output', 'isError'].includes(key))
      )
        throw new TransportFailure('envelope')
      const serialized = this.guard(result.output, TOOL_TRANSPORT_LIMITS.resultBytes)
      return {
        call,
        serialized,
        output: JSON.parse(serialized) as unknown,
        isError: result.isError === true,
      }
    })
    const protocol = this.config.protocol
    if (protocol === 'anthropic') {
      session.history.push({
        role: 'user',
        content: outputs.map(({ call, serialized, isError }) => ({
          type: 'tool_result',
          tool_use_id: call.id,
          content: serialized,
          ...(isError ? { is_error: true } : {}),
        })),
      })
    } else if (protocol === 'gemini') {
      session.history.push({
        role: 'user',
        parts: outputs.map(({ call, output, isError }) => ({
          functionResponse: {
            name: call.name,
            ...(call.wireId ? { id: call.wireId } : {}),
            response: isError ? { error: output } : { output },
          },
        })),
      })
    } else if (protocol === 'openai-responses') {
      session.history.push(
        ...outputs.map(({ call, serialized, isError }) => ({
          type: 'function_call_output',
          call_id: call.id,
          output: isError ? JSON.stringify({ error: JSON.parse(serialized) }) : serialized,
        })),
      )
    } else {
      session.history.push(
        ...outputs.map(({ call, serialized, isError }) => ({
          role: 'tool',
          tool_call_id: call.id,
          content: isError ? JSON.stringify({ error: JSON.parse(serialized) }) : serialized,
        })),
      )
    }
    session.pending = []
    return this.request(session, signal)
  }
  private parse(envelope: unknown, session: Session): ParsedTurn {
    const protocol = this.config.protocol
    const calls: PendingCall[] = []
    const texts: string[] = []
    const itemIds: string[] = []
    let append: unknown[] = []
    const addCall = (callId: string, toolName: string, args: unknown, wireId?: string) => {
      this.guard(args, TOOL_TRANSPORT_LIMITS.argumentBytes)
      const parsedArgs = parameters.parse(args)
      if (
        !session.tools.some((tool) => tool.name === toolName) ||
        session.seenIds.has(callId) ||
        calls.some((call) => call.id === callId)
      )
        throw new TransportFailure('envelope')
      calls.push({
        id: callId,
        name: toolName,
        arguments: parsedArgs,
        ...(wireId ? { wireId } : {}),
      })
    }
    const parseArguments = (raw: string): unknown => {
      if (Buffer.byteLength(raw, 'utf8') > TOOL_TRANSPORT_LIMITS.argumentBytes)
        throw new TransportFailure('response_too_large')
      try {
        return JSON.parse(raw)
      } catch {
        throw new TransportFailure('parse')
      }
    }
    if (protocol === 'anthropic') {
      const value = z
        .object({
          error: z.null().optional(),
          type: z.literal('message').optional(),
          role: z.literal('assistant').optional(),
          stop_reason: z.enum(['end_turn', 'tool_use']),
          content: z.array(anthropicBlock).min(1).max(26),
        })
        .parse(envelope)
      for (const block of value.content) {
        if (block.type === 'text') texts.push(block.text)
        else addCall(block.id, block.name, block.input)
      }
      if ((value.stop_reason === 'tool_use') !== calls.length > 0)
        throw new TransportFailure('envelope')
      append = [{ role: 'assistant', content: value.content }]
    } else if (protocol === 'gemini') {
      const value = z
        .object({
          error: z.null().optional(),
          promptFeedback: z
            .object({ blockReason: z.literal('BLOCK_REASON_UNSPECIFIED').optional() })
            .optional(),
          candidates: z
            .array(
              z.object({
                finishReason: z.literal('STOP'),
                content: z.strictObject({
                  role: z.literal('model').optional(),
                  parts: z.array(geminiPart).min(1).max(26),
                }),
              }),
            )
            .length(1),
        })
        .parse(envelope)
      const content = value.candidates[0].content
      for (const part of content.parts) {
        if ('text' in part) texts.push(part.text)
        if ('functionCall' in part) {
          const call = part.functionCall
          addCall(call.id ?? `local_${randomUUID()}`, call.name, call.args ?? {}, call.id)
        }
      }
      append = [{ role: 'model', parts: content.parts }]
    } else if (protocol === 'openai-responses') {
      const value = z
        .object({
          status: z.literal('completed'),
          error: z.null().optional(),
          incomplete_details: z.null().optional(),
          output: z.array(responsesItem).min(1).max(26),
        })
        .parse(envelope)
      for (const item of value.output) {
        if (item.id) itemIds.push(item.id)
        if (item.type === 'message') texts.push(...item.content.map((part) => part.text))
        if (item.type === 'function_call')
          addCall(item.call_id, item.name, parseArguments(item.arguments))
      }
      append = value.output
    } else {
      const value = z
        .object({
          error: z.null().optional(),
          choices: z
            .array(
              z.object({
                finish_reason: z.enum(['stop', 'tool_calls']),
                message: z.strictObject({
                  role: z.literal('assistant').optional(),
                  content: providerText.nullable().optional(),
                  refusal: z.null().optional(),
                  reasoning_content: providerText.optional(),
                  tool_calls: z.array(chatCall).max(TOOL_TRANSPORT_LIMITS.callsPerTurn).optional(),
                }),
              }),
            )
            .length(1),
        })
        .parse(envelope)
      const choice = value.choices[0]
      if (choice.message.content) texts.push(choice.message.content)
      for (const call of choice.message.tool_calls ?? [])
        addCall(call.id, call.function.name, parseArguments(call.function.arguments))
      if ((choice.finish_reason === 'tool_calls') !== calls.length > 0)
        throw new TransportFailure('envelope')
      append = [
        {
          role: 'assistant',
          content: choice.message.content ?? '',
          ...(choice.message.reasoning_content !== undefined
            ? { reasoning_content: choice.message.reasoning_content }
            : {}),
          ...(calls.length ? { tool_calls: choice.message.tool_calls } : {}),
        },
      ]
    }
    if (
      calls.length > TOOL_TRANSPORT_LIMITS.callsPerTurn ||
      new Set(itemIds).size !== itemIds.length ||
      itemIds.some((itemId) => session.seenItemIds.has(itemId))
    )
      throw new TransportFailure('envelope')
    const text = texts.join('\n').trim()
    if (!calls.length && !text) throw new TransportFailure('envelope')
    if (Buffer.byteLength(text, 'utf8') > TOOL_TRANSPORT_LIMITS.finalTextBytes)
      throw new TransportFailure('response_too_large')
    // Validate every carried block, including opaque reasoning/signatures, before retaining it.
    this.guard(append, TOOL_TRANSPORT_LIMITS.continuationBytes)
    return { calls, text, append, itemIds }
  }
  private async request(session: Session, signal?: AbortSignal): Promise<NativeToolTurn> {
    const started = Date.now(),
      requestId = randomUUID()
    let stage: ModelDebugStage = 'request'
    let httpStatus: number | undefined
    const controller = new AbortController()
    let timeout: ReturnType<typeof setTimeout> | undefined
    let interruption: TransportFailure | undefined
    let cancel = () => {}
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
      const turn = await Promise.race([
        interrupted,
        (async (): Promise<NativeToolTurn> => {
          if (controller.signal.aborted) throw interruption
          if (!this.key) throw new TransportFailure('auth')
          if (++session.turns > TOOL_TRANSPORT_LIMITS.turns) throw new TransportFailure('envelope')
          this.guard(session.history, TOOL_TRANSPORT_LIMITS.continuationBytes)
          const { protocol, baseUrl, model } = this.config
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'Accept-Encoding': 'identity',
          }
          let path: string, body: unknown
          if (protocol === 'anthropic') {
            path = '/messages'
            headers['x-api-key'] = this.key
            headers['anthropic-version'] = '2023-06-01'
            body = {
              model,
              max_tokens: 8192,
              system: session.system,
              messages: session.history,
              tools: session.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.inputSchema,
              })),
            }
          } else if (protocol === 'gemini') {
            path = `/models/${encodeURIComponent(model)}:generateContent`
            headers['x-goog-api-key'] = this.key
            body = {
              systemInstruction: { parts: [{ text: session.system }] },
              contents: session.history,
              generationConfig: { maxOutputTokens: 8192 },
              tools: [
                {
                  functionDeclarations: session.tools.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    parametersJsonSchema: tool.inputSchema,
                  })),
                },
              ],
            }
          } else if (protocol === 'openai-responses') {
            path = '/responses'
            headers.Authorization = `Bearer ${this.key}`
            body = {
              model,
              store: false,
              instructions: session.system,
              input: session.history,
              max_output_tokens: 8192,
              include: ['reasoning.encrypted_content'],
              tools: session.tools.map((tool) => ({
                type: 'function',
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
                strict: false,
              })),
            }
          } else {
            path = '/chat/completions'
            headers.Authorization = `Bearer ${this.key}`
            body = {
              model,
              stream: false,
              max_tokens: 8192,
              messages: [{ role: 'system', content: session.system }, ...session.history],
              tools: session.tools.map((tool) => ({
                type: 'function',
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.inputSchema,
                },
              })),
            }
          }
          const serialized = this.guard(body, TOOL_TRANSPORT_LIMITS.continuationBytes + 131072)
          let response: Response
          try {
            response = await this.fetchImpl(baseUrl + path, {
              method: 'POST',
              headers,
              body: serialized,
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
          // Validate before Zod can normalize record keys or discard unknown fields.
          this.guard(envelope, TOOL_TRANSPORT_LIMITS.continuationBytes)
          checkEnvelopeOutcome(protocol, envelope)
          let parsed: ParsedTurn
          try {
            parsed = this.parse(envelope, session)
          } catch (error) {
            throw error instanceof TransportFailure ? error : new TransportFailure('envelope')
          }
          if (controller.signal.aborted) throw interruption
          if (!parsed.calls.length) return { kind: 'final', text: parsed.text }
          if (session.totalCalls + parsed.calls.length > TOOL_TRANSPORT_LIMITS.totalCalls)
            throw new TransportFailure('envelope')
          session.history.push(...parsed.append)
          this.guard(session.history, TOOL_TRANSPORT_LIMITS.continuationBytes)
          for (const call of parsed.calls) session.seenIds.add(call.id)
          for (const itemId of parsed.itemIds) session.seenItemIds.add(itemId)
          session.totalCalls += parsed.calls.length
          session.pending = parsed.calls
          const continuation = Object.freeze({}) as ToolContinuation
          this.continuations.set(continuation, session)
          // Copies prevent executor mutation of the retained wire history or pending IDs.
          const calls = parsed.calls.map((call) => ({
            id: call.id,
            name: call.name,
            arguments: JSON.parse(JSON.stringify(call.arguments)) as Record<string, unknown>,
          }))
          return { kind: 'tool_calls', calls, continuation }
        })(),
      ])
      this.record({ requestId, stage, category: 'ok', elapsedMs: Date.now() - started, httpStatus })
      return turn
    } catch (error) {
      const failure =
        interruption ??
        (error instanceof TransportFailure ? error : new TransportFailure('network'))
      this.record({
        requestId,
        stage,
        category: failure.category,
        elapsedMs: Date.now() - started,
        httpStatus,
      })
      throw failure
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', cancel)
      controller.abort()
    }
  }
}
