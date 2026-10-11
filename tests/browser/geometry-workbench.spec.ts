import { test, expect, type Page } from '@playwright/test'
import type { MathWorkbenchState } from '../../src/shared/types'

declare global {
  interface Window {
    geometryFixture: { value: MathWorkbenchState; reset(): void; setDisabled(value: boolean): void }
  }
}
async function openWorkbench(
  page: Page,
  points: { id: string; label: string; x: number; y: number }[] = [],
) {
  await page.route('**/geometry-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html><body><div id="root"></div>
    <script type="module">
      import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
    </script>
    <script type="module">
      import React, { useState, createRoot } from '/tests/browser/fixtures/react.ts';
      import { MathWorkbench } from '/src/components/MathWorkbench.tsx';
      import { emptyMathState } from '/src/shared/types.ts';
      import '/src/styles.css';
      function Fixture() {
        const [value, setValue] = useState(() => JSON.parse(sessionStorage.getItem('geometry-fixture-state') || 'null') || ({ ...emptyMathState(), drawing: { mode: 'cartesian', points: ${JSON.stringify(points)}, lines: [] }}));
        const [disabled, setDisabled] = useState(false);
        window.geometryFixture = { value, reset: () => setValue(emptyMathState()), setDisabled };
        return React.createElement(MathWorkbench, { value, disabled, onChange: next => { setValue(next); sessionStorage.setItem('geometry-fixture-state', JSON.stringify(next)); } });
      }
      createRoot(document.getElementById('root')).render(React.createElement(Fixture));
    </script></body></html>`,
    }),
  )
  await page.goto('/geometry-fixture')
  await expect(page.getByRole('heading', { name: '三维坐标工作台' })).toBeVisible()
}
async function selectPerpendicular(page: Page, point = 'P') {
  await page.getByRole('button', { name: '作垂线', exact: true }).click()
  await page.getByLabel('垂线过点', { exact: true }).selectOption(point)
  await page.getByLabel('垂线直线起点').selectOption('A')
  await page.getByLabel('垂线直线终点').selectOption('B')
  await page.getByRole('button', { name: '构造垂线', exact: true }).click()
}
async function add3D(page: Page, label: string, x: number, y: number, z: number) {
  const fresh = page.getByRole('button', { name: '新建三维点', exact: true })
  if (await fresh.count()) await fresh.click()
  await page.getByLabel('三维点标记').fill(label)
  for (const [axis, value] of [
    ['X', x],
    ['Y', y],
    ['Z', z],
  ] as const)
    await page.getByLabel(`三维 ${axis} 坐标`).fill(String(value))
  await page.getByRole('button', { name: '添加三维点', exact: true }).click()
  await expect(page.getByLabel('三维点列表')).toContainText(`${label} (${x}, ${y}, ${z})`)
}

test('constructs perpendicular feet for horizontal, vertical and oblique lines with undo and reload', async ({
  page,
}) => {
  for (const [a, b, p, foot] of [
    [
      [-3, 0],
      [3, 0],
      [1, 4],
      [1, 0],
    ],
    [
      [0, -3],
      [0, 3],
      [4, 1],
      [0, 1],
    ],
    [
      [-2, -2],
      [2, 2],
      [0, 4],
      [2, 2],
    ],
  ]) {
    await page.goto('/')
    await page.evaluate(() => sessionStorage.removeItem('geometry-fixture-state'))
    await openWorkbench(
      page,
      [a, b, p].map(([x, y], i) => ({ id: ['A', 'B', 'P'][i], label: ['A', 'B', 'P'][i], x, y })),
    )
    await selectPerpendicular(page)
    await expect(page.getByTestId('math-right-angle')).toHaveCount(1)
    const relation = await page.evaluate(() => {
      const v = window.geometryFixture.value
      return v.drawing.points.find((p) => p.id === v.rightAngles![0].vertex)
    })
    expect(relation?.x).toBeCloseTo(foot[0])
    expect(relation?.y).toBeCloseTo(foot[1])
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await expect(page.getByTestId('math-right-angle')).toHaveCount(0)
  }
  await selectPerpendicular(page)
  await page.reload()
  await expect(page.getByTestId('math-right-angle')).toHaveCount(1)
})

test('on-line perpendicular remains nonzero and invalid constructions leave the model unchanged', async ({
  page,
}) => {
  await openWorkbench(page, [
    { id: 'A', label: 'A', x: -3, y: 0 },
    { id: 'B', label: 'B', x: 3, y: 0 },
    { id: 'P', label: 'P', x: 0, y: 0 },
  ])
  await selectPerpendicular(page)
  await expect(page.getByRole('status')).toContainText('非零垂线段')
  expect(
    await page.evaluate(() => {
      const v = window.geometryFixture.value,
        r = v.rightAngles![0]
      const a = v.drawing.points.find((p) => p.id === r.vertex)!,
        b = v.drawing.points.find((p) => p.id === r.to)!
      return Math.hypot(a.x - b.x, a.y - b.y)
    }),
  ).toBeGreaterThan(0)
  const before = await page.evaluate(() => JSON.stringify(window.geometryFixture.value))
  await page.getByLabel('垂线直线终点').selectOption('A')
  await page.getByRole('button', { name: '构造垂线', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('两个不同端点')
  expect(await page.evaluate(() => JSON.stringify(window.geometryFixture.value))).toBe(before)
  await page.getByRole('button', { name: '取消作垂线', exact: true }).click()
  await expect(page.getByLabel('垂线过点', { exact: true })).toHaveCount(0)
})

test('coordinate edits drop stale right-angle markers and delete/undo/reset remain valid', async ({
  page,
}) => {
  await openWorkbench(page, [
    { id: 'A', label: 'A', x: -3, y: 0 },
    { id: 'B', label: 'B', x: 3, y: 0 },
    { id: 'P', label: 'P', x: 1, y: 4 },
  ])
  await selectPerpendicular(page)
  await page.getByLabel('数学点列表').getByRole('button', { name: 'P (1, 4)' }).click()
  await page.getByLabel('数学 X 坐标').fill('2')
  await page.getByRole('button', { name: '更新数学点', exact: true }).click()
  await expect(page.getByTestId('math-right-angle')).toHaveCount(0)
  expect(await page.evaluate(() => window.geometryFixture.value.rightAngles)).toEqual([])
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(page.getByTestId('math-right-angle')).toHaveCount(1)
  await page.getByRole('button', { name: '重置工具', exact: true }).click()
  await page.getByRole('button', { name: '确认重置', exact: true }).click()
  expect(await page.evaluate(() => window.geometryFixture.value.drawing.points)).toEqual([])
  await expect(page.getByLabel('垂线过点', { exact: true })).toHaveCount(0)
})

test('real xyz points, line, triangular face, camera and persistence work together', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await openWorkbench(page)
  await expect(page.getByRole('alert')).toHaveCount(0)
  await add3D(page, 'A', 0, 0, 0)
  await add3D(page, 'B', 3, 0, 0)
  await add3D(page, 'C', 0, 2, 4)
  const pointIds = await page.evaluate(() =>
    window.geometryFixture.value.geometry!.points.map((p) => p.id),
  )
  await page.getByLabel('三维起点').selectOption(pointIds[0])
  await page.getByLabel('三维终点').selectOption(pointIds[1])
  await page.getByLabel('三维第三点（构面）').selectOption(pointIds[2])
  await page.getByRole('checkbox', { name: '虚线线段' }).check()
  await page.getByRole('button', { name: '添加三维线段', exact: true }).click()
  await page.getByRole('button', { name: '添加三角面', exact: true }).click()
  await expect(page.getByTestId('geometry-segment')).toHaveAttribute('stroke-dasharray', '6 5')
  await expect(page.getByTestId('geometry-face')).toHaveCount(1)
  const model = await page.evaluate(() => JSON.stringify(window.geometryFixture.value.geometry))
  const before = await page.getByTestId('geometry-point').nth(2).getAttribute('cy')
  await page.getByRole('button', { name: '正视 xz', exact: true }).click()
  expect(await page.getByTestId('geometry-point').nth(2).getAttribute('cy')).not.toBe(before)
  expect(await page.evaluate(() => JSON.stringify(window.geometryFixture.value.geometry))).toBe(
    model,
  )
  await page.getByLabel('三维 Z 坐标').fill('6')
  await page.getByRole('button', { name: '更新三维点', exact: true }).click()
  expect(await page.evaluate(() => window.geometryFixture.value.geometry!.points[2].z)).toBe(6)
  await expect(page.getByTestId('geometry-face')).toHaveCount(1)
  await page.reload()
  await expect(page.getByLabel('三维点列表')).toContainText('C (0, 2, 6)')
  await expect(page.getByTestId('geometry-segment')).toHaveCount(1)
  await page.screenshot({ path: 'test-results/geometry-workbench.png', fullPage: true })
  expect(errors).toEqual([])
})

test('3D bounds, cancel, undo, clear and readonly state guard every mutation', async ({ page }) => {
  await openWorkbench(page)
  await page.getByLabel('三维 Z 坐标').fill('101')
  await page.getByRole('button', { name: '添加三维点', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('−100 到 100')
  await page.getByRole('button', { name: '载入立方体示例', exact: true }).click()
  await expect(page.getByTestId('geometry-point')).toHaveCount(8)
  await page.getByRole('button', { name: '清空三维图形', exact: true }).click()
  await page.getByRole('button', { name: '取消三维操作', exact: true }).click()
  await expect(page.getByTestId('geometry-point')).toHaveCount(8)
  await page.getByRole('button', { name: '清空三维图形', exact: true }).click()
  await page.getByRole('button', { name: '确认清空', exact: true }).click()
  await expect(page.getByTestId('geometry-point')).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.getByRole('button', { name: '撤销三维操作', exact: true }).click()
  await expect(page.getByTestId('geometry-point')).toHaveCount(8)
  await page.getByLabel('三维点列表').getByRole('button', { name: 'A (0, 0, 0)' }).click()
  await page.getByLabel('三维 X 坐标').fill('7')
  const before = await page.evaluate(() => JSON.stringify(window.geometryFixture.value))
  await page.evaluate(() => window.geometryFixture.setDisabled(true))
  await expect(page.getByLabel('三维 X 坐标')).toBeDisabled()
  await page
    .getByLabel('三维 X 坐标')
    .evaluate((node) =>
      node.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    )
  expect(await page.evaluate(() => JSON.stringify(window.geometryFixture.value))).toBe(before)
  await page.evaluate(() => {
    window.geometryFixture.setDisabled(false)
    window.geometryFixture.reset()
  })
  await expect(page.getByTestId('geometry-point')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '撤销三维操作', exact: true })).toBeDisabled()
})
