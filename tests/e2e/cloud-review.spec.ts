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

test('mock humanities review resets consent and sends current final text and structure without stale blocks or history', async () => {
  const page = await launch(true)
  const historyMarker = 'SYNTHETIC_PRIOR_HISTORY_MUST_NOT_BE_SENT'
  const legacyMarker = 'SYNTHETIC_STALE_LEGACY_BLOCK_MUST_NOT_BE_SENT'
  await page.getByRole('radio').first().click()
  await page.getByLabel('思考笔记').fill(historyMarker)
  await page.getByRole('button', { name: '提交并审阅', exact: true }).click()
  await expect(page.getByRole('region', { name: '审阅结果', exact: true })).toBeVisible()
  await page.getByRole('button', { name: /文科组装 Argument/ }).click()
  await page.getByTestId('palette-principle').click()
  await page.getByTestId('drop-root').click()
  const principle = await page
    .getByTestId('argument-canvas')
    .locator('[data-block-id]')
    .first()
    .getAttribute('data-block-id')
  expect(principle).toBeTruthy()
  await page.getByTestId(`text-${principle}`).fill('Synthetic principle before edit.')
  await page.locator('#answer-text').fill('Synthetic manually authored final text.')
  await page.getByRole('radio', { name: /DeepSeek 云端/ }).check()
  const consent = page.getByRole('checkbox', { name: /我同意本次/ })
  await consent.check()
  await page
    .getByTestId(`text-${principle}`)
    .fill('Synthetic revised principle for this submission.')
  await expect(consent).not.toBeChecked()
  await consent.check()
  await page.getByTestId('palette-material').click()
  await page.getByTestId('drop-root').click()
  await expect(consent).not.toBeChecked()
  const material = await page
    .getByTestId('argument-canvas')
    .locator('[data-block-id]')
    .last()
    .getAttribute('data-block-id')
  await page.getByTestId(`text-${material}`).fill('Synthetic current evidence.')
  const expectedText = await page.getByTestId('argument-preview').inputValue()
  await consent.check()
  await page.getByTestId('sync-argument').click()
  await page.getByTestId('confirm-sync').click()
  await expect(consent).not.toBeChecked()
  await expect(page.locator('#answer-text')).toHaveValue(expectedText)

  // Seed a supported transitional record with a current argument plus stale legacy
  // blocks. It must still submit only the final text and current structure.
  await expect(page.getByRole('status').filter({ hasText: '已保存到本机' })).toBeVisible()
  await page.evaluate(async (marker) => {
    const state = await window.examcraft!.loadState()
    const draft = state.drafts['pol-assembly-1']
    await window.examcraft!.saveDraft('pol-assembly-1', {
      ...draft,
      blocks: [{ id: 'stale-legacy', category: 'analysis', label: 'Legacy fixture', text: marker }],
    })
  }, legacyMarker)
  await page.reload()
  await expect(page.getByRole('heading', { name: '今天，理解得更深一点。' })).toBeVisible()
  await page.getByRole('button', { name: /文科组装 Argument/ }).click()
  await expect(page.locator('#answer-text')).toHaveValue(expectedText)
  const currentState = await page.evaluate(() => window.examcraft!.loadState())
  const expectedArgument = currentState.drafts['pol-assembly-1'].argument
  expect(expectedArgument).toBeDefined()
  expect(currentState.drafts['pol-assembly-1'].blocks[0].text).toBe(legacyMarker)
  expect(currentState.attempts).toHaveLength(1)
  await app!.evaluate(() => {
    globalThis.fetch = async (input, init) => {
      if (String(input) !== 'https://api.deepseek.com/chat/completions')
        throw new Error('Unexpected destination')
      const request = JSON.parse(String(init?.body))
      const payload = JSON.parse(request.messages[1].content)
      ;(globalThis as typeof globalThis & { humanitiesPayload?: unknown }).humanitiesPayload =
        payload
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({
                  feedback: 'Synthetic humanities feedback only',
                  explanation: 'Synthetic humanities explanation only',
                  rubric: payload.question.rubric.map((item: { id: string }) => ({
                    id: item.id,
                    earned: 0,
                    feedback: 'Synthetic rubric result only',
                  })),
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
  })
  await page.getByRole('radio', { name: /DeepSeek 云端/ }).check()
  await page.getByRole('checkbox', { name: /我同意本次/ }).check()
  await page.getByRole('button', { name: '提交并审阅', exact: true }).click()
  await expect(page.getByText('Synthetic humanities feedback only', { exact: true })).toBeVisible()
  const payload = await app!.evaluate(
    () => (globalThis as typeof globalThis & { humanitiesPayload?: unknown }).humanitiesPayload,
  )
  expect(payload).toMatchObject({ answer: { text: expectedText, argument: expectedArgument } })
  expect(payload).not.toHaveProperty('answer.blocks')
  expect(payload).not.toHaveProperty('history')
  expect(payload).not.toHaveProperty('attempts')
  expect(JSON.stringify(payload)).not.toContain(legacyMarker)
  expect(JSON.stringify(payload)).not.toContain(historyMarker)
  const submitted = await page.evaluate(() => window.examcraft!.loadState())
  expect(submitted.attempts).toHaveLength(2)
  expect(submitted.attempts[1].draft.text).toBe(expectedText)
  expect(submitted.attempts[1].draft.argument).toEqual(expectedArgument)
  expect(submitted.attempts[1].reviewer).toMatch(/^DeepSeek/)
  await expect(page.getByRole('alert')).toHaveCount(0)
})
