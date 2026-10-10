import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ArgumentDocument,
  ArgumentNode,
  ExamCraftApi,
  ModelConfig,
  ModuleReviewResult,
  ModuleReviewSuggestion,
  StudentQuestion,
} from '../shared/types'
import './module-review.css'

export interface ModuleReviewPanelProps {
  document: ArgumentDocument
  disabled?: boolean
  question: StudentQuestion
  config: ModelConfig | null
  api: ExamCraftApi
  selectedNodeId?: string | null
  onSelect: (nodeId: string, span?: { start: number; end: number }) => void
  onApply: (suggestion: ModuleReviewSuggestion) => { ok: boolean; message?: string }
}
const labels: Record<ArgumentNode['kind'], string> = {
  principle: '观点 / 原理',
  material: '材料 / 证据',
  analysis: '分析',
  conclusion: '结论',
  cause: '因果链',
  contrast: '对比结构',
  point: '分论点',
}
function flatten(nodes: ArgumentNode[]): ArgumentNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)])
}
function pickRoots(nodes: ArgumentNode[], ids: string[]): ArgumentNode[] {
  return nodes.flatMap((node) => (ids.includes(node.id) ? [node] : pickRoots(node.children, ids)))
}
const priorityLabels = { 'must-fix': '优先修正', optional: '可选改进', uncertain: '需要核实' }

/** Review is an explicit cloud operation. It never owns or writes the final answer. */
export function ModuleReviewPanel({
  document: argument,
  disabled = false,
  question,
  config,
  api,
  selectedNodeId,
  onSelect,
  onApply,
}: ModuleReviewPanelProps) {
  const [open, setOpen] = useState(false)
  const [scope, setScope] = useState<'selected' | 'all'>('selected')
  const [checked, setChecked] = useState<string[]>([])
  const [span, setSpan] = useState<{
    moduleId: string
    start: number
    end: number
    expectedText: string
  } | null>(null)
  const [consent, setConsent] = useState(false)
  const [includeReference, setIncludeReference] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ModuleReviewResult | null>(null)
  const [stale, setStale] = useState(false)
  const [error, setError] = useState('')
  const [decisions, setDecisions] = useState<Record<string, 'accepted' | 'rejected'>>({})
  const active = useRef<string | null>(null)
  const toolbar = useRef<HTMLButtonElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const sourceKey = JSON.stringify({
    question: {
      id: question.id,
      subject: question.subject,
      prompt: question.prompt,
      choices: question.choices,
    },
    roots: argument.roots,
  })
  const configKey = JSON.stringify(config)
  const currentSource = useRef(sourceKey)
  currentSource.current = sourceKey
  const currentConfig = useRef(configKey)
  currentConfig.current = configKey
  const nodes = useMemo(() => flatten(argument.roots), [argument.roots])
  const roots = scope === 'all' ? argument.roots : pickRoots(argument.roots, checked)
  const included = flatten(roots)
  const single = included.length === 1 ? included[0] : null
  const cancel = useCallback(() => {
    const id = active.current
    active.current = null
    if (id) void api.cancelModuleReview(id).catch(() => {})
    setBusy(false)
  }, [api])
  const invalidate = useCallback(() => {
    cancel()
    setConsent(false)
    setStale(true)
  }, [cancel])
  useEffect(() => {
    invalidate()
    setSpan(null)
  }, [sourceKey, configKey, invalidate])
  useEffect(() => {
    if (disabled) invalidate()
  }, [disabled, invalidate])
  useEffect(() => {
    setOpen(false)
    setResult(null)
    setError('')
    setChecked([])
    setIncludeReference(false)
    setDecisions({})
  }, [question.id])
  useEffect(
    () => () => {
      const id = active.current
      active.current = null
      if (id) void api.cancelModuleReview(id).catch(() => {})
    },
    [api],
  )
  const close = useCallback(() => {
    cancel()
    setOpen(false)
    setConsent(false)
    setIncludeReference(false)
    setResult(null)
    setError('')
    toolbar.current?.focus()
  }, [cancel])
  useEffect(() => {
    if (!open) return
    closeButton.current?.focus()
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
      }
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [open, close])
  function changeScope(next: 'selected' | 'all') {
    invalidate()
    setScope(next)
    setSpan(null)
    setError('')
  }
  async function send() {
    if (disabled || !consent || busy || active.current || !config?.configured || !included.length)
      return
    const requestId = crypto.randomUUID()
    const source = sourceKey
    const destination = configKey
    active.current = requestId
    setBusy(true)
    setConsent(false)
    setResult(null)
    setDecisions({})
    setError('')
    setStale(false)
    try {
      const response = await api.reviewModules({
        requestId,
        cloudConsent: true,
        configRevision: config.revision,
        scope,
        questionId: question.id,
        includeReference,
        roots,
        ...(span ? { selectedSpans: [span] } : {}),
      })
      if (
        active.current !== requestId ||
        currentSource.current !== source ||
        currentConfig.current !== destination
      )
        return
      if (
        response.requestId !== requestId ||
        response.configRevision !== config.revision ||
        !Array.isArray(response.suggestions) ||
        response.suggestions.length > 5 ||
        !Array.isArray(response.confirmations) ||
        response.confirmations.length > 3 ||
        typeof response.summary !== 'string'
      )
        throw new Error('invalid')
      const ids = new Set<string>()
      for (const confirmation of response.confirmations) {
        if (
          !included.some((node) => node.id === confirmation.moduleId) ||
          typeof confirmation.text !== 'string'
        )
          throw new Error('invalid')
      }
      for (const suggestion of response.suggestions) {
        const node = included.find((node) => node.id === suggestion.moduleId)
        const edit = suggestion.edit
        if (
          !node ||
          !suggestion.id ||
          ids.has(suggestion.id) ||
          !Object.hasOwn(priorityLabels, suggestion.priority) ||
          typeof suggestion.reason !== 'string' ||
          typeof suggestion.evidence !== 'string'
        )
          throw new Error('invalid')
        ids.add(suggestion.id)
        if (
          edit &&
          (suggestion.priority === 'uncertain' ||
            edit.operation !== 'replace' ||
            edit.baseText !== node.text ||
            !Number.isInteger(edit.start) ||
            !Number.isInteger(edit.end) ||
            edit.start < 0 ||
            edit.end < edit.start ||
            edit.end > node.text.length ||
            node.text.slice(edit.start, edit.end) !== edit.expectedText ||
            typeof edit.replacement !== 'string' ||
            (span && (span.moduleId !== node.id || edit.start < span.start || edit.end > span.end)))
        )
          throw new Error('invalid')
      }
      setResult(response)
    } catch {
      if (active.current === requestId)
        setError('检查未完成，或返回内容无效。请检查接口设置后重新确认发送；未修改任何模块。')
    } finally {
      if (active.current === requestId) {
        active.current = null
        setBusy(false)
      }
    }
  }
  function accept(suggestion: ModuleReviewSuggestion) {
    const node = nodes.find((node) => node.id === suggestion.moduleId)
    if (disabled || stale || !suggestion.edit || node?.text !== suggestion.edit.baseText) {
      setStale(true)
      setError('模块已变化，请重新检查。')
      return
    }
    const applied = onApply(suggestion)
    if (applied.ok) {
      setDecisions((previous) => ({ ...previous, [suggestion.id]: 'accepted' }))
      setStale(true)
      setConsent(false)
    } else {
      setStale(true)
      setError(applied.message || '原文已变化，无法应用此建议。')
    }
  }
  return (
    <div className="module-review" data-advisor-exclude>
      <button
        ref={toolbar}
        disabled={disabled}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          invalidate()
          setOpen(true)
          setIncludeReference(false)
          setConsent(false)
          setChecked(selectedNodeId ? [selectedNodeId] : [])
          setSpan(null)
          setResult(null)
          setError('')
        }}
      >
        ✦ 检查模块
      </button>
      {open && (
        <section
          className="module-review-panel"
          role="dialog"
          aria-modal="false"
          aria-labelledby="module-review-title"
        >
          <header>
            <div>
              <span className="eyebrow">ADVISOR · 模块顾问</span>
              <h3 id="module-review-title">模块检查 · 保留好思路</h3>
            </div>
            <button ref={closeButton} type="button" aria-label="关闭模块检查" onClick={close}>
              ×
            </button>
          </header>
          <p className="module-review-muted">
            先确认有依据的优点，只提出影响论证的关键问题，最多 5
            条。逐条决定是否修改模块；成文答案保持独立。
          </p>
          <fieldset>
            <legend>本次检查范围</legend>
            <label>
              <input
                type="radio"
                name="module-review-scope"
                checked={scope === 'selected'}
                onChange={() => changeScope('selected')}
              />
              选择模块
            </label>
            <label>
              <input
                type="radio"
                name="module-review-scope"
                checked={scope === 'all'}
                onChange={() => changeScope('all')}
              />
              全部模块
            </label>
          </fieldset>
          {scope === 'selected' && (
            <div className="module-review-choices">
              {nodes.map((node) => (
                <label key={node.id}>
                  <input
                    type="checkbox"
                    checked={checked.includes(node.id)}
                    onChange={(event) => {
                      invalidate()
                      setSpan(null)
                      setChecked((previous) =>
                        event.target.checked
                          ? [...previous, node.id]
                          : previous.filter((id) => id !== node.id),
                      )
                    }}
                  />
                  <span>
                    {labels[node.kind]} · {node.text.slice(0, 48) || '空模块'}
                    {node.children.length > 0 ? '（含全部子模块）' : ''}
                  </span>
                </label>
              ))}
            </div>
          )}
          {!included.length && <p role="status">请选择至少一个模块。</p>}
          <details className="module-review-payload">
            <summary>核对发送内容 · {included.length} 个模块 + 必要题目信息</summary>
            <p>{question.subject}</p>
            <p>{question.prompt}</p>
            {question.choices?.map((option) => (
              <p key={option.id}>
                {option.id}. {option.text}
              </p>
            ))}
            {included.map((node) => (
              <div key={node.id}>
                <strong>{labels[node.kind]}</strong>
                <p>{node.text || '（空模块）'}</p>
              </div>
            ))}
          </details>
          {single && (
            <label className="module-review-span">
              可选：在原文快照中选中一段，只修改该片段
              <textarea
                readOnly
                aria-label="模块原文快照"
                rows={3}
                value={single.text}
                onSelect={(event) => {
                  const input = event.currentTarget
                  const start = input.selectionStart
                  const end = input.selectionEnd
                  if (start === end) return
                  invalidate()
                  setSpan({
                    moduleId: single.id,
                    start,
                    end,
                    expectedText: single.text.slice(start, end),
                  })
                }}
              />
            </label>
          )}
          {span && (
            <div className="module-review-span">
              <p>限定片段：{span.expectedText}</p>
              <button
                type="button"
                onClick={() => {
                  invalidate()
                  setSpan(null)
                }}
              >
                清除片段限制
              </button>
              <small>仍发送上方模块全文以核对上下文，建议只能修改所选片段。</small>
            </div>
          )}
          <label className="module-review-reference">
            <input
              type="checkbox"
              checked={includeReference}
              onChange={(event) => {
                invalidate()
                setIncludeReference(event.target.checked)
                setError('')
              }}
            />
            允许顾问参考本题解析和评分依据（仅发送至顾问模型）
          </label>
          <p className="module-review-muted">
            {includeReference
              ? '主进程将按题号补充本题解析和评分依据，仅供顾问模型参考。作答工作区不会收到这些内容。'
              : '默认仅检查所选模块和必要题目信息。作答工作区不接收解析和评分依据。'}
          </p>
          <dl className="module-review-destination">
            <dt>发送至</dt>
            <dd>{config?.baseUrl || '尚未配置接口'}</dd>
            <dt>协议 / 模型</dt>
            <dd>{config ? `${config.protocol} / ${config.model}` : '请先配置模型'}</dd>
          </dl>
          <p className="module-review-muted">
            发送上方必要题目信息、所选模块的编号、类型、文字、层级，以及片段范围和检查指令。勾选参考授权时，另附本题解析和评分依据。密钥仅用于该服务商鉴权；不发送成文答案或其他顾问对话。
          </p>
          <label className="module-review-consent">
            <input
              type="checkbox"
              checked={consent}
              disabled={disabled || busy || !config?.configured || !included.length}
              onChange={(event) => setConsent(event.target.checked)}
            />
            我同意将上述检查内容（所选模块、必要题目信息
            {includeReference ? '、本题解析和评分依据' : ''}
            ）发送到此顾问接口与模型，可能产生服务商费用。
          </label>
          {!config?.configured && <p role="status">请先在模型设置中配置接口与本次会话的密钥。</p>}
          <div className="module-review-actions">
            <button
              type="button"
              disabled={disabled || !consent || !config?.configured || !included.length || busy}
              onClick={() => void send()}
            >
              {busy ? '正在检查…' : '确认并检查模块'}
            </button>
            {busy && (
              <button
                type="button"
                onClick={() => {
                  cancel()
                  setConsent(false)
                  setError('已取消检查。')
                }}
              >
                取消检查
              </button>
            )}
          </div>
          <div aria-live="polite">
            {error && <p role="alert">{error}</p>}
            {result && (
              <div className="module-review-results">
                <p>{result.summary}</p>
                {stale && (
                  <p className="module-review-stale" role="status">
                    模块、范围或模型设置已变化，剩余建议已失效。请重新检查后再应用。
                  </p>
                )}
                {!!result.confirmations.length && (
                  <section>
                    <h4>值得保留</h4>
                    {result.confirmations.map((item, index) => (
                      <button
                        type="button"
                        className="module-review-confirmation"
                        key={`${item.moduleId}-${index}`}
                        onClick={() => onSelect(item.moduleId)}
                      >
                        {item.text} <span>定位模块 ↗</span>
                      </button>
                    ))}
                  </section>
                )}
                {!result.suggestions.length && <p>没有需要优先修改的问题，可以保留当前表达。</p>}
                {[...result.suggestions]
                  .sort(
                    (a, b) =>
                      ['must-fix', 'optional', 'uncertain'].indexOf(a.priority) -
                      ['must-fix', 'optional', 'uncertain'].indexOf(b.priority),
                  )
                  .map((suggestion) => (
                    <article
                      className={`module-review-finding ${suggestion.priority}`}
                      key={suggestion.id}
                    >
                      <header>
                        <strong>{priorityLabels[suggestion.priority]}</strong>
                        <button
                          type="button"
                          onClick={() =>
                            onSelect(
                              suggestion.moduleId,
                              suggestion.edit
                                ? { start: suggestion.edit.start, end: suggestion.edit.end }
                                : undefined,
                            )
                          }
                        >
                          定位原文
                        </button>
                      </header>
                      <p>{suggestion.reason}</p>
                      <p className="module-review-evidence">依据：{suggestion.evidence}</p>
                      {suggestion.edit && (
                        <div className="module-review-diff">
                          <div>
                            <span>修改前</span>
                            <del>{suggestion.edit.expectedText || '（插入位置）'}</del>
                          </div>
                          <div>
                            <span>修改后</span>
                            <ins>{suggestion.edit.replacement || '（删除此段）'}</ins>
                          </div>
                        </div>
                      )}
                      <div className="module-review-actions">
                        {Object.hasOwn(decisions, suggestion.id) ? (
                          <span>
                            {decisions[suggestion.id] === 'accepted' ? '已接受' : '已拒绝'}
                          </span>
                        ) : (
                          <>
                            {suggestion.edit && (
                              <button
                                type="button"
                                disabled={disabled || stale || busy}
                                onClick={() => accept(suggestion)}
                              >
                                接受此修改
                              </button>
                            )}
                            <button
                              type="button"
                              disabled={disabled || stale || busy}
                              onClick={() =>
                                setDecisions((previous) => ({
                                  ...previous,
                                  [suggestion.id]: 'rejected',
                                }))
                              }
                            >
                              拒绝此建议
                            </button>
                          </>
                        )}
                      </div>
                    </article>
                  ))}
                <small>AI 判断可能有误；“需要核实”的内容不会提供可应用修改。</small>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  )
}
