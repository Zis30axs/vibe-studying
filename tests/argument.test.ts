import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  argumentFromDraft,
  assertArgumentRoots,
  finalAnswerText,
  generateArgumentText,
  insertArgumentNode,
  moveArgumentNode,
  removeArgumentNode,
} from '../src/domain/argument'
import { argumentSchema, draftSchema, draftWireSchema, validateAnswer } from '../src/domain/schemas'
import { emptyDraft, type ArgumentKind, type ArgumentNode } from '../src/shared/types'
import { sampleQuestions } from '../src/domain/sample-bank'
import { LocalRuleAgent } from '../src/adapters/local-rule-agent'

const node = (
  id: string,
  kind: ArgumentKind = 'analysis',
  children: ArgumentNode[] = [],
): ArgumentNode => ({
  id,
  kind,
  text: id,
  children,
})
const chain = (depth: number, prefix = 'nested'): ArgumentNode =>
  node(`${prefix}-${depth}`, 'point', depth > 1 ? [chain(depth - 1, prefix)] : [])
const tree = () => [node('a'), node('group', 'cause', [node('b'), node('c')]), node('d')]
const document = (roots: ArgumentNode[]) => ({ version: 1 as const, roots })

describe('nested argument operations', () => {
  it('moves through root and nested sockets using pre-removal indexes without mutation', () => {
    const roots = tree()
    const original = structuredClone(roots)
    const reordered = moveArgumentNode(roots, 'a', null, 3)
    expect(reordered.map((n) => n.id)).toEqual(['group', 'd', 'a'])
    const nested = moveArgumentNode(roots, 'a', 'group', 1)
    expect(nested.map((n) => n.id)).toEqual(['group', 'd'])
    expect(nested[0].children.map((n) => n.id)).toEqual(['b', 'a', 'c'])
    const extracted = moveArgumentNode(nested, 'a', null, 0)
    expect(extracted.map((n) => n.id)).toEqual(['a', 'group', 'd'])
    const down = moveArgumentNode(roots, 'b', 'group', 2)
    expect(down[1].children.map((n) => n.id)).toEqual(['c', 'b'])
    expect(moveArgumentNode(roots, 'b', 'group', 1)).toEqual(roots)
    expect(roots).toEqual(original)
    expect(reordered[0]).not.toBe(roots[1])
    expect(reordered[0].children).not.toBe(roots[1].children)
  })

  it('inserts a copied subtree and removes an entire subtree', () => {
    const roots = tree()
    const added = node('contrast', 'contrast', [node('e')])
    const inserted = insertArgumentNode(roots, added, 'group', 1)
    expect(inserted[1].children.map((n) => n.id)).toEqual(['b', 'contrast', 'c'])
    expect(inserted[1].children[1]).not.toBe(added)
    expect(removeArgumentNode(inserted, 'contrast')).toEqual(roots)
    expect(removeArgumentNode(roots, 'group').map((n) => n.id)).toEqual(['a', 'd'])
    expect(roots).toEqual(tree())
  })

  it('rejects invalid targets, indexes, duplicates and self/descendant moves atomically', () => {
    const roots = tree()
    const original = structuredClone(roots)
    for (const action of [
      () => moveArgumentNode(roots, 'group', 'group', 0),
      () => moveArgumentNode(roots, 'group', 'b', 0),
      () => moveArgumentNode(roots, 'missing', null, 0),
      () => moveArgumentNode(roots, 'a', 'missing', 0),
      () => moveArgumentNode(roots, 'a', 'd', 0),
      () => moveArgumentNode(roots, 'a', null, -1),
      () => moveArgumentNode(roots, 'a', null, 4),
      () => moveArgumentNode(roots, 'a', null, 0.5),
      () => moveArgumentNode(roots, 'a', null, Number.NaN),
      () => insertArgumentNode(roots, node('a'), null, 0),
      () => removeArgumentNode(roots, 'missing'),
    ])
      expect(action).toThrow()
    expect(roots).toEqual(original)
  })

  it('rejects excessive depth/node count after moves or insertion without altering the source', () => {
    const roots = [chain(6), node('other')]
    expect(() => moveArgumentNode(roots, 'other', 'nested-1', 0)).toThrow('6 层')
    expect(() => insertArgumentNode(roots, chain(2, 'new'), 'nested-2', 0)).toThrow('6 层')
    const full = Array.from({ length: 80 }, (_, i) => node(`n-${i}`))
    expect(() => insertArgumentNode(full, node('extra'), null, 80)).toThrow('80')
    expect(roots).toEqual([chain(6), node('other')])
    expect(full).toHaveLength(80)
  })

  it('generates stable visual-order text with hierarchy and no answer from empty containers', () => {
    const roots = [node('先提出观点', 'principle')]
    // Generated IDs are opaque identifiers; text may contain any editable prose.
    roots[0].id = 'principle'
    roots.push({
      ...node('relation', 'cause', [node('evidence', 'material'), node('reason')]),
      text: '条件与影响',
    })
    expect(generateArgumentText(roots)).toBe(
      '先提出观点\n\n因果关系：条件与影响\n  1. evidence\n  2. reason',
    )
    expect(generateArgumentText([{ ...node('empty', 'contrast'), text: '  ' }])).toBe('')
    expect(generateArgumentText(moveArgumentNode(roots, 'relation', null, 0))).toMatch(/^因果关系/)
  })
})

describe('safe argument schema and legacy migration', () => {
  it('validates nested trees, bounded MCP shapes, all limits and strict fields', () => {
    expect(argumentSchema.parse(document([chain(6)]))).toEqual(document([chain(6)]))
    expect(argumentSchema.safeParse(document([chain(7)])).success).toBe(false)
    expect(
      argumentSchema.safeParse(document(Array.from({ length: 80 }, (_, i) => node(`n${i}`))))
        .success,
    ).toBe(true)
    expect(
      argumentSchema.safeParse(document(Array.from({ length: 81 }, (_, i) => node(`n${i}`))))
        .success,
    ).toBe(false)
    expect(
      argumentSchema.safeParse(document([{ ...node('big'), text: 'x'.repeat(4000) }])).success,
    ).toBe(true)
    expect(
      argumentSchema.safeParse(document([{ ...node('big'), text: 'x'.repeat(4001) }])).success,
    ).toBe(false)
    const exactly = Array.from({ length: 5 }, (_, i) => ({
      ...node(`n${i}`),
      text: 'x'.repeat(i === 4 ? 3992 : 4000),
    }))
    expect(generateArgumentText(exactly)).toHaveLength(20000)
    exactly[4].text += 'x'
    expect(() => assertArgumentRoots(exactly)).toThrow('20000')
    for (const invalid of [
      { version: 2, roots: [] },
      { version: 1, roots: [], extra: true },
      document([node('a'), node('a')]),
      document([node('constructor')]),
      document([node('leaf', 'analysis', [node('child')])]),
      { version: 1, roots: [{ ...node('a'), command: 'forbidden' }] },
      document([{ ...node('a'), kind: 'unknown' } as unknown as ArgumentNode]),
    ])
      expect(argumentSchema.safeParse(invalid).success).toBe(false)
    const json = z.toJSONSchema(draftWireSchema, { io: 'input' })
    expect(json.properties?.argument).toMatchObject({
      type: 'object',
      properties: { version: { const: 1 }, roots: { type: 'array' } },
    })
    expect(draftSchema.parse({ ...emptyDraft(), argument: document(tree()) }).argument).toEqual(
      document(tree()),
    )
  })

  it('rejects cyclic/shared object graphs before recursive Zod parsing instead of overflowing', () => {
    const cyclic = node('cycle', 'point')
    cyclic.children.push(cyclic)
    const shared = node('shared')
    const children: ArgumentNode[] = []
    for (const roots of [
      [cyclic],
      [node('first', 'point', [shared]), node('second', 'point', [shared])],
      [node('first', 'point', children), node('second', 'point', children)],
    ]) {
      const result = draftSchema.safeParse({ ...emptyDraft(), argument: document(roots) })
      expect(result.success).toBe(false)
      if (!result.success) expect(result.error.message).toMatch(/循环或共享节点/)
      expect(() => generateArgumentText(roots)).toThrow('循环或共享节点')
    }
    let huge = node('deep-leaf')
    for (let index = 0; index < 10000; index++) huge = node(`deep-${index}`, 'point', [huge])
    expect(draftSchema.safeParse({ ...emptyDraft(), argument: document([huge]) }).success).toBe(
      false,
    )
  })

  it('migrates copies of old blocks while preserving independent legacy final text', () => {
    const old = {
      ...emptyDraft(),
      blocks: [
        { id: 'legacy-text-1', category: 'principle' as const, label: '旧标签', text: '旧原理' },
      ],
      text: '新'.repeat(5000),
    }
    const saved = structuredClone(old)
    const migrated = argumentFromDraft(old)
    expect(migrated.roots.map((n) => n.id)).toEqual(['legacy-text-1'])
    expect(migrated.roots[0]).toEqual({
      id: 'legacy-text-1',
      kind: 'principle',
      text: '旧原理',
      children: [],
    })
    expect(old.text).toBe('新'.repeat(5000))
    expect(argumentFromDraft({ ...emptyDraft(), text: old.text }).roots).toEqual([])
    expect(old).toEqual(saved)
    expect(draftSchema.parse(old)).toEqual(old)
    const current = { ...old, argument: document(tree()) }
    expect(argumentFromDraft(current)).toEqual(current.argument)
    expect(argumentFromDraft(current).roots).not.toBe(current.argument.roots)
  })

  it('keeps oversized legacy records readable but refuses lossy migration', () => {
    const old = {
      ...emptyDraft(),
      text: 'x'.repeat(20000),
      blocks: Array.from({ length: 6 }, (_, i) => ({
        id: `old-${i}`,
        category: 'analysis' as const,
        label: '',
        text: 'y'.repeat(4000),
      })),
    }
    expect(draftSchema.safeParse(old).success).toBe(true)
    expect(() => argumentFromDraft(old)).toThrow('20000')
    expect(old.text).toHaveLength(20000)
  })
})

describe('current final answer and honest local review', () => {
  it('requires explicit final text for structured humanities answers and ignores stale legacy words', async () => {
    const question = sampleQuestions.find((q) => q.id === 'pol-assembly-1')!
    const legacy = { ...emptyDraft(), blocks: question.blocks!.slice(0, 4) }
    expect((await new LocalRuleAgent().review(question, legacy)).score).toBe(question.maxScore)
    const current = {
      ...legacy,
      text: '这次答案尚未覆盖要点。',
      argument: argumentFromDraft(legacy),
    }
    expect(finalAnswerText(current)).toBe(current.text)
    const review = await new LocalRuleAgent().review(question, current)
    expect(review.score).toBe(0)
    expect(review.feedback).toContain('不代表考试得分')
    expect(review.feedback).toContain('嵌套结构或因果关系')
    expect(() => validateAnswer(question, { ...current, text: '' }, true)).toThrow('填写')
  })

  it('accepts current final answers for every humanities subject and retains geography drawing-only', () => {
    for (const subject of ['chinese', 'politics', 'history', 'geography'] as const) {
      const question = sampleQuestions.find((q) => q.kind === subject)!
      const current = { ...emptyDraft(), text: '当前最终答案', argument: document(tree()) }
      expect(validateAnswer(question, current, true)).toEqual(current)
    }
    const geography = sampleQuestions.find((q) => q.kind === 'geography')!
    const drawingOnly = {
      ...emptyDraft(),
      argument: document([]),
      drawing: {
        mode: 'cartesian' as const,
        points: [{ id: 'a', x: 0, y: 0, label: '' }],
        lines: [],
      },
    }
    expect(validateAnswer(geography, drawingOnly, true)).toEqual(drawingOnly)
  })
})
