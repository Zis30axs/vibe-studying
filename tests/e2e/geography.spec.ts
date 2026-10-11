import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

async function launchWorkspace(
  userData: string,
): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  delete env.ELECTRON_RUN_AS_NODE
  delete env.EXAMCRAFT_DEV_URL
  env.EXAMCRAFT_USER_DATA = userData
  const app = await electron.launch({ args: ['.'], env })
  try {
    const page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setContentSize(1440, 960)
    })
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1440)
    await expect(page.getByRole('heading', { name: '今天，理解得更深一点。' })).toBeVisible()
    await page
      .getByRole('navigation', { name: '工作区导航' })
      .getByRole('button', { name: /地理工作台/ })
      .click()
    await expect(page.getByRole('button', { name: '地理交互工作台', exact: true })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    await expect(page.getByRole('region', { name: '地理绘图工作台', exact: true })).toBeVisible()
    return { app, page }
  } catch (error) {
    await app.close()
    throw error
  }
}

async function addPoint(workbench: Locator, label: string, x: string, y: string) {
  await workbench.getByLabel('点标记', { exact: true }).fill(label)
  await workbench.getByLabel('X 坐标', { exact: true }).fill(x)
  await workbench.getByLabel('Y 坐标', { exact: true }).fill(y)
  await workbench.getByRole('button', { name: '添加点', exact: true }).click()
}

test('geography drawing, confirmation, submission and restart preserve coordinates and edges', async () => {
  const temporaryRoot = resolve(tmpdir())
  const userData = await mkdtemp(join(temporaryRoot, 'examcraft-geo-e2e-'))
  let app: ElectronApplication | undefined
  try {
    const initial = await launchWorkspace(userData)
    app = initial.app
    const page = initial.page
    const workbench = page.getByRole('region', { name: '地理绘图工作台', exact: true })
    // New geography drafts open on the world map. This legacy flow deliberately
    // exercises Cartesian coordinates; switching an empty drawing needs no reset.
    await expect(workbench.getByTestId('geography-land')).toBeVisible()
    await workbench.getByRole('button', { name: '经纬度 ⇄', exact: true }).click()
    await addPoint(workbench, 'A', '1', '2')
    await workbench.getByRole('button', { name: '＋ 新建点', exact: true }).click()
    await addPoint(workbench, 'B', '-3', '4')
    await workbench.getByLabel('连线起点', { exact: true }).selectOption({ label: 'A (1, 2)' })
    await workbench.getByLabel('连线终点', { exact: true }).selectOption({ label: 'B (-3, 4)' })
    await workbench.getByRole('button', { name: '添加线段', exact: true }).click()
    await expect(workbench.getByText('2 个点 · 1 条线', { exact: true })).toBeVisible()

    // Deleting a point must remove its edge, and undo must restore both together.
    await workbench.getByRole('button', { name: 'A (1, 2)', exact: true }).click()
    await workbench.getByRole('button', { name: '删除点及关联线', exact: true }).click()
    await expect(workbench.getByText('1 个点 · 0 条线', { exact: true })).toBeVisible()
    await workbench.getByRole('button', { name: '撤销', exact: true }).click()
    await expect(workbench.getByText('2 个点 · 1 条线', { exact: true })).toBeVisible()

    await workbench.getByRole('button', { name: '直角坐标 ⇄', exact: true }).click()
    await expect(workbench.getByRole('alert')).toContainText('切换坐标系会清空当前图形')
    await workbench.getByRole('button', { name: '取消', exact: true }).click()
    await expect(workbench.getByText('2 个点 · 1 条线', { exact: true })).toBeVisible()
    await workbench.getByRole('button', { name: '直角坐标 ⇄', exact: true }).click()
    await workbench.getByRole('button', { name: '切换并清空', exact: true }).click()
    await expect(workbench.getByRole('button', { name: '经纬度 ⇄', exact: true })).toBeVisible()
    await expect(workbench.getByText('0 个点 · 0 条线', { exact: true })).toBeVisible()
    await workbench.getByRole('button', { name: '撤销', exact: true }).click()
    await expect(workbench.getByRole('button', { name: '直角坐标 ⇄', exact: true })).toBeVisible()
    await expect(workbench.getByText('2 个点 · 1 条线', { exact: true })).toBeVisible()

    const answer = 'A 点位于 B 点的东南方向。坐标差说明位置关系，图示连线连接两个观测位置。'
    await page.getByLabel(/文字说明与补充/).fill(answer)
    await expect(page.getByText('已保存到本机', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: /提交并审阅/ }).click()
    await expect(page.getByRole('region', { name: '审阅结果', exact: true })).toBeVisible()
    await expect(page.getByText('答案与审阅结果已保存', { exact: true })).toBeVisible()
    await page.getByText(/查看本次提交的答案/).click()
    const submitted = page.getByRole('region', { name: '审阅结果', exact: true })
    await expect(submitted.getByText(answer, { exact: true })).toBeVisible()
    await expect(submitted.getByText('2 个点 · 1 条线', { exact: true })).toBeVisible()
    await expect(submitted.getByRole('button', { name: '添加线段', exact: true })).toBeDisabled()

    await app.close()
    app = undefined
    const restarted = await launchWorkspace(userData)
    app = restarted.app
    const restoredPage = restarted.page
    const restoredDrawing = restoredPage.getByRole('region', {
      name: '地理绘图工作台',
      exact: true,
    })
    await expect(restoredDrawing.getByText('2 个点 · 1 条线', { exact: true })).toBeVisible()
    await expect(
      restoredDrawing.getByRole('button', { name: 'A (1, 2)', exact: true }),
    ).toBeVisible()
    await expect(
      restoredDrawing.getByRole('button', { name: 'B (-3, 4)', exact: true }),
    ).toBeVisible()
    await expect(restoredPage.getByLabel(/文字说明与补充/)).toHaveValue(answer)
    await restoredPage.getByRole('tab', { name: /审阅反馈/ }).click()
    await expect(restoredPage.getByRole('region', { name: '审阅结果', exact: true })).toBeVisible()
    await restoredPage.getByText(/查看本次提交的答案/).click()
    await expect(
      restoredPage
        .getByRole('region', { name: '审阅结果', exact: true })
        .getByText('2 个点 · 1 条线', { exact: true }),
    ).toBeVisible()
    await expect(restoredPage.getByRole('alert')).toHaveCount(0)
  } finally {
    if (app) await app.close()
    const resolvedData = resolve(userData)
    if (
      dirname(resolvedData) !== temporaryRoot ||
      !basename(resolvedData).startsWith('examcraft-geo-e2e-')
    )
      throw new Error('Refusing to remove an unexpected test directory')
    await rm(resolvedData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})
