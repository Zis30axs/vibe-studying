import { expect, test, type Page } from '@playwright/test'
import type { AnswerDraft, ExamCraftApi, StudyState } from '../../src/shared/types'
import { WORKSPACE_UI_KEY } from '../../src/domain/workspace-experience'
import { LAYOUT_STORAGE_KEY } from '../../src/domain/workspace-layout'

declare global {
  interface Window {
    uiFixture: { saves: AnswerDraft[]; submits: number; releaseLoad(): void; node?: Element | null }
  }
}
const palette = (page: Page) => page.getByRole('dialog', { name: '想去哪里，直接找', exact: true })
const trigger = (page: Page) =>
  page.getByRole('button', { name: '快速查找题目与工具', exact: true })
async function open(page: Page, delay = false) {
  await page.addInitScript(
    ({ delay }) => {
      const state: StudyState = JSON.parse(
        sessionStorage.getItem('ui-drafts') || '{"version":1,"drafts":{},"attempts":[]}',
      )
      let release: (() => void) | undefined
      const pending = delay
        ? new Promise<void>((resolve) => {
            release = resolve
          })
        : Promise.resolve()
      window.uiFixture = { saves: [], submits: 0, releaseLoad: () => release?.() }
      const api: Partial<ExamCraftApi> = {
        listQuestions: async () => [
          {
            id: 'ui-circle',
            subject: 'math',
            kind: 'math',
            title: '圆与切线：从条件到方程',
            prompt: '圆经过点（1，1），圆心在 x 轴正半轴上，与直线 y=x−4 相切。求圆的标准方程。',
            source: 'Synthetic browser fixture',
            tags: ['解析几何', '圆与切线'],
            maxScore: 10,
          },
          {
            id: 'ui-chord',
            subject: 'math',
            kind: 'math',
            title: '弦长：从垂径定理出发',
            prompt: '已知圆心到直线的距离，求弦长。',
            source: 'Synthetic fixture',
            tags: ['弦长'],
            maxScore: 10,
          },
          {
            id: 'ui-english',
            subject: 'english',
            kind: 'english',
            title: '英语：解释判断依据',
            prompt: 'Write reasoning.',
            source: 'Synthetic fixture',
            tags: ['阅读'],
            maxScore: 10,
          },
        ],
        loadState: async () => {
          await pending
          return structuredClone(state)
        },
        getCapabilities: async () => ({
          questionBank: 'fixture',
          reviewer: 'local',
          mcp: 'fixture',
        }),
        getModelProfiles: async () => ({
          revision: 1,
          profiles: [],
          roles: { parent: '', child: '' },
          secureStorageAvailable: false,
        }),
        getModelConsents: async () => ({ version: 1, revision: 0, grants: [] }),
        getGitHubProfile: async () => null,
        listKnowledgeDocuments: async () => [],
        getGenerationStatus: async () => ({ used: 0, limit: 5, pending: 0 }),
        saveDraft: async (id, draft) => {
          state.drafts[id] = structuredClone(draft)
          window.uiFixture.saves.push(structuredClone(draft))
          sessionStorage.setItem('ui-drafts', JSON.stringify(state))
        },
        submitAnswer: async () => {
          window.uiFixture.submits++
          throw new Error('No real submissions')
        },
      }
      window.examcraft = api as ExamCraftApi
    },
    { delay },
  )
  await page.goto('/')
  if (!delay) await expect(page.locator('#answer-text')).toBeVisible()
}
test('Ctrl+K opens a modal palette, arrow navigation and Escape restore trigger focus', async ({
  page,
}) => {
  await open(page)
  await trigger(page).focus()
  await page.keyboard.press('Control+k')
  await expect(palette(page)).toBeVisible()
  await expect(palette(page).getByRole('combobox')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(palette(page).getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Escape')
  await expect(palette(page)).not.toBeVisible()
  await expect(trigger(page)).toBeFocused()
})
test('global search switches questions without posting or losing drafts', async ({ page }) => {
  await open(page)
  await page.locator('#answer-text').fill('先设圆心（a，0）')
  await trigger(page).click()
  await palette(page).getByRole('combobox').fill('弦长')
  await page.keyboard.press('Enter')
  await expect(page.locator('.question-prompt h2')).toHaveText('弦长：从垂径定理出发')
  await expect(page.locator('#answer-text')).toHaveValue('')
  await page.getByRole('button', { name: '上一题', exact: true }).click()
  await expect(page.locator('#answer-text')).toHaveValue('先设圆心（a，0）')
  expect(await page.evaluate(() => window.uiFixture.submits)).toBe(0)
  expect(await page.evaluate(() => window.uiFixture.saves.length)).toBe(1)
})
test('palette offers empty state, navigation and motion preference', async ({ page }) => {
  await open(page)
  await trigger(page).click()
  await palette(page).getByRole('combobox').fill('绝不存在999')
  await expect(palette(page).getByRole('status')).toContainText('没有找到')
  await palette(page).getByRole('combobox').fill('减少界面动画')
  await page.keyboard.press('Enter')
  await expect(page.locator('.workspace-shell')).toHaveAttribute('data-motion', 'reduce')
  await trigger(page).click()
  await palette(page).getByRole('combobox').fill('设置')
  await expect(palette(page).getByRole('option')).toContainText('题库与 Agent')
})
test('prev/next respects math scope and bounds', async ({ page }) => {
  await open(page)
  await page.getByRole('button', { name: '数学工作台 Math lab', exact: true }).click()
  await expect(page.getByRole('button', { name: '上一题', exact: true })).toBeDisabled()
  await expect(page.getByLabel('题目位置', { exact: true })).toHaveText('1 / 2')
  await page.getByRole('button', { name: '下一题', exact: true }).click()
  await expect(page.getByLabel('题目位置', { exact: true })).toHaveText('2 / 2')
  await expect(page.getByRole('button', { name: '下一题', exact: true })).toBeDisabled()
})
test('focus restores previous widths while preserving the mounted answer node', async ({
  page,
}) => {
  await open(page)
  const before = await page.evaluate((key) => localStorage.getItem(key), LAYOUT_STORAGE_KEY)
  await page.locator('#answer-text').fill('专注也不能丢稿')
  await page.evaluate(() => {
    window.uiFixture.node = document.querySelector('#answer-text')
  })
  await page.getByRole('button', { name: '专注作答', exact: true }).click()
  await expect(page.locator('#tools-panel')).not.toBeVisible()
  await expect(page.locator('#question-panel')).not.toBeVisible()
  await page.getByRole('button', { name: '退出专注', exact: true }).click()
  expect(await page.evaluate((key) => localStorage.getItem(key), LAYOUT_STORAGE_KEY)).toBe(before)
  expect(
    await page.evaluate(() => window.uiFixture.node === document.querySelector('#answer-text')),
  ).toBe(true)
  await expect(page.locator('#answer-text')).toHaveValue('专注也不能丢稿')
})
test('last question survives reload; preference cache excludes answers and keys', async ({
  page,
}) => {
  await open(page)
  await page.getByRole('button', { name: '下一题', exact: true }).click()
  await page.locator('#answer-text').fill('PRIVATE_DRAFT')
  await expect
    .poll(() =>
      page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key)!).lastQuestionId,
        WORKSPACE_UI_KEY,
      ),
    )
    .toBe('ui-chord')
  await page.reload()
  await expect(page.locator('.question-prompt h2')).toHaveText('弦长：从垂径定理出发')
  await expect(page.locator('#answer-text')).toHaveValue('PRIVATE_DRAFT')
  expect(
    await page.evaluate(
      (key) => Object.keys(JSON.parse(localStorage.getItem(key)!)),
      WORKSPACE_UI_KEY,
    ),
  ).toEqual(['version', 'lastQuestionId', 'motion'])
})
test('respects system reduced motion, application reduction and loading shell', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await open(page)
  expect(
    await page.locator('.page-heading').evaluate((node) => getComputedStyle(node).animationName),
  ).toBe('none')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await trigger(page).click()
  await palette(page).getByRole('combobox').fill('减少界面动画')
  await page.keyboard.press('Enter')
  expect(
    await page.locator('.page-heading').evaluate((node) => getComputedStyle(node).animationName),
  ).toBe('none')
})
test('real workspace remains usable in narrow, dark and command views', async ({
  page,
}, testInfo) => {
  await open(page)
  await page.locator('#answer-text').fill('设圆心（a，0），a＞0，再列 r² 方程。')
  await page.screenshot({
    path: testInfo.outputPath('workspace-light.png'),
    fullPage: true,
    animations: 'disabled',
  })
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.screenshot({
    path: testInfo.outputPath('workspace-dark.png'),
    fullPage: true,
    animations: 'disabled',
  })
  await trigger(page).click()
  await palette(page).getByRole('combobox').fill('数学')
  await page.screenshot({
    path: testInfo.outputPath('workspace-search.png'),
    fullPage: true,
    animations: 'disabled',
  })
  await page.keyboard.press('Escape')
  for (const width of [390, 650, 760, 1100, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true)
    await expect(trigger(page)).toBeVisible()
  }
  await page.setViewportSize({ width: 390, height: 900 })
  await page.screenshot({
    path: testInfo.outputPath('workspace-narrow.png'),
    fullPage: true,
    animations: 'disabled',
  })
})
