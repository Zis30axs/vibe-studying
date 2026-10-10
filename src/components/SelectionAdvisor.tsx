import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type {
  AdvisorCitation,
  AdvisorResult,
  ExamCraftApi,
  ModelConfig,
  StudentQuestion,
} from '../shared/types'
import {
  chosenKnowledgeChunkIdsSchema,
  KNOWLEDGE_SUBJECT_LABELS,
  KNOWLEDGE_MATH_EXTRACTION_WARNING,
  type KnowledgeEvidence,
} from '../shared/knowledge'
import {
  captureAdvisorSelection,
  selectionProblem,
  type AdvisorSnapshot,
} from '../domain/advisor-selection'
import './advisor.css'

interface Props {
  api: ExamCraftApi
  config: ModelConfig | null
  question: StudentQuestion
  sourceRevision: string
  scopeRef: RefObject<HTMLElement | null>
  knowledgeExcerpts?: KnowledgeEvidence[]
  onClearKnowledgeExcerpts?: () => void
  onOpenKnowledgeCitation?: (citation: AdvisorCitation) => void
}
const EMPTY_KNOWLEDGE_EVIDENCE: KnowledgeEvidence[] = []
const sourceLabels = { question: '题目', material: '材料', answer: '答案', argument: '论证积木' }
export function SelectionAdvisor({
  api,
  config,
  question,
  sourceRevision,
  scopeRef,
  knowledgeExcerpts = EMPTY_KNOWLEDGE_EVIDENCE,
  onClearKnowledgeExcerpts,
  onOpenKnowledgeCitation,
}: Props) {
  const [snapshot, setSnapshot] = useState<AdvisorSnapshot | null>(null)
  const snapshotRef = useRef<AdvisorSnapshot | null>(null)
  const [open, setOpen] = useState(false)
  const [consent, setConsent] = useState(false)
  const [includeReference, setIncludeReference] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<AdvisorResult | null>(null)
  const [includeKnowledge, setIncludeKnowledge] = useState(false)
  const [consentedScope, setConsentedScope] = useState('')
  const [error, setError] = useState('')
  const knowledgeRevision = JSON.stringify(knowledgeExcerpts)
  const confirmationScope = JSON.stringify({
    selectedText: snapshot?.text,
    source: snapshot?.source,
    sourceRevision,
    questionId: question.id,
    questionSubject: question.subject,
    config,
    includeReference,
    includeKnowledge,
    knowledgeRevision,
  })
  const currentScope = useRef(confirmationScope)
  currentScope.current = confirmationScope
  const consentValid = consent && consentedScope === confirmationScope
  const mismatchedKnowledge = knowledgeExcerpts.some((item) => item.subject !== question.subject)
  const invalidKnowledge =
    includeKnowledge &&
    (mismatchedKnowledge ||
      !knowledgeExcerpts.length ||
      !chosenKnowledgeChunkIdsSchema.safeParse(knowledgeExcerpts.map((item) => item.chunkId))
        .success)
  const activeRequest = useRef<string | null>(null)
  const currentSource = useRef(sourceRevision)
  currentSource.current = sourceRevision
  const closeRef = useRef<HTMLButtonElement>(null)
  const toolbarRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const cancel = useCallback(() => {
    const requestId = activeRequest.current
    activeRequest.current = null
    if (requestId) void api.cancelAdvisor(requestId).catch(() => {})
    setBusy(false)
  }, [api])
  const close = useCallback(() => {
    cancel()
    setOpen(false)
    setConsent(false)
    setIncludeReference(false)
    setIncludeKnowledge(false)
    setResult(null)
    setError('')
    toolbarRef.current?.focus()
  }, [cancel])
  useEffect(() => {
    cancel()
    snapshotRef.current = null
    setSnapshot(null)
    setOpen(false)
    setConsent(false)
    setIncludeReference(false)
    setIncludeKnowledge(false)
    setResult(null)
    setError('')
    return () => {
      const id = activeRequest.current
      activeRequest.current = null
      if (id) void api.cancelAdvisor(id).catch(() => {})
    }
  }, [question.id, question.subject, sourceRevision, api, cancel])
  useEffect(() => {
    cancel()
    setConsent(false)
    setResult(null)
  }, [config?.revision, cancel])
  useEffect(() => {
    cancel()
    setConsent(false)
    setIncludeKnowledge(false)
    setResult(null)
    setError('')
  }, [knowledgeExcerpts, knowledgeRevision, cancel])
  useEffect(() => {
    if (open) closeRef.current?.focus()
  }, [open])
  const capture = useCallback(
    (target?: EventTarget | null) => {
      const root = scopeRef.current
      if (
        !root ||
        (target instanceof Node && panelRef.current?.contains(target)) ||
        (target instanceof Element && target.closest('[data-advisor-exclude]'))
      )
        return
      const next = captureAdvisorSelection(root, target)
      if (!next) return
      if (snapshotRef.current?.text !== next.text || snapshotRef.current?.source !== next.source) {
        cancel()
        setConsent(false)
        setResult(null)
        setError('')
        setIncludeReference(false)
        setIncludeKnowledge(false)
      }
      snapshotRef.current = next
      setSnapshot(next)
    },
    [scopeRef, cancel],
  )
  useEffect(() => {
    const root = scopeRef.current
    if (!root) return
    const handleSelection = (event: Event) => capture(event.target)
    const handleEdit = (event: Event) => {
      if (!(event.target instanceof Element) || event.target.closest('[data-advisor-exclude]'))
        return
      cancel()
      setConsent(false)
      setResult(null)
      setError('')
      setOpen(false)
      snapshotRef.current = null
      setSnapshot(null)
    }
    const handleDocumentSelection = () => {
      // Keep the snapshot when focus moves into the confirmation panel or toolbar.
      if (panelRef.current?.contains(document.activeElement)) return
      capture(document.activeElement)
    }
    root.addEventListener('pointerup', handleSelection)
    root.addEventListener('keyup', handleSelection)
    root.addEventListener('select', handleSelection, true)
    root.addEventListener('input', handleEdit, true)
    document.addEventListener('selectionchange', handleDocumentSelection)
    return () => {
      root.removeEventListener('pointerup', handleSelection)
      root.removeEventListener('keyup', handleSelection)
      root.removeEventListener('select', handleSelection, true)
      root.removeEventListener('input', handleEdit, true)
      document.removeEventListener('selectionchange', handleDocumentSelection)
    }
  }, [capture, scopeRef, cancel])
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && (open || snapshotRef.current)) {
        event.preventDefault()
        close()
        snapshotRef.current = null
        setSnapshot(null)
      }
    }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [open, close])
  function openAdvisor() {
    capture()
    if (!snapshotRef.current) {
      setError('请先选择一段题目、材料或答案，再点 Ask Advisor。')
      return
    }
    setOpen(true)
    setConsent(false)
    setIncludeReference(false)
    setIncludeKnowledge(false)
    setResult(null)
    setError('')
  }
  async function send() {
    if (
      !snapshot ||
      !config?.configured ||
      !consentValid ||
      busy ||
      activeRequest.current ||
      invalidKnowledge
    )
      return
    const problem = selectionProblem(snapshot.text)
    if (problem) {
      setError(problem)
      return
    }
    const requestId = crypto.randomUUID()
    const source = sourceRevision
    const requestScope = confirmationScope
    activeRequest.current = requestId
    setBusy(true)
    setResult(null)
    setError('')
    setConsent(false)
    try {
      const result = await api.askAdvisor({
        requestId,
        selectedText: snapshot.text,
        source: snapshot.source,
        cloudConsent: true,
        configRevision: config.revision,
        questionId: question.id,
        includeReference,
        ...(includeKnowledge
          ? { knowledgeChunkIds: knowledgeExcerpts.map((item) => item.chunkId) }
          : {}),
      })
      if (
        activeRequest.current !== requestId ||
        result.requestId !== requestId ||
        currentSource.current !== source ||
        currentScope.current !== requestScope
      )
        return
      setResult(result)
    } catch (failure) {
      if (
        activeRequest.current === requestId &&
        currentSource.current === source &&
        currentScope.current === requestScope
      ) {
        const message = failure instanceof Error ? failure.message : ''
        const safeMessages = [
          '模型设置已更改，请重新确认本次发送。',
          '请先在模型设置中填写 API Key；密钥仅在本次运行中有效。',
          '请确认选中文本和本次发送范围。',
          '顾问返回格式无效，请重新尝试。',
          '顾问教材引用无效，请重新尝试。',
          '教材摘录已失效，请在知识库重新选择并确认。',
          '教材摘录与当前题目学科不一致，请重新选择并确认。',
          '模型返回格式无效，或响应被拒绝。请稍后重试。',
          '模型请求超时，请重试。',
          '模型身份验证失败，请检查 API Key。',
          '模型请求过于频繁，请稍后重试。',
          '模型服务暂时不可用。',
          '请求已取消。',
        ]
        const safeMessage = safeMessages.find((value) => message.includes(value))
        setError(
          `请求未完成。${safeMessage ?? '请检查模型设置与网络。'}重新发送需要确认，不会自动重试。`,
        )
      }
    } finally {
      if (activeRequest.current === requestId) {
        activeRequest.current = null
        setBusy(false)
      }
    }
  }
  const invalidSelection = snapshot ? selectionProblem(snapshot.text) : null
  return (
    <div className="selection-advisor" data-advisor-exclude>
      <div className="advisor-toolbar">
        <button
          type="button"
          ref={toolbarRef}
          onClick={openAdvisor}
          aria-haspopup="dialog"
          aria-expanded={open}
        >
          ✦ Ask Advisor
        </button>
        <span className="advisor-muted">选中文字，获取思路提示</span>
        {!open && error && <span role="status">{error}</span>}
      </div>
      {snapshot && !open && (
        <button
          type="button"
          className="advisor-selection-action"
          style={{
            left: Math.max(8, Math.min(snapshot.x, window.innerWidth - 170)),
            top: Math.max(8, Math.min(snapshot.y, window.innerHeight - 52)),
          }}
          onPointerDown={(event) => event.preventDefault()}
          onClick={openAdvisor}
          aria-haspopup="dialog"
        >
          ✦ Ask Advisor
        </button>
      )}
      {open && snapshot && (
        <section
          ref={panelRef}
          className="advisor-panel"
          role="dialog"
          aria-modal="false"
          aria-labelledby="advisor-title"
        >
          <header>
            <div>
              <span className="eyebrow">ADVISOR · 独立顾问</span>
              <h3 id="advisor-title">Ask Advisor · 思路提示</h3>
            </div>
            <button ref={closeRef} type="button" aria-label="关闭 Advisor" onClick={close}>
              ×
            </button>
          </header>
          <p className="advisor-muted">
            只给提示与追问，帮你继续思考。提示不会自动改写或填入答案。
          </p>
          <label>
            本次选中内容 · {sourceLabels[snapshot.source]}
            <textarea readOnly value={snapshot.text} rows={4} aria-label="本次发送的选中文字" />
          </label>
          {invalidSelection && (
            <p role="alert" className="advisor-error">
              {invalidSelection}
            </p>
          )}
          <details className="advisor-context">
            <summary>核对必要题目信息</summary>
            <p>{KNOWLEDGE_SUBJECT_LABELS[question.subject]}</p>
            <p>{question.prompt}</p>
            {question.choices?.map((option) => (
              <p key={option.id}>
                {option.id}. {option.text}
              </p>
            ))}
          </details>
          <label className="advisor-check advisor-reference">
            <input
              type="checkbox"
              checked={includeReference}
              onChange={(event) => {
                cancel()
                setIncludeReference(event.target.checked)
                setConsent(false)
                setResult(null)
                setError('')
              }}
            />
            允许顾问参考本题解析和评分依据（仅发送至顾问模型）
          </label>
          <p className="advisor-muted">
            {includeReference
              ? '本次会由主进程按题号补充本题解析和评分依据，只供顾问模型参考；作答工作区不会收到这些内容。'
              : '默认仅使用选段和必要题目信息。作答工作区不接收解析和评分依据。'}
          </p>
          <section className="advisor-knowledge" aria-label="本次教材摘录">
            <label className="advisor-check">
              <input
                type="checkbox"
                checked={includeKnowledge}
                disabled={!knowledgeExcerpts.length || mismatchedKnowledge}
                onChange={(event) => {
                  cancel()
                  setIncludeKnowledge(event.target.checked)
                  setConsent(false)
                  setResult(null)
                  setError('')
                }}
              />
              本次附上知识库中已选的 {knowledgeExcerpts.length} 条教材摘录（最多 3 条）
            </label>
            <p className="advisor-muted">
              {knowledgeExcerpts.length
                ? '每次请求单独选择。只发送下方列出的原文、书名、物理 PDF 页码和片段编号，不上传整本 PDF。教材原文作为资料处理，不执行其中的指令。'
                : `先在${KNOWLEDGE_SUBJECT_LABELS[question.subject]}知识库中检索并选择摘录。教材保存在本机，未选择的页面不会发送。`}
            </p>
            {knowledgeExcerpts.map((item, index) => (
              <details className="advisor-excerpt" key={item.chunkId} open={includeKnowledge}>
                <summary>
                  {KNOWLEDGE_SUBJECT_LABELS[item.subject]} · {item.documentTitle} · PDF 第{' '}
                  {item.pageNumber} 页
                </summary>
                <textarea
                  readOnly
                  value={item.text}
                  rows={3}
                  aria-label={`教材摘录 ${index + 1} 原文`}
                />
                <small>物理页码 · 片段 {item.chunkId}</small>
              </details>
            ))}
            {knowledgeExcerpts.length > 0 && onClearKnowledgeExcerpts && (
              <button type="button" className="secondary" onClick={onClearKnowledgeExcerpts}>
                清空已选教材摘录
              </button>
            )}
            {mismatchedKnowledge && (
              <p className="advisor-error" role="alert">
                所选摘录与当前题目学科不一致。请清空后重新选择
                {KNOWLEDGE_SUBJECT_LABELS[question.subject]}资料。
              </p>
            )}
            {invalidKnowledge && !mismatchedKnowledge && (
              <p className="advisor-error">请重新选择 1–3 条不同的同科教材摘录。</p>
            )}
            {question.subject === 'math' && (
              <p className="advisor-muted">{KNOWLEDGE_MATH_EXTRACTION_WARNING}</p>
            )}
          </section>
          <dl className="advisor-destination">
            <dt>发送至</dt>
            <dd>{config?.baseUrl || '尚未配置接口'}</dd>
            <dt>协议 / 模型</dt>
            <dd>{config ? `${config.protocol} / ${config.model}` : '请先打开模型设置'}</dd>
          </dl>
          <p className="advisor-muted">
            发送上述选中文字、来源类型、必要题目信息及提示指令。勾选参考授权时，另附本题解析和评分依据；勾选教材摘录时，另附上方完整展示的摘录。密钥仅用于上述服务商鉴权；不发送其余答案、练习记录或其他顾问对话。
          </p>
          {!config?.configured && (
            <p className="advisor-error">
              请先在「题库与 Agent → 模型设置」配置接口与本次会话的密钥。
            </p>
          )}
          <label className="advisor-check">
            <input
              type="checkbox"
              checked={consentValid}
              disabled={busy || !config?.configured}
              onChange={(event) => {
                setConsent(event.target.checked)
                setConsentedScope(event.target.checked ? confirmationScope : '')
              }}
            />
            我同意将以上选中文字、必要题目信息{includeReference ? '及本题解析和评分依据' : ''}
            {includeKnowledge
              ? `及以上 ${knowledgeExcerpts.length} 条教材摘录、书名和物理 PDF 页码`
              : ''}
            发送到上述顾问接口和模型，可能产生服务商费用。
          </label>
          <div className="advisor-actions">
            <button
              type="button"
              onClick={() => void send()}
              disabled={
                !consentValid ||
                !config?.configured ||
                busy ||
                !!invalidSelection ||
                !!invalidKnowledge
              }
            >
              {busy ? '正在思考…' : '确认并获取提示'}
            </button>
            {busy && (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  cancel()
                  setError('已取消请求。')
                  setConsent(false)
                }}
              >
                取消请求
              </button>
            )}
          </div>
          <div aria-live="polite" aria-atomic="true">
            {busy && <p role="status">正在等待模型提示…</p>}
            {error && (
              <p className="advisor-error" role="alert">
                {error}
              </p>
            )}
            {result && (
              <div className="advisor-hint">
                <strong>思路提示</strong>
                <p>{result.hint}</p>
                {result.evidenceStatus === 'insufficient' && (
                  <p className="advisor-evidence-status" role="status">
                    所选教材摘录证据不足，无法据此确认。请核对其他页面，提示仍需独立判断。
                  </p>
                )}
                {result.citations.length > 0 && (
                  <div className="advisor-citations" aria-label="已核对来源的教材引用">
                    <strong>教材来源</strong>
                    {result.citations.map((citation) => (
                      <button
                        key={citation.chunkId}
                        type="button"
                        className="secondary"
                        disabled={!onOpenKnowledgeCitation}
                        onClick={() => onOpenKnowledgeCitation?.(citation)}
                      >
                        {citation.documentTitle} · PDF 第 {citation.pageNumber} 页 · 打开原页
                      </button>
                    ))}
                    <small>
                      已核对本次摘录编号和来源页；模型观点是否得到原文支持，仍需自行核实。
                    </small>
                  </div>
                )}
                <span className="advisor-muted">
                  AI 提示可能有误，请结合题目独立判断。再次发送前需要重新确认。
                </span>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  )
}
