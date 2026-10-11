import { describe, expect, it } from 'vitest'
import { filterStudyQuestions, isStudyView } from '../src/domain/study-question-context'
import { sampleQuestions } from '../src/domain/sample-bank'

describe('visible study question scope', () => {
  it('retains math, geography and humanities route restrictions without depending on auxiliary routes', () => {
    expect(sampleQuestions[0].subject).toBe('politics')
    for (const view of ['math', 'geography', 'politics'] as const) {
      const filtered = filterStudyQuestions(sampleQuestions, view, 'all', '')
      expect(filtered.length).toBeGreaterThan(0)
      if (view === 'math') expect(filtered.every((q) => q.subject === 'math')).toBe(true)
      if (view === 'geography') expect(filtered.every((q) => q.kind === 'geography')).toBe(true)
      if (view === 'politics')
        expect(
          filtered.every((q) => ['politics', 'history', 'chinese', 'geography'].includes(q.kind)),
        ).toBe(true)
    }
  })
  it('keeps search and subject intersections empty instead of choosing from the whole bank', () => {
    expect(filterStudyQuestions(sampleQuestions, 'math', 'politics', '')).toEqual([])
    expect(
      filterStudyQuestions(sampleQuestions, 'practice', 'all', 'no such question 923a'),
    ).toEqual([])
    expect(filterStudyQuestions([], 'practice', 'all', '')).toEqual([])
    const math = sampleQuestions.find((q) => q.subject === 'math')!
    expect(
      filterStudyQuestions(sampleQuestions, 'math', 'all', math.title).map((q) => q.id),
    ).toEqual([math.id])
  })
  it('only explicit study routes can replace the last study scope', () => {
    for (const route of ['practice', 'math', 'politics', 'geography'])
      expect(isStudyView(route)).toBe(true)
    for (const route of ['agent', 'formulas', 'history', 'adapters', ''])
      expect(isStudyView(route)).toBe(false)
  })
})

import {
  navigateStudyQuestionContext,
  type StudyQuestionContext,
} from '../src/domain/study-question-context'

function visible(context: StudyQuestionContext) {
  const list = filterStudyQuestions(sampleQuestions, context.view, context.subject, context.query)
  return list.find((q) => q.id === context.selectedId) ?? list[0]
}
function navigate(context: StudyQuestionContext, next: string, fromStudy = true) {
  return navigateStudyQuestionContext(
    context,
    next,
    fromStudy ? { id: visible(context)?.id ?? '' } : undefined,
  )
}
const initial: StudyQuestionContext = {
  view: 'practice',
  subject: 'all',
  query: '',
  selectedId: sampleQuestions[0].id,
}

describe('question context transitions used by App navigation', () => {
  it('promotes the visible math fallback before opening Agent instead of restoring initial politics', () => {
    expect(visible(initial)?.subject).toBe('politics')
    const math = navigate(initial, 'math')
    expect(math.selectedId).toBe(initial.selectedId)
    expect(visible(math)?.subject).toBe('math')
    const agent = navigate(math, 'agent')
    expect(agent.selectedId).toBe(visible(math)?.id)
    expect(visible(agent)?.subject).toBe('math')
    expect(visible(agent)?.id).not.toBe(initial.selectedId)
    expect(navigate(agent, 'math', false)).toEqual(agent)
  })
  it('retains explicit selections and filtered fallbacks through auxiliary pages', () => {
    const mathQuestions = filterStudyQuestions(sampleQuestions, 'math', 'all', '')
    const explicit: StudyQuestionContext = {
      view: 'math',
      subject: 'math',
      query: '',
      selectedId: mathQuestions[1].id,
    }
    expect(navigate(explicit, 'agent').selectedId).toBe(mathQuestions[1].id)
    const search = { ...explicit, query: mathQuestions[0].title }
    for (const route of ['agent', 'formulas', 'history', 'adapters']) {
      const away = navigate(search, route)
      expect(away).toEqual({ ...search, selectedId: mathQuestions[0].id })
      expect(navigate(away, 'math', false)).toEqual(away)
    }
  })
  it('keeps empty search and subject intersections empty through Agent and back', () => {
    for (const empty of [
      { ...initial, query: 'no such question 923a' },
      { ...initial, view: 'math' as const, subject: 'politics' as const },
    ]) {
      expect(visible(empty)).toBeUndefined()
      const away = navigate(empty, 'agent')
      expect(away.selectedId).toBe('')
      expect(visible(away)).toBeUndefined()
      const back = navigate(away, empty.view, false)
      expect(visible(back)).toBeUndefined()
      expect(back.query).toBe(empty.query)
      expect(back.subject).toBe(empty.subject)
    }
  })
  it('keeps geography and humanities question identity, and resets filters only on another study route', () => {
    for (const route of ['geography', 'politics'] as const) {
      const study = navigate(initial, route)
      const scoped = route === 'politics' ? { ...study, subject: 'history' as const } : study
      const question = visible(scoped)!
      const away = navigate(scoped, 'agent')
      expect(visible(away)?.id).toBe(question.id)
      expect(visible(away)?.subject).toBe(route === 'politics' ? 'history' : 'geography')
      const next = navigate(away, 'math', false)
      expect(next.subject).toBe('all')
      expect(next.query).toBe('')
      expect(visible(next)?.subject).toBe('math')
    }
  })
  it('does not replace an explicit auxiliary-page selection without visible evidence', () => {
    const restored = { ...initial, selectedId: 'restored-history-question' }
    expect(navigateStudyQuestionContext(restored, 'agent').selectedId).toBe(
      'restored-history-question',
    )
  })
})
