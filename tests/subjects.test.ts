import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sampleQuestions } from '../src/domain/sample-bank'
import { questionSchema, scopeSchema, validateAnswer } from '../src/domain/schemas'
import { subjects, subjectGuidance } from '../src/shared/subjects'
import { emptyDraft } from '../src/shared/types'
import { LocalQuestionBank } from '../src/adapters/local-question-bank'
import { LocalRuleAgent } from '../src/adapters/local-rule-agent'
import { StudyService } from '../src/domain/study-service'
import { DeepSeekAgent } from '../src/adapters/deepseek-agent'

const added = ['chinese', 'math', 'english', 'history'] as const

describe('six-subject practice', () => {
  let directory: string
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'examcraft-subjects-'))
  })
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('has three original demos per subject, with choice and subject-specific tasks', () => {
    expect(sampleQuestions).toHaveLength(18)
    for (const subject of subjects) {
      const questions = sampleQuestions.filter((q) => q.subject === subject)
      expect(questions).toHaveLength(3)
      expect(questions.some((q) => q.kind === 'choice')).toBe(true)
      expect(questions.some((q) => q.kind === subject)).toBe(true)
      for (const q of questions) {
        expect(questionSchema.parse(q)).toEqual(q)
        expect(q.source).toContain('原创示例 · 非历年真题')
      }
    }
  })

  it.each(added)(
    '%s selects, saves, reviews, imports, retries and reloads version-1 history',
    async (subject) => {
      const bank = new LocalQuestionBank(directory)
      const service = new StudyService(directory, bank, new LocalRuleAgent())
      const questions = await bank.list(scopeSchema.parse({ subject }))
      expect(questions.every((q) => q.subject === subject)).toBe(true)
      const choice = questions.find((q) => q.kind === 'choice')!
      const written = questions.find((q) => q.kind === subject)!
      const text = written.rubric!.map((r) => r.keywords[0]).join(' ')
      const draft = { ...emptyDraft(), text }
      await service.saveDraft(written.id, draft)
      const answer = await service.submitAnswer(written.id, draft)
      expect(answer.score).toBe(written.maxScore)
      expect(answer.feedback).toContain(subjectGuidance[subject].local)
      expect(answer.rubric.map((r) => r.id)).toEqual(written.rubric!.map((r) => r.id))
      expect(
        (await service.submitAnswer(choice.id, { ...emptyDraft(), choiceId: choice.correctAnswer }))
          .score,
      ).toBe(4)
      await expect(service.submitAnswer(written.id, emptyDraft())).rejects.toThrow('填写')
      const retry = await service.submitAnswer(written.id, {
        ...emptyDraft(),
        text: '未覆盖要点的练习答案',
      })
      expect(retry.id).not.toBe(answer.id)
      expect(retry.score).toBe(0)
      const imported = { ...written, id: `import-${subject}` }
      await bank.importBank({ version: 1, questions: [imported] })
      const restarted = new StudyService(
        directory,
        new LocalQuestionBank(directory),
        new LocalRuleAgent(),
      )
      expect((await restarted.loadState()).attempts).toHaveLength(3)
      expect((await restarted.loadState()).attempts[0].draft).toEqual(draft)
      expect((await restarted.bank.get(imported.id)).subject).toBe(subject)
    },
  )

  it('opens unchanged old version-1 files alongside new subjects without migration', async () => {
    const old = {
      version: 1,
      drafts: { 'pol-choice-1': { ...emptyDraft(), choiceId: 'A' } },
      attempts: [],
    }
    await writeFile(join(directory, 'study-state.json'), JSON.stringify(old))
    const service = new StudyService(
      directory,
      new LocalQuestionBank(directory),
      new LocalRuleAgent(),
    )
    expect(await service.loadState()).toEqual(old)
    await service.submitAnswer('eng-choice-1', { ...emptyDraft(), choiceId: 'B' })
    expect((await service.loadState()).drafts['pol-choice-1']).toEqual(old.drafts['pol-choice-1'])
  })

  it.each(added)('%s rejects cross-subject kinds and non-text hidden answers', (subject) => {
    const q = sampleQuestions.find((q) => q.kind === subject)!
    expect(() => questionSchema.parse({ ...q, subject: 'politics' })).toThrow()
    expect(() =>
      validateAnswer(
        q,
        {
          ...emptyDraft(),
          drawing: { mode: 'cartesian', points: [{ id: 'p', x: 0, y: 0, label: '' }], lines: [] },
        },
        true,
      ),
    ).toThrow('文字答案')
  })

  it('preserves an older imported ID that now collides with a new bundled demo', async () => {
    const imported = { ...sampleQuestions[0], id: 'chi-choice-1', title: '用户的原有题目' }
    const beforeUpgrade = new LocalQuestionBank(directory, sampleQuestions.slice(0, 6))
    await beforeUpgrade.importBank({ version: 1, questions: [imported] })
    const oldService = new StudyService(directory, beforeUpgrade, new LocalRuleAgent())
    const attempt = await oldService.submitAnswer(imported.id, { ...emptyDraft(), choiceId: 'A' })
    const upgraded = new LocalQuestionBank(directory)
    expect(await upgraded.get(imported.id)).toEqual(imported)
    expect(await upgraded.list()).toHaveLength(18)
    expect(
      (await new StudyService(directory, upgraded, new LocalRuleAgent()).loadState()).attempts,
    ).toEqual([attempt])
    await expect(upgraded.importBank({ version: 1, questions: [imported] })).rejects.toThrow(
      'ID 已存在',
    )
  })

  it('preserves a formerly full 994-import bank by omitting demos that do not fit', async () => {
    const imported = Array.from({ length: 994 }, (_, i) => ({
      ...sampleQuestions[0],
      id: `old-import-${i}`,
    }))
    await new LocalQuestionBank(directory, sampleQuestions.slice(0, 6)).importBank({
      version: 1,
      questions: imported,
    })
    const upgraded = new LocalQuestionBank(directory)
    const questions = await upgraded.list()
    expect(questions).toHaveLength(1000)
    expect(questions.slice(0, 6)).toEqual(sampleQuestions.slice(0, 6))
    expect(questions.slice(6)).toEqual(imported)
    await expect(
      upgraded.importBank({ version: 1, questions: [{ ...sampleQuestions[0], id: 'over-limit' }] }),
    ).rejects.toThrow()
    expect(await upgraded.list()).toEqual(questions)
  })

  it('English keywords are case-insensitive whole words and escaped safely', async () => {
    const q = {
      ...sampleQuestions.find((q) => q.kind === 'english')!,
      rubric: [{ id: 'one', label: 'Test', keywords: ['art'], points: 6 }],
    }
    const agent = new LocalRuleAgent()
    expect((await agent.review(q, { ...emptyDraft(), text: 'party' })).score).toBe(0)
    expect((await agent.review(q, { ...emptyDraft(), text: 'ART.' })).score).toBe(6)
    const literal = { ...q, rubric: [{ ...q.rubric[0], keywords: ['a+b'] }] }
    expect((await agent.review(literal, { ...emptyDraft(), text: 'a+b' })).score).toBe(6)
  })

  it.each(added)(
    '%s sends trusted subject guidance and validates synthetic cloud rubric',
    async (subject) => {
      const q = sampleQuestions.find((q) => q.kind === subject)!
      let sent: { messages: { content: string }[] } | undefined
      const agent = new DeepSeekAgent({
        apiKey: 'synthetic-test-key',
        fetchImpl: async (_url, init) => {
          sent = JSON.parse(String(init?.body))
          return new Response(
            JSON.stringify({
              choices: [
                {
                  finish_reason: 'stop',
                  message: {
                    content: JSON.stringify({
                      feedback: '模拟反馈，非真实模型验收',
                      explanation: q.explanation,
                      rubric: q.rubric!.map((r) => ({
                        id: r.id,
                        earned: r.points,
                        feedback: '模拟依据',
                      })),
                    }),
                  },
                },
              ],
            }),
          )
        },
      })
      const review = await agent.review(q, { ...emptyDraft(), text: 'Synthetic answer only.' })
      expect(sent!.messages[0].content).toContain(subjectGuidance[subject].review)
      expect(JSON.parse(sent!.messages[1].content).question.subject).toBe(subject)
      expect(review.score).toBe(q.maxScore)
      expect(review.rubric.map((r) => r.id)).toEqual(q.rubric!.map((r) => r.id))
    },
  )
})
