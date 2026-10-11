import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  argumentCanvas,
  argumentFromDraft,
  flattenArgument,
  generateArgumentText,
  removeArgumentNode,
} from '../src/domain/argument'
import {
  argumentGroupBounds,
  assertArgumentGroups,
  duplicateArgumentGroup,
  extractArgumentNode,
  findArgumentSnapTarget,
  isArgumentNodeOutsideGroup,
  mergeArgumentEntities,
  pruneArgumentGroups,
  removeArgumentGroup,
  reviewArgumentGroups,
  translateArgumentEntity,
  ungroupArgument,
} from '../src/domain/argument-groups'
import {
  checkpointArgument,
  checkpointAcceptedEdit,
  hasArgumentDraftChanges,
  restoreArgumentRevision,
} from '../src/domain/argument-revisions'
import { argumentSchema, draftSchema, draftWireSchema } from '../src/domain/schemas'
import { MODULE_REVIEW_PROMPT, validateModuleReviewRequest } from '../src/domain/module-review'
import { buildGradingContext, buildModuleAdvisorContext } from '../src/adapters/review-contexts'
import { LocalQuestionBank } from '../src/adapters/local-question-bank'
import { LocalRuleAgent } from '../src/adapters/local-rule-agent'
import { StudyService } from '../src/domain/study-service'
import {
  emptyDraft,
  type ArgumentDocument,
  type ArgumentNode,
  type ModuleReviewRequest,
  type Question,
} from '../src/shared/types'
import { safeModelDebugPaths } from '../src/shared/model-debug'

const node = (id: string, children: ArgumentNode[] = []): ArgumentNode => ({
  id,
  kind: children.length ? 'point' : 'analysis',
  text: `Synthetic ${id}`,
  children,
})
function initial(): ArgumentDocument {
  const document: ArgumentDocument = {
    version: 1,
    roots: [node('a', [node('b')]), node('c'), node('d')],
  }
  return { ...document, canvas: argumentCanvas(document) }
}
const entity = (id: string) => ({ type: 'node' as const, id })
const grouped = () => mergeArgumentEntities(initial(), entity('b'), entity('a'), 'g1')
const question: Question = {
  id: 'synthetic',
  subject: 'history',
  kind: 'history',
  title: '合成分题',
  prompt: '（1）说明原因。（2）分析影响。',
  source: '原创合成测试',
  tags: [],
  maxScore: 1,
  explanation: 'REFERENCE_NOT_AUTHORIZED',
  rubric: [{ id: 'r', label: 'RUBRIC_NOT_AUTHORIZED', keywords: [], points: 1 }],
}
const request = (document: ArgumentDocument, roots = document.roots): ModuleReviewRequest => ({
  requestId: 'synthetic-review',
  cloudConsent: true,
  configRevision: 1,
  scope: 'selected',
  questionId: question.id,
  includeReference: false,
  roots,
  groups: reviewArgumentGroups(document, roots),
})

describe('explicit compact humanities groups', () => {
  it('migrates old drafts with no proximity inference and keeps final text/order/parentage independent', () => {
    const before = initial(),
      original = structuredClone(before)
    const merged = mergeArgumentEntities(before, entity('b'), entity('a'), 'g1')
    expect(merged.groups).toEqual([{ id: 'g1', label: '', memberIds: ['a', 'b'] }])
    expect(merged.roots).toEqual(before.roots)
    expect(generateArgumentText(merged.roots)).toBe(generateArgumentText(before.roots))
    expect(before).toEqual(original)
    expect(argumentFromDraft({ ...emptyDraft(), argument: before })).not.toHaveProperty('groups')
    expect(merged.canvas!.positions.b.y - merged.canvas!.positions.a.y).toBe(136)
    expect(merged.canvas!.positions.a.x).toBe(merged.canvas!.positions.b.x)
  })
  it('merges groups without nesting and preserves the target ID, label and explicit member order', () => {
    let document = mergeArgumentEntities(grouped(), entity('d'), entity('c'), 'g2')
    document.groups![1].label = '第二小题（学生标签）'
    document = mergeArgumentEntities(
      document,
      { type: 'group', id: 'g1' },
      { type: 'group', id: 'g2' },
      'unused',
    )
    expect(document.groups).toEqual([
      { id: 'g2', label: '第二小题（学生标签）', memberIds: ['c', 'd', 'a', 'b'] },
    ])
    expect(() =>
      mergeArgumentEntities(document, entity('a'), { type: 'group', id: 'g2' }),
    ).toThrow()
    expect(() =>
      mergeArgumentEntities(document, { type: 'group', id: 'g2' }, { type: 'group', id: 'g2' }),
    ).toThrow()
  })
  it('preserves both explicit labels when merging and rejects overflow rather than silently dropping a label', () => {
    const document = mergeArgumentEntities(grouped(), entity('d'), entity('c'), 'g2')
    document.groups![0].label = '第一小题'
    document.groups![1].label = '第二小题'
    const merged = mergeArgumentEntities(
      document,
      { type: 'group', id: 'g1' },
      { type: 'group', id: 'g2' },
    )
    expect(merged.groups![0].label).toBe('第二小题 / 第一小题')
    const before = structuredClone(document)
    document.groups![0].label = '长'.repeat(120)
    expect(() =>
      mergeArgumentEntities(document, { type: 'group', id: 'g1' }, { type: 'group', id: 'g2' }),
    ).toThrow(/标签超过/)
    expect(document.groups).toHaveLength(2)
    expect(document.canvas).toEqual(before.canvas)
  })
  it('bounds large groups and fails duplicate overflow atomically at the existing node limit', () => {
    const document: ArgumentDocument = {
      version: 1,
      roots: Array.from({ length: 80 }, (_, index) => node(`n${index}`)),
      groups: [
        {
          id: 'large',
          label: '',
          memberIds: Array.from({ length: 80 }, (_, index) => `n${index}`),
        },
      ],
    }
    const before = structuredClone(document)
    expect(argumentSchema.safeParse(document).success).toBe(true)
    expect(() => duplicateArgumentGroup(document, 'large')).toThrow(/80/)
    expect(document).toEqual(before)
    expect(() =>
      assertArgumentGroups(
        Array.from({ length: 41 }, (_, index) => ({
          id: `g${index}`,
          label: '',
          memberIds: ['n0', 'n1'],
        })),
        document.roots,
      ),
    ).toThrow(/40/)
  })
  it('moves every group member by one delta without mutating membership, logical edges or free nodes', () => {
    const document = grouped(),
      before = structuredClone(document)
    const canvas = translateArgumentEntity(document, { type: 'group', id: 'g1' }, -47.5, 98)
    for (const id of ['a', 'b'])
      expect(canvas.positions[id]).toEqual({
        x: before.canvas!.positions[id].x - 47.5,
        y: before.canvas!.positions[id].y + 98,
      })
    expect(canvas.positions.c).toEqual(before.canvas!.positions.c)
    expect(document).toEqual(before)
    expect(() => translateArgumentEntity(document, entity('a'), NaN, 0)).toThrow()
    expect(() => translateArgumentEntity(document, { type: 'group', id: 'absent' }, 1, 2)).toThrow()
    const limit = translateArgumentEntity(document, { type: 'group', id: 'g1' }, 1e9, 1e9)
    expect(limit.positions.b.y - limit.positions.a.y).toBe(136)
    expect(Math.max(limit.positions.a.y, limit.positions.b.y)).toBe(100000)
  })
  it('previews nearby entities but never mutates or groups on inspection, including scaled/panned canvases', () => {
    const document = initial(),
      original = structuredClone(document)
    const canvas = argumentCanvas(document)
    canvas.positions.a = { x: 0, y: 0 }
    canvas.positions.b = { x: 400, y: 0 }
    canvas.positions.c = { x: 224 + 18, y: 0 }
    canvas.positions.d = { x: 900, y: 0 }
    canvas.viewport = { x: 812, y: -450, zoom: 0.25 }
    expect(findArgumentSnapTarget(document, entity('a'), canvas)).toEqual(entity('c'))
    canvas.positions.c.x += 1
    expect(findArgumentSnapTarget(document, entity('a'), canvas)).toBeNull()
    expect(document).toEqual(original)
    const group = grouped()
    expect(findArgumentSnapTarget(group, entity('b'), group.canvas!)).not.toEqual({
      type: 'group',
      id: 'g1',
    })
  })
  it('extracts explicitly selected children and cleans up singleton groups, leaving logical relations unchanged', () => {
    const document = grouped(),
      before = structuredClone(document)
    const moved = translateArgumentEntity(document, entity('b'), 500, 0)
    expect(isArgumentNodeOutsideGroup(document, 'b', moved)).toBe(true)
    expect(isArgumentNodeOutsideGroup(document, 'b', document.canvas!)).toBe(false)
    const next = extractArgumentNode(document, 'b', moved.positions.b)
    expect(next.groups).toEqual([])
    expect(next.roots).toEqual(before.roots)
    expect(next.canvas!.positions.b).toEqual(moved.positions.b)
    expect(document).toEqual(before)
    expect(extractArgumentNode(initial(), 'c')).toEqual(initial())
  })
  it('re-packs remaining members after extraction while preserving the original group identity', () => {
    const document = mergeArgumentEntities(grouped(), entity('c'), { type: 'group', id: 'g1' })
    const next = extractArgumentNode(document, 'b')
    expect(next.groups![0]).toEqual({ id: 'g1', label: '', memberIds: ['a', 'c'] })
    expect(next.canvas!.positions.c.y - next.canvas!.positions.a.y).toBe(136)
    expect(next.canvas!.positions.b.x).toBeGreaterThan(
      argumentGroupBounds(next.groups![0], next.canvas!).x + 224,
    )
  })
  it('ungroups without moving or losing content and prunes deleted descendants from all groups', () => {
    const document = grouped()
    const ungrouped = ungroupArgument(document, 'g1')
    expect(ungrouped.canvas).toEqual(document.canvas)
    expect(ungrouped.roots).toEqual(document.roots)
    expect(ungrouped.groups).toEqual([])
    expect(() => ungroupArgument(document, 'missing')).toThrow()
    expect(
      pruneArgumentGroups({ ...document, roots: removeArgumentNode(document.roots, 'b') }).groups,
    ).toEqual([])
    const removed = removeArgumentGroup(document, 'g1')
    expect(flattenArgument(removed.roots).map(({ node }) => node.id)).toEqual(['c', 'd'])
    expect(Object.keys(removed.canvas!.positions)).toEqual(['c', 'd'])
  })
  it('duplicates a group with fresh IDs, copied nested content once and independent grouping', () => {
    const document = grouped()
    let count = 0
    const next = duplicateArgumentGroup(document, 'g1', () => `copy-${++count}`)
    expect(flattenArgument(next.roots)).toHaveLength(6)
    expect(next.roots.at(-1)!.children).toHaveLength(1)
    expect(next.groups).toHaveLength(2)
    expect(next.groups![1]).toEqual({ id: 'copy-3', label: '', memberIds: ['copy-1', 'copy-2'] })
    expect(next.canvas!.positions['copy-1'].x).toBeGreaterThan(document.canvas!.positions.a.x)
    expect(() => duplicateArgumentGroup(document, 'g1', () => 'collision')).toThrow()
    expect(document.groups).toHaveLength(1)
  })
  it('rejects duplicate/nonexistent/reserved IDs, nested/overlapping/singleton groups and injected metadata', () => {
    const document = grouped()
    const base = document.groups![0]
    for (const groups of [
      [{ ...base, id: 'a' }],
      [{ ...base, id: '__proto__' }],
      [{ ...base, label: 'x'.repeat(121) }],
      [{ ...base, memberIds: ['a'] }],
      [{ ...base, memberIds: ['a', 'a'] }],
      [{ ...base, memberIds: ['a', 'absent'] }],
      [{ ...base, memberIds: ['a', 'g1'] }],
      [base, { ...base, id: 'g2' }],
      [base, { ...base, memberIds: ['c', 'd'] }],
      [{ ...base, x: 1 }],
      [{ ...base, children: [] }],
      [{ ...base, memberIds: [null, 'b'] }],
    ])
      expect(argumentSchema.safeParse({ ...document, groups }).success).toBe(false)
    expect(() => assertArgumentGroups([], document.roots)).not.toThrow()
  })
  it('round-trips group metadata through drafts and rejects corruption inside old revision snapshots', () => {
    const document = grouped(),
      draft = { ...emptyDraft(), argument: document, text: 'Independent final text' }
    expect(argumentFromDraft(draftSchema.parse(JSON.parse(JSON.stringify(draft))))).toEqual(
      document,
    )
    expect(draftWireSchema.parse(draft)).toEqual(draft)
    const saved = checkpointArgument(document, { label: 'Grouped', id: 'v1', now: 1 })
    saved.revisions!.nodes[0].snapshot.groups![0].memberIds.push('missing')
    expect(argumentSchema.safeParse(saved).success).toBe(false)
  })
  it('restores and branches group snapshots and preserves them across accepted AI text edits', () => {
    const document = checkpointArgument(grouped(), { label: 'Grouped', id: 'v1', now: 1 })
    expect(hasArgumentDraftChanges(document)).toBe(false)
    const split = extractArgumentNode(document, 'b')
    expect(hasArgumentDraftChanges(split)).toBe(true)
    const next = checkpointArgument(split, { label: 'Split', id: 'v2', now: 2 })
    const restored = restoreArgumentRevision(next, 'v1')
    expect(restored.groups).toEqual(grouped().groups)
    const edited = structuredClone(restored.roots)
    edited[0].text = 'Revised synthetic claim'
    const accepted = checkpointAcceptedEdit(restored, edited, 'Accepted')
    expect(accepted.groups).toEqual(restored.groups)
    expect(accepted.revisions!.nodes.at(-1)!.parentId).toBe('v1')
    expect(accepted.revisions!.nodes.at(-1)!.snapshot.groups).toEqual(restored.groups)
    expect(restoreArgumentRevision(accepted, 'v2').groups).toEqual([])
  })
})

describe('group structure across persistence and AI privacy boundaries', () => {
  let directory: string | undefined
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
  })
  it('persists drafts/attempts and gives grading structural groups without layout or versions', async () => {
    directory = await mkdtemp(join(tmpdir(), 'examcraft-group-test-'))
    let captured: any
    const local = new LocalRuleAgent()
    const service = () =>
      new StudyService(directory!, new LocalQuestionBank(directory!), {
        name: 'synthetic',
        review: async (question, draft) => {
          captured = structuredClone(draft)
          return local.review(question, draft)
        },
      })
    const document = checkpointArgument(grouped(), { label: 'Group draft', id: 'v1', now: 1 })
    const draft = {
      ...emptyDraft(),
      argument: document,
      text: 'Synthetic independent final answer',
    }
    await service().saveDraft('pol-assembly-1', draft)
    const submitted = await service().submitAnswer('pol-assembly-1', draft)
    expect(captured.argument.groups).toEqual(document.groups)
    expect(captured.argument).not.toHaveProperty('canvas')
    expect(captured.argument).not.toHaveProperty('revisions')
    expect(captured.text).toBe(draft.text)
    await service().saveDraft('pol-assembly-1', {
      ...draft,
      argument: extractArgumentNode(document, 'b'),
    })
    const state = await service().loadState()
    expect(state.attempts[0]).toEqual(submitted)
    expect(state.attempts[0].draft.argument!.groups).toEqual(document.groups)
    expect(state.drafts['pol-assembly-1'].argument!.groups).toEqual([])
  })
  it('sends selected membership plus explicit labels and partial status without hidden member IDs or positions', () => {
    const document = grouped()
    document.groups![0].label = '（2）影响'
    const onlyB = [document.roots[0].children[0]]
    const input = validateModuleReviewRequest(request(document, onlyB))
    expect(input.groups).toEqual([
      { id: 'g1', label: '（2）影响', memberIds: ['b'], partial: true },
    ])
    const context = buildModuleAdvisorContext(question, input)
    expect(context.groups).toEqual(input.groups)
    expect(Object.isFrozen(context.groups)).toBe(true)
    const serialized = JSON.stringify(context)
    for (const hidden of [
      'REFERENCE_NOT_AUTHORIZED',
      'RUBRIC_NOT_AUTHORIZED',
      'canvas',
      'viewport',
      'revisions',
      'memberIds":["a"',
    ])
      expect(serialized).not.toContain(hidden)
    expect(input.roots).toEqual(onlyB)
    expect(validateModuleReviewRequest(request(document)).groups![0].partial).toBe(false)
  })
  it('rejects forged review membership, duplicate groups and layout injection before sending', () => {
    const document = grouped()
    for (const change of [
      (value: any) => {
        value.groups[0].memberIds.push('not-in-scope')
      },
      (value: any) => {
        value.groups[0].memberIds = ['b']
        value.groups[0].partial = false
      },
      (value: any) => {
        value.groups[0].memberIds.push('b')
      },
      (value: any) => {
        value.groups.push({ ...value.groups[0], id: 'another' })
      },
      (value: any) => {
        value.groups[0].canvas = {}
      },
      (value: any) => {
        delete value.groups[0].partial
      },
    ]) {
      const input = request(document)
      change(input)
      expect(() => validateModuleReviewRequest(input)).toThrow()
    }
  })
  it('projects only public group fields in formal grading, without counting draft content as final text', () => {
    const draft = { ...emptyDraft(), argument: grouped(), text: 'Chosen final answer' }
    const context = buildGradingContext(question, draft)
    if (!('argument' in context.answer)) throw new Error('Expected argument context')
    expect(context.answer.argument!.groups).toEqual(draft.argument.groups)
    expect(context.answer.text).toBe('Chosen final answer')
    expect(context.answer.argument).not.toHaveProperty('canvas')
    expect(context.answer.argument).not.toHaveProperty('revisions')
  })
  it('keeps subquestion interpretation evidence-based and zero-suggestion reviews allowed', () => {
    for (const text of [
      '不可信',
      '第一小题、第二小题',
      '备选解法',
      '不得仅凭分组顺序',
      '不要强行拼成一篇文章',
      'partial:true',
      '允许零建议',
      '不要为每个模块或大模块凑回复',
    ])
      expect(MODULE_REVIEW_PROMPT).toContain(text)
    expect(safeModelDebugPaths([['groups', 0, 'memberIds', 'private-dynamic-id']])).toEqual([
      'groups[*].memberIds[field]',
    ])
  })
})
