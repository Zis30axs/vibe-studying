import { GeometryFigure } from './components/GeometryFigure'
import { LearningGraph } from './components/LearningGraph'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { version as appVersion } from '../package.json'
import type {
  AnswerDraft,
  ArgumentNode,
  Attempt,
  Capabilities,
  StudentQuestion,
  StudyState,
  ModelProfilesState,
  Subject,
} from './shared/types'
import { emptyDraft, emptyMathState } from './shared/types'
import { subjects, subjectLabel, kindLabel, subjectGuidance } from './shared/subjects'
import { HumanitiesComposer } from './components/HumanitiesComposer'
import { ActivityHeatmap } from './components/ActivityHeatmap'
import { SubmissionTimeline } from './components/SubmissionTimeline'
import { generateArgumentText } from './domain/argument'
import { GeographyWorkbench } from './components/GeographyWorkbench'
import { MathWorkbench } from './components/MathWorkbench'
import { WorkbenchDock } from './components/WorkbenchDock'
import { PanelDivider } from './components/PanelDivider'
import { useAppearance } from './components/useAppearance'
import { AppearanceSettings, WallpaperLayer } from './components/AppearanceSettings'
import { useWorkspaceLayout } from './components/useWorkspaceLayout'
import { PANEL_LIMITS } from './domain/workspace-layout'
import { ModelConsentControl, ModelConsentSettings } from './components/ModelConsentControl'
import { ModelRequestStatus } from './components/ModelRequestStatus'
import { ModelDebugPanel } from './components/ModelDebugPanel'
import { ModelSettings } from './components/ModelSettings'
import { WebResearchSettings } from './components/WebResearchSettings'
import { SelectionAdvisor } from './components/SelectionAdvisor'
import { GitHubProfile } from './components/GitHubProfile'
import { KnowledgeLibrary } from './components/KnowledgeLibrary'
import { FormulaReference } from './components/FormulaReference'
import {
  ReviewKnowledgePanel,
  supportsReviewKnowledge,
  type ReviewKnowledgePanelApi,
} from './components/ReviewKnowledgePanel'
import { AgentWorkbench } from './components/AgentWorkbench'
import { acceptedAgentDraft } from './domain/agent-workbench-ui'
import {
  filterStudyQuestions,
  isStudyView as isStudyRoute,
  navigateStudyQuestionContext,
  type StudyQuestionContext,
} from './domain/study-question-context'
import type { KnowledgeEvidence } from './shared/knowledge'
import type { AdvisorCitation } from './shared/types'
import { GeographyGenerator } from './components/GeographyGenerator'
import { GeographyFigure } from './components/GeographyFigure'
import { TerrainFigure, TerrainReviewProfile } from './components/TerrainFigure'

type View =
  'practice' | 'math' | 'politics' | 'geography' | 'formulas' | 'agent' | 'history' | 'adapters'
const navigation: { id: View; icon: string; label: string; caption: string }[] = [
  { id: 'practice', icon: '▤', label: '题目练习', caption: 'Practice' },
  { id: 'math', icon: 'ƒ', label: '数学工作台', caption: 'Math lab' },
  { id: 'politics', icon: '▦', label: '文科组装', caption: 'Argument builder' },
  { id: 'geography', icon: '◎', label: '地理工作台', caption: 'Geo canvas' },
  { id: 'formulas', icon: '∑', label: '公式速查', caption: 'Formula reference' },
  { id: 'agent', icon: '✧', label: 'Agent 工作台', caption: 'Bounded tools' },
  { id: 'history', icon: '◷', label: '练习记录', caption: 'Review & reflect' },
  { id: 'adapters', icon: '⌘', label: '题库与 Agent', caption: 'Connections' },
]
const blankState: StudyState = { version: 1, drafts: {}, attempts: [] }
const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
    : '操作失败，请重试。'
const dateText = (date: string) =>
  new Date(date).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })

const argumentNames: Record<ArgumentNode['kind'], string> = {
  principle: '观点 / 原理',
  material: '材料 / 依据',
  analysis: '分析',
  conclusion: '结论',
  cause: '因果',
  contrast: '对比',
  point: '分点',
}
function ArgumentSnapshot({ nodes }: { nodes: ArgumentNode[] }) {
  return (
    <ol className="argument-snapshot">
      {nodes.map((node) => (
        <li key={node.id}>
          <strong>{argumentNames[node.kind]}</strong>
          {node.text && <p>{node.text}</p>}
          {node.children.length > 0 && <ArgumentSnapshot nodes={node.children} />}
        </li>
      ))}
    </ol>
  )
}

export function Review({
  attempt,
  api,
}: {
  attempt: Attempt
  question?: StudentQuestion
  api?: Partial<ReviewKnowledgePanelApi> | null
}) {
  // A history node is a frozen submission. The live bank is never substituted for its snapshot.
  const question =
    attempt.questionSnapshot?.id === attempt.questionId ? attempt.questionSnapshot : undefined
  return (
    <section className="review-panel" aria-label="审阅结果">
      <div className="review-heading">
        <div>
          <span className="eyebrow">FEEDBACK</span>
          <h2>让每次作答都有收获</h2>
        </div>
        <div className="score">
          <strong>{Number.isFinite(attempt.score) ? attempt.score : '分数不可用'}</strong>
          <span>
            {Number.isFinite(attempt.maxScore) ? ` / ${attempt.maxScore}` : ' / 满分不可用'}
          </span>
        </div>
      </div>
      {question ? (
        <details className="review-question-figure">
          <summary>
            {question.figure || question.terrain || question.geometry
              ? '本次题目与示意图快照'
              : '本次题目快照'}
          </summary>
          <h3>{question.title}</h3>
          <p>{question.prompt}</p>
          {question.choices?.map((choice) => (
            <p key={choice.id}>
              {choice.id}. {choice.text}
            </p>
          ))}
          {question.geometry && <GeometryFigure scene={question.geometry} />}
          {question.figure && <GeographyFigure figure={question.figure} />}
          {question.terrain && (
            <>
              <TerrainFigure exercise={question.terrain} />
              <TerrainReviewProfile exercise={question.terrain} />
            </>
          )}
        </details>
      ) : (
        <p className="notice history-missing-snapshot">
          这条历史记录未保存题目快照，原题文案、选项与学科信息不可用。以下仅显示当次已保存的答案与审阅结果。
        </p>
      )}
      <p className="review-feedback">{attempt.feedback || '本次反馈不可用'}</p>
      <div className="notice">
        {attempt.reviewer || '审阅来源不可用'} ·{' '}
        {!(attempt.reviewer ?? '').toLowerCase().includes('local') &&
        !(attempt.reviewer ?? '').includes('本地')
          ? 'AI 练习反馈可能有误，不代表官方成绩；绘图依据坐标与连线数据审阅，请核查。'
          : question?.kind === 'choice'
            ? '按标准答案核对，仅供练习，不代表官方成绩'
            : '关键词规则仅供自查，不代表考试阅卷分数；图形未做语义评分。'}
      </div>
      {attempt.rubric?.length > 0 && (
        <div className="rubric-list">
          {attempt.rubric.map((item) => (
            <div key={item.id} className="rubric-row">
              <span className={item.earned > 0 ? 'check positive' : 'check'}>
                {item.earned > 0 ? '✓' : '·'}
              </span>
              <div>
                <strong>{item.label}</strong>
                <p>{item.feedback}</p>
              </div>
              <b>
                {item.earned}/{item.possible}
              </b>
            </div>
          ))}
        </div>
      )}
      <div className="explanation">
        <h3>解析与参考思路</h3>
        <p>{attempt.explanation || '本次解析不可用'}</p>
      </div>
      {supportsReviewKnowledge(api) && <ReviewKnowledgePanel api={api} attempt={attempt} />}
      <details>
        <summary>查看本次提交的答案 · {dateText(attempt.submittedAt)}</summary>
        <div className="submitted-answer">
          {attempt.draft.choiceId && (
            <p>
              选项：{attempt.draft.choiceId}{' '}
              {question?.choices?.find((c) => c.id === attempt.draft.choiceId)?.text}
            </p>
          )}
          {!attempt.draft.argument &&
            attempt.draft.blocks.map((block, index) => (
              <p key={block.id}>
                <b>
                  {index + 1}. {block.label}
                </b>
                <br />
                {block.text}
              </p>
            ))}
          {attempt.draft.argument && (
            <details className="submitted-structure">
              <summary>查看提交时的模块结构</summary>
              <ArgumentSnapshot nodes={attempt.draft.argument.roots} />
              <p className="muted">结构生成预览（最终正文保留在下方）</p>
              <p className="argument-prose">{generateArgumentText(attempt.draft.argument.roots)}</p>
            </details>
          )}
          {attempt.draft.text && <p className="argument-prose">{attempt.draft.text}</p>}
          {attempt.draft.math && (
            <MathWorkbench
              key={attempt.id}
              value={attempt.draft.math}
              onChange={() => {}}
              disabled
            />
          )}
          {(question?.kind === 'geography' ||
            (!question &&
              (attempt.draft.drawing.points.length > 0 ||
                attempt.draft.drawing.lines.length > 0))) && (
            <GeographyWorkbench drawing={attempt.draft.drawing} onChange={() => {}} disabled />
          )}
        </div>
      </details>
    </section>
  )
}

export default function App() {
  const [questions, setQuestions] = useState<StudentQuestion[]>([])
  const [state, setState] = useState<StudyState>(blankState)
  const latestStudyRef = useRef(state)
  latestStudyRef.current = state
  const latestQuestionsRef = useRef(questions)
  latestQuestionsRef.current = questions
  const [capabilities, setCapabilities] = useState<Capabilities>()
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [view, setView] = useState<View>('practice')
  const [questionContext, setQuestionContext] = useState<StudyQuestionContext>({
    view: 'practice',
    subject: 'all',
    query: '',
    selectedId: '',
  })
  const { view: questionView, subject, query, selectedId } = questionContext
  const setSelectedId = (selectedId: string) =>
    setQuestionContext((previous) => ({ ...previous, selectedId }))
  const setSubject = (subject: Subject | 'all') =>
    setQuestionContext((previous) => ({ ...previous, subject }))
  const setQuery = (query: string) => setQuestionContext((previous) => ({ ...previous, query }))
  const [formulaOrigin, setFormulaOrigin] = useState<View>('practice')
  const workspaceView = view === 'formulas' ? formulaOrigin : view
  const currentViewRef = useRef<View>(view)
  currentViewRef.current = view
  const [tab, setTab] = useState<'answer' | 'review'>('answer')
  const [busy, setBusy] = useState(false)
  const [provider, setProvider] = useState<'local' | 'cloud'>('local')
  const [cloudConsent, setCloudConsent] = useState(false)
  const [modelProfiles, setModelProfiles] = useState<ModelProfilesState | null>(null)
  const modelConfig =
    modelProfiles?.profiles.find((profile) => profile.profileId === modelProfiles.roles.parent) ??
    null
  const childModelConfig =
    modelProfiles?.profiles.find((profile) => profile.profileId === modelProfiles.roles.child) ??
    null
  const settingsNavigationGuard = useRef<((navigate: () => void) => void) | null>(null)
  const practiceRootRef = useRef<HTMLElement>(null)
  const [knowledgeExcerpts, setKnowledgeExcerpts] = useState<KnowledgeEvidence[]>([])
  const [knowledgeCitation, setKnowledgeCitation] = useState<
    (AdvisorCitation & { requestId: string }) | undefined
  >()
  const [syllabus, setSyllabus] = useState('')
  const submitting = useRef(false)
  const [saveStatus, setSaveStatus] = useState('草稿自动保存到本机')
  const [message, setMessage] = useState('')
  const [historyId, setHistoryId] = useState('')
  const saveSequence = useRef(0)
  const currentQuestionId = useRef<string | undefined>(undefined)
  const api = window.examcraft
  const layout = useWorkspaceLayout()
  const appearance = useAppearance()
  const focusAppearance = useRef(false)
  useEffect(() => {
    if (view === 'adapters' && focusAppearance.current) {
      focusAppearance.current = false
      const element = document.getElementById('appearance-settings')
      element?.focus()
      element?.scrollIntoView({ block: 'center' })
    }
  }, [view])
  const isStudyView = isStudyRoute(view)

  async function load() {
    if (!api) {
      setError(
        '请通过 npm run dev 或 npm start 打开 Electron 桌面应用。本页面需要桌面端的本地存储服务。',
      )
      return
    }
    setError('')
    try {
      const [bank, stored, info, config] = await Promise.all([
        api.listQuestions(),
        api.loadState(),
        api.getCapabilities(),
        api.getModelProfiles().catch(() => null),
      ])
      setQuestions(bank)
      setState(stored)
      setCapabilities(info)
      setModelProfiles(config)
      if (!config)
        setError('模型设置暂时无法读取；本地练习仍可使用。请检查模型配置文件或恢复备份。')
      setSelectedId(bank[0]?.id ?? '')
      setLoaded(true)
    } catch (err) {
      setError(errorText(err))
    }
  }
  useEffect(() => {
    void load()
  }, [])

  const filtered = filterStudyQuestions(questions, questionView, subject, query)
  const selected = filtered.find((q) => q.id === selectedId) ?? filtered[0]
  currentQuestionId.current = selected?.id
  useEffect(() => {
    setCloudConsent(false)
  }, [selected?.id, provider, modelConfig?.revision])
  useEffect(() => {
    setKnowledgeExcerpts([])
    setKnowledgeCitation(undefined)
  }, [selected?.id, workspaceView])
  const cloudReady = Boolean(modelConfig?.configured)
  const draft = selected ? (state.drafts[selected.id] ?? emptyDraft(selected.kind)) : emptyDraft()
  const currentDraftRef = useRef(draft)
  currentDraftRef.current = draft
  const attempts = selected ? state.attempts.filter((a) => a.questionId === selected.id) : []
  const latest = attempts.at(-1)
  const completed = new Set(state.attempts.map((a) => a.questionId)).size
  const choiceAttempts = state.attempts.filter(
    (a) => questions.find((q) => q.id === a.questionId)?.kind === 'choice',
  )
  const accuracy = choiceAttempts.length
    ? `${Math.round((choiceAttempts.filter((a) => a.score === a.maxScore).length / choiceAttempts.length) * 100)}%`
    : '—'

  function changeView(next: View) {
    if (busy || next === view) return
    const navigate = () => {
      if (next === 'formulas') setFormulaOrigin(view)
      // Commit the visible fallback before leaving a study page, rather than reviving
      // an old selection when an auxiliary page opens. Empty searches stay empty.
      const leavingStudy =
        isStudyRoute(view) || (view === 'formulas' && isStudyRoute(formulaOrigin))
      setQuestionContext((previous) =>
        navigateStudyQuestionContext(
          previous,
          next,
          leavingStudy ? { id: selected?.id ?? '' } : undefined,
        ),
      )
      setView(next)
      layout.closeDrawers()
      // Agent and other auxiliary pages share the exact last study scope. Only an
      // explicit move to a different study workspace resets the list filters.
      if (isStudyRoute(next) && next !== questionView) {
        setKnowledgeExcerpts([])
        setTab('answer')
      }
      setMessage('')
    }
    if (view === 'adapters' && settingsNavigationGuard.current)
      settingsNavigationGuard.current(navigate)
    else navigate()
  }
  function selectQuestion(id: string) {
    if (busy) return
    setSelectedId(id)
    if (layout.geometry.questionsOverlay) layout.closeDrawer()
    setKnowledgeExcerpts([])
    setTab('answer')
    setMessage('')
  }
  function updateDraft(next: AnswerDraft) {
    if (!selected || !api || busy) return
    const id = selected.id
    currentDraftRef.current = next
    latestStudyRef.current = {
      ...latestStudyRef.current,
      drafts: { ...latestStudyRef.current.drafts, [id]: next },
    }
    setCloudConsent(false)
    setState((s) => ({ ...s, drafts: { ...s.drafts, [id]: next } }))
    const seq = ++saveSequence.current
    setSaveStatus('正在保存…')
    void api
      .saveDraft(id, next)
      .then(() => {
        if (seq === saveSequence.current) {
          setSaveStatus('已保存到本机')
          setError((old) => (old.startsWith('草稿保存失败：') ? '' : old))
        }
      })
      .catch((err) => {
        if (seq === saveSequence.current) {
          setError(`草稿保存失败：${errorText(err)}`)
          setSaveStatus('保存失败，请重试')
        }
      })
  }
  async function submit() {
    if (!selected || !api || busy || submitting.current) return
    if (provider === 'cloud' && (!cloudReady || !cloudConsent)) {
      setError('请先配置自定义模型，并确认本次数据发送。')
      return
    }
    submitting.current = true
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const attempt = await api.submitAnswer(selected.id, draft, {
        provider,
        ...(provider === 'cloud'
          ? { cloudConsent, syllabus: syllabus.trim(), configRevision: modelConfig?.revision }
          : {}),
      })
      setState((s) => ({
        ...s,
        drafts: { ...s.drafts, [selected.id]: draft },
        attempts: [...s.attempts, attempt],
      }))
      if (currentQuestionId.current === selected.id) {
        setTab('review')
        setSaveStatus('答案与审阅结果已保存')
      }
    } catch (err) {
      setError(errorText(err))
    } finally {
      submitting.current = false
      setCloudConsent(false)
      setBusy(false)
    }
  }
  async function importBank() {
    if (!api || busy) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const result = await api.importQuestionBank()
      if (!result.canceled) {
        setQuestions(await api.listQuestions())
        setMessage(`已导入 ${result.count} 道题，可在题目列表中练习。`)
      }
    } catch (err) {
      setError(`题库导入失败：${errorText(err)}`)
    } finally {
      setBusy(false)
    }
  }
  const canSubmit =
    selected?.kind === 'choice'
      ? Boolean(draft.choiceId)
      : selected && ['chinese', 'math', 'english', 'history'].includes(selected.kind)
        ? Boolean(draft.text.trim())
        : Boolean(
            draft.text.trim() ||
            (!draft.argument && draft.blocks.some((b) => b.text.trim())) ||
            draft.drawing.points.length,
          )
  const focusedHistory = state.attempts.find((a) => a.id === historyId)

  return (
    <div
      className={`app-shell workspace-shell ${layout.geometry.navigationCollapsed ? 'navigation-collapsed' : ''} ${isStudyView ? 'is-study-view' : ''}`}
      style={{ '--navigation-width': `${layout.geometry.navigationWidth}px` } as CSSProperties}
    >
      <WallpaperLayer appearance={appearance} />
      <aside id="workspace-navigation" className="sidebar" aria-label="工作区侧栏">
        <button
          className="navigation-toggle"
          aria-label={layout.geometry.navigationCollapsed ? '展开导航栏' : '折叠导航栏'}
          aria-expanded={!layout.geometry.navigationCollapsed}
          aria-controls="workspace-navigation"
          disabled={layout.viewport < 1250}
          title={layout.viewport < 1250 ? '小窗口使用精简导航，放大窗口可展开' : '展开或折叠导航栏'}
          onClick={() => layout.toggle('navigation')}
        >
          ☰
        </button>
        <div className="brand">
          <span className="brand-mark">
            E<span>↗</span>
          </span>
          <div>
            <strong>ExamCraft</strong>
            <small>把思考，变成作品。</small>
          </div>
        </div>
        <div className="workspace-label">
          个人工作空间 <span>LOCAL</span>
        </div>
        <nav aria-label="工作区导航">
          {navigation.map((item) => (
            <button
              key={item.id}
              title={`${item.label} · ${item.caption}`}
              aria-label={`${item.label} ${item.caption}`}
              aria-current={view === item.id ? 'page' : undefined}
              className={`nav-item ${view === item.id ? 'active' : ''}`}
              onClick={() => changeView(item.id)}
            >
              <span className="nav-icon">{item.icon}</span>
              <span>
                {item.label}
                <small>{item.caption}</small>
              </span>
              {view === item.id && <span className="nav-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-tip">
          <span className="tiny-grid">▦</span>
          <strong>先思考，再审阅</strong>
          <p>
            把答案拆成步骤，
            <br />
            把知识连接起来。
          </p>
          <span className="edition">MVP / 01</span>
        </div>
        <div className="local-status">
          <span className="status-dot" />
          <div>
            本地优先学习<small>本地离线可用 · 云端需确认</small>
          </div>
        </div>
      </aside>

      <div className="navigation-divider-slot">
        {!layout.geometry.navigationCollapsed && (
          <PanelDivider
            label="导航栏宽度"
            controls="workspace-navigation"
            value={layout.geometry.navigationWidth}
            min={PANEL_LIMITS.navigation.min}
            max={PANEL_LIMITS.navigation.max}
            onResize={(width) => layout.resize('navigation', width)}
            onReset={() => layout.resetPanel('navigation')}
          />
        )}
      </div>
      <main className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            工作空间 <span>/</span> <b>{navigation.find((n) => n.id === view)?.label}</b>
          </div>
          <div className="topbar-right">
            <button
              className="appearance-shortcut"
              disabled={busy}
              onClick={() => {
                if (view === 'adapters') {
                  const element = document.getElementById('appearance-settings')
                  element?.focus()
                  element?.scrollIntoView({ block: 'center' })
                } else {
                  focusAppearance.current = true
                  changeView('adapters')
                }
              }}
            >
              外观
            </button>
            <button className="layout-reset" title="恢复默认栏宽和展开状态" onClick={layout.reset}>
              重置布局
            </button>
            <span className="offline-pill">
              <span className="status-dot" /> Local workspace
            </span>
            <button onClick={importBank} disabled={!loaded || busy} className="import-button">
              ＋ 导入题库
            </button>
            <GitHubProfile className="topbar-profile" />
          </div>
        </header>
        <div className="page-content">
          {error && (
            <div role="alert" className="error-banner">
              <span>{error}</span>
              <button onClick={() => (loaded ? setError('') : void load())}>
                {loaded ? '关闭' : '重试'}
              </button>
            </div>
          )}
          {message && (
            <div role="status" className="success-banner">
              {message}
            </div>
          )}
          {!loaded && !error && <p role="status">正在打开本地学习空间…</p>}
          {loaded && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">
                    {view === 'formulas'
                      ? 'LOOK UP, UNDERSTAND, APPLY'
                      : view === 'agent'
                        ? 'BOUNDED AGENT, EXPLICIT TOOLS'
                        : view === 'history'
                          ? 'REFLECT & GROW'
                          : view === 'adapters'
                            ? 'YOUR KNOWLEDGE, CONNECTED'
                            : 'A LITTLE PROGRESS, EVERY DAY'}
                  </div>
                  <h1>
                    {view === 'practice'
                      ? '今天，理解得更深一点。'
                      : view === 'math'
                        ? '把公式，变成可探索的图像。'
                        : view === 'politics'
                          ? '让每个观点，有理有据。'
                          : view === 'geography'
                            ? '在坐标里，发现联系。'
                            : view === 'formulas'
                              ? '把每个公式，用在合适的地方。'
                              : view === 'agent'
                                ? '把工具交给 Agent，把决定留给自己。'
                                : view === 'history'
                                  ? '每一次练习，都有迹可循。'
                                  : '为你的学习，接入更多可能。'}
                  </h1>
                  <p>
                    {view === 'formulas'
                      ? '查公式、看条件、核对易错点，再带着理解回到练习。'
                      : view === 'agent'
                        ? '确认学习范围与能力，查看实际工具执行，并逐项审阅写入建议。'
                        : view === 'history'
                          ? '回看提交时的答案与反馈，找到下一次进步的起点。'
                          : view === 'adapters'
                            ? '从本地题库出发，逐步接入你自己的工具与 Agent。'
                            : '选题 → 作答 → 审阅 → 重做：根据反馈改进答案，保留每次练习记录。'}
                  </p>
                </div>
                <div className="session-tag">
                  <span className="status-dot" /> 自主练习 <span>·</span> 不限时
                </div>
              </div>
              {view === 'history' && (
                <section className="learning-overview history-overview" aria-label="学习概览">
                  <h2>学习概览</h2>
                  <div className="stats-row">
                    <div className="stat-card">
                      <span className="stat-icon teal">▤</span>
                      <div>
                        <span>可用题目</span>
                        <strong>
                          {questions.length}
                          <small>道</small>
                        </strong>
                      </div>
                      <span className="stat-note">内置示例 + 导入题库</span>
                    </div>
                    <div className="stat-card">
                      <span className="stat-icon amber">✓</span>
                      <div>
                        <span>已练习</span>
                        <strong>
                          {completed}
                          <small>/ {questions.length} 道</small>
                        </strong>
                      </div>
                      <span className="stat-note">累计 {state.attempts.length} 次作答</span>
                    </div>
                    <div className="stat-card">
                      <span className="stat-icon blue">↗</span>
                      <div>
                        <span>选择题正确率</span>
                        <strong>{accuracy}</strong>
                      </div>
                      <span className="stat-note">按全部提交次数统计</span>
                    </div>
                  </div>

                  <ActivityHeatmap
                    attempts={state.attempts}
                    questions={questions}
                    onSelectAttempt={(id) => {
                      if (busy) return
                      setHistoryId(id)
                      changeView('history')
                    }}
                  />
                </section>
              )}

              <div hidden={view !== 'formulas'}>
                <FormulaReference />
              </div>

              {view === 'agent' && (
                <AgentWorkbench
                  api={api!}
                  parentConfig={modelConfig}
                  childConfig={childModelConfig}
                  configRevision={modelProfiles?.revision ?? 0}
                  currentQuestion={selected}
                  currentAnswer={draft}
                  onOpenSettings={() => changeView('adapters')}
                  onApplyAnswer={(input) => {
                    // A confirmed native write may finish after leaving this route.
                    // Reconcile its target question without overwriting any newer local edits.
                    const question = latestQuestionsRef.current.find(
                      (item) => item.id === input.questionId,
                    )
                    if (!question) return false
                    const current =
                      latestStudyRef.current.drafts[input.questionId] ?? emptyDraft(question.kind)
                    const next = acceptedAgentDraft(current, input)
                    if (!next) return false
                    latestStudyRef.current = {
                      ...latestStudyRef.current,
                      drafts: { ...latestStudyRef.current.drafts, [input.questionId]: next },
                    }
                    setState((previous) => {
                      const current = previous.drafts[input.questionId] ?? emptyDraft(question.kind)
                      const next = acceptedAgentDraft(current, input)
                      return next
                        ? { ...previous, drafts: { ...previous.drafts, [input.questionId]: next } }
                        : previous
                    })
                    if (currentQuestionId.current === input.questionId) {
                      currentDraftRef.current = next
                      setCloudConsent(false)
                      ++saveSequence.current
                      setSaveStatus('Agent 修改已保存到本机')
                    }
                    return true
                  }}
                  onAcceptedQuestion={(question) => {
                    setQuestions((previous) =>
                      previous.some((item) => item.id === question.id)
                        ? previous
                        : [...previous, question],
                    )
                  }}
                />
              )}

              {['practice', 'math', 'politics', 'geography'].includes(workspaceView) && (
                <section className="workspace-region" aria-label="学习工作台" hidden={!isStudyView}>
                  <div
                    className="workspace-toolbar"
                    aria-label="工作区布局"
                    data-workspace-layout-control
                  >
                    <div className="workspace-panel-toggles">
                      <button
                        aria-controls="question-panel"
                        aria-expanded={layout.questionsVisible}
                        onClick={() => layout.toggle('questions')}
                      >
                        <span aria-hidden="true">▤</span> 练习目录
                      </button>
                      <button
                        aria-controls="tools-panel"
                        aria-expanded={layout.toolsVisible}
                        onClick={() => layout.toggle('tools')}
                      >
                        <span aria-hidden="true">◫</span> 工具与顾问
                      </button>
                      <button onClick={layout.focusAnswer} title="收起侧栏，把空间留给答案">
                        专注作答
                      </button>
                    </div>
                    <span className="layout-hint">拖动分隔线调整 · 双击还原</span>
                  </div>
                  {layout.drawer && (
                    <button
                      className="workspace-scrim"
                      aria-label="关闭侧栏遮罩"
                      onClick={layout.closeDrawer}
                    />
                  )}
                  <section
                    ref={practiceRootRef}
                    className={`study-layout resizable-study-layout ${layout.questionsVisible && !layout.geometry.questionsOverlay ? 'has-questions' : ''} ${layout.toolsVisible && !layout.geometry.toolsOverlay ? 'has-tools' : ''}`}
                    aria-label="题目与作答"
                    style={
                      {
                        '--questions-width': `${layout.geometry.questionsWidth}px`,
                        '--tools-width': `${layout.geometry.toolsWidth}px`,
                      } as CSSProperties
                    }
                  >
                    <section
                      id="question-panel"
                      className={`question-library card workspace-panel ${layout.geometry.questionsOverlay ? 'workspace-drawer question-drawer' : ''}`}
                      aria-label="题目列表"
                      role={layout.geometry.questionsOverlay ? 'dialog' : undefined}
                      aria-modal={layout.geometry.questionsOverlay ? true : undefined}
                      hidden={!layout.questionsVisible}
                    >
                      <div className="library-heading">
                        <h2>练习目录</h2>
                        <span>{filtered.length} 题</span>
                        <button
                          className="panel-close"
                          aria-label="折叠练习目录"
                          onClick={() => layout.toggle('questions')}
                        >
                          ‹
                        </button>
                      </div>
                      <input
                        className="search-input"
                        aria-label="搜索题目"
                        placeholder="搜索题目、知识点…"
                        value={query}
                        disabled={busy}
                        onChange={(e) => {
                          setQuery(e.target.value)
                          setTab('answer')
                        }}
                      />
                      <div className="subject-filters" aria-label="按学科筛选">
                        {[
                          ['all', '全部'],
                          ...subjects
                            .filter(
                              (id) =>
                                workspaceView === 'practice' ||
                                (workspaceView === 'politics'
                                  ? ['politics', 'history', 'chinese', 'geography'].includes(id)
                                  : id === workspaceView),
                            )
                            .map((id) => [id, id === 'politics' ? '政治' : subjectLabel[id]]),
                        ].map(([id, label]) => (
                          <button
                            key={id}
                            aria-pressed={subject === id}
                            disabled={busy}
                            onClick={() => {
                              setSubject(id as Subject | 'all')
                              setTab('answer')
                            }}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      <div className="question-list">
                        {filtered.map((q, index) => (
                          <button
                            key={q.id}
                            className={`question-item ${selected?.id === q.id ? 'selected' : ''}`}
                            onClick={() => selectQuestion(q.id)}
                          >
                            <span className="question-number">
                              {String(index + 1).padStart(2, '0')}
                            </span>
                            <span className="question-item-body">
                              <span className="question-item-meta">
                                {subjectLabel[q.subject]} <i>·</i> {kindLabel[q.kind]}
                              </span>
                              <strong>{q.title}</strong>
                              <small>{q.tags.slice(0, 2).join(' / ')}</small>
                            </span>
                            <span className="completion">
                              {state.attempts.some((a) => a.questionId === q.id) ? '✓' : '›'}
                            </span>
                          </button>
                        ))}
                      </div>
                      {!filtered.length && (
                        <div className="empty-state small">
                          没有符合条件的题目。
                          <button
                            onClick={() => {
                              setQuery('')
                              setSubject('all')
                            }}
                          >
                            清除筛选
                          </button>
                        </div>
                      )}
                      <div className="library-footnote">
                        <span>◇</span> 内置题目为原创示例，非历年真题。可导入你有权使用的 JSON
                        题库。
                      </div>
                    </section>

                    {layout.questionsVisible && !layout.geometry.questionsOverlay && (
                      <PanelDivider
                        label="练习目录宽度"
                        controls="question-panel"
                        value={layout.geometry.questionsWidth}
                        min={PANEL_LIMITS.questions.min}
                        max={PANEL_LIMITS.questions.max}
                        onResize={(width) => layout.resize('questions', width)}
                        onReset={() => layout.resetPanel('questions')}
                      />
                    )}
                    <section
                      className="exercise-card card workspace-answer"
                      aria-label="作答工作区"
                    >
                      {selected ? (
                        <>
                          <div className="exercise-top">
                            <div className="pills">
                              <span className="subject-pill">{subjectLabel[selected.subject]}</span>
                              <span className="kind-pill">{kindLabel[selected.kind]}</span>
                              <span className="points-pill">{selected.maxScore} 分</span>
                            </div>
                            <span className="question-id">{selected.id}</span>
                          </div>
                          <div className="question-prompt" data-advisor-source="question">
                            <h2>{selected.title}</h2>
                            <p>{selected.prompt}</p>
                            {selected.geometry && <GeometryFigure scene={selected.geometry} />}
                            {selected.figure && <GeographyFigure figure={selected.figure} />}
                            {selected.terrain && <TerrainFigure exercise={selected.terrain} />}
                            {selected.provenance?.kind === 'ai-generated' && (
                              <p className="generated-question-note">
                                AI 原创练习 ·
                                示意图仅做结构校验，题目、参考解析和评分依据未经过事实核验，非真实考试题。
                              </p>
                            )}
                            <div className="question-source">
                              {selected.source} <span>·</span> {selected.tags.join(' / ')}
                            </div>
                          </div>
                          <div className="answer-tabs" role="tablist" aria-label="答题与反馈">
                            <button
                              role="tab"
                              aria-selected={tab === 'answer'}
                              onClick={() => setTab('answer')}
                            >
                              我的作答
                            </button>
                            <button
                              role="tab"
                              aria-selected={tab === 'review'}
                              onClick={() => setTab('review')}
                              disabled={!latest || busy}
                            >
                              审阅反馈{' '}
                              {latest && <span className="tab-count">{attempts.length}</span>}
                            </button>
                            <span className="save-status" role="status">
                              {saveStatus}
                            </span>
                          </div>
                          {tab === 'review' && latest ? (
                            <>
                              <Review attempt={latest} question={selected} api={api} />
                              {busy && submitting.current && provider === 'cloud' && (
                                <div>
                                  <ModelRequestStatus label="AI 答卷审查" />
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void api!
                                        .cancelModelReview()
                                        .catch(() => setError('取消请求未完成，请重试。'))
                                    }
                                  >
                                    取消 AI 审查
                                  </button>
                                </div>
                              )}
                              <div className="exercise-actions">
                                <span className="muted">重做会新增一条记录，保留原来的提交。</span>
                                <button
                                  className="primary"
                                  disabled={busy}
                                  onClick={() => {
                                    updateDraft(emptyDraft(selected?.kind))
                                    setTab('answer')
                                  }}
                                >
                                  重新练习 ↗
                                </button>
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="answer-area" data-role-context="student">
                                <p className="role-boundary-note">
                                  作答区 · 只显示题目与自己的草稿。顾问建议需你确认后才会修改模块。
                                </p>
                                {selected.kind === 'choice' && (
                                  <>
                                    <div className="section-label">选择你认为正确的一项</div>
                                    <div
                                      className="choices"
                                      role="radiogroup"
                                      aria-label="选择答案"
                                    >
                                      {selected.choices?.map((option) => (
                                        <button
                                          key={option.id}
                                          role="radio"
                                          aria-checked={draft.choiceId === option.id}
                                          disabled={busy}
                                          className={`choice ${draft.choiceId === option.id ? 'chosen' : ''}`}
                                          onClick={() =>
                                            updateDraft({ ...draft, choiceId: option.id })
                                          }
                                        >
                                          <span className="choice-letter">{option.id}</span>
                                          <span>{option.text}</span>
                                          <span className="radio-indicator">
                                            {draft.choiceId === option.id ? '✓' : ''}
                                          </span>
                                        </button>
                                      ))}
                                    </div>
                                  </>
                                )}
                                <label className="thinking-label" htmlFor="answer-text">
                                  {selected.kind === 'choice'
                                    ? '思考笔记'
                                    : subjectGuidance[selected.subject].label}
                                  <span>
                                    {selected.kind === 'choice'
                                      ? '可选 · 记录你选择的理由'
                                      : '把知识点与题目材料联系起来'}
                                  </span>
                                </label>
                                <textarea
                                  id="answer-text"
                                  data-advisor-source="answer"
                                  rows={selected.kind === 'choice' ? 3 : 5}
                                  lang={selected.subject === 'english' ? 'en' : 'zh-CN'}
                                  value={draft.text}
                                  disabled={busy}
                                  maxLength={20000}
                                  placeholder={
                                    selected.kind === 'choice'
                                      ? '为什么选这一项？其他选项的问题在哪里？'
                                      : subjectGuidance[selected.subject].placeholder
                                  }
                                  onChange={(e) => updateDraft({ ...draft, text: e.target.value })}
                                />
                                {selected.subject === 'english' && selected.kind !== 'choice' && (
                                  <p className="muted" aria-live="polite">
                                    词数参考：
                                    {draft.text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)?.length ??
                                      0}{' '}
                                    words
                                  </p>
                                )}
                                {provider === 'local' && selected.kind !== 'choice' && (
                                  <div className="notice compact">
                                    本地审阅按关键词检查要点，仅供学习自查。
                                    {subjectGuidance[selected.subject].local}
                                  </div>
                                )}
                                <fieldset className="review-settings" disabled={busy}>
                                  <legend>选择审阅方式</legend>
                                  <div className="review-provider-options">
                                    <label>
                                      <input
                                        type="radio"
                                        name="review-provider"
                                        value="local"
                                        checked={provider === 'local'}
                                        onChange={() => {
                                          setProvider('local')
                                          setCloudConsent(false)
                                        }}
                                      />
                                      <span>
                                        <strong>本地规则</strong>
                                        <small>离线审阅，不发送答案</small>
                                      </span>
                                    </label>
                                    <label>
                                      <input
                                        type="radio"
                                        name="review-provider"
                                        value="cloud"
                                        checked={provider === 'cloud'}
                                        disabled={!cloudReady}
                                        onChange={() => {
                                          setProvider('cloud')
                                          setCloudConsent(false)
                                        }}
                                      />
                                      <span>
                                        <strong>自定义模型</strong>
                                        <small>
                                          {cloudReady
                                            ? '联网审阅，可能产生 API 费用'
                                            : '尚未配置，暂不可用'}
                                        </small>
                                      </span>
                                    </label>
                                  </div>
                                  <button
                                    type="button"
                                    className="model-settings-shortcut"
                                    onClick={() => changeView('adapters')}
                                  >
                                    配置模型 / 协议
                                  </button>
                                  {!cloudReady && (
                                    <p className="review-settings-note">
                                      先在「题库与 Agent」中保存模型配置并为父角色分配可用模型。
                                    </p>
                                  )}
                                  {provider === 'cloud' && (
                                    <div className="cloud-review-options">
                                      <p className="review-settings-note">
                                        父角色配置：{modelConfig?.profileName} · 模型：
                                        {modelConfig?.model} · 协议：{modelConfig?.protocol} ·
                                        接收方：{modelConfig?.baseUrl} 。AI
                                        反馈可能有误，请对照参考思路核查。
                                      </p>
                                      <label htmlFor="review-syllabus">
                                        学习范围 / 考纲（可选）
                                      </label>
                                      <textarea
                                        id="review-syllabus"
                                        rows={3}
                                        maxLength={4000}
                                        value={syllabus}
                                        placeholder="可粘贴你希望参考的学习范围或考纲节选，请勿填写密钥或个人敏感信息。"
                                        onChange={(event) => {
                                          setSyllabus(event.target.value)
                                          setCloudConsent(false)
                                        }}
                                      />
                                      <p className="review-settings-note">
                                        {syllabus.length}/4000 字 ·
                                        仅在本次页面会话保留。不填写时不会声称依据官方考纲；填写内容也未经官方核验。
                                      </p>
                                      <p className="review-settings-note">
                                        发送前请移除题目、答案及学习范围中的姓名、身份信息和私人内容。不会附带历史练习记录或以往成绩。
                                      </p>
                                      <ModelConsentControl
                                        api={api!}
                                        config={modelConfig}
                                        scopes={['grading']}
                                        checked={cloudConsent}
                                        onChange={setCloudConsent}
                                        disabled={busy || !cloudReady}
                                        label={`我同意本次将当前题目（来源、参考答案、解析、评分依据）、我的答案（最终正文、模块结构、绘图、数学函数及参数/测量）和所填学习范围发送至 ${modelConfig?.baseUrl} 进行审阅，可能产生 API 费用。`}
                                      />
                                    </div>
                                  )}
                                  <p className="review-settings-note">
                                    所有审阅结果仅供练习反馈，不是官方成绩。
                                  </p>
                                </fieldset>
                              </div>
                              {busy && submitting.current && provider === 'cloud' && (
                                <div>
                                  <ModelRequestStatus label="AI 答卷审查" />
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void api!
                                        .cancelModelReview()
                                        .catch(() => setError('取消请求未完成，请重试。'))
                                    }
                                  >
                                    取消 AI 审查
                                  </button>
                                </div>
                              )}
                              <div className="exercise-actions">
                                <span className="muted">
                                  <span className="status-dot" />{' '}
                                  {provider === 'local'
                                    ? '本地规则审阅已就绪'
                                    : cloudConsent
                                      ? '已确认本次云端发送'
                                      : '请确认本次云端发送'}
                                </span>
                                <button
                                  className="primary"
                                  onClick={submit}
                                  disabled={
                                    !canSubmit ||
                                    busy ||
                                    (provider === 'cloud' && (!cloudReady || !cloudConsent))
                                  }
                                >
                                  {busy ? '正在审阅…' : '提交并审阅'}{' '}
                                  <span aria-hidden="true">→</span>
                                </button>
                              </div>
                            </>
                          )}
                        </>
                      ) : (
                        <div className="empty-state">
                          <span>▤</span>
                          <h2>从一道题开始</h2>
                          <p>调整左侧筛选，或导入你的题库。</p>
                        </div>
                      )}
                    </section>
                    {layout.toolsVisible && !layout.geometry.toolsOverlay && (
                      <PanelDivider
                        label="工具与顾问宽度"
                        controls="tools-panel"
                        reverse
                        value={layout.geometry.toolsWidth}
                        min={PANEL_LIMITS.tools.min}
                        max={PANEL_LIMITS.tools.max}
                        onResize={(width) => layout.resize('tools', width)}
                        onReset={() => layout.resetPanel('tools')}
                      />
                    )}
                    <aside
                      id="tools-panel"
                      className={`workspace-tools card workspace-panel ${layout.geometry.toolsOverlay ? 'workspace-drawer tools-drawer' : ''}`}
                      aria-label="工具与顾问"
                      role={layout.geometry.toolsOverlay ? 'dialog' : undefined}
                      aria-modal={layout.geometry.toolsOverlay ? true : undefined}
                      hidden={!layout.toolsVisible}
                    >
                      <div className="tools-panel-heading">
                        <div>
                          <span className="eyebrow">EXPLORE & THINK</span>
                          <h2>工具与顾问</h2>
                        </div>
                        <button
                          className="panel-close"
                          aria-label="折叠工具与顾问"
                          onClick={() => layout.toggle('tools')}
                        >
                          ›
                        </button>
                      </div>
                      <div className="tools-panel-content">
                        <p className="tools-panel-intro">在这里探索与组装，最终答案保留在左侧。</p>
                        {selected && (
                          <div hidden={tab !== 'answer'}>
                            <SelectionAdvisor
                              key={`${selected.id}-${workspaceView}`}
                              active={isStudyView && layout.toolsVisible && tab === 'answer'}
                              api={api!}
                              config={childModelConfig}
                              question={selected}
                              draft={draft}
                              sourceRevision={JSON.stringify({
                                question: selected,
                                text: draft.text,
                                choiceId: draft.choiceId,
                                blocks: draft.blocks,
                                roots: draft.argument?.roots,
                              })}
                              knowledgeExcerpts={knowledgeExcerpts}
                              onClearKnowledgeExcerpts={() => setKnowledgeExcerpts([])}
                              onOpenKnowledgeCitation={(citation) => {
                                setKnowledgeCitation({
                                  ...citation,
                                  requestId: crypto.randomUUID(),
                                })
                              }}
                              scopeRef={practiceRootRef}
                            />
                            {['politics', 'history', 'chinese', 'geography'].includes(
                              selected.kind,
                            ) && (
                              <WorkbenchDock
                                key={`dock-argument-${selected.id}-${workspaceView}`}
                                title="文科模块工作台"
                                selfSizing
                                initiallyOpen={workspaceView === 'politics'}
                              >
                                {(dockOpen) => (
                                  <div data-advisor-source="argument">
                                    <HumanitiesComposer
                                      key={`argument-${selected.id}`}
                                      active={
                                        isStudyView &&
                                        layout.toolsVisible &&
                                        dockOpen &&
                                        tab === 'answer'
                                      }
                                      subject={selected.subject}
                                      question={selected}
                                      config={childModelConfig}
                                      api={api!}
                                      draft={draft}
                                      onChange={updateDraft}
                                      disabled={busy}
                                    />
                                  </div>
                                )}
                              </WorkbenchDock>
                            )}
                            {selected.kind === 'geography' && (
                              <WorkbenchDock
                                key={`dock-geography-${selected.id}-${workspaceView}`}
                                title="地理交互工作台"
                                selfSizing
                                initiallyOpen={workspaceView === 'geography'}
                              >
                                {(dockOpen) => (
                                  <GeographyWorkbench
                                    key={`geography-${selected.id}`}
                                    drawing={draft.drawing}
                                    onChange={(drawing) => updateDraft({ ...draft, drawing })}
                                    disabled={
                                      busy ||
                                      !isStudyView ||
                                      !layout.toolsVisible ||
                                      !dockOpen ||
                                      tab !== 'answer'
                                    }
                                  />
                                )}
                              </WorkbenchDock>
                            )}
                            {selected.subject === 'math' && (
                              <WorkbenchDock
                                key={`dock-math-${selected.id}-${workspaceView}`}
                                title="数学交互工作台"
                                selfSizing
                                initiallyOpen={workspaceView === 'math'}
                              >
                                {(dockOpen) => (
                                  <MathWorkbench
                                    key={`math-${selected.id}`}
                                    value={draft.math ?? emptyMathState()}
                                    onChange={(math) => updateDraft({ ...draft, math })}
                                    disabled={
                                      busy ||
                                      !isStudyView ||
                                      !layout.toolsVisible ||
                                      !dockOpen ||
                                      tab !== 'answer'
                                    }
                                  />
                                )}
                              </WorkbenchDock>
                            )}
                          </div>
                        )}
                        {tab === 'review' && (
                          <p className="muted">返回「我的作答」可继续使用交互工具和顾问。</p>
                        )}
                        {
                          <KnowledgeLibrary
                            key={`knowledge-${selected?.id ?? 'none'}-${workspaceView}`}
                            active={isStudyView && layout.toolsVisible}
                            initialSubject={selected?.subject ?? 'politics'}
                            api={api!}
                            selectedEvidence={knowledgeExcerpts}
                            onSelectEvidence={setKnowledgeExcerpts}
                            citation={knowledgeCitation}
                          />
                        }

                        {workspaceView === 'geography' && (
                          <GeographyGenerator
                            localContext={selected ? { questionId: selected.id, draft } : undefined}
                            api={api!}
                            config={modelConfig}
                            disabled={busy}
                            visible={isStudyView && layout.toolsVisible}
                            onAccepted={(question) => {
                              setQuestions((previous) => [
                                ...previous.filter((item) => item.id !== question.id),
                                question,
                              ])
                              if (
                                currentViewRef.current === 'geography' &&
                                currentQuestionId.current === selected?.id
                              ) {
                                setSelectedId(question.id)
                                setSubject('all')
                                setQuery('')
                                setTab('answer')
                                setMessage('AI 原创题已加入本机题库；参考解析会在提交后展示。')
                              }
                            }}
                          />
                        )}
                      </div>
                    </aside>
                  </section>
                </section>
              )}

              {view === 'history' && (
                <div className="history-layout">
                  <section className="card history-list">
                    <SubmissionTimeline
                      attempts={state.attempts}
                      questions={questions}
                      selectedId={historyId}
                      onSelectAttempt={setHistoryId}
                    />
                    {state.attempts.length === 0 && (
                      <button
                        className="primary history-start"
                        onClick={() => changeView('practice')}
                      >
                        开始练习 →
                      </button>
                    )}
                  </section>
                  <section className="card history-detail">
                    <LearningGraph
                      api={api ?? undefined}
                      attempts={state.attempts}
                      onSelectAttempt={setHistoryId}
                      onRestore={
                        api?.restoreLearningSnapshot
                          ? async (snapshotId, expectedHeadId) => {
                              const restored = await api.restoreLearningSnapshot({
                                snapshotId,
                                expectedHeadId,
                              })
                              setState(await api.loadState())
                              // An explicit restore chooses a question, regardless of the
                              // old study filters. A late result must not change a newer route.
                              if (currentViewRef.current === 'history') {
                                setQuestionContext({
                                  view: 'practice',
                                  subject: 'all',
                                  query: '',
                                  selectedId: restored.questionId,
                                })
                                setTab('answer')
                              }
                              setMessage('已恢复为新的作答分支；原历史保留。')
                            }
                          : undefined
                      }
                    />
                    {focusedHistory ? (
                      <Review
                        key={focusedHistory.id}
                        attempt={focusedHistory}
                        api={api}
                        question={questions.find((q) => q.id === focusedHistory.questionId)}
                      />
                    ) : (
                      <div className="empty-state">
                        <span>◷</span>
                        <h2>回到当时的思考</h2>
                        <p>选择一条记录，查看完整答案与审阅反馈。</p>
                      </div>
                    )}
                  </section>
                </div>
              )}

              {view === 'adapters' && (
                <div className="adapters-grid">
                  <AppearanceSettings appearance={appearance} />
                  <section className="card adapter-card">
                    <span className="adapter-symbol">▤</span>
                    <span className="ready-tag">已连接</span>
                    <h2>本地题库</h2>
                    <p>{capabilities?.questionBank}</p>
                    <div className="adapter-detail">
                      通过 JSON
                      导入六科选择题、语文阅读表达、数学解答、英语读写、历史史料分析、政治模块题和地理探究题。导入时会校验字段、重复编号、分值和答案。
                    </div>
                    <button className="primary" disabled={busy} onClick={importBank}>
                      导入 JSON 题库
                    </button>
                    <p className="muted">格式示例见仓库 examples/。</p>
                  </section>
                  <section className="card adapter-card">
                    <span className="adapter-symbol">✧</span>
                    <span className="ready-tag">离线可用</span>
                    <h2>审阅 Agent</h2>
                    <p>{capabilities?.reviewer}</p>
                    <div className="adapter-detail">
                      本地模式：选择题按答案核对；主观题按关键词反馈得分点。自定义模型
                      模式：确认发送范围后获取云端练习反馈。
                    </div>
                    <div className="notice">
                      {cloudReady
                        ? `已配置 ${modelConfig?.model}；尚未验证网络或凭据。发送时需匹配接收方与数据范围授权，可能产生 API 费用。`
                        : '父角色尚未配置可用密钥。可在下方设置会话密钥或选择本机加密保存，不要粘贴到答案或学习范围中。'}
                      正式审阅使用父角色配置；反馈不代表官方成绩。地理工作台可另行确认后生成原创练习。
                    </div>
                  </section>
                  <ModelSettings
                    api={api!}
                    state={modelProfiles}
                    navigationGuardRef={settingsNavigationGuard}
                    onChange={(next) => {
                      setError((previous) =>
                        previous.startsWith('模型设置暂时无法读取') ? '' : previous,
                      )
                      setModelProfiles((previous) =>
                        !previous || next.revision >= previous.revision ? next : previous,
                      )
                      setCloudConsent(false)
                    }}
                  />
                  <WebResearchSettings api={api!} />
                  <ModelConsentSettings api={api!} />
                  <ModelDebugPanel api={api!} />
                  <section className="card adapter-card wide">
                    <span className="adapter-symbol">⌘</span>
                    <h2>MCP 题库服务</h2>
                    <p>{capabilities?.mcp}</p>
                    <div className="adapter-detail">
                      提供题目查询、读取和答案审阅工具，复用应用的题库校验与规则审阅。外部客户端以
                      stdio 方式启动服务；可通过启动参数限定学科、标签和题号。
                    </div>
                    <p className="muted">
                      接入步骤与作用域配置见 README。桌面端当前直接调用本地适配层。
                    </p>
                  </section>
                </div>
              )}
              <footer className="page-footer">
                <span>
                  ExamCraft <b>{appVersion}</b>
                </span>
                <span>学会一道题，比刷过一道题更重要。</span>
                <span>记录保存在本机 · 云端发送可按接收方记住授权</span>
              </footer>
            </>
          )}
        </div>
      </main>
    </div>
  )
}
