import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { ACTIVITY_WEEKS, buildActivityDays } from '../domain/activity'
import { subjectLabel } from '../shared/subjects'
import type { Attempt, Question } from '../shared/types'
import './activity.css'

interface Props {
  attempts: Attempt[]
  questions: Question[]
  onSelectAttempt: (id: string) => void
}

const dateLabel = (date: Date) =>
  date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  })

export function ActivityHeatmap({ attempts, questions, onSelectAttempt }: Props) {
  const headingId = useId()
  const hintId = useId()
  const detailsId = useId()
  const [clock, refreshClock] = useState(0)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [focusedKey, setFocusedKey] = useState<string | null>(null)
  const dayButtons = useRef(new Map<string, HTMLButtonElement>())
  const scrollContainer = useRef<HTMLDivElement>(null)
  // Read time again on history updates: a newly saved attempt must count even
  // when the component was already mounted before the submission took place.
  const days = useMemo(() => buildActivityDays(attempts, new Date()), [attempts, clock])
  const questionsById = useMemo(
    () => new Map(questions.map((question) => [question.id, question])),
    [questions],
  )

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    function refresh() {
      clearTimeout(timer)
      refreshClock((value) => value + 1)
      const now = new Date()
      const midnight = new Date(now)
      midnight.setHours(24, 0, 0, 0)
      // Also notice clock/time-zone changes while the window stays in front.
      timer = setTimeout(refresh, Math.min(60_000, midnight.getTime() - now.getTime() + 50))
    }
    function onVisible() {
      if (document.visibilityState === 'visible') refresh()
    }
    refresh()
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  const today = days.at(-1)
  const selected = days.find((day) => day.key === selectedKey) ?? today
  const tabKey = days.some((day) => day.key === focusedKey) ? focusedKey : today?.key
  const total = days.reduce((sum, day) => sum + day.count, 0)
  const weeks = Array.from({ length: Math.ceil(days.length / 7) }, (_, index) =>
    days.slice(index * 7, index * 7 + 7),
  )

  useEffect(() => {
    // Open narrow screens at the most recent dates without moving the page.
    const container = scrollContainer.current
    if (container) container.scrollLeft = container.scrollWidth
  }, [today?.key])

  function moveFocus(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number
    switch (event.key) {
      case 'ArrowUp':
        next = index - 1
        break
      case 'ArrowDown':
        next = index + 1
        break
      case 'ArrowLeft':
        next = index - 7
        break
      case 'ArrowRight':
        next = index + 7
        break
      case 'Home':
        next = event.ctrlKey ? 0 : index - (index % 7)
        break
      case 'End':
        next = event.ctrlKey ? days.length - 1 : index - (index % 7) + 6
        break
      default:
        return
    }
    event.preventDefault()
    const target = days[Math.max(0, Math.min(next, days.length - 1))]
    if (target) dayButtons.current.get(target.key)?.focus()
  }

  return (
    <section
      className="activity-heatmap"
      data-testid="activity-heatmap"
      aria-labelledby={headingId}
    >
      <div className="activity-heading">
        <div>
          <h2 id={headingId}>学习足迹</h2>
          <p>
            最近 {ACTIVITY_WEEKS} 周 · {total} 次提交
          </p>
        </div>
        <span className="activity-timezone">按本地日期统计</span>
      </div>
      <p className="activity-hint" id={hintId}>
        每格代表一天，绿色越深表示提交越多。选择日期可回看记录。
        <span className="activity-sr-only">方向键移动日期，Enter 或空格查看当天记录。</span>
      </p>
      <div className="activity-scroll" ref={scrollContainer}>
        <div
          className="activity-chart"
          role="group"
          aria-label="每日提交次数"
          aria-describedby={hintId}
        >
          <div className="activity-weekdays" aria-hidden="true">
            <span />
            {['日', '一', '二', '三', '四', '五', '六'].map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>
          {weeks.map((week, weekIndex) => {
            const monthDay = week.find((day) => day.date.getDate() === 1)
            const month = monthDay ?? (weekIndex === 0 ? week[0] : undefined)
            return (
              <div className="activity-week" key={week[0].key}>
                <span className="activity-month" aria-hidden="true">
                  {month ? `${month.date.getMonth() + 1}月` : ''}
                </span>
                <div className="activity-week-days">
                  {week.map((day, weekday) => {
                    const label = `${dateLabel(day.date)}，${day.count} 次提交${day.key === today?.key ? '，今天' : ''}`
                    return (
                      <button
                        type="button"
                        className="activity-day"
                        key={day.key}
                        ref={(element) => {
                          if (element) dayButtons.current.set(day.key, element)
                          else dayButtons.current.delete(day.key)
                        }}
                        data-testid={`activity-day-${day.key}`}
                        data-count={day.count}
                        data-level={day.level}
                        aria-label={label}
                        title={label}
                        aria-pressed={selected?.key === day.key}
                        aria-controls={detailsId}
                        tabIndex={tabKey === day.key ? 0 : -1}
                        onFocus={() => setFocusedKey(day.key)}
                        onKeyDown={(event) => moveFocus(event, weekIndex * 7 + weekday)}
                        onClick={() => setSelectedKey(day.key)}
                      />
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      </div>
      <div className="activity-footer">
        <p>
          {total === 0
            ? '这段时间暂无提交记录。草稿不会计入。'
            : '仅统计已保存的提交；同一天的多次提交分别计数。'}
        </p>
        <div className="activity-legend" role="group" aria-label="颜色图例：每天的提交次数">
          {['0', '1', '2–3', '4–6', '7+'].map((label, level) => (
            <span key={level} className="activity-legend-item" aria-label={`${label} 次提交`}>
              <span className="activity-swatch" data-level={level} aria-hidden="true" />
              <span aria-hidden="true">{label}</span>
            </span>
          ))}
        </div>
      </div>
      {selected && (
        <div className="activity-details" id={detailsId} data-testid="activity-day-details">
          <h3 aria-live="polite" aria-atomic="true">
            {dateLabel(selected.date)} · {selected.count} 次提交
          </h3>
          {selected.count === 0 ? (
            <p className="activity-empty">当天没有提交记录。</p>
          ) : (
            <ul className="activity-records">
              {selected.attempts.map((attempt) => {
                const question = questionsById.get(attempt.questionId)
                return (
                  <li key={attempt.id}>
                    <button
                      type="button"
                      data-testid={`activity-attempt-${attempt.id}`}
                      onClick={() => onSelectAttempt(attempt.id)}
                    >
                      <span className="activity-record-title">
                        {question?.title ?? `未找到题目（${attempt.questionId}）`}
                      </span>
                      <span className="activity-record-meta">
                        {new Date(attempt.submittedAt).toLocaleTimeString('zh-CN', {
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                          hour12: false,
                        })}
                        {' · '}
                        {question ? subjectLabel[question.subject] : '题目已不在当前题库'}
                        {' · '}
                        {attempt.score}/{attempt.maxScore} 分 · 查看记录
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
