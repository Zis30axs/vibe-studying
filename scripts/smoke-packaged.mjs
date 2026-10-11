import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
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
    await expect(page.locator('.page-footer')).toContainText(pkg.version)
    assert.equal(page.url(), 'examcraft://app/index.html')
    await expect(page.getByTestId('activity-heatmap')).toBeHidden()
    await page.locator('details.learning-overview > summary').click()
    await expect(page.getByTestId('activity-heatmap')).toBeVisible()
    return page
  }
  let page = await launch()
  await expect(page.getByRole('radio', { name: /自定义模型/ })).toBeDisabled()
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
  // Generate only original test documents. Real/private textbooks never enter CI or release assets.
  const fixtureModule = join(temporary, 'synthetic-pdf.mjs')
  await build({
    entryPoints: ['tests/fixtures/knowledge-pdf.ts'],
    outfile: fixtureModule,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
  })
  const { createKnowledgePdf } = await import(pathToFileURL(fixtureModule).href)
  const packDirectory = join(temporary, 'private-synthetic-pack')
  await mkdir(packDirectory)
  const subjects = ['chinese', 'math', 'english', 'politics', 'history', 'geography']
  const documents = []
  for (const subject of subjects) {
    const bytes = createKnowledgePdf([
      `Original synthetic ${subject} evidence.\nPDF physical page one.`,
    ])
    const file = `${subject}.pdf`
    let parts
    if (subject === 'english') {
      const cut = Math.floor(bytes.length / 2)
      parts = []
      for (const [index, data] of [bytes.subarray(0, cut), bytes.subarray(cut)].entries()) {
        const partFile = `${file}.part0${index + 1}`
        await writeFile(join(packDirectory, partFile), data)
        parts.push({
          file: partFile,
          sha256: createHash('sha256').update(data).digest('hex'),
          byteLength: data.length,
        })
      }
    } else await writeFile(join(packDirectory, file), bytes)
    documents.push({
      file,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      subject,
      title: `Synthetic ${subject}`,
      edition: 'Synthetic edition, not a textbook',
      editionConfirmed: false,
      ...(parts ? { parts } : {}),
    })
  }
  const manifestPath = join(packDirectory, 'pack.json')
  await writeFile(
    manifestPath,
    JSON.stringify({ version: 1, title: 'Synthetic six-subject pack', documents }),
  )
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, manifestPath)
  const library = page.getByRole('region', { name: '教材 PDF 知识库', exact: true })
  await library.locator('.knowledge-summary').click()
  await library.getByRole('button', { name: '导入教材资料包', exact: true }).click()
  await expect
    .poll(
      async () => (await page.evaluate(() => window.examcraft.listKnowledgeDocuments())).length,
      { timeout: 120000 },
    )
    .toBe(6)
  const cached = await page.evaluate(() => window.examcraft.listKnowledgeDocuments())
  assert.deepEqual(cached.map((document) => document.subject).sort(), subjects.slice().sort())
  for (const document of cached) {
    const hits = await page.evaluate(
      ({ id, subject }) =>
        window.examcraft.searchKnowledge({ documentId: id, subject, query: 'synthetic' }),
      { id: document.id, subject: document.subject },
    )
    assert.ok(hits.length > 0)
    assert.ok(
      hits.every(
        (hit) =>
          hit.documentId === document.id &&
          hit.subject === document.subject &&
          hit.pageNumber === 1,
      ),
    )
  }
  await library.getByLabel('知识库学科', { exact: true }).selectOption('math')
  await library
    .getByLabel('PDF 文档', { exact: true })
    .selectOption(cached.find((document) => document.subject === 'math').id)
  await expect(library.locator('canvas')).toBeVisible({ timeout: 30000 })
  await library.getByLabel('PDF 关键词', { exact: true }).fill('synthetic')
  await library.getByRole('button', { name: '检索本地文本', exact: true }).click()
  await expect(library.locator('.knowledge-hits')).toContainText('Original synthetic math')
  const repeated = await page.evaluate(() =>
    window.examcraft.importKnowledgePack('packaged-repeat'),
  )
  assert.equal(repeated.duplicateCount, 6)
  assert.equal(repeated.importedCount, 0)
  await app.close()
  app = undefined
  page = await launch()
  assert.equal((await page.evaluate(() => window.examcraft.loadState())).attempts.length, 1)
  assert.equal((await page.evaluate(() => window.examcraft.listKnowledgeDocuments())).length, 6)
  await expect(page.getByRole('alert')).toHaveCount(0)
  assert.deepEqual(errors, [])
  console.log(
    `Packaged smoke passed: ${artifact}.zip; packaged mode, production protocol, feature panels, submit/history, six-subject PDF package import/search/canvas, dedupe and restart.`,
  )
} finally {
  await app?.close()
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
}
