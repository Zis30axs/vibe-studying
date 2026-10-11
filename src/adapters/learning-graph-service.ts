import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { AtomicJsonStore } from './atomic-json-store'
import {
  acceptLearningHelp,
  appendLearningEvent,
  beginLearningHelp,
  captureLearningSnapshot,
  emptyLearningGraph,
  learningAssistance,
  learningGraphSchema,
  learningGraphTime,
  MAX_BRANCH_TOOL_TRACES,
  learningScopeKey,
} from '../domain/learning-graph'
import type {
  AcceptLearningHelp,
  BeginLearningHelp,
  CaptureLearningSnapshot,
  LearningEvent,
  LearningGraphState,
  LearningHelpBranch,
  LearningSnapshot,
  LearningToolTrace,
  SubmissionAssistance,
} from '../shared/learning-graph'

/** Local host-owned ledger. There is deliberately no renderer-selected path or raw model data. */
export class LearningGraphService {
  private readonly store: AtomicJsonStore<LearningGraphState>
  constructor(userDataDirectory: string) {
    this.store = new AtomicJsonStore(
      join(userDataDirectory, 'learning-graph.json'),
      learningGraphSchema,
      emptyLearningGraph,
    )
  }
  load(): Promise<LearningGraphState> {
    return this.store.load()
  }
  async capture(
    input: CaptureLearningSnapshot,
    persist?: (draft: LearningSnapshot['draft']) => Promise<void>,
  ): Promise<LearningSnapshot> {
    let snapshot!: LearningSnapshot
    // Clone at invocation so mutation during a queued write cannot change its evidence.
    const captured = structuredClone(input)
    await this.store.update(async (graph) => {
      const result = captureLearningSnapshot(graph, captured, `snap-${randomUUID()}`)
      snapshot = result.snapshot
      if (persist) await persist(structuredClone(snapshot.draft))
      return result.graph
    })
    return snapshot
  }
  /** Autosave establishes a baseline only; later typing is captured at meaningful milestones. */
  async ensureBaseline(input: CaptureLearningSnapshot): Promise<LearningSnapshot> {
    const captured = structuredClone(input)
    const loaded = await this.store.load()
    const key = learningScopeKey(captured)
    const existing = loaded.snapshots.find((snapshot) => snapshot.id === loaded.heads[key])
    if (existing) return existing
    let snapshot!: LearningSnapshot
    await this.store.update((graph) => {
      const head = graph.snapshots.find((entry) => entry.id === graph.heads[key])
      if (head) {
        snapshot = head
        return graph
      }
      const result = captureLearningSnapshot(graph, captured, `snap-${randomUUID()}`)
      snapshot = result.snapshot
      return result.graph
    })
    return snapshot
  }
  async beginHelp(input: BeginLearningHelp): Promise<LearningHelpBranch> {
    let branch!: LearningHelpBranch
    const captured = structuredClone(input)
    await this.store.update((graph) => {
      const result = beginLearningHelp(graph, captured, `help-${randomUUID()}`)
      branch = result.branch
      return result.graph
    })
    return branch
  }
  private async transition(
    branchId: string,
    type: 'help-received' | 'help-failed' | 'help-canceled' | 'help-rejected',
  ): Promise<void> {
    await this.store.update((graph) =>
      appendLearningEvent(graph, {
        id: `event-${randomUUID()}`,
        createdAt: learningGraphTime(graph),
        branchId,
        type,
      }),
    )
  }
  async receiveHelp(
    branchId: string,
    detail?: { prompt?: string; response: string },
  ): Promise<void> {
    const bounded = detail
      ? {
          ...(detail.prompt !== undefined ? { prompt: detail.prompt.slice(0, 4000) } : {}),
          response: detail.response.slice(0, 8000),
          truncated: detail.response.length > 8000 || (detail.prompt?.length ?? 0) > 4000,
        }
      : undefined
    await this.store.update((graph) =>
      appendLearningEvent(graph, {
        id: `event-${randomUUID()}`,
        createdAt: learningGraphTime(graph),
        branchId,
        type: 'help-received',
        ...(bounded ? { detail: bounded } : {}),
      }),
    )
  }
  failHelp(branchId: string): Promise<void> {
    return this.transition(branchId, 'help-failed')
  }
  cancelHelp(branchId: string): Promise<void> {
    return this.transition(branchId, 'help-canceled')
  }
  rejectHelp(branchId: string): Promise<void> {
    return this.transition(branchId, 'help-rejected')
  }
  async acceptHelp(
    input: AcceptLearningHelp,
    persist?: (draft: LearningSnapshot['draft'], base: LearningSnapshot['draft']) => Promise<void>,
  ): Promise<LearningSnapshot> {
    let snapshot!: LearningSnapshot
    const captured = structuredClone(input)
    await this.store.update(async (graph) => {
      const result = acceptLearningHelp(
        graph,
        captured,
        `snap-${randomUUID()}`,
        `event-${randomUUID()}`,
      )
      snapshot = result.snapshot
      const base = graph.snapshots.find((entry) => entry.id === captured.expectedSnapshotId)!
      if (persist) await persist(structuredClone(snapshot.draft), structuredClone(base.draft))
      return result.graph
    })
    return snapshot
  }
  async appendToolTrace(branchId: string, trace: LearningToolTrace): Promise<void> {
    const captured = structuredClone(trace)
    await this.store.update((graph) => {
      // Traces are supplementary. Refuse unbounded growth without interrupting the model run.
      if (
        graph.events.filter((event) => event.type === 'tool' && event.branchId === branchId)
          .length >= MAX_BRANCH_TOOL_TRACES
      )
        return graph
      return appendLearningEvent(graph, {
        id: `event-${randomUUID()}`,
        createdAt: learningGraphTime(graph),
        type: 'tool',
        branchId,
        trace: captured,
      })
    })
  }
  async assistance(snapshotId: string): Promise<SubmissionAssistance> {
    return learningAssistance(await this.store.load(), snapshotId)
  }
  /** Only call after the real Attempt persisted. No failed review creates a submission node. */
  async submission(input: {
    attemptId: string
    snapshotId: string
    assistance?: SubmissionAssistance
  }): Promise<SubmissionAssistance> {
    let assistance!: SubmissionAssistance
    await this.store.update((graph) => {
      const existing = graph.events.find(
        (event) => event.type === 'submission' && event.attemptId === input.attemptId,
      )
      if (existing?.type === 'submission') {
        if (existing.snapshotId !== input.snapshotId)
          throw new Error('提交记录不能连接到另一作答版本')
        assistance = existing.assistance
        return graph
      }
      assistance = input.assistance ?? learningAssistance(graph, input.snapshotId)
      const event: LearningEvent = {
        id: `event-${randomUUID()}`,
        createdAt: learningGraphTime(graph),
        type: 'submission',
        attemptId: input.attemptId,
        snapshotId: input.snapshotId,
        assistance,
      }
      return appendLearningEvent(graph, event)
    })
    return assistance
  }
}
