import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PRIVATE_REFERENCE = 'PRIVATE_GENERATED_REFERENCE_NEVER_IN_PREVIEW'
const PRIVATE_RUBRIC = 'PRIVATE_GENERATED_RUBRIC_NEVER_IN_PREVIEW'
const TITLE = '合成 AI 方位练习'
const fixture = {
  title: TITLE,
  prompt: '图中向右为东、向上为北，判断 A 相对 B 的方位，并说明依据。',
  maxScore: 4,
  explanation: PRIVATE_REFERENCE,
  rubric: [{ label: PRIVATE_RUBRIC, keywords: ['东北'], points: 4 }],
  figure: {
    version: 1,
    kind: 'schematic',
    title: '两个观测位置',
    description: '方向示意，非真实地图。',
    points: [
      { id: 'a', x: 40, y: 40, label: 'A' },
      { id: 'b', x: -40, y: -40, label: 'B' },
    ],
    segments: [{ id: 'ab', from: 'a', to: 'b' }],
    arrows: [],
    polylines: [],
    polygons: [],
    labels: [],
  },
}
let app: ElectronApplication | undefined
let directory: string

async function launch() {
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  delete env.ELECTRON_RUN_AS_NODE
  delete env.EXAMCRAFT_DEV_URL
  env.EXAMCRAFT_USER_DATA = directory
  env.DEEPSEEK_API_KEY = 'synthetic-generation-marker-not-a-credential'
  env.EXAMCRAFT_DEEPSEEK_MODEL = 'deepseek-flash'
  app = await electron.launch({ args: ['.'], env })
  // Replace the real HTTPS boundary before any authorized request. No DNS, API,
  // or live credential is used; the actual main service and preload remain intact.
  await app.evaluate((_electron, output) => {
    const state = globalThis as typeof globalThis & {
      generationBodies: { messages: { content: string }[] }[]
      generationMode: 'success' | 'pending' | 'failure'
      releaseGeneration?: () => void
    }
    state.generationBodies = []
    state.generationMode = 'success'
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
                signal: options.signal,
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
    globalThis.fetch = async (input, init) => {
      if (String(input) !== 'https://api.deepseek.com/chat/completions')
        throw new Error('Unexpected synthetic destination')
      state.generationBodies.push(JSON.parse(String(init?.body)))
      if (state.generationMode === 'failure') throw new Error('Synthetic generation unavailable')
      // Deliberately non-cooperative to prove late response suppression after cancel.
      if (state.generationMode === 'pending')
        await new Promise<void>((resolve) => {
          state.releaseGeneration = resolve
        })
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
  }, fixture)
  const page = await app.firstWindow()
  // CI display size must not silently turn this desktop scenario into a closed drawer.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setContentSize(1440, 960)
  })
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1440)
  await expect(page.getByRole('heading', { name: '今天，理解得更深一点。' })).toBeVisible()
  await page
    .getByRole('navigation', { name: '工作区导航' })
    .getByRole('button', { name: /地理工作台/ })
    .click()
  await page.locator('.geo-generator > summary').click()
  await expect(page.getByRole('region', { name: 'AI 地理出题', exact: true })).toBeVisible()
  return page
}
async function assertNoPrivateReference(page: Page) {
  // innerText alone misses hidden nodes. Check DOM markup and textContent too,
  // plus the actual public IPC payload returned by main.
  const contents = await page.evaluate(() => ({
    text: document.body.innerText,
    allText: document.body.textContent,
    html: document.documentElement.outerHTML,
  }))
  for (const content of Object.values(contents)) {
    expect(content).not.toContain(PRIVATE_REFERENCE)
    expect(content).not.toContain(PRIVATE_RUBRIC)
  }
  const questions = await page.evaluate(() => window.examcraft!.listQuestions())
  expect(JSON.stringify(questions)).not.toContain(PRIVATE_REFERENCE)
  expect(JSON.stringify(questions)).not.toContain(PRIVATE_RUBRIC)
  for (const question of questions) {
    expect(question).not.toHaveProperty('explanation')
    expect(question).not.toHaveProperty('rubric')
  }
}
async function requestPreview(page: Page) {
  const panel = page.getByRole('region', { name: 'AI 地理出题', exact: true })
  await panel.getByRole('checkbox', { name: /我同意本次/ }).check()
  await panel.getByRole('button', { name: '确认并生成一道题', exact: true }).click()
  await expect(page.getByRole('article', { name: '生成题目预览', exact: true })).toBeVisible()
}
async function callCount() {
  return app!.evaluate(
    () =>
      (globalThis as typeof globalThis & { generationBodies: unknown[] }).generationBodies.length,
  )
}
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'examcraft-generation-e2e-'))
})
test.afterEach(async () => {
  await app?.close()
  app = undefined
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

test('real UI consent → private preview → accept → practice → feedback and restart with figure snapshot', async () => {
  const page = await launch()
  const panel = page.getByRole('region', { name: 'AI 地理出题', exact: true })
  const generate = panel.getByRole('button', { name: '确认并生成一道题', exact: true })
  await expect(generate).toBeDisabled()
  await expect(panel).toContainText('https://api.deepseek.com')
  await expect(panel).toContainText('API 费用')
  expect(await callCount()).toBe(0)
  const before = await page.evaluate(() => window.examcraft!.listQuestions())
  await panel.getByRole('checkbox', { name: /我同意本次/ }).check()
  await panel.getByLabel('生成题目章节', { exact: true }).fill('合成经纬网')
  await expect(panel.getByRole('checkbox', { name: /我同意本次/ })).not.toBeChecked()
  await requestPreview(page)
  const preview = page.getByRole('article', { name: '生成题目预览', exact: true })
  await expect(preview.getByRole('heading', { name: TITLE, exact: true })).toBeVisible()
  await expect(preview.locator('.geography-figure svg')).toBeVisible()
  await expect(preview).toContainText('尚未核验')
  await assertNoPrivateReference(page)
  expect(await page.evaluate(() => window.examcraft!.listQuestions())).toHaveLength(before.length)
  expect((await page.evaluate(() => window.examcraft!.loadState())).attempts).toHaveLength(0)
  const inputs = await app!.evaluate(() =>
    (
      globalThis as typeof globalThis & { generationBodies: { messages: { content: string }[] }[] }
    ).generationBodies.map((body) => JSON.parse(body.messages[1].content)),
  )
  expect(inputs).toEqual([{ syllabus: '高中地理', chapter: '合成经纬网', difficulty: '基础' }])
  await preview.getByRole('button', { name: '加入题库并开始练习', exact: true }).click()
  await expect(page.locator('.question-prompt h2')).toHaveText(TITLE)
  await assertNoPrivateReference(page)
  const question = (await page.evaluate(() => window.examcraft!.listQuestions())).find(
    (item) => item.title === TITLE,
  )!
  expect(question.figure).toEqual(fixture.figure)
  await page.locator('#answer-text').fill('A 位于 B 的东北方向，因为横纵坐标都更大。')
  await page.getByRole('radio', { name: /本地规则/ }).check()
  await page.getByRole('button', { name: /提交并审阅/ }).click()
  const review = page.getByRole('region', { name: '审阅结果', exact: true })
  await expect(
    review.locator('.explanation').getByText(PRIVATE_REFERENCE, { exact: true }),
  ).toBeVisible()
  await expect(
    review.locator('.rubric-list').getByText(PRIVATE_RUBRIC, { exact: true }),
  ).toBeVisible()
  await review.getByText('本次题目与示意图快照', { exact: true }).click()
  await expect(review.locator('.geography-figure svg')).toBeVisible()
  const state = await page.evaluate(() => window.examcraft!.loadState())
  expect(state.attempts).toHaveLength(1)
  expect(state.attempts[0].questionSnapshot?.figure).toEqual(fixture.figure)
  expect(state.attempts[0].score).toBe(4)
  expect(await callCount()).toBe(1)
  await app!.close()
  app = undefined
  const restored = await launch()
  await restored.locator('.question-item').filter({ hasText: TITLE }).click()
  await expect(restored.locator('.question-prompt h2')).toHaveText(TITLE)
  await expect(restored.locator('.question-prompt .geography-figure svg')).toBeVisible()
  await assertNoPrivateReference(restored)
  await restored.getByRole('tab', { name: /审阅反馈/ }).click()
  const restoredReview = restored.getByRole('region', { name: '审阅结果', exact: true })
  await expect(
    restoredReview.locator('.explanation').getByText(PRIVATE_REFERENCE, { exact: true }),
  ).toBeVisible()
  await restoredReview.getByText('本次题目与示意图快照', { exact: true }).click()
  await expect(restoredReview.locator('.geography-figure svg')).toBeVisible()
  expect((await restored.evaluate(() => window.examcraft!.loadState())).attempts[0]).toEqual(
    state.attempts[0],
  )
})

test('rejecting a preview never writes the question or history and requires new generation consent', async () => {
  const page = await launch()
  const before = await page.evaluate(() => window.examcraft!.listQuestions())
  await requestPreview(page)
  await assertNoPrivateReference(page)
  await page.getByRole('button', { name: '舍弃 / 重新生成', exact: true }).click()
  await expect(page.getByRole('article', { name: '生成题目预览', exact: true })).toHaveCount(0)
  const panel = page.getByRole('region', { name: 'AI 地理出题', exact: true })
  await expect(panel.getByRole('checkbox', { name: /我同意本次/ })).not.toBeChecked()
  await expect(panel.getByRole('button', { name: '确认并生成一道题', exact: true })).toBeDisabled()
  expect(await page.evaluate(() => window.examcraft!.listQuestions())).toEqual(before)
  expect((await page.evaluate(() => window.examcraft!.loadState())).attempts).toEqual([])
  expect(await callCount()).toBe(1)
  await requestPreview(page)
  expect(await callCount()).toBe(2)
})

test('canceling a pending generation suppresses its late response with no automatic retry', async () => {
  const page = await launch()
  await app!.evaluate(() => {
    ;(globalThis as typeof globalThis & { generationMode: string }).generationMode = 'pending'
  })
  const panel = page.getByRole('region', { name: 'AI 地理出题', exact: true })
  const before = await page.evaluate(() => window.examcraft!.listQuestions())
  await panel.getByRole('checkbox', { name: /我同意本次/ }).check()
  await panel.getByRole('button', { name: '确认并生成一道题', exact: true }).click()
  await expect.poll(callCount).toBe(1)
  await panel.getByRole('button', { name: '取消生成', exact: true }).click()
  await app!.evaluate(() => {
    ;(globalThis as typeof globalThis & { releaseGeneration?: () => void }).releaseGeneration?.()
  })
  await expect(panel.getByRole('status')).toContainText('已取消')
  await expect(page.getByRole('article', { name: '生成题目预览', exact: true })).toHaveCount(0)
  await expect(panel.getByRole('checkbox', { name: /我同意本次/ })).not.toBeChecked()
  expect(await page.evaluate(() => window.examcraft!.listQuestions())).toEqual(before)
  expect((await page.evaluate(() => window.examcraft!.loadState())).attempts).toEqual([])
  await assertNoPrivateReference(page)
  expect(await callCount()).toBe(1)
})
