import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkpointArgument,
  checkpointAcceptedEdit,
  hasArgumentDraftChanges,
  MAX_ARGUMENT_REVISIONS,
  restoreArgumentRevision,
} from '../src/domain/argument-revisions'
import { argumentSchema } from '../src/domain/schemas'
import { argumentFromDraft } from '../src/domain/argument'
import { LocalQuestionBank } from '../src/adapters/local-question-bank'
import { LocalRuleAgent } from '../src/adapters/local-rule-agent'
import { StudyService } from '../src/domain/study-service'
import { emptyDraft, type ArgumentDocument } from '../src/shared/types'

const initial = (): ArgumentDocument => ({
  version: 1,
  roots: [{ id: 'a1', kind: 'analysis', text: '初始分析', children: [] }],
  canvas: { positions: { a1: { x: 123, y: 234 } }, viewport: { x: 17, y: 20, zoom: 0.7 } },
})
const commit = (document: ArgumentDocument, id: string, now = 100) =>
  checkpointArgument(document, { label: id, id, now })

describe('persistent branching argument revision timeline', () => {
  let directory: string | undefined
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  it('restores structure and canvas then branches from history without deleting old futures', () => {
    const original = initial()
    const a = commit(original, 'a')
    const changed = structuredClone(a)
    changed.roots[0].text = '新分析'
    changed.canvas!.positions.a1 = { x: 800, y: 900 }
    const b = commit(changed, 'b', 200)
    const restored = restoreArgumentRevision(b, 'a')
    expect(restored.roots).toEqual(original.roots)
    expect(restored.canvas).toEqual(original.canvas)
    restored.roots[0].text = '新分支'
    const c = commit(restored, 'c', 300)
    expect(c.revisions!.nodes.map(({ id, parentId }) => [id, parentId])).toEqual([
      ['a', null],
      ['b', 'a'],
      ['c', 'a'],
    ])
    expect(c.revisions!.headId).toBe('c')
    expect(restoreArgumentRevision(c, 'b').roots[0].text).toBe('新分析')
    expect(a.roots[0].text).toBe('初始分析')
    expect(original).not.toHaveProperty('revisions')
    expect(c.revisions!.nodes.every((node) => !('revisions' in node.snapshot))).toBe(true)
  })

  it('keeps edits as drafts until an explicit checkpoint and accepts AI edits atomically', () => {
    const a = commit(initial(), 'a')
    expect(hasArgumentDraftChanges(a)).toBe(false)
    const draft = structuredClone(a)
    draft.roots[0].text = '手动编辑'
    expect(hasArgumentDraftChanges(draft)).toBe(true)
    expect(draft.revisions!.nodes).toHaveLength(1)
    const editedRoots = [{ ...draft.roots[0], text: '接受的建议' }]
    const accepted = checkpointAcceptedEdit(draft, editedRoots, '证据更清晰')
    expect(accepted.revisions!.nodes).toHaveLength(3)
    expect(accepted.revisions!.nodes[1].snapshot.roots[0].text).toBe('手动编辑')
    expect(accepted.revisions!.nodes[2].source).toBe('ai')
    expect(accepted.revisions!.nodes[2].snapshot.roots[0].text).toBe('接受的建议')
    editedRoots[0].text = '外部修改'
    expect(accepted.roots[0].text).toBe('接受的建议')
    expect(draft.revisions!.nodes).toHaveLength(1)
  })

  it('retains old documents and persists branches in drafts and immutable attempt history after restart', async () => {
    expect(argumentSchema.parse(initial())).not.toHaveProperty('revisions')
    directory = await mkdtemp(join(tmpdir(), 'argument-revisions-'))
    const service = () =>
      new StudyService(directory!, new LocalQuestionBank(directory!), new LocalRuleAgent())
    const a = commit(initial(), 'a')
    const b = commit(a, 'b', 200)
    const c = commit(restoreArgumentRevision(b, 'a'), 'c', 300)
    const draft = { ...emptyDraft(), text: '最终正文保持不变', argument: c }
    await service().saveDraft('pol-assembly-1', draft)
    const submitted = await service().submitAnswer('pol-assembly-1', draft)
    draft.argument = restoreArgumentRevision(c, 'b')
    await service().saveDraft('pol-assembly-1', draft)
    const state = await service().loadState()
    expect(state.drafts['pol-assembly-1']).toEqual(draft)
    expect(state.attempts[0]).toEqual(submitted)
    expect(state.attempts[0].draft.argument!.revisions!.headId).toBe('c')
    expect(argumentFromDraft(state.drafts['pol-assembly-1']).revisions!.nodes).toHaveLength(3)
    expect(state.drafts['pol-assembly-1'].text).toBe('最终正文保持不变')
  })

  it('rejects dangling parents, duplicate IDs, cycles, recursive snapshots and invalid timestamps', () => {
    const good = commit(commit(initial(), 'a'), 'b', 200)
    for (const corrupt of [
      (doc: ArgumentDocument) => {
        doc.revisions!.headId = 'missing'
      },
      (doc: ArgumentDocument) => {
        doc.revisions!.nodes[1].id = 'a'
      },
      (doc: ArgumentDocument) => {
        doc.revisions!.nodes[1].parentId = 'missing'
      },
      (doc: ArgumentDocument) => {
        doc.revisions!.nodes[1].parentId = 'b'
      },
      (doc: ArgumentDocument) => {
        doc.revisions!.nodes[1].createdAt = Infinity
      },
      (doc: ArgumentDocument) => {
        doc.revisions!.nodes[1].createdAt = 50
      },
      (doc: ArgumentDocument) => {
        Object.assign(doc.revisions!.nodes[1].snapshot, { revisions: doc.revisions })
      },
    ]) {
      const doc = structuredClone(good)
      corrupt(doc)
      expect(argumentSchema.safeParse(doc).success).toBe(false)
    }
  })

  it('rejects count and byte limits without pruning branches or mutating the working draft', () => {
    let doc = initial()
    for (let i = 0; i < MAX_ARGUMENT_REVISIONS; i++) doc = commit(doc, `r${i}`)
    const almostFull = structuredClone(doc)
    almostFull.revisions!.nodes.pop()
    almostFull.revisions!.headId = 'r38'
    almostFull.roots[0].text = '未提交的手动编辑'
    const almostBefore = JSON.stringify(almostFull)
    expect(() => checkpointAcceptedEdit(almostFull, initial().roots, '需要两个检查点')).toThrow(
      '40',
    )
    expect(JSON.stringify(almostFull)).toBe(almostBefore)
    const before = JSON.stringify(doc)
    expect(() => commit(doc, 'overflow')).toThrow('40')
    const edited = structuredClone(doc.roots)
    edited[0].text = '修改'
    expect(() => checkpointAcceptedEdit(doc, edited, '建议')).toThrow('40')
    expect(JSON.stringify(doc)).toBe(before)
    const huge: ArgumentDocument = {
      version: 1,
      roots: Array.from({ length: 4 }, (_, i) => ({
        id: `n${i}`,
        kind: 'analysis',
        text: '汉'.repeat(4000),
        children: [],
      })),
    }
    let bounded = commit(huge, 'first')
    let rejected = false
    for (let i = 1; i < MAX_ARGUMENT_REVISIONS; i++) {
      try {
        bounded = commit(bounded, `large${i}`)
      } catch (error) {
        expect(String(error)).toContain('1 MiB')
        rejected = true
        break
      }
    }
    expect(rejected).toBe(true)
    expect(bounded.revisions!.nodes.length).toBeLessThan(MAX_ARGUMENT_REVISIONS)
    expect(argumentSchema.safeParse(bounded).success).toBe(true)
  })
})
