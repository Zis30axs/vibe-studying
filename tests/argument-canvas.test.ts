import { describe, expect, it } from 'vitest'
import {
  argumentCanvas,
  argumentFromDraft,
  flattenArgument,
  generateArgumentText,
  moveArgumentNode,
  positionArgumentNode,
  removeArgumentNode,
} from '../src/domain/argument'
import { argumentSchema, draftSchema, draftWireSchema } from '../src/domain/schemas'
import { emptyDraft, type ArgumentDocument, type ArgumentNode } from '../src/shared/types'

const node = (id: string, children: ArgumentNode[] = []): ArgumentNode => ({
  id,
  kind: children.length ? 'point' : 'analysis',
  text: `Text ${id}`,
  children,
})
const legacy = (): ArgumentDocument => ({
  version: 1,
  roots: [node('parent', [node('child')]), node('last')],
})

describe('independent free canvas', () => {
  it('lays out old trees without mutating or flattening their logical content', () => {
    const document = legacy(),
      original = structuredClone(document)
    const canvas = argumentCanvas(document)
    expect(document).toEqual(original)
    expect(Object.keys(canvas.positions)).toEqual(['parent', 'child', 'last'])
    expect(new Set(Object.values(canvas.positions).map((p) => `${p.x},${p.y}`)).size).toBe(3)
    expect(flattenArgument(document.roots).map((item) => [item.path, item.parentId])).toEqual([
      ['1', null],
      ['1.1', 'parent'],
      ['2', null],
    ])
    expect(argumentCanvas(document)).toEqual(canvas)
  })

  it('moves to arbitrary fractional and negative coordinates without changing text, order, or parents', () => {
    const document = legacy(),
      original = structuredClone(document)
    const before = generateArgumentText(document.roots)
    const next = positionArgumentNode(document, 'child', { x: -171.25, y: 908.75 })
    expect(next.canvas!.positions.child).toEqual({ x: -171.25, y: 908.75 })
    expect(next.roots).toEqual(document.roots)
    expect(generateArgumentText(next.roots)).toBe(before)
    expect(document).toEqual(original)
    expect(next.roots).not.toBe(document.roots)
    expect(argumentSchema.parse(next)).toEqual(next)
  })

  it('keeps saved positions when changing logical parent/order and drops deleted subtree coordinates', () => {
    const document = positionArgumentNode(legacy(), 'child', { x: 789, y: -110 })
    const reordered = { ...document, roots: moveArgumentNode(document.roots, 'child', null, 0) }
    expect(argumentCanvas(reordered).positions).toEqual(document.canvas!.positions)
    const removed = { ...document, roots: removeArgumentNode(document.roots, 'parent') }
    expect(Object.keys(argumentCanvas(removed).positions)).toEqual(['last'])
    expect(document.canvas!.positions.child).toEqual({ x: 789, y: -110 })
  })

  it('round trips free positions and viewport through persisted and wire drafts', () => {
    const document = positionArgumentNode(legacy(), 'last', { x: 547.125, y: 319.5 })
    document.canvas!.viewport = { x: -321, y: 15, zoom: 0.75 }
    const draft = { ...emptyDraft(), argument: document, text: 'Independent manual answer' }
    const persisted = draftSchema.parse(JSON.parse(JSON.stringify(draft)))
    expect(argumentFromDraft(persisted)).toEqual(document)
    expect(draftWireSchema.parse(draft)).toEqual(draft)
    expect(persisted.text).toBe('Independent manual answer')
    expect(argumentFromDraft(persisted).canvas).not.toBe(persisted.argument!.canvas)
  })

  it('rejects nonfinite, out-of-bounds and unsafe canvas values and unknown fields', () => {
    const base = positionArgumentNode(legacy(), 'last', { x: 0, y: 0 })
    for (const value of [NaN, Infinity, -Infinity, 100001, -100001]) {
      const document = structuredClone(base)
      document.canvas!.positions.last.x = value
      expect(argumentSchema.safeParse(document).success).toBe(false)
    }
    for (const zoom of [0, 0.14, 2.01, Infinity, NaN]) {
      const document = structuredClone(base)
      document.canvas!.viewport.zoom = zoom
      expect(argumentSchema.safeParse(document).success).toBe(false)
    }
    expect(
      argumentSchema.safeParse({ ...base, canvas: { ...base.canvas, surprise: true } }).success,
    ).toBe(false)
    const unsafe = JSON.parse('{"__proto__":{"x":1,"y":2}}')
    expect(
      argumentSchema.safeParse({ ...base, canvas: { ...base.canvas, positions: unsafe } }).success,
    ).toBe(false)
    expect(() => positionArgumentNode(base, 'missing', { x: 1, y: 2 })).toThrow()
    expect(() => positionArgumentNode(base, 'last', { x: NaN, y: 2 })).toThrow()
  })
})
