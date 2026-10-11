import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExamCraftApi, StudentQuestion } from '../src/shared/types'

// Exercise the component's real event handlers without a DOM renderer. Rendering
// and keyboard activation of the floating action are covered by advisor.spec.ts.
const hooks = vi.hoisted(() => ({
  effects: [] as (() => void | (() => void))[],
  stateIndex: 0,
  setSnapshot: vi.fn(),
}))
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useEffect: (effect: () => void | (() => void)) => hooks.effects.push(effect),
  useCallback: (callback: unknown) => callback,
  useRef: (value: unknown) => ({ current: value }),
  useState: (value: unknown) => [value, hooks.stateIndex++ === 0 ? hooks.setSnapshot : vi.fn()],
}))
import { SelectionAdvisor } from '../src/components/SelectionAdvisor'

class EventSource {
  listeners = new Map<string, Set<EventListener>>()
  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }
  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener)
  }
  emit(event: Event, target: EventSource = this) {
    Object.defineProperty(event, 'target', { value: target })
    for (const listener of this.listeners.get(event.type) ?? []) listener(event)
  }
}
class ElementFixture extends EventSource {
  constructor(readonly parentElement: ElementFixture | null = null) {
    super()
  }
  contains(node: ElementFixture | null): boolean {
    return node === this || Boolean(node?.parentElement && this.contains(node.parentElement))
  }
  closest() {
    return null
  }
  getBoundingClientRect() {
    return { left: 20, top: 30, height: 100 }
  }
}
class TextareaFixture extends ElementFixture {
  value = 'selected phrase'
  selectionStart = 0
  selectionEnd = 8
}
class KeyboardFixture extends Event {
  constructor(readonly key: string) {
    super('keyup')
  }
}
const cleanups: (() => void)[] = []
beforeEach(() => {
  hooks.effects = []
  hooks.stateIndex = 0
  hooks.setSnapshot.mockClear()
})
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  vi.unstubAllGlobals()
})
function setup() {
  const root = new ElementFixture()
  const input = new TextareaFixture(root)
  const document = Object.assign(new EventSource(), { activeElement: input })
  const window = new EventSource()
  vi.stubGlobal('Node', ElementFixture)
  vi.stubGlobal('Element', ElementFixture)
  vi.stubGlobal('HTMLTextAreaElement', TextareaFixture)
  vi.stubGlobal('KeyboardEvent', KeyboardFixture)
  vi.stubGlobal('document', document)
  vi.stubGlobal('window', window)
  SelectionAdvisor({
    api: { cancelAdvisor: vi.fn(async () => {}) } as unknown as ExamCraftApi,
    config: null,
    question: { id: 'question1', subject: 'history' } as StudentQuestion,
    sourceRevision: 'revision1',
    scopeRef: { current: root as unknown as HTMLElement },
  })
  for (const effect of hooks.effects) {
    const cleanup = effect()
    if (cleanup) cleanups.push(cleanup)
  }
  root.emit(new Event('select'), input)
  expect(hooks.setSnapshot).toHaveBeenLastCalledWith(
    expect.objectContaining({ text: 'selected', source: 'answer' }),
  )
  window.emit(new Event('blur'))
  expect(hooks.setSnapshot).toHaveBeenLastCalledWith(null)
  hooks.setSnapshot.mockClear()
  return { root, input, document, window }
}

describe('Advisor selection events after window blur', () => {
  it('ignores a queued textarea select even when activeElement and its range are unchanged', () => {
    const { root, input, document } = setup()
    expect(document.activeElement).toBe(input)
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 8])
    root.emit(new Event('select'), input)
    document.emit(new Event('selectionchange'))
    expect(hooks.setSnapshot).not.toHaveBeenCalled()
  })
  it('does not revive the old selection on focus alone', () => {
    const { root, input, document, window } = setup()
    window.emit(new Event('focus'))
    document.emit(new Event('focusin'), input)
    root.emit(new Event('select'), input)
    expect(hooks.setSnapshot).not.toHaveBeenCalled()
  })
  it.each(['keyboard', 'pointer'])('accepts a fresh %s selection after blur', (gesture) => {
    const { root, input, document } = setup()
    input.selectionStart = 9
    input.selectionEnd = 15
    if (gesture === 'keyboard') document.emit(new KeyboardFixture('ArrowRight'), input)
    else {
      document.emit(new Event('pointerdown'), input)
      root.emit(new Event('select'), input)
      document.emit(new Event('pointerup'), input)
    }
    expect(hooks.setSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: 'phrase', source: 'answer' }),
    )
  })
})
