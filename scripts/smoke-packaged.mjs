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
    // Exercise desktop panels deterministically even on a smaller CI display.
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1440, 960),
    )
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1440)
    // A freshly extracted Windows build can still be initializing its local profile
    // after the renderer opens. Wait for real readiness without skipping any assertions.
    try {
      await expect(page.getByRole('heading', { name: '今天，理解得更深一点。' })).toBeVisible({
        timeout: 30000,
      })
    } catch (error) {
      await mkdir('test-results', { recursive: true })
      await page.screenshot({ path: 'test-results/packaged-startup.png', fullPage: true })
      console.error('Packaged startup page errors:', errors)
      throw error
    }
    // Block the provider boundary for the whole packaged session. This is set
    // after real startup, before exercising any configuration or model action.
    await app.evaluate(() => {
      globalThis.packagedProviderRequests = 0
      const rejectProvider = () => {
        globalThis.packagedProviderRequests++
        throw new Error('Provider requests are disabled in packaged smoke tests')
      }
      process.getBuiltinModule('http').request = rejectProvider
      process.getBuiltinModule('https').request = rejectProvider
      process.getBuiltinModule('module').syncBuiltinESMExports()
    })
    await expect(page.locator('.page-footer')).toContainText(pkg.version)
    assert.equal(page.url(), 'examcraft://app/index.html')
    await expect(page.getByTestId('activity-heatmap')).toHaveCount(0)
    const navigation = page.getByRole('navigation', { name: '工作区导航' })
    await navigation.getByRole('button', { name: '练习记录 Review & reflect', exact: true }).click()
    const overview = page.getByRole('region', { name: '学习概览', exact: true })
    await expect(overview).toBeVisible()
    await expect(overview.getByTestId('activity-heatmap')).toBeVisible()
    await expect(overview.locator('summary')).toHaveCount(0)
    await navigation.getByRole('button', { name: '题目练习 Practice', exact: true }).click()
    await expect(page.getByTestId('activity-heatmap')).toHaveCount(0)
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
  await page.locator('.question-item').filter({ hasText: '解一元一次方程' }).click()
  let math = page.getByRole('region', { name: '数学交互工作台', exact: true })
  async function savedGeometry() {
    return page.evaluate(async () => {
      const value = (await window.examcraft.loadState()).drafts['math-solution-1']?.math
      return {
        drawing: value?.drawing,
        rightAngles: value?.rightAngles,
        geometry: value?.geometry,
      }
    })
  }
  // Construct the perpendicular through P to AB through the real packaged UI.
  for (const [index, [label, x, y]] of [
    ['A', '0', '0'],
    ['B', '4', '0'],
    ['P', '1', '3'],
  ].entries()) {
    if (index) await math.getByRole('button', { name: '新建数学点', exact: true }).click()
    await math.getByLabel('数学点标记', { exact: true }).fill(label)
    await math.getByLabel('数学 X 坐标', { exact: true }).fill(x)
    await math.getByLabel('数学 Y 坐标', { exact: true }).fill(y)
    await math.getByRole('button', { name: '添加数学点', exact: true }).click()
  }
  await math.getByRole('button', { name: '作垂线', exact: true }).click()
  await math.getByLabel('垂线过点', { exact: true }).selectOption({ label: 'P (1, 3)' })
  await math.getByLabel('垂线直线起点').selectOption({ label: 'A (0, 0)' })
  await math.getByLabel('垂线直线终点').selectOption({ label: 'B (4, 0)' })
  await math.getByRole('button', { name: '构造垂线', exact: true }).click()
  await expect(math.getByTestId('math-right-angle')).toHaveCount(1)
  await expect.poll(async () => (await savedGeometry()).rightAngles?.length).toBe(1)
  const perpendicular = await savedGeometry()
  const relation = perpendicular.rightAngles[0]
  const foot = perpendicular.drawing.points.find((point) => point.id === relation.vertex)
  const along = perpendicular.drawing.points.find((point) => point.id === relation.from)
  const through = perpendicular.drawing.points.find((point) => point.id === relation.to)
  assert.deepEqual({ x: foot.x, y: foot.y }, { x: 1, y: 0 })
  assert.deepEqual({ x: through.x, y: through.y }, { x: 1, y: 3 })
  assert.ok(Math.hypot(along.x - foot.x, along.y - foot.y) > 0)
  assert.equal(
    (along.x - foot.x) * (through.x - foot.x) + (along.y - foot.y) * (through.y - foot.y),
    0,
  )
  assert.ok(
    perpendicular.drawing.lines.some(
      (line) =>
        (line.from === foot.id && line.to === through.id) ||
        (line.to === foot.id && line.from === through.id),
    ),
  )
  // Independent x/y/z edits, a real spatial segment and a non-horizontal triangular face.
  let geometry = math.getByRole('region', { name: '三维坐标工作台', exact: true })
  await expect(geometry.locator('.geometry-axes text')).toHaveText(['x', 'y', 'z'])
  for (const [index, [label, x, y, z]] of [
    ['A', '0', '0', '0'],
    ['B', '3', '0', '0'],
    ['C', '0', '2', '4'],
  ].entries()) {
    if (index) await geometry.getByRole('button', { name: '新建三维点', exact: true }).click()
    await geometry.getByLabel('三维点标记').fill(label)
    await geometry.getByLabel('三维 X 坐标').fill(x)
    await geometry.getByLabel('三维 Y 坐标').fill(y)
    await geometry.getByLabel('三维 Z 坐标').fill(z)
    await geometry.getByRole('button', { name: '添加三维点', exact: true }).click()
  }
  await geometry.getByLabel('三维起点').selectOption({ label: 'A' })
  await geometry.getByLabel('三维终点').selectOption({ label: 'B' })
  await geometry.getByLabel('三维第三点（构面）').selectOption({ label: 'C' })
  await geometry.getByRole('checkbox', { name: '虚线线段' }).check()
  await geometry.getByRole('button', { name: '添加三维线段', exact: true }).click()
  await geometry.getByRole('button', { name: '添加三角面', exact: true }).click()
  await expect(geometry.getByTestId('geometry-point')).toHaveCount(3)
  await expect(geometry.getByTestId('geometry-segment')).toHaveAttribute('stroke-dasharray', '6 5')
  await expect(geometry.getByTestId('geometry-face')).toHaveCount(1)
  await expect.poll(async () => (await savedGeometry()).geometry?.faces?.length).toBe(1)
  const beforeCamera = (await savedGeometry()).geometry
  const projectedY = await geometry.getByTestId('geometry-point').nth(2).getAttribute('cy')
  assert.ok(projectedY !== null)
  await geometry.getByRole('button', { name: '正视 xz', exact: true }).click()
  await expect(geometry.getByTestId('geometry-point').nth(2)).not.toHaveAttribute('cy', projectedY)
  assert.deepEqual((await savedGeometry()).geometry, beforeCamera)
  await geometry.getByLabel('三维 Z 坐标').fill('6')
  await geometry.getByRole('button', { name: '更新三维点', exact: true }).click()
  await expect
    .poll(
      async () => (await savedGeometry()).geometry?.points.find((point) => point.label === 'C')?.z,
    )
    .toBe(6)
  const persistedGeometry = await savedGeometry()
  assert.deepEqual(
    persistedGeometry.geometry.points.map(({ label, x, y, z }) => ({ label, x, y, z })),
    [
      { label: 'A', x: 0, y: 0, z: 0 },
      { label: 'B', x: 3, y: 0, z: 0 },
      { label: 'C', x: 0, y: 2, z: 6 },
    ],
  )
  // Exercise the packaged Agent context controls without starting any model run.
  const contextTitle = await page.locator('.question-prompt h2').innerText()
  const contextId = await page.locator('.question-id').innerText()
  const contextDraft = 'Packaged Agent context: preserve this independent math draft.'
  await page.locator('#answer-text').fill(contextDraft)
  await expect
    .poll(async () =>
      page.evaluate(
        async () => (await window.examcraft.loadState()).drafts['math-solution-1']?.text,
      ),
    )
    .toBe(contextDraft)
  const questionSearch = page.getByRole('textbox', { name: '搜索题目', exact: true })
  await questionSearch.fill(contextTitle)
  const navigation = page.getByRole('navigation', { name: '工作区导航' })
  const agentNavigation = navigation.getByRole('button', {
    name: 'Agent 工作台 Bounded tools',
    exact: true,
  })
  const mathNavigation = navigation.getByRole('button', {
    name: '数学工作台 Math lab',
    exact: true,
  })
  await agentNavigation.click()
  const agentSubject = page.getByRole('combobox', { name: '学科', exact: true })
  const answerSnapshot = page.getByRole('checkbox', { name: /附带当前答卷快照/ })
  await expect(agentSubject).toHaveValue('math')
  await expect(page.locator('.agent-scope-summary')).toContainText(contextTitle)
  await expect(answerSnapshot).toBeEnabled()
  await expect(answerSnapshot).not.toBeChecked()
  const recordsBeforeSkills = await page.evaluate(() => window.examcraft.loadState())
  for (const title of [
    '解析几何分步引导',
    '错题原因自查',
    '针对性变式练习',
    '知识点主动复习',
    '教材证据检索',
  ])
    await expect(page.getByRole('button', { name: title, exact: true })).toBeVisible()
  await page.getByRole('button', { name: '解析几何分步引导', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '本次任务', exact: true })).toHaveValue(
    /垂足与距离/u,
  )
  await expect(
    page.getByRole('button', { name: '开始本次 Agent 任务', exact: true }),
  ).toBeDisabled()
  await expect(answerSnapshot).not.toBeChecked()
  assert.deepEqual(await page.evaluate(() => window.examcraft.loadState()), recordsBeforeSkills)
  assert.equal(await app.evaluate(() => globalThis.packagedProviderRequests), 0)
  await agentSubject.selectOption('geography')
  await expect(answerSnapshot).toBeDisabled()
  await expect(answerSnapshot).not.toBeChecked()
  await expect(page.locator('.agent-scope-summary')).not.toContainText(contextTitle)
  await expect(page.locator('#agent-answer-unavailable')).toContainText('当前题目属于数学')
  await agentSubject.selectOption('math')
  await expect(answerSnapshot).toBeEnabled()
  await expect(answerSnapshot).not.toBeChecked()
  await page.getByRole('combobox', { name: '工作模式', exact: true }).selectOption('create')
  await answerSnapshot.check()
  await expect(answerSnapshot).toBeChecked()
  await mathNavigation.click()
  await expect(page.locator('.question-id')).toHaveText(contextId)
  await expect(page.locator('#answer-text')).toHaveValue(contextDraft)
  await expect(questionSearch).toHaveValue(contextTitle)
  await agentNavigation.click()
  await expect(answerSnapshot).not.toBeChecked()
  await mathNavigation.click()
  await questionSearch.fill('packaged-no-matching-question-043')
  await expect(page.locator('.question-prompt')).toHaveCount(0)
  await agentNavigation.click()
  await expect(answerSnapshot).toBeDisabled()
  await expect(answerSnapshot).not.toBeChecked()
  await expect(page.locator('#agent-answer-unavailable')).toContainText('当前没有选中的题目')
  await expect(page.locator('.agent-scope-summary')).not.toContainText(contextTitle)
  await mathNavigation.click()
  await expect(questionSearch).toHaveValue('packaged-no-matching-question-043')
  await expect(page.locator('.question-prompt')).toHaveCount(0)
  await page.getByRole('button', { name: '清除筛选', exact: true }).click()
  await page.locator('.question-item').filter({ hasText: '解一元一次方程' }).click()
  await expect(page.locator('#answer-text')).toHaveValue(contextDraft)
  assert.deepEqual(await savedGeometry(), persistedGeometry)
  // Verify the offline catalog shipped in the ZIP, without configuring a model or sending API calls.
  const formula = {
    id: 'math.vector.dot',
    title: '空间向量数量积',
    expression: 'a·b = a₁b₁ + a₂b₂ + a₃b₃；a·b = |a||b| cos θ',
    conditions: [
      '坐标公式允许零向量；含夹角的公式要求两向量均非零。',
      '对于两个非零向量，a·b = 0 当且仅当它们垂直。',
    ],
  }
  await page
    .getByRole('navigation', { name: '工作区导航' })
    .getByRole('button', { name: '公式速查 Formula reference', exact: true })
    .click()
  let formulaReader = page.getByRole('region', { name: '公式速查', exact: true })
  await expect(formulaReader).toBeVisible()
  await formulaReader.getByRole('searchbox', { name: '搜索公式' }).fill(formula.id)
  await expect(
    formulaReader.getByRole('heading', { name: formula.title, exact: true }),
  ).toBeVisible()
  await expect(formulaReader.getByLabel('公式表达式')).toHaveText(formula.expression)
  await expect(
    formulaReader.getByRole('region', { name: '适用条件', exact: true }).getByRole('listitem'),
  ).toHaveText(formula.conditions)
  await formulaReader.getByRole('button', { name: `收藏：${formula.title}`, exact: true }).click()
  await expect(
    formulaReader.getByRole('button', { name: `取消收藏：${formula.title}`, exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
  await expect(formulaReader.getByRole('status').filter({ hasText: '已保存到本机' })).toBeVisible()
  await page
    .getByRole('navigation', { name: '工作区导航' })
    .getByRole('button', { name: '数学工作台 Math lab', exact: true })
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
  assert.equal(await app.evaluate(() => globalThis.packagedProviderRequests), 0)
  await app.close()
  app = undefined
  page = await launch()
  assert.equal((await page.evaluate(() => window.examcraft.loadState())).attempts.length, 1)
  assert.equal((await page.evaluate(() => window.examcraft.listKnowledgeDocuments())).length, 6)
  await page
    .getByRole('navigation', { name: '工作区导航' })
    .getByRole('button', { name: '公式速查 Formula reference', exact: true })
    .click()
  formulaReader = page.getByRole('region', { name: '公式速查', exact: true })
  await formulaReader.getByRole('button', { name: /只看收藏/ }).click()
  await expect(formulaReader.getByRole('button', { name: /只看收藏/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(
    formulaReader.getByRole('navigation', { name: '公式列表' }).getByRole('button'),
  ).toHaveCount(1)
  await expect(
    formulaReader.getByRole('heading', { name: formula.title, exact: true }),
  ).toBeVisible()
  await expect(formulaReader.getByLabel('公式表达式')).toHaveText(formula.expression)
  await expect(
    formulaReader.getByRole('button', { name: `取消收藏：${formula.title}`, exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
  await page
    .getByRole('navigation', { name: '工作区导航' })
    .getByRole('button', { name: '数学工作台 Math lab', exact: true })
    .click()
  await page.locator('.question-item').filter({ hasText: '解一元一次方程' }).click()
  math = page.getByRole('region', { name: '数学交互工作台', exact: true })
  geometry = math.getByRole('region', { name: '三维坐标工作台', exact: true })
  await expect(math.getByTestId('math-right-angle')).toHaveCount(1)
  await expect(geometry.getByTestId('geometry-point')).toHaveCount(3)
  await expect(geometry.getByTestId('geometry-segment')).toHaveAttribute('stroke-dasharray', '6 5')
  await expect(geometry.getByTestId('geometry-face')).toHaveCount(1)
  await expect(geometry.getByLabel('三维点列表')).toContainText('C (0, 2, 6)')
  assert.deepEqual(await savedGeometry(), persistedGeometry)
  await expect(page.locator('#answer-text')).toHaveValue(contextDraft)

  // UI-only diagnostic mocks: replace just this test process's IPC handler before
  // clicking diagnostics. No transport, DNS, TLS, endpoint or credential is used.
  // Production transport classifications are covered separately by unit/CI tests.
  const profilesBeforeDiagnostics = await page.evaluate(() => window.examcraft.getModelProfiles())
  await page
    .getByRole('navigation', { name: '工作区导航' })
    .getByRole('button', { name: '题库与 Agent Connections', exact: true })
    .click()
  const settings = page.getByRole('region', { name: '模型设置', exact: true })
  // Exercise the new packaged UI, preload and independent credential store.
  // Saving a synthetic session key must not diagnose or upload any content.
  const recordsBeforeEmbedding = await page.evaluate(() => window.examcraft.loadState())
  const embedding = page.getByRole('region', { name: 'Embedding 设置与检索', exact: true })
  await expect(
    embedding.getByRole('button', { name: '保存 Embedding 设置', exact: true }),
  ).toBeEnabled()
  const embeddingBefore = await page.evaluate(() => window.examcraft.getEmbeddingConfig())
  assert.equal(embeddingBefore.configured, false)
  const syntheticEmbeddingKey = 'synthetic-packaged-embedding-key-never-real'
  await embedding.getByRole('checkbox', { name: '启用独立 Embedding 服务', exact: true }).check()
  await embedding
    .getByLabel('Embedding API 地址', { exact: true })
    .fill('https://embedding-smoke.invalid/v1')
  await embedding
    .getByLabel('Embedding 模型 ID', { exact: true })
    .fill('synthetic-packaged-embedding')
  await embedding.getByLabel('Embedding API Key', { exact: true }).fill(syntheticEmbeddingKey)
  await expect(
    embedding.getByRole('checkbox', { name: /使用系统加密保存这个新 Embedding Key/ }),
  ).not.toBeChecked()
  await embedding.getByRole('button', { name: '保存 Embedding 设置', exact: true }).click()
  await expect(embedding.getByRole('status')).toContainText('未发出连接测试或上传教材')
  await expect(embedding.getByLabel('Embedding API Key', { exact: true })).toHaveValue('')
  const embeddingConfig = await page.evaluate(() => window.examcraft.getEmbeddingConfig())
  assert.equal(embeddingConfig.baseUrl, 'https://embedding-smoke.invalid/v1')
  assert.equal(embeddingConfig.model, 'synthetic-packaged-embedding')
  assert.equal(embeddingConfig.configured, true)
  assert.equal(embeddingConfig.keyStatus, 'session')
  assert.ok(!JSON.stringify(embeddingConfig).includes(syntheticEmbeddingKey))
  assert.ok(!JSON.stringify(embeddingConfig).includes('encryptedApiKey'))
  assert.ok(
    !(await readFile(join(userData, 'embedding-config.json'), 'utf8')).includes(
      syntheticEmbeddingKey,
    ),
  )
  const browserStorage = await page.evaluate(() =>
    JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
  )
  assert.ok(!browserStorage.includes(syntheticEmbeddingKey))
  const localEmbeddingResult = await page.evaluate(
    (id) =>
      window.examcraft.searchEmbeddingLocal({
        subject: 'math',
        documentId: id,
        startPage: 1,
        endPage: 1,
        query: 'synthetic',
      }),
    cached.find((document) => document.subject === 'math').id,
  )
  assert.equal(localEmbeddingResult.mode, 'keyword')
  assert.ok(localEmbeddingResult.hits.length > 0)
  assert.ok(
    localEmbeddingResult.hits.every((hit) => hit.subject === 'math' && hit.pageNumber === 1),
  )
  assert.deepEqual(
    await page.evaluate(() => window.examcraft.getModelProfiles()),
    profilesBeforeDiagnostics,
  )
  assert.deepEqual(await page.evaluate(() => window.examcraft.loadState()), recordsBeforeEmbedding)
  assert.equal(await app.evaluate(() => globalThis.packagedProviderRequests), 0)
  const diagnostics = settings.getByRole('region', { name: '模型连接诊断', exact: true })
  await settings.getByLabel('接口基础地址', { exact: true }).fill('https://smoke.invalid/v1')
  await settings.getByLabel('模型名称', { exact: true }).fill('synthetic-smoke-model')
  await expect(settings.locator('input[type="password"]')).toHaveValue('')
  for (const scenario of [
    {
      kind: 'list',
      code: 'dns',
      details: { stage: 'dns', networkCode: 'ENOTFOUND' },
      expected: '失败阶段：DNS 解析 · ENOTFOUND',
    },
    {
      kind: 'test',
      code: 'tls',
      details: { stage: 'tls', networkCode: 'CERT_HAS_EXPIRED' },
      expected: '失败阶段：TLS 安全连接 · CERT_HAS_EXPIRED',
    },
    {
      kind: 'list',
      code: 'list_unavailable',
      details: { stage: 'http', httpStatus: 405 },
      expected: '失败阶段：HTTP 响应 · HTTP 405',
    },
  ]) {
    await app.evaluate(({ ipcMain }, scenario) => {
      ipcMain.removeHandler('examcraft:diagnose-model')
      ipcMain.handle('examcraft:diagnose-model', (_event, input) => {
        if (
          input.kind !== scenario.kind ||
          input.baseUrl !== 'https://smoke.invalid/v1' ||
          input.model !== 'synthetic-smoke-model' ||
          input.apiKey !== undefined
        )
          throw new Error('Unexpected synthetic diagnostic input')
        return {
          error: {
            code: scenario.code,
            message: 'SYNTHETIC_PROVIDER_PAYLOAD_NOT_FOR_UI',
            details: { ...scenario.details, address: 'SYNTHETIC_PRIVATE_ADDRESS_NOT_FOR_UI' },
          },
        }
      })
    }, scenario)
    await diagnostics
      .getByRole('button', {
        name: scenario.kind === 'list' ? '获取模型' : '测试 API 连接',
        exact: true,
      })
      .click()
    await expect(diagnostics.locator('.model-diagnostic-details')).toContainText(scenario.expected)
    await expect(
      page.getByText(/SYNTHETIC_PROVIDER_PAYLOAD_NOT_FOR_UI|SYNTHETIC_PRIVATE_ADDRESS_NOT_FOR_UI/),
    ).toHaveCount(0)
  }
  await expect(diagnostics).not.toContainText('ENOTFOUND')
  await expect(diagnostics).not.toContainText('CERT_HAS_EXPIRED')
  assert.deepEqual(
    await page.evaluate(() => window.examcraft.getModelProfiles()),
    profilesBeforeDiagnostics,
  )
  await expect(page.getByRole('alert')).toHaveCount(0)
  assert.deepEqual(errors, [])
  assert.equal(await app.evaluate(() => globalThis.packagedProviderRequests), 0)
  console.log(
    `Packaged smoke passed: ${artifact}.zip; packaged mode, production protocol, feature panels, submit/history, perpendicular construction and editable xyz geometry, Agent question scope and explicit snapshot opt-in, five Skill cards without automatic execution, independent Embedding session credentials and local keyword fallback with no provider requests or learning-record changes, DNS/TLS/HTTP diagnostic display (UI-only IPC mocks), offline formula search/conditions/favorites, six-subject PDF package import/search/canvas, dedupe and restart persistence.`,
  )
} finally {
  await app?.close()
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
}
