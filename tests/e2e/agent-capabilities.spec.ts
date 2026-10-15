import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EMBEDDING_DIAGNOSTIC_TEXT, type EmbeddingPrepareInput } from '../../src/shared/embeddings'

interface CapabilityFixture {
  networkCalls: number
  diagnostics: unknown[]
  localSearches: unknown[]
  prepared: EmbeddingPrepareInput[]
  confirmed: unknown[]
}
declare global {
  var embeddingCapabilityFixture: CapabilityFixture
}

let app: ElectronApplication | undefined
let directory: string
const syntheticKey = 'synthetic-embedding-session-key-never-real'
const documentId = 'a'.repeat(64)

async function launch() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  for (const key of [
    'ELECTRON_RUN_AS_NODE',
    'EXAMCRAFT_DEV_URL',
    'DEEPSEEK_API_KEY',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
  ])
    delete env[key]
  env.EXAMCRAFT_USER_DATA = directory
  app = await electron.launch({ args: ['.'], env })
  // Main registers IPC asynchronously during startup. Install fixture handlers
  // only after the real window is ready, so fixtures cannot race registerIpc.
  const page = await app.firstWindow()
  await expect(page.getByRole('heading', { name: '今天，理解得更深一点。' })).toBeVisible()
  expect(
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      return { visible: window.isVisible(), focused: window.isFocused() }
    }),
  ).toEqual({ visible: false, focused: false })
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    globalThis.embeddingCapabilityFixture = {
      networkCalls: 0,
      diagnostics: [],
      localSearches: [],
      prepared: [],
      confirmed: [],
    }
    const rejectNetwork = () => {
      globalThis.embeddingCapabilityFixture.networkCalls++
      throw new Error('External network disabled in synthetic Agent capability tests')
    }
    const https = process.getBuiltinModule('https')
    const http = process.getBuiltinModule('http')
    https.request = rejectNetwork as typeof https.request
    http.request = rejectNetwork as typeof http.request
    ipcMain.removeHandler('examcraft:diagnose-embedding')
    ipcMain.handle('examcraft:diagnose-embedding', (_event, input: unknown) => {
      globalThis.embeddingCapabilityFixture.diagnostics.push(input)
      return { ok: true, dimensions: 4, latencyMs: 1 }
    })
    BrowserWindow.getAllWindows()[0].setContentSize(1440, 1100)
  })
  return page
}
async function openSettings(page: Page) {
  await page.getByRole('button', { name: '配置模型 / 协议', exact: true }).click()
  const settings = page.getByRole('region', { name: 'Embedding 设置与检索', exact: true })
  await expect(
    settings.getByRole('button', { name: '保存 Embedding 设置', exact: true }),
  ).toBeEnabled()
  return settings
}
async function configure(page: Page, existing?: Locator) {
  const settings = existing ?? (await openSettings(page))
  await settings.getByRole('checkbox', { name: '启用独立 Embedding 服务', exact: true }).check()
  await settings
    .getByLabel('Embedding API 地址', { exact: true })
    .fill('https://embedding.example/v1')
  await settings.getByLabel('Embedding 模型 ID', { exact: true }).fill('synthetic-embedding-model')
  await settings.getByLabel('Embedding API Key', { exact: true }).fill(syntheticKey)
  await expect(
    settings.getByRole('checkbox', { name: /使用系统加密保存这个新 Embedding Key/ }),
  ).not.toBeChecked()
  await settings.getByRole('button', { name: '保存 Embedding 设置', exact: true }).click()
  await expect(settings.getByRole('status')).toContainText('未发出连接测试或上传教材')
  return settings
}

test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'examcraft-capabilities-e2e-'))
})
test.afterEach(async () => {
  await app?.close()
  app = undefined
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

test('Skill selection prepares an explicit task without network or learning-record writes', async () => {
  const page = await launch()
  const before = await page.evaluate(() => window.examcraft!.loadState())
  await page.getByRole('button', { name: '数学工作台 Math lab', exact: true }).click()
  await page.getByRole('button', { name: 'Agent 工作台 Bounded tools', exact: true }).click()
  for (const title of [
    '解析几何分步引导',
    '错题原因自查',
    '针对性变式练习',
    '知识点主动复习',
    '教材证据检索',
  ]) {
    await expect(page.getByRole('button', { name: title, exact: true })).toBeVisible()
  }
  await page.getByRole('button', { name: '解析几何分步引导', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '本次任务', exact: true })).toHaveValue(
    /垂足与距离/u,
  )
  await expect(
    page.getByRole('button', { name: '开始本次 Agent 任务', exact: true }),
  ).toBeDisabled()
  await expect(
    page.getByRole('checkbox', { name: '附带当前答卷快照', exact: false }),
  ).not.toBeChecked()
  if (process.env.EXAMCRAFT_CAPTURE_CAPABILITIES) {
    await mkdir('work', { recursive: true })
    await page.screenshot({ path: 'work/agent-skills.png', fullPage: true })
  }
  await page.getByRole('button', { name: '针对性变式练习', exact: true }).click()
  await expect(page.getByRole('combobox', { name: '工作模式', exact: true })).toHaveValue('create')
  await expect(page.getByRole('textbox', { name: '本次任务', exact: true })).toHaveValue(/变式/u)
  expect(await page.evaluate(() => window.examcraft!.loadState())).toEqual(before)
  expect(await app!.evaluate(() => globalThis.embeddingCapabilityFixture.networkCalls)).toBe(0)
  expect(
    await app!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused()),
    ),
  ).toBe(true)
})

test('independent Embedding settings save locally without leaking a session key or changing chat profiles', async () => {
  let page = await launch()
  const before = await page.evaluate(async () => ({
    profiles: await window.examcraft!.getModelProfiles(),
    state: await window.examcraft!.loadState(),
  }))
  const settings = await configure(page)
  await expect(settings.getByLabel('Embedding API Key', { exact: true })).toHaveValue('')
  const config = await page.evaluate(() => window.examcraft!.getEmbeddingConfig())
  expect(config).toMatchObject({
    enabled: true,
    baseUrl: 'https://embedding.example/v1',
    model: 'synthetic-embedding-model',
    configured: true,
    keyStatus: 'session',
  })
  expect(JSON.stringify(config)).not.toContain(syntheticKey)
  expect(await page.evaluate(() => window.examcraft!.getModelProfiles())).toEqual(before.profiles)
  expect(await page.evaluate(() => window.examcraft!.loadState())).toEqual(before.state)
  expect(await readFile(join(directory, 'embedding-config.json'), 'utf8')).not.toContain(
    syntheticKey,
  )
  if (process.env.EXAMCRAFT_CAPTURE_CAPABILITIES) {
    await mkdir('work', { recursive: true })
    await settings.screenshot({ path: 'work/embedding-settings.png' })
  }
  expect(
    await page.evaluate(() =>
      JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
    ),
  ).not.toContain(syntheticKey)
  expect(await app!.evaluate(() => globalThis.embeddingCapabilityFixture)).toMatchObject({
    networkCalls: 0,
    diagnostics: [],
    confirmed: [],
  })
  await app!.close()
  app = undefined
  page = await launch()
  const restored = await page.evaluate(() => window.examcraft!.getEmbeddingConfig())
  expect(restored).toMatchObject({
    baseUrl: 'https://embedding.example/v1',
    model: 'synthetic-embedding-model',
    configured: false,
    keyStatus: 'missing',
  })
})

test('fixed-text Embedding diagnostics require a fresh explicit confirmation and never include study content', async () => {
  const page = await launch()
  const settings = await configure(page)
  const button = settings.getByRole('button', { name: '测试 Embedding 连接', exact: true })
  await expect(button).toBeDisabled()
  await expect(settings.getByLabel('Embedding 固定诊断文本', { exact: true })).toHaveText(
    EMBEDDING_DIAGNOSTIC_TEXT,
  )
  await settings.getByRole('checkbox', { name: '我同意发送固定诊断文本', exact: true }).check()
  await button.click()
  await expect(settings.getByRole('status')).toContainText('连接诊断成功，向量维度 4')
  await expect(button).toBeDisabled()
  const revision = await page.evaluate(
    async () => (await window.examcraft!.getEmbeddingConfig()).revision,
  )
  expect(await app!.evaluate(() => globalThis.embeddingCapabilityFixture.diagnostics)).toEqual([
    { expectedRevision: revision, cloudConsent: true },
  ])
  expect(await app!.evaluate(() => globalThis.embeddingCapabilityFixture.networkCalls)).toBe(0)
})

test('invalid Embedding endpoints fail locally without unhandled errors or leaking URL credentials', async () => {
  const page = await launch()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const settings = await openSettings(page)
  const before = await page.evaluate(() => window.examcraft!.getEmbeddingConfig())
  await settings
    .getByLabel('Embedding API 地址', { exact: true })
    .fill('https://user:synthetic-url-password@embedding.example/v1?secret=synthetic')
  await settings.getByRole('button', { name: '保存 Embedding 设置', exact: true }).click()
  await expect(settings.getByRole('alert')).toContainText(
    '请填写有效的 Embedding 模型 ID 与 HTTPS API 地址',
  )
  await expect(settings.getByRole('alert')).not.toContainText('synthetic-url-password')
  expect(await page.evaluate(() => window.examcraft!.getEmbeddingConfig())).toEqual(before)
  expect(await app!.evaluate(() => globalThis.embeddingCapabilityFixture.networkCalls)).toBe(0)
  expect(errors).toEqual([])
})

test('local fallback and exact outbound previews keep textbook scope and confirmation separate', async () => {
  const page = await launch()
  // Only retrieval/confirmation IPC results are synthetic; real renderer and preload
  // enforce the displayed choices. Provider calls remain blocked above.
  await app!.evaluate(({ ipcMain }, id) => {
    const hits = Array.from({ length: 4 }, (_, index) => ({
      chunkId: `${id}:p1:c${index + 1}`,
      documentId: id,
      documentTitle: '自编向量测试资料',
      subject: 'math',
      pageNumber: 1,
      text: `SYNTHETIC_TEXT_ONLY_${index + 1} 向量垂足`,
      score: 4 - index,
    }))
    ipcMain.removeHandler('examcraft:list-knowledge-documents')
    ipcMain.handle('examcraft:list-knowledge-documents', () => [
      {
        id,
        title: '自编向量测试资料',
        subject: 'math',
        pageCount: 3,
        textPageCount: 3,
        scopes: [],
        edition: '',
        editionConfirmed: false,
        byteLength: 100,
        importedAt: new Date().toISOString(),
      },
    ])
    ipcMain.removeHandler('examcraft:search-embedding-local')
    ipcMain.handle('examcraft:search-embedding-local', (_event, input: unknown) => {
      globalThis.embeddingCapabilityFixture.localSearches.push(input)
      return { mode: 'keyword', hits }
    })
    ipcMain.removeHandler('examcraft:prepare-embedding')
    ipcMain.handle('examcraft:prepare-embedding', (_event, input: EmbeddingPrepareInput) => {
      globalThis.embeddingCapabilityFixture.prepared.push(input)
      return {
        ...input,
        revision: input.expectedRevision,
        previewId: 'synthetic-preview',
        baseUrl: 'https://embedding.example/v1',
        model: 'synthetic-embedding-model',
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        texts:
          input.kind === 'search'
            ? [{ text: input.query, sha256: 'b'.repeat(64) }]
            : hits
                .filter((hit) => input.chunkIds.includes(hit.chunkId))
                .map((hit) => ({
                  chunkId: hit.chunkId,
                  pageNumber: hit.pageNumber,
                  text: hit.text,
                  sha256: 'c'.repeat(64),
                })),
      }
    })
    ipcMain.removeHandler('examcraft:confirm-embedding')
    ipcMain.handle('examcraft:confirm-embedding', (_event, input: unknown) => {
      globalThis.embeddingCapabilityFixture.confirmed.push(input)
      return { mode: 'keyword', hits, fallbackReason: 'synthetic-unavailable' }
    })
  }, documentId)
  const settings = await openSettings(page)
  expect(
    await page.evaluate(async () => (await window.examcraft!.getEmbeddingConfig()).configured),
  ).toBe(false)
  await settings.getByLabel('Embedding 检索内容', { exact: true }).fill('向量')
  await settings.getByRole('button', { name: '本地检索（关键词回退）', exact: true }).click()
  await expect(settings.getByRole('status')).toContainText('本地关键词检索')
  await expect(
    settings.getByRole('button', { name: '预览所选片段索引请求', exact: true }),
  ).toBeDisabled()
  await configure(page, settings)
  for (let chunk = 1; chunk <= 3; chunk++)
    await settings
      .getByRole('checkbox', { name: `选择片段 ${documentId}:p1:c${chunk}`, exact: true })
      .check()
  await expect(
    settings.getByRole('checkbox', { name: `选择片段 ${documentId}:p1:c4`, exact: true }),
  ).toBeDisabled()
  await settings.getByRole('button', { name: '预览所选片段索引请求', exact: true }).click()
  const preview = settings.getByRole('region', { name: 'Embedding 实际外发预览', exact: true })
  await expect(preview).toContainText('SYNTHETIC_TEXT_ONLY_1')
  await expect(preview).toContainText('SYNTHETIC_TEXT_ONLY_3')
  await expect(preview).not.toContainText('SYNTHETIC_TEXT_ONLY_4')
  await expect(
    preview.getByRole('button', { name: '确认发送本次 Embedding 请求', exact: true }),
  ).toBeDisabled()
  expect(await app!.evaluate(() => globalThis.embeddingCapabilityFixture.confirmed)).toEqual([])
  await settings.getByLabel('Embedding 检索内容', { exact: true }).fill('新的向量查询')
  await expect(preview).toHaveCount(0)
  await expect(settings.getByText('已选 0 / 3 个片段。', { exact: false })).toBeVisible()
  await settings.getByRole('button', { name: '预览语义检索请求', exact: true }).click()
  await expect(preview).toContainText('新的向量查询')
  await expect(preview).not.toContainText('SYNTHETIC_TEXT_ONLY')
  await preview.getByRole('checkbox', { name: '我同意发送本次预览内容', exact: true }).check()
  await preview.getByRole('button', { name: '确认发送本次 Embedding 请求', exact: true }).click()
  await expect(settings.getByRole('status')).toContainText('本地关键词检索')
  expect(await app!.evaluate(() => globalThis.embeddingCapabilityFixture.confirmed)).toEqual([
    { previewId: 'synthetic-preview', cloudConsent: true },
  ])
  expect(await app!.evaluate(() => globalThis.embeddingCapabilityFixture.localSearches)).toEqual([
    { subject: 'math', documentId, startPage: 1, endPage: 1, query: '向量', limit: 12 },
  ])
  expect(await app!.evaluate(() => globalThis.embeddingCapabilityFixture.networkCalls)).toBe(0)
})
