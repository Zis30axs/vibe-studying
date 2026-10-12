import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelDiagnosticInput, ModelDiagnosticResult } from '../../src/shared/types'

interface NetworkFixture {
  diagnostics: Pick<ModelDiagnosticInput, 'requestId' | 'kind' | 'network'>[]
  cancelled: string[]
  pending: Map<string, (value: ModelDiagnosticResult) => void>
  delay: boolean
}
declare global {
  var modelNetworkFixture: NetworkFixture
}

let app: ElectronApplication | undefined
let directory: string

async function launch() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  delete env.ELECTRON_RUN_AS_NODE
  delete env.EXAMCRAFT_DEV_URL
  delete env.DEEPSEEK_API_KEY
  env.EXAMCRAFT_USER_DATA = directory
  app = await electron.launch({ args: ['.'], env })
  const page = await app.firstWindow()
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    // Exercise the real renderer, preload, and profile store with synthetic input.
    // Diagnostics are an IPC fixture: no provider, proxy, DNS, or real credentials.
    const https = process.getBuiltinModule('https')
    const http = process.getBuiltinModule('http')
    https.request = (() => {
      throw new Error('Network disabled by model network settings test')
    }) as typeof https.request
    http.request = (() => {
      throw new Error('Network disabled by model network settings test')
    }) as typeof http.request
    globalThis.modelNetworkFixture = {
      diagnostics: [],
      cancelled: [],
      pending: new Map(),
      delay: false,
    }
    ipcMain.removeHandler('examcraft:diagnose-model')
    ipcMain.handle('examcraft:diagnose-model', (_event, input: ModelDiagnosticInput) => {
      const fixture = globalThis.modelNetworkFixture
      fixture.diagnostics.push({
        requestId: input.requestId,
        kind: input.kind,
        network: input.network,
      })
      if (fixture.delay)
        return new Promise<ModelDiagnosticResult>((resolve) => {
          fixture.pending.set(input.requestId, resolve)
        })
      return input.kind === 'list'
        ? { models: [{ id: 'synthetic-listed-model' }] }
        : { latencyMs: 1 }
    })
    ipcMain.removeHandler('examcraft:cancel-model-diagnostic')
    ipcMain.handle('examcraft:cancel-model-diagnostic', (_event, requestId: string) => {
      const fixture = globalThis.modelNetworkFixture
      fixture.cancelled.push(requestId)
      fixture.pending.get(requestId)?.({ models: [{ id: 'late-cancelled-model' }] })
      fixture.pending.delete(requestId)
    })
    BrowserWindow.getAllWindows()[0].setContentSize(1440, 1100)
  })
  await expect(page.getByRole('heading', { name: '今天，理解得更深一点。' })).toBeVisible()
  await page.getByRole('button', { name: '配置模型 / 协议', exact: true }).click()
  return { page, settings: page.getByRole('region', { name: '模型设置', exact: true }) }
}

test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'examcraft-network-settings-e2e-'))
})

test.afterEach(async () => {
  await app?.close()
  app = undefined
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

test('direct, system, and local proxy choices save per profile and survive restart', async () => {
  const { page, settings } = await launch()
  const mode = settings.getByLabel('网络连接方式', { exact: true })
  const proxy = settings.getByLabel('本机 HTTP 代理地址', { exact: true })
  await expect(mode).toHaveValue('direct')
  await expect(proxy).toHaveCount(0)
  await settings.getByLabel('配置名称', { exact: true }).fill('Synthetic proxy profile')
  await settings.locator('input[type=password]').fill('synthetic-proxy-key-never-real')
  await settings.getByRole('button', { name: '保存模型设置', exact: true }).click()
  await expect(settings.getByRole('status')).toContainText('密钥仅在本次应用会话中使用')
  const first = await page.evaluate(() => window.examcraft!.getModelConfig())
  expect(first.network).toEqual({ mode: 'direct' })

  await mode.selectOption('system')
  await expect(proxy).toHaveCount(0)
  await settings.getByRole('button', { name: '新建配置', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('放弃未保存的编辑')
  await page.getByRole('button', { name: '继续编辑', exact: true }).click()
  await settings.getByRole('button', { name: '保存模型设置', exact: true }).click()
  await expect(settings.getByRole('status')).toContainText('密钥仅在本次应用会话中使用')
  expect(await page.evaluate(() => window.examcraft!.getModelConfig())).toMatchObject({
    network: { mode: 'system' },
    configured: true,
    revision: first.revision + 1,
  })

  await mode.selectOption('local')
  await proxy.fill('http://127.0.0.1:7897')
  await settings.getByRole('button', { name: '保存模型设置', exact: true }).click()
  await expect(settings.getByRole('status')).toContainText('密钥仅在本次应用会话中使用')
  expect(await page.evaluate(() => window.examcraft!.getModelConfig())).toMatchObject({
    network: { mode: 'local', proxyUrl: 'http://127.0.0.1:7897' },
    configured: true,
    revision: first.revision + 2,
  })
  expect(await readFile(join(directory, 'model-profiles.json'), 'utf8')).not.toContain(
    'synthetic-proxy-key-never-real',
  )
  await app!.close()
  app = undefined
  const restored = await launch()
  await expect(restored.settings.getByLabel('网络连接方式', { exact: true })).toHaveValue('local')
  await expect(restored.settings.getByLabel('本机 HTTP 代理地址', { exact: true })).toHaveValue(
    'http://127.0.0.1:7897',
  )
})

test('draft diagnostics use the selected route and network edits cancel stale results', async () => {
  const { page, settings } = await launch()
  const initial = await page.evaluate(() => window.examcraft!.getModelConfig())
  const mode = settings.getByLabel('网络连接方式', { exact: true })
  await mode.selectOption('local')
  const proxy = settings.getByLabel('本机 HTTP 代理地址', { exact: true })
  await proxy.fill('http://192.168.1.1:7897')
  await settings.getByRole('button', { name: '获取模型', exact: true }).click()
  await expect(settings).toContainText('请填写有效的本机 HTTP 代理')
  expect(await app!.evaluate(() => globalThis.modelNetworkFixture.diagnostics.length)).toBe(0)
  await proxy.fill('http://[::1]:7897')
  await settings.getByRole('button', { name: '获取模型', exact: true }).click()
  await expect(settings).toContainText('已获取 1 个模型')
  await settings.getByRole('button', { name: '测试 API 连接', exact: true }).click()
  await expect(settings).toContainText('连接测试成功')
  expect(
    await app!.evaluate(() =>
      globalThis.modelNetworkFixture.diagnostics.map((item) => ({
        kind: item.kind,
        network: item.network,
      })),
    ),
  ).toEqual([
    { kind: 'list', network: { mode: 'local', proxyUrl: 'http://[::1]:7897' } },
    { kind: 'test', network: { mode: 'local', proxyUrl: 'http://[::1]:7897' } },
  ])
  expect(await page.evaluate(() => window.examcraft!.getModelConfig())).toEqual(initial)

  await app!.evaluate(() => {
    globalThis.modelNetworkFixture.delay = true
  })
  await settings.getByRole('button', { name: '获取模型', exact: true }).click()
  await expect(settings.getByRole('button', { name: '取消诊断', exact: true })).toBeVisible()
  await mode.selectOption('system')
  await expect
    .poll(() => app!.evaluate(() => globalThis.modelNetworkFixture.cancelled.length))
    .toBe(1)
  await expect(settings.getByRole('button', { name: '取消诊断', exact: true })).toHaveCount(0)
  await expect(settings).not.toContainText('late-cancelled-model')
  await expect(settings).not.toContainText('已获取')
})

test('legacy DeepSeek desktop submissions cannot bypass the selected network route', async () => {
  const { page } = await launch()
  await expect(
    page.evaluate(() =>
      window.examcraft!.submitAnswer(
        'synthetic-unused-question',
        { text: '', blocks: [], drawing: { points: [], lines: [], mode: 'cartesian' } },
        { provider: 'deepseek' },
      ),
    ),
  ).rejects.toThrow('已迁移的模型配置')
})
