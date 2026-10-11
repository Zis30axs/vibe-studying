import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
    // Replace the actual HTTPS boundary, so neither DNS nor network is used.
    // Existing fetch-shaped fixtures below are merely in-memory response factories.
    globalThis.fetch = async () => {
      throw new Error('Network disabled by desktop test')
    }
    const https = process.getBuiltinModule('https')
    const { EventEmitter } = process.getBuiltinModule('events')
    const { Readable } = process.getBuiltinModule('stream')
    https.request = ((
      input: string,
      options: import('node:https').RequestOptions,
      callback: (response: import('node:http').IncomingMessage) => void,
    ) => {
      const request = new EventEmitter()
      Object.assign(request, {
        end(body: string) {
          Promise.resolve()
            .then(async () => {
              const result = await globalThis.fetch(input, {
                method: 'POST',
                headers: options.headers as Record<string, string>,
                body,
              })
              const response = Readable.from([Buffer.from(await result.arrayBuffer())])
              Object.assign(response, {
                statusCode: result.status,
                headers: Object.fromEntries(result.headers.entries()),
              })
              callback(response as import('node:http').IncomingMessage)
            })
            .catch((error) => request.emit('error', error))
          return request
        },
      })
      return request
    }) as typeof https.request
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

test('missing provider configuration remains offline and keeps credentials out of practice', async () => {
  const page = await launch(false)
  await expect(page.getByRole('radio', { name: /自定义模型/ })).toBeDisabled()
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
  await page.getByRole('radio', { name: /自定义模型/ }).check()
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
  expect(state.attempts[0].reviewer).toBe('openai-chat · deepseek-flash')
  await app!.close()
  app = undefined
  const restored = await launch(false)
  await restored.getByRole('button', { name: /练习记录 Review/ }).click()
  await restored.locator('.history-item').first().click()
  await expect(restored.getByText('Synthetic feedback only', { exact: true })).toBeVisible()
})

test('invalid optional cloud model never blocks the offline desktop', async () => {
  const page = await launch(false, 'invalid model / value')
  const capabilities = await page.evaluate(() => window.examcraft!.getCapabilities())
  expect(capabilities.deepseek?.error).toContain('DeepSeek 模型配置无效')
  expect(await page.evaluate(() => window.examcraft!.getModelConfig())).toMatchObject({
    model: 'deepseek-flash',
    configured: false,
  })
  await expect(page.getByRole('radio', { name: /自定义模型/ })).toBeDisabled()
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
  await page.getByTestId('place-center').click()
  const principle = await page
    .getByTestId('argument-canvas')
    .locator('[data-block-id]')
    .first()
    .getAttribute('data-block-id')
  expect(principle).toBeTruthy()
  await page.getByTestId(`text-${principle}`).fill('Synthetic principle before edit.')
  await page.locator('#answer-text').fill('Synthetic manually authored final text.')
  await page.getByRole('radio', { name: /自定义模型/ }).check()
  const consent = page.getByRole('checkbox', { name: /我同意本次/ })
  await consent.check()
  await page
    .getByTestId(`text-${principle}`)
    .fill('Synthetic revised principle for this submission.')
  await expect(consent).not.toBeChecked()
  await consent.check()
  await page.getByTestId('palette-material').click()
  await page.getByTestId('place-center').click()
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
  await page.getByRole('radio', { name: /自定义模型/ }).check()
  await page.getByRole('checkbox', { name: /我同意本次/ }).check()
  await page.getByRole('button', { name: '提交并审阅', exact: true }).click()
  await expect(page.getByText('Synthetic humanities feedback only', { exact: true })).toBeVisible()
  const payload = await app!.evaluate(
    () => (globalThis as typeof globalThis & { humanitiesPayload?: unknown }).humanitiesPayload,
  )
  // Grading intentionally sends logical content, not local canvas coordinates.
  // The submitted local snapshot below must still retain the complete document.
  expect(payload).toMatchObject({
    answer: {
      text: expectedText,
      argument: { version: expectedArgument!.version, roots: expectedArgument!.roots },
    },
  })
  expect(payload).not.toHaveProperty('answer.argument.canvas')
  expect(payload).not.toHaveProperty('answer.blocks')
  expect(payload).not.toHaveProperty('history')
  expect(payload).not.toHaveProperty('attempts')
  expect(JSON.stringify(payload)).not.toContain(legacyMarker)
  expect(JSON.stringify(payload)).not.toContain(historyMarker)
  const submitted = await page.evaluate(() => window.examcraft!.loadState())
  expect(submitted.attempts).toHaveLength(2)
  expect(submitted.attempts[1].draft.text).toBe(expectedText)
  expect(submitted.attempts[1].draft.argument).toEqual(expectedArgument)
  expect(submitted.attempts[1].reviewer).toBe('openai-chat · deepseek-flash')
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('model settings offer four protocols without network and keep synthetic keys session-only', async () => {
  const page = await launch(false)
  await app!.evaluate(() => {
    ;(globalThis as typeof globalThis & { modelNetworkCalls: number }).modelNetworkCalls = 0
    globalThis.fetch = async () => {
      ;(globalThis as typeof globalThis & { modelNetworkCalls: number }).modelNetworkCalls += 1
      throw new Error('Network disabled by desktop test')
    }
  })
  await page.getByRole('button', { name: '配置模型 / 协议', exact: true }).click()
  const settings = page.getByRole('region', { name: '模型设置', exact: true })
  const protocol = settings.getByLabel('API 协议', { exact: true })
  await expect(protocol.locator('option')).toHaveCount(4)
  for (const value of ['anthropic', 'gemini', 'openai-responses', 'openai-chat']) {
    await protocol.selectOption(value)
    await expect(settings.getByLabel('接口基础地址', { exact: true })).toHaveValue(/^https:\/\//)
    await expect(settings.getByLabel('模型名称', { exact: true })).not.toHaveValue('')
  }
  const syntheticKey = 'synthetic-settings-marker-not-a-credential'
  const keyInput = settings.getByLabel('API Key（仅本次会话）', { exact: true })
  await keyInput.fill(syntheticKey)
  await settings.getByRole('button', { name: '保存模型设置', exact: true }).click()
  await expect(settings.getByRole('status')).toContainText(
    '设置已保存。密钥仅在本次应用会话中使用。',
  )
  await expect(keyInput).toHaveValue('')
  const config = await page.evaluate(() => window.examcraft!.getModelConfig())
  expect(config).toMatchObject({
    protocol: 'openai-chat',
    baseUrl: 'https://api.deepseek.com',
    configured: true,
  })
  expect(JSON.stringify(config)).not.toContain(syntheticKey)
  const persisted = await app!.evaluate(async () => {
    const { readFile } = process.getBuiltinModule('fs/promises')
    const { join } = process.getBuiltinModule('path')
    return readFile(join(process.env.EXAMCRAFT_USER_DATA!, 'model-profiles.json'), 'utf8')
  })
  expect(persisted).not.toContain(syntheticKey)
  expect(persisted).not.toContain('apiKey')
  expect(
    await page.evaluate(() =>
      JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
    ),
  ).not.toContain(syntheticKey)
  expect(
    await app!.evaluate(
      () => (globalThis as typeof globalThis & { modelNetworkCalls: number }).modelNetworkCalls,
    ),
  ).toBe(0)
  await app!.close()
  app = undefined
  const restored = await launch(false)
  expect(await restored.evaluate(() => window.examcraft!.getModelConfig())).toMatchObject({
    protocol: 'openai-chat',
    baseUrl: 'https://api.deepseek.com',
    model: config.model,
    revision: config.revision,
    configured: false,
  })
  await expect(restored.getByRole('radio', { name: /自定义模型/ })).toBeDisabled()
})

test('unreadable optional model configuration does not block offline practice', async () => {
  await writeFile(join(directory, 'model-config.json'), '{invalid json', 'utf8')
  const page = await launch(false)
  await expect(page.getByRole('alert')).toContainText('本地练习仍可使用')
  await page.getByRole('radio').first().click()
  await page.getByRole('button', { name: '提交并审阅', exact: true }).click()
  await expect(page.getByLabel('审阅结果').locator('.score')).toHaveText('4 / 4')
})

test('session Debug classifies a mocked malformed reply, copies only safe metadata, and clears on disable', async () => {
  const page = await launch(true)
  await page.getByRole('button', { name: '配置模型 / 协议', exact: true }).click()
  const debug = page.getByRole('region', { name: 'Debug · 本地脱敏诊断' })
  await expect(debug.getByRole('checkbox', { name: '开启本次会话 Debug' })).not.toBeChecked()
  await debug.getByRole('checkbox', { name: '开启本次会话 Debug' }).check()
  await page.getByRole('button', { name: /题目练习/ }).click()
  const answer = 'synthetic-private-debug-answer'
  await page.getByRole('radio').first().click()
  await page.getByLabel('思考笔记').fill(answer)
  await page.getByRole('radio', { name: /自定义模型/ }).check()
  await page.getByRole('checkbox', { name: /我同意本次/ }).check()
  await app!.evaluate(() => {
    globalThis.fetch = async () => new Response('{malformed-provider-response')
  })
  await page.getByRole('button', { name: '提交并审阅' }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  const state = await page.evaluate(() => window.examcraft!.getModelDebug())
  expect(state.records.some((record) => record.category === 'parse')).toBe(true)
  expect(JSON.stringify(state)).not.toContain(answer)
  expect(JSON.stringify(state)).not.toContain('synthetic-test-marker-not-a-credential')
  expect(JSON.stringify(state)).not.toContain('malformed-provider-response')
  await page.getByRole('button', { name: '配置模型 / 协议', exact: true }).click()
  await expect(debug.getByRole('checkbox', { name: '开启本次会话 Debug' })).toBeChecked()
  await debug.getByRole('button', { name: '复制脱敏诊断' }).click()
  await expect(debug.getByRole('status')).toContainText('已将脱敏诊断复制')
  const copied = await app!.evaluate(({ clipboard }) => clipboard.readText())
  expect(copied).toContain('examcraft-model-debug-v1')
  expect(copied).not.toContain(answer)
  expect(copied).not.toContain('synthetic-test-marker-not-a-credential')
  await debug.getByRole('checkbox', { name: '开启本次会话 Debug' }).uncheck()
  await expect(debug.getByRole('status')).toContainText('Debug 已关闭，记录已清空')
  expect((await page.evaluate(() => window.examcraft!.getModelDebug())).records).toEqual([])
})

test('formal AI review exposes elapsed/cancel and does not save a cancelled late review', async () => {
  const page = await launch(true)
  await page.getByRole('radio').first().click()
  await page.getByRole('radio', { name: /自定义模型/ }).check()
  await page.getByRole('checkbox', { name: /我同意本次/ }).check()
  await app!.evaluate(() => {
    globalThis.fetch = async () => new Promise<Response>(() => {})
  })
  await page.getByRole('button', { name: '提交并审阅' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'AI 答卷审查进行中' })).toBeVisible()
  await expect(page.getByRole('timer')).toContainText('已用时')
  await page.getByRole('button', { name: '取消 AI 审查' }).click()
  await expect(page.getByRole('button', { name: '提交并审阅' })).toBeVisible()
  expect((await page.evaluate(() => window.examcraft!.loadState())).attempts).toHaveLength(0)
  await expect(page.getByRole('button', { name: '取消 AI 审查' })).toHaveCount(0)
})
