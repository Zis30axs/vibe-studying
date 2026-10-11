import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LAYOUT_STORAGE_KEY } from '../../src/domain/workspace-layout'

// Native restart coverage. Renderer fixtures do not establish Electron persistence.
test('panel widths, collapsed state and answer survive an actual Electron restart', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'examcraft-layout-e2e-'))
  let app: ElectronApplication | undefined
  async function launch() {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    )
    delete env.ELECTRON_RUN_AS_NODE
    delete env.EXAMCRAFT_DEV_URL
    env.EXAMCRAFT_USER_DATA = userData
    app = await electron.launch({ args: ['.'], env })
    const page = await app.firstWindow()
    await expect(page.locator('#answer-text')).toBeVisible()
    return page
  }
  try {
    let page = await launch()
    await page.locator('#answer-text').fill('重启后保留的布局与答案。')
    await page.getByRole('separator', { name: '练习目录宽度' }).focus()
    await page.keyboard.press('Shift+ArrowRight')
    await page.getByRole('separator', { name: '工具与顾问宽度' }).focus()
    await page.keyboard.press('ArrowLeft')
    await page.getByRole('button', { name: '工具与顾问', exact: true }).click()
    const before = await page.evaluate((key) => localStorage.getItem(key), LAYOUT_STORAGE_KEY)
    await expect(page.getByRole('status').filter({ hasText: '已保存到本机' })).toBeVisible()
    await app!.close()
    app = undefined
    page = await launch()
    expect(await page.evaluate((key) => localStorage.getItem(key), LAYOUT_STORAGE_KEY)).toBe(before)
    await expect(page.locator('#answer-text')).toHaveValue('重启后保留的布局与答案。')
    await expect(page.locator('#tools-panel')).toBeHidden()
    await page.getByRole('button', { name: '工具与顾问', exact: true }).click()
    await expect(page.getByRole('separator', { name: '工具与顾问宽度' })).toHaveAttribute(
      'aria-valuenow',
      '450',
    )
    await page.getByRole('button', { name: '重置布局', exact: true }).click()
    await expect(page.getByRole('separator', { name: '练习目录宽度' })).toHaveAttribute(
      'aria-valuenow',
      '224',
    )
    await page.getByRole('button', { name: '练习记录 Review & reflect', exact: true }).click()
    await expect(page.getByRole('region', { name: '学习概览', exact: true })).toBeVisible()
    await expect(page.locator('.history-overview summary')).toHaveCount(0)
  } finally {
    await app?.close()
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})
