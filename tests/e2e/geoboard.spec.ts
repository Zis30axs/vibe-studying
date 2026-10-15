import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test('dynamic geometry survives Electron draft save and restart in an isolated profile', async () => {
  test.setTimeout(90000)
  const directory = await mkdtemp(join(tmpdir(), 'examcraft-geoboard-e2e-'))
  let app: ElectronApplication | undefined
  async function launch() {
    const env = Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
    )
    delete env.ELECTRON_RUN_AS_NODE
    delete env.EXAMCRAFT_DEV_URL
    env.EXAMCRAFT_USER_DATA = directory
    app = await electron.launch({ args: ['.'], env })
    const page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1440, 960),
    )
    await page
      .getByRole('navigation')
      .getByRole('button', { name: /数学工作台/ })
      .click()
    await page.locator('.question-item').filter({ hasText: '解一元一次方程' }).click()
    await page.locator('#tools-panel .geoboard-disclosure > summary').click()
    return page
  }
  try {
    let page = await launch(),
      board = page.locator('#tools-panel .geoboard')
    const question = await page.evaluate(async () =>
      (await window.examcraft!.listQuestions()).find(
        (q) => q.subject === 'math' && q.title.includes('解一元一次方程'),
      )!,
    )
    await board.getByText('精确坐标输入', { exact: true }).click()
    await board.getByLabel('新点名称', { exact: true }).fill('O')
    await board.getByRole('button', { name: '添加坐标点', exact: true }).click()
    await board.getByRole('button', { name: '定半径圆', exact: true }).click()
    await board.getByLabel('动态几何钉板', { exact: true }).scrollIntoViewIfNeeded()
    const center = await board.getByLabel('动态几何钉板', { exact: true }).evaluate((node) => {
      const p = new DOMPoint(400, 300).matrixTransform((node as SVGSVGElement).getScreenCTM()!)
      return { x: p.x, y: p.y }
    })
    await page.mouse.click(center.x, center.y)
    await expect
      .poll(
        async () =>
          await page.evaluate(
            async (id) =>
              (await window.examcraft!.loadState()).drafts[id]?.math?.geoboard?.objects.length,
            question.id,
          ),
      )
      .toBe(1)
    const saved = await page.evaluate(
      async (id) => (await window.examcraft!.loadState()).drafts[id].math!.geoboard,
      question.id,
    )
    await app!.close()
    app = undefined
    page = await launch()
    board = page.locator('#tools-panel .geoboard')
    expect(
      await page.evaluate(
        async (id) => (await window.examcraft!.loadState()).drafts[id].math!.geoboard,
        question.id,
      ),
    ).toEqual(saved)
    await expect(board.locator('button[data-object-id]')).toHaveCount(2)
  } finally {
    await app?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
