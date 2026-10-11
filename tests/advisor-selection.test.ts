import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  captureAdvisorSelection,
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

describe('selection capture revalidation', () => {
  class ElementFixture {
    parentElement: ElementFixture | null = null
    source: string | null = null
    excluded = false
    tagName = 'DIV'
    constructor(parent?: ElementFixture) {
      this.parentElement = parent ?? null
    }
    contains(node: ElementFixture | null): boolean {
      return node === this || Boolean(node?.parentElement && this.contains(node.parentElement))
    }
    closest(selector: string): ElementFixture | null {
      const matches =
        (selector.includes('[data-advisor-exclude]') && this.excluded) ||
        (selector.includes('[data-advisor-source]') && this.source !== null) ||
        selector.split(',').includes(this.tagName.toLowerCase())
      return matches ? this : (this.parentElement?.closest(selector) ?? null)
    }
    getAttribute(name: string) {
      return name === 'data-advisor-source' ? this.source : null
    }
    getBoundingClientRect() {
      return { left: 20, top: 30, bottom: 130, height: 100 }
    }
  }
  class TextareaFixture extends ElementFixture {
    value = 'private SELECTED rest'
    selectionStart = 8
    selectionEnd = 16
  }
  function setup() {
    const root = new ElementFixture()
    const input = new TextareaFixture(root)
    input.source = 'answer'
    const getSelection = vi.fn(() => null)
    vi.stubGlobal('Element', ElementFixture)
    vi.stubGlobal('HTMLTextAreaElement', TextareaFixture)
    vi.stubGlobal('document', { activeElement: input })
    vi.stubGlobal('window', { getSelection })
    return { root: root as unknown as HTMLElement, input, getSelection }
  }
  afterEach(() => vi.unstubAllGlobals())

  it('revalidates the original textarea after keyboard focus moves to an Advisor action', () => {
    const { root, input } = setup()
    const action = new ElementFixture()
    action.excluded = true
    vi.stubGlobal('document', { activeElement: action })
    expect(captureAdvisorSelection(root, input as unknown as EventTarget)).toMatchObject({
      text: 'SELECTED',
      source: 'answer',
    })
    input.selectionEnd = input.selectionStart
    expect(captureAdvisorSelection(root, input as unknown as EventTarget)).toBeNull()
  })

  it('does not use a document range when the current textarea selection has collapsed', () => {
    const { root, input, getSelection } = setup()
    input.selectionEnd = input.selectionStart
    expect(captureAdvisorSelection(root, input as unknown as EventTarget)).toBeNull()
    expect(getSelection).not.toHaveBeenCalled()
  })

  it('rejects detached source fields and excluded confirmation text', () => {
    const { root, input } = setup()
    input.parentElement = null
    expect(captureAdvisorSelection(root, input as unknown as EventTarget)).toBeNull()
    input.parentElement = root as unknown as ElementFixture
    input.excluded = true
    expect(captureAdvisorSelection(root, input as unknown as EventTarget)).toBeNull()
  })

  it('rejects a collapsed or cleared native selection instead of retaining prior text', () => {
    const { root, getSelection } = setup()
    const prompt = new ElementFixture(root as unknown as ElementFixture)
    getSelection.mockReturnValue({ isCollapsed: true, rangeCount: 1 } as never)
    expect(captureAdvisorSelection(root, prompt as unknown as EventTarget)).toBeNull()
    getSelection.mockReturnValue({ isCollapsed: false, rangeCount: 0 } as never)
    expect(captureAdvisorSelection(root, prompt as unknown as EventTarget)).toBeNull()
  })
})
