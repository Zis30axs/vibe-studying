import { z } from 'zod'
import { draftSchema, idSchema, subjectSchema } from './schemas'
import {
  helpKinds,
  traceTools,
  submissionAssistanceSchema,
  type LearningGraphState,
  type LearningSnapshot,
  type LearningHelpBranch,
  type LearningEvent,
  type CaptureLearningSnapshot,
  type BeginLearningHelp,
  type AcceptLearningHelp,
  type SubmissionAssistance,
  type HelpState,
} from '../shared/learning-graph'

export const MAX_LEARNING_SNAPSHOTS = 1000
export const MAX_LEARNING_BRANCHES = 2000
export const MAX_LEARNING_EVENTS = 12000
export const MAX_BRANCH_TOOL_TRACES = 40
export const MAX_LEARNING_BYTES = 6 * 1024 * 1024
const timeSchema = z.number().int().min(0).max(8640000000000000)
const snapshotSchema = z.strictObject({
  id: idSchema,
  parentId: idSchema.nullable(),
  lineageId: idSchema,
  questionId: idSchema,
  subject: subjectSchema,
  createdAt: timeSchema,
  draft: draftSchema,
  origin: z.enum(['independent', 'unknown']),
  reason: z.enum(['edit', 'baseline', 'independent', 'restore', 'merge']),
  restoredFromSnapshotId: idSchema.optional(),
  mergedBranchId: idSchema.optional(),
  argumentRevisionId: idSchema.optional(),
})
const branchSchema = z.strictObject({
  id: idSchema,
  snapshotId: idSchema,
  requestId: idSchema,
  kind: z.enum(helpKinds),
  createdAt: timeSchema,
})
const eventBase = { id: idSchema, createdAt: timeSchema }
const eventSchema = z.union([
  z.strictObject({
    ...eventBase,
    type: z.enum(['help-received', 'help-failed', 'help-canceled', 'help-rejected']),
    branchId: idSchema,
    detail: z
      .strictObject({
        prompt: z.string().max(4000).optional(),
        response: z.string().max(8000),
        truncated: z.boolean().optional(),
      })
      .optional(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal('help-merged'),
    branchId: idSchema,
    snapshotId: idSchema,
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal('tool'),
    branchId: idSchema,
    trace: z.strictObject({
      tool: z.enum(traceTools),
      outcome: z.enum(['completed', 'failed', 'canceled']),
    }),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal('submission'),
    snapshotId: idSchema,
    attemptId: idSchema,
    assistance: submissionAssistanceSchema,
  }),
])
const graphShape = z.strictObject({
  version: z.literal(1),
  snapshots: z.array(snapshotSchema).max(MAX_LEARNING_SNAPSHOTS),
  branches: z.array(branchSchema).max(MAX_LEARNING_BRANCHES),
  events: z.array(eventSchema).max(MAX_LEARNING_EVENTS),
  heads: z.record(z.string().max(100), idSchema),
})
export const emptyLearningGraph = (): LearningGraphState => ({
  version: 1,
  snapshots: [],
  branches: [],
  events: [],
  heads: {},
})
export const learningScopeKey = (scope: { questionId: string; subject: string }): string =>
  `${scope.subject}:${scope.questionId}`
const sameScope = (a: LearningSnapshot, b: LearningSnapshot) =>
  learningScopeKey(a) === learningScopeKey(b)

/** Append order is causal order, including under a backwards wall clock. */
export function learningHelpState(graph: LearningGraphState, branchId: string): HelpState {
  let state: HelpState = 'pending'
  for (const event of graph.events) {
    if (!('branchId' in event) || event.branchId !== branchId || event.type === 'tool') continue
    state = (
      {
        'help-received': 'received',
        'help-failed': 'failed',
        'help-canceled': 'canceled',
        'help-rejected': 'rejected',
        'help-merged': 'merged',
      } as const
    )[event.type]
  }
  return state
}
function assertTopology(graph: LearningGraphState): void {
  const allIds = new Set<string>()
  for (const record of [...graph.snapshots, ...graph.branches, ...graph.events]) {
    if (allIds.has(record.id)) throw new Error('学习图记录 ID 重复')
    allIds.add(record.id)
  }
  const snapshots = new Map<string, LearningSnapshot>()
  for (const snapshot of graph.snapshots) {
    if (snapshot.parentId) {
      const parent = snapshots.get(snapshot.parentId)
      if (!parent || !sameScope(parent, snapshot) || parent.createdAt > snapshot.createdAt)
        throw new Error('作答快照父节点无效或跨题目')
      if (snapshot.reason !== 'restore' && snapshot.lineageId !== parent.lineageId)
        throw new Error('作答谱系不一致')
      if (snapshot.origin !== parent.origin) throw new Error('不能重写既有来源')
    } else if (!['baseline', 'independent'].includes(snapshot.reason))
      throw new Error('作答起点无效')
    if (
      snapshot.reason === 'restore' &&
      (snapshot.restoredFromSnapshotId !== snapshot.parentId ||
        !snapshot.parentId ||
        snapshots.get(snapshot.parentId)?.lineageId === snapshot.lineageId)
    )
      throw new Error('恢复必须创建新分支')
    if ((snapshot.reason === 'merge') !== Boolean(snapshot.mergedBranchId))
      throw new Error('合并快照缺少对应 AI 分支')
    snapshots.set(snapshot.id, snapshot)
  }
  for (const [scope, id] of Object.entries(graph.heads)) {
    if (!snapshots.has(id) || learningScopeKey(snapshots.get(id)!) !== scope)
      throw new Error('当前作答指针无效')
  }
  const branches = new Map<string, LearningHelpBranch>()
  const requestIds = new Set<string>()
  for (const branch of graph.branches) {
    if (!snapshots.has(branch.snapshotId) || requestIds.has(branch.requestId))
      throw new Error('求助起点不存在或请求 ID 重复')
    if (branch.createdAt < snapshots.get(branch.snapshotId)!.createdAt)
      throw new Error('求助时间无效')
    requestIds.add(branch.requestId)
    branches.set(branch.id, branch)
  }
  const states = new Map<string, HelpState>()
  const traceCounts = new Map<string, number>()
  const attempts = new Set<string>()
  for (const event of graph.events) {
    if (event.type === 'submission') {
      if (
        !snapshots.has(event.snapshotId) ||
        event.assistance.snapshotId !== event.snapshotId ||
        attempts.has(event.attemptId)
      )
        throw new Error('提交连接无效或重复')
      if (event.assistance.helpBranchIds.some((id) => !branches.has(id)))
        throw new Error('提交求助分支不存在')
      attempts.add(event.attemptId)
      continue
    }
    const branch = branches.get(event.branchId)
    if (!branch || event.createdAt < branch.createdAt) throw new Error('求助事件分支不存在')
    const state = states.get(branch.id) ?? 'pending'
    if (event.type === 'tool') {
      const count = (traceCounts.get(branch.id) ?? 0) + 1
      if (state !== 'pending' || count > MAX_BRANCH_TOOL_TRACES)
        throw new Error('工具轨迹超限或求助已经结束')
      traceCounts.set(branch.id, count)
      continue
    }
    if ('detail' in event && event.detail && event.type !== 'help-received')
      throw new Error('只有已收到的提示可保存正文')
    if (event.type === 'help-received' && state !== 'pending')
      throw new Error('迟到或重复的求助结果')
    if (['help-failed', 'help-canceled'].includes(event.type) && state !== 'pending')
      throw new Error('求助已经结束')
    if (event.type === 'help-rejected' && state !== 'received')
      throw new Error('尚未收到可拒绝的建议')
    if (event.type === 'help-merged') {
      const snapshot = snapshots.get(event.snapshotId)
      if (
        state !== 'received' ||
        !snapshot ||
        snapshot.mergedBranchId !== branch.id ||
        snapshot.parentId !== branch.snapshotId ||
        snapshot.reason !== 'merge'
      )
        throw new Error('合并没有对应的已接收求助与作答快照')
    }
    states.set(
      branch.id,
      (
        {
          'help-received': 'received',
          'help-failed': 'failed',
          'help-canceled': 'canceled',
          'help-rejected': 'rejected',
          'help-merged': 'merged',
        } as const
      )[event.type],
    )
  }
  for (const snapshot of graph.snapshots) {
    if (
      snapshot.mergedBranchId &&
      !graph.events.some(
        (event) =>
          event.type === 'help-merged' &&
          event.snapshotId === snapshot.id &&
          event.branchId === snapshot.mergedBranchId,
      )
    )
      throw new Error('合并快照缺少合并事件')
  }
  if (new TextEncoder().encode(JSON.stringify(graph)).byteLength > MAX_LEARNING_BYTES)
    throw new Error('学习图已达到存储上限；已有历史保留，请先备份')
}
export const learningGraphSchema = graphShape.superRefine((graph, ctx) => {
  try {
    assertTopology(graph)
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : '学习图无效' })
  }
}) satisfies z.ZodType<LearningGraphState>

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}
function finish(graph: LearningGraphState): LearningGraphState {
  return freeze(learningGraphSchema.parse(graph))
}
function snapshotById(graph: LearningGraphState, id: string): LearningSnapshot {
  const snapshot = graph.snapshots.find((entry) => entry.id === id)
  if (!snapshot) throw new Error('找不到作答快照')
  return snapshot
}
function branchById(graph: LearningGraphState, id: string): LearningHelpBranch {
  const branch = graph.branches.find((entry) => entry.id === id)
  if (!branch) throw new Error('找不到 AI 求助分支')
  return branch
}
export function learningGraphTime(graph: LearningGraphState, now = Date.now()): number {
  return Math.max(
    now,
    ...graph.snapshots.map((x) => x.createdAt),
    ...graph.branches.map((x) => x.createdAt),
    ...graph.events.map((x) => x.createdAt),
  )
}
export function captureLearningSnapshot(
  graph: LearningGraphState,
  input: CaptureLearningSnapshot,
  id: string,
  now = Date.now(),
): { graph: LearningGraphState; snapshot: LearningSnapshot } {
  const draft = draftSchema.parse(input.draft)
  idSchema.parse(input.questionId)
  subjectSchema.parse(input.subject)
  const key = learningScopeKey(input)
  const headId = graph.heads[key] ?? null
  if (input.expectedHeadId !== undefined && input.expectedHeadId !== headId)
    throw new Error('作答已更新；请重新确认当前版本')
  const mode = input.mode ?? 'continue'
  let parent = headId ? snapshotById(graph, headId) : undefined
  if (mode === 'restore') {
    parent = snapshotById(graph, idSchema.parse(input.restoreSnapshotId))
    if (learningScopeKey(parent) !== key) throw new Error('不能恢复其他题目的版本')
    if (JSON.stringify(draft) !== JSON.stringify(parent.draft))
      throw new Error('恢复内容必须与所选快照一致')
  }
  if (mode === 'independent') parent = undefined
  if (mode === 'continue' && parent && JSON.stringify(parent.draft) === JSON.stringify(draft))
    return { graph, snapshot: parent }
  const snapshot: LearningSnapshot = {
    id,
    parentId: parent?.id ?? null,
    lineageId: !parent || mode === 'restore' ? id : parent.lineageId,
    questionId: input.questionId,
    subject: input.subject,
    draft,
    createdAt: learningGraphTime(graph, now),
    origin: parent?.origin ?? input.initialOrigin ?? 'unknown',
    reason:
      mode === 'restore'
        ? 'restore'
        : mode === 'independent'
          ? 'independent'
          : parent
            ? 'edit'
            : 'baseline',
    ...(mode === 'restore' ? { restoredFromSnapshotId: parent!.id } : {}),
    ...(draft.argument?.revisions ? { argumentRevisionId: draft.argument.revisions.headId } : {}),
  }
  const next = finish({
    ...graph,
    snapshots: [...graph.snapshots, snapshot],
    heads: { ...graph.heads, [key]: id },
  })
  return { graph: next, snapshot: next.snapshots[next.snapshots.length - 1] }
}
export function beginLearningHelp(
  graph: LearningGraphState,
  input: BeginLearningHelp,
  id: string,
  now = Date.now(),
): { graph: LearningGraphState; branch: LearningHelpBranch } {
  const snapshot = snapshotById(graph, input.snapshotId)
  if (graph.heads[learningScopeKey(snapshot)] !== snapshot.id)
    throw new Error('求助必须基于当前作答快照')
  const branch = { ...input, id, createdAt: learningGraphTime(graph, now) }
  const next = finish({ ...graph, branches: [...graph.branches, branch] })
  return { graph: next, branch: next.branches[next.branches.length - 1] }
}
export function appendLearningEvent(
  graph: LearningGraphState,
  event: LearningEvent,
): LearningGraphState {
  return finish({
    ...graph,
    events: [...graph.events, { ...event, createdAt: learningGraphTime(graph, event.createdAt) }],
  })
}
function answerContent(draft: LearningSnapshot['draft']): string {
  const copy = structuredClone(draft)
  if (copy.argument) delete copy.argument.revisions
  return JSON.stringify(copy)
}
export function acceptLearningHelp(
  graph: LearningGraphState,
  input: AcceptLearningHelp,
  snapshotId: string,
  eventId: string,
  now = Date.now(),
): { graph: LearningGraphState; snapshot: LearningSnapshot } {
  const branch = branchById(graph, input.branchId)
  const base = snapshotById(graph, branch.snapshotId)
  if (learningHelpState(graph, branch.id) !== 'received')
    throw new Error('建议已处理或尚未收到，不能重复采纳')
  if (input.expectedSnapshotId !== base.id || graph.heads[learningScopeKey(base)] !== base.id)
    throw new Error('作答已经变化；未覆盖当前内容，请重新请求建议')
  const draft = draftSchema.parse(input.draft)
  if (answerContent(draft) === answerContent(base.draft))
    throw new Error('作答未变化；仅参考建议，不创建虚假合并')
  const snapshot: LearningSnapshot = {
    ...base,
    id: snapshotId,
    parentId: base.id,
    draft,
    createdAt: learningGraphTime(graph, now),
    reason: 'merge',
    mergedBranchId: branch.id,
    ...(draft.argument?.revisions ? { argumentRevisionId: draft.argument.revisions.headId } : {}),
  }
  delete snapshot.restoredFromSnapshotId
  if (!draft.argument?.revisions) delete snapshot.argumentRevisionId
  const next = finish({
    ...graph,
    snapshots: [...graph.snapshots, snapshot],
    heads: { ...graph.heads, [learningScopeKey(base)]: snapshotId },
    events: [
      ...graph.events,
      {
        id: eventId,
        createdAt: snapshot.createdAt,
        type: 'help-merged',
        branchId: branch.id,
        snapshotId,
      },
    ],
  })
  return { graph: next, snapshot: next.snapshots[next.snapshots.length - 1] }
}
export function learningAssistance(
  graph: LearningGraphState,
  snapshotId: string,
): SubmissionAssistance {
  const snapshot = snapshotById(graph, snapshotId)
  const ancestors = new Set<string>()
  let current: LearningSnapshot | undefined = snapshot
  while (current) {
    ancestors.add(current.id)
    current = current.parentId ? snapshotById(graph, current.parentId) : undefined
  }
  const received = new Set(
    graph.events
      .filter((event) => event.type === 'help-received')
      .map((event) => ('branchId' in event ? event.branchId : '')),
  )
  const branches = graph.branches.filter(
    (branch) => ancestors.has(branch.snapshotId) && received.has(branch.id),
  )
  const adopted = graph.snapshots.some(
    (entry) => ancestors.has(entry.id) && entry.reason === 'merge',
  )
  return freeze({
    version: 1,
    snapshotId,
    status: adopted
      ? 'adopted-ai'
      : branches.length
        ? 'referenced-ai'
        : snapshot.origin === 'unknown'
          ? 'unknown'
          : 'independent',
    helpBranchIds: branches.map((branch) => branch.id),
    unknownHistory: snapshot.origin === 'unknown',
  })
}
