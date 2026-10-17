import { useEffect, useRef, useState } from 'react'
import type {
  MathChallengeAnswer,
  MathChallengeApi,
  MathChallengeCatalogEntry,
  MathChallengeKind,
  MathChallengeOverview,
  MathChallengeQuestion,
  MathChallengeSession,
} from '../shared/math-challenge'
import './math-challenge.css'

type ChallengeView = 'papers' | 'exam' | 'history' | 'review'
type SaveStatus = 'saved' | 'pending' | 'saving' | 'error'
const sections: { kind: MathChallengeKind; label: string }[] = [
  { kind: 'single', label: '一、单项选择题' },
  { kind: 'multiple', label: '二、多项选择题' },
  { kind: 'fill', label: '三、填空题' },
  { kind: 'solution', label: '四、解答题' },
]
const kindNames: Record<MathChallengeKind, string> = {
  single: '单项选择',
  multiple: '多项选择',
  fill: '填空',
  solution: '解答',
}
const blankAnswer = (): MathChallengeAnswer => ({ choiceIds: [], text: '', flagged: false })
const answered = (answer?: MathChallengeAnswer) =>
  !!answer && (answer.choiceIds.length > 0 || answer.text.trim().length > 0)
const readableError = (error: unknown) =>
  error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
    : '操作失败，请重试。'
const dateText = (value: number) =>
  new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
const clockText = (seconds: number) => {
  const safe = Math.max(0, seconds)
  return `${Math.floor(safe / 3600)
    .toString()
    .padStart(2, '0')}:${Math.floor((safe % 3600) / 60)
    .toString()
    .padStart(2, '0')}:${(safe % 60).toString().padStart(2, '0')}`
}

function SubmitDialog({
  unanswered,
  flagged,
  busy,
  onCancel,
  onSubmit,
}: {
  unanswered: number
  flagged: number
  busy: boolean
  onCancel(): void
  onSubmit(): void
}) {
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => previous?.focus()
  }, [])
  return (
    <div className="challenge-dialog-backdrop">
      <div
        ref={dialog}
        className="challenge-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="challenge-submit-title"
        aria-describedby="challenge-submit-description"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !busy) onCancel()
          if (event.key !== 'Tab') return
          const buttons =
            dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
          if (!buttons?.length) return
          const first = buttons[0]
          const last = buttons[buttons.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }}
      >
        <span className="eyebrow">FINISH CHALLENGE</span>
        <h3 id="challenge-submit-title">确认交卷？</h3>
        <p id="challenge-submit-description">
          {unanswered ? `还有 ${unanswered} 道题未作答。` : '全部题目都已填写。'}
          {flagged > 0 && `其中 ${flagged} 道题标记了稍后检查。`}
          交卷后将锁定答案，显示参考解答与评分要点。
        </p>
        <div className="challenge-actions">
          <button disabled={busy} onClick={onCancel}>
            继续检查
          </button>
          <button className="primary" disabled={busy} onClick={onSubmit}>
            {busy ? '正在交卷…' : '确认交卷'}
          </button>
        </div>
      </div>
    </div>
  )
}

function PaperCard({
  paper,
  index,
  disabled,
  onStart,
}: {
  paper: MathChallengeCatalogEntry
  index: number
  disabled: boolean
  onStart(): void
}) {
  return (
    <article className="challenge-paper-card">
      <div className="challenge-paper-topline">
        <span className="challenge-paper-edition">PAPER {String(index + 1).padStart(2, '0')}</span>
        <span className="challenge-badge">{paper.solutionCount === 5 ? '19 题卷' : '20 题卷'}</span>
      </div>
      <div>
        <h3>{paper.title}</h3>
        <p>{paper.description}</p>
      </div>
      <div className="challenge-paper-structure" aria-label="试卷结构">
        {paper.sections.map((section) => (
          <div key={section.kind}>
            <strong>{section.count}</strong>
            <span>{kindNames[section.kind]}</span>
          </div>
        ))}
      </div>
      <div className="challenge-paper-meta">
        <span>
          {paper.durationMinutes} 分钟 · {paper.totalPoints} 分
        </span>
        <span>{paper.totalQuestions} 题</span>
      </div>
      <p>{paper.scope}</p>
      <button className="primary" disabled={disabled} onClick={onStart}>
        开始挑战 · {paper.sections.map((section) => section.count).join(' + ')}
      </button>
    </article>
  )
}

function AnswerSheet({
  session,
  selectedId,
  disabled,
  onSelect,
}: {
  session: MathChallengeSession
  selectedId: string
  disabled: boolean
  onSelect(id: string): void
}) {
  const completed = session.paper.questions.filter((question) =>
    answered(session.answers[question.id]),
  ).length
  return (
    <nav className="challenge-answer-sheet" aria-label="综合试卷答题卡">
      <h3>答题卡</h3>
      <progress
        className="challenge-sheet-progress"
        max={session.paper.questions.length}
        value={completed}
        aria-label="作答进度"
      />
      <p className="challenge-sheet-status">
        已作答 {completed} / {session.paper.questions.length}
      </p>
      <div className="challenge-answer-sheet-sections">
        {sections.map((section) => (
          <div className="challenge-sheet-section" key={section.kind}>
            <h4>{section.label}</h4>
            <div className="challenge-sheet-grid">
              {session.paper.questions.map(
                (question, index) =>
                  question.kind === section.kind && (
                    <button
                      key={question.id}
                      aria-label={`第 ${index + 1} 题${answered(session.answers[question.id]) ? '，已作答' : '，未作答'}${session.answers[question.id]?.flagged ? '，已标记' : ''}`}
                      aria-current={selectedId === question.id ? 'true' : undefined}
                      data-answered={answered(session.answers[question.id])}
                      data-flagged={session.answers[question.id]?.flagged ?? false}
                      disabled={disabled}
                      onClick={() => onSelect(question.id)}
                    >
                      {index + 1}
                    </button>
                  ),
              )}
            </div>
          </div>
        ))}
      </div>
      <p className="challenge-sheet-legend">着色：已作答 · 圆点：稍后检查</p>
    </nav>
  )
}

function QuestionAnswer({
  question,
  answer,
  disabled,
  onChange,
}: {
  question: MathChallengeQuestion
  answer: MathChallengeAnswer
  disabled: boolean
  onChange(answer: MathChallengeAnswer): void
}) {
  if (question.kind === 'single' || question.kind === 'multiple') {
    return (
      <fieldset
        className="challenge-choices"
        disabled={disabled}
        aria-label={`${kindNames[question.kind]}答案`}
      >
        {question.choices?.map((choice) => (
          <label className="challenge-choice" key={choice.id}>
            <input
              type={question.kind === 'single' ? 'radio' : 'checkbox'}
              name={`challenge-${question.id}`}
              value={choice.id}
              checked={answer.choiceIds.includes(choice.id)}
              onChange={(event) =>
                onChange({
                  ...answer,
                  choiceIds:
                    question.kind === 'single'
                      ? [choice.id]
                      : event.target.checked
                        ? [...answer.choiceIds, choice.id]
                        : answer.choiceIds.filter((id) => id !== choice.id),
                })
              }
            />
            <strong>{choice.id}.</strong>
            <span>{choice.text}</span>
          </label>
        ))}
      </fieldset>
    )
  }
  return (
    <label className="challenge-answer-label">
      {question.kind === 'fill' ? '填写答案（多个空请依次填写）' : '解答过程与结论'}
      {question.kind === 'fill' ? (
        <input
          value={answer.text}
          disabled={disabled}
          maxLength={20000}
          onChange={(event) => onChange({ ...answer, text: event.target.value })}
          placeholder="支持直接输入根号、分数或数学表达式"
        />
      ) : (
        <textarea
          value={answer.text}
          disabled={disabled}
          maxLength={20000}
          onChange={(event) => onChange({ ...answer, text: event.target.value })}
          placeholder="写出关键步骤、计算过程和最终结论…"
        />
      )}
    </label>
  )
}

/** Kept mounted by App, so navigation never stops saving or resets the exam clock. */
export function MathChallenge({
  api,
  visible = true,
}: {
  api: MathChallengeApi
  visible?: boolean
}) {
  const [overview, setOverview] = useState<MathChallengeOverview | null>(null)
  const [active, setActive] = useState<MathChallengeSession | null>(null)
  const [review, setReview] = useState<MathChallengeSession | null>(null)
  const [view, setView] = useState<ChallengeView>('papers')
  const [reviewQuestionId, setReviewQuestionId] = useState('')
  const [gradeInputs, setGradeInputs] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved')
  const [now, setNow] = useState(Date.now())
  const [confirmSubmit, setConfirmSubmit] = useState(false)
  const activeRef = useRef<MathChallengeSession | null>(null)
  const mounted = useRef(true)
  const editVersion = useRef(0)
  const savedVersion = useRef(0)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveQueue = useRef<Promise<void>>(Promise.resolve())
  const expiryRequested = useRef<string | null>(null)
  const reviewId = useRef<string | null>(null)

  function showError(reason: unknown) {
    if (mounted.current) setError(readableError(reason))
  }
  async function refreshOverview() {
    const next = await api.getMathChallenges()
    if (mounted.current) setOverview(next)
  }
  function showReview(session: MathChallengeSession) {
    reviewId.current = session.id
    setReview(session)
    setReviewQuestionId(session.paper.questions[0]?.id ?? '')
    setGradeInputs({})
    setView('review')
  }
  function finish(session: MathChallengeSession) {
    activeRef.current = null
    savedVersion.current = editVersion.current
    if (!mounted.current) return
    setActive(null)
    setError('')
    setConfirmSubmit(false)
    setSaveStatus('saved')
    showReview(session)
    void refreshOverview().catch(showError)
  }
  function installActive(session: MathChallengeSession) {
    activeRef.current = session
    editVersion.current = 0
    savedVersion.current = 0
    expiryRequested.current = null
    setActive(session)
    setSaveStatus('saved')
    setNow(Date.now())
  }

  // Every writer is serialized, and responses update revision metadata without replacing
  // keystrokes made while the request was in flight. submit always drains this queue first.
  function flushSave(): Promise<void> {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = null
    const job = saveQueue.current
      .catch(() => undefined)
      .then(async () => {
        while (activeRef.current && savedVersion.current < editVersion.current) {
          const snapshot = activeRef.current
          const version = editVersion.current
          if (mounted.current) setSaveStatus('saving')
          const response = await api.saveMathChallenge({
            sessionId: snapshot.id,
            expectedRevision: snapshot.revision,
            answers: snapshot.answers,
            activeQuestionId: snapshot.activeQuestionId,
            scratchpad: snapshot.scratchpad,
          })
          if (activeRef.current?.id !== snapshot.id) return
          savedVersion.current = version
          if (response.submittedAt !== null) {
            finish(response)
            return
          }
          const latest = activeRef.current
          const next =
            editVersion.current === version
              ? response
              : {
                  ...response,
                  answers: latest.answers,
                  activeQuestionId: latest.activeQuestionId,
                  scratchpad: latest.scratchpad,
                }
          activeRef.current = next
          if (mounted.current) {
            setActive(next)
            setError('')
          }
        }
        if (mounted.current) setSaveStatus('saved')
      })
    saveQueue.current = job
    return job.catch((reason) => {
      if (mounted.current) setSaveStatus('error')
      showError(reason)
      throw reason
    })
  }
  function editSession(update: (session: MathChallengeSession) => MathChallengeSession) {
    const current = activeRef.current
    if (!current || current.submittedAt !== null || Date.now() >= current.deadlineAt) return
    const next = update(current)
    activeRef.current = next
    editVersion.current += 1
    setActive(next)
    setSaveStatus('pending')
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => void flushSave().catch(() => undefined), 350)
  }

  useEffect(() => {
    mounted.current = true
    let cancelled = false
    api
      .getMathChallenges()
      .then((next) => {
        if (cancelled) return
        setOverview(next)
        if (next.active) installActive(next.active)
      })
      .catch(showError)
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    const flushOnExit = () => {
      void flushSave().catch(() => undefined)
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flushOnExit()
    }
    window.addEventListener('pagehide', flushOnExit)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      mounted.current = false
      window.removeEventListener('pagehide', flushOnExit)
      document.removeEventListener('visibilitychange', onVisibility)
      flushOnExit()
    }
  }, [api])

  useEffect(() => {
    if (!active) return
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [active?.id])

  useEffect(() => {
    if (!visible) void flushSave().catch(() => undefined)
  }, [visible])

  useEffect(() => {
    if (!active || now < active.deadlineAt || expiryRequested.current === active.id) return
    expiryRequested.current = active.id
    setConfirmSubmit(false)
    setBusy(true)
    void (async () => {
      await flushSave()
      const current = activeRef.current
      if (!current) return
      const latest = await api.getMathChallenge(current.id)
      if (latest.submittedAt !== null) finish(latest)
      else
        finish(
          await api.submitMathChallenge({
            sessionId: latest.id,
            expectedRevision: latest.revision,
          }),
        )
    })()
      .catch((reason) => {
        expiryRequested.current = null
        showError(reason)
      })
      .finally(() => {
        if (mounted.current) setBusy(false)
      })
  }, [active?.id, active?.deadlineAt, now])

  async function changeView(next: 'papers' | 'history') {
    setError('')
    try {
      await flushSave()
      setView(next)
      if (next === 'history') await refreshOverview()
    } catch {
      /* The editor stays open so the answer can be saved again. */
    }
  }
  async function start(paperId: string) {
    setBusy(true)
    setError('')
    try {
      const session = await api.startMathChallenge({ paperId })
      if (session.submittedAt !== null) finish(session)
      else {
        installActive(session)
        setView('exam')
      }
    } catch (reason) {
      showError(reason)
    } finally {
      setBusy(false)
    }
  }
  async function retryLoad() {
    setLoading(true)
    setError('')
    try {
      const next = await api.getMathChallenges()
      setOverview(next)
      if (next.active) installActive(next.active)
      setView('papers')
    } catch (reason) {
      showError(reason)
    } finally {
      if (mounted.current) setLoading(false)
    }
  }
  async function submit() {
    setBusy(true)
    setError('')
    try {
      await flushSave()
      const session = activeRef.current
      if (session)
        finish(
          await api.submitMathChallenge({
            sessionId: session.id,
            expectedRevision: session.revision,
          }),
        )
    } catch (reason) {
      setConfirmSubmit(false)
      showError(reason)
    } finally {
      setBusy(false)
    }
  }
  async function openHistory(id: string) {
    setBusy(true)
    setError('')
    try {
      await flushSave()
      const session = await api.getMathChallenge(id)
      if (session.submittedAt !== null) showReview(session)
      else {
        installActive(session)
        setView('exam')
      }
    } catch (reason) {
      showError(reason)
    } finally {
      setBusy(false)
    }
  }
  async function grade(question: MathChallengeQuestion) {
    if (!review) return
    const item = review.review?.items.find((entry) => entry.questionId === question.id)
    const raw =
      gradeInputs[question.id] ?? (item?.earned === null ? '' : String(item?.earned ?? ''))
    const score = Number(raw)
    if (raw.trim() === '' || !Number.isInteger(score) || score < 0 || score > question.points) {
      setError(`请输入 0 到 ${question.points} 之间的整数分数。`)
      return
    }
    setBusy(true)
    setError('')
    try {
      const session = await api.gradeMathChallenge({
        sessionId: review.id,
        expectedRevision: review.revision,
        questionId: question.id,
        score,
      })
      if (reviewId.current === session.id) setReview(session)
      await refreshOverview()
    } catch (reason) {
      showError(reason)
    } finally {
      setBusy(false)
    }
  }

  const displayed = view === 'review' ? review : active
  const selectedId = view === 'review' ? reviewQuestionId : active?.activeQuestionId
  const questions = displayed?.paper.questions ?? []
  const selectedIndex = Math.max(
    0,
    questions.findIndex((question) => question.id === selectedId),
  )
  const selected = questions[selectedIndex]
  const selectedAnswer = displayed?.answers[selected?.id ?? ''] ?? blankAnswer()
  const reviewItem = review?.review?.items.find((item) => item.questionId === selected?.id)
  const completed =
    active?.paper.questions.filter((question) => answered(active.answers[question.id])).length ?? 0
  const remaining = active ? Math.max(0, Math.ceil((active.deadlineAt - now) / 1000)) : 0
  const isReview = view === 'review'
  const answerDisabled = busy || remaining <= 0
  const saveLabels: Record<SaveStatus, string> = {
    saved: '已自动保存到本机',
    pending: '等待保存…',
    saving: '正在保存…',
    error: '保存失败，答案仍保留在页面中',
  }
  function selectQuestion(id: string) {
    if (busy) return
    if (isReview) setReviewQuestionId(id)
    else {
      editSession((session) => ({ ...session, activeQuestionId: id }))
      void flushSave().catch(() => undefined)
    }
  }

  return (
    <section className="math-challenge" aria-label="数学挑战：综合试卷">
      <header className="challenge-header">
        <div>
          <span className="eyebrow">MATH CHALLENGE</span>
          <h2>
            {view === 'exam'
              ? '沉下心，完成一整卷。'
              : view === 'review'
                ? '回看思路，找到下一次的突破。'
                : '把零散知识，连成一张试卷。'}
          </h2>
          <p>高考式题型结构 · 综合调用已学知识 · 交卷后集中复盘</p>
        </div>
        <div className="challenge-tabs" aria-label="挑战页面">
          <button
            aria-pressed={view === 'papers' || view === 'exam'}
            disabled={busy}
            onClick={() => void changeView('papers')}
          >
            综合试卷
          </button>
          <button
            aria-pressed={view === 'history' || view === 'review'}
            disabled={busy}
            onClick={() => void changeView('history')}
          >
            挑战记录{overview?.history.length ? ` · ${overview.history.length}` : ''}
          </button>
        </div>
      </header>
      {error && (
        <div className="challenge-notice" role="alert">
          {error}{' '}
          {saveStatus === 'error' && (
            <button onClick={() => void flushSave().catch(() => undefined)}>重试保存</button>
          )}
        </div>
      )}
      {loading && (
        <div className="challenge-empty" role="status">
          正在打开数学挑战…
        </div>
      )}
      {!loading && !overview && (
        <div className="challenge-empty">
          <h3>暂时无法读取试卷</h3>
          <p>未开始计时，可以重新加载试卷列表。</p>
          <button onClick={() => void retryLoad()}>重新加载</button>
        </div>
      )}
      {!loading && overview && view === 'papers' && (
        <>
          {active && (
            <div className="challenge-resume challenge-heading-row">
              <div>
                <h3>你有一份进行中的试卷</h3>
                <p className="challenge-muted">
                  {active.paper.title} · 已作答 {completed} / {active.paper.questions.length} · 剩余{' '}
                  {clockText(remaining)}
                </p>
              </div>
              <button className="primary" disabled={busy} onClick={() => setView('exam')}>
                继续作答
              </button>
            </div>
          )}
          <div className="challenge-paper-grid">
            {overview.papers.map((paper, index) => (
              <PaperCard
                key={paper.id}
                paper={paper}
                index={index}
                disabled={busy || !!active}
                onStart={() => void start(paper.id)}
              />
            ))}
          </div>
          <p className="challenge-footnote">
            首批为当前学段的原创综合卷，采用高考式结构；具体知识范围见各卷说明。从开始挑战时计时，切换页面或关闭应用不会暂停；到时自动交卷。选择题自动计分，填空与解答题交卷后对照要点自评。
          </p>
        </>
      )}
      {!loading &&
        view === 'history' &&
        (overview?.history.length ? (
          <div className="challenge-history-list">
            {overview.history.map((item) => (
              <article className="challenge-history-row" key={item.id}>
                <div>
                  <h3>{item.paperTitle}</h3>
                  <p>
                    {dateText(item.submittedAt)} ·{' '}
                    {item.submitReason === 'timeout' ? '到时交卷' : '主动交卷'}
                  </p>
                </div>
                <div>
                  <strong>
                    {item.totalScore === null
                      ? `客观题 ${item.objectiveScore} 分`
                      : `${item.totalScore} 分`}
                  </strong>
                  <p>
                    {item.pendingManualCount ? `${item.pendingManualCount} 题待自评` : '评分已完成'}
                  </p>
                </div>
                <button disabled={busy} onClick={() => void openHistory(item.id)}>
                  查看复盘
                </button>
              </article>
            ))}
          </div>
        ) : (
          <div className="challenge-empty">
            <h3>第一份综合卷，等你开始。</h3>
            <p>交卷后，试题、答案与评分会保存在这里。</p>
            <button onClick={() => setView('papers')}>选择试卷</button>
          </div>
        ))}
      {(view === 'exam' || isReview) && displayed && selected && (
        <>
          {isReview && review?.review ? (
            <div className="challenge-review-summary">
              <div className="challenge-score-row">
                <div>
                  <div className="challenge-score">
                    {review.review.totalScore ?? review.review.objectiveScore}
                    <small>
                      {' '}
                      /{' '}
                      {review.review.totalScore === null
                        ? review.review.objectiveMaxScore
                        : review.review.objectiveMaxScore + review.review.manualMaxScore}
                    </small>
                  </div>
                  <p className="challenge-score-caption">
                    {review.review.totalScore === null
                      ? '选择题得分 · 总分等待自评'
                      : '本次综合试卷总分'}
                  </p>
                </div>
                <div className="challenge-review-stats">
                  <span>
                    <strong>{review.review.pendingManualCount}</strong>题待自评
                  </span>
                  <span>
                    <strong>{review.review.manualScore}</strong>自评已得分
                  </span>
                </div>
                <button disabled={busy} onClick={() => void changeView('history')}>
                  返回挑战记录
                </button>
              </div>
              <p className="challenge-footnote">
                {displayed.paper.title} ·{' '}
                {displayed.submitReason === 'timeout' ? '到时自动交卷' : '已交卷'} ·{' '}
                {dateText(displayed.submittedAt!)}。填空与解答题请结合完整过程按要点评分。
              </p>
            </div>
          ) : (
            <div className="challenge-exam-bar">
              <div>
                <h3>{displayed.paper.title}</h3>
                <span className="challenge-save-status" role="status">
                  {saveLabels[saveStatus]}
                </span>
              </div>
              <div
                className="challenge-timer"
                data-urgent={remaining <= 600}
                role="timer"
                aria-label={`剩余时间 ${clockText(remaining)}`}
              >
                <small>剩余时间</small>
                {clockText(remaining)}
              </div>
              <button
                className="primary"
                disabled={busy || remaining <= 0}
                onClick={() => setConfirmSubmit(true)}
              >
                提交试卷
              </button>
            </div>
          )}
          <div className="challenge-exam-layout">
            <AnswerSheet
              session={displayed}
              selectedId={selected.id}
              disabled={busy}
              onSelect={selectQuestion}
            />
            <div>
              <article className="challenge-question" aria-label={`第 ${selectedIndex + 1} 题`}>
                <div className="challenge-question-heading">
                  <div>
                    <span className="challenge-question-type">
                      {kindNames[selected.kind]} · {selected.points} 分
                    </span>
                    <h3>第 {selectedIndex + 1} 题</h3>
                  </div>
                  {!isReview && (
                    <button
                      className="challenge-flag"
                      aria-pressed={selectedAnswer.flagged}
                      disabled={answerDisabled}
                      onClick={() =>
                        editSession((session) => ({
                          ...session,
                          answers: {
                            ...session.answers,
                            [selected.id]: { ...selectedAnswer, flagged: !selectedAnswer.flagged },
                          },
                        }))
                      }
                    >
                      {selectedAnswer.flagged ? '已标记检查' : '标记检查'}
                    </button>
                  )}
                  {isReview && reviewItem && (
                    <span
                      className="challenge-result-badge"
                      data-pending={reviewItem.earned === null}
                    >
                      {reviewItem.earned === null
                        ? '待自评'
                        : `${reviewItem.earned} / ${reviewItem.points} 分`}
                    </span>
                  )}
                </div>
                <p className="challenge-question-prompt">{selected.prompt}</p>
                {selected.kind === 'multiple' && (
                  <p className="challenge-question-note">
                    多项选择：全部选对得 6 分，少选且无错选得 3 分，有错选得 0 分（本地练习规则）。
                  </p>
                )}
                {isReview ? (
                  <>
                    {selected.choices?.map((choice) => (
                      <p className="challenge-question-note" key={choice.id}>
                        {choice.id}. {choice.text}
                      </p>
                    ))}
                    <div className="challenge-review-answer">
                      <h4>你的作答</h4>
                      <p>
                        {selectedAnswer.choiceIds.join('、') || selectedAnswer.text || '未作答'}
                      </p>
                    </div>
                    {reviewItem && (
                      <>
                        <div className="challenge-review-answer">
                          <h4>参考答案</h4>
                          <p>{reviewItem.answer}</p>
                        </div>
                        <div className="challenge-review-answer">
                          <h4>解析与关键步骤</h4>
                          <p>{reviewItem.explanation}</p>
                        </div>
                        {reviewItem.rubric.length > 0 && (
                          <div className="challenge-review-answer">
                            <h4>评分要点</h4>
                            {reviewItem.rubric.map((part, index) => (
                              <p key={index}>
                                {part.label}（{part.points} 分）
                              </p>
                            ))}
                          </div>
                        )}
                        {(selected.kind === 'fill' || selected.kind === 'solution') &&
                          !answered(selectedAnswer) && (
                            <p className="challenge-question-note">
                              未填写答案，已自动计为 0 分；若有纸面作答，可按要点更正自评分。
                            </p>
                          )}
                        {(selected.kind === 'fill' || selected.kind === 'solution') && (
                          <form
                            className="challenge-grade"
                            onSubmit={(event) => {
                              event.preventDefault()
                              void grade(selected)
                            }}
                          >
                            <label htmlFor={`challenge-grade-${selected.id}`}>本题自评分</label>
                            <input
                              id={`challenge-grade-${selected.id}`}
                              type="number"
                              min="0"
                              max={selected.points}
                              step="1"
                              disabled={busy}
                              value={
                                gradeInputs[selected.id] ??
                                (reviewItem.earned === null ? '' : String(reviewItem.earned))
                              }
                              onChange={(event) =>
                                setGradeInputs((current) => ({
                                  ...current,
                                  [selected.id]: event.target.value,
                                }))
                              }
                            />
                            <span>/ {selected.points} 分</span>
                            <button disabled={busy} type="submit">
                              保存自评
                            </button>
                          </form>
                        )}
                      </>
                    )}
                  </>
                ) : (
                  <QuestionAnswer
                    key={selected.id}
                    question={selected}
                    answer={selectedAnswer}
                    disabled={answerDisabled}
                    onChange={(answer) =>
                      editSession((session) => ({
                        ...session,
                        answers: { ...session.answers, [selected.id]: answer },
                      }))
                    }
                  />
                )}
                <div className="challenge-pager">
                  <button
                    disabled={selectedIndex === 0 || busy}
                    onClick={() => selectQuestion(questions[selectedIndex - 1].id)}
                  >
                    ← 上一题
                  </button>
                  <span>
                    {selectedIndex + 1} / {questions.length}
                  </span>
                  <button
                    disabled={selectedIndex === questions.length - 1 || busy}
                    onClick={() => selectQuestion(questions[selectedIndex + 1].id)}
                  >
                    下一题 →
                  </button>
                </div>
              </article>
              {!isReview && (
                <details className="challenge-scratchpad">
                  <summary>整卷草稿 · 自动保存</summary>
                  <label className="challenge-answer-label">
                    草稿不会计入答案
                    <textarea
                      value={active?.scratchpad ?? ''}
                      maxLength={40000}
                      disabled={answerDisabled}
                      onChange={(event) =>
                        editSession((session) => ({ ...session, scratchpad: event.target.value }))
                      }
                      placeholder="暂存公式、计算与待检查的问题…"
                    />
                  </label>
                </details>
              )}
            </div>
          </div>
        </>
      )}
      {confirmSubmit && active && (
        <SubmitDialog
          unanswered={active.paper.questions.length - completed}
          flagged={Object.values(active.answers).filter((answer) => answer.flagged).length}
          busy={busy}
          onCancel={() => setConfirmSubmit(false)}
          onSubmit={() => void submit()}
        />
      )}
    </section>
  )
}
