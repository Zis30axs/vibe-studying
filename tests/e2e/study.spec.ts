import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

let userData: string
let app: ElectronApplication | undefined
async function launch() {
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  env.EXAMCRAFT_USER_DATA = userData
  delete env.ELECTRON_RUN_AS_NODE
  delete env.EXAMCRAFT_DEV_URL
  app = await electron.launch({ args: ['.'], env })
  const page = await app.firstWindow()
  await expect(page.getByRole('heading', { name: '今天，理解得更深一点。' })).toBeVisible()
  return page
}
test.beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'examcraft-study-'))
})
test.afterEach(async () => {
  await app?.close()
  app = undefined
  if (
    dirname(resolve(userData)) !== resolve(tmpdir()) ||
    !basename(userData).startsWith('examcraft-study-')
  )
    throw new Error('Unexpected test cleanup path')
  await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

test('choice answer, exact feedback, retry history, draft and restart persistence', async () => {
  let page = await launch()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await expect(page.getByRole('button', { name: '提交并审阅' })).toBeDisabled()
  await expect(page.locator('.explanation')).toHaveCount(0)
  await page.getByRole('radio').nth(1).click()
  await page.getByLabel('思考笔记').fill('先核对实践与认识的关系。')
  await page.getByRole('button', { name: '提交并审阅' }).click()
  await expect(page.getByLabel('审阅结果').locator('.score')).toHaveText('0 / 4')
  await expect(page.getByText('解析与参考思路', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '重新练习' }).click()
  await expect(page.getByRole('radio').nth(1)).toHaveAttribute('aria-checked', 'false')
  await page.getByRole('radio').first().click()
  await page.getByLabel('思考笔记').fill('从走访中获得认识，再通过试点检验。')
  await page.getByRole('button', { name: '提交并审阅' }).click()
  await expect(page.getByLabel('审阅结果').locator('.score')).toHaveText('4 / 4')
  await page.getByRole('tab', { name: '我的作答' }).click()
  await page.getByRole('region', { name: '作答工作区', exact: true }).evaluate((panel) => {
    panel.scrollTop = 0
  })
  await page.screenshot({ path: 'test-results/examcraft-practice.png', fullPage: true })
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(
    await page.evaluate(() => ({
      require: typeof (window as unknown as { require?: unknown }).require,
      process: typeof (window as unknown as { process?: unknown }).process,
    })),
  ).toEqual({ require: 'undefined', process: 'undefined' })
  expect(errors).toEqual([])
  await app!.close()
  app = undefined
  page = await launch()
  await expect(page.getByRole('radio').first()).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByLabel('思考笔记')).toHaveValue('从走访中获得认识，再通过试点检验。')
  await page.getByRole('button', { name: /练习记录 Review/ }).click()
  await expect(page.locator('.history-item')).toHaveCount(2)
  await page.locator('.history-item').last().click()
  await expect(page.getByLabel('审阅结果').locator('.score')).toHaveText('0 / 4')
  await page.getByText(/查看本次提交的答案/).click()
  await expect(
    page
      .getByRole('region', { name: '审阅结果', exact: true })
      .getByText('先核对实践与认识的关系。', { exact: true }),
  ).toBeVisible()
})

test('native JSON import succeeds once, duplicate import preserves existing bank', async () => {
  let page = await launch()
  await app!.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] })
  }, resolve('examples/question-bank.json'))
  await page.getByRole('button', { name: '＋ 导入题库', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '已导入' })).toBeVisible()
  const count = await page.locator('.question-item').count()
  expect(count).toBeGreaterThan(6)
  await page.getByRole('button', { name: '＋ 导入题库', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('题目 ID 已存在')
  await expect(page.locator('.question-item')).toHaveCount(count)
  await app!.close()
  app = undefined
  page = await launch()
  await expect(page.locator('.question-item')).toHaveCount(count)
})

test('closing the window drains a slow in-flight draft write before exit', async () => {
  let page = await launch()
  await app!.evaluate(() => {
    const fs = process.getBuiltinModule('fs/promises')
    const original = fs.open
    fs.open = async (...args: Parameters<typeof original>) => {
      if (String(args[0]).endsWith('.tmp') && args[1] === 'wx')
        await new Promise((resolve) => setTimeout(resolve, 350))
      return original(...args)
    }
  })
  await page.getByLabel('思考笔记').fill('这段草稿在关闭窗口之前仍在写入。')
  const exited = app!.waitForEvent('close')
  await app!.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].close()
  })
  await exited
  app = undefined
  page = await launch()
  await expect(page.getByLabel('思考笔记')).toHaveValue('这段草稿在关闭窗口之前仍在写入。')
})

test('practice keeps the answer beside independently scrolling tools and supports collapse and resizing', async () => {
  const page = await launch()
  // Establish the desktop geometry before exercising the native resize transitions below.
  await app!.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setContentSize(1440, 960)
  })
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1440)
  await expect(page.locator('.learning-overview')).toHaveCount(0)
  await expect(page.getByTestId('activity-heatmap')).toHaveCount(0)
  await page.getByRole('button', { name: '练习记录 Review & reflect', exact: true }).click()
  const overview = page.locator('section.history-overview')
  await expect(overview).toBeVisible()
  await expect(overview.locator('summary')).toHaveCount(0)
  await expect(page.locator('details.learning-overview')).toHaveCount(0)
  await expect(overview.getByTestId('activity-heatmap')).toBeVisible()
  await page.getByRole('button', { name: '题目练习 Practice', exact: true }).click()
  await expect(page.locator('.learning-overview')).toHaveCount(0)
  await expect(page.getByTestId('activity-heatmap')).toHaveCount(0)

  const answer = page.getByRole('region', { name: '作答工作区', exact: true })
  const tools = page.locator('#tools-panel')
  const toolsToggle = page.getByRole('button', { name: /^(?:◫\s*)?工具与顾问$/ })
  await expect(tools).toBeVisible()
  await expect(answer).toHaveCSS('overflow-y', 'auto')
  await expect(tools).toHaveCSS('overflow-y', 'auto')

  for (const item of [
    { subject: '政治', title: '让社区更新回应居民需求', dock: '文科模块工作台' },
    { subject: '地理', title: '在经纬网中定位与连线', dock: '地理交互工作台' },
    { subject: '数学', title: '解一元一次方程', dock: '数学交互工作台' },
  ]) {
    await page
      .getByLabel('按学科筛选')
      .getByRole('button', { name: item.subject, exact: true })
      .click()
    await page.locator('.question-item').filter({ hasText: item.title }).click()
    const dock = tools.getByRole('region', { name: `${item.dock}面板`, exact: true })
    const toggle = dock.getByRole('button', { name: item.dock, exact: true })
    const body = dock.locator('.workbench-dock-body')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(body).toBeHidden()
    expect(
      await dock.evaluate((element) =>
        Boolean(
          document.querySelector('#answer-text')!.compareDocumentPosition(element) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      ),
    ).toBe(true)
    await expect(answer.getByRole('region', { name: `${item.dock}面板`, exact: true })).toHaveCount(
      0,
    )
    const answerBounds = (await answer.boundingBox())!
    const toolsBounds = (await tools.boundingBox())!
    expect(toolsBounds.x).toBeGreaterThanOrEqual(answerBounds.x + answerBounds.width)
    await page.locator('#answer-text').fill(`Compact draft: ${item.subject}`)
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(body).toBeVisible()
    // Dock content grows naturally; the outer tools pane owns scrolling and resizing.
    await expect(body).toHaveCSS('resize', 'none')
    await expect(body).toHaveCSS('overflow-y', 'visible')
    await expect(dock.getByRole('button', { name: '扩大视图', exact: true })).toHaveCount(0)
    await expect(dock.getByRole('button', { name: '紧凑视图', exact: true })).toHaveCount(0)
    if (item.subject === '政治') {
      const canvas = dock.locator('.free-canvas')
      await expect(canvas).toHaveCSS('resize', 'vertical')
      const compactHeight = (await canvas.boundingBox())!.height
      await dock.getByRole('button', { name: '展开画布', exact: true }).click()
      await expect(dock.getByRole('button', { name: '收起画布', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      expect((await canvas.boundingBox())!.height).toBeGreaterThan(compactHeight)
      await dock.getByRole('button', { name: '收起画布', exact: true }).click()
      expect((await canvas.boundingBox())!.height).toBeCloseTo(compactHeight, 0)
    }
    const divider = page.getByRole('separator', { name: '工具与顾问宽度', exact: true })
    const initialWidth = Number(await divider.getAttribute('aria-valuenow'))
    await divider.focus()
    await divider.press('Shift+ArrowLeft')
    await expect(divider).toHaveAttribute('aria-valuenow', String(initialWidth + 40))
    expect((await tools.boundingBox())!.width).toBeGreaterThan(toolsBounds.width)
    await divider.press('Enter')
    await expect(divider).toHaveAttribute('aria-valuenow', String(initialWidth))
    await toggle.click()
    await expect(body).toBeHidden()
    await expect(page.locator('#answer-text')).toHaveValue(`Compact draft: ${item.subject}`)
  }

  // Shorten the real window so both actual panes overflow, without altering their contents.
  await app!.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setMinimumSize(640, 480)
    window.setContentSize(1280, 560)
  })
  await expect.poll(() => page.evaluate(() => window.innerHeight)).toBe(560)
  const mathToggle = tools.getByRole('button', { name: '数学交互工作台', exact: true })
  await mathToggle.click()
  await expect(answer).toHaveCSS('overflow-y', 'auto')
  await expect(tools).toHaveCSS('overflow-y', 'auto')
  expect(await answer.evaluate((panel) => panel.scrollHeight > panel.clientHeight)).toBe(true)
  expect(await tools.evaluate((panel) => panel.scrollHeight > panel.clientHeight)).toBe(true)
  await answer.evaluate((panel) => {
    panel.scrollTop = 0
  })
  await tools.evaluate((panel) => {
    panel.scrollTop = 0
  })
  const pageScroll = await page.evaluate(() => window.scrollY)
  await tools.evaluate((panel) => {
    panel.scrollTop = 120
  })
  await expect.poll(() => tools.evaluate((panel) => panel.scrollTop)).toBeGreaterThan(0)
  expect(await answer.evaluate((panel) => panel.scrollTop)).toBe(0)
  const toolsScroll = await tools.evaluate((panel) => panel.scrollTop)
  await answer.evaluate((panel) => {
    panel.scrollTop = 120
  })
  await expect.poll(() => answer.evaluate((panel) => panel.scrollTop)).toBeGreaterThan(0)
  expect(await tools.evaluate((panel) => panel.scrollTop)).toBe(toolsScroll)
  expect(await page.evaluate(() => window.scrollY)).toBe(pageScroll)
  await mathToggle.click()

  // Opening an overlay is explicit after each resize, including the compact question drawer.
  for (const width of [900, 720, 1280]) {
    await app!.evaluate(({ BrowserWindow }, width) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setMinimumSize(640, 480)
      window.setContentSize(width, 800)
    }, width)
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width)
    await expect(page.locator('#answer-text')).toBeVisible()
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true)
    if (width < 760) {
      await expect(page.locator('#question-panel')).toBeHidden()
      await page.getByRole('button', { name: /^(?:▤\s*)?练习目录$/ }).click()
      await expect(page.getByRole('dialog', { name: '题目列表', exact: true })).toBeVisible()
      await page.locator('.question-item').filter({ hasText: '解一元一次方程' }).click()
      await expect(page.locator('#question-panel')).toBeHidden()
    }
    if (width < 1120) {
      await expect(tools).toBeHidden()
      await expect(toolsToggle).toHaveAttribute('aria-expanded', 'false')
      await toolsToggle.click()
      await expect(tools).toBeVisible()
      await expect(tools).toHaveAttribute('role', 'dialog')
      await expect(tools).toHaveAttribute('aria-modal', 'true')
    } else {
      await expect(tools).toBeVisible()
      await expect(toolsToggle).toHaveAttribute('aria-expanded', 'true')
    }
    await expect(
      tools.getByRole('button', { name: '数学交互工作台', exact: true }),
    ).toHaveAttribute('aria-expanded', 'false')
    if (width < 1120) {
      await tools.getByRole('button', { name: '折叠工具与顾问', exact: true }).click()
      await expect(tools).toBeHidden()
    }
    await expect(page.locator('#answer-text')).toHaveValue('Compact draft: 数学')
  }
  await expect(page.getByRole('alert')).toHaveCount(0)
})
