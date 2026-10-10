import { describe, expect, it } from 'vitest'
import {
  MAX_ADVISOR_SELECTION,
  selectedExcerpt,
  selectionProblem,
} from '../src/domain/advisor-selection'

describe('selection advisor data minimization', () => {
  it('captures only selected text, with no surrounding answer', () => {
    expect(selectedExcerpt('private before SELECTED private after', 15, 23)).toBe('SELECTED')
  })
  it('handles reversed keyboard selection and trims whitespace', () => {
    expect(selectedExcerpt('  hello world  ', 8, 2)).toBe('hello')
  })
  it('does not fall back to the whole value for collapsed or unavailable selections', () => {
    expect(selectedExcerpt('private full answer', 3, 3)).toBe('')
    expect(selectedExcerpt('private full answer', null, null)).toBe('')
  })
  it('requires an explicit smaller selection rather than silently truncating', () => {
    expect(selectionProblem('a'.repeat(MAX_ADVISOR_SELECTION))).toBeNull()
    expect(selectionProblem('a'.repeat(MAX_ADVISOR_SELECTION + 1))).toContain('过长')
    expect(selectionProblem(' \n ')).toContain('选择')
  })
})
