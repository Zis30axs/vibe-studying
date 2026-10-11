import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { attemptSchema } from '../domain/schemas'
import { knowledgeEvidenceSchema, type KnowledgeEvidence } from '../shared/knowledge'
import {
  MAX_REVIEW_KNOWLEDGE_EXCERPT,
  MAX_REVIEW_KNOWLEDGE_NODES,
  MAX_REVIEW_KNOWLEDGE_REMOVED_NODES,
  reviewKnowledgeAssociateInputSchema,
  reviewKnowledgeLabelInputSchema,
  reviewKnowledgeListInputSchema,
  reviewKnowledgeMutationInputSchema,
  reviewKnowledgeNodeIdSchema,
  reviewKnowledgeRefreshInputSchema,
  reviewKnowledgeStateSchema,
  type ReviewKnowledgeNode,
  type ReviewKnowledgeRecord,
  type ReviewKnowledgeReference,
  type ReviewKnowledgeStaleReason,
  type ReviewKnowledgeState,
} from '../shared/review-knowledge'
import type { Attempt } from '../shared/types'
import { AtomicJsonStore } from './atomic-json-store'

const reviewKnowledgeErrorMessages = {
  CANCELED: '知识点索引操作已取消；已有记录保持不变',
  CORRUPT: '无法读取知识点索引；原文件未覆盖，请保留备份并检查数据',
  STORAGE: '无法保存知识点索引；已有数据保持不变',
  SOURCE_INVALID: '提交身份不一致',
  EVIDENCE_INVALID: 'PDF 片段身份不一致',
  ATTEMPT_NOT_FOUND: '找不到已保存的评阅提交，请刷新历史记录',
  REFRESH_CHANGED: '评阅记录已变化，本次索引未保存，请刷新后重试',
  NODE_LIMIT:
    '知识点索引已达到 1000 条上限；本次未保存，请先移除不再需要的索引。已有历史和 PDF 不会自动删除',
  NODE_NOT_FOUND: '知识点索引已移除，请刷新后重试',
  REVISION_CONFLICT: '知识点索引已更新；本次修改未保存，请保留标签草稿并刷新后重试',
  REVIEW_CHANGED: '原评阅记录已变化或不可用，请重新生成知识点索引',
  UNKNOWN_SUBJECT: '旧提交缺少学科快照，不能为其推测教材关联',
  EVIDENCE_UNAVAILABLE: '所选 PDF 片段缺失或校验失败，请重新检索',
  SUBJECT_MISMATCH: '所选教材与评阅学科不一致',
  LINK_CHANGED: '原评阅记录已变化或不可用，本次关联未保存',
  REMOVAL_LIMIT: '索引移除记录已达到上限；本次未保存，已有历史保持不变',
  OPERATION_FAILED: '无法处理知识点索引；请检查本地来源后重试，原记录不会自动删除',
} as const
export type ReviewKnowledgeErrorCode = keyof typeof reviewKnowledgeErrorMessages
/** Only this fixed message catalog may be exposed over IPC; never forward source/filesystem messages. */
export class ReviewKnowledgeError extends Error {
  constructor(readonly code: ReviewKnowledgeErrorCode) {
    super(reviewKnowledgeErrorMessages[code])
    this.name = 'ReviewKnowledgeError'
  }
}

export interface ReviewKnowledgeSources {
  /** Trusted host lookup of an already committed submission. Never accept renderer review objects. */
  resolveAttempt(id: string): Promise<Attempt | undefined>
  /** Trusted LocalKnowledgeLibrary resolver, not model or renderer excerpts. */
  resolveChunks(ids: string[]): Promise<KnowledgeEvidence[]>
  /** Must verify current source.pdf bytes against their content-addressed document ID. */
  verifyDocument(documentId: string): Promise<void>
}
interface Operation {
  attempts: Map<string, Promise<Attempt | undefined>>
  documents: Map<string, Promise<void>>
  chunks: Map<string, Promise<KnowledgeEvidence>>
  reviews: WeakMap<Attempt, ReturnType<typeof seeds>>
  signal?: AbortSignal
}
interface Checked {
  node: ReviewKnowledgeNode
  evidence: KnowledgeEvidence[]
}
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
function clip(text: string, length: number): string {
  const end =
    text.length > length && /[\uD800-\uDBFF]/u.test(text[length - 1]) ? length - 1 : length
  return text.slice(0, end)
}
function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ReviewKnowledgeError('CANCELED')
}
function reviewIdentity(attempt: Attempt): string {
  // Property order comes from the strict canonical attempt schema, independent of caller JSON order.
  return hash(JSON.stringify(attempt))
}
function nodeIdentity(reviewId: string, source: ReviewKnowledgeRecord['source']): string {
  return `rkn-${hash(JSON.stringify({ reviewId, source }))}`
}
function seeds(
  attempt: Attempt,
): Omit<ReviewKnowledgeRecord, 'revision' | 'references' | 'createdAt' | 'updatedAt'>[] {
  const reviewId = reviewIdentity(attempt)
  const points = attempt.rubric.length
    ? attempt.rubric.map((item, rubricIndex) => ({
        source: { kind: 'rubric' as const, rubricId: item.id, rubricIndex },
        label: item.label,
        text: item.feedback,
      }))
    : [{ source: { kind: 'feedback' as const }, label: '评阅反馈', text: attempt.feedback }]
  return points.map(({ source, label, text }) => ({
    id: nodeIdentity(reviewId, source),
    attemptId: attempt.id,
    questionId: attempt.questionId,
    subject: attempt.questionSnapshot?.subject ?? null,
    reviewId,
    source,
    label: clip(label.trim() || '评阅反馈', 160),
    reviewExcerpt: clip(text, MAX_REVIEW_KNOWLEDGE_EXCERPT),
    excerptTruncated: text.length > MAX_REVIEW_KNOWLEDGE_EXCERPT,
  }))
}
function reference(evidence: KnowledgeEvidence): ReviewKnowledgeReference {
  return {
    documentId: evidence.documentId,
    documentSha256: evidence.documentId,
    documentTitle: evidence.documentTitle,
    subject: evidence.subject,
    pageNumber: evidence.pageNumber,
    chunkId: evidence.chunkId,
    textSha256: hash(evidence.text),
  }
}
function isMissing(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'PDF_NOT_FOUND' || error.code === 'ENOENT')
  )
}

/** Local derived index. No network, model dispatch, PDF mutations, or implicit retrieval consent. */
export class ReviewKnowledgeIndex {
  private readonly store: AtomicJsonStore<ReviewKnowledgeState>
  private queue: Promise<unknown> = Promise.resolve()
  constructor(
    userDataDirectory: string,
    private readonly sources: ReviewKnowledgeSources,
  ) {
    this.store = new AtomicJsonStore(
      join(userDataDirectory, 'review-knowledge-index.json'),
      reviewKnowledgeStateSchema,
      () => ({ version: 1, nodes: [], removedNodeIds: [] }),
    )
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation).catch((error: unknown) => {
      if (error instanceof ReviewKnowledgeError) throw error
      // AtomicJsonStore errors include a native profile path. Keep corruption fail-closed without exposing it.
      if (error instanceof Error && error.message.startsWith('无法读取学习数据：'))
        throw new ReviewKnowledgeError('CORRUPT')
      if (error && typeof error === 'object' && 'code' in error)
        throw new ReviewKnowledgeError('STORAGE')
      throw new ReviewKnowledgeError('OPERATION_FAILED')
    })
    this.queue = result.catch(() => undefined)
    return result
  }
  private operation(signal?: AbortSignal): Operation {
    abortIfNeeded(signal)
    return {
      attempts: new Map(),
      documents: new Map(),
      chunks: new Map(),
      reviews: new WeakMap(),
      signal,
    }
  }
  private async attempt(id: string, operation: Operation): Promise<Attempt | undefined> {
    let pending = operation.attempts.get(id)
    if (!pending) {
      pending = this.sources.resolveAttempt(id).then((raw) => {
        abortIfNeeded(operation.signal)
        if (raw === undefined) return undefined
        const attempt = attemptSchema.parse(raw)
        if (attempt.id !== id) throw new ReviewKnowledgeError('SOURCE_INVALID')
        return attempt
      })
      operation.attempts.set(id, pending)
    }
    return pending
  }
  private async chunk(id: string, operation: Operation): Promise<KnowledgeEvidence> {
    let pending = operation.chunks.get(id)
    if (!pending) {
      pending = (async () => {
        const documentId = id.split(':')[0]
        let verified = operation.documents.get(documentId)
        if (!verified) {
          verified = this.sources.verifyDocument(documentId)
          operation.documents.set(documentId, verified)
        }
        await verified
        abortIfNeeded(operation.signal)
        const result = z
          .array(knowledgeEvidenceSchema)
          .length(1)
          .parse(await this.sources.resolveChunks([id]))
        abortIfNeeded(operation.signal)
        const evidence = result[0]
        if (
          evidence.chunkId !== id ||
          evidence.documentId !== documentId ||
          !id.startsWith(`${evidence.documentId}:p${evidence.pageNumber}:`)
        )
          throw new ReviewKnowledgeError('EVIDENCE_INVALID')
        return evidence
      })()
      operation.chunks.set(id, pending)
    }
    return pending
  }
  private review(attempt: Attempt, operation: Operation): ReturnType<typeof seeds> {
    let points = operation.reviews.get(attempt)
    if (!points) {
      points = seeds(attempt)
      operation.reviews.set(attempt, points)
    }
    return points
  }
  private async checkSource(
    node: ReviewKnowledgeRecord,
    operation: Operation,
  ): Promise<ReviewKnowledgeStaleReason | undefined> {
    let attempt: Attempt | undefined
    try {
      attempt = await this.attempt(node.attemptId, operation)
    } catch {
      abortIfNeeded(operation.signal)
      return 'source-unavailable'
    }
    if (!attempt) return 'review-missing'
    const points = this.review(attempt, operation)
    if (points[0].reviewId !== node.reviewId) return 'review-changed'
    const canonical = points.find((candidate) => candidate.id === node.id)
    if (
      !canonical ||
      canonical.questionId !== node.questionId ||
      canonical.subject !== node.subject ||
      JSON.stringify(canonical.source) !== JSON.stringify(node.source) ||
      canonical.reviewExcerpt !== node.reviewExcerpt ||
      canonical.excerptTruncated !== node.excerptTruncated
    )
      return 'review-changed'
    return undefined
  }
  private async checked(node: ReviewKnowledgeRecord, operation: Operation): Promise<Checked> {
    const stale = (staleReason: ReviewKnowledgeStaleReason): Checked => ({
      node: { ...node, status: 'stale', staleReason },
      evidence: [],
    })
    const sourceFailure = await this.checkSource(node, operation)
    if (sourceFailure) return stale(sourceFailure)
    if (!node.references.length) return { node: { ...node, status: 'pending' }, evidence: [] }
    if (!node.subject) return stale('subject-changed')
    const evidence: KnowledgeEvidence[] = []
    for (const saved of node.references) {
      let current: KnowledgeEvidence
      try {
        current = await this.chunk(saved.chunkId, operation)
      } catch (error) {
        abortIfNeeded(operation.signal)
        return stale(isMissing(error) ? 'evidence-missing' : 'evidence-changed')
      }
      if (current.subject !== node.subject || current.subject !== saved.subject)
        return stale('subject-changed')
      if (
        saved.documentId !== current.documentId ||
        saved.documentSha256 !== current.documentId ||
        saved.pageNumber !== current.pageNumber ||
        saved.textSha256 !== hash(current.text)
      )
        return stale('evidence-changed')
      evidence.push(current)
    }
    // Labels/titles can be edited independently; references always display today's canonical book title.
    return {
      node: { ...node, status: 'linked', references: evidence.map(reference) },
      evidence,
    }
  }
  private async checkNodes(
    nodes: ReviewKnowledgeRecord[],
    operation: Operation,
  ): Promise<ReviewKnowledgeNode[]> {
    const result: ReviewKnowledgeNode[] = []
    for (const node of nodes) result.push((await this.checked(node, operation)).node)
    abortIfNeeded(operation.signal)
    return result
  }
  refresh(input: unknown, options: { signal?: AbortSignal } = {}): Promise<ReviewKnowledgeNode[]> {
    const request = reviewKnowledgeRefreshInputSchema.parse(input)
    return this.serialize(async () => {
      const operation = this.operation(options.signal)
      const incoming: ReviewKnowledgeRecord[] = []
      const now = new Date().toISOString()
      for (const id of request.attemptIds) {
        const attempt = await this.attempt(id, operation)
        if (!attempt) throw new ReviewKnowledgeError('ATTEMPT_NOT_FOUND')
        incoming.push(
          ...this.review(attempt, operation).map((seed) => ({
            ...seed,
            revision: 1,
            references: [],
            createdAt: now,
            updatedAt: now,
          })),
        )
      }
      const state = await this.store.update(async (current) => {
        // Resolve again immediately before committing after asynchronous source reads.
        for (const id of request.attemptIds) {
          operation.attempts.delete(id)
          const latest = await this.attempt(id, operation)
          if (
            !latest ||
            incoming.some(
              (node) =>
                node.attemptId === id &&
                node.reviewId !== this.review(latest, operation)[0].reviewId,
            )
          )
            throw new ReviewKnowledgeError('REFRESH_CHANGED')
        }
        abortIfNeeded(operation.signal)
        const known = new Set([...current.nodes.map((node) => node.id), ...current.removedNodeIds])
        const additions = incoming.filter((node) => !known.has(node.id))
        if (current.nodes.length + additions.length > MAX_REVIEW_KNOWLEDGE_NODES)
          throw new ReviewKnowledgeError('NODE_LIMIT')
        return { ...current, nodes: [...current.nodes, ...additions] }
      })
      // AtomicJsonStore's rename is the commit point. Late cancellation cannot hide saved work.
      operation.signal = undefined
      const ids = new Set(request.attemptIds)
      return this.checkNodes(
        state.nodes.filter((node) => ids.has(node.attemptId)),
        operation,
      )
    })
  }
  list(
    input: unknown = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<ReviewKnowledgeNode[]> {
    const request = reviewKnowledgeListInputSchema.parse(input)
    return this.serialize(async () => {
      const operation = this.operation(options.signal)
      const state = await this.store.load()
      return this.checkNodes(
        state.nodes.filter(
          (node) =>
            (!request.attemptId || node.attemptId === request.attemptId) &&
            (!request.questionId || node.questionId === request.questionId) &&
            (!request.subject || node.subject === request.subject),
        ),
        operation,
      )
    })
  }
  get(
    nodeId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ReviewKnowledgeNode | undefined> {
    const id = reviewKnowledgeNodeIdSchema.parse(nodeId)
    return this.serialize(async () => {
      const operation = this.operation(options.signal)
      const node = (await this.store.load()).nodes.find((candidate) => candidate.id === id)
      abortIfNeeded(operation.signal)
      return node ? (await this.checked(node, operation)).node : undefined
    })
  }
  private mutate(
    input: { nodeId: string; expectedRevision: number },
    update: (node: ReviewKnowledgeRecord, operation: Operation) => Promise<ReviewKnowledgeRecord>,
    options: { signal?: AbortSignal },
  ): Promise<ReviewKnowledgeNode> {
    return this.serialize(async () => {
      const operation = this.operation(options.signal)
      let changed!: ReviewKnowledgeRecord
      await this.store.update(async (state) => {
        const node = state.nodes.find((candidate) => candidate.id === input.nodeId)
        if (!node) throw new ReviewKnowledgeError('NODE_NOT_FOUND')
        if (node.revision !== input.expectedRevision)
          throw new ReviewKnowledgeError('REVISION_CONFLICT')
        changed = await update(node, operation)
        abortIfNeeded(operation.signal)
        changed = { ...changed, revision: node.revision + 1, updatedAt: new Date().toISOString() }
        return {
          ...state,
          nodes: state.nodes.map((candidate) => (candidate.id === node.id ? changed : candidate)),
        }
      })
      operation.signal = undefined
      return (await this.checked(changed, operation)).node
    })
  }
  updateLabel(
    input: unknown,
    options: { signal?: AbortSignal } = {},
  ): Promise<ReviewKnowledgeNode> {
    const request = reviewKnowledgeLabelInputSchema.parse(input)
    return this.mutate(request, async (node) => ({ ...node, label: request.label }), options)
  }
  associate(input: unknown, options: { signal?: AbortSignal } = {}): Promise<ReviewKnowledgeNode> {
    const request = reviewKnowledgeAssociateInputSchema.parse(input)
    return this.mutate(
      request,
      async (node, operation) => {
        if (await this.checkSource(node, operation))
          throw new ReviewKnowledgeError('REVIEW_CHANGED')
        if (!node.subject) throw new ReviewKnowledgeError('UNKNOWN_SUBJECT')
        const references: ReviewKnowledgeReference[] = []
        for (const chunkId of request.chunkIds) {
          let evidence: KnowledgeEvidence
          try {
            evidence = await this.chunk(chunkId, operation)
          } catch {
            abortIfNeeded(operation.signal)
            throw new ReviewKnowledgeError('EVIDENCE_UNAVAILABLE')
          }
          if (evidence.subject !== node.subject) throw new ReviewKnowledgeError('SUBJECT_MISMATCH')
          references.push(reference(evidence))
        }
        operation.attempts.delete(node.attemptId)
        if (await this.checkSource(node, operation)) throw new ReviewKnowledgeError('LINK_CHANGED')
        return { ...node, references }
      },
      options,
    )
  }
  removeAssociation(
    input: unknown,
    options: { signal?: AbortSignal } = {},
  ): Promise<ReviewKnowledgeNode> {
    const request = reviewKnowledgeMutationInputSchema.parse(input)
    return this.mutate(request, async (node) => ({ ...node, references: [] }), options)
  }
  removeNode(input: unknown, options: { signal?: AbortSignal } = {}): Promise<void> {
    const request = reviewKnowledgeMutationInputSchema.parse(input)
    return this.serialize(async () => {
      await this.store.update((state) => {
        abortIfNeeded(options.signal)
        const node = state.nodes.find((candidate) => candidate.id === request.nodeId)
        if (!node) throw new ReviewKnowledgeError('NODE_NOT_FOUND')
        if (node.revision !== request.expectedRevision)
          throw new ReviewKnowledgeError('REVISION_CONFLICT')
        if (state.removedNodeIds.length >= MAX_REVIEW_KNOWLEDGE_REMOVED_NODES)
          throw new ReviewKnowledgeError('REMOVAL_LIMIT')
        return {
          ...state,
          nodes: state.nodes.filter((candidate) => candidate.id !== node.id),
          removedNodeIds: [...state.removedNodeIds, node.id],
        }
      })
    })
  }
  /** Local-only canonical helper. Remote callers MUST additionally enforce the current explicit PDF/page selection and consent budget. */
  resolveEvidence(
    nodeId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<KnowledgeEvidence[]> {
    const id = reviewKnowledgeNodeIdSchema.parse(nodeId)
    return this.serialize(async () => {
      const operation = this.operation(options.signal)
      const node = (await this.store.load()).nodes.find((candidate) => candidate.id === id)
      abortIfNeeded(operation.signal)
      if (!node) return []
      const checked = await this.checked(node, operation)
      abortIfNeeded(operation.signal)
      return checked.node.status === 'linked' ? checked.evidence : []
    })
  }
}
