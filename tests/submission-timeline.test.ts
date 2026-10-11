import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SubmissionTimeline, SubmissionTimelineEntry } from '../src/components/SubmissionTimeline'
import {
  buildSubmissionTimeline,
  filterSubmissionTimeline,
  submissionTimeLabel,
} from '../src/domain/submission-timeline'
import { LocalQuestionBank } from '../src/adapters/local-question-bank'
import { LocalRuleAgent } from '../src/adapters/local-rule-agent'
import { StudyService } from '../src/domain/study-service'
import { subjects } from '../src/shared/subjects'
import { emptyDraft, type Attempt, type StudentQuestion, type Subject } from '../src/shared/types'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

function question(subject: Subject = 'math'): StudentQuestion {
  return {
    id: `question-${subject}`,
    subject,
    kind: subject,
    title: `${subject}提交时题目`,
    prompt: '提交时题干',
    source: '测试',
    tags: [],
    maxScore: 5,
    choices: [{ id: 'A', text: '提交时的选项' }],
  }
}

function attempt(id: string, subject: Subject = 'math', at = '2026-10-10T12:00:00Z'): Attempt {
  const snapshot = question(subject)
  return {
    id,
    questionId: snapshot.id,
    questionSnapshot: snapshot,
    submittedAt: at,
    draft: { ...emptyDraft(), text: '提交时的答案', choiceId: 'A' },
    score: 3,
    maxScore: 5,
    feedback: '提交时的反馈',
    explanation: '提交时的解析',
    rubric: [{ id: 'r1', label: '论证', earned: 3, possible: 5, feedback: '提交时的评分项' }],
    reviewer: '本地规则',
  }
}

describe('saved submission timeline projection', () => {
  it('keeps six independent subjects and preserves repeated and zero-score saved attempts', () => {
    const initial = subjects.map((subject) => attempt(`first-${subject}`, subject))
    const repeated = attempt('repeat-math', 'math', '2026-10-11T12:00:00Z')
    repeated.score = 0
    const timeline = buildSubmissionTimeline([repeated, ...initial])
    for (const subject of subjects) {
      const group = timeline.find((value) => value.subject === subject)!
      expect(group.nodes.map((node) => node.attempt.id)).toEqual(
        subject === 'math' ? ['repeat-math', 'first-math'] : [`first-${subject}`],
      )
      expect(group.nodes.every((node) => node.subject === subject)).toBe(true)
    }
    const math = timeline.find((group) => group.subject === 'math')!
    expect(math.nodes.map((node) => node.ordinal)).toEqual([2, 1])
    expect(math.nodes[0].attempt.score).toBe(0)
    expect(math.nodes[0].attempt.questionId).toBe(math.nodes[1].attempt.questionId)
    expect(math.nodes[0]).not.toHaveProperty('parentId')
    expect(math.nodes[0]).not.toHaveProperty('children')
  })

  it('uses detached frozen historical evidence instead of later question, answer, or grade edits', () => {
    const saved = attempt('saved')
    const editedQuestion = { ...question(), title: '当前已改题目', subject: 'english' as const }
    editedQuestion.choices = [{ id: 'A', text: '当前已改选项' }]
    const before = structuredClone(saved)
    const timeline = buildSubmissionTimeline([saved], [editedQuestion])
    const node = timeline.find((group) => group.subject === 'math')!.nodes[0]
    expect(saved).toEqual(before)
    expect(node.title).toBe('math提交时题目')
    expect(node.answerPreview).toContain('提交时的选项')
    expect(node.answerPreview).not.toContain('当前已改选项')
    expect(node.currentQuestionTitle).toBeUndefined()
    saved.draft.text = '后续改稿'
    saved.score = 5
    saved.feedback = '后续反馈'
    saved.rubric[0].feedback = '后续评分项'
    saved.questionSnapshot!.title = '后续题目'
    expect(node.attempt).toEqual(before)
    expect(Object.isFrozen(node.attempt)).toBe(true)
    expect(Object.isFrozen(node.attempt.draft)).toBe(true)
    expect(Object.isFrozen(node.attempt.rubric[0])).toBe(true)
    expect(Object.isFrozen(node.attempt.questionSnapshot)).toBe(true)
    expect(Object.isFrozen(node)).toBe(true)
  })

  it('never infers a legacy record subject or question snapshot from the current bank', () => {
    const legacy = attempt('legacy')
    delete legacy.questionSnapshot
    const current = { ...question(), title: '当前题库新标题', subject: 'english' as const }
    const timeline = buildSubmissionTimeline([legacy], [current])
    const unknown = timeline.find((group) => group.subject === 'unknown')!.nodes[0]
    expect(unknown.subject).toBe('unknown')
    expect(unknown.snapshotAvailable).toBe(false)
    expect(unknown.title).toContain('题面快照不可用')
    expect(unknown.title).not.toContain(current.title)
    expect(unknown.currentQuestionTitle).toBe(current.title)
    expect(unknown.answerPreview).toContain('选项 A')
    expect(unknown.answerPreview).not.toContain('提交时的选项')
    expect(timeline.find((group) => group.subject === 'english')!.nodes).toHaveLength(0)
    const noBank = buildSubmissionTimeline([legacy]).find((group) => group.subject === 'unknown')!
    expect(noBank.nodes[0].currentQuestionTitle).toBeUndefined()
    expect(noBank.nodes[0].attempt.draft.text).toBe('提交时的答案')
  })

  it('keeps missing subject metadata unknown and refuses mismatched snapshot identity', () => {
    const missingSubject = attempt('missing-subject')
    delete (missingSubject.questionSnapshot as Partial<StudentQuestion>).subject
    const mismatched = attempt('mismatched')
    mismatched.questionSnapshot!.id = 'another-question'
    const unknown = buildSubmissionTimeline([missingSubject, mismatched], [question()]).find(
      (group) => group.subject === 'unknown',
    )!
    expect(unknown.nodes).toHaveLength(2)
    expect(unknown.nodes.find((node) => node.attempt.id === 'missing-subject')!.title).toBe(
      'math提交时题目',
    )
    expect(unknown.nodes.find((node) => node.attempt.id === 'mismatched')!.snapshotAvailable).toBe(
      false,
    )
  })

  it('orders by submitted time with stable append-order ties without dropping bad timestamps', () => {
    const source = [
      attempt('same-first'),
      attempt('earliest', 'math', '2026-10-09T12:00:00Z'),
      attempt('bad-first', 'math', 'invalid'),
      attempt('same-last'),
      attempt('bad-last', 'math', ''),
    ]
    const ids = source.map((value) => value.id)
    const math = buildSubmissionTimeline(source).find((group) => group.subject === 'math')!
    expect(math.nodes.map((node) => node.attempt.id)).toEqual([
      'same-last',
      'same-first',
      'earliest',
      'bad-last',
      'bad-first',
    ])
    expect(source.map((value) => value.id)).toEqual(ids)
    expect(submissionTimeLabel('invalid')).toBe('提交时间不可用')
    expect(submissionTimeLabel('2026-10-10T12:00:00Z')).not.toContain('Invalid')
  })

  it('filters empty and populated subjects without changing or deduplicating the timeline', () => {
    const legacy = attempt('legacy')
    delete legacy.questionSnapshot
    const timeline = buildSubmissionTimeline([attempt('one'), attempt('two'), legacy])
    expect(filterSubmissionTimeline(timeline, 'all').map((group) => group.subject)).toEqual([
      'math',
      'unknown',
    ])
    expect(filterSubmissionTimeline(timeline, 'math')[0].nodes).toHaveLength(2)
    expect(filterSubmissionTimeline(timeline, 'english')[0].nodes).toHaveLength(0)
    expect(filterSubmissionTimeline(timeline, 'unknown')[0].nodes[0].attempt.id).toBe('legacy')
    expect(buildSubmissionTimeline([])).toHaveLength(7)
    expect(filterSubmissionTimeline(buildSubmissionTimeline([]), 'all')).toEqual([])
  })

  it('previews saved non-text module and drawing submissions without sourcing current drafts', () => {
    const module = attempt('module', 'politics')
    module.draft = {
      ...emptyDraft(),
      argument: { version: 1, roots: [{ id: 'a', kind: 'analysis', text: '论证', children: [] }] },
    }
    const drawing = attempt('drawing', 'geography')
    drawing.draft = emptyDraft()
    drawing.draft.drawing.points.push({ id: 'p', x: 1, y: 2, label: 'A' })
    const timeline = buildSubmissionTimeline([module, drawing])
    expect(
      timeline.find((group) => group.subject === 'politics')!.nodes[0].answerPreview,
    ).toContain('模块作答')
    expect(
      timeline.find((group) => group.subject === 'geography')!.nodes[0].answerPreview,
    ).toContain('绘图作答')
  })
})

describe('submission timeline rendering and selection', () => {
  it('renders real saved nodes, labelled subject filters and frozen answer/feedback previews', () => {
    const saved = attempt('selected')
    const onSelectAttempt = vi.fn()
    const html = renderToStaticMarkup(
      createElement(SubmissionTimeline, {
        attempts: [saved, attempt('second', 'history')],
        questions: [{ ...question(), title: '当前题面不能冒充快照' }],
        selectedId: saved.id,
        onSelectAttempt,
      }),
    )
    expect(html).toContain('学科提交时间线')
    expect(html).toContain('aria-label="按学科筛选提交记录"')
    expect(html).toContain('aria-label="数学提交记录，最新在前"')
    expect(html).toContain('aria-label="历史提交记录，最新在前"')
    expect(html).toContain('class="submission-node history-item is-selected selected"')
    expect(html).toContain('data-attempt-id="selected" aria-pressed="true"')
    expect(html.match(/data-attempt-id=/g)).toHaveLength(2)
    expect(html).toContain('提交时的答案')
    expect(html).toContain('提交时的反馈')
    expect(html).toContain('提交时的选项')
    expect(html).not.toContain('当前题面不能冒充快照')
    expect(html).toContain('点击仅回看，不覆盖当前草稿')
    expect(html).not.toContain('恢复此版本')
    expect(onSelectAttempt).not.toHaveBeenCalled()
  })

  it('explicitly labels legacy metadata gaps and current-only question context', () => {
    const legacy = attempt('legacy')
    delete legacy.questionSnapshot
    const html = renderToStaticMarkup(
      createElement(SubmissionTimeline, {
        attempts: [legacy],
        questions: [question()],
        onSelectAttempt: () => {},
      }),
    )
    expect(html).toContain('学科未知')
    expect(html).toContain('题面快照缺失')
    expect(html).toContain('当前题库标题（非提交快照）')
    expect(html).toContain('未按当前题库推测归类')
    expect(html).toContain('提交时的答案')
    expect(html).not.toContain('aria-label="数学提交时间线"')
  })

  it('selects only the exact saved attempt ID and never mutates a draft, even on repeated clicks', () => {
    const saved = attempt('exact-id')
    const before = structuredClone(saved)
    const node = buildSubmissionTimeline([saved]).find((group) => group.subject === 'math')!
      .nodes[0]
    const onSelectAttempt = vi.fn()
    const button = SubmissionTimelineEntry({ node, selected: false, onSelectAttempt })
    button.props.onClick()
    button.props.onClick()
    expect(onSelectAttempt.mock.calls).toEqual([['exact-id'], ['exact-id']])
    expect(saved).toEqual(before)
    expect(node.attempt).toEqual(before)
    expect(button.props.type).toBe('button')
  })

  it('shows an honest empty state with no synthetic submission nodes', () => {
    const html = renderToStaticMarkup(
      createElement(SubmissionTimeline, {
        attempts: [],
        onSelectAttempt: () => {},
      }),
    )
    expect(html).toContain('还没有提交记录')
    expect(html).toContain('成功提交并保存后')
    expect(html).toContain('0 次已保存提交')
    expect(html).not.toContain('data-attempt-id=')
  })

  it('escapes untrusted stored question and feedback text', () => {
    const saved = attempt('escape')
    saved.questionSnapshot!.title = '<script>alert(1)</script>'
    saved.feedback = '<img src=x onerror=alert(1)>'
    const html = renderToStaticMarkup(
      createElement(SubmissionTimeline, {
        attempts: [saved],
        onSelectAttempt: () => {},
      }),
    )
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&lt;img')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img ')
  })
})

it('adds nodes only after successful persisted grading; autosaves, pending and failed requests add none', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'examcraft-submission-timeline-'))
  directories.push(directory)
  const bank = new LocalQuestionBank()
  let started!: () => void
  const began = new Promise<void>((resolve) => {
    started = resolve
  })
  let reject!: (error: Error) => void
  const gate = new Promise<never>((_, fail) => {
    reject = fail
  })
  const service = new StudyService(directory, bank, {
    name: 'controlled failing reviewer',
    review: async () => {
      started()
      return gate
    },
  })
  const draft = { ...emptyDraft(), choiceId: 'A' }
  await service.saveDraft('pol-choice-1', draft)
  const pending = service.submitAnswer('pol-choice-1', draft)
  const failure = expect(pending).rejects.toThrow('controlled review failure')
  await began
  expect(
    filterSubmissionTimeline(buildSubmissionTimeline((await service.loadState()).attempts), 'all'),
  ).toEqual([])
  reject(new Error('controlled review failure'))
  await failure
  expect(
    filterSubmissionTimeline(buildSubmissionTimeline((await service.loadState()).attempts), 'all'),
  ).toEqual([])

  const successful = new StudyService(directory, bank, new LocalRuleAgent())
  const first = await successful.submitAnswer('pol-choice-1', draft)
  const second = await successful.submitAnswer('pol-choice-1', draft)
  const restored = await new StudyService(directory, bank, new LocalRuleAgent()).loadState()
  const politics = buildSubmissionTimeline(restored.attempts).find(
    (group) => group.subject === 'politics',
  )!
  expect(politics.nodes.map((node) => node.attempt.id)).toEqual([second.id, first.id])
  expect(politics.nodes.every((node) => node.snapshotAvailable)).toBe(true)
})
