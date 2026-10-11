import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StudyService } from '../src/domain/study-service'
import { LocalQuestionBank } from '../src/adapters/local-question-bank'
import { LocalRuleAgent } from '../src/adapters/local-rule-agent'
import { emptyDraft, type AnswerDraft, type Question } from '../src/shared/types'
import { checkpointArgument } from '../src/domain/argument-revisions'

const directories: string[] = []
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true })
})
it('captures submission before awaits and isolates frozen grading evidence from drafts and timeline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'examcraft-role-isolation-'))
  directories.push(dir)
  const bank = new LocalQuestionBank()
  const original = await bank.get('pol-assembly-1')
  let release: (() => void) | undefined
  const delayedBank = {
    name: bank.name,
    list: bank.list.bind(bank),
    get: async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return original
    },
  }
  let seen: { question: Question; draft: AnswerDraft } | undefined
  const agent = {
    name: 'Isolated test reviewer',
    review: async (question: Question, draft: AnswerDraft) => {
      seen = { question, draft }
      expect(Object.isFrozen(question)).toBe(true)
      expect(Object.isFrozen(draft)).toBe(true)
      expect(Object.isFrozen(draft.argument!.roots[0])).toBe(true)
      expect(draft.argument).not.toHaveProperty('canvas')
      expect(draft.argument).not.toHaveProperty('revisions')
      expect(draft.blocks).toEqual([])
      return new LocalRuleAgent().review(question, draft)
    },
  }
  const service = new StudyService(dir, delayedBank, agent)
  const draft = emptyDraft()
  draft.text = '实践决定认识，通过走访调查，再检验完善方案。'
  draft.argument = checkpointArgument(
    {
      version: 1,
      roots: [{ id: 'a1', kind: 'analysis', text: '我自己的论证', children: [] }],
      canvas: { positions: { a1: { x: 5, y: 10 } }, viewport: { x: 0, y: 0, zoom: 1 } },
    },
    { label: '顾问讨论不应成为评分上下文' },
  )
  const captured = structuredClone(draft)
  const pending = service.submitAnswer(original.id, draft)
  draft.text = '并发工作区修改，不是本次提交'
  draft.argument.roots[0].text = '后续编辑'
  release!()
  const attempt = await pending
  expect(seen!.draft.text).toBe(captured.text)
  expect(seen!.draft.argument!.roots[0].text).toBe('我自己的论证')
  expect(attempt.draft).toEqual(captured)
  expect((await service.loadState()).attempts[0].draft).toEqual(captured)
  expect(original).not.toBe(seen!.question)
})

it('cancels cloud grading before dispatch while retaining the submitted draft', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'examcraft-cancel-before-'))
  directories.push(dir)
  const bank = new LocalQuestionBank()
  let resolveReviewer!: (reviewer: LocalRuleAgent) => void
  let calls = 0
  const reviewer = new LocalRuleAgent()
  const originalReview = reviewer.review.bind(reviewer)
  reviewer.review = (...args) => {
    calls++
    return originalReview(...args)
  }
  const service = new StudyService(
    dir,
    bank,
    new LocalRuleAgent(),
    undefined,
    () =>
      new Promise((resolve) => {
        resolveReviewer = resolve
      }),
  )
  const pending = service.submitAnswer(
    'pol-choice-1',
    { ...emptyDraft(), choiceId: 'A' },
    { provider: 'cloud', cloudConsent: true, configRevision: 0 },
  )
  service.cancelCloudReview()
  resolveReviewer(reviewer)
  await expect(pending).rejects.toThrow('取消')
  expect(calls).toBe(0)
  const state = await service.loadState()
  expect(state.attempts).toEqual([])
  expect(state.drafts['pol-choice-1'].choiceId).toBe('A')
})

it('suppresses a non-cooperative late cloud result after cancel and allows a fresh review', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'examcraft-cancel-after-'))
  directories.push(dir)
  const bank = new LocalQuestionBank()
  const local = new LocalRuleAgent()
  let release!: () => void
  let began!: () => void
  const started = new Promise<void>((resolve) => {
    began = resolve
  })
  let delay = true
  const reviewer = {
    name: 'synthetic',
    review: async (...args: Parameters<LocalRuleAgent['review']>) => {
      if (delay) {
        began()
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      return local.review(...args)
    },
  }
  const service = new StudyService(dir, bank, local, undefined, async () => reviewer)
  const draft = { ...emptyDraft(), choiceId: 'A' }
  const options = { provider: 'cloud' as const, cloudConsent: true, configRevision: 0 }
  const pending = service.submitAnswer('pol-choice-1', draft, options)
  await started
  service.cancelCloudReview()
  release()
  await expect(pending).rejects.toThrow('取消')
  expect((await service.loadState()).attempts).toEqual([])
  delay = false
  await service.submitAnswer('pol-choice-1', draft, options)
  expect((await service.loadState()).attempts).toHaveLength(1)
})
