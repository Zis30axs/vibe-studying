import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { AgentRunRequest, AgentRunState, AgentWorkbenchApi } from '../shared/agent-workbench'
import { AGENT_BUDGET } from '../shared/agent-workbench'
import type { AgentToolName, AgentToolProposal } from '../shared/agent-tool-context'
import type { AnswerDraft, ModelConfig, StudentQuestion, Subject } from '../shared/types'
import type { KnowledgeApi, KnowledgeDocument } from '../shared/knowledge'
import { KNOWLEDGE_MATH_EXTRACTION_WARNING } from '../shared/knowledge'
import type { ModelConsentApi } from '../shared/model-consent'
import {
  canonicalPublicResearchUrl,
  WEB_RESEARCH_ENDPOINT,
  WEB_RESEARCH_LIMITS,
  type WebResearchApi,
  type WebResearchConfig,
  type WebResearchSource,
} from '../shared/web-research'
import { subjects, subjectLabel } from '../shared/subjects'
import {
  AGENT_DEFAULT_TOOLS,
  AGENT_CHILD_TOOLS,
  AGENT_DELEGATE_TOOLS,
  AGENT_TOOL_LABELS,
  AgentUiSession,
  agentConsentScopes,
  availableAgentTools,
  sameAgentReceiver,
  publicWebScopePreview,
  type AgentAnswerApplication,
} from '../domain/agent-workbench-ui'
import { ModelConsentControl } from './ModelConsentControl'
import './agent-workbench.css'

export interface AgentWorkbenchProps {
  api: AgentWorkbenchApi &
    ModelConsentApi &
    WebResearchApi &
    Pick<KnowledgeApi, 'listKnowledgeDocuments'>
  parentConfig: ModelConfig | null
  childConfig: ModelConfig | null
  configRevision: number
  currentQuestion?: StudentQuestion
  currentAnswer: AnswerDraft
  onApplyAnswer: (input: AgentAnswerApplication) => boolean
  onAcceptedQuestion: (question: StudentQuestion) => void
  onOpenSettings?: () => void
}
const runLabels: Record<AgentRunState['status'], string> = {
  running: '进行中',
  complete: '已结束',
  failed: '已停止',
  cancelled: '已取消',
}
const eventLabels = { running: '进行中', complete: '完成', failed: '失败', cancelled: '已取消' }
const seconds = (value: number) => `${Math.max(0, Math.floor(value / 1000))} 秒`

export function AgentWebSources({ sources }: { sources: WebResearchSource[] }) {
  return (
    <section className="agent-web-sources" aria-label="本次公开来源">
      <h4>本次公开来源</h4>
      <p className="agent-muted">
        以下网页和摘录均为不可信外部内容，未核验为官方真题。来源中的年份仅是文字证据，不代表考试年份已核验。
      </p>
      <ol>
        {sources.map((source) => {
          let href = ''
          try {
            href = canonicalPublicResearchUrl(source.url)
          } catch {
            /* No unsafe links. */
          }
          return (
            <li key={source.sourceId}>
              <strong>{source.title || '未提供标题'}</strong>
              <small>
                {source.sourceId} · {source.retrieved ? '已取得摘录' : '已批准网址，尚未读取'} ·
                未核验
              </small>
              {href ? (
                <label className="agent-source-url">
                  来源网址（可复制）
                  <textarea
                    readOnly
                    value={href}
                    rows={2}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                </label>
              ) : (
                <span>来源地址无效，链接已隐藏。</span>
              )}
              {source.excerpt && <p className="agent-plain-text">{source.excerpt}</p>}
              {source.yearEvidence.length > 0 ? (
                <ul className="agent-year-evidence">
                  {source.yearEvidence.map((item, index) => (
                    <li key={`${item.year}-${index}`}>
                      来源提及 {item.year}：{item.evidence}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="agent-muted">未找到可展示的年份证据。</p>
              )}
              {source.retrievedAt && <small>获取时间：{source.retrievedAt}</small>}
            </li>
          )
        })}
      </ol>
    </section>
  )
}

export function AgentProposalContent({ proposal }: { proposal: AgentToolProposal }) {
  if (proposal.kind === 'answer-edit')
    return (
      <div className="agent-proposal-content">
        <p>{proposal.reason}</p>
        <div className="agent-answer-diff">
          <section aria-label="修改前完整正文">
            <h4>修改前完整正文</h4>
            <pre>{proposal.expectedText || '（空白正文）'}</pre>
          </section>
          <section aria-label="修改后完整正文">
            <h4>修改后完整正文</h4>
            <pre>{proposal.replacement || '（空白正文）'}</pre>
          </section>
        </div>
        <p className="agent-muted">
          仅替换当前答卷正文；模块、绘图和数学参数不变。提交审阅仍需你另行操作。
        </p>
      </div>
    )
  const q = proposal.question
  const originLabel =
    q.researchOrigin === 'adapted'
      ? 'AI 改编练习'
      : q.researchOrigin === 'unverified-source'
        ? '来源未核验的 AI 练习'
        : 'AI 原创练习'
  return (
    <div className="agent-proposal-content">
      <p className="agent-warning">
        {originLabel}，尚未核验为官方真题。请检查题干、参考答案、评分依据、来源及图形数据后再保存。
      </p>
      <h4>{q.title}</h4>
      <p className="agent-plain-text">{q.prompt}</p>
      <p>
        {subjectLabel[q.subject]} · {q.maxScore} 分 · {q.source}
      </p>
      <details open>
        <summary>新题待确认预览（含新生成参考答案）</summary>
        <pre aria-label="完整题目预览">{JSON.stringify(q, null, 2)}</pre>
      </details>
    </div>
  )
}

export function AgentWorkbench({
  api,
  parentConfig,
  childConfig,
  configRevision,
  currentQuestion,
  currentAnswer,
  onApplyAnswer,
  onAcceptedQuestion,
  onOpenSettings,
}: AgentWorkbenchProps) {
  const session = useMemo(() => new AgentUiSession(api), [api])
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
  const [task, setTask] = useState('')
  const [subject, setSubject] = useState<Subject>(currentQuestion?.subject ?? 'math')
  const [mode, setMode] = useState<AgentRunRequest['mode']>('learner')
  const [includeAnswer, setIncludeAnswer] = useState(false)
  const [includeReference, setIncludeReference] = useState(false)
  const [allowDelegation, setAllowDelegation] = useState(false)
  const [selectedTools, setSelectedTools] = useState<AgentToolName[]>([...AGENT_DEFAULT_TOOLS])
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([])
  const [documentId, setDocumentId] = useState('')
  const [startPage, setStartPage] = useState('1')
  const [endPage, setEndPage] = useState('1')
  const [documentError, setDocumentError] = useState('')
  const [documentsLoading, setDocumentsLoading] = useState(false)
  const [parentConsent, setParentConsent] = useState(false)
  const [childConsent, setChildConsent] = useState(false)
  const [webEnabled, setWebEnabled] = useState(false)
  const [webTopic, setWebTopic] = useState('')
  const [webRegion, setWebRegion] = useState('')
  const [webYears, setWebYears] = useState('')
  const [webApprovedUrls, setWebApprovedUrls] = useState('')
  const [webConsent, setWebConsent] = useState(false)
  const [webConfig, setWebConfig] = useState<WebResearchConfig | null>(null)
  const [webConfigLoading, setWebConfigLoading] = useState(false)
  const [webConfigError, setWebConfigError] = useState('')
  const mounted = useRef(false)
  const documentLoad = useRef(0)
  const webConfigLoad = useRef(0)
  const live = useRef({
    questionId: currentQuestion?.id,
    draft: currentAnswer,
    onApplyAnswer,
    onAcceptedQuestion,
  })
  live.current = {
    questionId: currentQuestion?.id,
    draft: currentAnswer,
    onApplyAnswer,
    onAcceptedQuestion,
  }
  const scopedQuestion = currentQuestion?.subject === subject ? currentQuestion : undefined
  const scopedAnswer = includeAnswer && !!scopedQuestion
  const reference = mode !== 'learner' && includeReference
  const selectedDocument = documents.find(
    (item) => item.id === documentId && item.subject === subject,
  )
  const from = Number(startPage),
    to = Number(endPage)
  const validPages =
    !!selectedDocument &&
    Number.isInteger(from) &&
    Number.isInteger(to) &&
    from >= 1 &&
    to >= from &&
    to <= selectedDocument.pageCount &&
    to - from < 100
  const knowledge = validPages
    ? { documentId: selectedDocument!.id, startPage: from, endPage: to }
    : undefined
  const available = availableAgentTools({
    subject,
    mode,
    hasQuestion: !!scopedQuestion,
    includeAnswer: scopedAnswer,
    hasModules: !!currentAnswer.argument?.roots.length,
    includeReference: reference,
    hasKnowledge: !!knowledge,
    allowDelegation,
    hasWeb: webEnabled,
  })
  const tools = available.filter((name) => selectedTools.includes(name))
  const delegated = tools.some((name) => AGENT_DELEGATE_TOOLS.includes(name))
  const needsChild = tools.some((name) => AGENT_CHILD_TOOLS.includes(name))
  const sameReceiver = sameAgentReceiver(parentConfig, childConfig)
  const scopes = agentConsentScopes({
    includeAnswer: scopedAnswer,
    includeReference: reference,
    hasKnowledge: !!knowledge,
    hasWeb: webEnabled,
  })
  const webPreview = publicWebScopePreview({
    subject,
    topic: webTopic,
    region: webRegion,
    years: webYears,
    approvedUrls: webApprovedUrls,
  })
  const webScope = 'scope' in webPreview ? webPreview.scope : undefined
  const webReady =
    !webEnabled || (!!webScope && !!webConfig?.configured && webConsent && !webConfigLoading)
  const webReceiver: ModelConfig = {
    protocol: 'openai-chat',
    baseUrl: WEB_RESEARCH_ENDPOINT,
    model: 'Tavily basic search',
    revision: webConfig?.revision ?? 0,
    configured: !!webConfig?.configured,
  }
  const running = snapshot.starting || snapshot.run?.status === 'running'
  const receiving = !!snapshot.pendingProposal
  const sendingAllowed =
    !!parentConfig?.configured &&
    parentConsent &&
    (!needsChild || (!!childConfig?.configured && (sameReceiver ? parentConsent : childConsent))) &&
    webReady
  const reviewReady = mode !== 'review' || (scopedAnswer && reference)
  const scopeKey = JSON.stringify({
    task,
    subject,
    mode,
    question: scopedQuestion,
    draft: currentAnswer,
    includeAnswer: scopedAnswer,
    reference,
    documentId,
    startPage,
    endPage,
    tools,
    configRevision,
    parentConfig,
    childConfig,
    webEnabled,
    webTopic,
    webRegion,
    webYears,
    webApprovedUrls,
    webConfigRevision: webConfig?.revision,
  })
  const lastScope = useRef(scopeKey)

  async function loadDocuments() {
    const version = ++documentLoad.current
    setDocumentsLoading(true)
    setDocumentError('')
    try {
      const value = await api.listKnowledgeDocuments()
      if (mounted.current && version === documentLoad.current) setDocuments(value)
    } catch {
      if (mounted.current && version === documentLoad.current)
        setDocumentError('无法读取本地教材列表。可不选教材继续，或点击重新读取。')
    } finally {
      if (mounted.current && version === documentLoad.current) setDocumentsLoading(false)
    }
  }
  async function loadWebConfig() {
    const version = ++webConfigLoad.current
    setWebConfigLoading(true)
    setWebConfigError('')
    try {
      const value = await api.getWebResearchConfig()
      if (mounted.current && version === webConfigLoad.current) setWebConfig(value)
    } catch {
      if (mounted.current && version === webConfigLoad.current) {
        setWebConfig(null)
        setWebConfigError('无法读取本地联网设置。请重新读取或打开设置检查 Tavily Key。')
      }
    } finally {
      if (mounted.current && version === webConfigLoad.current) setWebConfigLoading(false)
    }
  }
  useEffect(() => {
    mounted.current = true
    void loadDocuments()
    void loadWebConfig()
    const hidden = () => {
      if (document.hidden)
        session.invalidate('窗口已隐藏，任务已请求停止。已发模型请求仍可能计费。')
    }
    document.addEventListener('visibilitychange', hidden)
    return () => {
      mounted.current = false
      ++documentLoad.current
      ++webConfigLoad.current
      document.removeEventListener('visibilitychange', hidden)
      session.invalidate('已离开 Agent 工作台，任务与待确认预览已停止。已发请求仍可能计费。')
    }
  }, [session])
  useEffect(() => {
    if (lastScope.current === scopeKey) return
    lastScope.current = scopeKey
    session.invalidate()
    setParentConsent(false)
    setChildConsent(false)
    setWebConsent(false)
  }, [scopeKey, session])
  useEffect(() => {
    if (
      running &&
      (!parentConsent ||
        (needsChild && !sameReceiver && !childConsent) ||
        (webEnabled && !webConsent))
    )
      session.invalidate('发送同意已撤销，任务已请求停止。已发请求仍可能计费。')
  }, [
    parentConsent,
    childConsent,
    needsChild,
    sameReceiver,
    webEnabled,
    webConsent,
    running,
    session,
  ])
  useEffect(() => {
    if (snapshot.run?.status !== 'running') return
    const timer = window.setInterval(() => {
      if (!document.hidden) void session.poll()
    }, 400)
    return () => window.clearInterval(timer)
  }, [snapshot.run?.runId, snapshot.run?.status, session])

  function change(action: () => void) {
    session.invalidate()
    setParentConsent(false)
    setChildConsent(false)
    setWebConsent(false)
    action()
  }
  function start() {
    if (
      running ||
      receiving ||
      !sendingAllowed ||
      !reviewReady ||
      !task.trim() ||
      task.length > 4000 ||
      !tools.length ||
      (documentId && !validPages) ||
      document.hidden ||
      lastScope.current !== scopeKey
    )
      return
    void session.start({
      runId: crypto.randomUUID(),
      task: task.trim(),
      subject,
      mode,
      questionIds: scopedQuestion ? [scopedQuestion.id] : [],
      ...(scopedQuestion
        ? { currentQuestionId: scopedQuestion.id, localDraft: structuredClone(currentAnswer) }
        : {}),
      ...(scopedAnswer ? { answer: structuredClone(currentAnswer) } : {}),
      includeReference: reference,
      ...(knowledge ? { knowledge } : {}),
      ...(webEnabled && webScope && webConfig
        ? {
            web: {
              provider: 'tavily' as const,
              scope: webScope,
              configRevision: webConfig.revision,
              consent: webConsent,
            },
          }
        : {}),
      allowedTools: tools,
      configRevision,
      parentConsent,
      childConsent: needsChild ? (sameReceiver ? parentConsent : childConsent) : false,
    })
  }
  return (
    <section className="agent-workbench" aria-labelledby="agent-workbench-title">
      <header className="agent-header">
        <div>
          <span className="eyebrow">NATIVE TOOL CALLING</span>
          <h2 id="agent-workbench-title">有界 Agent 工作台</h2>
          <p>
            模型可调用你启用的有界工具并读取结果。公开联网需单独开启；写入先预览，由你决定是否应用。
          </p>
        </div>
        <span className="agent-local-badge">显式发送 · 有界工具</span>
      </header>
      <div className="agent-layout">
        <section className="agent-scope" aria-label="任务与发送范围">
          <h3>1. 确认本次任务与范围</h3>
          <label className="agent-field">
            本次任务
            <textarea
              value={task}
              maxLength={4000}
              rows={4}
              disabled={receiving}
              placeholder="例如：用数值工具检查这道题中的关系，并解释计算结果。"
              onChange={(event) => change(() => setTask(event.target.value))}
            />
          </label>
          <p className="agent-muted">
            {task.length} / 4000 字。任务文字会发送给主模型，请勿填写密钥或无关个人资料。
          </p>
          <div className="agent-field-row">
            <label className="agent-field">
              学科
              <select
                value={subject}
                disabled={receiving}
                onChange={(event) =>
                  change(() => {
                    setSubject(event.target.value as Subject)
                    setDocumentId('')
                    setIncludeAnswer(false)
                  })
                }
              >
                {subjects.map((id) => (
                  <option key={id} value={id}>
                    {subjectLabel[id]}
                  </option>
                ))}
              </select>
            </label>
            <label className="agent-field">
              工作模式
              <select
                value={mode}
                disabled={receiving}
                onChange={(event) =>
                  change(() => {
                    setMode(event.target.value as AgentRunRequest['mode'])
                    setIncludeReference(false)
                  })
                }
              >
                <option value="learner">学习提示</option>
                <option value="review">明确审阅</option>
                <option value="create">创作题目</option>
              </select>
            </label>
          </div>
          <div className="agent-scope-summary">
            <strong>题目范围：仅当前题目</strong>
            <p>
              {scopedQuestion
                ? `${scopedQuestion.title}（${subjectLabel[scopedQuestion.subject]}）`
                : '当前没有同学科题目；不发送其他题目。可返回练习页选题。'}
            </p>
            <p className="agent-muted">
              不会读取其他题目、历史答卷或整个题库。当前答卷的本地基线仅用于检查建议是否过期；未勾选下项时不发送作答内容。
            </p>
          </div>
          <label className="agent-check">
            <input
              type="checkbox"
              checked={scopedAnswer}
              disabled={!scopedQuestion || receiving}
              onChange={(event) => change(() => setIncludeAnswer(event.target.checked))}
            />
            附带当前答卷快照（正文、模块、绘图、数学参数）
          </label>
          {mode !== 'learner' && (
            <label className="agent-check">
              <input
                type="checkbox"
                checked={reference}
                disabled={receiving}
                onChange={(event) => change(() => setIncludeReference(event.target.checked))}
              />
              允许本次参考访问（解析、评分依据及评阅结果）
            </label>
          )}
          {mode === 'learner' && <p className="agent-muted">学习提示模式不开放参考答案。</p>}
          {!reviewReady && (
            <p className="agent-warning">明确审阅需要同时选中当前答卷和参考访问。</p>
          )}
          <details className="agent-knowledge">
            <summary>可选：限定本地教材与物理页码</summary>
            <p className="agent-muted">
              这里只读取本地元数据。点击开始并同意发送后，模型才可检索你选定范围内的内容；最多 100
              页。
            </p>
            <label className="agent-field">
              教材
              <select
                value={documentId}
                disabled={receiving || documentsLoading}
                onChange={(event) =>
                  change(() => {
                    setDocumentId(event.target.value)
                    setStartPage('1')
                    setEndPage('1')
                  })
                }
              >
                <option value="">不使用教材</option>
                {documents
                  .filter((item) => item.subject === subject)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title} · {item.pageCount} 页
                    </option>
                  ))}
              </select>
            </label>
            {documentId && (
              <div className="agent-field-row">
                <label className="agent-field">
                  物理 PDF 起始页
                  <input
                    type="number"
                    min={1}
                    max={selectedDocument?.pageCount ?? 1500}
                    value={startPage}
                    disabled={receiving}
                    onChange={(event) => change(() => setStartPage(event.target.value))}
                  />
                </label>
                <label className="agent-field">
                  物理 PDF 结束页
                  <input
                    type="number"
                    min={1}
                    max={selectedDocument?.pageCount ?? 1500}
                    value={endPage}
                    disabled={receiving}
                    onChange={(event) => change(() => setEndPage(event.target.value))}
                  />
                </label>
              </div>
            )}
            {documentId && !validPages && (
              <p className="agent-warning">请选择有效的物理 PDF 页码，连续范围不能超过 100 页。</p>
            )}
            {subject === 'math' && documentId && (
              <p className="agent-warning">{KNOWLEDGE_MATH_EXTRACTION_WARNING}</p>
            )}
            {documentError && <p role="alert">{documentError}</p>}
            <button
              type="button"
              className="secondary"
              disabled={documentsLoading || receiving}
              onClick={() => void loadDocuments()}
            >
              {documentsLoading ? '正在读取元数据…' : '重新读取本地教材列表'}
            </button>
          </details>
          <section className="agent-web-scope" aria-label="公开联网范围">
            <label className="agent-check">
              <input
                type="checkbox"
                checked={webEnabled}
                disabled={receiving}
                onChange={(event) =>
                  change(() => {
                    setWebEnabled(event.target.checked)
                    if (event.target.checked)
                      setSelectedTools((previous) => [
                        ...new Set<AgentToolName>([...previous, 'web_search', 'web_fetch']),
                      ])
                  })
                }
              />
              本次任务允许联网（Tavily Search + Fetch）
            </label>
            <p className="agent-muted">
              默认关闭。记住接收方同意不会替你开启联网；主模型和实际调用的子角色共用本次公开范围与网络预算。
            </p>
            {webEnabled && (
              <>
                <p className="agent-warning">
                  下列内容会用于公开检索。只填可公开的章节、地区和年份，不要填写姓名、学号、答案、教材正文或密钥。这些字段不会从任务或作答自动填入。
                </p>
                <p className="agent-muted">公开学科：{subjectLabel[subject]}（使用上方当前学科）</p>
                <label className="agent-field">
                  公开章节 / 主题
                  <input
                    value={webTopic}
                    maxLength={80}
                    disabled={receiving}
                    placeholder="例如：函数与导数"
                    onChange={(event) => change(() => setWebTopic(event.target.value))}
                  />
                </label>
                <div className="agent-field-row">
                  <label className="agent-field">
                    公开地区 / 试卷范围
                    <input
                      value={webRegion}
                      maxLength={40}
                      disabled={receiving}
                      placeholder="例如：全国卷"
                      onChange={(event) => change(() => setWebRegion(event.target.value))}
                    />
                  </label>
                  <label className="agent-field">
                    公开年份（最多 5 个）
                    <input
                      value={webYears}
                      maxLength={40}
                      disabled={receiving}
                      placeholder="例如：2023, 2024"
                      onChange={(event) => change(() => setWebYears(event.target.value))}
                    />
                  </label>
                </div>
                <label className="agent-field">
                  已批准的公开 HTTPS 网址（可选，最多 3 个）
                  <textarea
                    value={webApprovedUrls}
                    maxLength={6150}
                    rows={3}
                    disabled={receiving}
                    placeholder="每行一个公开网页网址，不含登录信息或密钥"
                    onChange={(event) => change(() => setWebApprovedUrls(event.target.value))}
                  />
                </label>
                {webPreview.error ? (
                  <p className="agent-warning">{webPreview.error}</p>
                ) : (
                  'queries' in webPreview && (
                    <div className="agent-query-preview" aria-label="实际外发查询预览">
                      <strong>实际外发查询预览</strong>
                      <p className="agent-muted">
                        模型只能选择全部年份或其中一个已确认年份。每次搜索只能发送以下一条固定查询，不能自行改写或追加任务文字。
                      </p>
                      <ul>
                        {webPreview.queries.map((query) => (
                          <li key={query}>
                            <pre>{query}</pre>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )
                )}
                <p className="agent-muted">
                  Fetch 只接收本次来源 ID，对应本次搜索结果或上方已批准网址。仅公开
                  HTTPS，禁止跳转；不发送模型密钥，不读取其他网站、文件或登录页面。
                </p>
                <p className="agent-muted">
                  每次 Tavily basic 搜索约 1 credit；全任务最多 {WEB_RESEARCH_LIMITS.searches}{' '}
                  次搜索和 {WEB_RESEARCH_LIMITS.fetches} 次
                  Fetch，主/子角色共享。取消后已发请求仍可能计费，失败不会自动重试。
                </p>
                {webConfigLoading && <p role="status">正在读取本地联网配置…</p>}
                {!webConfigLoading && !webConfig?.configured && (
                  <p className="agent-warning">
                    请先在设置中配置独立的 Tavily Key。已有模型 API Key 不用于搜索。
                  </p>
                )}
                {webConfigError && <p role="alert">{webConfigError}</p>}
                <div className="agent-actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={webConfigLoading || receiving}
                    onClick={() => void loadWebConfig()}
                  >
                    重新读取联网设置
                  </button>
                  {onOpenSettings && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={receiving}
                      onClick={onOpenSettings}
                    >
                      打开联网设置
                    </button>
                  )}
                </div>
              </>
            )}
          </section>
          <h3>2. 启用本次工具能力</h3>
          <label className="agent-check">
            <input
              type="checkbox"
              checked={allowDelegation}
              disabled={receiving}
              onChange={(event) => change(() => setAllowDelegation(event.target.checked))}
            />
            允许有界模型委派（另需选择工具，可能额外计费）
          </label>
          <div className="agent-tools">
            {available.map((name) => (
              <label key={name} className="agent-tool">
                <input
                  type="checkbox"
                  checked={selectedTools.includes(name)}
                  disabled={receiving}
                  onChange={(event) =>
                    change(() =>
                      setSelectedTools((previous) =>
                        event.target.checked
                          ? [...previous, name]
                          : previous.filter((item) => item !== name),
                      ),
                    )
                  }
                />
                <span>
                  <strong>{AGENT_TOOL_LABELS[name].label}</strong>
                  <small>{AGENT_TOOL_LABELS[name].description}</small>
                </span>
              </label>
            ))}
          </div>
          {!tools.length && <p className="agent-warning">请启用至少一个当前范围可用的工具。</p>}
          <p className="agent-muted">
            仅上述工具可调用，没有任意查询、任意网址抓取、文件、终端或任意代码执行工具。
          </p>
        </section>
        <section className="agent-execution" aria-label="发送确认与运行结果">
          <h3>3. 确认接收方并运行</h3>
          <p>
            主模型：{parentConfig?.model || '未配置'}
            {needsChild ? `；子角色：${childConfig?.model || '未配置'}` : ''}
          </p>
          {(!parentConfig?.configured || (needsChild && !childConfig?.configured)) && (
            <div className="agent-warning">
              <p>请先为需要的模型角色配置可用密钥。配置不等于已验证网络。</p>
              {onOpenSettings && (
                <button type="button" className="secondary" onClick={onOpenSettings}>
                  打开模型设置
                </button>
              )}
            </div>
          )}
          <ModelConsentControl
            api={api}
            config={parentConfig}
            scopes={scopes}
            checked={parentConsent}
            onChange={setParentConsent}
            disabled={receiving}
            label={
              needsChild && sameReceiver
                ? '我同意向此接收方发送本次主模型与委派任务及所选数据'
                : '我同意向主模型发送本次任务、所选数据与工具结果'
            }
          />
          {needsChild && !sameReceiver && (
            <ModelConsentControl
              api={api}
              config={childConfig}
              scopes={scopes}
              checked={childConsent}
              onChange={setChildConsent}
              disabled={receiving}
              label="我同意向子模型接收方发送本次委派任务及所选数据"
            />
          )}
          {webEnabled && (
            <ModelConsentControl
              api={api}
              config={webReceiver}
              scopes={['web_public']}
              checked={webConsent}
              onChange={setWebConsent}
              disabled={receiving || !webScope || !webConfig?.configured}
              label="我同意向 Tavily 发送预览中的公开查询，并访问本次已批准的公开来源"
            />
          )}
          {delegated && (
            <p className="agent-muted">
              评阅与地理出题使用父角色；选区顾问与模块检查使用子角色。所选参考和教材工具结果也会回传主模型。
              委派模型请求合计最多 2 次，包含子模型读取公开来源后的工具续接。
              {needsChild
                ? sameReceiver
                  ? '两个角色使用相同接收方，本次共用一次范围确认。'
                  : '两个接收方都需确认本次数据范围。'
                : '本次启用的委派仅使用父角色接收方。'}
            </p>
          )}
          <div className="agent-budget" aria-label="运行预算">
            <span>
              主模型 {snapshot.run?.modelRequests ?? 0} / {AGENT_BUDGET.modelRequests}
            </span>
            <span>
              工具 {snapshot.run?.toolCalls ?? 0} / {AGENT_BUDGET.toolCalls}
            </span>
            <span>
              委派模型请求 {snapshot.run?.delegatedCalls ?? 0} / {AGENT_BUDGET.delegatedCalls}
              （含子模型工具续接）
            </span>
            <span>
              本次应用会话 {snapshot.run?.sessionRequests ?? '—'} / {AGENT_BUDGET.sessionRequests}{' '}
              次模型请求
            </span>
            <span>总时限 {seconds(AGENT_BUDGET.timeoutMs)}</span>
            {(webEnabled || snapshot.run?.web) && (
              <>
                <span>
                  公开搜索 {snapshot.run?.web?.budget.searchesUsed ?? 0} /{' '}
                  {WEB_RESEARCH_LIMITS.searches}
                </span>
                <span>
                  Fetch {snapshot.run?.web?.budget.fetchesUsed ?? 0} / {WEB_RESEARCH_LIMITS.fetches}
                </span>
                <span>
                  搜索估算 {snapshot.run?.web?.budget.estimatedSearchCredits ?? 0} credits（非账单）
                </span>
              </>
            )}
          </div>
          <p className="agent-warning">
            调用可能产生 API
            费用。取消、隐藏窗口或离开页面会停止后续执行，已发请求仍可能计费。失败不会自动重试。
          </p>
          <div className="agent-actions">
            <button
              type="button"
              className="primary"
              disabled={
                running ||
                receiving ||
                !sendingAllowed ||
                !reviewReady ||
                !task.trim() ||
                task.length > 4000 ||
                !tools.length ||
                !!(documentId && !validPages)
              }
              onClick={start}
            >
              {running ? '任务进行中…' : '开始本次 Agent 任务'}
            </button>
            {running && (
              <button
                type="button"
                className="secondary"
                onClick={() => session.invalidate('已取消。已发模型请求仍可能计费；未自动重试。')}
              >
                取消任务
              </button>
            )}
          </div>
          {snapshot.notice && (
            <p role="status" className="agent-notice">
              {snapshot.notice}
            </p>
          )}
          {snapshot.run && (
            <section className="agent-run" aria-label="本次运行状态">
              <h3>
                {runLabels[snapshot.run.status]} · {seconds(snapshot.run.elapsedMs)}
              </h3>
              <p role="status">{snapshot.run.message || '正在执行本次有界任务…'}</p>
              <ol className="agent-events">
                {snapshot.run.events.map((event) => (
                  <li key={event.sequence}>
                    <span>
                      {event.kind === 'tool' && event.tool
                        ? AGENT_TOOL_LABELS[event.tool].label
                        : event.kind === 'delegate'
                          ? `模型委派（${event.role === 'child' ? '子' : '父'}角色）`
                          : event.kind === 'finish'
                            ? '结束处理'
                            : '主模型请求'}
                      {event.kind === 'tool' && event.tool && (
                        <small className="agent-tool-name">{event.tool}</small>
                      )}
                    </span>
                    <span>
                      {eventLabels[event.status]} · {seconds(event.elapsedMs)}
                    </span>
                  </li>
                ))}
              </ol>
              {snapshot.run.text && (
                <div className="agent-output">
                  <h4>模型结果</h4>
                  <p className="agent-plain-text">{snapshot.run.text}</p>
                  <p className="agent-muted">
                    模型建议仅供学习，数值采样不构成证明，教学模拟不代表真实测绘。
                  </p>
                </div>
              )}
              {!!snapshot.run.web?.sources.length && (
                <AgentWebSources sources={snapshot.run.web.sources} />
              )}
            </section>
          )}
          {snapshot.run?.proposals.map(({ proposalId, proposal }) => (
            <section
              key={proposalId}
              className="agent-proposal"
              aria-label={proposal.kind === 'answer-edit' ? '待确认正文修改' : '待确认新题目'}
            >
              <h3>{proposal.kind === 'answer-edit' ? '待确认：正文替换' : '待确认：保存新题目'}</h3>
              <AgentProposalContent proposal={proposal} />
              <div className="agent-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={receiving || snapshot.run?.status !== 'complete'}
                  onClick={() =>
                    void session.accept(
                      proposalId,
                      () => live.current,
                      (input) => live.current.onApplyAnswer(input),
                      (question) => live.current.onAcceptedQuestion(question),
                    )
                  }
                >
                  {snapshot.pendingProposal === proposalId
                    ? '正在处理…'
                    : proposal.kind === 'answer-edit'
                      ? '确认应用正文修改'
                      : '确认保存到本地题库'}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={receiving}
                  onClick={() => void session.discard(proposalId)}
                >
                  丢弃预览
                </button>
              </div>
            </section>
          ))}
          {!snapshot.run && !running && (
            <p className="agent-empty">
              确认范围、能力和发送同意后开始。运行记录会显示真实调用阶段与计数。
            </p>
          )}
        </section>
      </div>
    </section>
  )
}
