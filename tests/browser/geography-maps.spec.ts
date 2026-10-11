import { expect, test, type Page } from '@playwright/test'
import type { AnswerDraft, ExamCraftApi, StudyState } from '../../src/shared/types'

// Renderer regression specification. Real disk/snapshot persistence is separately
// exercised by geography-map-persistence.test.ts. Browser execution may be blocked
// by the runner's Chromium sandbox; static/unit checks are not a browser pass.
declare global {
  interface Window {
    geographyMapTest: { state: StudyState; saves: AnswerDraft[] }
  }
}
const workbench = (page: Page) => page.getByRole('region', { name: '地理绘图工作台', exact: true })
async function openGeography(page: Page, oldCartesian = false) {
  await page.addInitScript(
    ({ oldCartesian }) => {
      const state: StudyState = JSON.parse(
        sessionStorage.getItem('synthetic-geography-state') ||
          '{"version":1,"drafts":{},"attempts":[]}',
      )
      if (oldCartesian && !state.drafts['geo-map-fixture'])
        state.drafts['geo-map-fixture'] = {
          text: '',
          blocks: [],
          drawing: {
            mode: 'cartesian',
            points: [{ id: 'old-a', x: 2, y: 3, label: '旧图' }],
            lines: [],
          },
        }
      window.geographyMapTest = { state, saves: [] }
      const api: Partial<ExamCraftApi> = {
        listQuestions: async () => [
          {
            id: 'geo-map-fixture',
            subject: 'geography',
            kind: 'geography',
            title: '离线地图回归',
            prompt: '标注位置并比较方向。',
            source: 'Synthetic browser fixture',
            tags: [],
            maxScore: 10,
          },
        ],
        loadState: async () => structuredClone(state),
        getCapabilities: async () => ({
          questionBank: 'Fixture',
          reviewer: 'Fixture',
          mcp: 'Fixture',
        }),
        getModelProfiles: async () => ({
          revision: 1,
          secureStorageAvailable: false,
          profiles: [],
          roles: { parent: '', child: '' },
        }),
        getGitHubProfile: async () => null,
        listKnowledgeDocuments: async () => [],
        getGenerationStatus: async () => ({ used: 0, pending: 0, limit: 5 }),
        saveDraft: async (id, draft) => {
          state.drafts[id] = structuredClone(draft)
          window.geographyMapTest.saves.push(structuredClone(draft))
          sessionStorage.setItem('synthetic-geography-state', JSON.stringify(state))
        },
        cancelAdvisor: async () => {},
        cancelModuleReview: async () => {},
        cancelQuestionGeneration: async () => {},
      }
      window.examcraft = api as ExamCraftApi
    },
    { oldCartesian },
  )
  await page.goto('/')
  await page
    .getByRole('navigation')
    .getByRole('button', { name: /地理工作台/ })
    .click()
  await expect(workbench(page)).toBeVisible()
}

test('new world map supports terrain, labelled Admin1, aligned zoom points, toggles and reload', async ({
  page,
}) => {
  const externalMapRequests: string[] = []
  const adminRequests: string[] = []
  page.on('request', (request) => {
    if (/naturalearthdata\.com|googleapis\.com|tianditu/.test(request.url()))
      externalMapRequests.push(request.url())
    if (request.url().includes('natural-earth-admin1')) adminRequests.push(request.url())
  })
  await openGeography(page)
  const work = workbench(page)
  await expect(work.getByTestId('geography-land')).toBeVisible()
  expect(adminRequests).toEqual([])
  await expect(work.getByRole('button', { name: '世界轮廓', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await work.getByLabel('点标记', { exact: true }).fill('北京参考点')
  await work.getByLabel('经度', { exact: true }).fill('116.4')
  await work.getByLabel('纬度', { exact: true }).fill('39.9')
  await work.getByRole('button', { name: '添加点', exact: true }).click()
  await work.getByRole('button', { name: '定位选点', exact: true }).click()
  const marker = work.getByRole('button', {
    name: '选择点 北京参考点，坐标 116.4, 39.9',
    exact: true,
  })
  const before = { x: await marker.getAttribute('cx'), y: await marker.getAttribute('cy') }
  await work.getByRole('button', { name: '自然地理', exact: true }).click()
  await expect(work.getByTestId('geography-terrain')).toBeVisible()
  await work.getByRole('button', { name: '省州参考', exact: true }).click()
  await expect(work.getByTestId('admin1-boundary')).toBeVisible()
  await expect(work.getByTestId('admin1-label').first()).toBeVisible()
  await expect(work.getByText(/不是中国审定标准或 Google 美国视图/)).toBeVisible()
  expect(await work.getByTestId('admin1-label').count()).toBeLessThanOrEqual(70)
  expect({ x: await marker.getAttribute('cx'), y: await marker.getAttribute('cy') }).toEqual(before)
  await work.getByLabel('省州名称', { exact: true }).uncheck()
  await expect(work.getByTestId('admin1-label')).toHaveCount(0)
  await work.getByLabel('经纬网', { exact: true }).uncheck()
  await expect(work.locator('.geo-grid-line')).toHaveCount(0)
  await expect
    .poll(() =>
      page.evaluate(
        () => window.geographyMapTest.state.drafts['geo-map-fixture']?.drawing.map?.showGrid,
      ),
    )
    .toBe(false)
  await page.reload()
  await page
    .getByRole('navigation')
    .getByRole('button', { name: /地理工作台/ })
    .click()
  await expect(work.getByRole('button', { name: '省州参考', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(work.getByLabel('省州名称', { exact: true })).not.toBeChecked()
  await expect(marker).toHaveAttribute('cx', before.x!)
  await expect(marker).toHaveAttribute('cy', before.y!)
  // A direct map click must invert the zoomed/letterboxed SVG transform, not
  // accidentally write world-extent coordinates into the persisted point.
  const target = { x: 125.2345, y: 30.5678 }
  await work.locator('svg.geo-canvas').scrollIntoViewIfNeeded()
  const client = await work.locator('svg.geo-canvas').evaluate((svg, target) => {
    const view = window.geographyMapTest.state.drafts['geo-map-fixture'].drawing.map!
    const rect = svg.getBoundingClientRect()
    const scale = Math.min(rect.width / 800, rect.height / 480)
    const x = 56 + (((target.x - view.longitude) * view.zoom + 180) / 360) * 696
    const y = 436 - (((target.y - view.latitude) * view.zoom + 90) / 180) * 400
    // Native click coordinates are integer CSS pixels in Chromium. Choose that
    // pixel explicitly and verify its inverse at four-decimal precision; the
    // arbitrary geographic target usually falls between addressable pixels.
    const left = rect.left + (rect.width - 800 * scale) / 2
    const top = rect.top + (rect.height - 480 * scale) / 2
    const clientX = Math.round(left + x * scale)
    const clientY = Math.round(top + y * scale)
    return {
      x: clientX,
      y: clientY,
      expected: {
        x: view.longitude + ((((clientX - left) / scale - 56) / 696) * 360 - 180) / view.zoom,
        y: view.latitude + (((436 - (clientY - top) / scale) / 400) * 180 - 90) / view.zoom,
      },
      halfPixel: { x: 180 / (696 * scale * view.zoom), y: 90 / (400 * scale * view.zoom) },
    }
  }, target)
  expect(Math.abs(client.expected.x - target.x)).toBeLessThanOrEqual(client.halfPixel.x)
  expect(Math.abs(client.expected.y - target.y)).toBeLessThanOrEqual(client.halfPixel.y)
  await page.mouse.click(client.x, client.y)
  await expect
    .poll(() =>
      page.evaluate(
        () => window.geographyMapTest.state.drafts['geo-map-fixture'].drawing.points.length,
      ),
    )
    .toBe(2)
  const clicked = await page.evaluate(() =>
    window.geographyMapTest.state.drafts['geo-map-fixture'].drawing.points.at(-1)!,
  )
  expect(clicked.x).toBeCloseTo(client.expected.x, 4)
  expect(clicked.y).toBeCloseTo(client.expected.y, 4)
  expect(externalMapRequests).toEqual([])
})

test('saved Cartesian work remains unchanged and cancelled coordinate reset preserves annotations', async ({
  page,
}) => {
  await openGeography(page, true)
  const work = workbench(page)
  await expect(work.getByTestId('geography-basemap')).toHaveCount(0)
  await expect(work.getByRole('button', { name: '旧图 (2, 3)', exact: true })).toBeVisible()
  await work.getByRole('button', { name: '直角坐标 ⇄', exact: true }).click()
  await work.getByRole('button', { name: '取消', exact: true }).click()
  await expect(work.getByRole('button', { name: '旧图 (2, 3)', exact: true })).toBeVisible()
  await work.getByRole('button', { name: '直角坐标 ⇄', exact: true }).click()
  await work.getByRole('button', { name: '切换并清空', exact: true }).click()
  await expect(work.getByTestId('geography-land')).toBeVisible()
  await work.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(work.getByTestId('geography-basemap')).toHaveCount(0)
  await expect(work.getByRole('button', { name: '旧图 (2, 3)', exact: true })).toBeVisible()
})
