import { useEffect, useRef, useState } from 'react'
import {
  EMBEDDING_DIAGNOSTIC_TEXT,
  embeddingConfigInputSchema,
  type EmbeddingApi,
  type EmbeddingConfig,
  type EmbeddingPreview,
  type EmbeddingResult,
} from '../shared/embeddings'
import {
  KNOWLEDGE_SUBJECT_LABELS,
  KNOWLEDGE_SUBJECTS,
  type KnowledgeApi,
  type KnowledgeDocument,
  type KnowledgeHit,
} from '../shared/knowledge'
import type { Subject } from '../shared/types'
import './web-research-settings.css'
import './embedding-settings.css'

type Api = EmbeddingApi & Pick<KnowledgeApi, 'listKnowledgeDocuments'>
const embeddingEndpoint = (value: string) =>
  value.endsWith('/embeddings') ? value : value + '/embeddings'
const keyLabels: Record<EmbeddingConfig['keyStatus'], string> = {
  missing: '尚未配置',
  locked: '已保存的密钥暂不可读取',
  saved: '已通过系统加密保存',
  session: '仅本次应用会话',
}

/** Local configuration and exact, one-use outbound previews; no automatic network work. */
export function EmbeddingSettings({ api }: { api: Api }) {
  const [config, setConfig] = useState<EmbeddingConfig | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1')
  const [model, setModel] = useState('text-embedding-3-small')
  const [apiKey, setApiKey] = useState('')
  const [persistApiKey, setPersistApiKey] = useState(false)
  const [clearApiKey, setClearApiKey] = useState(false)
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([])
  const [subject, setSubject] = useState<Subject>('math')
  const [documentId, setDocumentId] = useState('')
  const [startPage, setStartPage] = useState('1')
  const [endPage, setEndPage] = useState('1')
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<KnowledgeHit[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [preview, setPreview] = useState<EmbeddingPreview | null>(null)
  const [consent, setConsent] = useState(false)
  const [diagnosticConsent, setDiagnosticConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const mounted = useRef(false)
  const epoch = useRef(0)
  const operation = useRef(false)
  const document = documents.find((item) => item.id === documentId && item.subject === subject)
  const rangeValid = Boolean(
    document &&
    Number.isInteger(Number(startPage)) &&
    Number.isInteger(Number(endPage)) &&
    Number(startPage) >= 1 &&
    Number(endPage) >= Number(startPage) &&
    Number(endPage) <= document.pageCount &&
    Number(endPage) - Number(startPage) < 100,
  )
  const dirty =
    !!config &&
    (enabled !== config.enabled ||
      baseUrl !== config.baseUrl ||
      model !== config.model ||
      !!apiKey ||
      clearApiKey)
  const configured = !!config?.configured && config.enabled && !dirty

  function invalidate() {
    setPreview(null)
    setConsent(false)
    setDiagnosticConsent(false)
    setMessage('')
    setError('')
  }
  function scopeChanged() {
    invalidate()
    setHits([])
    setSelected([])
  }
  async function perform(action: () => Promise<void>, failure: string) {
    if (operation.current) return
    operation.current = true
    const current = ++epoch.current
    setBusy(true)
    setError('')
    try {
      await action()
    } catch {
      if (mounted.current && current === epoch.current) setError(failure)
    } finally {
      if (mounted.current && current === epoch.current) {
        operation.current = false
        setBusy(false)
      }
    }
  }
  function applyConfig(next: EmbeddingConfig) {
    setConfig(next)
    setEnabled(next.enabled)
    setBaseUrl(next.baseUrl)
    setModel(next.model)
    setApiKey('')
    setPersistApiKey(false)
    setClearApiKey(false)
    invalidate()
  }
  async function load() {
    await perform(async () => {
      const current = epoch.current
      const [next, docs] = await Promise.all([
        api.getEmbeddingConfig(),
        api.listKnowledgeDocuments(),
      ])
      if (!mounted.current || current !== epoch.current) return
      applyConfig(next)
      setDocuments(docs)
      setDocumentId((previous) =>
        docs.some((item) => item.id === previous && item.subject === subject)
          ? previous
          : (docs.find((item) => item.subject === subject)?.id ?? ''),
      )
      setHits([])
      setSelected([])
    }, '无法读取本地 Embedding 设置或教材目录。请重新读取；没有发出外部请求。')
  }
  useEffect(() => {
    mounted.current = true
    operation.current = false
    void load()
    return () => {
      mounted.current = false
      ++epoch.current
    }
  }, [api])

  async function save() {
    if (!config) return
    const parsed = embeddingConfigInputSchema.safeParse({
      enabled,
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      expectedRevision: config.revision,
      ...(apiKey.trim() && !clearApiKey ? { apiKey: apiKey.trim() } : {}),
      persistApiKey:
        !!apiKey.trim() && !clearApiKey && persistApiKey && config.secureStorageAvailable,
      clearApiKey,
    })
    if (!parsed.success) {
      setError(
        '请填写有效的 Embedding 模型 ID 与 HTTPS API 地址；本机服务可使用 localhost / 127.0.0.1 / [::1] HTTP。地址不能含凭据、参数或片段。',
      )
      return
    }
    await perform(async () => {
      const current = epoch.current
      setApiKey('')
      setPersistApiKey(false)
      invalidate()
      const next = await api.saveEmbeddingConfig(parsed.data)
      if (!mounted.current || current !== epoch.current) return
      applyConfig(next)
      setMessage('Embedding 设置已保存到本机；未发出连接测试或上传教材。')
    }, '保存失败或设置已变化。请重新读取后重试；密钥已从表单清空，没有自动重试。')
  }
  function showResult(result: EmbeddingResult) {
    setHits(result.hits ?? [])
    setSelected([])
    setMessage(
      result.mode === 'indexed'
        ? `已为本次所选片段建立本地向量索引（${result.indexedCount ?? 0} 条）。`
        : result.mode === 'vector'
          ? '已完成本次范围的向量检索。结果仍需对照教材原页核验。'
          : '已使用本地关键词检索；没有扩大教材范围。',
    )
  }
  async function localSearch() {
    if (!rangeValid || !query.trim()) return
    await perform(async () => {
      const current = epoch.current
      invalidate()
      const result = await api.searchEmbeddingLocal({
        subject,
        documentId,
        startPage: Number(startPage),
        endPage: Number(endPage),
        query: query.trim(),
        limit: 12,
      })
      if (mounted.current && current === epoch.current) showResult(result)
    }, '本地检索未完成。请检查教材与物理页码后重试。')
  }
  async function prepare(kind: 'index' | 'search') {
    if (!config || !configured || !rangeValid || (kind === 'index' && !selected.length)) return
    await perform(async () => {
      const current = epoch.current
      invalidate()
      const next = await api.prepareEmbedding({
        kind,
        subject,
        documentId,
        startPage: Number(startPage),
        endPage: Number(endPage),
        chunkIds: selected,
        ...(kind === 'search' ? { query: query.trim() } : {}),
        expectedRevision: config.revision,
      })
      if (mounted.current && current === epoch.current) setPreview(next)
    }, '无法准备外发预览。请重新检索、选择片段并核对设置；没有自动重试。')
  }
  async function confirm() {
    if (!preview || !consent) return
    const id = preview.previewId
    await perform(async () => {
      const current = epoch.current
      setPreview(null)
      setConsent(false)
      setMessage('')
      const result = await api.confirmEmbedding({ previewId: id, cloudConsent: true })
      if (mounted.current && current === epoch.current) showResult(result)
    }, '本次检索或索引未完成，或预览已过期。可重新使用本地关键词检索；没有自动重试。')
  }
  async function diagnose() {
    if (!config || !configured || !diagnosticConsent) return
    await perform(async () => {
      const current = epoch.current
      setDiagnosticConsent(false)
      setMessage('')
      const result = await api.diagnoseEmbedding({
        expectedRevision: config.revision,
        cloudConsent: true,
      })
      if (!mounted.current || current !== epoch.current) return
      setMessage(
        result.ok
          ? `Embedding 连接诊断成功，向量维度 ${result.dimensions ?? '未知'}。`
          : 'Embedding 连接诊断未通过。请检查地址、模型、密钥和网络；没有自动重试。',
      )
    }, 'Embedding 连接诊断未完成。请检查设置和网络；没有自动重试。')
  }
  async function clearIndex() {
    if (!rangeValid) return
    await perform(async () => {
      const current = epoch.current
      invalidate()
      await api.clearEmbeddingIndex({
        subject,
        documentId,
        startPage: Number(startPage),
        endPage: Number(endPage),
      })
      if (mounted.current && current === epoch.current)
        setMessage('已清除当前教材页码范围的本地向量索引。')
    }, '本地索引清除未完成，请重新读取后重试。')
  }

  return (
    <section
      className="card adapter-card wide web-research-settings embedding-settings"
      aria-label="Embedding 设置与检索"
    >
      <span className="eyebrow">OPTIONAL SEMANTIC RETRIEVAL</span>
      <h2>Embedding 设置与检索</h2>
      <p>
        Embedding
        可使用与聊天模型不同的服务商。保存设置和本地关键词检索不会上传教材或答卷；每次外发都需核对完整预览并确认。
      </p>
      <label className="web-research-check">
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy || !config}
          onChange={(event) => {
            setEnabled(event.target.checked)
            invalidate()
          }}
        />
        启用独立 Embedding 服务
      </label>
      <label className="web-research-field">
        Embedding API 地址
        <input
          value={baseUrl}
          disabled={busy || !config}
          maxLength={300}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setBaseUrl(event.target.value)
            invalidate()
          }}
        />
      </label>
      <label className="web-research-field">
        Embedding 模型 ID
        <input
          value={model}
          disabled={busy || !config}
          maxLength={200}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setModel(event.target.value)
            invalidate()
          }}
        />
      </label>
      <p className="web-research-muted">
        标准 OpenAI-compatible POST /embeddings。密钥状态：
        {config ? keyLabels[config.keyStatus] : '尚未读取'}；已有密钥不回填。
      </p>
      <label className="web-research-field">
        Embedding API Key
        <input
          type="password"
          value={apiKey}
          disabled={busy || !config || clearApiKey}
          maxLength={4096}
          autoComplete="off"
          spellCheck={false}
          placeholder="留空保留已有密钥"
          onChange={(event) => {
            setApiKey(event.target.value)
            invalidate()
          }}
        />
      </label>
      <label className="web-research-check">
        <input
          type="checkbox"
          checked={persistApiKey}
          disabled={busy || !config?.secureStorageAvailable || !apiKey.trim() || clearApiKey}
          onChange={(event) => setPersistApiKey(event.target.checked)}
        />
        使用系统加密保存这个新 Embedding Key，供下次应用启动使用
      </label>
      <p className="web-research-muted">
        新密钥默认仅在本次会话使用；不写入学习记录或浏览器存储。系统安全存储不可用时不会改用明文。
      </p>
      <label className="web-research-check">
        <input
          type="checkbox"
          checked={clearApiKey}
          disabled={busy || !config || config.keyStatus === 'missing'}
          onChange={(event) => {
            setClearApiKey(event.target.checked)
            setApiKey('')
            setPersistApiKey(false)
            invalidate()
          }}
        />
        清除已有 Embedding Key（保存后生效）
      </label>
      <div className="web-research-actions">
        <button
          type="button"
          className="primary"
          disabled={busy || !config}
          onClick={() => void save()}
        >
          保存 Embedding 设置
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={() => void load()}>
          重新读取 Embedding 设置
        </button>
      </div>
      {dirty && (
        <p className="web-research-warning">设置尚未保存。保存后再准备外发预览或连接诊断。</p>
      )}
      <section aria-label="Embedding 连接诊断">
        <h3>连接诊断</h3>
        <p className="web-research-muted">
          只发送固定诊断文本，不包含教材、查询或作答。请求可能产生 API 费用。
        </p>
        <p>
          接收接口：{embeddingEndpoint(config?.baseUrl ?? baseUrl)}；模型：{config?.model ?? model}
        </p>
        <pre aria-label="Embedding 固定诊断文本">{EMBEDDING_DIAGNOSTIC_TEXT}</pre>
        <label className="web-research-check">
          <input
            type="checkbox"
            checked={diagnosticConsent}
            disabled={busy || !configured}
            onChange={(event) => setDiagnosticConsent(event.target.checked)}
          />
          我同意发送固定诊断文本
        </label>
        <button
          type="button"
          className="secondary"
          disabled={busy || !configured || !diagnosticConsent}
          onClick={() => void diagnose()}
        >
          测试 Embedding 连接
        </button>
      </section>
      <section aria-label="本地教材检索与向量索引">
        <h3>限定教材与物理 PDF 页码</h3>
        <p className="web-research-muted">
          选择不超过 100 页的范围。先做本地关键词检索，再选最多 3
          个片段建立向量索引。语义检索只发送本次查询，在本地匹配所选范围的已有向量。
        </p>
        <label className="web-research-field">
          Embedding 检索学科
          <select
            value={subject}
            disabled={busy}
            onChange={(event) => {
              const next = event.target.value as Subject
              setSubject(next)
              setDocumentId(documents.find((item) => item.subject === next)?.id ?? '')
              setStartPage('1')
              setEndPage('1')
              scopeChanged()
            }}
          >
            {KNOWLEDGE_SUBJECTS.map((item) => (
              <option key={item} value={item}>
                {KNOWLEDGE_SUBJECT_LABELS[item]}
              </option>
            ))}
          </select>
        </label>
        <label className="web-research-field">
          Embedding 检索教材
          <select
            value={documentId}
            disabled={busy}
            onChange={(event) => {
              setDocumentId(event.target.value)
              setStartPage('1')
              setEndPage('1')
              scopeChanged()
            }}
          >
            <option value="">请选择已导入教材</option>
            {documents
              .filter((item) => item.subject === subject)
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
          </select>
        </label>
        {!documents.some((item) => item.subject === subject) && (
          <p>本学科暂无教材，请先在教材库导入。</p>
        )}
        <div className="embedding-pages">
          <label className="web-research-field">
            Embedding 起始物理页
            <input
              type="number"
              min="1"
              max={document?.pageCount ?? 1500}
              value={startPage}
              disabled={busy}
              onChange={(event) => {
                setStartPage(event.target.value)
                scopeChanged()
              }}
            />
          </label>
          <label className="web-research-field">
            Embedding 结束物理页
            <input
              type="number"
              min="1"
              max={document?.pageCount ?? 1500}
              value={endPage}
              disabled={busy}
              onChange={(event) => {
                setEndPage(event.target.value)
                scopeChanged()
              }}
            />
          </label>
        </div>
        {document && !rangeValid && (
          <p className="web-research-warning">
            请填写有效的物理 PDF 页码，连续范围不能超过 100 页。
          </p>
        )}
        <label className="web-research-field">
          Embedding 检索内容
          <input
            value={query}
            disabled={busy}
            maxLength={300}
            onChange={(event) => {
              setQuery(event.target.value)
              scopeChanged()
            }}
          />
        </label>
        <div className="web-research-actions">
          <button
            type="button"
            className="secondary"
            disabled={busy || !rangeValid || !query.trim()}
            onClick={() => void localSearch()}
          >
            本地检索（关键词回退）
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy || !rangeValid}
            onClick={() => void clearIndex()}
          >
            清除本范围向量索引
          </button>
        </div>
        {!!hits.length && (
          <ul className="embedding-hits" aria-label="Embedding 检索结果">
            {hits.map((hit) => (
              <li key={hit.chunkId}>
                <label className="web-research-check">
                  <input
                    type="checkbox"
                    aria-label={`选择片段 ${hit.chunkId}`}
                    checked={selected.includes(hit.chunkId)}
                    disabled={busy || (!selected.includes(hit.chunkId) && selected.length >= 3)}
                    onChange={(event) => {
                      invalidate()
                      setSelected((previous) =>
                        event.target.checked
                          ? [...previous, hit.chunkId]
                          : previous.filter((id) => id !== hit.chunkId),
                      )
                    }}
                  />
                  {hit.documentTitle} · 物理 PDF 第 {hit.pageNumber} 页
                </label>
                <pre>{hit.text}</pre>
              </li>
            ))}
          </ul>
        )}
        <p className="web-research-muted">
          已选 {selected.length} / 3 个片段。向量只是检索线索，不代表教材已核验或答案正确。
        </p>
        <div className="web-research-actions">
          <button
            type="button"
            className="secondary"
            disabled={busy || !configured || !rangeValid || !selected.length}
            onClick={() => void prepare('index')}
          >
            预览所选片段索引请求
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy || !configured || !rangeValid || !query.trim()}
            onClick={() => void prepare('search')}
          >
            预览语义检索请求
          </button>
        </div>
      </section>
      {preview && (
        <section className="embedding-preview" aria-label="Embedding 实际外发预览">
          <h3>本次实际外发预览</h3>
          <p>
            {preview.kind === 'index' ? '索引所选教材片段' : '仅发送本次检索查询'}；接收接口：
            {embeddingEndpoint(preview.baseUrl)}；模型：{preview.model}
          </p>
          <p>
            学科：{KNOWLEDGE_SUBJECT_LABELS[preview.subject]}；物理 PDF 第 {preview.startPage}–
            {preview.endPage} 页。预览到期时间：
            {new Date(preview.expiresAt).toLocaleTimeString('zh-CN')}
          </p>
          {preview.texts.map((item, index) => (
            <div key={item.sha256 + index}>
              <p>
                {item.pageNumber ? `物理 PDF 第 ${item.pageNumber} 页` : '本次查询'} · SHA-256：
                {item.sha256}
              </p>
              <pre>{item.text}</pre>
            </div>
          ))}
          <p className="web-research-warning">
            仅上述文本将发送给此 Embedding
            服务商。服务商可能保留请求，调用可能计费；离开页面不会撤回已经发出的请求。
          </p>
          <label className="web-research-check">
            <input
              type="checkbox"
              checked={consent}
              disabled={busy}
              onChange={(event) => setConsent(event.target.checked)}
            />
            我同意发送本次预览内容
          </label>
          <div className="web-research-actions">
            <button
              type="button"
              className="primary"
              disabled={busy || !consent}
              onClick={() => void confirm()}
            >
              确认发送本次 Embedding 请求
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={invalidate}>
              丢弃 Embedding 预览
            </button>
          </div>
        </section>
      )}
      {busy && <p role="status">正在处理本次 Embedding 操作…</p>}
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className="web-research-warning">
          {error}
        </p>
      )}
    </section>
  )
}
