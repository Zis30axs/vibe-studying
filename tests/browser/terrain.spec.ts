import { expect, test, type Page } from '@playwright/test'
import type { ExamCraftApi, StudentQuestion } from '../../src/shared/types'
import { DEFAULT_TERRAIN } from '../../src/domain/terrain'
import { compileTerrainExercise } from '../../src/domain/terrain-exercise'

const compiled = compileTerrainExercise({ terrain: DEFAULT_TERRAIN, section: 'west-center' })
const question: StudentQuestion = {
  id: 'terrain-browser-fixture',
  subject: 'geography',
  kind: 'geography',
  title: compiled.title,
  prompt: compiled.prompt,
  source: 'Synthetic browser fixture',
  tags: [],
  maxScore: 8,
  terrain: compiled.terrain,
}
async function open(page: Page) {
  await page.addInitScript(
    ({ question }) => {
      const api: Partial<ExamCraftApi> = {
        listQuestions: async () => [question],
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
      window.examcraft = api as ExamCraftApi
    },
    { question },
  )
  await page.goto('/')
  await page
    .getByRole('navigation')
    .getByRole('button', { name: /地理工作台/ })
    .click()
}
test('local terrain controls change contours and calculate probes/profiles without external requests', async ({
  page,
}) => {
  const outgoing: string[] = []
  page.on('request', (request) => {
    if (/^https?:/.test(request.url()) && !request.url().startsWith('http://127.0.0.1:5174'))
      outgoing.push(request.url())
  })
  await open(page)
  await page.locator('.terrain-workbench > summary').click()
  const panel = page.getByRole('region', { name: '教学地形实验', exact: true })
  await expect(panel).toContainText('非实测 DEM')
  await expect(panel.getByRole('img', { name: '模拟教学等高线图', exact: true })).toBeVisible()
  const initialCount = await panel.locator('.terrain-contours polyline').count()
  await panel.getByLabel('教学等高距', { exact: true }).selectOption('100')
  expect(await panel.locator('.terrain-contours polyline').count()).toBeLessThan(initialCount)
  await panel.getByRole('button', { name: '查询地形高程', exact: true }).click()
  await expect(panel.getByLabel('地形探测结果')).toHaveText('(1000, 1000) → 500 m')
  await panel.getByLabel('教学地形预设', { exact: true }).selectOption('depression')
  await expect(panel.getByLabel('地形探测结果')).toHaveText('(1000, 1000) → 100 m')
  await panel.getByLabel('教学地形预设', { exact: true }).selectOption('plane')
  await panel.getByLabel('地形剖面 B x (m)', { exact: true }).fill('1000')
  await panel.getByRole('button', { name: '计算地形剖面', exact: true }).click()
  await expect(panel.locator('.terrain-readout')).toContainText('水平距离 750 m')
  await expect(panel.locator('.terrain-readout')).toContainText('端点平均坡度 20%')
  await panel.getByLabel('地形剖面 A x (m)', { exact: true }).fill('1000')
  await panel.getByRole('button', { name: '计算地形剖面', exact: true }).click()
  await expect(panel.getByRole('alert')).toContainText('至少相距')
  await expect(panel.locator('.terrain-readout')).toContainText('水平距离 750 m')
  await page.locator('.terrain-workbench > summary').click()
  await page.locator('.terrain-workbench > summary').click()
  await expect(panel.locator('.terrain-readout')).toContainText('水平距离 750 m')
  expect(outgoing).toEqual([])
})
test('public terrain question displays calibrated contours without reference profile or expected answers', async ({
  page,
}) => {
  await open(page)
  const prompt = page.locator('.question-prompt')
  await expect(prompt.locator('.terrain-figure')).toBeVisible()
  await expect(prompt).toContainText('等高距 50 m')
  await expect(prompt).toContainText('A(250, 1000)')
  await expect(prompt.locator('.terrain-profile')).toHaveCount(0)
  await expect(prompt).not.toContainText('30%')
  const response = await page.evaluate(() => window.examcraft!.listQuestions())
  expect(response[0]).not.toHaveProperty('rubric')
  expect(response[0]).not.toHaveProperty('explanation')
  for (const viewport of [
    { width: 1440, height: 1050 },
    { width: 900, height: 760 },
  ]) {
    await page.setViewportSize(viewport)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true)
  }
})
