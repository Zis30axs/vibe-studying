import { expect, test, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MathChallengeService } from '../../src/adapters/math-challenge-service'
import { mathChallengePapers } from '../../src/domain/math-challenge-papers'
import type { ExamCraftApi } from '../../src/shared/types'
import type { MathChallengeSaveInput } from '../../src/shared/math-challenge'

const challenge = (page: Page) =>
  page.getByRole('region', { name: '数学挑战：综合试卷', exact: true })
const sheet = (page: Page) => challenge(page).getByRole('navigation', { name: '综合试卷答题卡' })
const question = (page: Page) => challenge(page).locator('article.challenge-question')
const firstPaper = mathChallengePapers[0]

async function openWorkspace(
  page: Page,
  service: MathChallengeService,
  delay?: {
    enabled: boolean
    pending: boolean
    release?: () => void
    saves: MathChallengeSaveInput[]
  },
) {
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url())
    return ['127.0.0.1', 'localhost'].includes(url.hostname) ||
      ['data:', 'blob:'].includes(url.protocol)
      ? route.continue()
      : route.abort()
  })
  await page.exposeFunction('mathChallengeInvoke', async (method: string, input: unknown) => {
    if (method === 'overview') return service.getMathChallenges()
    if (method === 'start') return service.startMathChallenge(input)
    if (method === 'get') return service.getMathChallenge(input)
    if (method === 'submit') return service.submitMathChallenge(input)
    if (method === 'grade') return service.gradeMathChallenge(input)
    if (method === 'save') {
      const savedInput = structuredClone(input) as MathChallengeSaveInput
      delay?.saves.push(savedInput)
      if (delay?.enabled) {
        delay.enabled = false
        delay.pending = true
        await new Promise<void>((resolve) => {
          delay.release = resolve
        })
        delay.pending = false
      }
      return service.saveMathChallenge(savedInput)
    }
    throw new Error('Unexpected fixture method')
  })
  await page.addInitScript(() => {
    const call = (method: string, input?: unknown) =>
      (
        window as unknown as {
          mathChallengeInvoke(method: string, input?: unknown): Promise<unknown>
        }
      ).mathChallengeInvoke(method, input)
    const api: Partial<ExamCraftApi> = {
      listQuestions: async () => [
        {
          id: 'fixture-question',
          subject: 'math',
          kind: 'math',
          title: '常规练习',
          prompt: '测试常规练习保留。',
          source: 'fixture',
          tags: [],
          maxScore: 10,
        },
      ],
      loadState: async () => ({ version: 1, drafts: {}, attempts: [] }),
      getCapabilities: async () => ({
        questionBank: 'fixture',
        reviewer: 'fixture',
        mcp: 'fixture',
      }),
      getModelProfiles: async () => ({
        revision: 1,
        secureStorageAvailable: false,
        profiles: [],
        roles: { parent: '', child: '' },
      }),
      getModelConsents: async () => ({ version: 1, revision: 0, grants: [] }),
      getGitHubProfile: async () => null,
      listKnowledgeDocuments: async () => [],
      getGenerationStatus: async () => ({ used: 0, pending: 0, limit: 5 }),
      saveDraft: async () => {},
      cancelAdvisor: async () => {},
      cancelModuleReview: async () => {},
      cancelQuestionGeneration: async () => {},
    }
    window.examcraft = {
      ...api,
      getMathChallenges: () => call('overview'),
      startMathChallenge: (input: unknown) => call('start', input),
      getMathChallenge: (input: unknown) => call('get', input),
      saveMathChallenge: (input: unknown) => call('save', input),
      submitMathChallenge: (input: unknown) => call('submit', input),
      gradeMathChallenge: (input: unknown) => call('grade', input),
    } as ExamCraftApi
  })
  await page.goto('/')
  await expect(page.locator('#answer-text')).toBeVisible()
  await page.getByRole('button', { name: '数学挑战 Comprehensive paper', exact: true }).click()
  await expect(
    challenge(page)
      .getByRole('button', { name: /开始挑战/ })
      .first(),
  ).toBeVisible()
}

test('new entrance runs a full paper, locks answers before review, and restores history and manual scores', async ({
  page,
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'examcraft-browser-challenge-'))
  try {
    const service = new MathChallengeService(directory)
    await openWorkspace(page, service)
    await expect(challenge(page).locator('.challenge-paper-card')).toHaveCount(2)
    await page.screenshot({ path: 'test-results/math-challenge-lobby.png', fullPage: true })
    await challenge(page)
      .getByRole('button', { name: /开始挑战/ })
      .first()
      .click()
    await expect(sheet(page).getByRole('button')).toHaveCount(firstPaper.questions.length)
    await page.screenshot({ path: 'test-results/math-challenge-exam.png', fullPage: true })
    await expect(challenge(page).getByText('参考答案', { exact: true })).toHaveCount(0)
    await question(page)
      .getByRole('radio', {
        name: new RegExp(`^${firstPaper.questions[0].correctChoiceIds![0]}\\.`),
      })
      .check()
    await question(page).getByRole('button', { name: '标记检查', exact: true }).click()
    await sheet(page)
      .getByRole('button', { name: /^第 12 题/ })
      .click()
    await question(page).getByRole('textbox').fill('填空的独立结果')
    await page.getByRole('button', { name: '题目练习 Practice', exact: true }).click()
    await expect(page.locator('#answer-text')).toBeVisible()
    await page.getByRole('button', { name: '数学挑战 Comprehensive paper', exact: true }).click()
    await expect(question(page).getByRole('textbox')).toHaveValue('填空的独立结果')
    await challenge(page).getByRole('button', { name: '提交试卷', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '确认交卷？' })
    await expect(dialog).toContainText(`还有 ${firstPaper.questions.length - 2} 道题未作答`)
    await dialog.getByRole('button', { name: '继续检查', exact: true }).click()
    await expect(dialog).toBeHidden()
    await challenge(page).getByRole('button', { name: '提交试卷', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: '确认交卷', exact: true }).click()
    await expect(challenge(page).getByText('参考答案', { exact: true })).toBeVisible()
    await expect(
      challenge(page).getByText('选择题得分 · 总分等待自评', { exact: true }),
    ).toBeVisible()
    await expect(question(page).getByRole('radio')).toHaveCount(0)
    await sheet(page)
      .getByRole('button', { name: /^第 12 题/ })
      .click()
    await question(page).getByRole('spinbutton', { name: '本题自评分', exact: true }).fill('4')
    await question(page).getByRole('button', { name: '保存自评', exact: true }).click()
    await expect(challenge(page).getByText('本次综合试卷总分', { exact: true })).toBeVisible()
    await page.reload()
    await page.getByRole('button', { name: '数学挑战 Comprehensive paper', exact: true }).click()
    await challenge(page)
      .getByRole('button', { name: /挑战记录/ })
      .click()
    await challenge(page).getByRole('button', { name: '查看复盘', exact: true }).click()
    await sheet(page)
      .getByRole('button', { name: /^第 12 题/ })
      .click()
    await expect(
      question(page).getByRole('spinbutton', { name: '本题自评分', exact: true }),
    ).toHaveValue('4')
    await expect(question(page)).toContainText('填空的独立结果')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('late save responses preserve newer typing and navigation flushes before submission', async ({
  page,
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'examcraft-browser-challenge-race-'))
  const delay = {
    enabled: false,
    pending: false,
    release: undefined as (() => void) | undefined,
    saves: [] as MathChallengeSaveInput[],
  }
  try {
    const service = new MathChallengeService(directory)
    await openWorkspace(page, service, delay)
    await challenge(page)
      .getByRole('button', { name: /开始挑战/ })
      .first()
      .click()
    await sheet(page)
      .getByRole('button', { name: /^第 15 题/ })
      .click()
    await expect(challenge(page).getByText('已自动保存到本机', { exact: true })).toBeVisible()
    delay.enabled = true
    await question(page).getByRole('textbox').fill('第一段')
    await expect.poll(() => delay.pending).toBe(true)
    await question(page).getByRole('textbox').fill('第一段，继续写出的完整推导')
    delay.release?.()
    await expect(question(page).getByRole('textbox')).toHaveValue('第一段，继续写出的完整推导')
    await challenge(page).getByRole('button', { name: '提交试卷', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: '确认交卷', exact: true }).click()
    await expect(challenge(page).getByText('参考答案', { exact: true })).toBeVisible()
    await sheet(page)
      .getByRole('button', { name: /^第 15 题/ })
      .click()
    await expect(question(page)).toContainText('第一段，继续写出的完整推导')
    const overview = await service.getMathChallenges()
    const submitted = await service.getMathChallenge(overview.history[0].id)
    expect(submitted.answers[firstPaper.questions[14].id].text).toBe('第一段，继续写出的完整推导')
    expect(delay.saves.length).toBeGreaterThan(1)
  } finally {
    delay.release?.()
    await rm(directory, { recursive: true, force: true })
  }
})

test('deadline survives closing the page and opens an automatically submitted history record', async ({
  page,
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'examcraft-browser-challenge-timeout-'))
  let offset = 0
  try {
    const service = new MathChallengeService(directory, undefined, () => Date.now() + offset)
    await openWorkspace(page, service)
    await challenge(page)
      .getByRole('button', { name: /开始挑战/ })
      .last()
      .click()
    await expect(sheet(page).getByRole('button')).toHaveCount(20)
    await question(page).getByRole('radio').first().check()
    await expect(challenge(page).getByText('已自动保存到本机', { exact: true })).toBeVisible()
    offset = 121 * 60_000
    await page.reload()
    await page.getByRole('button', { name: '数学挑战 Comprehensive paper', exact: true }).click()
    await expect(
      challenge(page).getByRole('button', { name: '继续作答', exact: true }),
    ).toHaveCount(0)
    await challenge(page)
      .getByRole('button', { name: /挑战记录/ })
      .click()
    await expect(challenge(page).locator('.challenge-history-row')).toContainText('到时交卷')
    await challenge(page).getByRole('button', { name: '查看复盘', exact: true }).click()
    await expect(challenge(page)).toContainText('到时自动交卷')
    await expect(challenge(page).getByText('参考答案', { exact: true })).toBeVisible()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
