import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelService } from '../src/adapters/model-service'
import { generationRequestSchema } from '../src/adapters/question-generator'
import type { ModelNetworkConfig } from '../src/shared/model-network'
import type { ModelConfig, ModelDiagnosticInput } from '../src/shared/types'

const mocked = vi.hoisted(() => ({
  createModelFetch: vi.fn(),
  fetch: vi.fn<typeof fetch>(),
}))
vi.mock('../src/adapters/model-network-transport', () => ({
  createModelFetch: mocked.createModelFetch,
}))
// A routing regression must fail locally, never fall through to a real provider.
vi.mock('node:https', () => ({
  request: vi.fn(() => {
    throw new Error('Unexpected real HTTPS request in a synthetic routing test')
  }),
}))
vi.mock('node:dns', () => ({
  lookup: vi.fn(() => {
    throw new Error('Unexpected real DNS request in a synthetic routing test')
  }),
}))

const key = 'synthetic-routing-key-never-real'
const destination = {
  protocol: 'openai-chat' as const,
  baseUrl: 'https://api.example.com/v1',
  model: 'synthetic-model',
}
const routes: ModelNetworkConfig[] = [
  { mode: 'direct' },
  { mode: 'system' },
  { mode: 'local', proxyUrl: 'http://127.0.0.1:17890' },
]
const generated = {
  title: 'Synthetic geography routing test',
  prompt: 'Which direction is A from B? Use the diagram.',
  maxScore: 1,
  explanation: 'A is east of B.',
  rubric: [{ label: 'Direction', keywords: ['east'], points: 1 }],
  figure: {
    version: 1,
    kind: 'schematic',
    title: 'Two points',
    description: 'Right is east.',
    points: [
      { id: 'a', x: 20, y: 0, label: 'A' },
      { id: 'b', x: -20, y: 0, label: 'B' },
    ],
    segments: [],
    arrows: [],
    polylines: [],
    polygons: [],
    labels: [],
  },
}
const tools = [
  {
    name: 'read_question',
    description: 'Read the selected synthetic question.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]
function envelope(content: string) {
  return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] }
}
function response(value: unknown) {
  return new Response(JSON.stringify(value))
}
function streamedResponse(value: unknown) {
  const text = JSON.stringify(value)
  return new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()
        controller.enqueue(encoder.encode(text.slice(0, 17)))
        controller.enqueue(encoder.encode(text.slice(17)))
        controller.close()
      },
    }),
  )
}
const directories: string[] = []
async function setup(network?: ModelNetworkConfig) {
  const directory = await mkdtemp(join(tmpdir(), 'examcraft-network-routing-'))
  directories.push(directory)
  const resolveSystemProxy = vi.fn(async () => 'PROXY 127.0.0.1:17890')
  const models = new ModelService(directory, {
    resolveSystemProxy,
    timeoutMs: 1000,
    listQuestions: async () => [],
    persistGenerated: async () => undefined,
  })
  const config = await models.saveConfig({
    ...destination,
    apiKey: key,
    ...(network ? { network } : {}),
  })
  return { models, config, resolveSystemProxy }
}
function diagnostic(config: ModelConfig, kind: 'list' | 'test'): ModelDiagnosticInput {
  return {
    ...destination,
    profileId: config.profileId,
    expectedRevision: config.revision,
    requestId: `routing-${kind}`,
    kind,
    ...(config.network ? { network: config.network } : {}),
  }
}
function generation(config: ModelConfig) {
  return {
    requestId: 'routing-generation',
    syllabus: 'Synthetic syllabus',
    chapter: 'Position',
    difficulty: generationRequestSchema.shape.difficulty.options[0],
    cloudConsent: true,
    configRevision: config.revision,
  }
}
beforeEach(() => {
  mocked.createModelFetch.mockReset().mockReturnValue(mocked.fetch)
  mocked.fetch.mockReset().mockImplementation(async () => {
    throw new Error('Unexpected synthetic model request')
  })
})
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('model network selection across service entry points', () => {
  it.each(routes)(
    'uses the saved $mode route for model list, connection test, JSON generation and native tools',
    async (network) => {
      const { models, config, resolveSystemProxy } = await setup(network)
      mocked.fetch
        .mockResolvedValueOnce(response({ data: [{ id: destination.model }] }))
        .mockResolvedValueOnce(response(envelope('OK')))
        .mockResolvedValueOnce(response(envelope(JSON.stringify(generated))))
        .mockResolvedValueOnce(streamedResponse(envelope('Finished synthetic tool turn.')))
        .mockResolvedValueOnce(response(envelope(JSON.stringify({ result: 'ok' }))))

      expect(await models.diagnoseModel(diagnostic(config, 'list'))).toEqual({
        models: [{ id: destination.model }],
      })
      expect(await models.diagnoseModel(diagnostic(config, 'test'))).toEqual({
        latencyMs: expect.any(Number),
      })
      expect(await models.generateGeographyQuestion(generation(config))).toMatchObject({
        question: { title: generated.title },
      })
      const native = await models.agentTransport(config.revision)
      expect(await native.transport.start('Synthetic system', {}, tools)).toMatchObject({
        kind: 'final',
        text: 'Finished synthetic tool turn.',
      })
      expect(
        await models.agentJson(
          'parent',
          config.revision,
          'Synthetic system',
          {},
          new AbortController().signal,
        ),
      ).toEqual({ result: 'ok' })

      expect(mocked.createModelFetch).toHaveBeenCalledTimes(5)
      for (const args of mocked.createModelFetch.mock.calls)
        expect(args).toEqual([network, resolveSystemProxy])
      expect(mocked.fetch).toHaveBeenCalledTimes(5)
      expect(String(mocked.fetch.mock.calls[0][0])).toBe(`${destination.baseUrl}/models`)
      for (const [url, init] of mocked.fetch.mock.calls) {
        expect(String(url)).not.toContain(key)
        expect(init?.body ?? '').not.toContain(key)
        expect(init?.redirect).toBe('error')
        expect(init?.signal).toBeInstanceOf(AbortSignal)
      }
      // Native tool transport consumes a bounded streamed JSON body, not token SSE.
      expect(JSON.parse(String(mocked.fetch.mock.calls[3][1]?.body)).stream).toBe(false)
    },
  )

  it.each(['list', 'test'] as const)(
    'uses an unsaved diagnostic route for %s without changing the saved generation route',
    async (kind) => {
      const saved: ModelNetworkConfig = { mode: 'system' }
      const draft: ModelNetworkConfig = { mode: 'local', proxyUrl: 'http://[::1]:17890' }
      const { models, config, resolveSystemProxy } = await setup(saved)
      mocked.fetch
        .mockResolvedValueOnce(
          response(kind === 'list' ? { data: [{ id: destination.model }] } : envelope('OK')),
        )
        .mockResolvedValueOnce(response(envelope(JSON.stringify({ result: 'saved-route' }))))
      expect(
        await models.diagnoseModel({ ...diagnostic(config, kind), network: draft }),
      ).not.toHaveProperty('error')
      expect(await models.getConfig()).toMatchObject({ network: saved, revision: config.revision })
      await models.agentJson(
        'parent',
        config.revision,
        'Synthetic system',
        {},
        new AbortController().signal,
      )
      expect(mocked.createModelFetch.mock.calls).toEqual([
        [draft, resolveSystemProxy],
        [saved, resolveSystemProxy],
      ])
    },
  )

  it('keeps profiles without a network selection on the direct route', async () => {
    const { models, config, resolveSystemProxy } = await setup()
    mocked.fetch.mockResolvedValueOnce(response(envelope(JSON.stringify({ result: 'legacy' }))))
    await models.agentJson(
      'parent',
      config.revision,
      'Synthetic system',
      {},
      new AbortController().signal,
    )
    const [network, resolver] = mocked.createModelFetch.mock.calls[0]
    expect(network ?? { mode: 'direct' }).toEqual({ mode: 'direct' })
    expect(resolver).toBe(resolveSystemProxy)
    expect(resolveSystemProxy).not.toHaveBeenCalled()
  })

  it.each(['list', 'test', 'generation', 'native'] as const)(
    'cancels in-flight %s when the saved network route changes',
    async (operation) => {
      const { models, config } = await setup({ mode: 'system' })
      let signal: AbortSignal | null | undefined
      let dispatched!: () => void
      const started = new Promise<void>((resolve) => {
        dispatched = resolve
      })
      mocked.fetch.mockImplementation(async (_url, init) => {
        signal = init?.signal
        dispatched()
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Cancelled', 'AbortError')),
            { once: true },
          )
        })
      })
      const controller = new AbortController()
      // AgentService uses this observer to cancel native tool requests on a config edit.
      const unsubscribe = models.onCancelAll(() => controller.abort())
      const native =
        operation === 'native' ? await models.agentTransport(config.revision) : undefined
      const pending =
        operation === 'generation'
          ? models.generateGeographyQuestion(generation(config))
          : operation === 'native'
            ? native!.transport.start('Synthetic system', {}, tools, controller.signal)
            : models.diagnoseModel(diagnostic(config, operation))
      const outcome = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
      await started
      await models.saveConfig({ ...destination, network: { mode: 'direct' } })
      expect(signal?.aborted).toBe(true)
      const result = await outcome
      if (operation === 'list' || operation === 'test')
        expect(result).toMatchObject({ value: { error: { code: 'cancelled' } } })
      else expect(result).toHaveProperty('error')
      expect(mocked.fetch).toHaveBeenCalledTimes(1)
      unsubscribe()
    },
  )
})
