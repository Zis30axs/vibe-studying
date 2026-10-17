import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MathChallengeService } from '../src/adapters/math-challenge-service'
import {
  mathChallengeCatalog,
  mathChallengePaperProjection,
  mathChallengePaperSchema,
  scoreMathChallengeChoice,
} from '../src/domain/math-challenge'
import type {
  MathChallengeAnswer,
  MathChallengeKind,
  MathChallengePaperDefinition,
  MathChallengeReferenceQuestion,
  MathChallengeSession,
} from '../src/shared/math-challenge'

/** All sessions in this suite use synthetic papers and a new temporary directory. */
function fixturePaper(solutionCount: 5 | 6 = 5): MathChallengePaperDefinition {
  const kinds: MathChallengeKind[] = [
    ...Array<MathChallengeKind>(8).fill('single'),
    ...Array<MathChallengeKind>(3).fill('multiple'),
    ...Array<MathChallengeKind>(3).fill('fill'),
    ...Array<MathChallengeKind>(solutionCount).fill('solution'),
  ]
  const solutionPoints = solutionCount === 5 ? [13, 15, 15, 17, 17] : [12, 12, 12, 13, 14, 14]
  return {
    id: `fixture-${solutionCount}`,
    title: `测试综合卷 ${solutionCount}`,
    description: '仅用于验证综合卷生命周期的合成试卷。',
    scope: '已学知识综合',
    source: '自动化测试合成数据',
    durationMinutes: 120,
    solutionCount,
    questions: kinds.map((kind, i): MathChallengeReferenceQuestion => {
      const points = kind === 'solution' ? solutionPoints[i - 14] : kind === 'multiple' ? 6 : 5
      return {
        id: `q${i + 1}`,
        kind,
        title: `第 ${i + 1} 题`,
        prompt: `合成试题 ${i + 1}`,
        points,
        tags: ['测试'],
        ...(kind === 'single' || kind === 'multiple'
          ? {
              choices: ['A', 'B', 'C', 'D'].map((id) => ({ id, text: `选项 ${id}` })),
              correctChoiceIds: kind === 'single' ? ['A'] : ['A', 'C'],
            }
          : {}),
        answer: `secret-answer-${i + 1}`,
        explanation: `secret-explanation-${i + 1}`,
        rubric: [{ label: `secret-rubric-${i + 1}`, points }],
      }
    }),
  }
}

const answer = (choiceIds: string[] = [], text = ''): MathChallengeAnswer => ({
  choiceIds,
  text,
  flagged: false,
})
const saveInput = (session: MathChallengeSession, answers = session.answers) => ({
  sessionId: session.id,
  expectedRevision: session.revision,
  answers,
  activeQuestionId: session.activeQuestionId,
  scratchpad: session.scratchpad,
})
const refFields = new Set([
  'answer',
  'explanation',
  'rubric',
  'correctChoiceIds',
  'manualScores',
  'review',
])
function expectNoReference(value: unknown): void {
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    expect(refFields.has(key), `reference field leaked: ${key}`).toBe(false)
    expectNoReference(child)
  }
  expect(JSON.stringify(value)).not.toContain('secret-')
}

const directories: string[] = []
async function createService(papers = [fixturePaper()], initialTime = 1_000_000) {
  const directory = await mkdtemp(join(tmpdir(), 'examcraft-math-challenge-'))
  directories.push(directory)
  let time = initialTime
  const now = () => time
  return {
    directory,
    path: join(directory, 'math-challenges.json'),
    service: new MathChallengeService(directory, papers, now),
    now,
    setTime: (next: number) => {
      time = next
    },
  }
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('math comprehensive challenge contract and scoring', () => {
  it.each([5, 6] as const)(
    'validates the 8+3+3+%i layout with 150 points and isolated student data',
    (count) => {
      const paper = fixturePaper(count)
      expect(mathChallengePaperSchema.parse(paper)).toEqual(paper)
      const catalog = mathChallengeCatalog(paper)
      expect(catalog.totalQuestions).toBe(14 + count)
      expect(catalog.totalPoints).toBe(150)
      expect(catalog.sections.map((section) => [section.count, section.points])).toEqual([
        [8, 40],
        [3, 18],
        [3, 15],
        [count, 77],
      ])
      expectNoReference(catalog)
      const projected = mathChallengePaperProjection(paper)
      expectNoReference(projected)
      projected.questions[0].tags.push('renderer mutation')
      projected.questions[0].choices![0].text = 'renderer mutation'
      expect(paper.questions[0].tags).toEqual(['测试'])
      expect(paper.questions[0].choices![0].text).toBe('选项 A')
    },
  )

  it('rejects malformed ordering, totals, question keys, option keys and supplied extra fields', () => {
    const invalid = [
      (p: MathChallengePaperDefinition) => {
        ;[p.questions[0], p.questions[8]] = [p.questions[8], p.questions[0]]
      },
      (p: MathChallengePaperDefinition) => {
        p.questions[1].id = p.questions[0].id
      },
      (p: MathChallengePaperDefinition) => {
        p.questions[14].points++
        p.questions[14].rubric[0].points++
      },
      (p: MathChallengePaperDefinition) => {
        p.questions[0].rubric[0].points--
      },
      (p: MathChallengePaperDefinition) => {
        p.questions[0].id = 'constructor'
      },
      (p: MathChallengePaperDefinition) => {
        p.questions[0].choices![1].id = 'A'
      },
      (p: MathChallengePaperDefinition) => {
        p.questions[0].correctChoiceIds = ['Z']
      },
      (p: MathChallengePaperDefinition) => {
        p.questions[0].correctChoiceIds = ['A', 'B']
      },
      (p: MathChallengePaperDefinition) => {
        Object.assign(p.questions[0], { forgedScore: 5 })
      },
    ]
    for (const mutate of invalid) {
      const paper = fixturePaper()
      mutate(paper)
      expect(mathChallengePaperSchema.safeParse(paper).success).toBe(false)
    }
  })

  it('scores single and multiple choice answers by full, partial, wrong and empty selection rules', () => {
    const paper = fixturePaper()
    const single = paper.questions[0],
      multiple = paper.questions[8]
    expect(scoreMathChallengeChoice(single, ['A'])).toBe(5)
    expect(scoreMathChallengeChoice(single, ['B'])).toBe(0)
    expect(scoreMathChallengeChoice(single, [])).toBe(0)
    expect(scoreMathChallengeChoice(multiple, ['C', 'A'])).toBe(6)
    expect(scoreMathChallengeChoice(multiple, ['A'])).toBe(3)
    expect(scoreMathChallengeChoice(multiple, ['C'])).toBe(3)
    for (const selected of [[], ['A', 'B'], ['B'], ['A', 'A'], ['Z']])
      expect(scoreMathChallengeChoice(multiple, selected)).toBe(0)
  })
})

describe('math challenge durable lifecycle', () => {
  it('keeps saved work and the original paper after reopening with a changed catalog, then self-assesses pending scores', async () => {
    const original = fixturePaper()
    const { service, directory, now } = await createService([original])
    const started = await service.startMathChallenge({ paperId: original.id })
    expectNoReference(started)
    const saved = await service.saveMathChallenge({
      ...saveInput(started, {
        q1: answer(['A']),
        q9: answer(['A', 'C']),
        q12: answer([], '我的填空答案'),
        q15: answer([], '我的解答过程'),
      }),
      activeQuestionId: 'q15',
      scratchpad: '草稿保留',
    })
    expect(saved.revision).toBe(1)
    expectNoReference(saved)

    const changed = fixturePaper()
    changed.title = '新版目录试卷'
    changed.questions[0].prompt = '目录更新后的题目'
    changed.questions[0].correctChoiceIds = ['B']
    changed.questions[0].answer = 'new-secret-answer'
    const reopened = new MathChallengeService(directory, [changed], now)
    const overview = await reopened.getMathChallenges()
    expect(overview.papers[0].title).toBe(changed.title)
    expect(overview.active).toEqual(saved)
    await expect(reopened.startMathChallenge({ paperId: changed.id })).rejects.toThrow(/已有进行中/)
    const submitted = await reopened.submitMathChallenge({
      sessionId: saved.id,
      expectedRevision: saved.revision,
    })
    expect(submitted.paper.title).toBe(original.title)
    expect(submitted.paper.questions[0].prompt).toBe(original.questions[0].prompt)
    expect(submitted.review!.items[0].answer).toBe(original.questions[0].answer)
    expect(submitted.review!.objectiveScore).toBe(11)
    expect(submitted.review!.objectiveMaxScore).toBe(58)
    expect(submitted.review!.manualMaxScore).toBe(92)
    expect(submitted.review!.pendingManualCount).toBe(2)
    expect(submitted.review!.totalScore).toBeNull()
    expect(submitted.review!.items.find((item) => item.questionId === 'q12')).toMatchObject({
      earned: null,
      grading: 'pending',
    })
    expect(submitted.review!.items.find((item) => item.questionId === 'q13')).toMatchObject({
      earned: 0,
      grading: 'automatic',
    })
    expect((await reopened.getMathChallenges()).history[0]).toMatchObject({
      totalScore: null,
      pendingManualCount: 2,
    })

    const gradedFill = await reopened.gradeMathChallenge({
      sessionId: saved.id,
      expectedRevision: submitted.revision,
      questionId: 'q12',
      score: 4,
    })
    expect(gradedFill.review!.totalScore).toBeNull()
    const graded = await reopened.gradeMathChallenge({
      sessionId: saved.id,
      expectedRevision: gradedFill.revision,
      questionId: 'q15',
      score: 10,
    })
    expect(graded.review).toMatchObject({ manualScore: 14, pendingManualCount: 0, totalScore: 25 })
    expect(graded.review!.items.find((item) => item.questionId === 'q15')).toMatchObject({
      earned: 10,
      grading: 'self',
    })
    expect(
      await new MathChallengeService(directory, [changed], now).getMathChallenge(saved.id),
    ).toEqual(graded)
  })

  it('allows only one concurrent active sitting and preserves atomic state on stale saves or submissions', async () => {
    const { service, path } = await createService()
    const attempts = await Promise.allSettled([
      service.startMathChallenge({ paperId: 'fixture-5' }),
      service.startMathChallenge({ paperId: 'fixture-5' }),
    ])
    const accepted = attempts.filter((attempt) => attempt.status === 'fulfilled')
    expect(accepted).toHaveLength(1)
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1)
    const session = (accepted[0] as PromiseFulfilledResult<MathChallengeSession>).value
    const writes = await Promise.allSettled([
      service.saveMathChallenge({ ...saveInput(session), scratchpad: '第一份保存' }),
      service.saveMathChallenge({ ...saveInput(session), scratchpad: '第二份保存' }),
    ])
    expect(writes.filter((write) => write.status === 'fulfilled')).toHaveLength(1)
    expect(writes.filter((write) => write.status === 'rejected')).toHaveLength(1)
    const current = await service.getMathChallenge(session.id)
    expect(current.revision).toBe(1)
    const before = await readFile(path, 'utf8')
    await expect(service.saveMathChallenge(saveInput(session))).rejects.toThrow(/更新/)
    await expect(
      service.submitMathChallenge({ sessionId: session.id, expectedRevision: 0 }),
    ).rejects.toThrow(/更新/)
    expect(await readFile(path, 'utf8')).toBe(before)
    expect((await service.getMathChallenges()).active).toEqual(current)
  })

  it('ignores late answers at the deadline and persists the timed-out sitting before returning it', async () => {
    const { service, path, setTime } = await createService()
    const started = await service.startMathChallenge({ paperId: 'fixture-5' })
    const saved = await service.saveMathChallenge({
      ...saveInput(started, { q1: answer(['A']) }),
      scratchpad: '截止前草稿',
    })
    setTime(saved.deadlineAt)
    const expired = await service.saveMathChallenge({
      ...saveInput(saved, { q1: answer(['B']) }),
      activeQuestionId: 'q2',
      scratchpad: '截止后修改',
    })
    expect(expired).toMatchObject({
      submittedAt: saved.deadlineAt,
      submitReason: 'timeout',
      revision: saved.revision + 1,
      answers: saved.answers,
      activeQuestionId: saved.activeQuestionId,
      scratchpad: saved.scratchpad,
    })
    expect(expired.review!.objectiveScore).toBe(5)
    expect(JSON.parse(await readFile(path, 'utf8')).sessions[0]).toMatchObject({
      submittedAt: saved.deadlineAt,
      submitReason: 'timeout',
      answers: saved.answers,
    })
    const before = await readFile(path, 'utf8')
    expect(await service.submitMathChallenge({ sessionId: saved.id, expectedRevision: 0 })).toEqual(
      expired,
    )
    expect(
      await service.submitMathChallenge({
        sessionId: saved.id,
        expectedRevision: expired.revision,
      }),
    ).toEqual(expired)
    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it('closes and saves a background sitting when first read after reopening beyond its deadline', async () => {
    const { service, directory, path, setTime, now } = await createService()
    const started = await service.startMathChallenge({ paperId: 'fixture-5' })
    const saved = await service.saveMathChallenge(
      saveInput(started, { q15: answer([], '关窗前未交卷的过程') }),
    )
    setTime(saved.deadlineAt + 60_000)
    const reopened = new MathChallengeService(directory, [fixturePaper()], now)
    const overview = await reopened.getMathChallenges()
    expect(overview.active).toBeNull()
    expect(overview.history).toEqual([
      expect.objectContaining({
        id: saved.id,
        submitReason: 'timeout',
        submittedAt: saved.deadlineAt,
        totalScore: null,
        pendingManualCount: 1,
      }),
    ])
    const persisted = JSON.parse(await readFile(path, 'utf8')).sessions[0]
    expect(persisted).toMatchObject({
      submittedAt: saved.deadlineAt,
      submitReason: 'timeout',
      revision: 2,
    })
    expect((await reopened.getMathChallenge(saved.id)).answers).toEqual(saved.answers)
  })

  it('rejects invalid answer payloads and grades without altering durable work', async () => {
    const { service, path } = await createService()
    await expect(
      service.startMathChallenge({ paperId: 'fixture-5', extra: true }),
    ).rejects.toThrow()
    const started = await service.startMathChallenge({ paperId: 'fixture-5' })
    const before = await readFile(path, 'utf8')
    const invalidSaves = [
      { ...saveInput(started), activeQuestionId: 'missing' },
      { ...saveInput(started), answers: { missing: answer(['A']) } },
      { ...saveInput(started), answers: { constructor: answer(['A']) } },
      { ...saveInput(started), answers: { q1: answer(['Z']) } },
      { ...saveInput(started), answers: { q1: answer(['A', 'B']) } },
      { ...saveInput(started), answers: { q9: answer(['A', 'A']) } },
      { ...saveInput(started), answers: { q12: answer(['A'], '填空') } },
      { ...saveInput(started), answers: { q1: answer(['A'], '隐藏文本') } },
      { ...saveInput(started), answers: { q1: { ...answer(['A']), score: 5 } } },
      { ...saveInput(started), extra: true },
    ]
    for (const input of invalidSaves) {
      await expect(service.saveMathChallenge(input)).rejects.toThrow()
      expect(await readFile(path, 'utf8')).toBe(before)
    }
    await expect(
      service.gradeMathChallenge({
        sessionId: started.id,
        expectedRevision: 0,
        questionId: 'q12',
        score: 5,
      }),
    ).rejects.toThrow(/交卷后/)
    expect(await readFile(path, 'utf8')).toBe(before)

    const submitted = await service.submitMathChallenge({
      sessionId: started.id,
      expectedRevision: 0,
    })
    const submittedBytes = await readFile(path, 'utf8')
    const gradeInput = {
      sessionId: started.id,
      expectedRevision: submitted.revision,
      questionId: 'q12',
      score: 5,
    }
    for (const invalid of [
      { ...gradeInput, score: -1 },
      { ...gradeInput, score: 0.5 },
      { ...gradeInput, score: 6 },
      { ...gradeInput, questionId: 'q1' },
      { ...gradeInput, questionId: 'missing' },
      { ...gradeInput, extra: true },
    ]) {
      await expect(service.gradeMathChallenge(invalid)).rejects.toThrow()
      expect(await readFile(path, 'utf8')).toBe(submittedBytes)
    }
    expect(
      await service.submitMathChallenge({ sessionId: started.id, expectedRevision: 0 }),
    ).toEqual(submitted)
    const graded = await service.gradeMathChallenge(gradeInput)
    const gradedBytes = await readFile(path, 'utf8')
    await expect(service.gradeMathChallenge(gradeInput)).rejects.toThrow(/更新/)
    expect(await readFile(path, 'utf8')).toBe(gradedBytes)
    expect((await service.getMathChallenge(started.id)).revision).toBe(graded.revision)
  })
})
