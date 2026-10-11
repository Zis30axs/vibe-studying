import { useEffect, useId, useRef, useState } from 'react'
import type { Attempt } from '../shared/types'
import {
  KNOWLEDGE_MATH_EXTRACTION_WARNING,
  MAX_KNOWLEDGE_EVIDENCE,
  type KnowledgeApi,
  type KnowledgeDocument,
  type KnowledgeHit,
} from '../shared/knowledge'
import type {
  ReviewKnowledgeApi,
  ReviewKnowledgeNode,
  ReviewKnowledgeReference,
  ReviewKnowledgeStaleReason,
} from '../shared/review-knowledge'
import { subjectLabel } from '../shared/subjects'
import { validPdfRange } from '../domain/pdf-reader'
import { KnowledgePdfCanvas } from './KnowledgePdfCanvas'
import './review-knowledge.css'

export type ReviewKnowledgePanelApi = ReviewKnowledgeApi &
  Pick<KnowledgeApi, 'listKnowledgeDocuments' | 'searchKnowledge' | 'getKnowledgePdf'>

export function supportsReviewKnowledge(
  api: Partial<ReviewKnowledgePanelApi> | null | undefined,
): api is ReviewKnowledgePanelApi {
  return Boolean(
    api &&
    (
      [
        'refreshReviewKnowledge',
        'listReviewKnowledge',
        'updateReviewKnowledgeLabel',
        'associateReviewKnowledge',
        'removeReviewKnowledgeAssociation',
        'removeReviewKnowledgeNode',
        'listKnowledgeDocuments',
        'searchKnowledge',
        'getKnowledgePdf',
      ] as const
    ).every((method) => typeof api[method] === 'function'),
  )
}

/** A changed saved submission must never inherit another review's selections or requests. */
export function reviewKnowledgeContextKey(attempt: Attempt): string {
  return JSON.stringify([
    attempt.id,
    attempt.questionId,
    attempt.submittedAt,
    attempt.questionSnapshot?.id,
    attempt.questionSnapshot?.subject,
    attempt.feedback,
    attempt.rubric,
    attempt.reviewer,
  ])
}

/** Pure helper: a late refresh/save must not overwrite text typed while it was in flight. */
export function reconcileReviewKnowledgeLabels(
  drafts: Readonly<Record<string, string>>,
  previous: readonly ReviewKnowledgeNode[],
  next: readonly ReviewKnowledgeNode[],
  saved?: { id: string; label: string },
  editedAfterRead: ReadonlySet<string> = new Set(),
): Record<string, string> {
  const old = new Map(previous.map((node) => [node.id, node.label]))
  return Object.fromEntries(
    next.map((node) => {
      const local = drafts[node.id]
      // For the saved field, even retyping the old persisted value is a newer edit.
      // Only the exact submitted text can be acknowledged by this response.
      const replace =
        saved?.id === node.id
          ? local === undefined || local === saved.label
          : local === undefined || local === old.get(node.id)
      return [
        node.id,
        replace && !editedAfterRead.has(node.id) ? node.label : (local ?? node.label),
      ]
    }),
  )
}

/** Synchronous lock and request generations also protect rapid repeated clicks before React commits. */
export class ReviewKnowledgeRequests {
  private live = true
  private generations = { load: 0, search: 0, preview: 0 }
  private write: symbol | null = null
  next(kind: keyof ReviewKnowledgeRequests['generations']): number {
    return ++this.generations[kind]
  }
  current(kind: keyof ReviewKnowledgeRequests['generations'], token: number): boolean {
    return this.live && this.generations[kind] === token
  }
  beginWrite(): symbol | null {
    if (!this.live || this.write) return null
    return (this.write = Symbol('review-knowledge-write'))
  }
  ownsWrite(token: symbol): boolean {
    return this.live && this.write === token
  }
  endWrite(token: symbol) {
    if (this.write === token) this.write = null
  }
  get writing(): boolean {
    return Boolean(this.write)
  }
  close() {
    this.live = false
  }
}

const staleMessages: Record<ReviewKnowledgeStaleReason, string> = {
  'review-missing': '原提交已不可用，无法核验审阅来源。',
  'review-changed': '原审阅内容已变化，请从当前反馈重新核对。',
  'source-unavailable': '原提交的学科信息缺失，不能推测教材学科。',
  'evidence-missing': '原 PDF 或片段已不可用，请重新导入原文件并核对。',
  'evidence-changed': 'PDF 或片段内容校验不一致，请重新核对。',
  'subject-changed': '教材学科已变化，请重新选择同学科材料。',
}
export const reviewKnowledgeStatusLabels = {
  pending: '待关联',
  linked: '已关联 · 用户确认',
  stale: '已失效 · 待核对',
} as const
const messageOf = (error: unknown) =>
  error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
    : '索引操作失败，请刷新后重试。'

export function ReviewKnowledgePanel({
  api,
  attempt,
}: {
  api: ReviewKnowledgePanelApi
  attempt: Attempt
}) {
  // Keying the inner editor protects callers that reuse this component across submissions.
  return (
    <ReviewKnowledgeEditor key={reviewKnowledgeContextKey(attempt)} api={api} attempt={attempt} />
  )
}

function ReviewKnowledgeEditor({
  api,
  attempt,
}: {
  api: ReviewKnowledgePanelApi
  attempt: Attempt
}) {
  const headingId = useId()
  const [nodes, setNodes] = useState<ReviewKnowledgeNode[]>([])
  const nodeRef = useRef(nodes)
  const [labels, setLabels] = useState<Record<string, string>>({})
  const labelEditVersions = useRef(new Map<string, number>())
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [removeId, setRemoveId] = useState<string | null>(null)
  const [documentId, setDocumentId] = useState('')
  const [start, setStart] = useState('1')
  const [end, setEnd] = useState('1')
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)
  const [hits, setHits] = useState<KnowledgeHit[]>([])
  const [chosen, setChosen] = useState<string[]>([])
  const [opening, setOpening] = useState(false)
  const [preview, setPreview] = useState<{
    document: KnowledgeDocument
    pageNumber: number
  } | null>(null)
  const requests = useRef(new ReviewKnowledgeRequests())
  const searchPending = useRef(false)
  const previewPending = useRef(false)
  const editing = nodes.find((node) => node.id === editingId)
  const eligibleDocuments = documents.filter((document) => document.subject === editing?.subject)
  const selectedDocument = eligibleDocuments.find((document) => document.id === documentId)
  const rangeValid = Boolean(
    selectedDocument && validPdfRange(Number(start), Number(end), selectedDocument.pageCount),
  )

  function applyNodes(
    next: ReviewKnowledgeNode[],
    saved?: { id: string; label: string },
    readStartedAt?: ReadonlyMap<string, number>,
  ) {
    // The host is authoritative, but its response must still belong to this displayed submission.
    const scoped = next.filter(
      (node) => node.attemptId === attempt.id && node.questionId === attempt.questionId,
    )
    const previous = nodeRef.current
    nodeRef.current = scoped
    setNodes(scoped)
    const editedAfterRead = new Set(
      scoped
        .filter(
          (node) =>
            readStartedAt &&
            (labelEditVersions.current.get(node.id) ?? 0) !== (readStartedAt.get(node.id) ?? 0),
        )
        .map((node) => node.id),
    )
    setLabels((local) =>
      reconcileReviewKnowledgeLabels(local, previous, scoped, saved, editedAfterRead),
    )
  }

  async function load(materialize = true, gate = requests.current) {
    if (gate.writing) return
    const token = gate.next('load')
    const readStartedAt = new Map(labelEditVersions.current)
    setLoading(true)
    setError('')
    try {
      const next = materialize
        ? await api.refreshReviewKnowledge({ attemptIds: [attempt.id] })
        : await api.listReviewKnowledge({ attemptId: attempt.id })
      if (!gate.current('load', token)) return
      applyNodes(next, undefined, readStartedAt)
      const docs = await api.listKnowledgeDocuments()
      if (gate.current('load', token)) setDocuments(docs)
    } catch (reason) {
      if (gate.current('load', token)) setError(messageOf(reason))
    } finally {
      if (gate.current('load', token)) setLoading(false)
    }
  }

  useEffect(() => {
    const gate = new ReviewKnowledgeRequests()
    requests.current = gate
    nodeRef.current = []
    setNodes([])
    setLabels({})
    labelEditVersions.current.clear()
    setDocuments([])
    setEditingId(null)
    setRemoveId(null)
    setPreview(null)
    setBusy(false)
    setOpening(false)
    searchPending.current = false
    previewPending.current = false
    void load(true, gate)
    return () => gate.close()
  }, [api, attempt.id, attempt.questionId])

  function resetSearch() {
    closePreview()
    requests.current.next('search')
    searchPending.current = false
    setSearching(false)
    setSearched(false)
    setHits([])
    setChosen([])
    setError('')
    setNotice('')
  }
  function closePreview() {
    requests.current.next('preview')
    previewPending.current = false
    setOpening(false)
    setPreview(null)
  }
  function beginAssociation(node: ReviewKnowledgeNode) {
    if (requests.current.writing) return
    resetSearch()
    closePreview()
    setEditingId(node.id)
    setRemoveId(null)
    const first = documents.find((document) => document.subject === node.subject)
    setDocumentId(first?.id ?? '')
    setStart('1')
    // Default to one physical page, never silently search a whole book.
    setEnd('1')
    setQuery((labels[node.id] ?? node.label).trim())
  }
  function cancelAssociation() {
    if (requests.current.writing) return
    resetSearch()
    setEditingId(null)
  }

  async function search() {
    if (!editing || !selectedDocument || !rangeValid || !query.trim() || searchPending.current)
      return
    const gate = requests.current
    const token = gate.next('search')
    const selected = selectedDocument
    const first = Number(start)
    const last = Number(end)
    searchPending.current = true
    setSearching(true)
    setSearched(false)
    setHits([])
    setChosen([])
    setError('')
    try {
      const results = await api.searchKnowledge({
        documentId: selected.id,
        subject: selected.subject,
        query: query.trim(),
        startPage: first,
        endPage: last,
        limit: 12,
      })
      if (!gate.current('search', token)) return
      setHits(
        results.filter(
          (hit) =>
            hit.documentId === selected.id &&
            hit.subject === editing.subject &&
            hit.pageNumber >= first &&
            hit.pageNumber <= last,
        ),
      )
      setSearched(true)
    } catch (reason) {
      if (gate.current('search', token)) setError(messageOf(reason))
    } finally {
      if (gate.current('search', token)) {
        searchPending.current = false
        setSearching(false)
      }
    }
  }

  async function mutate(
    node: ReviewKnowledgeNode,
    action: 'label' | 'associate' | 'unlink' | 'remove',
  ) {
    const gate = requests.current
    if (
      loading ||
      (action === 'associate' && (!editing || editing.id !== node.id || !chosen.length))
    )
      return
    const token = gate.beginWrite()
    if (!token) return
    gate.next('load')
    gate.next('preview')
    setOpening(false)
    setPreview(null)
    previewPending.current = false
    setBusy(true)
    setError('')
    setNotice('')
    const label = labels[node.id] ?? node.label
    const input = { nodeId: node.id, expectedRevision: node.revision }
    try {
      if (action === 'remove') {
        await api.removeReviewKnowledgeNode(input)
        if (!gate.ownsWrite(token)) return
        applyNodes(nodeRef.current.filter((item) => item.id !== node.id))
        resetSearch()
        setEditingId(null)
        setRemoveId(null)
        setNotice('知识点索引已移除；提交记录与 PDF 均保留，刷新不会自动恢复。')
        return
      }
      const updated =
        action === 'label'
          ? await api.updateReviewKnowledgeLabel({ ...input, label })
          : action === 'associate'
            ? await api.associateReviewKnowledge({ ...input, chunkIds: [...chosen] })
            : await api.removeReviewKnowledgeAssociation(input)
      if (!gate.ownsWrite(token)) return
      if (
        updated.id !== node.id ||
        updated.attemptId !== attempt.id ||
        updated.questionId !== attempt.questionId
      )
        throw new Error('索引返回的提交不一致，请刷新后重试。')
      applyNodes(
        nodeRef.current.map((item) => (item.id === updated.id ? updated : item)),
        action === 'label' ? { id: node.id, label } : undefined,
      )
      if (action === 'associate') {
        resetSearch()
        setEditingId(null)
      }
      setNotice(
        action === 'label'
          ? '标签已保存。'
          : action === 'associate'
            ? '关联已保存；原文身份由本机校验，相关性仍请自行核对。'
            : '关联已移除，PDF 原文件保留。',
      )
    } catch (reason) {
      if (gate.ownsWrite(token)) {
        // Failed CAS must require a fresh explicit selection, not a blind retry of old evidence.
        if (action === 'associate') resetSearch()
        setError(`${messageOf(reason)} 本地标签草稿保留；可刷新索引后重试。`)
      }
    } finally {
      if (gate.ownsWrite(token)) setBusy(false)
      gate.endWrite(token)
    }
  }

  async function openReference(node: ReviewKnowledgeNode, reference: ReviewKnowledgeReference) {
    if (requests.current.writing || previewPending.current) return
    const gate = requests.current
    const token = gate.next('preview')
    const readStartedAt = new Map(labelEditVersions.current)
    previewPending.current = true
    setOpening(true)
    setPreview(null)
    setError('')
    try {
      // Recheck saved hashes before opening a previously confirmed citation.
      const current = await api.listReviewKnowledge({ attemptId: attempt.id })
      if (!gate.current('preview', token)) return
      const checked = current.find(
        (item) =>
          item.id === node.id &&
          item.attemptId === attempt.id &&
          item.questionId === attempt.questionId,
      )
      const verified = checked?.references.find(
        (item) =>
          item.chunkId === reference.chunkId &&
          item.documentSha256 === reference.documentSha256 &&
          item.textSha256 === reference.textSha256,
      )
      applyNodes(current, undefined, readStartedAt)
      if (checked?.status !== 'linked' || !verified)
        throw new Error('此关联已失效，未打开未经核验的引用。请重新核对。')
      const docs = await api.listKnowledgeDocuments()
      if (!gate.current('preview', token)) return
      setDocuments(docs)
      const document = docs.find(
        (item) => item.id === verified.documentId && item.subject === verified.subject,
      )
      if (!document || verified.pageNumber > document.pageCount)
        throw new Error('原 PDF 或物理页码已不可用，请重新导入原文件。')
      setPreview({ document, pageNumber: verified.pageNumber })
    } catch (reason) {
      if (gate.current('preview', token)) setError(messageOf(reason))
    } finally {
      if (gate.current('preview', token)) {
        previewPending.current = false
        setOpening(false)
      }
    }
  }

  return (
    <section
      className="review-knowledge"
      aria-labelledby={headingId}
      data-testid="review-knowledge"
    >
      <header className="review-knowledge-heading">
        <div>
          <span className="eyebrow">REVIEW → LOCAL PDF</span>
          <h3 id={headingId}>审阅知识点索引</h3>
        </div>
        <button
          type="button"
          disabled={loading || busy}
          onClick={() => {
            resetSearch()
            closePreview()
            setEditingId(null)
            setRemoveId(null)
            void load()
          }}
        >
          刷新索引
        </button>
      </header>
      <p className="review-knowledge-note">
        标签来自本次已保存的审阅反馈，可自行修改；不代表已读懂或概括整本教材。只有手动确认的片段才会成为
        PDF 关联。
      </p>
      <p className="review-knowledge-note">
        检索与索引保存在本机，不会自动上传 PDF，也不会调用付费模型。向 Agent 提供教材需在 Agent
        中另行选择与授权。
      </p>
      {loading && <p role="status">正在核对本次提交与本地索引…</p>}
      {error && (
        <p className="review-knowledge-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {!loading && !nodes.length && (
        <p>本次没有可索引的已保存反馈，或知识点已被移除；不补造知识点与页码。</p>
      )}
      <ol className="review-knowledge-points" aria-label="本次审阅知识点">
        {nodes.map((node) => (
          <li key={node.id} data-node-id={node.id} data-status={node.status}>
            <div className="review-knowledge-point-heading">
              <span className={`review-knowledge-status status-${node.status}`}>
                {reviewKnowledgeStatusLabels[node.status]}
              </span>
              <small>
                {node.subject ? subjectLabel[node.subject] : '学科未记录'} ·{' '}
                {node.source.kind === 'rubric' ? '评分项反馈' : '整体反馈'}
              </small>
            </div>
            <div className="review-knowledge-label-row">
              <label>
                知识点标签
                <input
                  maxLength={160}
                  value={labels[node.id] ?? node.label}
                  onChange={(event) => {
                    const value = event.target.value
                    labelEditVersions.current.set(
                      node.id,
                      (labelEditVersions.current.get(node.id) ?? 0) + 1,
                    )
                    setLabels((current) => ({ ...current, [node.id]: value }))
                  }}
                />
              </label>
              <button
                type="button"
                disabled={
                  busy ||
                  loading ||
                  !(labels[node.id] ?? '').trim() ||
                  labels[node.id] === node.label
                }
                onClick={() => void mutate(node, 'label')}
              >
                保存标签
              </button>
            </div>
            <details className="review-knowledge-provenance">
              <summary>查看反馈来源</summary>
              <p>
                {node.reviewExcerpt || '原反馈未包含正文。'}
                {node.excerptTruncated ? '（节选）' : ''}
              </p>
              <small>
                真实提交：{node.attemptId} · 题目：{node.questionId}
              </small>
              <small>审阅校验：{node.reviewId}</small>
            </details>
            {node.status === 'stale' && (
              <p className="review-knowledge-warning">
                {node.staleReason
                  ? staleMessages[node.staleReason]
                  : '关联暂时无法核验，请重新核对。'}
              </p>
            )}
            {!node.subject && (
              <p className="review-knowledge-warning">
                历史提交缺少学科快照，保留待核对状态，不借用当前题库推测关联。
              </p>
            )}
            <ul className="review-knowledge-references">
              {node.references.map((reference) => (
                <li key={reference.chunkId}>
                  <button
                    type="button"
                    disabled={node.status !== 'linked' || opening || busy || loading}
                    onClick={() => void openReference(node, reference)}
                  >
                    {reference.documentTitle} · PDF 物理第 {reference.pageNumber} 页
                  </button>
                </li>
              ))}
            </ul>
            {node.status === 'linked' && (
              <details className="review-knowledge-provenance">
                <summary>在 Agent 中使用此关联</summary>
                <label>
                  Agent 索引编号
                  <input
                    readOnly
                    value={node.id}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                </label>
                <p className="review-knowledge-note">
                  Agent
                  可用此索引编号取回原文；仍需另选对应教材页码并确认模型发送。仅展开或复制编号不会发送资料。
                </p>
              </details>
            )}
            <div className="review-knowledge-actions">
              <button
                type="button"
                disabled={
                  busy ||
                  loading ||
                  !node.subject ||
                  node.staleReason === 'review-missing' ||
                  node.staleReason === 'review-changed'
                }
                onClick={() => beginAssociation(node)}
              >
                {node.references.length ? '重新选择 PDF 片段' : '关联 PDF 片段'}
              </button>
              {node.references.length > 0 && (
                <button
                  type="button"
                  disabled={busy || loading}
                  onClick={() => void mutate(node, 'unlink')}
                >
                  移除关联（保留 PDF）
                </button>
              )}
              <button
                type="button"
                disabled={busy || loading}
                onClick={() => {
                  resetSearch()
                  setEditingId(null)
                  setRemoveId(node.id)
                }}
              >
                移除此知识点索引
              </button>
            </div>
            {removeId === node.id && (
              <section className="review-knowledge-remove" aria-label="确认移除知识点索引">
                <p>
                  仅移除「{labels[node.id] ?? node.label}」这条索引，保留提交记录和
                  PDF；刷新不会自动恢复。确认移除？
                </p>
                <div className="review-knowledge-actions">
                  <button type="button" disabled={busy} onClick={() => void mutate(node, 'remove')}>
                    确认移除知识点
                  </button>
                  <button type="button" disabled={busy} onClick={() => setRemoveId(null)}>
                    保留知识点
                  </button>
                </div>
              </section>
            )}
          </li>
        ))}
      </ol>
      {editing && (
        <section className="review-knowledge-picker" aria-label="选择本地 PDF 片段">
          <div className="review-knowledge-heading">
            <h4>为「{labels[editing.id] ?? editing.label}」选择原文</h4>
            <button type="button" disabled={busy} onClick={cancelAssociation}>
              取消关联
            </button>
          </div>
          {!eligibleDocuments.length ? (
            <p>没有同学科的已导入 PDF。请先在教材知识库导入；不会生成新的关联。</p>
          ) : (
            <>
              <label>
                同学科已导入 PDF
                <select
                  value={documentId}
                  disabled={busy}
                  onChange={(event) => {
                    resetSearch()
                    setDocumentId(event.target.value)
                    setStart('1')
                    setEnd('1')
                  }}
                >
                  {eligibleDocuments.map((document) => (
                    <option key={document.id} value={document.id}>
                      {document.title}
                    </option>
                  ))}
                </select>
              </label>
              <div className="review-knowledge-range">
                <label>
                  物理起始页
                  <input
                    type="number"
                    min={1}
                    max={selectedDocument?.pageCount}
                    value={start}
                    disabled={busy}
                    onChange={(event) => {
                      resetSearch()
                      setStart(event.target.value)
                    }}
                  />
                </label>
                <label>
                  物理结束页
                  <input
                    type="number"
                    min={1}
                    max={selectedDocument?.pageCount}
                    value={end}
                    disabled={busy}
                    onChange={(event) => {
                      resetSearch()
                      setEnd(event.target.value)
                    }}
                  />
                </label>
              </div>
              <p className="review-knowledge-note">
                仅检索上面明确选择的物理页码（共 {selectedDocument?.pageCount ?? 0}{' '}
                页），不猜测书中印刷页码。
              </p>
              {!rangeValid && (
                <p className="review-knowledge-warning">请填写文件范围内完整、有效的起止页码。</p>
              )}
              {editing.subject === 'math' && (
                <p className="review-knowledge-warning">{KNOWLEDGE_MATH_EXTRACTION_WARNING}</p>
              )}
              <label>
                本地检索词
                <input
                  maxLength={300}
                  value={query}
                  disabled={busy}
                  onChange={(event) => {
                    resetSearch()
                    setQuery(event.target.value)
                  }}
                />
              </label>
              <button
                type="button"
                disabled={busy || searching || !rangeValid || !query.trim()}
                onClick={() => void search()}
              >
                {searching ? '本地检索中…' : '在所选页码检索'}
              </button>
              {searched && !hits.length && (
                <p role="status">
                  未找到匹配片段，不生成新的引用；未关联项继续待关联。可调整检索词和页码后重试。
                </p>
              )}
              {hits.length > 0 && (
                <>
                  <p className="review-knowledge-note">
                    以下是实际提取的原文片段；文本匹配不证明与反馈相关。请核对后明确确认，最多{' '}
                    {MAX_KNOWLEDGE_EVIDENCE} 段。
                  </p>
                  <ol className="review-knowledge-hits">
                    {hits.map((hit) => (
                      <li key={hit.chunkId}>
                        <label className="review-knowledge-hit-choice">
                          <input
                            type="checkbox"
                            checked={chosen.includes(hit.chunkId)}
                            disabled={
                              busy ||
                              (!chosen.includes(hit.chunkId) &&
                                chosen.length >= MAX_KNOWLEDGE_EVIDENCE)
                            }
                            onChange={(event) =>
                              setChosen((current) =>
                                event.target.checked
                                  ? [...new Set([...current, hit.chunkId])].slice(
                                      0,
                                      MAX_KNOWLEDGE_EVIDENCE,
                                    )
                                  : current.filter((id) => id !== hit.chunkId),
                              )
                            }
                          />
                          PDF 物理第 {hit.pageNumber} 页
                        </label>
                        <p>{hit.text}</p>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            closePreview()
                            if (selectedDocument)
                              setPreview({ document: selectedDocument, pageNumber: hit.pageNumber })
                          }}
                        >
                          核对原页 · 第 {hit.pageNumber} 页
                        </button>
                      </li>
                    ))}
                  </ol>
                  <button
                    type="button"
                    className="primary"
                    disabled={busy || !chosen.length}
                    onClick={() => void mutate(editing, 'associate')}
                  >
                    确认关联所选 {chosen.length} 段
                  </button>
                </>
              )}
            </>
          )}
          {busy && (
            <p role="status">正在保存已确认的操作，请稍候。关闭页面不会撤回已经提交的保存。</p>
          )}
        </section>
      )}
      {(preview || opening) && (
        <section className="review-knowledge-reader" aria-label="关联 PDF 原页">
          <header className="review-knowledge-heading">
            <h4>
              {preview
                ? `${preview.document.title} · PDF 物理第 ${preview.pageNumber} 页`
                : '正在核验已保存引用…'}
            </h4>
            <button type="button" onClick={closePreview}>
              关闭原页
            </button>
          </header>
          {preview && (
            <KnowledgePdfCanvas
              api={api}
              document={preview.document}
              pageNumber={preview.pageNumber}
              zoom={1}
            />
          )}
        </section>
      )}
    </section>
  )
}
