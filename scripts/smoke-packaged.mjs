import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect } from '@playwright/test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)
if (process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('Packaged Windows smoke test requires Windows x64.')
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const artifact = `ExamCraft-${pkg.version}-win-x64`
const archive = resolve('work/release', `${artifact}.zip`)
await stat(archive)
const temporary = await mkdtemp(join(tmpdir(), 'examcraft-packaged-'))
const extracted = join(temporary, 'extracted')
const userData = join(temporary, 'profile')
let app
const errors = []
try {
  // Test the actual release ZIP after extraction, not a development launch or staging folder.
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory($env:EXAMCRAFT_ZIP_SOURCE, $env:EXAMCRAFT_ZIP_TARGET)',
    ],
    {
      stdio: 'inherit',
      env: { ...process.env, EXAMCRAFT_ZIP_SOURCE: archive, EXAMCRAFT_ZIP_TARGET: extracted },
    },
  )
  const executablePath = join(extracted, artifact, 'ExamCraft.exe')
  await stat(executablePath)
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== undefined),
  )
  for (const key of [
    'ELECTRON_RUN_AS_NODE',
    'EXAMCRAFT_DEV_URL',
    'EXAMCRAFT_USER_DATA',
    'DEEPSEEK_API_KEY',
    'EXAMCRAFT_DEEPSEEK_MODEL',
  ])
    delete env[key]
  async function launch() {
    app = await electron.launch({
      executablePath,
      args: [`--user-data-dir=${userData}`],
      env,
      timeout: 45000,
    })
    const identity = await app.evaluate(({ app }) => ({
      packaged: app.isPackaged,
      version: app.getVersion(),
      userData: app.getPath('userData'),
    }))
    assert.equal(identity.packaged, true, 'Smoke test must exercise app.isPackaged === true')
    assert.equal(identity.version, pkg.version)
    assert.equal(
      resolve(identity.userData).toLowerCase(),
      resolve(userData).toLowerCase(),
      'Refuse to use the normal profile in smoke tests',
    )
    const page = await app.firstWindow()
    page.on('pageerror', (error) => errors.push(error.message))
    await expect(page.getByRole('heading', { name: '今天，理解得更深一点。' })).toBeVisible()
    assert.equal(page.url(), 'examcraft://app/index.html')
    await expect(page.getByTestId('activity-heatmap')).toBeVisible()
    return page
  }
  let page = await launch()
  await expect(page.getByRole('radio', { name: /DeepSeek 云端/ })).toBeDisabled()
  await page.getByRole('radio').first().click()
  await page.getByLabel('思考笔记').fill('Packaged application persistence smoke test')
  await page.getByRole('button', { name: '提交并审阅', exact: true }).click()
  await expect(page.getByLabel('审阅结果').locator('.score')).toHaveText('4 / 4')
  assert.equal((await page.evaluate(() => window.examcraft.loadState())).attempts.length, 1)
  await page
    .getByRole('navigation', { name: '工作区导航' })
    .getByRole('button', { name: /文科组装 Argument/ })
    .click()
  await expect(page.getByTestId('humanities-composer')).toBeVisible()
  await page
    .getByRole('navigation', { name: '工作区导航' })
    .getByRole('button', { name: /数学工作台/ })
    .click()
  await expect(page.getByRole('region', { name: '数学交互工作台', exact: true })).toBeVisible()
  await app.close()
  app = undefined
  page = await launch()
  assert.equal((await page.evaluate(() => window.examcraft.loadState())).attempts.length, 1)
  await expect(page.getByRole('alert')).toHaveCount(0)
  assert.deepEqual(errors, [])
  console.log(
    `Packaged smoke passed: ${artifact}.zip; packaged mode, production protocol, all three feature panels, submit, persisted history, restart.`,
  )
} finally {
  await app?.close()
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
}
