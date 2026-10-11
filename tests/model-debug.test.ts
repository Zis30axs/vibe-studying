import { describe, expect, it, vi } from 'vitest'
import { ModelDebugStore } from '../src/adapters/model-debug'
import { ModelTransport, ModelTransportError } from '../src/adapters/model-transport'
import { ModelAgent } from '../src/adapters/model-agent'
import {
  MODEL_DEBUG_LIMIT,
  safeModelDebugPaths,
  type ModelDebugCategory,
  type ModelDebugEvent,
} from '../src/shared/model-debug'
import { emptyDraft, type ModelProtocol, type Question } from '../src/shared/types'

const key = 'sk-synthetic-debug-key-not-real'
const marker = 'PRIVATE-ANSWER-AND-TEXTBOOK-BODY'
const requestId = 'a37c1967-3052-4d36-853f-402c1efc6630'
const config = {
  protocol: 'openai-chat' as const,
  model: 'synthetic-model',
  baseUrl: 'https://api.vendor.com/v1',
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const envelope = (value: unknown) => ({
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }],
})
const event: ModelDebugEvent = {
  requestId,
  protocol: 'openai-chat',
  model: 'synthetic-model',
  stage: 'schema',
  category: 'schema',
  elapsedMs: 20,
  httpStatus: 200,
  schemaPaths: ['rubric[*].earned'],
}
function setup(fetcher: typeof fetch, protocol: ModelProtocol = 'openai-chat', timeoutMs = 100) {
  const store = new ModelDebugStore()
  store.setEnabled(true)
  return {
    store,
    transport: new ModelTransport({ ...config, protocol }, key, fetcher, timeoutMs, store.record),
  }
}
const question: Question = {
  id: 'question',
  subject: 'history',
  kind: 'history',
  title: 'Synthetic',
  prompt: 'Synthetic',
  source: 'Synthetic',
  tags: [],
  explanation: 'Synthetic',
  maxScore: 4,
  rubric: [{ id: 'reason', label: 'Reason', keywords: ['reason'], points: 4 }],
}

describe('local opt-in model debug store', () => {
  it('defaults off, bounds records and clears on disable without persisting anything', () => {
    const store = new ModelDebugStore()
    store.record(event)
    expect(store.getState()).toEqual({ enabled: false, limit: MODEL_DEBUG_LIMIT, records: [] })
    store.setEnabled(true)
    for (let count = 0; count < MODEL_DEBUG_LIMIT + 10; count++) store.record(event)
    expect(store.getState().records).toHaveLength(MODEL_DEBUG_LIMIT)
    expect(store.getState().records[0].id).toBe(11)
    const snapshot = store.getState()
    snapshot.records[0].schemaPaths!.push(key)
    snapshot.records[0].model = key
    expect(store.copyText()).not.toContain(key)
    store.setEnabled(false)
    expect(store.getState().records).toEqual([])
    store.record(event)
    expect(store.copyText()).not.toContain('synthetic-model')
    store.setEnabled(true)
    expect(store.getState().records).toEqual([])
    store.record(event)
    expect(store.clear()).toEqual({ enabled: true, limit: MODEL_DEBUG_LIMIT, records: [] })
    expect(new ModelDebugStore().getState().enabled).toBe(false)
  })

  it('allowlists every stored/copied field and normalizes hostile schema paths', () => {
    const store = new ModelDebugStore()
    store.setEnabled(true)
    store.record({
      ...event,
      model: key,
      elapsedMs: Infinity,
      httpStatus: 9999,
      schemaPaths: [`rubric.${key}.earned`, `https://host.invalid/?key=${key}`, 'rubric[*].earned'],
      response: marker,
      headers: { Authorization: key },
      request: marker,
      error: `${key} ${marker}`,
    } as ModelDebugEvent)
    const saved = store.getState().records[0]
    expect(saved).toEqual({
      ...event,
      id: 1,
      model: '[redacted]',
      elapsedMs: 0,
      httpStatus: undefined,
      schemaPaths: ['rubric[field].earned', '[field][field]', 'rubric[*].earned'],
    })
    expect(Object.keys(saved)).not.toContain('httpStatus')
    const copied = store.copyText()
    expect(copied).not.toContain(key)
    expect(copied).not.toContain(marker)
    expect(copied).not.toContain('Authorization')
    expect(copied).not.toContain('?key=')
    store.record({ ...event, stage: key } as unknown as ModelDebugEvent)
    store.record({ ...event, requestId: key })
    expect(store.getState().records).toHaveLength(1)
    expect(
      safeModelDebugPaths([
        ['rubric', key, 'earned'],
        ['rubric', Number.MAX_SAFE_INTEGER, 'feedback'],
        [Symbol(key)],
        [],
      ]),
    ).toEqual(['rubric[field].earned', 'rubric[*].feedback', '[field]', '$'])
  })

  it('bounds individual metadata and rejects non-boolean toggles', () => {
    const store = new ModelDebugStore()
    expect(() => store.setEnabled('true' as unknown as boolean)).toThrow('Debug 开关无效')
    store.setEnabled(true)
    store.record({
      ...event,
      model: 'x'.repeat(200),
      elapsedMs: 99999999,
      schemaPaths: Array(100).fill('feedback'),
    })
    expect(store.getState().records[0]).toMatchObject({
      model: '[redacted]',
      elapsedMs: 600000,
      schemaPaths: ['feedback'],
    })
  })
})

describe('fixed sanitized transport diagnostics, mocked HTTP only', () => {
  it.each([
    ['malformed outer JSON', () => new Response(`{${key}${marker}`), 'response', 'parse'],
    [
      'invalid envelope',
      () => json({ choices: [{ finish_reason: marker, message: { content: '{}' } }] }),
      'envelope',
      'envelope',
    ],
    [
      'malformed model JSON',
      () => json({ choices: [{ finish_reason: 'stop', message: { content: `{${marker}` } }] }),
      'json',
      'parse',
    ],
    ['authentication', () => new Response(`${key} ${marker}`, { status: 401 }), 'http', 'auth'],
    ['forbidden', () => new Response(`${key} ${marker}`, { status: 403 }), 'http', 'auth'],
    ['rate limit', () => new Response(`${key} ${marker}`, { status: 429 }), 'http', 'rate_limit'],
    ['unknown model', () => new Response(`${key} ${marker}`, { status: 404 }), 'http', 'http'],
    [
      'too large',
      () => new Response(marker, { headers: { 'content-length': '262145' } }),
      'response',
      'response_too_large',
    ],
    [
      'reflected credential',
      () => json(envelope({ hint: key })),
      'envelope',
      'credential_reflection',
    ],
  ] as const)(
    '%s emits one safe record without an automatic retry',
    async (_name, makeResponse, stage, category) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(makeResponse())
      const { store, transport } = setup(fetcher)
      const error = await transport
        .json(marker, { answer: marker, textbook: marker })
        .catch((error: unknown) => error)
      expect(error).toBeInstanceOf(ModelTransportError)
      expect((error as ModelTransportError).code).toBe(category)
      expect((error as Error).message).not.toContain(key)
      expect((error as Error).message).not.toContain(marker)
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(store.getState().records).toHaveLength(1)
      expect(store.getState().records[0]).toMatchObject({
        stage,
        category,
        protocol: 'openai-chat',
        model: config.model,
      })
      expect(store.copyText()).not.toContain(key)
      expect(store.copyText()).not.toContain(marker)
      expect(store.copyText()).not.toContain('api.vendor.com')
    },
  )

  it.each([
    [
      'anthropic',
      { stop_reason: 'max_tokens', content: [{ type: 'text', text: marker }] },
      'truncated',
    ],
    ['anthropic', { stop_reason: 'refusal', content: [{ type: 'text', text: marker }] }, 'refusal'],
    ['gemini', { candidates: [{ finishReason: 'MAX_TOKENS' }] }, 'truncated'],
    ['gemini', { promptFeedback: { blockReason: 'SAFETY' }, candidates: [] }, 'refusal'],
    ['gemini', { candidates: [{ finishReason: 'RECITATION' }] }, 'refusal'],
    [
      'openai-responses',
      { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
      'truncated',
    ],
    [
      'openai-responses',
      {
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'refusal', refusal: marker }] }],
      },
      'refusal',
    ],
    [
      'openai-chat',
      { choices: [{ finish_reason: 'length', message: { content: marker } }] },
      'truncated',
    ],
    ['openai-chat', { choices: [{ finish_reason: 'content_filter', message: {} }] }, 'refusal'],
    [
      'openai-chat',
      { choices: [{ finish_reason: 'stop', message: { content: null, refusal: marker } }] },
      'refusal',
    ],
  ] as [ModelProtocol, unknown, ModelDebugCategory][])(
    '%s classifies documented %s outcome as %s',
    async (protocol, body, category) => {
      const { store, transport } = setup(
        vi.fn<typeof fetch>().mockResolvedValue(json(body)),
        protocol,
      )
      await expect(transport.json(marker, {})).rejects.toMatchObject({ code: category })
      expect(store.getState().records[0]).toMatchObject({
        stage: 'envelope',
        category,
        httpStatus: 200,
      })
      expect(store.copyText()).not.toContain(marker)
    },
  )

  it('does not infer a refusal or truncation from arbitrary provider wording', async () => {
    const { store, transport } = setup(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(json({ error: { message: 'token limit safety refusal' } })),
    )
    await expect(transport.json('', {})).rejects.toMatchObject({ code: 'envelope' })
    expect(store.getState().records[0].category).toBe('envelope')
  })

  it('sanitizes network errors, key-shaped model IDs and callbacks before they cross boundaries', async () => {
    const records: ModelDebugEvent[] = []
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error(`https://host.invalid?token=${key} ${marker}`))
    const transport = new ModelTransport({ ...config, model: key }, key, fetcher, 50, (record) =>
      records.push(record),
    )
    await expect(transport.json(marker, {})).rejects.toMatchObject({ code: 'network' })
    expect(records[0].model).toBe('[redacted]')
    expect(JSON.stringify(records)).not.toContain(key)
    expect(JSON.stringify(records)).not.toContain(marker)
    const successful = new ModelTransport(
      config,
      key,
      vi.fn<typeof fetch>().mockResolvedValue(json(envelope({ hint: 'safe' }))),
      50,
      () => {
        throw new Error(marker)
      },
    )
    await expect(successful.json('', {})).resolves.toEqual({ hint: 'safe' })
  })

  it('blocks decoded credential echoes in otherwise ignored envelope fields', async () => {
    const escapedKey = 'credential-decoded-"-\\-key'
    const store = new ModelDebugStore()
    store.setEnabled(true)
    const transport = new ModelTransport(
      config,
      escapedKey,
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          json({ ...envelope({ hint: 'safe' }), debug: { [escapedKey]: 'ignored' } }),
        ),
      50,
      store.record,
    )
    await expect(transport.json('', {})).rejects.toMatchObject({ code: 'credential_reflection' })
    expect(store.copyText()).not.toContain('credential-decoded-')
  })

  it('generates independent request IDs while retaining only allowlisted success metadata', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => json(envelope({ hint: marker })))
    const { store, transport } = setup(fetcher)
    await Promise.all([transport.json(marker, {}), transport.json(marker, {})])
    const records = store.getState().records
    expect(new Set(records.map((item) => item.requestId)).size).toBe(2)
    expect(records.every((item) => item.category === 'ok' && item.stage === 'json')).toBe(true)
    expect(store.copyText()).not.toContain(marker)
  })

  it('stays disabled until explicitly enabled and immediately stops recording when disabled', async () => {
    const store = new ModelDebugStore()
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => json(envelope({ hint: marker })))
    const transport = new ModelTransport(config, key, fetcher, 50, store.record)
    await transport.json('', {})
    expect(store.getState().records).toEqual([])
    store.setEnabled(true)
    await transport.json('', {})
    expect(store.getState().records).toHaveLength(1)
    store.setEnabled(false)
    await transport.json('', {})
    expect(store.getState().records).toEqual([])
  })

  it('preserves cancellation, does not fetch for pre-cancelled work and never reports cancellation as parse failure', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}))
    const { store, transport } = setup(fetcher)
    const before = new AbortController()
    before.abort()
    await expect(transport.json('', {}, before.signal)).rejects.toMatchObject({ code: 'cancelled' })
    expect(fetcher).not.toHaveBeenCalled()
    const after = new AbortController()
    const pending = transport.json('', {}, after.signal)
    const assertion = expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    after.abort()
    await assertion
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect(store.getState().records.map((item) => item.category)).toEqual([
      'cancelled',
      'cancelled',
    ])
  })

  it('distinguishes a stalled connection and response-body timeout without late stale events', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}))
    const { store, transport } = setup(fetcher, 'openai-chat', 5)
    await expect(transport.json('', {})).rejects.toMatchObject({ code: 'timeout' })
    expect(store.getState().records[0]).toMatchObject({ category: 'timeout', stage: 'request' })
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'))
      },
      cancel,
    })
    const stalled = setup(
      vi.fn<typeof fetch>().mockResolvedValue(new Response(body)),
      'openai-chat',
      5,
    )
    await expect(stalled.transport.json('', {})).rejects.toMatchObject({ code: 'timeout' })
    expect(stalled.store.getState().records[0]).toMatchObject({
      category: 'timeout',
      stage: 'response',
      httpStatus: 200,
    })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(stalled.store.getState().records).toHaveLength(1)
  })

  it('late success from a non-cooperative fetch cannot add an event after cancellation and clear', async () => {
    let finish: ((response: Response) => void) | undefined
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const { store, transport } = setup(fetcher)
    const controller = new AbortController()
    const pending = transport.json('', {}, controller.signal)
    const assertion = expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    controller.abort()
    await assertion
    store.clear()
    finish!(json(envelope({ hint: marker })))
    await Promise.resolve()
    await Promise.resolve()
    expect(store.getState().records).toEqual([])
  })
})

describe('schema diagnostics retain no model-written grading data', () => {
  it.each([
    [{ feedback: '', explanation: marker, rubric: [] }, 'feedback'],
    [
      {
        feedback: marker,
        explanation: marker,
        rubric: [{ id: 'reason', earned: 1.2, feedback: marker }],
      },
      'rubric[*].earned',
    ],
    [
      {
        feedback: marker,
        explanation: marker,
        rubric: [{ id: 'reason', earned: 90, feedback: marker }],
      },
      'rubric[*].earned',
    ],
    [{ feedback: marker, explanation: marker, rubric: [] }, 'rubric'],
  ])(
    'keeps only schema paths and correlates them to the transport request',
    async (result, expectedPath) => {
      const { store, transport } = setup(
        vi.fn<typeof fetch>().mockResolvedValue(json(envelope(result))),
      )
      await expect(
        new ModelAgent('mock reviewer', transport).review(question, {
          ...emptyDraft(),
          text: marker,
        }),
      ).rejects.toMatchObject({ code: 'schema' })
      const records = store.getState().records
      expect(records).toHaveLength(2)
      expect(records[0].category).toBe('ok')
      expect(records[1]).toMatchObject({
        stage: 'schema',
        category: 'schema',
        schemaPaths: expect.arrayContaining([expectedPath]),
      })
      expect(records[1].requestId).toBe(records[0].requestId)
      expect(store.copyText()).not.toContain(marker)
      expect(store.copyText()).not.toContain(key)
    },
  )

  it('redacts malicious schema keys and never copies error messages or dynamic IDs', () => {
    const { store, transport } = setup(vi.fn<typeof fetch>())
    transport.reportSchemaFailure(
      [['rubric', key, 'earned'], ['rubric', 1, marker], ['https://host.invalid?token=' + key]],
      1,
    )
    expect(store.getState().records[0].schemaPaths).toEqual([
      'rubric[field].earned',
      'rubric[*][field]',
      '[field]',
    ])
    expect(store.copyText()).not.toContain(key)
    expect(store.copyText()).not.toContain(marker)
  })
})

it('allowlists and clones connection metadata at every Debug boundary', () => {
  const store = new ModelDebugStore()
  store.setEnabled(true)
  store.record({
    ...event,
    operation: 'model_list',
    connection: { stage: 'dns', networkCode: key, httpStatus: 9999, message: key, url: key },
  } as unknown as ModelDebugEvent)
  expect(store.getState().records[0].connection).toEqual({ stage: 'dns' })
  const copy = store.getState()
  copy.records[0].connection!.stage = 'http'
  expect(store.getState().records[0].connection!.stage).toBe('dns')
  expect(store.copyText()).not.toContain(key)
  store.record({
    ...event,
    operation: key,
    connection: { stage: key, networkCode: 'ENOTFOUND' },
  } as unknown as ModelDebugEvent)
  expect(store.getState().records[1]).not.toHaveProperty('operation')
  expect(store.getState().records[1]).not.toHaveProperty('connection')
})
