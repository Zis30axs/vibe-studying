import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  reconcileReviewKnowledgeLabels,
  reviewKnowledgeContextKey,
  ReviewKnowledgePanel,
  ReviewKnowledgeRequests,
  reviewKnowledgeStatusLabels,
  supportsReviewKnowledge,
  type ReviewKnowledgePanelApi,
} from '../src/components/ReviewKnowledgePanel'
import { Review } from '../src/App'
import { emptyDraft, type Attempt } from '../src/shared/types'
import type { ReviewKnowledgeNode } from '../src/shared/review-knowledge'

const node = (overrides: Partial<ReviewKnowledgeNode> = {}): ReviewKnowledgeNode => ({
  id: `rkn-${'a'.repeat(64)}`,
  attemptId: 'saved-attempt',
  questionId: 'frozen-q',
  subject: 'history',
  reviewId: 'b'.repeat(64),
  source: { kind: 'feedback' },
  label: '原标签',
  reviewExcerpt: '真实保存的反馈。',
  excerptTruncated: false,
  references: [],
  revision: 1,
  createdAt: '2026-10-11T00:00:00.000Z',
  updatedAt: '2026-10-11T00:00:00.000Z',
  status: 'pending',
  ...overrides,
})
const attempt: Attempt = {
  id: 'saved-attempt',
  questionId: 'frozen-q',
  submittedAt: '2026-10-11T00:00:00.000Z',
  draft: emptyDraft(),
  score: 1,
  maxScore: 2,
  feedback: '真实保存的反馈。',
  explanation: '',
  rubric: [],
  reviewer: '本地规则',
}
const api: ReviewKnowledgePanelApi = {
  refreshReviewKnowledge: async () => [],
  listReviewKnowledge: async () => [],
  updateReviewKnowledgeLabel: async () => node(),
  associateReviewKnowledge: async () => node(),
  removeReviewKnowledgeAssociation: async () => node(),
  removeReviewKnowledgeNode: async () => {},
  listKnowledgeDocuments: async () => [],
  searchKnowledge: async () => [],
  getKnowledgePdf: async () => new Uint8Array(),
}

describe('review knowledge UI boundaries', () => {
  it('retains the optional API boundary for old history previews', () => {
    expect(supportsReviewKnowledge(undefined)).toBe(false)
    expect(supportsReviewKnowledge(null)).toBe(false)
    expect(supportsReviewKnowledge({ listKnowledgeDocuments: async () => [] })).toBe(false)
    expect(supportsReviewKnowledge(api)).toBe(true)
    const withoutApi = renderToStaticMarkup(createElement(Review, { attempt }))
    expect(withoutApi).not.toContain('data-testid="review-knowledge"')
    expect(withoutApi).toContain('真实保存的反馈。')
    const withApi = renderToStaticMarkup(createElement(Review, { attempt, api }))
    expect(withApi).toContain('data-testid="review-knowledge"')
    expect(withApi).toContain('真实保存的反馈。')
  })

  it('describes feedback-derived labels, local-only retrieval and explicit Agent authorization', () => {
    const html = renderToStaticMarkup(createElement(ReviewKnowledgePanel, { attempt, api }))
    expect(html).toContain('标签来自本次已保存的审阅反馈')
    expect(html).toContain('不代表已读懂或概括整本教材')
    expect(html).toContain('不会自动上传 PDF')
    expect(html).toContain('不会调用付费模型')
    expect(html).toContain('需在 Agent 中另行选择与授权')
    expect(html).not.toContain('<canvas')
    expect(reviewKnowledgeStatusLabels).toEqual({
      pending: '待关联',
      linked: '已关联 · 用户确认',
      stale: '已失效 · 待核对',
    })
  })

  it('changes the keyed session for a different attempt or saved source, not a live bank guess', () => {
    const key = reviewKnowledgeContextKey(attempt)
    expect(reviewKnowledgeContextKey({ ...attempt })).toBe(key)
    for (const changed of [
      { id: 'other-attempt' },
      { questionId: 'other-question' },
      { submittedAt: '2026-10-12T00:00:00.000Z' },
      { feedback: 'Changed authoritative saved review' },
      { reviewer: 'Changed source' },
      {
        rubric: [{ id: 'criterion', label: 'Other', feedback: 'Changed', earned: 0, possible: 1 }],
      },
    ])
      expect(reviewKnowledgeContextKey({ ...attempt, ...changed })).not.toBe(key)
  })
})

describe('review knowledge label draft reconciliation', () => {
  it('keeps unsaved labels while refreshing another revision and adopts untouched labels', () => {
    const original = node()
    const refreshed = node({ label: '另一窗口保存的标签', revision: 2 })
    expect(
      reconcileReviewKnowledgeLabels({ [original.id]: '用户尚未保存' }, [original], [refreshed]),
    ).toEqual({ [original.id]: '用户尚未保存' })
    expect(
      reconcileReviewKnowledgeLabels({ [original.id]: original.label }, [original], [refreshed]),
    ).toEqual({ [original.id]: refreshed.label })
    expect(reconcileReviewKnowledgeLabels({}, [], [original])).toEqual({
      [original.id]: original.label,
    })
  })

  it('acknowledges the submitted label without overwriting a newer edit made during the save', () => {
    const original = node()
    const saved = node({ label: '提交标签', revision: 2 })
    const acknowledged = { id: original.id, label: ' 提交标签 ' }
    expect(
      reconcileReviewKnowledgeLabels(
        { [original.id]: ' 提交标签 ' },
        [original],
        [saved],
        acknowledged,
      ),
    ).toEqual({ [original.id]: '提交标签' })
    expect(
      reconcileReviewKnowledgeLabels(
        { [original.id]: '保存中又修改了' },
        [original],
        [saved],
        acknowledged,
      ),
    ).toEqual({ [original.id]: '保存中又修改了' })
  })

  it('preserves a user reverting to the old persisted label while another label is saving', () => {
    const original = node({ label: 'A' })
    const saved = node({ label: 'B', revision: 2 })
    expect(
      reconcileReviewKnowledgeLabels({ [original.id]: 'A' }, [original], [saved], {
        id: original.id,
        label: 'B',
      }),
    ).toEqual({ [original.id]: 'A' })
  })

  it('preserves labels touched after a refresh or reference check begins, even when changed back to A', () => {
    const original = node({ label: 'A' })
    const refreshed = node({ label: 'B', revision: 2 })
    const touched = new Set([original.id])
    expect(
      reconcileReviewKnowledgeLabels(
        { [original.id]: 'A' },
        [original],
        [refreshed],
        undefined,
        touched,
      ),
    ).toEqual({ [original.id]: 'A' })
    expect(
      reconcileReviewKnowledgeLabels(
        { [original.id]: 'A' },
        [original],
        [refreshed],
        undefined,
        new Set(),
      ),
    ).toEqual({ [original.id]: 'B' })
  })

  it('drops removed node drafts and does not mutate frozen source data', () => {
    const old = Object.freeze(node())
    const drafts = Object.freeze({ [old.id]: '<img src=x onerror=alert(1)>' })
    expect(reconcileReviewKnowledgeLabels(drafts, [old], [])).toEqual({})
    expect(drafts[old.id]).toBe('<img src=x onerror=alert(1)>')
    expect(old.label).toBe('原标签')
  })
})

describe('review knowledge interrupted and repeated request guards', () => {
  it('rejects old search results after changed document, page, query or cancellation', () => {
    const requests = new ReviewKnowledgeRequests()
    for (const _change of ['document', 'page', 'query', 'cancel']) {
      const started = requests.next('search')
      expect(requests.current('search', started)).toBe(true)
      requests.next('search')
      expect(requests.current('search', started)).toBe(false)
    }
  })

  it('suppresses late loads and previews on close without accepting old tokens after remount', () => {
    const old = new ReviewKnowledgeRequests()
    const load = old.next('load')
    const preview = old.next('preview')
    old.close()
    expect(old.current('load', load)).toBe(false)
    expect(old.current('preview', preview)).toBe(false)
    const next = new ReviewKnowledgeRequests()
    expect(next.current('load', next.next('load'))).toBe(true)
    expect(old.current('load', load)).toBe(false)
  })

  it('locks mutations before a repeated click and never releases a newer write with an old token', () => {
    const requests = new ReviewKnowledgeRequests()
    const first = requests.beginWrite()!
    expect(first).toBeTypeOf('symbol')
    expect(requests.beginWrite()).toBeNull()
    expect(requests.writing).toBe(true)
    requests.endWrite(first)
    const second = requests.beginWrite()!
    requests.endWrite(first)
    expect(requests.ownsWrite(second)).toBe(true)
    requests.close()
    expect(requests.ownsWrite(second)).toBe(false)
    expect(requests.beginWrite()).toBeNull()
  })
})
