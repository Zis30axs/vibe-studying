import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalQuestionBank } from '../src/adapters/local-question-bank'
import { LocalRuleAgent } from '../src/adapters/local-rule-agent'
import { StudyService } from '../src/domain/study-service'
import { emptyDraft } from '../src/shared/types'

describe('consented cloud review lifecycle with a synthetic provider', () => {
  let dir: string
  const local = new LocalRuleAgent()
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'examcraft-cloud-test-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  it('requires explicit consent and configured provider before any external review', async () => {
    const review = vi.fn(local.review.bind(local))
    const service = new StudyService(dir, new LocalQuestionBank(dir), local, {
      name: 'Synthetic',
      review,
    })
    const draft = { ...emptyDraft(), choiceId: 'A' }
    await expect(
      service.submitAnswer('pol-choice-1', draft, { provider: 'deepseek' }),
    ).rejects.toThrow('确认')
    expect(review).not.toHaveBeenCalled()
    const unconfigured = new StudyService(dir, new LocalQuestionBank(dir), local)
    await expect(
      unconfigured.submitAnswer('pol-choice-1', draft, {
        provider: 'deepseek',
        cloudConsent: true,
      }),
    ).rejects.toThrow('尚未配置')
    expect((await service.loadState()).attempts).toHaveLength(0)
  })
  it('passes only this question, answer and scope then saves a reviewed attempt across restart', async () => {
    const review = vi.fn(async (question, draft, _context?: { syllabus?: string }) => ({
      ...(await local.review(question, draft)),
      reviewer: 'DeepSeek · synthetic',
    }))
    const service = new StudyService(dir, new LocalQuestionBank(dir), local, {
      name: 'Synthetic',
      review,
    })
    const draft = { ...emptyDraft(), choiceId: 'A', text: 'Synthetic current answer' }
    await service.saveDraft('pol-choice-1', draft)
    await service.submitAnswer('pol-choice-1', draft, {
      provider: 'deepseek',
      cloudConsent: true,
      syllabus: 'Synthetic scope',
    })
    expect(review).toHaveBeenCalledTimes(1)
    expect(review.mock.calls[0]).toHaveLength(3)
    expect(review.mock.calls[0][2]).toEqual({ syllabus: 'Synthetic scope' })
    const restored = new StudyService(dir, new LocalQuestionBank(dir), local)
    expect((await restored.loadState()).attempts[0]).toMatchObject({
      reviewer: 'DeepSeek · synthetic',
      draft,
      score: 4,
    })
  })
  it('preserves the current draft and no phantom grade on provider failure, then permits local retry', async () => {
    const service = new StudyService(dir, new LocalQuestionBank(dir), local, {
      name: 'Synthetic',
      review: async () => {
        throw new Error('Synthetic unavailable')
      },
    })
    const draft = { ...emptyDraft(), choiceId: 'B', text: 'Synthetic unsent reasoning' }
    await expect(
      service.submitAnswer('pol-choice-1', draft, { provider: 'deepseek', cloudConsent: true }),
    ).rejects.toThrow('Synthetic unavailable')
    const state = await service.loadState()
    expect(state.drafts['pol-choice-1']).toEqual(draft)
    expect(state.attempts).toHaveLength(0)
    expect((await service.submitAnswer('pol-choice-1', draft, { provider: 'local' })).score).toBe(0)
  })
  it('rejects simultaneous cloud submission without a duplicate request', async () => {
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      release = resolve
    })
    let finish!: () => void
    const held = new Promise<void>((resolve) => {
      finish = resolve
    })
    const review = vi.fn(async (q, d) => {
      release()
      await held
      return local.review(q, d)
    })
    const service = new StudyService(dir, new LocalQuestionBank(dir), local, {
      name: 'Synthetic',
      review,
    })
    const draft = { ...emptyDraft(), choiceId: 'A' }
    const first = service.submitAnswer('pol-choice-1', draft, {
      provider: 'deepseek',
      cloudConsent: true,
    })
    await started
    await expect(
      service.submitAnswer('pol-choice-1', draft, { provider: 'deepseek', cloudConsent: true }),
    ).rejects.toThrow('重复')
    finish()
    await first
    expect(review).toHaveBeenCalledTimes(1)
  })
})
