import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  await app.evaluate(() => {
    const https = process.getBuiltinModule('https')
    https.request = (() => {
      throw new Error('Unexpected network in local profile test')
    }) as typeof https.request
  })
  const page = await app.firstWindow()
  await expect(page.getByRole('heading', { name: '今天，理解得更深一点。' })).toBeVisible()
  return page
}
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'examcraft-profiles-e2e-'))
})
test.afterEach(async () => {
  await app?.close()
  app = undefined
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

test('OS-encrypted named profiles survive restart with task routing and no renderer key readback', async () => {
  const page = await launch()
  const initial = await page.evaluate(() => window.examcraft!.getModelProfiles())
  test.skip(
    !initial.secureStorageAvailable,
    'This OS session has no secure key storage; fail-closed behavior is covered separately.',
  )
  await page.getByRole('button', { name: '配置模型 / 协议', exact: true }).click()
  const settings = page.getByRole('region', { name: '模型设置', exact: true })
  await settings.getByLabel('配置名称', { exact: true }).fill('深度审阅')
  const synthetic = 'synthetic-os-profile-key-not-a-real-credential'
  const key = settings.locator('input[type=password]')
  await key.fill(synthetic)
  await settings.getByRole('checkbox', { name: /使用操作系统加密/ }).check()
  await expect(key).toHaveAttribute('type', 'password')
  await settings.getByRole('button', { name: '保存模型设置', exact: true }).click()
  await expect(settings.getByRole('status')).toContainText('密钥已通过操作系统加密')
  await expect(key).toHaveValue('')
  const saved = await page.evaluate(() => window.examcraft!.getModelProfiles())
  expect(saved.profiles[0]).toMatchObject({
    profileName: '深度审阅',
    configured: true,
    keyStatus: 'saved',
  })
  expect(JSON.stringify(saved)).not.toContain(synthetic)
  expect(JSON.stringify(saved)).not.toContain('encryptedApiKey')
  expect(await readFile(join(directory, 'model-profiles.json'), 'utf8')).not.toContain(synthetic)
  expect(
    await page.evaluate(() =>
      JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
    ),
  ).not.toContain(synthetic)
  const child = await page.evaluate(async (revision) => {
    const state = await window.examcraft!.saveModelProfile({
      profileName: '轻量提示',
      protocol: 'openai-chat',
      baseUrl: 'https://api.deepseek.com',
      model: 'synthetic-small',
      apiKey: 'synthetic-child-session-only',
      persistApiKey: false,
      expectedRevision: revision,
    })
    const id = state.profiles.find((profile) => profile.profileName === '轻量提示')!.profileId
    return window.examcraft!.assignModelProfiles({
      roles: { ...state.roles, child: id },
      expectedRevision: state.revision,
    })
  }, saved.revision)
  expect(child.roles.parent).not.toBe(child.roles.child)
  await app!.close()
  app = undefined
  const restored = await launch()
  const state = await restored.evaluate(() => window.examcraft!.getModelProfiles())
  expect(state.roles).toEqual(child.roles)
  expect(state.profiles.find((p) => p.profileName === '深度审阅')).toMatchObject({
    configured: true,
    keyStatus: 'saved',
  })
  expect(state.profiles.find((p) => p.profileName === '轻量提示')).toMatchObject({
    configured: false,
    keyStatus: 'missing',
  })
  expect(await restored.evaluate(() => window.examcraft!.getModelConfig('parent'))).toMatchObject({
    configured: true,
    profileName: '深度审阅',
  })
  expect(await restored.evaluate(() => window.examcraft!.getModelConfig('child'))).toMatchObject({
    configured: false,
    model: 'synthetic-small',
  })
})
