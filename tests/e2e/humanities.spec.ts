import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

let userData: string
let app: ElectronApplication | undefined
let pageErrors: string[]

async function launch() {
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  env.EXAMCRAFT_USER_DATA = userData
  delete env.ELECTRON_RUN_AS_NODE
  delete env.EXAMCRAFT_DEV_URL
  delete env.DEEPSEEK_API_KEY
  delete env.EXAMCRAFT_DEEPSEEK_MODEL
  app = await electron.launch({ args: ['.'], env })
  // Electron contexts are created outside Playwright's page fixture, so the
  // configured test trace alone does not contain their snapshots or input log.
  await app.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
  const page = await app.firstWindow()
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await expect(page.getByRole('heading', { name: '今天，理解得更深一点。' })).toBeVisible()
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(1600, 1100)
  })
  await page
    .getByRole('navigation', { name: '工作区导航' })
    .getByRole('button', { name: /文科组装 Argument/ })
    .click()
  await expect(page.getByTestId('humanities-composer')).toBeVisible()
  return page
}

test.beforeEach(async () => {
  pageErrors = []
  userData = await mkdtemp(join(tmpdir(), 'examcraft-humanities-e2e-'))
})

test.afterEach(async ({}, testInfo) => {
  if (app) {
    const tracePath = testInfo.outputPath('electron-trace.zip')
    const failed = testInfo.status !== testInfo.expectedStatus || pageErrors.length > 0
    const window = app.windows().find((window) => !window.isClosed())
    if (failed && window)
      await testInfo.attach('electron-screenshot', {
        body: await window.screenshot({ fullPage: true }),
        contentType: 'image/png',
      })
    await app.context().tracing.stop(failed ? { path: tracePath } : {})
    if (failed)
      await testInfo.attach('electron-trace', { path: tracePath, contentType: 'application/zip' })
  }
  await app?.close()
  app = undefined
  const resolvedData = resolve(userData)
  if (
    dirname(resolvedData) !== resolve(tmpdir()) ||
    !basename(resolvedData).startsWith('examcraft-humanities-e2e-')
  )
    throw new Error('Refusing to remove an unexpected test directory')
  await rm(resolvedData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  expect(pageErrors).toEqual([])
})

const canvas = (page: Page) => page.getByTestId('argument-canvas')
const nodes = (page: Page) => canvas(page).locator('[data-block-id]')

async function nodeIds(page: Page) {
  return nodes(page).evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-block-id')!),
  )
}

async function structure(page: Page) {
  return nodes(page).evaluateAll((elements) =>
    elements.map((element) => ({
      id: element.getAttribute('data-block-id'),
      kind: element.getAttribute('data-block-kind'),
      parent: element.getAttribute('data-parent-id') || null,
    })),
  )
}

async function rootIds(page: Page) {
  return (await structure(page)).filter((node) => node.parent === null).map((node) => node.id)
}

async function activate(control: Locator) {
  // Native button activation is the keyboard alternative to every drag operation.
  await control.focus()
  await control.press('Enter')
}

async function selectNode(page: Page, id: string) {
  const outline = page.locator('.free-outline')
  if ((await outline.getAttribute('open')) === null) await outline.locator('summary').click()
  await activate(page.getByTestId(`select-${id}`))
}

async function addWithKeyboard(page: Page, kind: string, target?: string) {
  const before = await nodeIds(page)
  await activate(page.getByTestId(`palette-${kind}`))
  await activate(page.getByTestId('place-center'))
  await expect(nodes(page)).toHaveCount(before.length + 1)
  await page.getByRole('button', { name: '适应全部', exact: true }).click()
  const id = (await nodeIds(page)).find((id) => !before.includes(id))!
  if (target?.startsWith('drop-inside-'))
    await page.getByTestId('argument-parent').selectOption(target.slice('drop-inside-'.length))
  return id
}

async function addWithDrag(page: Page, kind: string, x: number, y: number) {
  const before = await nodeIds(page)
  await page.getByTestId(`palette-${kind}`).dragTo(canvas(page), { targetPosition: { x, y } })
  await expect(nodes(page)).toHaveCount(before.length + 1)
  return (await nodeIds(page)).find((id) => !before.includes(id))!
}

async function dragNode(page: Page, id: string, dx: number, dy: number) {
  await selectNode(page, id)
  const handle = page.getByTestId(`drag-${id}`)
  await handle.scrollIntoViewIfNeeded()
  const box = await handle.boundingBox()
  if (!box) throw new Error('Missing drag handle')
  await page.mouse.move(box.x + 20, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 20 + dx, box.y + box.height / 2 + dy, { steps: 10 })
  await page.mouse.up()
}

async function selectSubject(page: Page, subject: string, title: string) {
  await page.getByLabel('按学科筛选').getByRole('button', { name: subject, exact: true }).click()
  await page.locator('.question-item').filter({ hasText: title }).click()
  await expect(page.getByTestId('humanities-composer')).toBeVisible()
}

test('real palette drags and pointer moves freely without changing logical order; connections reject cycles', async () => {
  const page = await launch()
  const first = await addWithDrag(page, 'principle', 31, 27)
  const second = await addWithDrag(page, 'principle', 290, 101)
  await page.getByTestId(`text-${first}`).fill('第一条原理，只编辑这一份。')
  await expect(page.getByTestId(`text-${second}`)).toHaveValue('')
  await page.getByTestId(`text-${second}`).fill('第二条原理，独立保留。')
  const original = await structure(page)
  const x = Number(await page.getByTestId(`block-${first}`).getAttribute('data-x'))
  await dragNode(page, first, 83, 41)
  await expect
    .poll(async () => Number(await page.getByTestId(`block-${first}`).getAttribute('data-x')))
    .toBeCloseTo(x + 83, 0)
  await expect.poll(() => structure(page)).toEqual(original)
  await expect(page.getByTestId('argument-preview')).toHaveValue(/第一条原理[\s\S]*第二条原理/)
  await selectNode(page, second)
  await activate(page.getByTestId(`move-up-${second}`))
  await expect.poll(() => rootIds(page)).toEqual([second, first])
  const cause = await addWithKeyboard(page, 'cause')
  const point = await addWithKeyboard(page, 'point', `drop-inside-${cause}`)
  await selectNode(page, first)
  await page.getByTestId('argument-parent').selectOption(point)
  await expect.poll(() => rootIds(page)).toEqual([second, cause])
  await selectNode(page, cause)
  await expect(page.getByTestId('argument-parent').locator(`option[value="${cause}"]`)).toHaveCount(
    0,
  )
  await expect(page.getByTestId('argument-parent').locator(`option[value="${point}"]`)).toHaveCount(
    0,
  )
  await expect(nodes(page)).toHaveCount(4)
  await expect(page.locator('#answer-text')).toHaveValue('')
})

test('keyboard movement, explicit nesting and undo preserve independent content and placement', async () => {
  const page = await launch()
  const principle = await addWithKeyboard(page, 'principle')
  const material = await addWithKeyboard(page, 'material')
  const point = await addWithKeyboard(page, 'point')
  await page.getByTestId(`text-${principle}`).fill('实践是认识的来源。')
  await page.getByTestId(`text-${material}`).fill('居民议事会和实地走访。')
  await selectNode(page, material)
  const block = page.getByTestId(`block-${material}`)
  const x = Number(await block.getAttribute('data-x'))
  await page.getByTestId(`drag-${material}`).focus()
  await page.getByTestId(`drag-${material}`).press('ArrowRight')
  await expect(block).toHaveAttribute('data-x', String(x + 10))
  await activate(page.getByTestId('undo-argument'))
  await expect(block).toHaveAttribute('data-x', String(x))
  await selectNode(page, material)
  await activate(page.getByTestId(`move-up-${material}`))
  await expect.poll(() => rootIds(page)).toEqual([material, principle, point])
  await activate(page.getByTestId(`move-down-${material}`))
  await page.getByTestId('argument-parent').selectOption(point)
  await expect(block).toHaveAttribute('data-parent-id', point)
  await page.getByTestId('argument-parent').selectOption('')
  await expect(block).toHaveAttribute('data-parent-id', '')
  await page.getByTestId('argument-parent').selectOption(point)
  const beforeRemoval = await structure(page)
  const beforePosition = await block.getAttribute('data-x')
  await selectNode(page, point)
  await activate(page.getByTestId(`remove-${point}`))
  await expect(nodes(page)).toHaveCount(1)
  await activate(page.getByTestId('undo-argument'))
  await expect.poll(() => structure(page)).toEqual(beforeRemoval)
  await expect(block).toHaveAttribute('data-x', beforePosition!)
  await expect(page.getByTestId(`text-${material}`)).toHaveValue('居民议事会和实地走访。')
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('manual final text survives block edits and overwrite sync requires confirmation', async () => {
  const page = await launch()
  const principle = await addWithKeyboard(page, 'principle')
  const original = '实践决定认识。通过走访调查，在试点中检验并完善方案。'
  const edited = '实践决定认识。通过居民议事会和走访调查，在试点中检验并优化方案。'
  const manual = '这是我手动写好的最终正文，不应被模块编辑静默覆盖。'
  await page.getByTestId(`text-${principle}`).fill(original)
  await expect(page.getByTestId('argument-preview')).toHaveValue(original)
  await expect(page.locator('#answer-text')).toHaveValue('')
  await expect(page.getByRole('button', { name: '提交并审阅', exact: true })).toBeDisabled()

  // An empty body can be explicitly filled without an overwrite confirmation.
  await page.getByTestId('sync-argument').click()
  await expect(page.locator('#answer-text')).toHaveValue(original)
  await expect(page.getByTestId('confirm-sync')).toHaveCount(0)
  await page.locator('#answer-text').fill(manual)
  await page.getByTestId(`text-${principle}`).fill(edited)
  await expect(page.getByTestId('argument-preview')).toHaveValue(edited)
  await expect(page.locator('#answer-text')).toHaveValue(manual)
  await page.getByTestId('sync-argument').click()
  await expect(page.getByTestId('confirm-sync')).toBeVisible()
  await page.getByTestId('cancel-sync').click()
  await expect(page.locator('#answer-text')).toHaveValue(manual)
  await expect(page.getByTestId('confirm-sync')).toHaveCount(0)
  await page.getByTestId('sync-argument').click()
  await page.getByTestId('confirm-sync').click()
  await expect(page.locator('#answer-text')).toHaveValue(edited)
  await expect(page.getByRole('button', { name: '提交并审阅', exact: true })).toBeEnabled()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('four humanities subjects offer structure templates, isolate drafts and retain geography drawing', async () => {
  const page = await launch()
  await expect(page.getByLabel('按学科筛选').getByRole('button')).toHaveText([
    '全部',
    '语文',
    '政治',
    '历史',
    '地理',
  ])
  await expect(page.locator('.question-item')).toHaveCount(6)
  const cases = [
    { subject: '政治', title: '让社区更新回应居民需求', template: 'argument', count: 5 },
    { subject: '历史', title: '从两则记录认识交通变化', template: 'cause', count: 4 },
    { subject: '语文', title: '旧书摊前的停留', template: 'contrast', count: 7 },
    { subject: '地理', title: '在经纬网中定位与连线', template: 'points', count: 10 },
  ]
  const savedNodes = new Map<string, string[]>()
  for (const item of cases) {
    await selectSubject(page, item.subject, item.title)
    await expect(nodes(page)).toHaveCount(0)
    if (item.subject === '地理') {
      const drawing = page.getByRole('region', { name: '地理绘图工作台', exact: true })
      await drawing.getByLabel('点标记', { exact: true }).fill('A')
      await drawing.getByLabel('X 坐标', { exact: true }).fill('1')
      await drawing.getByLabel('Y 坐标', { exact: true }).fill('2')
      await drawing.getByRole('button', { name: '添加点', exact: true }).click()
      await expect(drawing.getByText('1 个点 · 0 条线', { exact: true })).toBeVisible()
    }
    await page.locator('.free-template > summary').click()
    await page.getByTestId('argument-template').selectOption(item.template)
    await page.getByTestId('apply-template').click()
    await expect(nodes(page)).toHaveCount(item.count)
    await page.getByRole('button', { name: '适应全部', exact: true }).click()
    const ids = await nodeIds(page)
    savedNodes.set(item.subject, ids)
    await page.getByTestId(`text-${ids.at(-1)}`).fill(`${item.subject}的独立草稿。`)
    await page.locator('#answer-text').fill(`${item.subject}的手动正文。`)
    await expect(page.getByTestId('argument-preview')).toHaveValue(
      new RegExp(`${item.subject}的独立草稿。`),
    )
    if (item.subject === '地理') {
      const drawing = page.getByRole('region', { name: '地理绘图工作台', exact: true })
      await expect(drawing.getByText('1 个点 · 0 条线', { exact: true })).toBeVisible()
      await expect(drawing.getByRole('button', { name: 'A (1, 2)', exact: true })).toBeVisible()
    }
  }
  for (const item of cases) {
    await selectSubject(page, item.subject, item.title)
    await expect.poll(() => nodeIds(page)).toEqual(savedNodes.get(item.subject))
    await expect(page.locator('#answer-text')).toHaveValue(`${item.subject}的手动正文。`)
  }
  // Applying another template appends a separate structure without replacing work.
  await selectSubject(page, '政治', '让社区更新回应居民需求')
  await page.locator('.free-template > summary').click()
  await page.getByTestId('argument-template').selectOption('cause')
  await page.getByTestId('apply-template').click()
  await expect(nodes(page)).toHaveCount(9)
  const originalIds = savedNodes.get('政治')!
  expect((await nodeIds(page)).slice(0, originalIds.length)).toEqual(originalIds)
  await expect(page.getByTestId(`text-${originalIds.at(-1)}`)).toHaveValue('政治的独立草稿。')
  await expect(page.locator('#answer-text')).toHaveValue('政治的手动正文。')
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('nested drafts and manual text survive restart while submission history stays immutable', async () => {
  let page = await launch()
  const point = await addWithKeyboard(page, 'point')
  const principle = await addWithKeyboard(page, 'principle', `drop-inside-${point}`)
  const material = await addWithKeyboard(page, 'material', `drop-inside-${point}`)
  const submittedMaterial = '提交时的材料：社区通过居民议事会和实地走访调查需求。'
  const laterMaterial = '提交后的草稿材料，不应回写到历史记录。'
  const finalText = '实践决定认识。走访调查获取认识，通过试点检验并完善改造方案。'
  await page.getByTestId(`text-${principle}`).fill('实践是认识的来源。')
  await page.getByTestId(`text-${material}`).fill(submittedMaterial)
  await page.locator('#answer-text').fill(finalText)
  await selectNode(page, material)
  await page.getByTestId(`drag-${material}`).focus()
  await page.getByTestId(`drag-${material}`).press('ArrowRight')
  const savedX = await page.getByTestId(`block-${material}`).getAttribute('data-x')
  const submittedStructure = await structure(page)
  await page.getByRole('button', { name: '提交并审阅', exact: true }).click()
  await expect(
    page.getByRole('region', { name: '审阅结果', exact: true }).locator('.score'),
  ).toHaveText('12 / 12')
  await expect(page.getByText('答案与审阅结果已保存', { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: '我的作答', exact: true }).click()
  await page.getByTestId(`text-${material}`).fill(laterMaterial)
  await expect(page.locator('#answer-text')).toHaveValue(finalText)
  await expect(page.getByRole('status').filter({ hasText: '已保存到本机' })).toBeVisible()

  await app!.close()
  app = undefined
  page = await launch()
  await expect.poll(() => structure(page)).toEqual(submittedStructure)
  await expect(page.getByTestId(`block-${material}`)).toHaveAttribute('data-x', savedX!)
  await expect(page.getByTestId(`text-${material}`)).toHaveValue(laterMaterial)
  await expect(page.getByTestId(`text-${principle}`)).toHaveValue('实践是认识的来源。')
  await expect(page.locator('#answer-text')).toHaveValue(finalText)
  await page.getByRole('button', { name: /练习记录 Review/ }).click()
  await expect(page.locator('.history-item')).toHaveCount(1)
  await page.locator('.history-item').click()
  await page.getByText(/查看本次提交的答案/).click()
  const review = page.getByRole('region', { name: '审阅结果', exact: true })
  await expect(review.getByText(finalText, { exact: true })).toBeVisible()
  await review.getByText('查看提交时的模块结构', { exact: true }).click()
  await expect(review.getByText(submittedMaterial, { exact: true })).toBeVisible()
  await expect(review.getByText(laterMaterial, { exact: true })).toHaveCount(0)
  await expect(review.getByText(/不代表考试阅卷分数/)).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
})
