import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelService } from '../src/adapters/model-service'
import { ModelTransport, isPublicAddress, validateBaseUrl } from '../src/adapters/model-transport'
import { emptyDraft, type ModelProtocol, type Question } from '../src/shared/types'

const key = 'synthetic-model-test-key-not-real'
const protocols: ModelProtocol[] = ['anthropic', 'gemini', 'openai-responses', 'openai-chat']
const question: Question = {
  id: 'q1',
  subject: 'history',
  kind: 'choice',
  title: 'Synthetic',
  prompt: 'Pick A',
  source: 'Synthetic fixture',
  tags: [],
  maxScore: 4,
  explanation: 'A',
  choices: [
    { id: 'A', text: 'A' },
    { id: 'B', text: 'B' },
  ],
  correctAnswer: 'A',
}
function envelope(protocol: ModelProtocol, value: unknown) {
  const text = JSON.stringify(value)
  switch (protocol) {
    case 'anthropic':
      return { stop_reason: 'end_turn', content: [{ type: 'text', text }] }
    case 'gemini':
      return { candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] }
    case 'openai-responses':
      return {
        status: 'completed',
        output: [
          { type: 'message', status: 'completed', content: [{ type: 'output_text', text }] },
        ],
      }
    default:
      return { choices: [{ finish_reason: 'stop', message: { content: text } }] }
  }
}
const response = (body: unknown) => new Response(JSON.stringify(body))
const directories: string[] = []
async function service(fetchImpl: typeof fetch, timeoutMs?: number) {
  const directory = await mkdtemp(join(tmpdir(), 'models-'))
  directories.push(directory)
  return {
    directory,
    models: new ModelService(directory, {
      fetchImpl,
      timeoutMs,
      resolveQuestion: (id) => (id === question.id ? question : undefined),
    }),
  }
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})
describe.each(protocols)('%s mock-only protocol', (protocol) => {
  it('reviews with bounded validated scoring and sends only allowlisted data', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response(envelope(protocol, { feedback: 'Hint', explanation: 'Reason', rubric: [] })),
      )
    const { models } = await service(fetcher)
    const config = await models.saveConfig({
      protocol,
      baseUrl: 'https://api.vendor.com/v1',
      model: 'model-test',
      apiKey: key,
    })
    const agent = await models.reviewer(config.revision)
    const result = await agent.review(question, {
      ...emptyDraft(),
      choiceId: 'A',
      text: 'Synthetic',
    })
    expect(result.score).toBe(4)
    const [url, options] = fetcher.mock.calls[0]
    expect(options?.redirect).toBe('error')
    expect(String(url)).not.toContain(key)
    const body = JSON.parse(String(options?.body))
    expect(JSON.stringify(body)).not.toContain(key)
    expect(JSON.stringify(body)).not.toContain('attempts')
    if (protocol === 'anthropic') {
      expect(url).toBe('https://api.vendor.com/v1/messages')
      expect(body.system).toContain('不可信')
      expect(options?.headers).toHaveProperty('x-api-key', key)
    }
    if (protocol === 'gemini') {
      expect(url).toBe('https://api.vendor.com/v1/models/model-test:generateContent')
      expect(options?.headers).toHaveProperty('x-goog-api-key', key)
    }
    if (protocol === 'openai-responses') {
      expect(body.store).toBe(false)
      expect(body.input).toContain('Synthetic')
    }
    if (protocol === 'openai-chat') expect(body.messages).toHaveLength(2)
  })
  it('advises only the selected excerpt and explicit optional context; keys never persisted', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response(envelope(protocol, { hint: 'What evidence supports this step?' })),
      )
    const { models, directory } = await service(fetcher)
    const config = await models.saveConfig({
      protocol,
      baseUrl: 'https://api.vendor.com/v1',
      model: 'model-test',
      apiKey: key,
    })
    expect(JSON.stringify(config)).not.toContain(key)
    expect(await readFile(join(directory, 'model-config.json'), 'utf8')).not.toContain(key)
    const result = await models.askAdvisor({
      requestId: 'r1',
      source: 'answer',
      selectedText: 'My selected line',
      questionId: question.id,
      includeReference: false,
      cloudConsent: true,
      configRevision: config.revision,
    })
    expect(result.requestId).toBe('r1')
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body))
    const data = JSON.parse(
      protocol === 'anthropic' || protocol === 'openai-chat'
        ? body.messages.at(-1).content
        : protocol === 'gemini'
          ? body.contents[0].parts[0].text
          : body.input,
    )
    expect(data).toEqual({
      selectedText: 'My selected line',
      source: 'answer',
      question: { subject: question.subject, prompt: question.prompt, choices: question.choices },
    })
    expect(JSON.stringify(body)).toContain('不提供完整答案')
  })
  it('includes trusted reference only with an explicit opt-in, never renderer context', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => response(envelope(protocol, { hint: 'A local hint' })))
    const { models } = await service(fetcher)
    const config = await models.saveConfig({
      protocol,
      baseUrl: 'https://api.vendor.com',
      model: 'test',
      apiKey: key,
    })
    for (const includeReference of [false, true]) {
      await models.askAdvisor({
        requestId: 'opt-in',
        questionId: question.id,
        includeReference,
        selectedText: 'Only this excerpt',
        source: 'answer',
        cloudConsent: true,
        configRevision: config.revision,
      })
      const body = JSON.parse(String(fetcher.mock.calls.at(-1)![1]?.body))
      const data = JSON.parse(
        protocol === 'gemini'
          ? body.contents[0].parts[0].text
          : protocol === 'openai-responses'
            ? body.input
            : body.messages.at(-1).content,
      )
      expect(data.question.reference).toBe(includeReference ? question.explanation : undefined)
      expect(data.question.correctAnswer).toBe(
        includeReference ? question.correctAnswer : undefined,
      )
      expect(Object.keys(data)).toEqual(['selectedText', 'source', 'question'])
    }
    const valid = {
      requestId: 'invalid',
      questionId: question.id,
      includeReference: false,
      selectedText: 'Excerpt',
      source: 'answer',
      cloudConsent: true,
      configRevision: config.revision,
    }
    for (const input of [
      { ...valid, questionId: undefined },
      { ...valid, questionId: 'missing' },
      { ...valid, includeReference: undefined },
      { ...valid, questionContext: 'forged' },
    ]) {
      await expect(models.askAdvisor(input as any)).rejects.toThrow()
    }
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('rejects malformed, blocked, tool-only and credential-echo replies', async () => {
    for (const value of [
      {},
      { error: { message: key } },
      protocol === 'anthropic'
        ? { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't' }] }
        : protocol === 'gemini'
          ? { promptFeedback: { blockReason: 'SAFETY' }, candidates: [] }
          : protocol === 'openai-responses'
            ? { status: 'completed', output: [{ type: 'function_call' }] }
            : {
                choices: [
                  { finish_reason: 'tool_calls', message: { content: '{}', tool_calls: [{}] } },
                ],
              },
      envelope(protocol, { hint: key }),
    ]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(value))
      const transport = new ModelTransport(
        { protocol, baseUrl: 'https://api.vendor.com', model: 'test' },
        key,
        fetcher,
      )
      await expect(transport.json('system', {})).rejects.toThrow(/模型/)
    }
  })
  it('bounds never-resolving requests, HTTP errors and oversized bodies', async () => {
    for (const fetcher of [
      vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {})),
      vi.fn<typeof fetch>().mockResolvedValue(new Response(key, { status: 401 })),
      vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(262145))),
    ]) {
      const transport = new ModelTransport(
        { protocol, baseUrl: 'https://api.vendor.com', model: 'test' },
        key,
        fetcher,
        10,
      )
      await expect(transport.json('system', {})).rejects.toThrow(/模型/)
    }
  })
})
it('binds consent to revision; requires explicit consent; cancels matching IDs', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}))
  const { models } = await service(fetcher)
  const config = await models.saveConfig({
    protocol: 'openai-chat',
    baseUrl: 'https://api.vendor.com/v1',
    model: 'test',
    apiKey: key,
  })
  const request = {
    requestId: 'req',
    questionId: question.id,
    includeReference: false,
    source: 'answer' as const,
    selectedText: 'Text',
    cloudConsent: true,
    configRevision: config.revision,
  }
  await expect(models.askAdvisor({ ...request, cloudConsent: false })).rejects.toThrow()
  await models.saveConfig({ ...config, model: 'next' } as never).catch(() => {}) // unknown revision/configured keys rejected
  const next = await models.saveConfig({
    protocol: config.protocol,
    baseUrl: config.baseUrl,
    model: 'next',
  })
  await expect(models.askAdvisor(request)).rejects.toThrow(/更改/)
  const pending = models.askAdvisor({ ...request, configRevision: next.revision })
  const assertion = expect(pending).rejects.toThrow(/取消/)
  models.cancelAdvisor('req')
  await assertion
  expect(fetcher).not.toHaveBeenCalled()
  expect(
    (
      await models.saveConfig({
        protocol: config.protocol,
        baseUrl: 'https://other.vendor.com/v1',
        model: 'next',
      })
    ).configured,
  ).toBe(false)
})
it('rejects unsafe endpoints and private or special-use resolved addresses', () => {
  for (const url of [
    'http://api.vendor.com',
    'https://user:pass@api.vendor.com',
    'https://api.vendor.com?key=x',
    'https://localhost',
    'https://127.0.0.1',
    'https://169.254.169.254',
    'https://[::1]',
    'https://api.local',
    'https://metadata.google.internal',
    'https://api.vendor.com/#x',
  ])
    expect(() => validateBaseUrl(url)).toThrow()
  for (const address of [
    '127.0.0.1',
    '10.1.1.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '::1',
    '::ffff:127.0.0.1',
    'fd00::1',
    '2001:db8::1',
  ])
    expect(isPublicAddress(address)).toBe(false)
  expect(isPublicAddress('8.8.8.8')).toBe(true)
  expect(validateBaseUrl('https://my.public-provider.com/v1/')).toBe(
    'https://my.public-provider.com/v1',
  )
})

it('cancels an already-started advisor and bounds a stalled response body', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}))
  const { models } = await service(fetcher)
  const config = await models.saveConfig({
    protocol: 'openai-chat',
    baseUrl: 'https://api.vendor.com',
    model: 'test',
    apiKey: key,
  })
  const pending = models.askAdvisor({
    requestId: 'started',
    questionId: question.id,
    includeReference: false,
    selectedText: 'A line',
    source: 'answer',
    cloudConsent: true,
    configRevision: config.revision,
  })
  const assertion = expect(pending).rejects.toThrow(/取消/)
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
  models.cancelAdvisor('other')
  models.cancelAdvisor('started')
  await assertion
  expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
  const stalled = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{'))
    },
  })
  const transport = new ModelTransport(
    { protocol: 'openai-chat', baseUrl: 'https://api.vendor.com', model: 'test' },
    key,
    vi.fn<typeof fetch>().mockResolvedValue(new Response(stalled)),
    10,
  )
  await expect(transport.json('system', {})).rejects.toThrow(/超时/)
})

it.each(protocols)(
  '%s rejects out-of-range review scoring without accepting model-authored totals',
  async (protocol) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response(
        envelope(protocol, {
          feedback: 'Test',
          explanation: 'Test',
          rubric: [{ id: 'rubric', earned: 99, feedback: 'Test' }],
          score: 99,
        }),
      ),
    )
    const { models } = await service(fetcher)
    const config = await models.saveConfig({
      protocol,
      baseUrl: 'https://api.vendor.com',
      model: 'test',
      apiKey: key,
    })
    const agent = await models.reviewer(config.revision)
    await expect(
      agent.review(
        {
          ...question,
          kind: 'history',
          choices: undefined,
          correctAnswer: undefined,
          rubric: [{ id: 'rubric', label: 'Reason', keywords: ['reason'], points: 4 }],
        },
        { ...emptyDraft(), text: 'Some reasoning' },
      ),
    ).rejects.toThrow(/评阅失败/)
  },
)
