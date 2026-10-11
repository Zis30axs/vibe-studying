import { test, expect, type Page } from '@playwright/test'
import type { AnswerDraft, ExamCraftApi, StudyState } from '../../src/shared/types'

// Renderer regression only: actual disk persistence is covered in math-integration.test.ts
// and the real Electron restart flow remains in tests/e2e/math.spec.ts.
declare global {
  interface Window {
    mathTest: { state: StudyState; saves: AnswerDraft[] }
  }
}
const workbench = (page: Page) =>
  page.locator('#tools-panel').getByRole('region', { name: '数学交互工作台', exact: true })

async function openTools(page: Page) {
  const panel = page.locator('#tools-panel')
  await expect(panel).toBeAttached()
  if (await panel.isHidden())
    await page.getByRole('button', { name: /^(?:◫\s*)?工具与顾问$/ }).click()
  await expect(panel).toBeVisible()
  await expect(workbench(page).getByLabel('函数表达式')).toBeEnabled()
}

async function enterMathWorkspace(page: Page) {
  await page
    .getByRole('navigation', { name: '工作区导航' })
    .getByRole('button', { name: /数学工作台/ })
    .click()
  await openTools(page)
  await expect(workbench(page).getByLabel('函数表达式')).toBeVisible()
}

async function openMath(page: Page) {
  await page.addInitScript(() => {
    const state: StudyState = JSON.parse(
      sessionStorage.getItem('synthetic-math-state') || '{"version":1,"drafts":{},"attempts":[]}',
    )
    window.mathTest = { state, saves: [] }
    const api: Partial<ExamCraftApi> = {
      listQuestions: async () => [
        {
          id: 'math-expression-fixture',
          subject: 'math',
          kind: 'math',
          title: '函数输入测试',
          prompt: '观察函数并写出推理。',
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
        window.mathTest.saves.push(structuredClone(draft))
        sessionStorage.setItem('synthetic-math-state', JSON.stringify(state))
      },
      cancelAdvisor: async () => {},
      cancelModuleReview: async () => {},
      cancelQuestionGeneration: async () => {},
    }
    window.examcraft = api as ExamCraftApi
  })
  await page.goto('/')
  await enterMathWorkspace(page)
}

test('previews shorthand without applying, then persists the explicit expression on Enter or click', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await openMath(page)
  const work = workbench(page)
  const input = work.getByLabel('函数表达式')
  const initialCurve = await work.getByTestId('function-curve').first().getAttribute('points')
  await input.fill('y = 2x+1')
  await expect(work.getByText('识别为：y = 2*x+1', { exact: true })).toBeVisible()
  await expect(work.getByText(/当前已保存：a\*x\^2\+b\*x\+c/)).toContainText('输入尚未应用')
  expect(await work.getByTestId('function-curve').first().getAttribute('points')).toBe(initialCurve)
  await input.press('Enter')
  await expect(input).toHaveValue('2*x+1')
  await expect(input).toHaveAttribute('aria-invalid', 'false')
  await expect(work.getByText('当前已保存：2*x+1', { exact: true })).toBeVisible()
  expect(await work.getByTestId('function-curve').first().getAttribute('points')).not.toBe(
    initialCurve,
  )
  for (const [source, normalized] of [
    ['2(x+1)', '2*(x+1)'],
    ['(x+1)(x-1)', '(x+1)*(x-1)'],
    ['y = ax^2+bx+c', 'a*x^2+b*x+c'],
    ['2×sin(x)', '2*sin(x)'],
  ]) {
    await input.fill(source)
    await expect(work.getByText(`识别为：y = ${normalized}`, { exact: true })).toBeVisible()
    await work.getByRole('button', { name: '应用函数', exact: true }).click()
    await expect(input).toHaveValue(normalized)
    expect(await page.evaluate(() => window.mathTest.saves.at(-1)?.math?.expression)).toBe(
      normalized,
    )
  }
  await page.screenshot({
    path: 'test-results/math-friendly-expression-browser.png',
    fullPage: true,
  })
  await page.reload()
  await enterMathWorkspace(page)
  await expect(workbench(page).getByLabel('函数表达式')).toHaveValue('2*sin(x)')
  await expect(workbench(page).getByText('识别为：y = 2*sin(x)', { exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('invalid or ambiguous edits give an accessible explanation and preserve the saved curve', async ({
  page,
}) => {
  await openMath(page)
  const work = workbench(page)
  const input = work.getByLabel('函数表达式')
  await input.fill('y=2x')
  await work.getByRole('button', { name: '应用函数', exact: true }).click()
  const curve = await work.getByTestId('function-curve').first().getAttribute('points')
  const saves = await page.evaluate(() => window.mathTest.saves.length)
  for (const [source, message] of [
    ['1/2x', '含义不明确'],
    ['6/2(x+1)', '含义不明确'],
    ['x2', '相乘请写 *'],
    ['sinx', 'sin 需要括号'],
    ['y=', '后请输入'],
    ['y=x=2', '不能输入其他等式'],
    ['window.alert(1)', '不支持'],
  ]) {
    await input.fill(source)
    await expect(input).toHaveAttribute('aria-invalid', 'true')
    await expect(work.locator('.math-expression-preview')).toContainText(message)
    await work.getByRole('button', { name: '应用函数', exact: true }).click()
    await expect(work.getByRole('status')).toContainText(message)
    await expect(work.getByText(/当前已保存：2\*x/)).toBeVisible()
    expect(await work.getByTestId('function-curve').first().getAttribute('points')).toBe(curve)
    expect(await page.evaluate(() => window.mathTest.saves.length)).toBe(saves)
  }
  await input.fill('1/(2x)')
  await input.press('Enter')
  await expect(input).toHaveValue('1/(2*x)')
  await expect(work.getByTestId('function-curve')).toHaveCount(2)
  await expect(input).toHaveAttribute('aria-invalid', 'false')
})

test('sliders, demos, clear, undo and reset still work after applying shorthand', async ({
  page,
}) => {
  await openMath(page)
  const work = workbench(page)
  const input = work.getByLabel('函数表达式')
  await input.fill('y=ax^2+bx+c')
  await input.press('Enter')
  const before = await work.getByTestId('function-curve').first().getAttribute('points')
  await work.getByLabel('参数 a 滑块').focus()
  await page.keyboard.press('ArrowRight')
  await expect(work.getByLabel('参数 a 数值')).toHaveValue('1.1')
  expect(await work.getByTestId('function-curve').first().getAttribute('points')).not.toBe(before)
  for (const demo of ['a*sin(b*x)+c', 'a/(x-b)+c', 'a*x^2+b*x+c']) {
    await work.getByRole('button', { name: demo, exact: true }).click()
    await expect(input).toHaveValue(demo)
    await expect(work.getByText(`识别为：y = ${demo}`, { exact: true })).toBeVisible()
  }
  await work.getByRole('button', { name: '清除函数', exact: true }).click()
  await expect(input).toHaveValue('')
  await expect(work.getByTestId('function-curve')).toHaveCount(0)
  await work.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(input).toHaveValue('a*x^2+b*x+c')
  await input.fill('   ')
  await input.press('Enter')
  await expect(input).toHaveValue('')
  await expect(work.getByTestId('function-curve')).toHaveCount(0)
  await work.getByRole('button', { name: '重置工具', exact: true }).click()
  await work.getByRole('button', { name: '取消', exact: true }).click()
  await expect(input).toHaveValue('')
  await work.getByRole('button', { name: '重置工具', exact: true }).click()
  await work.getByRole('button', { name: '确认重置', exact: true }).click()
  await expect(input).toHaveValue('a*x^2+b*x+c')
  await expect(work.getByLabel('参数 a 数值')).toHaveValue('1')
  await work.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(input).toHaveValue('')
  await expect(work.getByLabel('参数 a 数值')).toHaveValue('1.1')
  await expect(work.getByRole('alert')).toHaveCount(0)
})

async function mathClient(page: Page, x: number, y: number) {
  const canvas = workbench(page).getByLabel('数学等比例坐标图')
  await canvas.scrollIntoViewIfNeeded()
  return canvas.evaluate(
    (element, { x, y }) => {
      const svg = element as unknown as SVGSVGElement
      const point = svg.createSVGPoint()
      point.x = 280 + 24 * x
      point.y = 280 - 24 * y
      const result = point.matrixTransform(svg.getScreenCTM()!)
      return { x: result.x, y: result.y }
    },
    { x, y },
  )
}

test('right click creates exactly the shown snapped point across canvas sizes and never duplicates it', async ({
  page,
}) => {
  await openMath(page)
  const work = workbench(page)
  for (const width of [1440, 820, 540]) {
    await page.setViewportSize({ width, height: 1050 })
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width)
    if (width < 1120) {
      // Resizing closes overlay drawers; explicitly reopen before interacting with the plot.
      await expect(page.locator('#tools-panel')).toBeHidden()
      if (width < 760) await expect(page.locator('#question-panel')).toBeHidden()
    }
    await openTools(page)
    const location = await mathClient(page, -2.4, 3.4)
    await page.mouse.move(location.x, location.y)
    await expect(work.getByTestId('math-coordinate-tooltip')).toContainText('x = -2，y = 3')
    await page.mouse.click(location.x, location.y, { button: 'right' })
    await expect(work.getByLabel('数学点列表').getByRole('button')).toHaveCount(1)
    await expect(work.getByLabel('数学点列表')).toContainText('P1 (-2, 3)')
  }
  const onPoint = await mathClient(page, -2, 3)
  await page.mouse.click(onPoint.x, onPoint.y, { button: 'right' })
  await expect(work.getByLabel('数学点列表').getByRole('button')).toHaveCount(1)
  await expect(work.getByTestId('math-projection-x').first()).toHaveAttribute('x1', '232')
  await expect(work.getByTestId('math-projection-x').first()).toHaveAttribute('y2', '280')
  await expect(work.getByTestId('math-projection-y').first()).toHaveAttribute('x2', '280')
  await expect(work.getByTestId('math-coordinate-tooltip')).toContainText('到 x 轴 3 · 到 y 轴 2')
  const edge = await mathClient(page, 9.9, -9.9)
  await page.mouse.move(edge.x, edge.y)
  const bounds = (await work.getByLabel('数学等比例坐标图').boundingBox())!
  const tip = (await work.getByTestId('math-coordinate-tooltip').boundingBox())!
  expect(tip.x).toBeGreaterThanOrEqual(bounds.x)
  expect(tip.y).toBeGreaterThanOrEqual(bounds.y)
  expect(tip.x + tip.width).toBeLessThanOrEqual(bounds.x + bounds.width)
  expect(tip.y + tip.height).toBeLessThanOrEqual(bounds.y + bounds.height)
  await work.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(work.getByLabel('数学点列表').getByRole('button')).toHaveCount(0)
})

test('wheel adjusts the actual snap grid only inside the plot and leaves browser zoom and outside scroll alone', async ({
  page,
}) => {
  await openMath(page)
  const work = workbench(page)
  const point = await mathClient(page, 2.37, -1.14)
  await page.mouse.move(point.x, point.y)
  for (const step of ['0.5', '0.25', '0.24', '0.23']) {
    await page.mouse.wheel(0, 100)
    await expect(work.getByLabel('坐标吸附步长')).toHaveValue(step)
  }
  await expect(work.getByTestId('math-coordinate-tooltip')).toContainText('x = 2.3，y = -1.15')
  await page.mouse.click(point.x, point.y, { button: 'right' })
  await expect(work.getByLabel('数学点列表')).toContainText('P1 (2.3, -1.15)')
  await page.mouse.wheel(0, -100)
  await expect(work.getByLabel('坐标吸附步长')).toHaveValue('0.24')
  const canvas = work.getByLabel('数学等比例坐标图')
  expect(
    await canvas.evaluate((node, p) => {
      const event = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        clientX: p.x,
        clientY: p.y,
        deltaY: 100,
        ctrlKey: true,
      })
      node.dispatchEvent(event)
      return event.defaultPrevented
    }, point),
  ).toBe(false)
  expect(
    await canvas.evaluate((node) => {
      const event = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        clientX: -100,
        clientY: -100,
        deltaY: 100,
      })
      node.dispatchEvent(event)
      return event.defaultPrevented
    }),
  ).toBe(false)
  await expect(work.getByLabel('坐标吸附步长')).toHaveValue('0.24')
})

test('I toggles projections only during canvas interaction and skips text, modifiers, repeat and composition', async ({
  page,
}) => {
  await openMath(page)
  const work = workbench(page)
  const point = await mathClient(page, -2, -3)
  await page.mouse.move(point.x, point.y)
  await expect(work.getByTestId('math-coordinate-tooltip')).toContainText('到 x 轴 3 · 到 y 轴 2')
  const toggle = work.getByRole('checkbox', { name: '显示轴距投影（I）' })
  await expect(toggle).toBeChecked()
  await page.keyboard.press('i')
  await expect(toggle).not.toBeChecked()
  await expect(work.getByTestId('math-projection-x')).toHaveCount(0)
  const canvas = work.getByLabel('数学等比例坐标图')
  await canvas.focus()
  await page.keyboard.press('i')
  await expect(toggle).toBeChecked()
  for (const event of [
    { repeat: true },
    { isComposing: true },
    { ctrlKey: true },
    { altKey: true },
    { metaKey: true },
  ]) {
    await canvas.dispatchEvent('keydown', { key: 'i', bubbles: true, ...event })
    await expect(toggle).toBeChecked()
  }
  await work.getByLabel('函数表达式').focus()
  await page.keyboard.press('i')
  await expect(toggle).toBeChecked()
  await page.mouse.move(0, 0)
  await work.getByRole('button', { name: '应用步长', exact: true }).focus()
  await page.keyboard.press('i')
  await expect(toggle).toBeChecked()
  await toggle.uncheck()
  await expect(work.getByTestId('math-projection-x')).toHaveCount(0)
})

test('custom grid and projection settings validate, keep existing coordinates, and reload with the draft', async ({
  page,
}) => {
  await openMath(page)
  const work = workbench(page)
  const step = work.getByLabel('坐标吸附步长')
  for (const invalid of ['', '0', '-1', '11', '0.0123456']) {
    await step.fill(invalid)
    await work.getByRole('button', { name: '应用步长', exact: true }).click()
    await expect(work.getByRole('status')).toContainText('吸附步长须为 0.01 到 10')
  }
  await step.fill('0.3')
  await work.getByRole('button', { name: '应用步长', exact: true }).click()
  const point = await mathClient(page, 9.98, -2.99)
  await page.mouse.move(point.x, point.y)
  await expect(work.getByTestId('math-coordinate-tooltip')).toContainText('x = 9.9，y = -3')
  await page.mouse.click(point.x, point.y, { button: 'right' })
  await step.fill('0.125')
  await work.getByRole('button', { name: '应用步长', exact: true }).click()
  await expect(work.getByLabel('数学点列表')).toContainText('P1 (9.9, -3)')
  await work.getByLabel('投影线颜色').evaluate((node) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, '#336699')
    node.dispatchEvent(new Event('input', { bubbles: true }))
    node.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await expect(work.getByTestId('math-projection-x').first()).toHaveAttribute('stroke', '#336699')
  await work.getByRole('checkbox', { name: '显示轴距投影（I）' }).uncheck()
  await page.reload()
  await enterMathWorkspace(page)
  await expect(workbench(page).getByLabel('坐标吸附步长')).toHaveValue('0.125')
  await expect(workbench(page).getByLabel('投影线颜色')).toHaveValue('#336699')
  await expect(
    workbench(page).getByRole('checkbox', { name: '显示轴距投影（I）' }),
  ).not.toBeChecked()
  await expect(workbench(page).getByLabel('数学点列表')).toContainText('P1 (9.9, -3)')
})

test('undo while a pointer drag is held cancels capture and does not recreate or crash on a removed point', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await openMath(page)
  const work = workbench(page)
  const point = await mathClient(page, 2, 3)
  await page.mouse.click(point.x, point.y, { button: 'right' })
  await expect(work.getByLabel('数学点列表')).toContainText('P1 (2, 3)')
  await page.mouse.move(point.x, point.y)
  await page.mouse.down()
  await page.mouse.move(point.x + 15, point.y + 20, { steps: 3 })
  await work.getByRole('button', { name: '撤销', exact: true }).focus()
  await page.keyboard.press('Enter')
  await page.mouse.up()
  await expect(work.getByLabel('数学点列表').getByRole('button')).toHaveCount(0)
  await expect(work.getByTestId('math-coordinate-tooltip')).toHaveCount(0)
  expect(errors).toEqual([])
})
