import { expect, test, type Page } from '@playwright/test'
import type { AnswerDraft, ModuleReviewRequest } from '../../src/shared/types'

declare global {
  interface Window {
    groupFixture: {
      draft: AnswerDraft
      setDraft(value: AnswerDraft): void
      setDisabled(value: boolean): void
      setActive(value: boolean): void
      requests: ModuleReviewRequest[]
      canceled: string[]
      release(): void
    }
  }
}

// Real renderer composition; synthetic local data, stubbed IPC and no provider calls.
async function openFixture(page: Page) {
  await page.route('**/humanities-group-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html><body><div id="root"></div>
    <script type="module">
      import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;
    </script>
    <script type="module">
      import React, { useState, createRoot } from '/tests/browser/fixtures/react.ts';
      import { HumanitiesComposer } from '/src/components/HumanitiesComposer.tsx';
      import '/src/styles.css'; import '/src/components/politics.css'; import '/src/components/argument-timeline.css'; import '/src/components/module-review.css';
      const h = React.createElement;
      const initial = { text: '独立的合成最终正文', blocks: [], drawing: { mode: 'geographic', points: [], lines: [] }, argument: { version: 1,
        roots: ['a','b','c','d'].map(id => ({ id, kind: 'analysis', text: '合成内容 ' + id, children: [] })),
        canvas: { positions: { a: { x: 40, y: 70 }, b: { x: 440, y: 70 }, c: { x: 740, y: 70 }, d: { x: 740, y: 260 } }, viewport: { x: 0, y: 0, zoom: 1 } }
      }};
      const f = window.groupFixture = { draft: initial, requests: [], canceled: [], release() {} };
      const api = {
        getModelConsents: async () => ({ version: 1, revision: 0, grants: [] }),
        cancelModuleReview: async requestId => { f.canceled.push(requestId); },
        reviewModules: request => { f.requests.push(structuredClone(request)); return new Promise(resolve => { f.release = () => resolve({ requestId: request.requestId, configRevision: 1, summary: '无需修改', confirmations: [], suggestions: [] }); }); }
      };
      function App() {
        const [draft, setDraft] = useState(() => JSON.parse(sessionStorage.getItem('synthetic-groups') || 'null') || initial);
        const [disabled, setDisabled] = useState(false);
        const [active, setActive] = useState(true);
        f.draft = draft; f.setDraft = setDraft; f.setDisabled = setDisabled; f.setActive = setActive;
        return h('main', { style: { width: '1100px', margin: '10px auto', display: 'block' } }, h(HumanitiesComposer, { subject: 'history', draft, disabled, active,
          onChange(value) { sessionStorage.setItem('synthetic-groups', JSON.stringify(value)); setDraft(value); },
          question: { id: 'synthetic-question', subject: 'history', kind: 'history', title: '合成题', prompt: '（1）说明原因。（2）分析影响。', source: '合成测试', tags: [], maxScore: 1 },
          config: { configured: true, protocol: 'openai-chat', baseUrl: 'https://synthetic.example.com/v1', model: 'synthetic-model', revision: 1 }, api
        }));
      }
      createRoot(document.getElementById('root')).render(h(App));
    </script></body></html>`,
    }),
  )
  await page.goto('/humanities-group-fixture')
  await expect(page.getByTestId('block-a')).toBeVisible()
  await page.getByRole('button', { name: '展开画布', exact: true }).click()
}
const groups = (page: Page) => page.locator('.free-group')
const draft = (page: Page) => page.evaluate(() => structuredClone(window.groupFixture.draft))
async function dragNode(page: Page, id: string, dx: number, dy: number, release = true) {
  const box = await page.getByTestId(`drag-${id}`).boundingBox()
  if (!box) throw new Error('Missing drag handle')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 12 })
  if (release) await page.mouse.up()
}
async function groupAB(page: Page) {
  await page.getByTestId('drag-b').click()
  await page.getByRole('combobox', { name: '组合目标', exact: true }).selectOption('node:a')
  await page.getByRole('button', { name: '组合为大模块', exact: true }).click()
  await expect(groups(page)).toHaveCount(1)
}

test('drag-near shows preview only, escape and pointer cancel revert, release groups and undo/redo restore', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await openFixture(page)
  const original = await draft(page)
  await dragNode(page, 'b', -162, 0, false)
  await expect(page.getByText('松开即可紧凑组合为一个大模块 · 按 Esc 取消')).toBeVisible()
  expect((await draft(page)).argument?.groups).toBeUndefined()
  await page.keyboard.press('Escape')
  await page.mouse.up()
  expect(await draft(page)).toEqual(original)
  await expect(page.locator('.free-snap-preview')).toHaveCount(0)
  await dragNode(page, 'b', -162, 0, false)
  await page.getByTestId('drag-b').dispatchEvent('pointercancel', { pointerId: 1 })
  await page.mouse.up()
  expect(await draft(page)).toEqual(original)
  await dragNode(page, 'b', -162, 0)
  await expect(groups(page)).toHaveCount(1)
  const grouped = await draft(page)
  expect(grouped.argument!.groups![0].memberIds).toEqual(['a', 'b'])
  expect(grouped.argument!.roots).toEqual(original.argument!.roots)
  expect(grouped.text).toBe(original.text)
  await page.getByTestId('undo-argument').click()
  await expect(groups(page)).toHaveCount(0)
  await page.getByRole('button', { name: '↷ 重做', exact: true }).click()
  await expect(groups(page)).toHaveCount(1)
  await page.reload()
  await expect(groups(page)).toHaveCount(1)
  expect((await draft(page)).argument!.groups).toEqual(grouped.argument!.groups)
  expect(errors).toEqual([])
})

test('group dragging moves members together, double-click selects a child, drag outside splits once', async ({
  page,
}) => {
  await openFixture(page)
  await groupAB(page)
  const before = await draft(page)
  await dragNode(page, 'a', 50, 30)
  const moved = await draft(page)
  for (const id of ['a', 'b']) {
    expect(moved.argument!.canvas!.positions[id].x - before.argument!.canvas!.positions[id].x).toBe(
      50,
    )
    expect(moved.argument!.canvas!.positions[id].y - before.argument!.canvas!.positions[id].y).toBe(
      30,
    )
  }
  await page.getByTestId('drag-b').dblclick()
  await expect(page.getByRole('button', { name: '拆出小模块', exact: true })).toBeVisible()
  await expect(page.getByTestId('block-b')).toHaveClass(/is-extractable/)
  const beforeSmall = await draft(page)
  await dragNode(page, 'b', 20, 0)
  expect(await draft(page)).toEqual(beforeSmall)
  await dragNode(page, 'b', 350, 160)
  await expect(groups(page)).toHaveCount(0)
  const split = await draft(page)
  expect(split.argument!.canvas!.positions.a).toEqual(moved.argument!.canvas!.positions.a)
  expect(split.argument!.roots).toEqual(before.argument!.roots)
  await page.getByTestId('undo-argument').click()
  await expect(groups(page)).toHaveCount(1)
})

test('keyboard alternatives edit labels, select and extract members, duplicate/remove/ungroup without losing text', async ({
  page,
}) => {
  await openFixture(page)
  await groupAB(page)
  await page.getByRole('textbox', { name: '大模块标签', exact: true }).fill('第二小题：影响')
  const label = (await draft(page)).argument!.groups![0].label
  expect(label).toBe('第二小题：影响')
  const handle = groups(page).getByRole('button')
  const before = await draft(page)
  await handle.focus()
  await handle.press('ArrowRight')
  await handle.press('Shift+ArrowDown')
  const after = await draft(page)
  expect(after.argument!.canvas!.positions.a.x).toBe(before.argument!.canvas!.positions.a.x + 10)
  expect(after.argument!.canvas!.positions.b.y).toBe(before.argument!.canvas!.positions.b.y + 1)
  await page.getByRole('button', { name: '复制大模块', exact: true }).click()
  await expect(groups(page)).toHaveCount(2)
  expect((await draft(page)).argument!.roots).toHaveLength(6)
  await page.getByRole('button', { name: '移除大模块及逻辑子模块', exact: true }).click()
  await expect(groups(page)).toHaveCount(1)
  expect((await draft(page)).argument!.roots).toHaveLength(4)
  await groups(page).getByRole('button').click()
  await page.getByRole('combobox', { name: '选择内部小模块', exact: true }).selectOption('b')
  await page.getByRole('button', { name: '拆出小模块', exact: true }).click()
  await expect(groups(page)).toHaveCount(0)
  await page.getByTestId('undo-argument').click()
  await groups(page).getByRole('button').click()
  await page.getByRole('button', { name: '解除大模块', exact: true }).click()
  await expect(groups(page)).toHaveCount(0)
  expect((await draft(page)).text).toBe('独立的合成最终正文')
})

test('typing, textarea double-click, zoom and reload do not auto-group or split; disabled editing cancels a drag', async ({
  page,
}) => {
  await openFixture(page)
  await page.evaluate(() => {
    const d = structuredClone(window.groupFixture.draft)
    d.argument!.canvas!.positions.b.x = 270
    window.groupFixture.setDraft(d)
  })
  await page.getByTestId('text-a').fill('合成近邻文本')
  await page.getByTestId('text-a').dblclick()
  await page.getByRole('button', { name: '缩小画布', exact: true }).click()
  await expect(groups(page)).toHaveCount(0)
  await groupAB(page)
  await page.getByTestId('text-b').dblclick()
  await expect(page.getByTestId('block-b')).not.toHaveClass(/is-extractable/)
  await page.getByTestId('text-b').fill('编辑仍在同一个大模块')
  await expect(groups(page)).toHaveCount(1)
  const before = await draft(page)
  await dragNode(page, 'a', 30, 25, false)
  await page.evaluate(() => window.groupFixture.setDisabled(true))
  await page.mouse.up()
  expect(await draft(page)).toEqual(before)
  await page.evaluate(() => window.groupFixture.setDisabled(false))
})

test('scoped AI request sends partial group data, consent resets when grouping changes and late results are discarded', async ({
  page,
}) => {
  await openFixture(page)
  await groupAB(page)
  await page.getByRole('textbox', { name: '大模块标签', exact: true }).fill('（2）影响')
  await page.getByRole('combobox', { name: '选择内部小模块', exact: true }).selectOption('b')
  await page.getByRole('button', { name: '✦ 检查模块', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '模块检查 · 保留好思路' })
  const consent = panel.getByRole('checkbox', { name: /^我同意将上述检查内容/ })
  await expect(consent).toBeEnabled()
  await consent.check()
  await panel.getByRole('button', { name: '确认并检查模块', exact: true }).click()
  await expect(panel.getByRole('button', { name: '正在检查…', exact: true })).toBeVisible()
  const request = await page.evaluate(() => window.groupFixture.requests[0])
  expect(request.groups![0]).toMatchObject({ label: '（2）影响', memberIds: ['b'], partial: true })
  expect(request).not.toHaveProperty('canvas')
  expect(request).not.toHaveProperty('revisions')
  expect(request.roots.map((node) => node.id)).toEqual(['b'])
  await page.getByRole('button', { name: '拆出小模块', exact: true }).click()
  await page.evaluate(() => window.groupFixture.release())
  await expect(panel.getByText('无需修改', { exact: true })).toHaveCount(0)
  await expect(consent).not.toBeChecked()
})

test('new palette drag snaps only on drop, and selecting a different card clears child extraction mode', async ({
  page,
}) => {
  await openFixture(page)
  await page
    .getByTestId('palette-analysis')
    .dragTo(page.getByTestId('argument-canvas'), { targetPosition: { x: 40, y: 211 } })
  await expect(groups(page)).toHaveCount(1)
  const added = (await draft(page)).argument!.groups![0].memberIds.find((id) => id !== 'a')!
  expect((await draft(page)).argument!.groups![0].memberIds).toEqual(['a', added])
  await page.getByTestId(`drag-${added}`).dblclick()
  await expect(page.getByTestId(`block-${added}`)).toHaveClass(/is-extractable/)
  await page.getByTestId('drag-c').click()
  await expect(page.getByTestId(`block-${added}`)).not.toHaveClass(/is-extractable/)
  const before = await draft(page)
  await dragNode(page, added, 30, 20)
  const after = await draft(page)
  expect(after.argument!.canvas!.positions.a.x - before.argument!.canvas!.positions.a.x).toBe(30)
  expect(
    after.argument!.canvas!.positions[added].x - before.argument!.canvas!.positions[added].x,
  ).toBe(30)
  expect(after.argument!.groups).toEqual(before.argument!.groups)
})

test('hiding the mounted workbench cancels gestures and review without losing the document or selected child', async ({
  page,
}) => {
  await openFixture(page)
  await groupAB(page)
  await page.getByRole('combobox', { name: '选择内部小模块', exact: true }).selectOption('b')
  const before = await draft(page)
  await dragNode(page, 'b', 200, 10, false)
  await page.evaluate(() => window.groupFixture.setActive(false))
  await expect(page.getByTestId('palette-analysis')).toBeDisabled()
  await page.mouse.up()
  expect(await draft(page)).toEqual(before)
  await page.evaluate(() => window.groupFixture.setActive(true))
  await expect(page.getByTestId('palette-analysis')).toBeEnabled()
  await expect(page.getByTestId('block-b')).toHaveClass(/is-extractable/)
  await page.getByRole('button', { name: '✦ 检查模块', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '模块检查 · 保留好思路' })
  const consent = panel.getByRole('checkbox', { name: /^我同意将上述检查内容/ })
  await expect(consent).toBeEnabled()
  await consent.check()
  await panel.getByRole('button', { name: '确认并检查模块', exact: true }).click()
  await expect(panel.getByRole('button', { name: '正在检查…', exact: true })).toBeVisible()
  const requestId = await page.evaluate(() => window.groupFixture.requests[0].requestId)
  await page.evaluate(() => window.groupFixture.setActive(false))
  // A fixture setter schedules React work; it does not synchronously hide the
  // workbench. Release the late reply only after the hide commits and cancels
  // this exact request, rather than racing a response against an uncommitted hide.
  await expect(page.getByTestId('palette-analysis')).toBeDisabled()
  await expect.poll(() => page.evaluate(() => window.groupFixture.canceled)).toEqual([requestId])
  await page.evaluate(() => window.groupFixture.release())
  await page.evaluate(() => window.groupFixture.setActive(true))
  await expect(page.getByTestId('palette-analysis')).toBeEnabled()
  await expect(panel.getByText('无需修改', { exact: true })).toHaveCount(0)
  await expect(consent).not.toBeChecked()
  expect(await draft(page)).toEqual(before)
})

test('group label edits revoke checked one-off consent before a request is sent', async ({
  page,
}) => {
  await openFixture(page)
  await groupAB(page)
  await page.getByRole('combobox', { name: '选择内部小模块', exact: true }).selectOption('b')
  await page.getByRole('button', { name: '✦ 检查模块', exact: true }).click()
  const panel = page.getByRole('dialog', { name: '模块检查 · 保留好思路' })
  const consent = panel.getByRole('checkbox', { name: /^我同意将上述检查内容/ })
  await expect(consent).toBeEnabled()
  await consent.check()
  await expect(panel.getByRole('button', { name: '确认并检查模块', exact: true })).toBeEnabled()
  await groups(page).getByRole('button').click()
  await page.getByRole('textbox', { name: '大模块标签', exact: true }).fill('第一小题：合成标签')
  await expect(consent).not.toBeChecked()
  await expect(panel.getByRole('button', { name: '确认并检查模块', exact: true })).toBeDisabled()
  expect(await page.evaluate(() => window.groupFixture.requests)).toEqual([])
})
