import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acceptLearningHelp,
  appendLearningEvent,
  beginLearningHelp,
  captureLearningSnapshot,
  emptyLearningGraph,
  learningAssistance,
  learningGraphSchema,
  learningHelpState,
  MAX_BRANCH_TOOL_TRACES,
} from '../src/domain/learning-graph'
import { LearningGraphService } from '../src/adapters/learning-graph-service'
import { LearningHelpCoordinator } from '../src/adapters/learning-help-coordinator'
import { StudyService } from '../src/domain/study-service'
import { LocalQuestionBank } from '../src/adapters/local-question-bank'
import { LocalRuleAgent } from '../src/adapters/local-rule-agent'
import { emptyDraft } from '../src/shared/types'
import type { LearningGraphState } from '../src/shared/learning-graph'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
function baseline(origin: 'independent' | 'unknown' = 'independent') {
  return captureLearningSnapshot(
    emptyLearningGraph(),
    {
      questionId: 'q1',
      subject: 'math',
      draft: { ...emptyDraft('math'), text: 'my answer' },
      initialOrigin: origin,
    },
    's1',
    10,
  ).graph
}
function begin(graph: LearningGraphState, id = 'b1', snapshotId = 's1') {
  return beginLearningHelp(graph, { snapshotId, requestId: `req-${id}`, kind: 'agent' }, id, 20)
    .graph
}
function received(graph: LearningGraphState, branchId = 'b1') {
  return appendLearningEvent(graph, {
    id: `got-${branchId}`,
    createdAt: 30,
    type: 'help-received',
    branchId,
    detail: { prompt: 'Why?', response: '<script>alert(1)</script>' },
  })
}

describe('immutable Git-like learning graph', () => {
  it('records hint reference immediately without a merge or new mainline node', () => {
    const original = baseline()
    const pending = begin(original)
    expect(learningAssistance(pending, 's1').status).toBe('independent')
    const graph = received(pending)
    expect(learningAssistance(graph, 's1').status).toBe('referenced-ai')
    expect(graph.snapshots).toHaveLength(1)
    expect(graph.events.some((event) => event.type === 'help-merged')).toBe(false)
    expect(original.branches).toHaveLength(0)
    expect(Object.isFrozen(graph.snapshots[0].draft)).toBe(true)
    expect(() => {
      graph.snapshots[0].draft.text = 'mutated'
    }).toThrow()
  })
  it('inherits received assistance only along the actual ancestor lineage, across later edits', () => {
    let graph = received(begin(baseline()))
    graph = captureLearningSnapshot(
      graph,
      { questionId: 'q1', subject: 'math', draft: { ...emptyDraft('math'), text: 'later' } },
      's2',
      40,
    ).graph
    expect(learningAssistance(graph, 's2').status).toBe('referenced-ai')
    graph = captureLearningSnapshot(
      graph,
      {
        questionId: 'q1',
        subject: 'math',
        draft: { ...emptyDraft('math'), text: 'fresh' },
        mode: 'independent',
        initialOrigin: 'independent',
      },
      's3',
      50,
    ).graph
    expect(learningAssistance(graph, 's3').status).toBe('independent')
    graph = captureLearningSnapshot(
      graph,
      {
        questionId: 'q2',
        subject: 'math',
        draft: emptyDraft('math'),
        initialOrigin: 'independent',
      },
      's4',
      60,
    ).graph
    expect(learningAssistance(graph, 's4').status).toBe('independent')
    graph = captureLearningSnapshot(
      graph,
      {
        questionId: 'q1',
        subject: 'history',
        draft: emptyDraft('history'),
        initialOrigin: 'independent',
      },
      's5',
      70,
    ).graph
    expect(learningAssistance(graph, 's5').status).toBe('independent')
  })
  it('keeps unknown legacy origin and does not call old history independent', () => {
    const graph = baseline('unknown')
    expect(learningAssistance(graph, 's1')).toMatchObject({
      status: 'unknown',
      unknownHistory: true,
    })
    expect(learningAssistance(received(begin(graph)), 's1')).toMatchObject({
      status: 'referenced-ai',
      unknownHistory: true,
    })
  })
  it.each(['help-canceled', 'help-failed'] as const)(
    '%s stays distinct and late success is rejected',
    (type) => {
      const graph = appendLearningEvent(begin(baseline()), {
        id: 'done',
        type,
        branchId: 'b1',
        createdAt: 30,
      })
      expect(learningAssistance(graph, 's1').status).toBe('independent')
      expect(learningHelpState(graph, 'b1')).toBe(type === 'help-canceled' ? 'canceled' : 'failed')
      expect(() => received(graph)).toThrow()
    },
  )
  it('rejected suggestions preserve the fact that a hint was received', () => {
    const graph = appendLearningEvent(received(begin(baseline())), {
      id: 'reject',
      type: 'help-rejected',
      branchId: 'b1',
      createdAt: 40,
    })
    expect(learningHelpState(graph, 'b1')).toBe('rejected')
    expect(learningAssistance(graph, 's1').status).toBe('referenced-ai')
    expect(() =>
      acceptLearningHelp(
        graph,
        {
          branchId: 'b1',
          expectedSnapshotId: 's1',
          draft: { ...emptyDraft('math'), text: 'change' },
        },
        's2',
        'merge',
        50,
      ),
    ).toThrow()
  })
  it('merges only a changed received proposal with exact base and rejects duplicate/stale/concurrent accept', () => {
    let graph = received(begin(baseline()))
    graph = received(begin(graph, 'b2'), 'b2')
    expect(() =>
      acceptLearningHelp(
        graph,
        { branchId: 'b1', expectedSnapshotId: 's1', draft: graph.snapshots[0].draft },
        's2',
        'merge',
        40,
      ),
    ).toThrow(/未变化/)
    const merged = acceptLearningHelp(
      graph,
      {
        branchId: 'b1',
        expectedSnapshotId: 's1',
        draft: { ...emptyDraft('math'), text: 'accepted' },
      },
      's2',
      'merge',
      40,
    ).graph
    expect(learningAssistance(merged, 's2').status).toBe('adopted-ai')
    expect(merged.snapshots[1]).toMatchObject({
      parentId: 's1',
      mergedBranchId: 'b1',
      reason: 'merge',
    })
    expect(() =>
      acceptLearningHelp(
        merged,
        {
          branchId: 'b1',
          expectedSnapshotId: 's1',
          draft: { ...emptyDraft('math'), text: 'again' },
        },
        's3',
        'merge2',
        50,
      ),
    ).toThrow()
    expect(() =>
      acceptLearningHelp(
        merged,
        {
          branchId: 'b2',
          expectedSnapshotId: 's1',
          draft: { ...emptyDraft('math'), text: 'second' },
        },
        's3',
        'merge3',
        50,
      ),
    ).toThrow(/变化/)
    expect(graph.snapshots).toHaveLength(1)
  })
  it('restore creates a new branch, preserves old history, and inherits original assistance', () => {
    let graph = received(begin(baseline()))
    graph = captureLearningSnapshot(
      graph,
      {
        questionId: 'q1',
        subject: 'math',
        draft: { ...emptyDraft('math'), text: 'new branch' },
        mode: 'independent',
        initialOrigin: 'independent',
      },
      's2',
      40,
    ).graph
    const restored = captureLearningSnapshot(
      graph,
      {
        questionId: 'q1',
        subject: 'math',
        draft: graph.snapshots[0].draft,
        mode: 'restore',
        restoreSnapshotId: 's1',
        expectedHeadId: 's2',
      },
      's3',
      50,
    ).graph
    expect(restored.snapshots).toHaveLength(3)
    expect(restored.snapshots[2]).toMatchObject({
      parentId: 's1',
      lineageId: 's3',
      reason: 'restore',
    })
    expect(learningAssistance(restored, 's3').status).toBe('referenced-ai')
    expect(() =>
      captureLearningSnapshot(
        restored,
        {
          questionId: 'q2',
          subject: 'math',
          draft: graph.snapshots[0].draft,
          mode: 'restore',
          restoreSnapshotId: 's1',
        },
        's4',
        60,
      ),
    ).toThrow(/其他题目/)
  })
  it('tool reads expand one bounded help branch without mainline commits', () => {
    let graph = begin(baseline())
    for (let i = 0; i < MAX_BRANCH_TOOL_TRACES; i++)
      graph = appendLearningEvent(graph, {
        id: `tool-${i}`,
        type: 'tool',
        branchId: 'b1',
        createdAt: 21,
        trace: { tool: 'get_question', outcome: 'completed' },
      })
    expect(graph.snapshots).toHaveLength(1)
    expect(graph.branches).toHaveLength(1)
    expect(() =>
      appendLearningEvent(graph, {
        id: 'overflow',
        type: 'tool',
        branchId: 'b1',
        createdAt: 21,
        trace: { tool: 'get_question', outcome: 'completed' },
      }),
    ).toThrow()
    expect(
      learningGraphSchema.safeParse({
        ...graph,
        events: [
          ...graph.events,
          {
            id: 'bad',
            type: 'tool',
            branchId: 'b1',
            createdAt: 21,
            trace: { tool: 'get_question', outcome: 'completed', apiKey: 'secret' },
          },
        ],
      }).success,
    ).toBe(false)
    expect(learningGraphSchema.safeParse({ ...graph, config: { apiKey: 'secret' } }).success).toBe(
      false,
    )
  })
  it('keeps submission assistance immutable even when help arrives later', () => {
    let graph = begin(baseline())
    const assistance = learningAssistance(graph, 's1')
    graph = appendLearningEvent(graph, {
      id: 'submission',
      type: 'submission',
      snapshotId: 's1',
      attemptId: 'attempt1',
      createdAt: 25,
      assistance,
    })
    graph = received(graph)
    expect(graph.events.find((event) => event.type === 'submission')).toMatchObject({
      assistance: { status: 'independent' },
    })
    expect(learningAssistance(graph, 's1').status).toBe('referenced-ai')
  })
})

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'examcraft-learning-'))
  dirs.push(dir)
  const bank = new LocalQuestionBank()
  const graph = new LearningGraphService(dir)
  const service = new StudyService(dir, bank, new LocalRuleAgent(), undefined, undefined, graph)
  return { graph, service, bank, dir }
}
it('persists genuine submissions and inherits assistance, while old attempts remain unannotated', async () => {
  const { graph, service } = await setup()
  const draft = { ...emptyDraft(), text: '实践认识，实事求是。' }
  await service.saveDraft('pol-assembly-1', draft)
  const base = (await graph.load()).snapshots[0]
  const help = await graph.beginHelp({ snapshotId: base.id, requestId: 'req-1', kind: 'selection' })
  await graph.receiveHelp(help.id, { prompt: '请提示', response: '先结合材料思考。' })
  const attempt1 = await service.submitAnswer('pol-assembly-1', draft)
  const attempt2 = await service.submitAnswer('pol-assembly-1', {
    ...draft,
    text: '认识反作用于实践，需要结合材料。',
  })
  expect(attempt1.assistance?.status).toBe('referenced-ai')
  expect(attempt2.assistance?.status).toBe('referenced-ai')
  expect(attempt1.id).not.toBe(attempt2.id)
  expect((await graph.load()).events.filter((event) => event.type === 'submission')).toHaveLength(2)
  const reopened = new LearningGraphService((await setup()).dir)
  expect((await reopened.load()).snapshots).toHaveLength(0)
})
it('failed persistence cannot produce a merge; simultaneous accepts only persist once', async () => {
  const { graph, service } = await setup()
  const draft = { ...emptyDraft(), text: '实践决定认识' }
  await service.saveDraft('pol-assembly-1', draft)
  const base = (await graph.load()).snapshots[0]
  const branch = await graph.beginHelp({ snapshotId: base.id, requestId: 'req-1', kind: 'agent' })
  await graph.receiveHelp(branch.id)
  const edit = {
    branchId: branch.id,
    expectedSnapshotId: base.id,
    draft: { ...draft, text: '实践决定认识，认识反作用于实践。' },
  }
  await expect(
    graph.acceptHelp(edit, async () => {
      throw new Error('disk failure')
    }),
  ).rejects.toThrow('disk failure')
  expect((await graph.load()).events.some((event) => event.type === 'help-merged')).toBe(false)
  const results = await Promise.allSettled([
    service.applyLearningEdit('pol-assembly-1', edit),
    service.applyLearningEdit('pol-assembly-1', edit),
  ])
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  expect((await service.loadState()).drafts['pol-assembly-1'].text).toBe(edit.draft.text)
  expect((await graph.load()).events.filter((event) => event.type === 'help-merged')).toHaveLength(
    1,
  )
})
it('cancellation during pending legacy help never turns its late result into completed assistance', async () => {
  const { graph, service } = await setup()
  const coordinator = new LearningHelpCoordinator(service)
  let finish!: (value: string) => void
  const operation = new Promise<string>((resolve) => {
    finish = resolve
  })
  const run = coordinator.run(
    {
      requestId: 'request',
      questionId: 'pol-assembly-1',
      kind: 'selection',
      draft: { ...emptyDraft(), text: '自己的答案' },
      prompt: '提示',
    },
    () => operation,
    (result) => result,
  )
  coordinator.cancel('request')
  finish('late model response')
  await expect(run).rejects.toThrow(/取消/)
  const stored = await graph.load()
  expect(learningAssistance(stored, stored.snapshots[0].id).status).toBe('independent')
  expect(learningHelpState(stored, stored.branches[0].id)).toBe('canceled')
})
it('more than a thousand autosaves remain usable with only a baseline and milestone snapshots', async () => {
  const { graph, service } = await setup()
  for (let index = 0; index < 1005; index++)
    await service.saveDraft('pol-assembly-1', { ...emptyDraft(), text: `自己的第 ${index} 次编辑` })
  expect((await graph.load()).snapshots).toHaveLength(1)
  expect((await service.loadState()).drafts['pol-assembly-1'].text).toBe('自己的第 1004 次编辑')
  await service.submitAnswer('pol-assembly-1', { ...emptyDraft(), text: '自己的第 1004 次编辑' })
  expect((await graph.load()).snapshots).toHaveLength(2)
}, 30000)
it('a corrupted optional graph never blocks autosave or local submission, and is never called independent', async () => {
  const { service, dir } = await setup()
  const { writeFile, readFile } = await import('node:fs/promises')
  await writeFile(join(dir, 'learning-graph.json'), '{ broken')
  await service.saveDraft('pol-assembly-1', { ...emptyDraft(), text: '本机作答照常保留' })
  const attempt = await service.submitAnswer('pol-assembly-1', {
    ...emptyDraft(),
    text: '本机作答照常提交',
  })
  expect(attempt.assistance).toBeUndefined()
  expect((await service.loadState()).attempts).toHaveLength(1)
  expect(await readFile(join(dir, 'learning-graph.json'), 'utf8')).toBe('{ broken')
})
it('edits after a help milestone are caught by stored-draft CAS without creating keystroke snapshots', async () => {
  const { graph, service } = await setup()
  const draft = { ...emptyDraft(), text: '先前答案' }
  await service.saveDraft('pol-assembly-1', draft)
  const base = (await graph.load()).snapshots[0]
  const help = await graph.beginHelp({ snapshotId: base.id, requestId: 'request', kind: 'agent' })
  await graph.receiveHelp(help.id)
  await service.saveDraft('pol-assembly-1', { ...draft, text: '更新后的自己的答案' })
  await expect(
    service.applyLearningEdit('pol-assembly-1', {
      branchId: help.id,
      expectedSnapshotId: base.id,
      draft: { ...draft, text: 'AI 修改' },
    }),
  ).rejects.toThrow(/草稿已变化/)
  expect((await graph.load()).snapshots).toHaveLength(1)
  expect((await graph.load()).events.some((event) => event.type === 'help-merged')).toBe(false)
  expect((await service.loadState()).drafts['pol-assembly-1'].text).toBe('更新后的自己的答案')
})
it('first cloud-graded submission freezes pre-feedback independence; only subsequent retries inherit that feedback', async () => {
  const { graph, bank, dir } = await setup()
  const local = new LocalRuleAgent()
  const service = new StudyService(dir, bank, local, local, undefined, graph)
  const draft = { ...emptyDraft(), text: '实践决定认识' }
  const first = await service.submitAnswer('pol-assembly-1', draft, {
    provider: 'deepseek',
    cloudConsent: true,
  })
  expect(first.assistance?.status).toBe('independent')
  const second = await service.submitAnswer('pol-assembly-1', {
    ...draft,
    text: '实践决定认识，认识反作用于实践。',
  })
  expect(second.assistance?.status).toBe('referenced-ai')
  expect((await service.loadState()).attempts[0].assistance?.status).toBe('independent')
})
it('failed cloud review keeps completed help off the lineage and creates no submission', async () => {
  const { graph, bank, dir } = await setup()
  const service = new StudyService(
    dir,
    bank,
    new LocalRuleAgent(),
    {
      name: 'failed',
      review: async () => {
        throw new Error('failed')
      },
    },
    undefined,
    graph,
  )
  const draft = { ...emptyDraft(), text: '自己的答案' }
  await expect(
    service.submitAnswer('pol-assembly-1', draft, { provider: 'deepseek', cloudConsent: true }),
  ).rejects.toThrow('failed')
  const stored = await graph.load()
  expect(learningHelpState(stored, stored.branches[0].id)).toBe('failed')
  expect((await service.loadState()).attempts).toHaveLength(0)
  expect(learningAssistance(stored, stored.snapshots[0].id).status).toBe('independent')
})
it('explicit restore preserves pending typed work as a checkpoint and creates a fresh branch', async () => {
  const { graph, service } = await setup()
  await service.saveDraft('pol-assembly-1', { ...emptyDraft(), text: '起点' })
  const original = (await graph.load()).snapshots[0]
  await service.captureSnapshot('pol-assembly-1', { ...emptyDraft(), text: '求助时作答' })
  await service.saveDraft('pol-assembly-1', { ...emptyDraft(), text: '尚未求助或提交的最新内容' })
  const stored = await graph.load()
  const restored = await service.restoreLearningSnapshot({
    snapshotId: original.id,
    expectedHeadId: stored.heads['politics:pol-assembly-1'],
  })
  const next = await graph.load()
  expect(
    next.snapshots.some((snapshot) => snapshot.draft.text === '尚未求助或提交的最新内容'),
  ).toBe(true)
  expect(restored).toMatchObject({ reason: 'restore', parentId: original.id })
  expect(restored.lineageId).not.toBe(original.lineageId)
  expect((await service.loadState()).drafts['pol-assembly-1'].text).toBe('起点')
})
it('module proposals merge only the host-validated saved suggestion and ignore arbitrary renderer edits', async () => {
  const { graph, service } = await setup()
  const draft = {
    ...emptyDraft(),
    text: '最终正文保持不变',
    argument: {
      version: 1 as const,
      roots: [{ id: 'node1', kind: 'analysis' as const, text: '旧内容', children: [] }],
    },
  }
  await service.saveDraft('pol-assembly-1', draft)
  const coordinator = new LearningHelpCoordinator(service)
  const result = {
    requestId: 'module-request',
    configRevision: 1,
    summary: '一处修改',
    confirmations: [],
    suggestions: [
      {
        id: 'suggestion1',
        moduleId: 'node1',
        priority: 'optional' as const,
        reason: '局部证据',
        evidence: '材料支持',
        edit: {
          operation: 'replace' as const,
          baseText: '旧内容',
          start: 0,
          end: 3,
          expectedText: '旧内容',
          replacement: '新内容',
        },
      },
    ],
  }
  await coordinator.run(
    {
      requestId: 'module-request',
      questionId: 'pol-assembly-1',
      kind: 'module-review',
      draft,
      prompt: '检查模块',
    },
    async () => result,
    (response) => response.summary,
  )
  await expect(
    coordinator.acceptModule({
      requestId: result.requestId,
      suggestionId: 'invented',
      expectedDraft: draft,
    }),
  ).rejects.toThrow()
  const accepted = await coordinator.acceptModule({
    requestId: result.requestId,
    suggestionId: 'suggestion1',
    expectedDraft: draft,
  })
  expect(accepted.argument?.roots[0].text).toBe('新内容')
  expect(accepted.text).toBe(draft.text)
  expect((await service.loadState()).drafts['pol-assembly-1'].argument?.roots[0].text).toBe(
    '新内容',
  )
  const stored = await graph.load()
  expect(learningAssistance(stored, stored.heads['politics:pol-assembly-1']).status).toBe(
    'adopted-ai',
  )
  await expect(
    coordinator.acceptModule({
      requestId: result.requestId,
      suggestionId: 'suggestion1',
      expectedDraft: draft,
    }),
  ).rejects.toThrow()
})
it('existing stored draft without graph migrates as unknown, never inferred independent', async () => {
  const { bank, dir, graph } = await setup()
  const old = new StudyService(dir, bank, new LocalRuleAgent())
  const draft = { ...emptyDraft(), text: '已有的旧草稿' }
  await old.saveDraft('pol-assembly-1', draft)
  const current = new StudyService(dir, bank, new LocalRuleAgent(), undefined, undefined, graph)
  const saved = await current.submitAnswer('pol-assembly-1', draft)
  expect(saved.assistance).toMatchObject({ status: 'unknown', unknownHistory: true })
})
