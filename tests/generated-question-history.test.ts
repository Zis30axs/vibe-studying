import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalQuestionBank } from '../src/adapters/local-question-bank'
import { LocalRuleAgent } from '../src/adapters/local-rule-agent'
import { StudyService } from '../src/domain/study-service'
import { studentQuestionProjection } from '../src/domain/student-question'
import { buildAdvisorContext, buildGradingContext } from '../src/adapters/review-contexts'
import { attemptSchema, questionBankSchema } from '../src/domain/schemas'
import { emptyDraft } from '../src/shared/types'
import { exampleGeneratedQuestion } from './fixtures/geography-generation'
const dirs: string[] = []
afterEach(async () => {
  for (const path of dirs.splice(0)) await rm(path, { recursive: true, force: true })
})
it('generated diagram and private rubric persist while history snapshots stay student-safe and immutable', async () => {
  const path = await mkdtemp(join(tmpdir(), 'examcraft-generated-history-'))
  dirs.push(path)
  const bank = new LocalQuestionBank(path)
  await bank.importBank({ version: 1, questions: [exampleGeneratedQuestion] })
  const restoredBank = new LocalQuestionBank(path)
  const question = await restoredBank.get(exampleGeneratedQuestion.id)
  expect(question.figure).toEqual(exampleGeneratedQuestion.figure)
  expect(question.rubric).toEqual(exampleGeneratedQuestion.rubric)
  const safe = studentQuestionProjection(question)
  expect(safe).not.toHaveProperty('explanation')
  expect(safe).not.toHaveProperty('rubric')
  const service = new StudyService(path, restoredBank, new LocalRuleAgent())
  const draft = { ...emptyDraft(), text: '一般条件下，上游侵蚀较强，下游流速减缓可能堆积。' }
  await service.saveDraft(question.id, draft)
  const attempt = await service.submitAnswer(question.id, draft)
  expect(attempt.questionSnapshot).toEqual(safe)
  safe.figure!.points[0].label = '客户端后来修改'
  expect(attempt.questionSnapshot!.figure!.points[0].label).toBe('上游')
  const restarted = await new StudyService(
    path,
    new LocalQuestionBank(path),
    new LocalRuleAgent(),
  ).loadState()
  expect(restarted.attempts[0].questionSnapshot).toEqual(studentQuestionProjection(question))
  expect(restarted.drafts[question.id].text).toBe(draft.text)
  expect(
    attemptSchema.safeParse({
      ...attempt,
      questionSnapshot: { ...attempt.questionSnapshot, id: 'other' },
    }).success,
  ).toBe(false)
  const legacy = { ...attempt }
  delete legacy.questionSnapshot
  expect(attemptSchema.safeParse(legacy).success).toBe(true)
})
it('diagram is explicit factual input for advisor and grading, with no teacher fields without consent', () => {
  const context = buildAdvisorContext(exampleGeneratedQuestion, {
    requestId: 'figure-hint',
    questionId: exampleGeneratedQuestion.id,
    selectedText: '上游',
    source: 'question',
    includeReference: false,
    cloudConsent: true,
    configRevision: 1,
  })
  expect(context.question.figure).toEqual(exampleGeneratedQuestion.figure)
  expect(context.question).not.toHaveProperty('reference')
  expect(context.question).not.toHaveProperty('rubric')
  const grading = buildGradingContext(exampleGeneratedQuestion, {
    ...emptyDraft(),
    text: '侵蚀与堆积',
  })
  expect(grading.question.figure).toEqual(exampleGeneratedQuestion.figure)
  expect(grading.question.reference).toBe(exampleGeneratedQuestion.explanation)
  expect(Object.isFrozen(grading.question.figure)).toBe(true)
  const old = { ...exampleGeneratedQuestion }
  delete old.figure
  delete old.provenance
  expect(questionBankSchema.safeParse({ version: 1, questions: [old] }).success).toBe(true)
})
