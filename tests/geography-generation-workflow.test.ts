import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelService } from '../src/adapters/model-service'
import { LocalQuestionBank } from '../src/adapters/local-question-bank'
import { LocalRuleAgent } from '../src/adapters/local-rule-agent'
import { StudyService } from '../src/domain/study-service'
import { listStudentQuestions } from '../src/domain/student-question'
import { emptyDraft, type GenerateGeographyRequest } from '../src/shared/types'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})
const original = () => ({
  title: '合成地理位置练习',
  prompt: '根据已知示意图判断 A 相对 B 的方位，并解释坐标依据。',
  maxScore: 4,
  explanation: 'PRIVATE_GENERATED_REFERENCE_A在B东北方。',
  rubric: [{ label: 'PRIVATE_GENERATED_RUBRIC方位依据', keywords: ['东北'], points: 4 }],
  figure: {
    version: 1,
    kind: 'schematic',
    title: '两个观测点',
    description: '平面示意，向右为东，向上为北。',
    points: [
      { id: 'a', x: 40, y: 40, label: 'A' },
      { id: 'b', x: -40, y: -40, label: 'B' },
    ],
    segments: [{ id: 'ab', from: 'a', to: 'b' }],
    arrows: [],
    polylines: [],
    polygons: [],
    labels: [],
  },
})
function response(output = original()) {
  return new Response(
    JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }],
    }),
    { status: 200 },
  )
}
async function setup(fetchImpl: typeof fetch) {
  const directory = await mkdtemp(join(tmpdir(), 'examcraft-generation-flow-'))
  directories.push(directory)
  const bank = new LocalQuestionBank(directory)
  const models = new ModelService(directory, {
    fetchImpl,
    listQuestions: () => bank.list(),
    persistGenerated: (question) => bank.importBank({ version: 1, questions: [question] }),
    resolveQuestion: (id) => bank.get(id),
  })
  const config = await models.saveConfig({
    protocol: 'openai-chat',
    baseUrl: 'https://api.example.com/v1',
    model: 'synthetic-model',
    apiKey: 'synthetic-not-a-real-credential',
  })
  const study = new StudyService(directory, bank, new LocalRuleAgent())
  const request = (requestId = 'generation-test'): GenerateGeographyRequest => ({
    requestId,
    syllabus: '合成高中地理考纲',
    chapter: '经纬网',
    difficulty: '基础',
    cloudConsent: true,
    configRevision: config.revision,
  })
  return { directory, bank, models, config, study, request }
}

describe('generated geography end-to-end workflow through actual main services (no GUI or network)', () => {
  it('authorizes exact inputs, previews privately, accepts, practices, submits and restores feedback', async () => {
    const sent: unknown[] = []
    const transport = vi.fn<typeof fetch>(async (_url, init) => {
      sent.push(JSON.parse(JSON.parse(String(init?.body)).messages[1].content))
      return response()
    })
    const { directory, bank, models, study, request } = await setup(transport)
    const prior = { ...emptyDraft(), choiceId: 'A', text: 'PRIVATE_PREVIOUS_HISTORY' }
    await study.submitAnswer('pol-choice-1', prior)
    const countBefore = (await bank.list()).length
    await expect(
      models.generateGeographyQuestion({ ...request(), cloudConsent: false }),
    ).rejects.toThrow('授权')
    expect(transport).not.toHaveBeenCalled()
    const preview = await models.generateGeographyQuestion(request())
    expect(sent).toEqual([{ syllabus: '合成高中地理考纲', chapter: '经纬网', difficulty: '基础' }])
    expect(JSON.stringify(sent)).not.toContain('PRIVATE_PREVIOUS_HISTORY')
    expect(await bank.list()).toHaveLength(countBefore)
    expect((await study.loadState()).attempts).toHaveLength(1)
    expect(preview.question.figure?.points).toHaveLength(2)
    expect(preview.question.provenance).toMatchObject({
      kind: 'ai-generated',
      verified: false,
      model: 'synthetic-model',
    })
    expect(preview.question).not.toHaveProperty('explanation')
    expect(preview.question).not.toHaveProperty('rubric')
    expect(JSON.stringify(preview)).not.toContain('PRIVATE_GENERATED')
    const question = await models.acceptGeneratedQuestion(preview.token)
    expect(await bank.list()).toHaveLength(countBefore + 1)
    expect(JSON.stringify(question)).not.toContain('PRIVATE_GENERATED')
    expect(JSON.stringify(await listStudentQuestions(bank))).not.toContain('PRIVATE_GENERATED')
    const draft = { ...emptyDraft(), text: 'A 位于 B 的东北方向，因为横坐标与纵坐标都更大。' }
    await study.saveDraft(question.id, draft)
    const result = await study.submitAnswer(question.id, draft, { provider: 'local' })
    expect(result).toMatchObject({
      score: 4,
      maxScore: 4,
      draft,
      explanation: original().explanation,
    })
    expect(result.feedback).toContain('不代表考试得分')
    expect(result.rubric[0].label).toContain('PRIVATE_GENERATED_RUBRIC')
    expect(transport).toHaveBeenCalledTimes(1)
    expect(models.getGenerationStatus()).toEqual({ used: 1, limit: 5, pending: 0 })
    const restoredBank = new LocalQuestionBank(directory)
    const restoredStudy = new StudyService(directory, restoredBank, new LocalRuleAgent())
    expect((await restoredStudy.loadState()).attempts.at(-1)).toEqual(result)
    expect((await restoredBank.get(question.id)).figure).toEqual(question.figure)
    expect(JSON.stringify(await listStudentQuestions(restoredBank))).not.toContain(
      'PRIVATE_GENERATED',
    )
  })

  it('rejects without question-bank/history writes and never regenerates automatically', async () => {
    const transport = vi.fn<typeof fetch>(async () => response())
    const { directory, bank, models, study, request } = await setup(transport)
    const before = await bank.list()
    const preview = await models.generateGeographyQuestion(request())
    models.rejectGeneratedQuestion(preview.token)
    await expect(models.acceptGeneratedQuestion(preview.token)).rejects.toThrow('预览')
    expect(await bank.list()).toEqual(before)
    expect(await study.loadState()).toEqual({ version: 1, drafts: {}, attempts: [] })
    await expect(readFile(join(directory, 'question-bank.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(transport).toHaveBeenCalledTimes(1)
    expect(models.getGenerationStatus()).toEqual({ used: 1, limit: 5, pending: 0 })
    const another = await models.generateGeographyQuestion(request('explicit-retry'))
    expect(transport).toHaveBeenCalledTimes(2)
    expect(another.token).not.toEqual(preview.token)
  })

  it.each(['cancel', 'change-model'] as const)(
    'discards late %s responses with no saved question or attempt',
    async (action) => {
      let start!: () => void
      let release!: (value: Response) => void
      const started = new Promise<void>((resolve) => {
        start = resolve
      })
      const delayed = new Promise<Response>((resolve) => {
        release = resolve
      })
      const transport = vi.fn<typeof fetch>(async () => {
        start()
        return delayed
      })
      const { bank, models, study, request } = await setup(transport)
      const before = await bank.list()
      const pending = models.generateGeographyQuestion(request())
      // Attach a rejection handler before cancellation to avoid an unhandled rejection.
      const outcome = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
      await started
      if (action === 'cancel') models.cancelQuestionGeneration(request().requestId)
      else
        await models.saveConfig({
          protocol: 'openai-chat',
          baseUrl: 'https://api.example.com/v1',
          model: 'new-synthetic-model',
        })
      release(response())
      const result = await outcome
      expect(result).toHaveProperty('error')
      expect(result).not.toHaveProperty('value')
      expect(await bank.list()).toEqual(before)
      expect(await study.loadState()).toEqual({ version: 1, drafts: {}, attempts: [] })
      expect(transport).toHaveBeenCalledTimes(1)
      expect(models.getGenerationStatus()).toEqual({ used: 1, limit: 5, pending: 0 })
    },
  )

  it('a malformed generation keeps the previous practice draft intact and cannot trigger a review', async () => {
    const transport = vi.fn<typeof fetch>(async () => response({ ...original(), maxScore: 3 }))
    const { models, study, request } = await setup(transport)
    const draft = { ...emptyDraft(), text: '仍在编辑的既有答案' }
    await study.saveDraft('pol-choice-1', draft)
    await expect(models.generateGeographyQuestion(request())).rejects.toThrow('格式无效')
    expect((await study.loadState()).drafts['pol-choice-1']).toEqual(draft)
    expect((await study.loadState()).attempts).toEqual([])
    expect(transport).toHaveBeenCalledTimes(1)
    expect(models.getGenerationStatus().pending).toBe(0)
  })
})
