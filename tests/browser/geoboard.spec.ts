import { test, expect, type Page } from '@playwright/test'
import type { MathWorkbenchState } from '../../src/shared/types'
import type { GeoboardState } from '../../src/shared/geoboard-types'

declare global {
  interface Window {
    geoboardFixture: { value: MathWorkbenchState; reset(): void; setDisabled(v: boolean): void }
  }
}
const board = (page: Page) => page.locator('.geoboard')
async function open(page: Page) {
  await page.route('**/geoboard-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html><body><div id="root"></div>
  <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script>
  <script type="module">
  import React, { useState, createRoot } from '/tests/browser/fixtures/react.ts';
  import { MathWorkbench } from '/src/components/MathWorkbench.tsx';
  import { emptyMathState } from '/src/shared/types.ts'; import '/src/styles.css';
  function Fixture(){
    const [value,setValue]=useState(()=>JSON.parse(sessionStorage.getItem('geoboard-synthetic-state')||'null')||emptyMathState());
    const [disabled,setDisabled]=useState(false);
    window.geoboardFixture={value,reset:()=>setValue(emptyMathState()),setDisabled};
    return React.createElement(MathWorkbench,{value,disabled,onChange:next=>{setValue(next);sessionStorage.setItem('geoboard-synthetic-state',JSON.stringify(next))}});
  } createRoot(document.getElementById('root')).render(React.createElement(Fixture));</script></body></html>`,
    }),
  )
  await page.goto('/geoboard-fixture')
  await page.locator('.geoboard-disclosure > summary').click()
  await expect(board(page)).toBeVisible()
}
async function coordinate(page: Page, x: number, y: number) {
  const svg = board(page).getByLabel('动态几何钉板', { exact: true })
  await svg.scrollIntoViewIfNeeded()
  return svg.evaluate(
    (node, { x, y }) => {
      const view = window.geoboardFixture.value.geoboard?.view ?? { x: 0, y: 0, scale: 32 }
      const result = new DOMPoint(
        400 + (x - view.x) * view.scale,
        300 - (y - view.y) * view.scale,
      ).matrixTransform((node as SVGSVGElement).getScreenCTM()!)
      return { x: result.x, y: result.y }
    },
    { x, y },
  )
}
async function click(page: Page, x: number, y: number) {
  const p = await coordinate(page, x, y)
  await page.mouse.click(p.x, p.y)
}
async function circle(page: Page) {
  await board(page).getByRole('button', { name: '圆', exact: true }).click()
  await click(page, 0, 0)
  await click(page, 3, 0)
}
async function state(page: Page): Promise<GeoboardState | undefined> {
  return page.evaluate(() => window.geoboardFixture.value.geoboard)
}

test('opening does not migrate old drafts, then a circle persists on reload', async ({ page }) => {
  await open(page)
  expect(await state(page)).toBeUndefined()
  await circle(page)
  const before = await state(page)
  expect(before?.objects[0].kind).toBe('circle')
  await page.reload()
  await page.locator('.geoboard-disclosure > summary').click()
  expect(await state(page)).toEqual(before)
})
test('tangent construction, drag, undo and redo run through the real React wrapper', async ({
  page,
}) => {
  await open(page)
  await circle(page)
  await board(page).getByRole('button', { name: '切线', exact: true }).click()
  await click(page, 5, 0)
  await click(page, 0, 3)
  expect((await state(page))?.objects.filter((o) => o.kind === 'tangent')).toHaveLength(2)
  await board(page).getByRole('button', { name: '选择 / 拖动', exact: true }).click()
  const p = await coordinate(page, 5, 0),
    q = await coordinate(page, 6, 1)
  await page.mouse.move(p.x, p.y)
  await page.mouse.down()
  await page.mouse.move(q.x, q.y, { steps: 8 })
  await page.mouse.up()
  expect((await state(page))?.points[2]).toMatchObject({ x: 6, y: 1 })
  await board(page).getByRole('button', { name: '撤销钉板操作', exact: true }).click()
  expect((await state(page))?.points[2]).toMatchObject({ x: 5, y: 0 })
  await board(page).getByRole('button', { name: '重做钉板操作', exact: true }).click()
  expect((await state(page))?.points[2]).toMatchObject({ x: 6, y: 1 })
})
test('legacy canvas undo preserves new constructions', async ({ page }) => {
  await open(page)
  await circle(page)
  const before = await state(page)
  const legacy = page.getByRole('region', { name: '数学交互工作台', exact: true })
  await legacy.getByLabel('数学点标记', { exact: true }).fill('Legacy')
  await legacy.getByLabel('数学 X 坐标', { exact: true }).fill('2')
  await legacy.getByLabel('数学 Y 坐标', { exact: true }).fill('3')
  await legacy.getByRole('button', { name: '添加数学点', exact: true }).click()
  await legacy.getByRole('button', { name: '撤销', exact: true }).click()
  expect(await state(page)).toEqual(before)
  await board(page).getByRole('button', { name: '撤销钉板操作', exact: true }).click()
  expect(await page.evaluate(() => window.geoboardFixture.value.drawing.points)).toEqual([])
})
test('reset after undoing to an empty board also clears the redo stack', async ({ page }) => {
  await open(page)
  await board(page).getByRole('button', { name: '描点', exact: true }).click()
  await click(page, 1, 1)
  await board(page).getByRole('button', { name: '撤销钉板操作', exact: true }).click()
  await expect(board(page).getByRole('button', { name: '重做钉板操作', exact: true })).toBeEnabled()
  await page.evaluate(() => window.geoboardFixture.reset())
  await expect(
    board(page).getByRole('button', { name: '重做钉板操作', exact: true }),
  ).toBeDisabled()
  expect(await state(page)).toBeUndefined()
})
test('invalid imported geometry cannot replace the current document', async ({ page }) => {
  await open(page)
  await circle(page)
  const before = await state(page)
  await board(page)
    .locator('input[type=file]')
    .setInputFiles({
      name: 'invalid.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{"version":1,"bad":true}'),
    })
  await expect(board(page).getByRole('status')).toContainText('字段')
  expect(await state(page)).toEqual(before)
})
test('submitted/read-only geometry cannot be edited', async ({ page }) => {
  await open(page)
  await circle(page)
  const before = await state(page)
  await page.evaluate(() => window.geoboardFixture.setDisabled(true))
  await expect(board(page).getByRole('button', { name: '描点', exact: true })).toBeDisabled()
  await click(page, 6, 2)
  expect(await state(page)).toEqual(before)
})
test('Ctrl-wheel stays available for browser zoom and does not change the board', async ({
  page,
}) => {
  await open(page)
  await circle(page)
  const before = await state(page)
  expect(
    await board(page)
      .getByLabel('动态几何钉板', { exact: true })
      .evaluate((node) => {
        const event = new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          deltaY: 100,
        })
        node.dispatchEvent(event)
        return event.defaultPrevented
      }),
  ).toBe(false)
  expect(await state(page)).toEqual(before)
})
test('rubber band polygon closes on its first point and supports touch layout', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await open(page)
  await board(page).getByRole('button', { name: '橡皮筋', exact: true }).click()
  for (const [x, y] of [
    [-4, -2],
    [0, -2],
    [0, 1],
    [-4, 1],
    [-4, -2],
  ])
    await click(page, x, y)
  expect((await state(page))?.objects[0]).toMatchObject({ kind: 'polygon', fill: true })
  expect(await board(page).evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
})
