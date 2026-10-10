import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalQuestionBank } from '../src/adapters/local-question-bank'
import { LocalRuleAgent } from '../src/adapters/local-rule-agent'
import { sampleQuestions } from '../src/domain/sample-bank'
import { listStudentQuestions, studentQuestionProjection } from '../src/domain/student-question'
import { StudyService } from '../src/domain/study-service'
import { emptyDraft, type Question, type StudentQuestion } from '../src/shared/types'

const publicFields = ['id', 'subject', 'kind', 'title', 'prompt', 'source', 'tags', 'maxScore']

describe('student question boundary', () => {
  it('allowlists nested public data even when a bank returns unexpected reference fields', async () => {
    const question = {
      ...sampleQuestions.find((item) => item.kind === 'choice')!,
      reference: { secret: 'TOP_LEVEL_REFERENCE_SENTINEL' },
      blocks: [{ text: 'ANSWER_BLOCK_SENTINEL', label: 'ANSWER_LABEL_SENTINEL' }],
      rubric: [{ label: 'RUBRIC_SENTINEL' }],
      explanation: 'EXPLANATION_SENTINEL',
      correctAnswer: 'ANSWER_KEY_SENTINEL',
      choices: [{ id: 'A', text: 'Visible choice', reference: 'NESTED_REFERENCE_SENTINEL' }],
    } as unknown as Question
    const before = structuredClone(question)
    const result = await listStudentQuestions({ list: async () => [question] })
    expect(Object.keys(result[0]).sort()).toEqual([...publicFields, 'choices'].sort())
    expect(result[0].choices).toEqual([{ id: 'A', text: 'Visible choice' }])
    expect(JSON.stringify(result)).not.toContain('SENTINEL')
    expect(question).toEqual(before)
    result[0].tags.push('renderer-only')
    result[0].choices![0].text = 'renderer modification'
    expect(question).toEqual(before)
  })

  it('omits all reference blocks rather than leaking sample answers through labels or IDs', () => {
    for (const question of sampleQuestions) {
      const student: StudentQuestion = studentQuestionProjection(question)
      for (const field of ['explanation', 'rubric', 'correctAnswer', 'blocks'])
        expect(student).not.toHaveProperty(field)
      expect(student.prompt).toBe(question.prompt)
      expect(Object.keys(student).sort()).toEqual(
        [...publicFields, ...(question.choices ? ['choices'] : [])].sort(),
      )
    }
  })

  it('wires the renderer-facing list endpoint to the allowlist boundary', async () => {
    const main = await readFile(new URL('../electron/main.ts', import.meta.url), 'utf8')
    expect(main).toContain("handle('examcraft:list-questions', () => listStudentQuestions(bank))")
    expect(main).not.toContain("handle('examcraft:list-questions', () => bank.list())")
  })
})

describe('private question persistence and grading remain intact', () => {
  let directory: string
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'examcraft-student-boundary-'))
  })
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('leaves imported bank data, prior drafts and attempts untouched while hiding references in list', async () => {
    const bank = new LocalQuestionBank(directory)
    const imported = {
      ...sampleQuestions.find((item) => item.blocks?.length)!,
      id: 'legacy-private',
    }
    await bank.importBank({ version: 1, questions: [imported] })
    const service = new StudyService(directory, bank, new LocalRuleAgent())
    const legacyDraft = { ...emptyDraft(), blocks: structuredClone(imported.blocks!.slice(0, 4)) }
    const attempt = await service.submitAnswer(imported.id, legacyDraft)
    const previousState = await readFile(join(directory, 'study-state.json'), 'utf8')
    const projected = (await listStudentQuestions(bank)).find((item) => item.id === imported.id)!
    expect(projected).not.toHaveProperty('blocks')
    expect(projected).not.toHaveProperty('rubric')
    expect(await bank.get(imported.id)).toEqual(imported)
    expect(await readFile(join(directory, 'study-state.json'), 'utf8')).toBe(previousState)
    expect(attempt.score).toBe(imported.maxScore)
    expect(attempt.explanation).toBe(imported.explanation)
    expect(attempt.rubric).toHaveLength(imported.rubric!.length)
    const changed = structuredClone(legacyDraft)
    changed.blocks[0].text = 'Edited after grading'
    await service.saveDraft(imported.id, changed)
    const restarted = new StudyService(
      directory,
      new LocalQuestionBank(directory),
      new LocalRuleAgent(),
    )
    const state = await restarted.loadState()
    expect(state.attempts).toEqual([attempt])
    expect(state.attempts[0].draft).toEqual(legacyDraft)
    expect(state.drafts[imported.id]).toEqual(changed)
    expect(await restarted.bank.get(imported.id)).toEqual(imported)
  })

  it('retains the private choice key for authoritative grading but never includes it in listings', async () => {
    const bank = new LocalQuestionBank(directory)
    const privateQuestion = await bank.get('pol-choice-1')
    const question = (await listStudentQuestions(bank)).find(
      (item) => item.id === privateQuestion.id,
    )!
    expect(question).not.toHaveProperty('correctAnswer')
    const service = new StudyService(directory, bank, new LocalRuleAgent())
    const result = await service.submitAnswer(question.id, {
      ...emptyDraft(),
      choiceId: privateQuestion.correctAnswer,
    })
    expect(result.score).toBe(privateQuestion.maxScore)
    expect(result.explanation).toBe(privateQuestion.explanation)
  })
})
