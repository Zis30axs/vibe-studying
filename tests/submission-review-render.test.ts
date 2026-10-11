import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Review } from '../src/App'
import { emptyDraft, type Attempt, type StudentQuestion } from '../src/shared/types'

const question: StudentQuestion = {
  id: 'frozen-choice',
  subject: 'history',
  kind: 'choice',
  title: '提交时标题',
  prompt: '提交时原题',
  source: 'Synthetic fixture',
  tags: [],
  maxScore: 4,
  choices: [{ id: 'A', text: '提交时选项' }],
}
const attempt = (): Attempt => ({
  id: 'saved-attempt',
  questionId: question.id,
  submittedAt: '2026-10-11T00:00:00.000Z',
  draft: { ...emptyDraft(), text: '提交时答案', choiceId: 'A' },
  score: 4,
  maxScore: 4,
  feedback: '提交时反馈',
  explanation: '提交时解析',
  rubric: [],
  reviewer: '本地规则',
})
describe('frozen submission review rendering', () => {
  it('uses saved question and answer data even when the current question has changed', () => {
    const saved = { ...attempt(), questionSnapshot: question }
    const current = {
      ...question,
      title: 'LIVE_TITLE_MUST_NOT_APPEAR',
      prompt: 'LIVE_PROMPT_MUST_NOT_APPEAR',
      choices: [{ id: 'A', text: 'LIVE_CHOICE_MUST_NOT_APPEAR' }],
    }
    const before = JSON.stringify(saved)
    const html = renderToStaticMarkup(createElement(Review, { attempt: saved, question: current }))
    for (const text of [
      '提交时标题',
      '提交时原题',
      '提交时选项',
      '提交时答案',
      '提交时反馈',
      '提交时解析',
    ])
      expect(html).toContain(text)
    expect(html).not.toContain('LIVE_')
    expect(JSON.stringify(saved)).toBe(before)
  })
  it('labels absent legacy question metadata unavailable instead of using live bank fields', () => {
    const html = renderToStaticMarkup(createElement(Review, { attempt: attempt(), question }))
    expect(html).toContain('未保存题目快照')
    expect(html).toContain('原题文案、选项与学科信息不可用')
    expect(html).not.toContain('提交时标题')
    expect(html).not.toContain('提交时选项')
    expect(html).toContain('提交时答案')
    expect(html).toContain('提交时反馈')
  })
  it('labels missing saved feedback and explanation rather than manufacturing them', () => {
    const html = renderToStaticMarkup(
      createElement(Review, {
        attempt: { ...attempt(), feedback: '', explanation: '', reviewer: '' },
      }),
    )
    expect(html).toContain('本次反馈不可用')
    expect(html).toContain('本次解析不可用')
    expect(html).toContain('审阅来源不可用')
  })
})
