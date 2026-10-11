import { subjectLabel, subjects } from '../shared/subjects'
import type { Attempt, StudentQuestion, Subject } from '../shared/types'

export type SubmissionSubject = Subject | 'unknown'
export type SubmissionFilter = SubmissionSubject | 'all'

export interface SubmissionNode {
  /** Detached, frozen copy of a saved submission, never the current editable draft. */
  readonly attempt: Readonly<Attempt>
  readonly subject: SubmissionSubject
  readonly title: string
  readonly snapshotAvailable: boolean
  /** Current-bank context only. Must never be presented as a historical question. */
  readonly currentQuestionTitle?: string
  readonly answerPreview: string
  /** Chronological position among the saved submissions for this subject. */
  readonly ordinal: number
}

export interface SubmissionSubjectTimeline {
  readonly subject: SubmissionSubject
  readonly label: string
  /** Latest first; repeated submissions remain separate nodes. */
  readonly nodes: readonly SubmissionNode[]
}

function freezeCopy<T>(value: T): T {
  function freeze(current: unknown): void {
    if (current && typeof current === 'object') {
      for (const nested of Object.values(current)) freeze(nested)
      Object.freeze(current)
    }
  }
  const copy = structuredClone(value)
  freeze(copy)
  return copy
}

function savedSubject(snapshot?: StudentQuestion): SubmissionSubject {
  return snapshot && subjects.includes(snapshot.subject) ? snapshot.subject : 'unknown'
}

function answerPreview(attempt: Readonly<Attempt>, snapshot?: StudentQuestion): string {
  const { draft } = attempt
  const parts: string[] = []
  if (draft.choiceId) {
    const choice = snapshot?.choices?.find((value) => value.id === draft.choiceId)
    parts.push(`选项 ${draft.choiceId}${choice ? `：${choice.text}` : ''}`)
  }
  if (draft.text.trim()) parts.push(draft.text.trim())
  if (parts.length) return parts.join(' · ')
  if (draft.argument?.roots.length) return '已保存模块作答；打开记录查看提交结构。'
  if (draft.blocks.length) return draft.blocks.map((block) => block.text).join(' · ')
  if (draft.drawing.points.length || draft.drawing.lines.length)
    return '已保存绘图作答；打开记录查看坐标与连线。'
  if (snapshot?.subject === 'math' && draft.math) return '已保存数学作答；打开记录查看函数与绘图。'
  return '本次记录没有文字或选项作答。'
}

/**
 * Only persisted Attempt records belong here. Pending requests, failed grading, editor
 * undo, and argument revisions are not submissions and are never synthesized as nodes.
 * Current-bank questions supply explicitly labelled context for legacy records only.
 */
export function buildSubmissionTimeline(
  attempts: readonly Attempt[],
  questions: readonly StudentQuestion[] = [],
): readonly SubmissionSubjectTimeline[] {
  const currentQuestions = new Map(questions.map((question) => [question.id, question]))
  const buckets = new Map<SubmissionSubject, SubmissionNode[]>(
    [...subjects, 'unknown' as const].map((subject) => [subject, []]),
  )
  // Sort oldest first to assign subject-local ordinals. Equal/unknown timestamps retain
  // original append order; reversing each bucket puts the latest appended record first.
  const chronological = attempts
    .map((attempt, index) => ({ attempt, index, time: Date.parse(attempt.submittedAt) }))
    .sort((a, b) => {
      const aTime = Number.isFinite(a.time) ? a.time : -Infinity
      const bTime = Number.isFinite(b.time) ? b.time : -Infinity
      return aTime === bTime ? a.index - b.index : aTime < bTime ? -1 : 1
    })

  for (const entry of chronological) {
    const attempt = freezeCopy(entry.attempt)
    // A mismatched snapshot is not evidence about this submitted question.
    const snapshot =
      attempt.questionSnapshot?.id === attempt.questionId ? attempt.questionSnapshot : undefined
    const subject = savedSubject(snapshot)
    const bucket = buckets.get(subject)!
    const title = snapshot?.title?.trim()
    bucket.push(
      Object.freeze({
        attempt,
        subject,
        title: title || `题面快照不可用（${attempt.questionId}）`,
        snapshotAvailable: Boolean(snapshot),
        currentQuestionTitle: !snapshot
          ? currentQuestions.get(attempt.questionId)?.title
          : undefined,
        answerPreview: answerPreview(attempt, snapshot),
        ordinal: bucket.length + 1,
      }),
    )
  }

  return Object.freeze(
    [...buckets.entries()].map(([subject, nodes]) =>
      Object.freeze({
        subject,
        label: subject === 'unknown' ? '学科未知' : subjectLabel[subject],
        nodes: Object.freeze(nodes.reverse()),
      }),
    ),
  )
}

export function filterSubmissionTimeline(
  timeline: readonly SubmissionSubjectTimeline[],
  filter: SubmissionFilter,
): readonly SubmissionSubjectTimeline[] {
  return timeline.filter((group) =>
    filter === 'all' ? group.nodes.length > 0 : group.subject === filter,
  )
}

export function submissionTimeLabel(submittedAt: string): string {
  const date = new Date(submittedAt)
  return Number.isFinite(date.getTime())
    ? date.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      })
    : '提交时间不可用'
}
