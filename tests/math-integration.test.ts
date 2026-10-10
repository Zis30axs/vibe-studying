import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeepSeekAgent } from '../src/adapters/deepseek-agent'
import { LocalQuestionBank } from '../src/adapters/local-question-bank'
import { LocalRuleAgent } from '../src/adapters/local-rule-agent'
import { StudyService } from '../src/domain/study-service'
import { emptyDraft, type AnswerDraft, type Question } from '../src/shared/types'

const syntheticKey = 'synthetic-math-key-no-network'
const mathDraft = (): AnswerDraft => ({
  ...emptyDraft(),
  text: '根据函数分析并写出计算过程。',
  math: {
    expression: 'a*x^2+b*x+c',
    parameters: { a: 1, b: -2, c: 1 },
    drawing: {
      mode: 'cartesian',
      points: [
        { id: 'A', label: 'A', x: 0, y: 0 },
        { id: 'B', label: 'B', x: 3, y: 0 },
        { id: 'C', label: 'C', x: 3, y: 4 },
      ],
      lines: [{ id: 'AB', from: 'A', to: 'B' }],
    },
    measurement: ['A', 'B', 'C'],
  },
})
const providerResponse = (question: Question) =>
  new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              feedback: '合成评语：请解释推理。',
              explanation: '合成解析，不代表真实模型结果。',
              rubric: (question.rubric ?? []).map((item) => ({
                id: item.id,
                earned: 0,
                feedback: '需要文字依据。',
              })),
            }),
          },
        },
      ],
    }),
  )

describe('math tools service, persistence and synthetic cloud integration', () => {
  let directory: string
  let bank: LocalQuestionBank
  let question: Question
  const local = new LocalRuleAgent()
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'examcraft-math-test-'))
    bank = new LocalQuestionBank(directory)
    question = (await bank.list({ subject: 'math' })).find((item) => item.kind === 'math')!
  })
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('persists and restores function, parameters, geometry and measurement independently of snapshots', async () => {
    const service = new StudyService(directory, bank, local)
    const draft = mathDraft()
    await service.saveDraft(question.id, draft)
    const restored = new StudyService(directory, new LocalQuestionBank(directory), local)
    expect((await restored.loadState()).drafts[question.id]).toEqual(draft)
    const first = await restored.submitAnswer(question.id, draft)
    const next = mathDraft()
    next.math!.expression = 'sin(x)+a'
    next.math!.parameters.a = 2
    next.math!.drawing.points[0].x = -2
    next.math!.measurement = ['B', 'C']
    await restored.saveDraft(question.id, next)
    const second = await restored.submitAnswer(question.id, next)
    const state = await new StudyService(
      directory,
      new LocalQuestionBank(directory),
      local,
    ).loadState()
    expect(state.version).toBe(1)
    expect(state.drafts[question.id]).toEqual(next)
    expect(state.attempts.map((attempt) => attempt.draft)).toEqual([draft, next])
    expect(first.id).not.toBe(second.id)
    expect(state.attempts[0].draft.math!.measurement).toEqual(['A', 'B', 'C'])
  })

  it('loads pre-workbench version-1 drafts and attempts without migration or manufactured math state', async () => {
    const draft: AnswerDraft = {
      text: '旧版文字作答',
      blocks: [],
      drawing: { mode: 'cartesian', points: [], lines: [] },
    }
    const review = await local.review(question, draft)
    const legacy = {
      version: 1,
      drafts: { [question.id]: draft },
      attempts: [
        {
          ...review,
          id: 'legacy-attempt',
          questionId: question.id,
          submittedAt: '2026-01-01T00:00:00.000Z',
          draft,
        },
      ],
    }
    await writeFile(join(directory, 'study-state.json'), JSON.stringify(legacy))
    const service = new StudyService(directory, bank, local)
    expect(await service.loadState()).toEqual(legacy)
    await service.saveDraft(question.id, mathDraft())
    const state = await new StudyService(directory, bank, local).loadState()
    expect(state.attempts[0].draft).toEqual(draft)
    expect(state.attempts[0].draft.math).toBeUndefined()
    expect(state.drafts[question.id].math).toEqual(mathDraft().math)
  })

  it('requires consent before HTTP, sends only current structured math and saves its reviewed snapshot', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(providerResponse(question))
    const cloud = new DeepSeekAgent({ apiKey: syntheticKey, fetchImpl: fetcher })
    const service = new StudyService(directory, bank, local, cloud)
    const draft = mathDraft()
    await service.submitAnswer(question.id, { ...emptyDraft(), text: 'PRIVATE PRIOR ATTEMPT' })
    await expect(
      service.submitAnswer(question.id, draft, { provider: 'deepseek' }),
    ).rejects.toThrow('确认')
    expect(fetcher).not.toHaveBeenCalled()
    await service.submitAnswer(question.id, draft, { provider: 'deepseek', cloudConsent: true })
    expect(fetcher).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetcher.mock.calls[0][1]!.body as string)
    const payload = JSON.parse(body.messages[1].content)
    expect(payload.answer.math).toEqual(draft.math)
    expect(Object.keys(payload.answer.math).sort()).toEqual([
      'drawing',
      'expression',
      'measurement',
      'parameters',
    ])
    expect(body.messages[0].content).toContain('参数')
    expect(body.messages[0].content).toContain('测量')
    expect(JSON.stringify(body)).not.toContain('PRIVATE PRIOR ATTEMPT')
    expect(JSON.stringify(body)).not.toContain(syntheticKey)
    expect(JSON.stringify(cloud)).not.toContain(syntheticKey)
    const persisted = await readFile(join(directory, 'study-state.json'), 'utf8')
    expect(persisted).not.toContain(syntheticKey)
    const state = await new StudyService(directory, bank, local).loadState()
    expect(state.attempts[1].draft.math).toEqual(draft.math)
    expect(state.attempts[1].reviewer).toContain('DeepSeek')
  })

  it('never adds math state to a non-math cloud request', async () => {
    const other = (await bank.list({ subject: 'history' })).find((item) => item.kind === 'history')!
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(providerResponse(other))
    const cloud = new DeepSeekAgent({ apiKey: syntheticKey, fetchImpl: fetcher })
    await cloud.review(other, mathDraft())
    expect(fetcher).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetcher.mock.calls[0][1]!.body as string)
    expect(JSON.parse(body.messages[1].content).answer.math).toBeUndefined()
  })

  it('rejects unsafe expressions before network and preserves math draft on a provider failure', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('synthetic transport failure'))
    const cloud = new DeepSeekAgent({ apiKey: syntheticKey, fetchImpl: fetcher })
    const service = new StudyService(directory, bank, local, cloud)
    const unsafe = mathDraft()
    unsafe.math!.expression = 'globalThis.fetch(x)'
    await expect(
      service.submitAnswer(question.id, unsafe, { provider: 'deepseek', cloudConsent: true }),
    ).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
    await expect(
      service.submitAnswer(question.id, mathDraft(), { provider: 'deepseek', cloudConsent: true }),
    ).rejects.toThrow('无法连接')
    const state = await service.loadState()
    expect(state.drafts[question.id].math).toEqual(mathDraft().math)
    expect(state.attempts).toHaveLength(0)
  })
})
