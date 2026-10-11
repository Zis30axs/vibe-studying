import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('math tools: drag, precise edits, measurements, function, undo, snapshots and restart', async () => {
  test.setTimeout(90000)
  const userData = await mkdtemp(join(tmpdir(), 'examcraft-math-e2e-'))
  let app: ElectronApplication | undefined
  async function launch() {
    const env = Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
    )
    delete env.ELECTRON_RUN_AS_NODE
    delete env.EXAMCRAFT_DEV_URL
    env.EXAMCRAFT_USER_DATA = userData
    app = await electron.launch({ args: ['.'], env })
    const page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setContentSize(1440, 960)
    })
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1440)
    await page
      .getByRole('navigation')
      .getByRole('button', { name: /数学工作台/ })
      .click()
    await page.locator('.question-item').filter({ hasText: '解一元一次方程' }).click()
    await expect(page.getByRole('button', { name: '数学交互工作台', exact: true })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    return page
  }
  try {
    let page = await launch()
    let work = page.getByRole('region', { name: '数学交互工作台', exact: true })
    async function add(label: string, x: string, y: string) {
      await work.getByLabel('数学点标记', { exact: true }).fill(label)
      await work.getByLabel('数学 X 坐标', { exact: true }).fill(x)
      await work.getByLabel('数学 Y 坐标', { exact: true }).fill(y)
      await work.getByRole('button', { name: '添加数学点', exact: true }).click()
    }
    await add('A', '0', '0')
    await work.getByRole('button', { name: '新建数学点', exact: true }).click()
    await add('B', '3', '0')
    await work.getByRole('button', { name: '新建数学点', exact: true }).click()
    await add('C', '3', '4')
    await work.getByLabel('数学连线起点').selectOption({ label: 'A (0, 0)' })
    await work.getByLabel('数学连线终点').selectOption({ label: 'B (3, 0)' })
    await work.getByRole('button', { name: '添加数学线段', exact: true }).click()
    await work.getByRole('button', { name: '测量', exact: true }).click()
    const points = work.getByLabel('数学点列表')
    await points.getByRole('button', { name: 'A (0, 0)', exact: true }).click()
    await points.getByRole('button', { name: 'B (3, 0)', exact: true }).click()
    await expect(work.getByText('距离 A → B = 3.000', { exact: true })).toBeVisible()
    await points.getByRole('button', { name: 'C (3, 4)', exact: true }).click()
    await expect(work.getByText('∠ABC = 90.00°', { exact: true })).toBeVisible()
    await work.getByRole('button', { name: '移动点', exact: true }).click()
    const point = work.getByRole('button', { name: '数学点 C (3, 4)', exact: true })
    await point.scrollIntoViewIfNeeded()
    const box = (await point.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 25, box.y + box.height / 2 + 15, { steps: 8 })
    await page.mouse.up()
    await expect(work.getByLabel('数学 X 坐标', { exact: true })).not.toHaveValue('3')
    await work.getByRole('button', { name: '撤销', exact: true }).click()
    await expect(work.getByRole('button', { name: '数学点 C (3, 4)', exact: true })).toBeVisible()
    await work.getByRole('button', { name: '清除函数', exact: true }).click()
    await expect(work.getByTestId('function-curve')).toHaveCount(0)
    await work.getByRole('button', { name: '撤销', exact: true }).click()
    await work.getByLabel('参数 a 数值').fill('-2')
    await expect(work.getByLabel('参数 a 滑块')).toHaveValue('-2')
    await work.getByLabel('函数表达式').fill('window.alert(1)')
    await work.getByRole('button', { name: '应用函数', exact: true }).click()
    await expect(work.getByRole('status')).toContainText('不支持')
    await work.getByLabel('函数表达式').fill('y = a/(x-b)+c')
    await expect(work.getByText('识别为：y = a/(x-b)+c', { exact: true })).toBeVisible()
    await work.getByRole('button', { name: '应用函数', exact: true }).click()
    await work.getByLabel('参数 a 数值').fill('2')
    await expect(work.getByTestId('function-curve')).toHaveCount(2)
    await work.getByLabel('参数 b 滑块').focus()
    await page.keyboard.press('ArrowRight')
    await expect(work.getByLabel('参数 b 数值')).toHaveValue('0.1')
    await work.getByRole('button', { name: '重置工具', exact: true }).click()
    await work.getByRole('button', { name: '取消', exact: true }).click()
    await expect(work.getByText('3 个点 · 1 条线', { exact: true })).toBeVisible()
    await work.getByRole('button', { name: '重置工具', exact: true }).click()
    await work.getByRole('button', { name: '确认重置', exact: true }).click()
    await expect(work.getByText('0 个点 · 0 条线', { exact: true })).toBeVisible()
    await work.getByRole('button', { name: '撤销', exact: true }).click()
    await expect(work.getByText('3 个点 · 1 条线', { exact: true })).toBeVisible()
    await points.getByRole('button', { name: 'B (3, 0)', exact: true }).click()
    await work.getByRole('button', { name: '删除数学点及关联线', exact: true }).click()
    await expect(work.getByText('2 个点 · 0 条线', { exact: true })).toBeVisible()
    await work.getByRole('button', { name: '撤销', exact: true }).click()
    await work.getByLabel('坐标吸附步长').fill('0.125')
    await work.getByRole('button', { name: '应用步长', exact: true }).click()
    await work.getByRole('checkbox', { name: '显示轴距投影（I）' }).uncheck()
    await work.getByRole('button', { name: '作垂线', exact: true }).click()
    await work.getByLabel('垂线过点', { exact: true }).selectOption({ label: 'C (3, 4)' })
    await work.getByLabel('垂线直线起点').selectOption({ label: 'A (0, 0)' })
    await work.getByLabel('垂线直线终点').selectOption({ label: 'B (3, 0)' })
    await work.getByRole('button', { name: '构造垂线', exact: true }).click()
    await expect(work.getByTestId('math-right-angle')).toHaveCount(1)
    await work.getByRole('button', { name: '载入立方体示例', exact: true }).click()
    await expect(work.getByTestId('geometry-point')).toHaveCount(8)
    await expect
      .poll(async () => {
        const state = await page.evaluate(() => window.examcraft!.loadState())
        return state.drafts['math-solution-1'].math?.geometry?.points.length
      })
      .toBe(8)
    await page.getByLabel('解题步骤与结论').fill('3x - 6 = 2x + 5，所以 x = 11。代回两边均为27。')
    await expect(page.getByText('已保存到本机', { exact: true })).toBeVisible()
    await app!.close()
    app = undefined
    page = await launch()
    work = page.getByRole('region', { name: '数学交互工作台', exact: true })
    await expect(work.getByLabel('函数表达式')).toHaveValue('a/(x-b)+c')
    await expect(work.getByLabel('参数 a 数值')).toHaveValue('2')
    await expect(work.getByLabel('坐标吸附步长')).toHaveValue('0.125')
    await expect(work.getByRole('checkbox', { name: '显示轴距投影（I）' })).not.toBeChecked()
    await expect(work.getByText('∠ABC = 90.00°', { exact: true })).toBeVisible()
    await expect(work.getByTestId('math-right-angle')).toHaveCount(1)
    await expect(work.getByTestId('geometry-point')).toHaveCount(8)
    await page.getByRole('button', { name: '提交并审阅', exact: true }).click()
    await page.getByText(/查看本次提交的答案/).click()
    await expect(page.getByLabel('审阅结果').getByLabel('函数表达式')).toHaveValue('a/(x-b)+c')
    await expect(page.getByLabel('审阅结果').getByLabel('函数表达式')).toBeDisabled()
    await expect(page.getByLabel('审阅结果').getByTestId('geometry-point')).toHaveCount(8)
    await expect(page.getByLabel('审阅结果').getByLabel('三维 X 坐标')).toBeDisabled()
    await page.getByRole('button', { name: /重新练习/ }).click()
    await expect(page.getByLabel('函数表达式')).toHaveValue('a*x^2+b*x+c')
    await expect(work.getByText('当前已保存：a*x^2+b*x+c', { exact: true })).toBeVisible()
    await expect(work.getByTestId('math-right-angle')).toHaveCount(0)
    await expect(work.getByTestId('geometry-point')).toHaveCount(0)
    await expect(work.getByLabel('参数 a 数值')).toHaveValue('1')
    await expect(work.getByText('0 个点 · 0 条线', { exact: true })).toBeVisible()
    await expect
      .poll(async () => {
        const state = await page.evaluate(() => window.examcraft!.loadState())
        return state.drafts['math-solution-1'].math?.expression
      })
      .toBe('a*x^2+b*x+c')
    await page
      .getByRole('navigation')
      .getByRole('button', { name: /练习记录/ })
      .click()
    await page.locator('.history-item').click()
    await page.getByText(/查看本次提交的答案/).click()
    await expect(page.getByLabel('函数表达式')).toHaveValue('a/(x-b)+c')
    await expect(page.getByTestId('geometry-point')).toHaveCount(8)
    await expect(page.getByTestId('math-right-angle')).toHaveCount(1)
    await expect(page.getByRole('alert')).toHaveCount(0)
  } finally {
    await app?.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})
