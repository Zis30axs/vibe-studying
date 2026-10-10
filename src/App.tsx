import { useEffect, useRef, useState } from 'react'
import type { AnswerDraft, Attempt, Capabilities, Question, StudyState } from './shared/types'
import { emptyDraft } from './shared/types'
import { PoliticsComposer } from './components/PoliticsComposer'
import { GeographyWorkbench } from './components/GeographyWorkbench'

type View = 'practice' | 'politics' | 'geography' | 'history' | 'adapters'
const kindLabel = { choice: '单项选择', politics: '模块论证', geography: '绘图探究' }
const subjectLabel = { politics: '思想政治', geography: '地理' }
const navigation: { id: View; icon: string; label: string; caption: string }[] = [
  { id: 'practice', icon: '▤', label: '题目练习', caption: 'Practice' },
  { id: 'politics', icon: '▦', label: '政治组装', caption: 'Argument builder' },
  { id: 'geography', icon: '◎', label: '地理工作台', caption: 'Geo canvas' },
  { id: 'history', icon: '◷', label: '练习记录', caption: 'Review & reflect' },
  { id: 'adapters', icon: '⌘', label: '题库与 Agent', caption: 'Connections' },
]
const blankState: StudyState = { version: 1, drafts: {}, attempts: [] }
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : '操作失败，请重试。'
const dateText = (date: string) =>
  new Date(date).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })

function Review({ attempt, question }: { attempt: Attempt; question?: Question }) {
  return (
    <section className="review-panel" aria-label="审阅结果">
      <div className="review-heading">
        <div>
          <span className="eyebrow">FEEDBACK</span>
          <h2>让每次作答都有收获</h2>
        </div>
        <div className="score">
          <strong>{attempt.score}</strong>
          <span> / {attempt.maxScore}</span>
        </div>
      </div>
      <p className="review-feedback">{attempt.feedback}</p>
      <div className="notice">
        {attempt.reviewer} ·{' '}
        {question?.kind === 'choice'
          ? '按标准答案核对'
          : '关键词规则仅供自查，不代表考试阅卷分数；图形未做语义评分。'}
      </div>
      {attempt.rubric.length > 0 && (
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
        <p>{attempt.explanation}</p>
      </div>
      <details>
        <summary>查看本次提交的答案 · {dateText(attempt.submittedAt)}</summary>
        <div className="submitted-answer">
          {attempt.draft.choiceId && (
            <p>
              选项：{attempt.draft.choiceId}{' '}
              {question?.choices?.find((c) => c.id === attempt.draft.choiceId)?.text}
            </p>
          )}
          {attempt.draft.blocks.map((block, index) => (
            <p key={block.id}>
              <b>
                {index + 1}. {block.label}
              </b>
              <br />
              {block.text}
            </p>
          ))}
          {attempt.draft.text && <p>{attempt.draft.text}</p>}
          {question?.kind === 'geography' && (
            <GeographyWorkbench drawing={attempt.draft.drawing} onChange={() => {}} disabled />
          )}
        </div>
      </details>
    </section>
  )
}

export default function App() {
  const [questions, setQuestions] = useState<Question[]>([])
  const [state, setState] = useState<StudyState>(blankState)
  const [capabilities, setCapabilities] = useState<Capabilities>()
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [view, setView] = useState<View>('practice')
  const [subject, setSubject] = useState('all')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [tab, setTab] = useState<'answer' | 'review'>('answer')
  const [busy, setBusy] = useState(false)
  const [saveStatus, setSaveStatus] = useState('草稿自动保存到本机')
  const [message, setMessage] = useState('')
  const [historyId, setHistoryId] = useState('')
  const saveSequence = useRef(0)
  const currentQuestionId = useRef<string | undefined>(undefined)
  const api = window.examcraft

  async function load() {
    if (!api) {
      setError(
        '请通过 npm run dev 或 npm start 打开 Electron 桌面应用。本页面需要桌面端的本地存储服务。',
      )
      return
    }
    setError('')
    try {
      const [bank, stored, info] = await Promise.all([
        api.listQuestions(),
        api.loadState(),
        api.getCapabilities(),
      ])
      setQuestions(bank)
      setState(stored)
      setCapabilities(info)
      setSelectedId(bank[0]?.id ?? '')
      setLoaded(true)
    } catch (err) {
      setError(errorText(err))
    }
  }
  useEffect(() => {
    void load()
  }, [])

  const filtered = questions.filter((q) => {
    if (view === 'politics' && q.kind !== 'politics') return false
    if (view === 'geography' && q.kind !== 'geography') return false
    if (subject !== 'all' && q.subject !== subject) return false
    return `${q.title} ${q.tags.join(' ')} ${q.source}`.toLowerCase().includes(query.toLowerCase())
  })
  const selected = filtered.find((q) => q.id === selectedId) ?? filtered[0]
  currentQuestionId.current = selected?.id
  const draft = selected ? (state.drafts[selected.id] ?? emptyDraft()) : emptyDraft()
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
    if (busy) return
    setView(next)
    setSubject('all')
    setQuery('')
    setTab('answer')
    setMessage('')
  }
  function selectQuestion(id: string) {
    if (busy) return
    setSelectedId(id)
    setTab('answer')
    setMessage('')
  }
  function updateDraft(next: AnswerDraft) {
    if (!selected || !api || busy) return
    const id = selected.id
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
    if (!selected || !api || busy) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const attempt = await api.submitAnswer(selected.id, draft)
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
      : Boolean(
          draft.text.trim() ||
          draft.blocks.some((b) => b.text.trim()) ||
          draft.drawing.points.length,
        )
  const focusedHistory = state.attempts.find((a) => a.id === historyId)

  return (
    <div className="app-shell">
      <aside className="sidebar">
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
            本地学习模式<small>无需账号 · 离线可用</small>
          </div>
        </div>
      </aside>

      <main className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            工作空间 <span>/</span> <b>{navigation.find((n) => n.id === view)?.label}</b>
          </div>
          <div className="topbar-right">
            <span className="offline-pill">
              <span className="status-dot" /> Local workspace
            </span>
            <button onClick={importBank} disabled={!loaded || busy} className="import-button">
              ＋ 导入题库
            </button>
            <span className="avatar">我</span>
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
                    {view === 'history'
                      ? 'REFLECT & GROW'
                      : view === 'adapters'
                        ? 'YOUR KNOWLEDGE, CONNECTED'
                        : 'A LITTLE PROGRESS, EVERY DAY'}
                  </div>
                  <h1>
                    {view === 'practice'
                      ? '今天，理解得更深一点。'
                      : view === 'politics'
                        ? '让每个观点，有理有据。'
                        : view === 'geography'
                          ? '在坐标里，发现联系。'
                          : view === 'history'
                            ? '每一次练习，都有迹可循。'
                            : '为你的学习，接入更多可能。'}
                  </h1>
                  <p>
                    {view === 'history'
                      ? '回看提交时的答案与反馈，找到下一次进步的起点。'
                      : view === 'adapters'
                        ? '从本地题库出发，逐步接入你自己的工具与 Agent。'
                        : '选择一道题，展开思考，再用反馈校准自己的理解。'}
                  </p>
                </div>
                <div className="session-tag">
                  <span className="status-dot" /> 自主练习 <span>·</span> 不限时
                </div>
              </div>
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

              {(view === 'practice' || view === 'politics' || view === 'geography') && (
                <div className="study-layout">
                  <section className="question-library card" aria-label="题目列表">
                    <div className="library-heading">
                      <h2>练习目录</h2>
                      <span>{filtered.length} 题</span>
                    </div>
                    <input
                      className="search-input"
                      aria-label="搜索题目"
                      placeholder="搜索题目、知识点…"
                      value={query}
                      onChange={(e) => {
                        setQuery(e.target.value)
                        setTab('answer')
                      }}
                    />
                    <div className="subject-filters" aria-label="按学科筛选">
                      {[
                        ['all', '全部'],
                        ['politics', '政治'],
                        ['geography', '地理'],
                      ].map(([id, label]) => (
                        <button
                          key={id}
                          aria-pressed={subject === id}
                          onClick={() => {
                            setSubject(id)
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
                      <span>◇</span> 内置题目为原创示例，非历年真题。可导入你有权使用的 JSON 题库。
                    </div>
                  </section>

                  <section className="exercise-card card" aria-label="作答工作区">
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
                        <div className="question-prompt">
                          <h2>{selected.title}</h2>
                          <p>{selected.prompt}</p>
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
                            disabled={!latest}
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
                            <Review attempt={latest} question={selected} />
                            <div className="exercise-actions">
                              <span className="muted">重做会新增一条记录，保留原来的提交。</span>
                              <button
                                className="primary"
                                onClick={() => {
                                  updateDraft(emptyDraft())
                                  setTab('answer')
                                }}
                              >
                                重新练习 ↗
                              </button>
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="answer-area">
                              {selected.kind === 'choice' && (
                                <>
                                  <div className="section-label">选择你认为正确的一项</div>
                                  <div className="choices" role="radiogroup" aria-label="选择答案">
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
                              {selected.kind === 'politics' && (
                                <PoliticsComposer
                                  key={selected.id}
                                  availableBlocks={selected.blocks ?? []}
                                  blocks={draft.blocks}
                                  onChange={(blocks) => updateDraft({ ...draft, blocks })}
                                  disabled={busy}
                                />
                              )}
                              {selected.kind === 'geography' && (
                                <GeographyWorkbench
                                  key={selected.id}
                                  drawing={draft.drawing}
                                  onChange={(drawing) => updateDraft({ ...draft, drawing })}
                                  disabled={busy}
                                />
                              )}
                              <label className="thinking-label" htmlFor="answer-text">
                                {selected.kind === 'choice' ? '思考笔记' : '文字说明与补充'}
                                <span>
                                  {selected.kind === 'choice'
                                    ? '可选 · 记录你选择的理由'
                                    : '把知识点与题目材料联系起来'}
                                </span>
                              </label>
                              <textarea
                                id="answer-text"
                                rows={selected.kind === 'choice' ? 3 : 4}
                                value={draft.text}
                                disabled={busy}
                                maxLength={20000}
                                placeholder={
                                  selected.kind === 'choice'
                                    ? '为什么选这一项？其他选项的问题在哪里？'
                                    : '写下你的分析、材料依据与结论…'
                                }
                                onChange={(e) => updateDraft({ ...draft, text: e.target.value })}
                              />
                              {selected.kind !== 'choice' && (
                                <div className="notice compact">
                                  本地审阅按关键词检查要点，仅供学习自查。绘图会随答案保存，暂不自动判断图形含义。
                                </div>
                              )}
                            </div>
                            <div className="exercise-actions">
                              <span className="muted">
                                <span className="status-dot" /> 本地规则审阅已就绪
                              </span>
                              <button
                                className="primary"
                                onClick={submit}
                                disabled={!canSubmit || busy}
                              >
                                {busy ? '正在审阅…' : '提交并审阅'} <span>→</span>
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
                </div>
              )}

              {view === 'history' && (
                <div className="history-layout">
                  <section className="card history-list">
                    <div className="library-heading">
                      <h2>全部提交</h2>
                      <span>{state.attempts.length} 次</span>
                    </div>
                    {state.attempts.length === 0 ? (
                      <div className="empty-state">
                        <h2>还没有练习记录</h2>
                        <p>提交第一份答案，反馈会保存在这里。</p>
                        <button className="primary" onClick={() => changeView('practice')}>
                          开始练习 →
                        </button>
                      </div>
                    ) : (
                      [...state.attempts].reverse().map((attempt) => (
                        <button
                          key={attempt.id}
                          className={`history-item ${historyId === attempt.id ? 'selected' : ''}`}
                          onClick={() => setHistoryId(attempt.id)}
                        >
                          <span>
                            <strong>
                              {questions.find((q) => q.id === attempt.questionId)?.title ??
                                attempt.questionId}
                            </strong>
                            <small>
                              {dateText(attempt.submittedAt)} · {attempt.reviewer}
                            </small>
                          </span>
                          <b>
                            {attempt.score}
                            <small> / {attempt.maxScore}</small>
                          </b>
                        </button>
                      ))
                    )}
                  </section>
                  <section className="card history-detail">
                    {focusedHistory ? (
                      <Review
                        key={focusedHistory.id}
                        attempt={focusedHistory}
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
                  <section className="card adapter-card">
                    <span className="adapter-symbol">▤</span>
                    <span className="ready-tag">已连接</span>
                    <h2>本地题库</h2>
                    <p>{capabilities?.questionBank}</p>
                    <div className="adapter-detail">
                      通过 JSON
                      导入选择题、政治模块题、地理探究题。导入时会校验字段、重复编号、分值和答案。
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
                      选择题按答案核对；主观题按关键词反馈得分点。接口可替换为模型适配器。
                    </div>
                    <div className="notice">
                      尚未接入外部大模型。当前不会上传答案，也不生成新的试题。
                    </div>
                  </section>
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
                  ExamCraft <b>0.1</b>
                </span>
                <span>学会一道题，比刷过一道题更重要。</span>
                <span>数据保存在这台设备</span>
              </footer>
            </>
          )}
        </div>
      </main>
    </div>
  )
}
