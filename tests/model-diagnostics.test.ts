import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { request } from 'node:https'
import { lookup } from 'node:dns'
import type { ModelProtocol } from '../src/shared/types'
import {
  listRemoteModels,
  ModelDiagnosticError,
  testModelConnection,
} from '../src/adapters/model-diagnostics'
import { secureFetch } from '../src/adapters/model-transport'

vi.mock('node:https', () => ({ request: vi.fn() }))
vi.mock('node:dns', () => ({ lookup: vi.fn() }))

const key = 'synthetic-diagnostic-key-never-real'
const protocols: ModelProtocol[] = ['anthropic', 'gemini', 'openai-responses', 'openai-chat']
const config = (protocol: ModelProtocol = 'openai-chat') => ({
  protocol,
  baseUrl: 'https://api.vendor.com/v1',
  model: 'model-test',
})
const response = (body: unknown) => new Response(JSON.stringify(body))
function envelope(protocol: ModelProtocol, text = 'OK', limited = false) {
  if (protocol === 'anthropic')
    return {
      type: 'message',
      role: 'assistant',
      stop_reason: limited ? 'max_tokens' : 'end_turn',
      content: [{ type: 'text', text }],
    }
  if (protocol === 'gemini')
    return {
      candidates: [
        {
          finishReason: limited ? 'MAX_TOKENS' : 'STOP',
          content: { role: 'model', parts: [{ text }] },
        },
      ],
    }
  if (protocol === 'openai-responses')
    return {
      object: 'response',
      status: limited ? 'incomplete' : 'completed',
      error: null,
      incomplete_details: limited ? { reason: 'max_output_tokens' } : null,
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: limited ? 'incomplete' : 'completed',
          content: [{ type: 'output_text', text }],
        },
      ],
    }
  return {
    object: 'chat.completion',
    choices: [
      {
        finish_reason: limited ? 'length' : 'stop',
        message: { role: 'assistant', content: text, refusal: null },
      },
    ],
  }
}
function listEnvelope(protocol: ModelProtocol) {
  if (protocol === 'gemini')
    return {
      models: [
        {
          name: 'models/model-test',
          displayName: 'Test model',
          supportedGenerationMethods: ['generateContent'],
        },
        { name: 'models/embedding-only', supportedGenerationMethods: ['embedContent'] },
      ],
    }
  return { data: [{ id: 'model-test', display_name: 'Test model', ignored: 'provider-only' }] }
}
afterEach(() => vi.clearAllMocks())

describe.each(protocols)('%s diagnostics with synthetic credentials', (protocol) => {
  it('lists models with protocol authentication, no request body and an allowlisted result', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(listEnvelope(protocol)))
    expect(await listRemoteModels({ ...config(protocol), model: '' }, key, { fetchImpl })).toEqual([
      { id: 'model-test', name: 'Test model' },
    ])
    const [url, options] = fetchImpl.mock.calls[0]
    const parsed = new URL(String(url))
    expect(parsed.pathname).toBe('/v1/models')
    expect(String(url)).not.toContain(key)
    expect(options?.method).toBe('GET')
    expect(options?.body).toBeUndefined()
    expect(options?.redirect).toBe('error')
    expect(options?.signal).toBeInstanceOf(AbortSignal)
    if (protocol === 'anthropic') {
      expect(options?.headers).toHaveProperty('x-api-key', key)
      expect(options?.headers).toHaveProperty('anthropic-version', '2023-06-01')
      expect(parsed.searchParams.get('limit')).toBe('100')
    } else if (protocol === 'gemini') {
      expect(options?.headers).toHaveProperty('x-goog-api-key', key)
      expect(parsed.searchParams.get('pageSize')).toBe('100')
    } else {
      expect(options?.headers).toHaveProperty('Authorization', `Bearer ${key}`)
      expect(parsed.search).toBe('')
    }
  })

  it.each([false, true])(
    'probes the selected model with fixed bounded input; limited=%s',
    async (limited) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(response(envelope(protocol, 'OK', limited)))
      const result = await testModelConnection(config(protocol), key, { fetchImpl })
      expect(Object.keys(result)).toEqual(['latencyMs'])
      expect(result.latencyMs).toBeGreaterThanOrEqual(0)
      const [url, options] = fetchImpl.mock.calls[0]
      expect(options?.method).toBe('POST')
      expect(options?.redirect).toBe('error')
      const body = JSON.parse(String(options?.body))
      expect(JSON.stringify(body)).not.toContain(key)
      expect(body).not.toHaveProperty('response_format')
      expect(body).not.toHaveProperty('history')
      expect(body).not.toHaveProperty('tools')
      if (protocol === 'anthropic') {
        expect(url).toBe('https://api.vendor.com/v1/messages')
        expect(body).toEqual({
          model: 'model-test',
          max_tokens: 32,
          stream: false,
          messages: [{ role: 'user', content: 'Reply with OK.' }],
        })
      } else if (protocol === 'gemini') {
        expect(url).toBe('https://api.vendor.com/v1/models/model-test:generateContent')
        expect(body).toEqual({
          contents: [{ role: 'user', parts: [{ text: 'Reply with OK.' }] }],
          generationConfig: { maxOutputTokens: 32 },
        })
      } else if (protocol === 'openai-responses') {
        expect(url).toBe('https://api.vendor.com/v1/responses')
        expect(body).toEqual({
          model: 'model-test',
          input: 'Reply with OK.',
          max_output_tokens: 32,
          store: false,
          stream: false,
        })
      } else {
        expect(url).toBe('https://api.vendor.com/v1/chat/completions')
        expect(body).toEqual({
          model: 'model-test',
          messages: [{ role: 'user', content: 'Reply with OK.' }],
          max_tokens: 32,
          stream: false,
        })
      }
    },
  )

  it('rejects malformed, empty and credential-echo responses without exposing provider text', async () => {
    for (const body of [
      {},
      { error: { message: key } },
      envelope(protocol, ''),
      envelope(protocol, key),
    ]) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(body))
      await expect(testModelConnection(config(protocol), key, { fetchImpl })).rejects.toMatchObject(
        { code: 'invalid_response' },
      )
    }
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      response(
        protocol === 'gemini'
          ? {
              models: [{ name: `models/${key}`, supportedGenerationMethods: ['generateContent'] }],
            }
          : { data: [{ id: key }] },
      ),
    )
    const error = await listRemoteModels(config(protocol), key, { fetchImpl }).catch(
      (error: unknown) => error,
    )
    expect(error).toBeInstanceOf(ModelDiagnosticError)
    expect(String(error)).not.toContain(key)
  })

  it('rejects refusals or tool-only completion envelopes', async () => {
    const body =
      protocol === 'anthropic'
        ? { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't' }] }
        : protocol === 'gemini'
          ? { promptFeedback: { blockReason: 'SAFETY' }, candidates: [] }
          : protocol === 'openai-responses'
            ? { status: 'completed', output: [{ type: 'function_call' }] }
            : { choices: [{ finish_reason: 'content_filter', message: { content: null } }] }
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(body))
    await expect(testModelConnection(config(protocol), key, { fetchImpl })).rejects.toMatchObject({
      code: 'invalid_response',
    })
  })
})

it('uses runtime-compatible Chat parameters against a strict endpoint and never retries unsupported requests', async () => {
  const allowed = new Set(['model', 'messages', 'max_tokens', 'stream'])
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
    const body = JSON.parse(String(options?.body))
    if (Object.keys(body).some((field) => !allowed.has(field)) || body.max_tokens !== 32)
      return new Response('{"error":{"code":"unsupported_parameter"}}', { status: 400 })
    return response(envelope('openai-chat'))
  })
  await expect(testModelConnection(config(), key, { fetchImpl })).resolves.toHaveProperty(
    'latencyMs',
  )
  expect(fetchImpl).toHaveBeenCalledOnce()
  const rejected = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response('{"error":{"code":"unsupported_parameter"}}', { status: 400 }))
  await expect(testModelConnection(config(), key, { fetchImpl: rejected })).rejects.toMatchObject({
    code: 'model',
  })
  expect(rejected).toHaveBeenCalledOnce()
})

it('follows Gemini cursor pages, filters methods and deduplicates model IDs', async () => {
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      response({
        models: [{ name: 'models/a', supportedGenerationMethods: ['generateContent'] }],
        nextPageToken: 'opaque+/token=',
      }),
    )
    .mockResolvedValueOnce(
      response({
        models: [
          { name: 'models/a', supportedGenerationMethods: ['generateContent'] },
          {
            name: 'models/b',
            displayName: 'B',
            supportedGenerationMethods: ['generateContent', 'countTokens'],
          },
        ],
      }),
    )
  expect(await listRemoteModels(config('gemini'), key, { fetchImpl })).toEqual([
    { id: 'a' },
    { id: 'b', name: 'B' },
  ])
  const next = new URL(String(fetchImpl.mock.calls[1][0]))
  expect(next.origin).toBe('https://api.vendor.com')
  expect(next.searchParams.get('pageToken')).toBe('opaque+/token=')
})

it('follows Anthropic after_id pages', async () => {
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(response({ data: [{ id: 'a' }], has_more: true, last_id: 'a' }))
    .mockResolvedValueOnce(
      response({ data: [{ id: 'b', display_name: 'B' }], has_more: false, last_id: 'b' }),
    )
  expect(await listRemoteModels(config('anthropic'), key, { fetchImpl })).toEqual([
    { id: 'a' },
    { id: 'b', name: 'B' },
  ])
  expect(new URL(String(fetchImpl.mock.calls[1][0])).searchParams.get('after_id')).toBe('a')
})

it('reports incomplete lists instead of silently truncating at page, count or unknown pagination limits', async () => {
  for (const kind of ['pages', 'count', 'repeat', 'unsupported']) {
    let page = 0
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
      page++
      return response({
        data:
          kind === 'count'
            ? Array.from({ length: 501 }, (_, index) => ({ id: `model-${index}` }))
            : [{ id: `page-${page}` }],
        has_more: kind !== 'count',
        last_id: kind === 'repeat' ? 'same-cursor' : `page-${page}`,
      })
    })
    await expect(
      listRemoteModels(config(kind === 'unsupported' ? 'openai-chat' : 'anthropic'), key, {
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: 'incomplete_list' })
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(5)
  }
})

it('rejects invalid pagination, names and model IDs; permits a valid empty list', async () => {
  for (const body of [
    { data: [{ id: 'valid' }], has_more: true },
    { data: [{ id: 'bad id' }] },
    { data: [{ id: 'valid', display_name: 'bad\nname' }] },
    { data: 'not-an-array' },
  ]) {
    await expect(
      listRemoteModels(config('anthropic'), key, {
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response(body)),
      }),
    ).rejects.toMatchObject({ code: 'invalid_response' })
  }
  expect(
    await listRemoteModels(config(), key, {
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response({ data: [] })),
    }),
  ).toEqual([])
})

it('returns an exactly bounded complete list and blocks JSON-escaped credential echoes', async () => {
  const data = Array.from({ length: 500 }, (_, index) => ({ id: `model-${index}` }))
  await expect(
    listRemoteModels(config(), key, {
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response({ data })),
    }),
  ).resolves.toHaveLength(500)
  const escapedKey = 'synthetic-"key"-never-real'
  await expect(
    listRemoteModels(config(), escapedKey, {
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValue(response({ data: [{ id: 'valid', display_name: escapedKey }] })),
    }),
  ).rejects.toMatchObject({ code: 'invalid_response' })
})

it.each([
  [401, 'auth'],
  [403, 'auth'],
  [404, 'not_found'],
  [400, 'model'],
  [422, 'model'],
  [429, 'rate_limit'],
  [500, 'network'],
  [302, 'network'],
])(
  'maps HTTP %s to a fixed %s error without reading or echoing provider details',
  async (status, code) => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel })
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(body, { status: Number(status) }))
    await expect(testModelConnection(config(), key, { fetchImpl })).rejects.toMatchObject({ code })
    expect(cancel).toHaveBeenCalledOnce()
  },
)

it('maps thrown provider/network errors without echoing secrets and rejects redirect responses', async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error(`Cannot connect with ${key}`))
  const error = await testModelConnection(config(), key, { fetchImpl }).catch(
    (error: unknown) => error,
  )
  expect(error).toMatchObject({ code: 'network' })
  expect(String(error)).not.toContain(key)
  const redirected = response(envelope('openai-chat'))
  Object.defineProperty(redirected, 'redirected', { value: true })
  await expect(
    testModelConnection(config(), key, {
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(redirected),
    }),
  ).rejects.toMatchObject({ code: 'network' })
})

it.each([listRemoteModels, testModelConnection])(
  'validates endpoints and credentials before performing diagnostics',
  async (operation) => {
    const fetchImpl = vi.fn<typeof fetch>()
    for (const baseUrl of [
      'http://api.vendor.com',
      'https://127.0.0.1',
      'https://api.local',
      'https://user:pass@api.vendor.com',
      'https://api.vendor.com?key=secret',
    ]) {
      await expect(operation({ ...config(), baseUrl }, key, { fetchImpl })).rejects.toMatchObject({
        code: 'invalid_config',
      })
    }
    for (const invalid of ['', 'key\r\nHeader: injection', 'x'.repeat(4097)])
      await expect(operation(config(), invalid, { fetchImpl })).rejects.toMatchObject({
        code: 'auth',
      })
    expect(fetchImpl).not.toHaveBeenCalled()
  },
)

it('requires a model for generation, while model listing accepts an unselected model', async () => {
  const fetchImpl = vi.fn<typeof fetch>()
  await expect(
    testModelConnection({ ...config(), model: '' }, key, { fetchImpl }),
  ).rejects.toMatchObject({ code: 'invalid_config' })
  expect(fetchImpl).not.toHaveBeenCalled()
})

it.each([listRemoteModels, testModelConnection])(
  'bounds both fetch and stalled body using one deadline',
  async (operation) => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}))
    await expect(operation(config(), key, { fetchImpl, timeoutMs: 5 })).rejects.toMatchObject({
      code: 'timeout',
    })
    expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true)
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'))
      },
      cancel,
    })
    await expect(
      operation(config(), key, {
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(body)),
        timeoutMs: 5,
      }),
    ).rejects.toMatchObject({ code: 'timeout' })
    expect(cancel).toHaveBeenCalledOnce()
  },
)

it.each([listRemoteModels, testModelConnection])(
  'honors cancellation before and during requests',
  async (operation) => {
    const before = new AbortController()
    before.abort()
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}))
    await expect(
      operation(config(), key, { fetchImpl, signal: before.signal }),
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(fetchImpl).not.toHaveBeenCalled()
    const during = new AbortController()
    const pending = operation(config(), key, { fetchImpl, signal: during.signal })
    const assertion = expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    during.abort()
    await assertion
    expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true)
  },
)

it('bounds response bytes, rejects invalid JSON/UTF-8 and treats empty HTTP success as invalid', async () => {
  for (const item of [
    new Response('x'.repeat(262145)),
    new Response('{}', { headers: { 'content-length': '262145' } }),
    new Response('<html>an error page</html>'),
    new Response(new Uint8Array([0xff, 0xfe])),
    new Response(null, { status: 204 }),
  ]) {
    await expect(
      listRemoteModels(config(), key, { fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(item) }),
    ).rejects.toMatchObject({ code: 'invalid_response' })
  }
})

it('accepts bounded reasoning-token output on a token-limited probe without visible text', async () => {
  for (const [protocol, body] of [
    [
      'gemini',
      { candidates: [{ finishReason: 'MAX_TOKENS' }], usageMetadata: { thoughtsTokenCount: 32 } },
    ],
    [
      'openai-responses',
      {
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [],
        usage: { output_tokens: 32 },
      },
    ],
    [
      'openai-chat',
      {
        choices: [{ finish_reason: 'length', message: { content: null } }],
        usage: { completion_tokens: 32 },
      },
    ],
  ] as const) {
    await expect(
      testModelConnection(config(protocol), key, {
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response(body)),
      }),
    ).resolves.toHaveProperty('latencyMs')
  }
})

it('rejects incomplete or empty responses without positive output-token evidence', async () => {
  for (const body of [
    { status: 'incomplete', output: [], usage: { output_tokens: 32 } },
    {
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [],
      usage: { output_tokens: 0 },
    },
    {
      status: 'incomplete',
      incomplete_details: { reason: 'content_filter' },
      output: [],
      usage: { output_tokens: 32 },
    },
  ]) {
    await expect(
      testModelConnection(config('openai-responses'), key, {
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response(body)),
      }),
    ).rejects.toMatchObject({ code: 'invalid_response' })
  }
})

it('uses HTTPS GET without a body and retains DNS checks in the production transport', async () => {
  const end = vi.fn()
  let actualOptions: any
  vi.mocked(request).mockImplementation(((
    _url: unknown,
    options: unknown,
    callback: (response: unknown) => void,
  ) => {
    actualOptions = options
    const req = new EventEmitter() as EventEmitter & { end: typeof end }
    req.end = end.mockImplementation(() => {
      const incoming = Object.assign(Readable.from([Buffer.from('{"data":[]}')]), {
        statusCode: 200,
        headers: {},
      })
      callback(incoming)
    })
    return req
  }) as unknown as typeof request)
  const result = await secureFetch('https://api.vendor.com/v1/models', {
    method: 'GET',
    body: 'must-not-send',
  })
  expect(await result.json()).toEqual({ data: [] })
  expect(actualOptions.method).toBe('GET')
  expect(end).toHaveBeenCalledWith(undefined)
  const callback = vi.fn()
  vi.mocked(lookup).mockImplementation(((_host: string, _options: unknown, done: Function) =>
    done(null, [{ address: '127.0.0.1', family: 4 }])) as typeof lookup)
  actualOptions.lookup('api.vendor.com', { all: true }, callback)
  expect(callback).toHaveBeenCalledWith(expect.any(Error), [], undefined)
  vi.mocked(lookup).mockImplementation(((_host: string, _options: unknown, done: Function) =>
    done(null, [{ address: '8.8.8.8', family: 4 }])) as typeof lookup)
  actualOptions.lookup('api.vendor.com', { all: true }, callback)
  expect(callback).toHaveBeenLastCalledWith(null, [{ address: '8.8.8.8', family: 4 }])
})
