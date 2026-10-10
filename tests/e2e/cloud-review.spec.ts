import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let directory: string
let app: ElectronApplication | undefined
async function launch(configured: boolean, model = 'deepseek-flash') {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  delete env.ELECTRON_RUN_AS_NODE
  delete env.EXAMCRAFT_DEV_URL
  delete env.DEEPSEEK_API_KEY
  env.EXAMCRAFT_USER_DATA = directory
  env.EXAMCRAFT_DEEPSEEK_MODEL = model
  // Synthetic test marker only, never a real credential. All cloud fetches are replaced below.
  if (configured) env.DEEPSEEK_API_KEY = 'synthetic-test-marker-not-a-credential'
  app = await electron.launch({ args: ['.'], env })
  await app.evaluate(() => {
    globalThis.fetch = async () => {
      throw new Error('Network disabled by desktop test')
    }
  })
  const page = await app.firstWindow()
  await expect(page.getByRole('heading', { name: '今天，理解得更深一点。' })).toBeVisible()
  return page
}
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'examcraft-cloud-e2e-'))
})
test.afterEach(async () => {
  await app?.close()
  app = undefined
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

test('missing provider configuration remains offline and exposes no credential UI', async () => {
  const page = await launch(false)
  await expect(page.getByRole('radio', { name: /DeepSeek 云端/ })).toBeDisabled()
  await expect(page.locator('input[type=password]')).toHaveCount(0)
  await page.getByRole('radio').first().click()
  await page.getByRole('button', { name: '提交并审阅' }).click()
  await expect(page.getByLabel('审阅结果').locator('.score')).toHaveText('4 / 4')
})

test('mock cloud workflow requires each consent, preserves draft on failure and saves successful history', async () => {
  const page = await launch(true)
  expect(await app!.evaluate(() => process.env.DEEPSEEK_API_KEY)).toBeUndefined()
  await page.getByRole('radio').first().click()
  await page.getByLabel('思考笔记').fill('Synthetic answer for integration testing only')
  await page.getByRole('radio', { name: /DeepSeek 云端/ }).check()
  await page.getByLabel('学习范围 / 考纲（可选）').fill('Synthetic scope only')
  const consent = page.getByRole('checkbox', { name: /我同意本次/ })
  await expect(page.getByRole('button', { name: '提交并审阅' })).toBeDisabled()
  await consent.check()
  await page.getByLabel('思考笔记').fill('Synthetic revised answer')
  await expect(consent).not.toBeChecked()
  await consent.check()
  await page.getByRole('button', { name: '提交并审阅' }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  expect((await page.evaluate(() => window.examcraft!.loadState())).attempts).toHaveLength(0)
  expect(
    (await page.evaluate(() => window.examcraft!.loadState())).drafts['pol-choice-1'].text,
  ).toBe('Synthetic revised answer')
  await expect(consent).not.toBeChecked()
  await app!.evaluate(() => {
    globalThis.fetch = async (input, init) => {
      if (String(input) !== 'https://api.deepseek.com/chat/completions')
        throw new Error('Unexpected destination')
      const request = JSON.parse(String(init?.body))
      const data = JSON.parse(request.messages[1].content)
      if ('history' in data || 'attempts' in data || data.syllabus !== 'Synthetic scope only')
        throw new Error('Unexpected disclosure')
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({
                  feedback: 'Synthetic feedback only',
                  explanation: 'Synthetic explanation only',
                  rubric: [],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
  })
  await consent.check()
  await page.getByRole('button', { name: '提交并审阅' }).click()
  await expect(page.getByLabel('审阅结果').locator('.score')).toHaveText('4 / 4')
  await expect(page.getByText('Synthetic feedback only', { exact: true })).toBeVisible()
  await page.screenshot({ path: 'test-results/deepseek-mocked-workflow.png', fullPage: true })
  const state = await page.evaluate(() => window.examcraft!.loadState())
  expect(state.attempts).toHaveLength(1)
  expect(state.attempts[0].reviewer).toMatch(/^DeepSeek/)
  await app!.close()
  app = undefined
  const restored = await launch(false)
  await restored.getByRole('button', { name: /练习记录 Review/ }).click()
  await restored.locator('.history-item').first().click()
  await expect(restored.getByText('Synthetic feedback only', { exact: true })).toBeVisible()
})

test('invalid optional cloud model never blocks the offline desktop', async () => {
  const page = await launch(false, 'invalid model / value')
  await expect(page.getByText(/DeepSeek 模型配置无效/)).toBeVisible()
  await expect(page.getByRole('radio', { name: /DeepSeek 云端/ })).toBeDisabled()
  await page.getByRole('radio').first().click()
  await page.getByRole('button', { name: '提交并审阅' }).click()
  await expect(page.getByLabel('审阅结果').locator('.score')).toHaveText('4 / 4')
})
