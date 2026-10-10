import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalQuestionBank } from '../src/adapters/local-question-bank'
import { LocalRuleAgent } from '../src/adapters/local-rule-agent'
import { StudyService } from '../src/domain/study-service'
import { draftSchema, questionBankSchema } from '../src/domain/schemas'
import { sampleQuestions } from '../src/domain/sample-bank'
import { emptyDraft } from '../src/shared/types'

describe('offline study lifecycle', () => {
  let directory: string
  let bank: LocalQuestionBank
  let service: StudyService
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'examcraft-domain-'))
    bank = new LocalQuestionBank(directory)
    service = new StudyService(directory, bank, new LocalRuleAgent())
  })
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('lists original examples, saves a draft, grades exact choices and reloads attempts after restart', async () => {
    const questions = await bank.list()
    expect(questions).toHaveLength(6)
    expect(questions.every((question) => question.source.includes('非历年真题'))).toBe(true)
    const question = questions.find((item) => item.id === 'pol-choice-1')!
    const draft = { ...emptyDraft(), choiceId: 'A' }
    await service.saveDraft(question.id, draft)
    expect((await service.loadState()).drafts[question.id]).toEqual(draft)
    const attempt = await service.submitAnswer(question.id, draft)
    expect(attempt.score).toBe(question.maxScore)
    const restarted = new StudyService(
      directory,
      new LocalQuestionBank(directory),
      new LocalRuleAgent(),
    )
    expect((await restarted.loadState()).attempts).toEqual([attempt])
    expect((await service.submitAnswer(question.id, { ...draft, choiceId: 'B' })).score).toBe(0)
  })

  it('serializes concurrent submissions without lost history', async () => {
    const attempts = await Promise.all(
      Array.from({ length: 15 }, () =>
        service.submitAnswer('geo-choice-1', { ...emptyDraft(), choiceId: 'C' }),
      ),
    )
    const state = await service.loadState()
    expect(state.attempts).toHaveLength(15)
    expect(new Set(state.attempts.map((item) => item.id))).toEqual(
      new Set(attempts.map((item) => item.id)),
    )
    expect(
      JSON.parse(await readFile(join(directory, 'study-state.json'), 'utf8')).attempts,
    ).toHaveLength(15)
  })

  it('rejects blank or invalid answers without saving an attempt', async () => {
    await expect(service.submitAnswer('pol-choice-1', emptyDraft())).rejects.toThrow('选择')
    await expect(
      service.submitAnswer('pol-choice-1', { ...emptyDraft(), choiceId: 'Z' }),
    ).rejects.toThrow('选项')
    await expect(service.submitAnswer('pol-assembly-1', emptyDraft())).rejects.toThrow('填写')
    await expect(service.saveDraft('constructor', emptyDraft())).rejects.toThrow()
    expect((await service.loadState()).attempts).toEqual([])
  })

  it('preserves corrupt data and refuses subsequent writes instead of silently resetting', async () => {
    const file = join(directory, 'study-state.json')
    const broken = '{"version":1,"drafts":'
    await writeFile(file, broken)
    await expect(service.loadState()).rejects.toThrow('原文件未被覆盖')
    await expect(service.saveDraft('pol-choice-1', emptyDraft())).rejects.toThrow('原文件未被覆盖')
    expect(await readFile(file, 'utf8')).toBe(broken)
  })

  it('imports append-only validated JSON and rejects duplicate IDs atomically', async () => {
    const question = { ...sampleQuestions[0], id: 'imported-choice' }
    expect(await bank.importBank({ version: 1, questions: [question] })).toBe(1)
    expect(await new LocalQuestionBank(directory).get(question.id)).toEqual(question)
    await expect(
      bank.importBank({ version: 1, questions: [{ ...question, id: 'would-be-new' }, question] }),
    ).rejects.toThrow('ID 已存在')
    expect(await bank.list()).toHaveLength(7)
    await expect(bank.get('would-be-new')).rejects.toThrow()
    await expect(
      bank.importBank({
        version: 1,
        questions: [{ ...question, id: 'invalid', correctAnswer: 'Z' }],
      }),
    ).rejects.toThrow()
  })

  it('handles simultaneous duplicate imports without overwrites', async () => {
    const input = { version: 1, questions: [{ ...sampleQuestions[0], id: 'concurrent-import' }] }
    const results = await Promise.allSettled([bank.importBank(input), bank.importBank(input)])
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(await bank.list()).toHaveLength(7)
  })

  it('enforces the combined bundled and imported bank limit before writing', async () => {
    const questions = Array.from({ length: 995 }, (_, index) => ({
      ...sampleQuestions[0],
      id: `overflow-${index}`,
    }))
    await expect(bank.importBank({ version: 1, questions })).rejects.toThrow()
    expect(await bank.list()).toHaveLength(6)
  })

  it('preserves assembled blocks and drawing snapshots; labels grading limitations honestly', async () => {
    const politics = await bank.get('pol-assembly-1')
    const draft = { ...emptyDraft(), blocks: politics.blocks!.slice(0, 4) }
    const attempt = await service.submitAnswer(politics.id, draft)
    expect(attempt.score).toBe(12)
    expect(attempt.feedback).toContain('不理解语义')
    expect(attempt.draft.blocks).toEqual(draft.blocks)
    const geoDraft = {
      ...emptyDraft(),
      text: 'B 在东北方向，因为东经和北纬都增加。',
      drawing: {
        mode: 'geographic' as const,
        points: [
          { id: 'A', x: 20, y: 30, label: 'A' },
          { id: 'B', x: 40, y: 50, label: 'B' },
        ],
        lines: [{ id: 'AB', from: 'A', to: 'B' }],
      },
    }
    const geo = await service.submitAnswer('geo-drawing-1', geoDraft)
    expect(geo.score).toBe(6)
    expect(geo.feedback).toContain('未参与自动评分')
    expect((await service.loadState()).attempts[1].draft.drawing).toEqual(geoDraft.drawing)
  })
})

describe('untrusted import and draft validation', () => {
  it('rejects duplicate or dangerous IDs and inconsistent scoring', () => {
    expect(
      questionBankSchema.safeParse({
        version: 1,
        questions: [sampleQuestions[0], sampleQuestions[0]],
      }).success,
    ).toBe(false)
    expect(
      questionBankSchema.safeParse({
        version: 1,
        questions: [{ ...sampleQuestions[0], id: '__proto__' }],
      }).success,
    ).toBe(false)
    expect(
      questionBankSchema.safeParse({
        version: 1,
        questions: [{ ...sampleQuestions[2], maxScore: 99 }],
      }).success,
    ).toBe(false)
    expect(
      questionBankSchema.safeParse({
        version: 1,
        questions: [{ ...sampleQuestions[0], command: 'anything' }],
      }).success,
    ).toBe(false)
  })
  it('rejects nonfinite/out-of-range coordinates and dangling lines while allowing intermediate text edits', () => {
    const draft = emptyDraft()
    draft.drawing.points = [{ id: 'A', x: 11, y: 0, label: 'A' }]
    expect(draftSchema.safeParse(draft).success).toBe(false)
    draft.drawing.points[0].x = 0
    draft.drawing.lines = [{ id: 'line', from: 'A', to: 'missing' }]
    expect(draftSchema.safeParse(draft).success).toBe(false)
    draft.drawing.lines = []
    draft.blocks = [{ id: 'editing', category: 'principle', label: '', text: '' }]
    expect(draftSchema.safeParse(draft).success).toBe(true)
  })
})
