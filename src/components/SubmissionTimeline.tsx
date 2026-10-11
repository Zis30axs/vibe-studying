import { AssistanceBadge } from './LearningGraph'
import { useEffect, useId, useMemo, useState } from 'react'
import type { Attempt, StudentQuestion } from '../shared/types'
import {
  buildSubmissionTimeline,
  filterSubmissionTimeline,
  submissionTimeLabel,
  type SubmissionFilter,
  type SubmissionNode,
} from '../domain/submission-timeline'
import './submission-timeline.css'

export interface SubmissionTimelineProps {
  attempts: readonly Attempt[]
  questions?: readonly StudentQuestion[]
  selectedId?: string
  onSelectAttempt: (id: string) => void
}

/** A read-only selection button. Opening a saved submission never restores a draft. */
export function SubmissionTimelineEntry({
  node,
  selected,
  onSelectAttempt,
}: {
  node: SubmissionNode
  selected: boolean
  onSelectAttempt: (id: string) => void
}) {
  const { attempt } = node
  const time = submissionTimeLabel(attempt.submittedAt)
  return (
    <button
      type="button"
      className={`submission-node history-item${selected ? ' is-selected selected' : ''}`}
      data-attempt-id={attempt.id}
      aria-pressed={selected}
      data-assistance={attempt.assistance?.status ?? 'unknown'}
      aria-label={`${node.title}，${time}，${attempt.score}/${attempt.maxScore} 分，查看提交记录`}
      onClick={() => onSelectAttempt(attempt.id)}
    >
      <span className="submission-node-top">
        <strong>{node.title}</strong>
        <span className="submission-score">
          <b>{attempt.score}</b> / {attempt.maxScore}
        </span>
      </span>
      <span className="submission-node-meta">
        <span>
          {node.subject === 'unknown' ? '未知学科记录' : '学科提交'} #{node.ordinal}
        </span>
        <time
          dateTime={
            Number.isFinite(Date.parse(attempt.submittedAt)) ? attempt.submittedAt : undefined
          }
        >
          {time}
        </time>
      </span>
      <AssistanceBadge status={attempt.assistance?.status} />
      <span className="submission-answer-preview">{node.answerPreview}</span>
      <span className="submission-feedback-preview">
        反馈：{attempt.feedback || '未保存文字反馈'}
      </span>
      <span className="submission-node-footer">
        <span>{attempt.reviewer}</span>
        <span
          className={
            node.snapshotAvailable ? 'submission-snapshot-label' : 'submission-legacy-label'
          }
        >
          {node.snapshotAvailable ? '提交时快照' : '旧记录 · 题面快照缺失'}
        </span>
      </span>
      {node.currentQuestionTitle && (
        <span className="submission-current-context">
          当前题库标题（非提交快照）：{node.currentQuestionTitle}
        </span>
      )}
    </button>
  )
}

export function SubmissionTimeline({
  attempts,
  questions,
  selectedId,
  onSelectAttempt,
}: SubmissionTimelineProps) {
  const headingId = useId()
  const [filter, setFilter] = useState<SubmissionFilter>('all')
  const timeline = useMemo(
    () => buildSubmissionTimeline(attempts, questions),
    [attempts, questions],
  )
  const selectedSubject = timeline.find((group) =>
    group.nodes.some((node) => node.attempt.id === selectedId),
  )?.subject
  // An external selection (for example from the activity calendar) must not remain hidden.
  useEffect(() => {
    if (selectedSubject) setFilter((current) => (current === 'all' ? current : selectedSubject))
  }, [selectedId, selectedSubject])
  const visible = filterSubmissionTimeline(timeline, filter)
  const visibleCount = visible.reduce((count, group) => count + group.nodes.length, 0)

  return (
    <section
      className="submission-timeline"
      aria-labelledby={headingId}
      data-testid="submission-timeline"
    >
      <div className="submission-timeline-heading">
        <div>
          <span className="submission-kicker">SAVED SUBMISSIONS</span>
          <h2 id={headingId}>学科提交时间线</h2>
        </div>
        <span className="submission-total">{attempts.length} 次</span>
      </div>
      <p className="submission-timeline-hint">
        每科独立排列，最新在前。保留每次提交的答案、得分与反馈。
      </p>
      <div className="submission-filters" role="group" aria-label="按学科筛选提交记录">
        <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
          全部 <span>{attempts.length}</span>
        </button>
        {timeline
          .filter((group) => group.subject !== 'unknown' || group.nodes.length > 0)
          .map((group) => (
            <button
              type="button"
              key={group.subject}
              aria-pressed={filter === group.subject}
              onClick={() => setFilter(group.subject)}
            >
              {group.label} <span>{group.nodes.length}</span>
            </button>
          ))}
      </div>
      <p className="submission-count" role="status" aria-live="polite" aria-atomic="true">
        {filter === 'all' ? '全部学科' : timeline.find((group) => group.subject === filter)?.label}
        {' · '}
        {visibleCount} 次已保存提交
      </p>
      <div className="submission-groups">
        {attempts.length === 0 ? (
          <div className="submission-empty">
            <strong>还没有提交记录</strong>
            <p>成功提交并保存后，会在对应学科留下一个节点。</p>
          </div>
        ) : (
          visible.map((group) => (
            <section
              className="submission-subject"
              key={group.subject}
              aria-label={`${group.label}提交时间线`}
            >
              <h3>
                <span>{group.label}</span>
                <small>{group.nodes.length} 次</small>
              </h3>
              {group.subject === 'unknown' && (
                <p className="submission-unknown-note">
                  旧记录没有可确认的提交时学科，未按当前题库推测归类。
                </p>
              )}
              {group.nodes.length === 0 ? (
                <p className="submission-empty">该学科还没有已保存的提交。</p>
              ) : (
                <ol aria-label={`${group.label}提交记录，最新在前`}>
                  {group.nodes.map((node) => (
                    <li key={node.attempt.id}>
                      <SubmissionTimelineEntry
                        node={node}
                        selected={node.attempt.id === selectedId}
                        onSelectAttempt={onSelectAttempt}
                      />
                    </li>
                  ))}
                </ol>
              )}
            </section>
          ))
        )}
      </div>
      <p className="submission-timeline-footnote">
        点击仅回看，不覆盖当前草稿。草稿、失败请求和模块编辑版本不计入提交。
      </p>
    </section>
  )
}
