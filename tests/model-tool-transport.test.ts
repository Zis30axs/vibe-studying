import { describe, expect, it, vi } from 'vitest'
import { ModelToolTransport, TOOL_TRANSPORT_LIMITS } from '../src/adapters/model-tool-transport'
import { ModelTransportError } from '../src/adapters/model-transport'
import type { NativeToolTurn, ToolContinuation, ToolDefinition } from '../src/shared/agent-tools'
import type { ModelProtocol } from '../src/shared/types'
import type { ModelDebugEvent } from '../src/shared/model-debug'

const key = 'sk-native-synthetic-key-never-real'
const marker = 'PRIVATE-TOOL-INPUT-RESULT-OR-REASONING'
const protocols: ModelProtocol[] = ['anthropic', 'gemini', 'openai-responses', 'openai-chat']
const definitions: ToolDefinition[] = [
  {
    name: 'get_selected_question',
    description: 'Read selected question only.',
    inputSchema: {
      type: 'object',
      properties: { part: { type: 'string' } },
      required: ['part'],
      additionalProperties: false,
    },
  },
]
const config = (protocol: ModelProtocol) => ({
  protocol,
  model: 'synthetic-model',
  baseUrl: 'https://api.vendor.com/v1',
})
const response = (body: unknown) => new Response(JSON.stringify(body))
interface FixtureCall {
  id: string
  name?: string
  args?: unknown
  raw?: string
}
// Deliberately mutable provider fixtures so hostile and malformed envelopes can be tested.
function toolEnvelope(
  protocol: ModelProtocol,
  calls: FixtureCall[] = [{ id: 'call_1', args: { part: 'prompt' } }],
): any {
  if (protocol === 'anthropic')
    return {
      type: 'message',
      role: 'assistant',
      stop_reason: 'tool_use',
      content: calls.map((call) => ({
        type: 'tool_use',
        id: call.id,
        name: call.name ?? definitions[0].name,
        input: call.args ?? { part: 'prompt' },
      })),
    }
  if (protocol === 'gemini')
    return {
      candidates: [
        {
          finishReason: 'STOP',
          content: {
            role: 'model',
            parts: calls.map((call) => ({
              functionCall: {
                id: call.id,
                name: call.name ?? definitions[0].name,
                args: call.args ?? { part: 'prompt' },
              },
            })),
          },
        },
      ],
    }
  if (protocol === 'openai-responses')
    return {
      status: 'completed',
      output: calls.map((call, index) => ({
        type: 'function_call',
        id: `fc_${index}_${call.id}`,
        status: 'completed',
        call_id: call.id,
        name: call.name ?? definitions[0].name,
        arguments: call.raw ?? JSON.stringify(call.args ?? { part: 'prompt' }),
      })),
    }
  return {
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: calls.map((call) => ({
            id: call.id,
            type: 'function',
            function: {
              name: call.name ?? definitions[0].name,
              arguments: call.raw ?? JSON.stringify(call.args ?? { part: 'prompt' }),
            },
          })),
        },
      },
    ],
  }
}
function finalEnvelope(
  protocol: ModelProtocol,
  text = 'The selected question asks about rainfall.',
): any {
  if (protocol === 'anthropic')
    return { stop_reason: 'end_turn', content: [{ type: 'text', text }] }
  if (protocol === 'gemini')
    return { candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] }
  if (protocol === 'openai-responses')
    return {
      status: 'completed',
      output: [
        {
          type: 'message',
          status: 'completed',
          role: 'assistant',
          id: 'msg_final',
          content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
        },
      ],
    }
  return {
    choices: [
      { finish_reason: 'stop', message: { role: 'assistant', content: text, refusal: null } },
    ],
  }
}
function requireCalls(turn: NativeToolTurn) {
  expect(turn.kind).toBe('tool_calls')
  if (turn.kind !== 'tool_calls') throw new Error('Expected synthetic tool calls')
  return turn
}
const bodyOf = (fetcher: ReturnType<typeof vi.fn<typeof fetch>>, index: number) =>
  JSON.parse(String(fetcher.mock.calls[index][1]?.body))

function addUnsupported(protocol: ModelProtocol, envelope: any) {
  if (protocol === 'anthropic')
    envelope.content.push({
      type: 'server_tool_use',
      id: 'remote_1',
      name: 'web_search',
      input: {},
    })
  else if (protocol === 'gemini')
    envelope.candidates[0].content.parts.push({
      executableCode: { language: 'PYTHON', code: marker },
    })
  else if (protocol === 'openai-responses')
    envelope.output.push({ type: 'web_search_call', id: 'remote_1', status: 'completed' })
  else envelope.choices[0].message.function_call = { name: 'legacy_function', arguments: '{}' }
}

describe.each(protocols)('%s native tools (synthetic fetch only)', (protocol) => {
  it('accepts twenty bounded definitions including geometry tools and rejects a twenty-first before sending', async () => {
    const tools = Array.from({ length: 20 }, (_, index) => ({
      ...definitions[0],
      name:
        index === 16
          ? 'search_formulas'
          : index === 17
            ? 'get_formula'
            : index === 18
              ? 'geometry_calculate'
              : index === 19
                ? 'generate_geometry_question'
                : `read_fixture_${index}`,
    }))
    expect(TOOL_TRANSPORT_LIMITS.definitions).toBe(20)
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(finalEnvelope(protocol)))
    await expect(
      new ModelToolTransport(config(protocol), key, fetcher).start('System', {}, tools),
    ).resolves.toMatchObject({ kind: 'final' })
    expect(fetcher).toHaveBeenCalledTimes(1)
    const denied = vi.fn<typeof fetch>()
    await expect(
      new ModelToolTransport(config(protocol), key, denied).start('System', {}, [
        ...tools,
        { ...definitions[0], name: 'twenty_first' },
      ]),
    ).rejects.toBeInstanceOf(ModelTransportError)
    expect(denied).not.toHaveBeenCalled()
  })
  it('performs actual calls, sends ordered results, and returns final model text', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response(
          toolEnvelope(protocol, [{ id: 'call_1' }, { id: 'call_2', args: { part: 'rubric' } }]),
        ),
      )
      .mockResolvedValueOnce(response(finalEnvelope(protocol)))
    const transport = new ModelToolTransport(config(protocol), key, fetcher)
    const turn = requireCalls(
      await transport.start(
        'Use only supplied local tools.',
        { questionId: 'selected' },
        definitions,
      ),
    )
    expect(turn.calls).toEqual([
      { id: 'call_1', name: definitions[0].name, arguments: { part: 'prompt' } },
      { id: 'call_2', name: definitions[0].name, arguments: { part: 'rubric' } },
    ])
    expect(JSON.stringify(turn.continuation)).toBe('{}')
    const result = await transport.continue(
      turn.continuation,
      turn.calls.map((call) => ({
        callId: call.id,
        output: { selectedPart: call.arguments.part, text: 'Only authorized data.' },
      })),
    )
    expect(result).toEqual({ kind: 'final', text: 'The selected question asks about rainfall.' })
    expect(fetcher).toHaveBeenCalledTimes(2)
    const first = bodyOf(fetcher, 0),
      second = bodyOf(fetcher, 1)
    expect(first.response_format).toBeUndefined()
    expect(first.text).toBeUndefined()
    expect(first.tool_choice).toBeUndefined()
    expect(JSON.stringify(second)).not.toContain(key)
    expect(JSON.stringify(second)).toContain('Only authorized data.')
    for (const [url, init] of fetcher.mock.calls) {
      expect(String(url)).not.toContain(key)
      expect(init?.redirect).toBe('error')
      expect(init?.signal).toBeInstanceOf(AbortSignal)
    }
    if (protocol === 'anthropic') {
      expect(first.tools).toEqual([
        {
          name: definitions[0].name,
          description: definitions[0].description,
          input_schema: definitions[0].inputSchema,
        },
      ])
      expect(second.messages.map((message: any) => message.role)).toEqual([
        'user',
        'assistant',
        'user',
      ])
      expect(second.messages[2].content.map((item: any) => item.tool_use_id)).toEqual([
        'call_1',
        'call_2',
      ])
      expect(second.messages[2].content.every((item: any) => item.type === 'tool_result')).toBe(
        true,
      )
    } else if (protocol === 'gemini') {
      expect(first.tools[0].functionDeclarations[0].parametersJsonSchema).toEqual(
        definitions[0].inputSchema,
      )
      expect(first.generationConfig.responseMimeType).toBeUndefined()
      expect(second.contents.map((item: any) => item.role)).toEqual(['user', 'model', 'user'])
      expect(second.contents[2].parts.map((item: any) => item.functionResponse.id)).toEqual([
        'call_1',
        'call_2',
      ])
      expect(second.contents[2].parts[0].functionResponse.response.output.selectedPart).toBe(
        'prompt',
      )
    } else if (protocol === 'openai-responses') {
      expect(first.store).toBe(false)
      expect(first.tools[0]).toMatchObject({
        type: 'function',
        name: definitions[0].name,
        strict: false,
      })
      expect(
        second.input
          .filter((item: any) => item.type === 'function_call_output')
          .map((item: any) => item.call_id),
      ).toEqual(['call_1', 'call_2'])
    } else {
      expect(first.max_tokens).toBe(8192)
      expect(first.store).toBeUndefined()
      expect(first.max_completion_tokens).toBeUndefined()
      expect(first.tools[0].function.parameters).toEqual(definitions[0].inputSchema)
      expect(second.messages.map((item: any) => item.role)).toEqual([
        'system',
        'user',
        'assistant',
        'tool',
        'tool',
      ])
      expect(second.messages[2].content).toBe('')
      expect(second.messages.slice(-2).map((item: any) => item.tool_call_id)).toEqual([
        'call_1',
        'call_2',
      ])
    }
  })
  it('supports sequential rounds with fresh IDs and preserves prior results', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(toolEnvelope(protocol)))
      .mockResolvedValueOnce(
        response(toolEnvelope(protocol, [{ id: 'call_2', args: { part: 'followup' } }])),
      )
      .mockResolvedValueOnce(response(finalEnvelope(protocol, 'Both local results were used.')))
    const transport = new ModelToolTransport(config(protocol), key, fetcher)
    const first = requireCalls(await transport.start('System', {}, definitions))
    const second = requireCalls(
      await transport.continue(first.continuation, [
        { callId: 'call_1', output: { localResult: 'first-local-result' } },
      ]),
    )
    expect(second.calls[0].id).toBe('call_2')
    const result = await transport.continue(second.continuation, [
      { callId: 'call_2', output: { localResult: 'second-local-result' } },
    ])
    expect(result).toEqual({ kind: 'final', text: 'Both local results were used.' })
    expect(JSON.stringify(bodyOf(fetcher, 2))).toContain('first-local-result')
    expect(JSON.stringify(bodyOf(fetcher, 2))).toContain('second-local-result')
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
  it('fails closed on mixed error/success envelopes and blank final text', async () => {
    for (const value of [
      { ...toolEnvelope(protocol), error: { message: marker } },
      finalEnvelope(protocol, '  '),
    ]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(value))
      await expect(
        new ModelToolTransport(config(protocol), key, fetcher).start('System', {}, definitions),
      ).rejects.toMatchObject({ code: 'envelope' })
    }
  })
  it('rejects prototype keys before parsing argument records', async () => {
    const args = JSON.parse('{"__proto__":{"part":"polluted"},"part":"prompt"}')
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response(toolEnvelope(protocol, [{ id: 'call_1', args }])))
    await expect(
      new ModelToolTransport(config(protocol), key, fetcher).start('System', {}, definitions),
    ).rejects.toMatchObject({ code: 'envelope' })
  })
  it('accepts repeated JSON object references in safe local results without accepting cycles', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(toolEnvelope(protocol)))
      .mockResolvedValueOnce(response(finalEnvelope(protocol)))
    const transport = new ModelToolTransport(config(protocol), key, fetcher)
    const turn = requireCalls(await transport.start('System', {}, definitions))
    const samePoint = { x: 1, y: 2 }
    await expect(
      transport.continue(turn.continuation, [
        { callId: 'call_1', output: { start: samePoint, end: samePoint } },
      ]),
    ).resolves.toMatchObject({ kind: 'final' })
  })
  it('represents execution failures as provider tool results', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(toolEnvelope(protocol)))
      .mockResolvedValueOnce(response(finalEnvelope(protocol)))
    const transport = new ModelToolTransport(config(protocol), key, fetcher)
    const turn = requireCalls(await transport.start('System', {}, definitions))
    await transport.continue(turn.continuation, [
      { callId: 'call_1', output: { code: 'scope_denied' }, isError: true },
    ])
    const body = bodyOf(fetcher, 1)
    expect(JSON.stringify(body)).toContain('scope_denied')
    if (protocol === 'anthropic') expect(body.messages.at(-1).content[0].is_error).toBe(true)
    if (protocol === 'gemini')
      expect(body.contents.at(-1).parts[0].functionResponse.response.error).toEqual({
        code: 'scope_denied',
      })
    if (protocol === 'openai-responses')
      expect(JSON.parse(body.input.at(-1).output)).toEqual({ error: { code: 'scope_denied' } })
    if (protocol === 'openai-chat')
      expect(JSON.parse(body.messages.at(-1).content)).toEqual({ error: { code: 'scope_denied' } })
  })
  it('keeps assistant preambles in opaque continuation instead of returning them as final results', async () => {
    const value = toolEnvelope(protocol)
    if (protocol === 'anthropic') value.content.unshift({ type: 'text', text: marker })
    if (protocol === 'gemini') value.candidates[0].content.parts.unshift({ text: marker })
    if (protocol === 'openai-responses')
      value.output.unshift({
        type: 'message',
        role: 'assistant',
        phase: 'commentary',
        content: [{ type: 'output_text', text: marker }],
      })
    if (protocol === 'openai-chat') value.choices[0].message.content = marker
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(value))
      .mockResolvedValueOnce(response(finalEnvelope(protocol)))
    const debug: ModelDebugEvent[] = []
    const transport = new ModelToolTransport(config(protocol), key, fetcher, 1000, (event) =>
      debug.push(event),
    )
    const turn = requireCalls(await transport.start('System', {}, definitions))
    expect(JSON.stringify(turn)).not.toContain(marker)
    await transport.continue(turn.continuation, [{ callId: 'call_1', output: {} }])
    expect(JSON.stringify(bodyOf(fetcher, 1))).toContain(marker)
    expect(JSON.stringify(debug)).not.toContain(marker)
  })
  it.each([
    ['unknown tool', (value: any) => toolEnvelope(protocol, [{ id: 'call_1', name: 'shell' }])],
    ['duplicate IDs', (value: any) => toolEnvelope(protocol, [{ id: 'call_1' }, { id: 'call_1' }])],
    ['invalid arguments', (value: any) => toolEnvelope(protocol, [{ id: 'call_1', args: [] }])],
    [
      'unsupported blocks',
      (value: any) => {
        addUnsupported(protocol, value)
        return value
      },
    ],
    [
      'too many calls',
      (value: any) =>
        toolEnvelope(
          protocol,
          Array.from({ length: 7 }, (_, i) => ({ id: `call_${i}` })),
        ),
    ],
    ['invalid call ID', (value: any) => toolEnvelope(protocol, [{ id: 'bad id' }])],
    ['unexpected envelope', (value: any) => ({ output_text: 'Pretend success' })],
  ])('rejects %s without continuing', async (_, mutate) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response(mutate(toolEnvelope(protocol))))
    const transport = new ModelToolTransport(config(protocol), key, fetcher)
    await expect(transport.start('System', {}, definitions)).rejects.toMatchObject({
      code: 'envelope',
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('rejects an ID replayed in a later model turn', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => response(toolEnvelope(protocol)))
    const transport = new ModelToolTransport(config(protocol), key, fetcher)
    const turn = requireCalls(await transport.start('System', {}, definitions))
    await expect(
      transport.continue(turn.continuation, [{ callId: 'call_1', output: {} }]),
    ).rejects.toMatchObject({ code: 'envelope' })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('rejects replayed, copied, and cross-transport continuation tokens', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(toolEnvelope(protocol)))
      .mockResolvedValueOnce(response(finalEnvelope(protocol)))
    const transport = new ModelToolTransport(config(protocol), key, fetcher)
    const turn = requireCalls(await transport.start('System', {}, definitions))
    const results = [{ callId: 'call_1', output: {} }]
    await expect(transport.continue({} as ToolContinuation, results)).rejects.toMatchObject({
      code: 'envelope',
    })
    await expect(
      new ModelToolTransport(config(protocol), key, fetcher).continue(turn.continuation, results),
    ).rejects.toMatchObject({ code: 'envelope' })
    await transport.continue(turn.continuation, results)
    await expect(transport.continue(turn.continuation, results)).rejects.toMatchObject({
      code: 'envelope',
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('consumes each continuation before concurrent requests can replay it', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(toolEnvelope(protocol)))
      .mockResolvedValueOnce(response(finalEnvelope(protocol)))
    const transport = new ModelToolTransport(config(protocol), key, fetcher)
    const turn = requireCalls(await transport.start('System', {}, definitions))
    const outcomes = await Promise.allSettled([
      transport.continue(turn.continuation, [{ callId: 'call_1', output: {} }]),
      transport.continue(turn.continuation, [{ callId: 'call_1', output: {} }]),
    ])
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it.each(['missing', 'wrong', 'duplicate', 'out-of-order'])(
    'rejects %s results without sending',
    async (kind) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(response(toolEnvelope(protocol, [{ id: 'call_1' }, { id: 'call_2' }])))
      const transport = new ModelToolTransport(config(protocol), key, fetcher)
      const turn = requireCalls(await transport.start('System', {}, definitions))
      const ids =
        kind === 'missing'
          ? ['call_1']
          : kind === 'wrong'
            ? ['call_1', 'call_other']
            : kind === 'duplicate'
              ? ['call_1', 'call_1']
              : ['call_2', 'call_1']
      await expect(
        transport.continue(
          turn.continuation,
          ids.map((callId) => ({ callId, output: {} })),
        ),
      ).rejects.toMatchObject({ code: 'envelope' })
      expect(fetcher).toHaveBeenCalledTimes(1)
    },
  )
  it('does not allow caller mutations to alter retained provider history', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(toolEnvelope(protocol)))
      .mockResolvedValueOnce(response(finalEnvelope(protocol)))
    const transport = new ModelToolTransport(config(protocol), key, fetcher)
    const turn = requireCalls(await transport.start('System', {}, definitions))
    turn.calls[0].arguments.part = 'malicious mutation'
    await transport.continue(turn.continuation, [{ callId: 'call_1', output: {} }])
    expect(JSON.stringify(bodyOf(fetcher, 1))).not.toContain('malicious mutation')
  })
  it('bounds argument JSON by bytes and nesting', async () => {
    let nested: unknown = {}
    for (let i = 0; i < 40; i++) nested = { next: nested }
    for (const args of [{ text: '文'.repeat(TOOL_TRANSPORT_LIMITS.argumentBytes / 2) }, nested]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(response(toolEnvelope(protocol, [{ id: 'call_1', args }])))
      await expect(
        new ModelToolTransport(config(protocol), key, fetcher).start('System', {}, definitions),
      ).rejects.toBeInstanceOf(ModelTransportError)
    }
  })
  it('blocks credential reflection anywhere in provider envelope and decoded arguments', async () => {
    const values = [
      { ...toolEnvelope(protocol), harmlessMetadata: { [key]: true } },
      toolEnvelope(protocol, [{ id: 'call_1', args: { secret: key } }]),
    ]
    for (const value of values) {
      const events: ModelDebugEvent[] = []
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(value))
      const transport = new ModelToolTransport(config(protocol), key, fetcher, 1000, (event) =>
        events.push(event),
      )
      await expect(transport.start('System', {}, definitions)).rejects.toMatchObject({
        code: 'credential_reflection',
      })
      expect(JSON.stringify(events)).not.toContain(key)
      expect(JSON.stringify(events)).not.toContain('harmlessMetadata')
    }
  })
  it('blocks credential reflection and oversized tool outputs before sending continuation', async () => {
    for (const output of [{ key }, { text: 'x'.repeat(TOOL_TRANSPORT_LIMITS.resultBytes + 1) }]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(toolEnvelope(protocol)))
      const transport = new ModelToolTransport(config(protocol), key, fetcher)
      const turn = requireCalls(await transport.start('System', {}, definitions))
      await expect(
        transport.continue(turn.continuation, [{ callId: 'call_1', output }]),
      ).rejects.toBeInstanceOf(ModelTransportError)
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  })
  it('rejects non-JSON or cyclic local results without leaking data', async () => {
    const cycle: any = {}
    cycle.next = cycle
    for (const output of [undefined, Infinity, BigInt(1), cycle, { constructor: marker }]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(toolEnvelope(protocol)))
      const transport = new ModelToolTransport(config(protocol), key, fetcher)
      const turn = requireCalls(await transport.start('System', {}, definitions))
      await expect(
        transport.continue(turn.continuation, [{ callId: 'call_1', output }]),
      ).rejects.toMatchObject({ code: 'envelope' })
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  })
  it('classifies refusals and truncation instead of treating partial calls as executable', async () => {
    for (const kind of ['refusal', 'truncated']) {
      const value = toolEnvelope(protocol)
      if (protocol === 'anthropic')
        value.stop_reason = kind === 'refusal' ? 'refusal' : 'max_tokens'
      if (protocol === 'gemini')
        value.candidates[0].finishReason = kind === 'refusal' ? 'SAFETY' : 'MAX_TOKENS'
      if (protocol === 'openai-responses') {
        value.status = 'incomplete'
        value.incomplete_details = {
          reason: kind === 'refusal' ? 'content_filter' : 'max_output_tokens',
        }
      }
      if (protocol === 'openai-chat')
        value.choices[0].finish_reason = kind === 'refusal' ? 'content_filter' : 'length'
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(value))
      await expect(
        new ModelToolTransport(config(protocol), key, fetcher).start('System', {}, definitions),
      ).rejects.toMatchObject({ code: kind })
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  })
  it('aborts before fetch, during fetch, and after a call before continuation', async () => {
    const alreadyCancelled = new AbortController()
    alreadyCancelled.abort()
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Promise(() => {}))
    const transport = new ModelToolTransport(config(protocol), key, fetcher, 1000)
    await expect(
      transport.start('System', {}, definitions, alreadyCancelled.signal),
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(fetcher).not.toHaveBeenCalled()
    const controller = new AbortController()
    const pending = transport.start('System', {}, definitions, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
    const callsFetch = vi.fn<typeof fetch>().mockResolvedValue(response(toolEnvelope(protocol)))
    const callsTransport = new ModelToolTransport(config(protocol), key, callsFetch)
    const turn = requireCalls(await callsTransport.start('System', {}, definitions))
    await expect(
      callsTransport.continue(
        turn.continuation,
        [{ callId: 'call_1', output: {} }],
        alreadyCancelled.signal,
      ),
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(callsFetch).toHaveBeenCalledTimes(1)
  })
  it('times out an uncooperative fetch without retrying', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Promise(() => {}))
    await expect(
      new ModelToolTransport(config(protocol), key, fetcher, 5).start('System', {}, definitions),
    ).rejects.toMatchObject({ code: 'timeout' })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
  })
  it('times out and cancels a stalled response body', async () => {
    const cancel = vi.fn()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{'))
          },
          cancel,
        }),
      ),
    )
    await expect(
      new ModelToolTransport(config(protocol), key, fetcher, 5).start('System', {}, definitions),
    ).rejects.toMatchObject({ code: 'timeout' })
    expect(cancel).toHaveBeenCalled()
  })
  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [429, 'rate_limit'],
    [500, 'http'],
    [302, 'network'],
  ] as const)('handles HTTP %s using fixed diagnostics', async (status, code) => {
    const events: ModelDebugEvent[] = []
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(`${key} ${marker}`, { status }))
    await expect(
      new ModelToolTransport(config(protocol), key, fetcher, 1000, (event) =>
        events.push(event),
      ).start('System', {}, definitions),
    ).rejects.toMatchObject({ code })
    expect(events[0]).toMatchObject({ category: code, stage: 'http', httpStatus: status })
    expect(JSON.stringify(events)).not.toContain(marker)
  })
  it('rejects redirects, oversized streams and content-length, malformed JSON and UTF-8', async () => {
    const redirected = response(finalEnvelope(protocol))
    Object.defineProperty(redirected, 'redirected', { value: true })
    const cases: [Response, string][] = [
      [redirected, 'network'],
      [new Response('x'.repeat(262145)), 'response_too_large'],
      [new Response('{}', { headers: { 'content-length': '262145' } }), 'response_too_large'],
      [new Response('{bad'), 'parse'],
      [new Response(new Uint8Array([255])), 'parse'],
    ]
    for (const [result, code] of cases) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(result)
      await expect(
        new ModelToolTransport(config(protocol), key, fetcher).start('System', {}, definitions),
      ).rejects.toMatchObject({ code })
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  })
  it('never records arguments, results, raw model output, endpoint or raw errors', async () => {
    const events: ModelDebugEvent[] = []
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response(toolEnvelope(protocol, [{ id: 'call_1', args: { part: marker } }])),
      )
      .mockResolvedValueOnce(response(finalEnvelope(protocol, marker)))
    const transport = new ModelToolTransport(config(protocol), key, fetcher, 1000, (event) =>
      events.push(event),
    )
    const turn = requireCalls(
      await transport.start('System', { secretDocument: marker }, definitions),
    )
    await transport.continue(turn.continuation, [
      { callId: 'call_1', output: { secretResult: marker } },
    ])
    expect(events).toHaveLength(2)
    expect(JSON.stringify(events)).not.toContain(marker)
    expect(JSON.stringify(events)).not.toContain('vendor.com')
    const failureFetch = vi.fn<typeof fetch>().mockRejectedValue(new Error(`${key}: ${marker}`))
    await expect(
      new ModelToolTransport(config(protocol), key, failureFetch, 1000, (event) =>
        events.push(event),
      ).start('System', {}, definitions),
    ).rejects.toMatchObject({ code: 'network' })
    expect(JSON.stringify(events)).not.toContain(marker)
    expect(JSON.stringify(events)).not.toContain(key)
  })
})

describe('bounded required continuation metadata', () => {
  it('replays Gemini thought signatures and IDs exactly, privately and without invented wire IDs', async () => {
    const value = toolEnvelope('gemini', [{ id: 'given_id' }, { id: 'remove_id' }])
    delete value.candidates[0].content.parts[1].functionCall.id
    value.candidates[0].content.parts[0].thoughtSignature = 'opaque+/signature=='
    value.candidates[0].content.parts.unshift({
      text: marker,
      thoughtSignature: 'text+/signature==',
    })
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(value))
      .mockResolvedValueOnce(response(finalEnvelope('gemini')))
    const events: ModelDebugEvent[] = []
    const transport = new ModelToolTransport(config('gemini'), key, fetcher, 1000, (event) =>
      events.push(event),
    )
    const turn = requireCalls(await transport.start('System', {}, definitions))
    expect(turn.calls[1].id).toMatch(/^local_/)
    expect(JSON.stringify(turn)).not.toContain('signature')
    await transport.continue(
      turn.continuation,
      turn.calls.map((call) => ({ callId: call.id, output: {} })),
    )
    const contents = bodyOf(fetcher, 1).contents
    expect(contents[1]).toEqual(value.candidates[0].content)
    expect(contents[2].parts[0].functionResponse.id).toBe('given_id')
    expect(contents[2].parts[1].functionResponse.id).toBeUndefined()
    expect(JSON.stringify(events)).not.toContain('signature')
  })
  it('replays complete bounded Responses reasoning items without exposing them', async () => {
    const reasoning = {
      id: 'rs_first',
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: marker }],
      content: [],
      encrypted_content: 'opaque_encrypted_state',
      status: 'completed',
    }
    const value = toolEnvelope('openai-responses')
    value.output.unshift(reasoning)
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(value))
      .mockResolvedValueOnce(response(finalEnvelope('openai-responses')))
    const events: ModelDebugEvent[] = []
    const transport = new ModelToolTransport(
      config('openai-responses'),
      key,
      fetcher,
      1000,
      (event) => events.push(event),
    )
    const turn = requireCalls(await transport.start('System', {}, definitions))
    expect(JSON.stringify(turn)).not.toContain(marker)
    await transport.continue(turn.continuation, [{ callId: 'call_1', output: {} }])
    expect(bodyOf(fetcher, 1).input[1]).toEqual(reasoning)
    expect(bodyOf(fetcher, 0).include).toEqual(['reasoning.encrypted_content'])
    expect(JSON.stringify(events)).not.toContain(marker)
    expect(JSON.stringify(events)).not.toContain('opaque_encrypted_state')
  })
  it('replays bounded DeepSeek reasoning_content without forcing thinking or exposing it', async () => {
    const value = toolEnvelope('openai-chat')
    value.choices[0].message.reasoning_content = marker
    const final = finalEnvelope('openai-chat')
    final.choices[0].message.reasoning_content = 'PRIVATE FINAL REASONING'
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(value))
      .mockResolvedValueOnce(response(final))
    const events: ModelDebugEvent[] = []
    const transport = new ModelToolTransport(config('openai-chat'), key, fetcher, 1000, (event) =>
      events.push(event),
    )
    const turn = requireCalls(await transport.start('System', {}, definitions))
    expect(JSON.stringify(turn)).not.toContain(marker)
    const result = await transport.continue(turn.continuation, [{ callId: 'call_1', output: {} }])
    const body = bodyOf(fetcher, 1)
    expect(body.messages[2].reasoning_content).toBe(marker)
    expect(body.thinking).toBeUndefined()
    expect(body.tool_choice).toBeUndefined()
    expect(body.store).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain('PRIVATE FINAL REASONING')
    expect(JSON.stringify(events)).not.toContain(marker)
  })
  it('rejects unsolicited thinking blocks or unknown reasoning fields', async () => {
    const anthropic = toolEnvelope('anthropic')
    anthropic.content.unshift({ type: 'thinking', thinking: marker, signature: 'opaque' })
    const gemini = toolEnvelope('gemini')
    gemini.candidates[0].content.parts.unshift({ text: marker, thought: true })
    const responses = toolEnvelope('openai-responses')
    responses.output.unshift({ id: 'rs_1', type: 'reasoning', summary: [], unexpected: marker })
    const chat = toolEnvelope('openai-chat')
    chat.choices[0].message.reasoning = marker
    for (const [protocol, value] of [
      ['anthropic', anthropic],
      ['gemini', gemini],
      ['openai-responses', responses],
      ['openai-chat', chat],
    ] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(value))
      await expect(
        new ModelToolTransport(config(protocol), key, fetcher).start('System', {}, definitions),
      ).rejects.toMatchObject({ code: 'envelope' })
    }
  })
  it('blocks keys inside carried signatures, reasoning and double-escaped JSON arguments', async () => {
    const gemini = toolEnvelope('gemini')
    gemini.candidates[0].content.parts[0].thoughtSignature = key
    const responses = toolEnvelope('openai-responses')
    responses.output.unshift({ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: key })
    const chat = toolEnvelope('openai-chat')
    chat.choices[0].message.reasoning_content = key
    for (const [protocol, value] of [
      ['gemini', gemini],
      ['openai-responses', responses],
      ['openai-chat', chat],
    ] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(value))
      await expect(
        new ModelToolTransport(config(protocol), key, fetcher).start('System', {}, definitions),
      ).rejects.toMatchObject({ code: 'credential_reflection' })
    }
    for (const protocol of ['openai-chat', 'openai-responses'] as const) {
      const raw = JSON.stringify({ part: key }).replace('sk-', '\\u0073k-')
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(response(toolEnvelope(protocol, [{ id: 'call_1', raw }])))
      await expect(
        new ModelToolTransport(config(protocol), key, fetcher).start('System', {}, definitions),
      ).rejects.toMatchObject({ code: 'credential_reflection' })
    }
  })
  it('bounds accumulated continuation before sending another request', async () => {
    const first = toolEnvelope('openai-responses', [
      { id: 'call_1' },
      { id: 'call_2' },
      { id: 'call_3' },
    ])
    first.output.unshift({
      type: 'reasoning',
      id: 'rs_1',
      summary: [],
      encrypted_content: 'x'.repeat(65536),
    })
    const second = toolEnvelope('openai-responses', [{ id: 'call_4' }])
    second.output.unshift({
      type: 'reasoning',
      id: 'rs_2',
      summary: [],
      encrypted_content: 'y'.repeat(65536),
    })
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(first))
      .mockResolvedValueOnce(response(second))
    const transport = new ModelToolTransport(config('openai-responses'), key, fetcher)
    const turn = requireCalls(await transport.start('System', {}, definitions))
    await expect(
      transport.continue(
        turn.continuation,
        turn.calls.map((call) => ({ callId: call.id, output: { text: 'z'.repeat(60000) } })),
      ),
    ).rejects.toMatchObject({ code: 'response_too_large' })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
