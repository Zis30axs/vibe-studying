import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

let app: ElectronApplication | undefined
let directory: string
async function launch() {
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  env.EXAMCRAFT_USER_DATA = directory
  delete env.ELECTRON_RUN_AS_NODE
  delete env.EXAMCRAFT_DEV_URL
  delete env.DEEPSEEK_API_KEY
  app = await electron.launch({ args: ['.'], env })
  const page = await app.firstWindow()
  await expect(page.getByTestId('activity-heatmap')).toBeVisible()
  return page
}
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'examcraft-activity-e2e-'))
})
test.afterEach(async () => {
  await app?.close()
  app = undefined
  if (
    dirname(resolve(directory)) !== resolve(tmpdir()) ||
    !basename(directory).startsWith('examcraft-activity-e2e-')
  )
    throw new Error('Unexpected activity test cleanup path')
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

test('heatmap counts persisted submissions, excludes drafts and failures, opens records and survives restart', async () => {
  let page = await launch()
  const localDay = await page.evaluate(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  })
  let cell = page.getByTestId(`activity-day-${localDay}`)
  await expect(cell).toHaveAttribute('data-count', '0')
  await expect(cell).toHaveAttribute('data-level', '0')
  await page.getByLabel('思考笔记').fill('只有草稿，不应增加提交次数。')
  await expect(page.getByText('已保存到本机', { exact: true })).toBeVisible()
  await expect(cell).toHaveAttribute('data-count', '0')
  expect(
    await page.evaluate(async () => {
      const draft = {
        text: '',
        blocks: [],
        drawing: { mode: 'cartesian' as const, points: [], lines: [] },
      }
      try {
        await window.examcraft!.submitAnswer('pol-choice-1', draft)
        return 'unexpected success'
      } catch {
        return 'rejected'
      }
    }),
  ).toBe('rejected')
  await expect(cell).toHaveAttribute('data-count', '0')
  await page.getByRole('radio').nth(1).click()
  await page.getByRole('button', { name: '提交并审阅', exact: true }).click()
  await expect(page.getByLabel('审阅结果').locator('.score')).toHaveText('0 / 4')
  await expect(cell).toHaveAttribute('data-count', '1')
  await expect(cell).toHaveAttribute('data-level', '1')
  await page.getByRole('button', { name: '重新练习', exact: false }).click()
  await page.getByRole('radio').first().click()
  await page.getByRole('button', { name: '提交并审阅', exact: true }).click()
  await expect(cell).toHaveAttribute('data-count', '2')
  const attempts = (await page.evaluate(() => window.examcraft!.loadState())).attempts
  expect(attempts).toHaveLength(2)
  await cell.focus()
  await cell.press('Enter')
  await expect(page.getByTestId('activity-day-details')).toContainText('2')
  await page.getByTestId(`activity-attempt-${attempts[0].id}`).click()
  await expect(page.locator('.history-item')).toHaveCount(2)
  await expect(page.locator('.history-item.selected')).toHaveCount(1)
  await expect(page.getByLabel('审阅结果').locator('.score')).toHaveText('0 / 4')
  await app!.close()
  app = undefined
  page = await launch()
  cell = page.getByTestId(`activity-day-${localDay}`)
  await expect(cell).toHaveAttribute('data-count', '2')
  await cell.click()
  await expect(page.getByTestId(`activity-attempt-${attempts[0].id}`)).toBeVisible()
  await expect(page.getByTestId(`activity-attempt-${attempts[1].id}`)).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
})
