import { expect, it } from 'vitest'
import {
  buildAdvisorContext,
  buildGradingContext,
  buildModuleAdvisorContext,
} from '../src/adapters/review-contexts'
import { sampleQuestions } from '../src/domain/sample-bank'
import { emptyDraft } from '../src/shared/types'

it('freezes a fresh allowlisted grading snapshot with no hint/history/revision state', () => {
  const question = structuredClone(sampleQuestions.find((q) => q.subject === 'history')!)
  const draft = {
    ...emptyDraft(),
    text: 'Confirmed final answer',
    argument: {
      version: 1 as const,
      roots: [{ id: 'a', kind: 'analysis' as const, text: 'Structure', children: [] }],
    },
  }
  Object.assign(draft, {
    advisorHistory: ['PRIVATE_HINT'],
    hint: 'PRIVATE_HINT',
    account: 'PRIVATE_ACCOUNT',
  })
  Object.assign(draft.argument, {
    canvas: { private: 'PRIVATE_CANVAS' },
    revisions: { private: 'PRIVATE_REVISION' },
  })
  Object.assign(draft.argument.roots[0], { hint: 'PRIVATE_NODE_HINT' })
  const payload = buildGradingContext(question, draft)
  const initial = JSON.stringify(payload)
  question.explanation = 'changed'
  draft.text = 'changed'
  draft.argument.roots[0].text = 'changed'
  expect(JSON.stringify(payload)).toBe(initial)
  expect(initial).not.toContain('PRIVATE_')
  expect(Object.isFrozen(payload)).toBe(true)
  expect('argument' in payload.answer && Object.isFrozen(payload.answer.argument!.roots[0])).toBe(
    true,
  )
  expect(() => {
    ;(payload.answer as any).text = 'mutated'
  }).toThrow()
})
it('builds separate advisor contexts with only requested roots/spans and explicit reference flag', () => {
  const question = sampleQuestions.find((q) => q.subject === 'history')!
  const root = { id: 'a', kind: 'analysis' as const, text: 'selected text', children: [] }
  const request = {
    requestId: 'r',
    cloudConsent: true,
    configRevision: 0,
    questionId: question.id,
    includeReference: false,
    scope: 'selected' as const,
    roots: [root],
    selectedSpans: [{ moduleId: 'a', start: 0, end: 8, expectedText: 'selected' }],
  }
  const context = buildModuleAdvisorContext(question, request)
  expect(context.question).toEqual({
    subject: question.subject,
    prompt: question.prompt,
    choices: question.choices,
  })
  expect(context.roots).toEqual([root])
  expect(context.selectedSpans).toEqual(request.selectedSpans)
  request.roots[0].text = 'changed'
  expect(context.roots[0].text).toBe('selected text')
  const hint = buildAdvisorContext(question, {
    requestId: 'r',
    cloudConsent: true,
    configRevision: 0,
    questionId: question.id,
    includeReference: true,
    selectedText: 'selected',
    source: 'answer',
  })
  expect(hint.question.reference).toBe(question.explanation)
  expect(hint.question.rubric).toEqual(question.rubric)
  expect(hint).not.toHaveProperty('roots')
})
