import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelService } from '../src/adapters/model-service'
import type { ModelProtocol, Question } from '../src/shared/types'
const protocols: ModelProtocol[] = ['anthropic', 'gemini', 'openai-responses', 'openai-chat']
const figure = {
  version: 1,
  kind: 'schematic',
  title: '河流',
  description: '非真实地图',
  points: [
    { id: 'a', x: 0, y: 0 },
    { id: 'b', x: 20, y: 20 },
  ],
  segments: [],
  arrows: [{ id: 'flow', from: 'a', to: 'b' }],
  polylines: [],
  polygons: [],
  labels: [],
}
const valid = {
  title: '地理示例',
  prompt: '解释河流流向及依据。',
  figure,
  maxScore: 4,
  explanation: '私有解析',
  rubric: [{ label: '依据', keywords: ['地势'], points: 4 }],
}
function envelope(protocol: ModelProtocol, data: unknown) {
  const text = JSON.stringify(data)
  if (protocol === 'anthropic')
    return { stop_reason: 'end_turn', content: [{ type: 'text', text }] }
  if (protocol === 'gemini')
    return { candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] }
  if (protocol === 'openai-responses')
    return {
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
    }
  return { choices: [{ finish_reason: 'stop', message: { content: text } }] }
}
const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})
async function setup(
  protocol: ModelProtocol = 'openai-chat',
  output: unknown = valid,
  override?: typeof fetch,
) {
  const directory = await mkdtemp(join(tmpdir(), 'generation-'))
  directories.push(directory)
  const bank: Question[] = []
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(
      override ?? (async () => new Response(JSON.stringify(envelope(protocol, output)))),
    )
  const persist = vi.fn(async (q: Question) => {
    bank.push(q)
  })
  const models = new ModelService(directory, {
    fetchImpl: fetcher,
    timeoutMs: 100,
    listQuestions: async () => bank,
    persistGenerated: persist,
  })
  const config = await models.saveConfig({
    protocol,
    baseUrl: 'https://api.vendor.com',
    model: 'mock-model',
    apiKey: 'synthetic-not-a-real-key',
  })
  const request = {
    requestId: 'generate-1',
    syllabus: '普通高中地理',
    chapter: '河流',
    difficulty: '基础' as const,
    cloudConsent: true,
    configRevision: config.revision,
  }
  return { models, fetcher, persist, bank, request, config }
}
describe.each(protocols)('%s generation mock only', (protocol) => {
  it('sends bounded topic only and previews without reference before explicit acceptance', async () => {
    const { models, fetcher, persist, bank, request } = await setup(protocol)
    const result = await models.generateGeographyQuestion(request)
    expect(result.question).not.toHaveProperty('explanation')
    expect(result.question).not.toHaveProperty('rubric')
    expect(result.question.figure).toEqual(figure)
    expect(result.question.provenance?.verified).toBe(false)
    expect(result.question.id).toMatch(/^geo-ai-/)
    expect(result.question.source).toContain('未经事实核验')
    expect(persist).not.toHaveBeenCalled()
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body))
    const data = JSON.parse(
      protocol === 'gemini'
        ? body.contents[0].parts[0].text
        : protocol === 'openai-responses'
          ? body.input
          : body.messages.at(-1).content,
    )
    expect(data).toEqual({
      syllabus: request.syllabus,
      chapter: request.chapter,
      difficulty: request.difficulty,
    })
    const accepted = await models.acceptGeneratedQuestion(result.token)
    expect(accepted).toEqual(result.question)
    expect(bank[0].explanation).toBe('私有解析')
    await expect(models.acceptGeneratedQuestion(result.token)).rejects.toThrow()
    await expect(models.generateGeographyQuestion(request)).rejects.toThrow(/重复/)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it.each([
    { ...valid, id: 'forged' },
    { ...valid, source: '官方真题' },
    { ...valid, provenance: { verified: true } },
    { ...valid, rubric: [{ label: 'x', keywords: ['x'], points: 3 }] },
    { ...valid, figure: { ...figure, arrows: [{ id: 'x', from: 'a', to: 'missing' }] } },
    { ...valid, figure: { ...figure, svg: '<script>evil</script>' } },
  ])('rejects malformed or forged outputs without auto retry', async (output) => {
    const { models, fetcher, persist, request } = await setup(protocol, output)
    await expect(models.generateGeographyQuestion(request)).rejects.toThrow(/格式/)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(persist).not.toHaveBeenCalled()
    expect(models.getGenerationStatus()).toEqual({ used: 1, limit: 5, pending: 0 })
  })
})
it('rejects invalid input and stale consent before dispatch', async () => {
  const { models, fetcher, request } = await setup()
  for (const change of [
    { cloudConsent: false },
    { configRevision: 0 },
    { syllabus: 'x'.repeat(501) },
    { history: [] },
    { difficulty: 'unknown' },
  ])
    await expect(
      models.generateGeographyQuestion({ ...request, ...change } as any),
    ).rejects.toThrow()
  expect(fetcher).not.toHaveBeenCalled()
})
it('bounds quota, clears discarded tokens, and does not retry', async () => {
  const { models, fetcher, request } = await setup()
  for (let i = 0; i < 5; i++) {
    const preview = await models.generateGeographyQuestion(request)
    models.rejectGeneratedQuestion(preview.token)
    await expect(models.acceptGeneratedQuestion(preview.token)).rejects.toThrow()
  }
  await expect(models.generateGeographyQuestion(request)).rejects.toThrow(/最多/)
  expect(fetcher).toHaveBeenCalledTimes(5)
})
it('bounds concurrency and cancels in-flight generation', async () => {
  const { models, fetcher, request } = await setup(
    'openai-chat',
    valid,
    () => new Promise(() => {}),
  )
  const pending = models.generateGeographyQuestion(request)
  const assertion = expect(pending).rejects.toThrow(/取消/)
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
  await expect(
    models.generateGeographyQuestion({ ...request, requestId: 'other' }),
  ).rejects.toThrow(/进行中/)
  models.cancelQuestionGeneration(request.requestId)
  await assertion
  expect(models.getGenerationStatus()).toEqual({ used: 1, limit: 5, pending: 0 })
})
it('config change aborts generation and cannot deliver stale preview', async () => {
  const { models, fetcher, request, config } = await setup(
    'openai-chat',
    valid,
    () => new Promise(() => {}),
  )
  const pending = models.generateGeographyQuestion(request)
  const assertion = expect(pending).rejects.toThrow(/取消/)
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
  await models.saveConfig({
    protocol: config.protocol,
    baseUrl: config.baseUrl,
    model: 'new-model',
  })
  await assertion
  expect(models.getGenerationStatus().pending).toBe(0)
})
it('bounds pending previews and serializes repeated accepts', async () => {
  let index = 0
  const { models, request, fetcher, persist } = await setup(
    'openai-chat',
    valid,
    async () =>
      new Response(
        JSON.stringify(envelope('openai-chat', { ...valid, prompt: `河流问题${++index}` })),
      ),
  )
  const previews = []
  for (let i = 0; i < 3; i++) previews.push(await models.generateGeographyQuestion(request))
  await expect(models.generateGeographyQuestion(request)).rejects.toThrow(/预览/)
  expect(fetcher).toHaveBeenCalledTimes(3)
  const results = await Promise.allSettled([
    models.acceptGeneratedQuestion(previews[0].token),
    models.acceptGeneratedQuestion(previews[0].token),
  ])
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  expect(persist).toHaveBeenCalledTimes(1)
  expect(models.getGenerationStatus()).toEqual({ used: 3, limit: 5, pending: 2 })
})
it('accept failure retains preview for explicit retry without another model call', async () => {
  const { models, request, persist, fetcher } = await setup()
  const preview = await models.generateGeographyQuestion(request)
  persist.mockRejectedValueOnce(new Error('Disk full'))
  await expect(models.acceptGeneratedQuestion(preview.token)).rejects.toThrow('Disk full')
  expect(models.getGenerationStatus().pending).toBe(1)
  await models.acceptGeneratedQuestion(preview.token)
  expect(fetcher).toHaveBeenCalledTimes(1)
})
it('configuration revisions invalidate unaccepted preview tokens', async () => {
  const { models, request, config } = await setup()
  const preview = await models.generateGeographyQuestion(request)
  await models.saveConfig({ protocol: config.protocol, baseUrl: config.baseUrl, model: 'changed' })
  await expect(models.acceptGeneratedQuestion(preview.token)).rejects.toThrow(/预览/)
  expect(models.getGenerationStatus().pending).toBe(0)
})
it('deferred discard releases a preview after an in-flight save failure', async () => {
  const { models, request, persist, bank } = await setup()
  const preview = await models.generateGeographyQuestion(request)
  let fail!: (reason: Error) => void
  persist.mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, reject) => {
        fail = reject
      }),
  )
  const saving = models.acceptGeneratedQuestion(preview.token)
  const assertion = expect(saving).rejects.toThrow('Disk full')
  await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1))
  models.rejectGeneratedQuestion(preview.token)
  expect(models.getGenerationStatus().pending).toBe(1)
  fail(new Error('Disk full'))
  await assertion
  expect(models.getGenerationStatus().pending).toBe(0)
  expect(bank).toHaveLength(0)
  await expect(models.acceptGeneratedQuestion(preview.token)).rejects.toThrow(/预览/)
})
it('deferred discard does not cancel an authorized in-flight successful save', async () => {
  const { models, request, persist, bank } = await setup()
  const preview = await models.generateGeographyQuestion(request)
  let finish!: () => void
  persist.mockImplementationOnce(
    (question) =>
      new Promise<void>((resolve) => {
        finish = () => {
          bank.push(question)
          resolve()
        }
      }),
  )
  const saving = models.acceptGeneratedQuestion(preview.token)
  await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1))
  models.rejectGeneratedQuestion(preview.token)
  finish()
  expect(await saving).toEqual(preview.question)
  expect(models.getGenerationStatus().pending).toBe(0)
  expect(bank).toHaveLength(1)
})
