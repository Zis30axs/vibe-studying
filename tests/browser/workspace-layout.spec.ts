import { test, expect, type Page } from '@playwright/test'
import type {
  AdvisorRequest,
  AdvisorResult,
  AnswerDraft,
  ExamCraftApi,
  StudyState,
} from '../../src/shared/types'
import { LAYOUT_STORAGE_KEY } from '../../src/domain/workspace-layout'

declare global {
  interface Window {
    layoutFixture: {
      saves: AnswerDraft[]
      requests: AdvisorRequest[]
      canceled: string[]
      release(): void
      mathNode?: Element | null
    }
  }
}
const toolsToggle = (page: Page) => page.getByRole('button', { name: '工具与顾问', exact: true })
const questionsToggle = (page: Page) => page.getByRole('button', { name: '练习目录', exact: true })
const separator = (page: Page, name = '工具与顾问宽度') => page.getByRole('separator', { name })
const saved = (page: Page) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), LAYOUT_STORAGE_KEY)

async function openWorkspace(page: Page) {
  await page.addInitScript(() => {
    const state: StudyState = JSON.parse(
      sessionStorage.getItem('layout-draft-fixture') || '{"version":1,"drafts":{},"attempts":[]}',
    )
    const release: (() => void)[] = []
    window.layoutFixture = {
      saves: [],
      requests: [],
      canceled: [],
      release: () => release.splice(0).forEach((resolve) => resolve()),
    }
    const api: Partial<ExamCraftApi> = {
      listQuestions: async () => [
        {
          id: 'layout-math',
          subject: 'math',
          kind: 'math',
          title: '函数与思路',
          prompt: '观察函数并说明理由。',
          source: 'Synthetic layout fixture',
          tags: [],
          maxScore: 10,
        },
      ],
      loadState: async () => structuredClone(state),
      getCapabilities: async () => ({
        questionBank: 'fixture',
        reviewer: 'fixture',
        mcp: 'fixture',
      }),
      getModelProfiles: async () => ({
        revision: 1,
        secureStorageAvailable: false,
        roles: { parent: 'test', child: 'test' },
        profiles: [
          {
            profileId: 'test',
            profileName: 'Fixture',
            keyStatus: 'session',
            protocol: 'openai-chat',
            model: 'synthetic',
            baseUrl: 'https://fixture.vendor.com/v1',
            revision: 1,
            configured: true,
          },
        ],
      }),
      getModelConsents: async () => ({ version: 1, revision: 0, grants: [] }),
      getGitHubProfile: async () => null,
      listKnowledgeDocuments: async () => [],
      getGenerationStatus: async () => ({ used: 0, pending: 0, limit: 5 }),
      saveDraft: async (id, draft) => {
        state.drafts[id] = structuredClone(draft)
        window.layoutFixture.saves.push(structuredClone(draft))
        sessionStorage.setItem('layout-draft-fixture', JSON.stringify(state))
      },
      askAdvisor: async (input) => {
        window.layoutFixture.requests.push(input)
        await new Promise<void>((resolve) => release.push(resolve))
        return {
          requestId: input.requestId,
          hint: 'STALE_LAYOUT_RESULT',
          questions: [],
          cautions: [],
        } as unknown as AdvisorResult
      },
      cancelAdvisor: async (id) => {
        window.layoutFixture.canceled.push(id)
      },
      cancelModuleReview: async () => {},
      cancelQuestionGeneration: async () => {},
    }
    window.examcraft = api as ExamCraftApi
  })
  await page.goto('/')
  await expect(page.locator('#answer-text')).toBeVisible()
}

async function assertNoHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true)
}

test('four-zone shell uses remaining room for the answer; overview lives only in history', async ({
  page,
}) => {
  await openWorkspace(page)
  await expect(page.locator('#question-panel')).toBeVisible()
  await expect(page.locator('#tools-panel')).toBeVisible()
  await expect(page.locator('.history-overview')).toHaveCount(0)
  const answer = (await page.locator('.workspace-answer').boundingBox())!
  expect(answer.width).toBeGreaterThanOrEqual(420)
  await assertNoHorizontalOverflow(page)
  await page.getByRole('button', { name: '练习记录 Review & reflect', exact: true }).click()
  await expect(page.getByRole('region', { name: '学习概览', exact: true })).toBeVisible()
  await expect(page.locator('.history-overview summary')).toHaveCount(0)
  await expect(page.locator('.history-overview .activity-heatmap')).toBeVisible()
})

test('keyboard and drag boundaries resize all panels; per-divider and whole-layout reset work', async ({
  page,
}) => {
  await openWorkspace(page)
  await separator(page, '练习目录宽度').focus()
  await page.keyboard.press('Home')
  await expect(separator(page, '练习目录宽度')).toHaveAttribute('aria-valuenow', '190')
  await page.keyboard.press('Shift+ArrowRight')
  await expect(separator(page, '练习目录宽度')).toHaveAttribute('aria-valuenow', '230')
  await page.keyboard.press('Enter')
  await expect(separator(page, '练习目录宽度')).toHaveAttribute('aria-valuenow', '224')
  const splitter = separator(page)
  await splitter.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(splitter).toHaveAttribute('aria-valuenow', '450')
  await page.keyboard.press('End')
  expect(Number(await splitter.getAttribute('aria-valuenow'))).toBeLessThanOrEqual(960)
  expect((await page.locator('.workspace-answer').boundingBox())!.width).toBeGreaterThanOrEqual(419)
  await splitter.dblclick()
  await expect(splitter).toHaveAttribute('aria-valuenow', '440')
  const box = (await splitter.boundingBox())!
  await page.mouse.move(box.x + 4, box.y + 40)
  await page.mouse.down()
  await page.mouse.move(box.x + 500, box.y + 40, { steps: 10 })
  await page.mouse.up()
  await expect(splitter).toHaveAttribute('aria-valuenow', '340')
  await page.getByRole('button', { name: '展开导航栏', exact: true }).click()
  await separator(page, '导航栏宽度').focus()
  await page.keyboard.press('End')
  await expect(separator(page, '导航栏宽度')).toHaveAttribute('aria-valuenow', '280')
  await page.getByRole('button', { name: '重置布局', exact: true }).click()
  await expect(page.getByRole('button', { name: '展开导航栏', exact: true })).toBeVisible()
  expect((await saved(page)).widths).toEqual({ navigation: 196, questions: 224, tools: 440 })
})

test('collapse, focus mode, reopening and reload preserve the canonical draft and one mounted tool', async ({
  page,
}) => {
  await openWorkspace(page)
  await page.getByRole('button', { name: '数学工作台 Math lab', exact: true }).click()
  await page.locator('#answer-text').fill('布局调整不能丢失这份答案。')
  const expression = page
    .getByRole('region', { name: '数学交互工作台', exact: true })
    .getByLabel('函数表达式')
  await expression.fill('2(x+1)')
  await page.evaluate(() => {
    window.layoutFixture.mathNode = document.querySelector('.math-workbench')
  })
  await toolsToggle(page).click()
  await expect(page.locator('#tools-panel')).toBeHidden()
  await toolsToggle(page).click()
  await expect(expression).toHaveValue('2(x+1)')
  expect(
    await page.evaluate(
      () => window.layoutFixture.mathNode === document.querySelector('.math-workbench'),
    ),
  ).toBe(true)
  await expect(page.locator('.math-workbench')).toHaveCount(1)
  await page.getByRole('button', { name: '专注作答', exact: true }).click()
  await expect(page.locator('#question-panel')).toBeHidden()
  await expect(page.locator('#tools-panel')).toBeHidden()
  await page.reload()
  await expect(page.locator('#answer-text')).toHaveValue('布局调整不能丢失这份答案。')
  await expect(page.locator('#tools-panel')).toBeHidden()
  await questionsToggle(page).click()
  await expect(page.locator('#question-panel')).toBeVisible()
  await toolsToggle(page).click()
  await expect(page.locator('#tools-panel')).toBeVisible()
})

test('narrow-window drawers preserve desktop preferences, trap focus, close on Escape and recover when enlarged', async ({
  page,
}) => {
  await openWorkspace(page)
  const before = await saved(page)
  await page.setViewportSize({ width: 720, height: 800 })
  await expect(page.locator('#question-panel')).toBeHidden()
  await expect(page.locator('#tools-panel')).toBeHidden()
  await toolsToggle(page).click()
  const drawer = page.getByRole('dialog', { name: '工具与顾问', exact: true })
  await expect(drawer).toBeVisible()
  await expect(page.getByRole('button', { name: '折叠工具与顾问', exact: true })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  expect(await drawer.evaluate((node) => node.contains(document.activeElement))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()
  await expect(toolsToggle(page)).toBeFocused()
  await questionsToggle(page).click()
  await expect(page.getByRole('dialog', { name: '题目列表', exact: true })).toBeVisible()
  await page
    .getByRole('button', { name: '关闭侧栏遮罩', exact: true })
    .click({ position: { x: 580, y: 500 } })
  await expect(page.locator('#question-panel')).toBeHidden()
  expect(await saved(page)).toEqual(before)
  for (const width of [390, 760, 1100, 1250, 1440]) {
    await page.setViewportSize({ width, height: 850 })
    await assertNoHorizontalOverflow(page)
  }
  await expect(page.locator('#question-panel')).toBeVisible()
  await expect(page.locator('#tools-panel')).toBeVisible()
  expect(await saved(page)).toEqual(before)
})

test('divider adjustment preserves Advisor context; hiding its panel cancels pending work and drops late results', async ({
  page,
}) => {
  await openWorkspace(page)
  const answer = page.locator('#answer-text')
  await answer.fill('需要提示的完整数学思路。')
  await answer.evaluate((node) => {
    const input = node as HTMLTextAreaElement
    input.focus()
    input.setSelectionRange(0, input.value.length)
    input.dispatchEvent(new Event('select', { bubbles: true }))
  })
  await expect(page.locator('.advisor-selection-action')).toBeInViewport()
  await page.locator('.advisor-selection-action').click()
  const dialog = page.getByRole('dialog', { name: 'Ask Advisor · 思路提示' })
  await expect(dialog).toBeVisible()
  await separator(page).focus()
  await page.keyboard.press('ArrowLeft')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('checkbox', { name: /我同意将以上选中文字/ }).check()
  await dialog.getByRole('button', { name: '确认并获取提示', exact: true }).click()
  await expect(dialog.getByRole('button', { name: '取消请求', exact: true })).toBeVisible()
  await toolsToggle(page).click()
  await expect.poll(() => page.evaluate(() => window.layoutFixture.canceled.length)).toBe(1)
  await page.evaluate(() => window.layoutFixture.release())
  await toolsToggle(page).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByText('STALE_LAYOUT_RESULT')).toHaveCount(0)
  await expect(answer).toHaveValue('需要提示的完整数学思路。')
})

test('invalid stored layout falls back safely and layout persistence contains no answer content', async ({
  page,
}) => {
  await page.addInitScript((key) => localStorage.setItem(key, '{broken'), LAYOUT_STORAGE_KEY)
  await openWorkspace(page)
  await page.locator('#answer-text').fill('PRIVATE_ANSWER_NOT_LAYOUT')
  const preferences = await saved(page)
  expect(preferences).toEqual({
    version: 1,
    widths: { navigation: 196, questions: 224, tools: 440 },
    collapsed: { navigation: true, questions: false, tools: false },
  })
  expect(JSON.stringify(preferences)).not.toContain('PRIVATE_ANSWER_NOT_LAYOUT')
})
