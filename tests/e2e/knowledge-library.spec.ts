import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { subjects, subjectLabel } from '../../src/shared/subjects'
import { basename, dirname, join, resolve } from 'node:path'
import { createKnowledgePdf } from '../fixtures/knowledge-pdf'
import type { KnowledgeHit, KnowledgeSearchInput } from '../../src/shared/knowledge'

const TITLE = '合成政治知识演示'
const QUESTION = '知识库隔离测试题'
const PACK_TITLE = '自编六科私有测试包'
const subjectBookTitle = (subject: string) => `自编六科教材 ${subject}`
const subjectQuestionTitle = (subject: string) => `六科资料题 ${subject}`
const PRIVATE_REFERENCE = 'PRIVATE_PDF_QUESTION_REFERENCE_NEVER_LIBRARY_EVIDENCE'
const PRIVATE_RUBRIC = 'PRIVATE_PDF_QUESTION_RUBRIC_NEVER_LIBRARY_EVIDENCE'
const PAGE_ONE =
  'SYNTHETIC PAGE ONE\n实践是认识的来源。\n社区收集居民意见，以实际证据研究公共问题。'
const PAGE_TWO =
  '实践是检验认识的标准。\n第二页讨论试点与反馈。\n<script>window.PDF_SCRIPT_RAN=true\n</script>'
const PAGE_THREE = '公共参与需要清楚区分事实、推论和待核验的主张。'
let app: ElectronApplication | undefined
let directory: string
let sourcePath: string
let pageErrors: string[]

async function launch() {
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  delete env.ELECTRON_RUN_AS_NODE
  delete env.EXAMCRAFT_DEV_URL
  env.EXAMCRAFT_USER_DATA = directory
  env.DEEPSEEK_API_KEY = 'synthetic-pdf-advisor-not-a-credential'
  app = await electron.launch({ args: ['.'], env })
  // Mock only native selection and the provider boundary. Storage, PDF extraction,
  // scoped search, citation resolution, main-process checks and preload are real.
  await app.evaluate(({ dialog }, filePath) => {
    const state = globalThis as typeof globalThis & {
      pdfPath: string
      pdfPickerMode: 'selected' | 'cancel' | 'pending'
      pdfPickerCalls: number
      releasePdfPicker?: () => void
      pdfAdvisorBodies: { messages: { content: string }[] }[]
      pdfAdvisorMode: 'success' | 'pending'
      pdfAdvisorResponses: number
      releasePdfAdvisor?: () => void
    }
    state.pdfPath = filePath
    state.pdfPickerMode = 'selected'
    state.pdfPickerCalls = 0
    state.pdfAdvisorBodies = []
    state.pdfAdvisorMode = 'success'
    state.pdfAdvisorResponses = 0
    dialog.showOpenDialog = (async () => {
      state.pdfPickerCalls++
      if (state.pdfPickerMode === 'pending')
        await new Promise<void>((resolve) => {
          state.releasePdfPicker = resolve
        })
      return { canceled: state.pdfPickerMode === 'cancel', filePaths: [state.pdfPath] }
    }) as typeof dialog.showOpenDialog
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
              if (String(input) !== 'https://api.deepseek.com/chat/completions')
                throw new Error('Unexpected synthetic provider destination')
              const payload = JSON.parse(body)
              state.pdfAdvisorBodies.push(payload)
              if (state.pdfAdvisorMode === 'pending')
                await new Promise<void>((resolve) => {
                  state.releasePdfAdvisor = resolve
                })
              const data = JSON.parse(payload.messages[1].content)
              const ids = (data.knowledgeExcerpts ?? []).map((item: { chunkId: string }) => ({
                chunkId: item.chunkId,
              }))
              const output = ids.length
                ? {
                    hint: '对照所引原页，说明材料中的实践如何检验认识。',
                    evidenceStatus: 'supported',
                    citations: ids,
                  }
                : { hint: '先区分材料中的事实与自己的推论。' }
              const response = Readable.from([
                Buffer.from(
                  JSON.stringify({
                    choices: [
                      { finish_reason: 'stop', message: { content: JSON.stringify(output) } },
                    ],
                  }),
                ),
              ])
              Object.assign(response, {
                statusCode: 200,
                headers: { 'content-type': 'application/json' },
              })
              callback(response as import('node:http').IncomingMessage)
              state.pdfAdvisorResponses++
            })
            .catch((error) => request.emit('error', error))
          return request
        },
      })
      return request
    }) as typeof https.request
  }, sourcePath)
  const page = await app.firstWindow()
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await expect(page.getByRole('heading', { name: '今天，理解得更深一点。' })).toBeVisible()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1100))
  await page
    .getByRole('navigation', { name: '工作区导航' })
    .getByRole('button', { name: /文科组装 Argument/ })
    .click()
  await page.locator('.question-item').filter({ hasText: QUESTION }).click()
  await openLibrary(page)
  return page
}

const library = (page: Page) => page.getByRole('region', { name: '教材 PDF 知识库', exact: true })
async function openLibrary(page: Page) {
  const panel = library(page)
  if (!(await panel.getByRole('button', { name: '导入本地 PDF', exact: true }).isVisible()))
    await page.locator('.knowledge-summary').click()
  await expect(panel).toBeVisible()
  // Select option text must not become part of the control's stable label.
  const subject = panel.getByRole('combobox', { name: '知识库学科', exact: true })
  await expect(subject).toHaveAccessibleName('知识库学科')
  await expect(subject.locator('option')).toHaveCount(6)
}
async function importPdf(page: Page) {
  await library(page).getByRole('button', { name: '导入本地 PDF', exact: true }).click()
  await expect(library(page).getByLabel('PDF 文档', { exact: true })).toContainText(TITLE)
  await expect(
    library(page).getByRole('combobox', { name: 'PDF 文档', exact: true }),
  ).toHaveAccessibleName('PDF 文档')
  await expect(
    library(page).getByRole('combobox', { name: '检索范围', exact: true }),
  ).toHaveAccessibleName('检索范围')
  const documents = await page.evaluate(() => window.examcraft!.listKnowledgeDocuments())
  expect(documents).toHaveLength(1)
  return documents[0]
}
async function search(page: Page, query: string) {
  await library(page).getByLabel('PDF 关键词', { exact: true }).fill(query)
  await library(page).getByRole('button', { name: '检索本地文本', exact: true }).click()
}
async function advisorPayloads() {
  return app!.evaluate(() =>
    (
      globalThis as typeof globalThis & {
        pdfAdvisorBodies: { messages: { content: string }[] }[]
      }
    ).pdfAdvisorBodies.map((body) => JSON.parse(body.messages[1].content)),
  )
}
async function selectAnswer(page: Page, answer = 'SECRET_BEFORE 自己的分析 SECRET_AFTER') {
  await page.locator('#answer-text').fill(answer)
  await page.locator('#answer-text').evaluate((element) => {
    const input = element as HTMLTextAreaElement
    input.focus()
    const start = input.value.indexOf('自己的分析')
    input.setSelectionRange(start, start + '自己的分析'.length)
    input.dispatchEvent(new Event('select', { bubbles: true }))
  })
  await page.locator('.advisor-selection-action').click()
  return page.getByRole('dialog', { name: 'Ask Advisor · 思路提示', exact: true })
}
async function assertNoPrivateReference(page: Page) {
  const dom = await page.evaluate(() => ({
    visible: document.body.innerText,
    allText: document.body.textContent,
    html: document.documentElement.outerHTML,
  }))
  for (const value of Object.values(dom)) {
    expect(value).not.toContain(PRIVATE_REFERENCE)
    expect(value).not.toContain(PRIVATE_RUBRIC)
  }
  const publicData = await page.evaluate(async () => ({
    questions: await window.examcraft!.listQuestions(),
    documents: await window.examcraft!.listKnowledgeDocuments(),
  }))
  expect(JSON.stringify(publicData)).not.toContain(PRIVATE_REFERENCE)
  expect(JSON.stringify(publicData)).not.toContain(PRIVATE_RUBRIC)
  expect(JSON.stringify(publicData.documents)).not.toContain(directory)
  for (const question of publicData.questions) {
    expect(question).not.toHaveProperty('rubric')
    expect(question).not.toHaveProperty('explanation')
    expect(question).not.toHaveProperty('correctAnswer')
  }
}

test.beforeEach(async () => {
  pageErrors = []
  directory = await mkdtemp(join(tmpdir(), 'examcraft-knowledge-e2e-'))
  sourcePath = join(directory, `${TITLE}.pdf`)
  await writeFile(sourcePath, createKnowledgePdf([PAGE_ONE, PAGE_TWO, PAGE_THREE]))
  await writeFile(
    join(directory, 'question-bank.json'),
    JSON.stringify({
      version: 1,
      questions: [
        ...subjects.map((subject) => ({
          id: `knowledge-subject-${subject}`,
          subject,
          kind: subject,
          title: subjectQuestionTitle(subject),
          prompt: `请用${subjectLabel[subject]}资料解释共同检索词的含义。`,
          source: 'Self-authored synthetic test only',
          tags: ['六科隔离测试'],
          maxScore: 4,
          explanation: PRIVATE_REFERENCE,
          rubric: [
            { id: `rubric-${subject}`, label: PRIVATE_RUBRIC, keywords: ['共同检索词'], points: 4 },
          ],
        })),
        {
          id: 'knowledge-private-question',
          subject: 'politics',
          kind: 'politics',
          title: QUESTION,
          prompt: '社区通过实地走访与试点完善改造方案。请依据材料说明实践的作用。',
          source: 'Self-authored synthetic test only',
          tags: ['合成测试'],
          maxScore: 4,
          explanation: PRIVATE_REFERENCE,
          rubric: [{ id: 'private-rubric', label: PRIVATE_RUBRIC, keywords: ['实践'], points: 4 }],
        },
      ],
    }),
  )
})
test.afterEach(async () => {
  await app?.close()
  app = undefined
  if (
    dirname(resolve(directory)) !== resolve(tmpdir()) ||
    !basename(directory).startsWith('examcraft-knowledge-e2e-')
  )
    throw new Error('Unexpected PDF test cleanup path')
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  expect(pageErrors).toEqual([])
})

test('real PDF import, scoped physical-page search, raster navigation and persisted restart', async () => {
  let page = await launch()
  expect(await page.evaluate(() => window.examcraft!.listKnowledgeDocuments())).toEqual([])
  const document = await importPdf(page)
  expect(document).toMatchObject({ title: TITLE, pageCount: 3, textPageCount: 3 })
  expect(document.id).toMatch(/^[a-f0-9]{64}$/)
  const canvas = library(page).getByRole('img', { name: `${TITLE}，PDF 物理第 1 页`, exact: true })
  await expect(canvas).toBeVisible()
  await expect
    .poll(() =>
      canvas.evaluate((element) => {
        const target = element as HTMLCanvasElement
        if (!target.width || !target.height) return false
        const values = target.getContext('2d')!.getImageData(0, 0, target.width, target.height).data
        for (let index = 0; index < values.length; index += 4)
          if (values[index + 3] > 0 && values[index] < 200) return true
        return false
      }),
    )
    .toBe(true)
  await search(page, '实践')
  await expect(
    library(page).getByRole('button', { name: '查看第 1 页', exact: true }),
  ).toBeVisible()
  await expect(
    library(page).getByRole('button', { name: '查看第 2 页', exact: true }),
  ).toBeVisible()
  await library(page).getByLabel('检索范围', { exact: true }).selectOption('custom')
  await library(page).getByLabel('起始物理页', { exact: true }).fill('2')
  await library(page).getByLabel('结束物理页', { exact: true }).fill('2')
  await search(page, '实践')
  await expect(library(page).getByRole('button', { name: '查看第 1 页', exact: true })).toHaveCount(
    0,
  )
  await library(page).getByRole('button', { name: '查看第 2 页', exact: true }).click()
  await expect(
    library(page).getByRole('img', { name: `${TITLE}，PDF 物理第 2 页`, exact: true }),
  ).toBeVisible()
  await expect(library(page).getByLabel('PDF 物理页', { exact: true })).toHaveValue('2')
  // Text resembling HTML remains text; no script/link/annotation viewer is mounted.
  expect(
    await page.evaluate(
      () => (window as typeof window & { PDF_SCRIPT_RAN?: boolean }).PDF_SCRIPT_RAN,
    ),
  ).toBeUndefined()
  await expect(
    library(page).locator('iframe, object, embed, .annotationLayer, a[href^="javascript:"]'),
  ).toHaveCount(0)
  await assertNoPrivateReference(page)
  expect(await advisorPayloads()).toEqual([])
  await library(page).getByLabel('章节标签（可选）', { exact: true }).fill('第二物理页')
  await library(page).getByRole('button', { name: '保存章节范围', exact: true }).click()
  await expect(library(page)).toContainText('章节标签与物理页范围已保存在本机。')
  const saved = (await page.evaluate(() => window.examcraft!.listKnowledgeDocuments()))[0]
  expect(saved.id).toBe(document.id)
  expect(saved.scopes).toEqual([
    { id: expect.any(String), label: '第二物理页', startPage: 2, endPage: 2 },
  ])
  await app!.close()
  app = undefined
  page = await launch()
  const restored = await page.evaluate(() => window.examcraft!.listKnowledgeDocuments())
  expect(restored).toHaveLength(1)
  expect(restored[0].scopes).toEqual([
    { id: saved.scopes[0].id, label: '第二物理页', startPage: 2, endPage: 2 },
  ])
  await library(page).getByLabel('检索范围', { exact: true }).selectOption(saved.scopes[0].id)
  await search(page, '实践')
  await expect(
    library(page).getByRole('button', { name: '查看第 2 页', exact: true }),
  ).toBeVisible()
  await expect(library(page).getByRole('button', { name: '查看第 1 页', exact: true })).toHaveCount(
    0,
  )
  await assertNoPrivateReference(page)
})

test('Advisor sends only explicitly opted-in chosen excerpts and opens verified citations at physical pages', async () => {
  const page = await launch()
  await importPdf(page)
  await search(page, '反馈')
  const chosen = library(page).getByRole('checkbox', {
    name: `选作 Advisor 证据：${TITLE}，第 2 页`,
    exact: true,
  })
  await chosen.check()
  const panel = await selectAnswer(page)
  const include = panel.getByRole('checkbox', { name: /^本次附上知识库中已选的/ })
  const consent = panel.getByRole('checkbox', { name: /我同意将以上/ })
  const send = panel.getByRole('button', { name: '确认并获取提示', exact: true })
  await expect(include).not.toBeChecked()
  await expect(send).toBeDisabled()
  await consent.check()
  await send.click()
  await expect(panel.getByText('先区分材料中的事实与自己的推论。', { exact: true })).toBeVisible()
  let payloads = await advisorPayloads()
  expect(payloads).toHaveLength(1)
  expect(payloads[0]).not.toHaveProperty('knowledgeExcerpts')
  await consent.check()
  await include.check()
  await expect(consent).not.toBeChecked()
  await expect(panel.getByLabel('教材摘录 1 原文', { exact: true })).toHaveValue(PAGE_TWO)
  await expect(panel).toContainText('https://api.deepseek.com')
  await consent.check()
  await send.click()
  await expect(
    panel.getByText('对照所引原页，说明材料中的实践如何检验认识。', { exact: true }),
  ).toBeVisible()
  payloads = await advisorPayloads()
  expect(payloads).toHaveLength(2)
  expect(payloads[1].knowledgeExcerpts).toEqual([
    {
      chunkId: expect.stringMatching(/^[a-f0-9]{64}:p2:c1$/),
      documentTitle: TITLE,
      subject: 'politics',
      pageNumber: 2,
      text: PAGE_TWO,
    },
  ])
  const serialized = JSON.stringify(payloads)
  for (const privateValue of [
    PRIVATE_REFERENCE,
    PRIVATE_RUBRIC,
    PAGE_ONE,
    PAGE_THREE,
    'SECRET_BEFORE',
    'SECRET_AFTER',
    directory,
  ])
    expect(serialized).not.toContain(privateValue)
  await expect(page.locator('#answer-text')).toHaveValue('SECRET_BEFORE 自己的分析 SECRET_AFTER')
  await expect(library(page).getByLabel('PDF 物理页', { exact: true })).toHaveValue('1')
  await panel
    .getByRole('button', { name: `${TITLE} · PDF 第 2 页 · 打开原页`, exact: true })
    .click()
  await expect(library(page).getByLabel('PDF 物理页', { exact: true })).toHaveValue('2')
  await assertNoPrivateReference(page)
})

test('canceling or leaving a pending native picker prevents late imports and allows clean retry', async () => {
  const page = await launch()
  await app!.evaluate(() => {
    ;(globalThis as typeof globalThis & { pdfPickerMode: string }).pdfPickerMode = 'pending'
  })
  await library(page).getByRole('button', { name: '导入本地 PDF', exact: true }).click()
  await expect(library(page).getByRole('button', { name: '取消导入', exact: true })).toBeVisible()
  await library(page).getByRole('button', { name: '取消导入', exact: true }).click()
  await app!.evaluate(() => {
    ;(globalThis as typeof globalThis & { releasePdfPicker?: () => void }).releasePdfPicker?.()
  })
  await expect
    .poll(() => page.evaluate(() => window.examcraft!.listKnowledgeDocuments()))
    .toEqual([])
  await library(page).getByRole('button', { name: '导入本地 PDF', exact: true }).click()
  await expect(library(page).getByRole('button', { name: '取消导入', exact: true })).toBeVisible()
  await page
    .getByRole('navigation', { name: '工作区导航' })
    .getByRole('button', { name: /题目练习 Practice/ })
    .click()
  await app!.evaluate(() => {
    ;(globalThis as typeof globalThis & { releasePdfPicker?: () => void }).releasePdfPicker?.()
  })
  await expect
    .poll(() => page.evaluate(() => window.examcraft!.listKnowledgeDocuments()))
    .toEqual([])
  await page
    .getByRole('navigation', { name: '工作区导航' })
    .getByRole('button', { name: /文科组装 Argument/ })
    .click()
  await openLibrary(page)
  await app!.evaluate(() => {
    ;(globalThis as typeof globalThis & { pdfPickerMode: string }).pdfPickerMode = 'selected'
  })
  await importPdf(page)
  await assertNoPrivateReference(page)
})

test('duplicate imports are idempotent; blank/corrupt PDFs and invalid renderer paths are safe', async () => {
  const page = await launch()
  const document = await importPdf(page)
  await importPdf(page)
  expect(await page.evaluate(() => window.examcraft!.listKnowledgeDocuments())).toHaveLength(1)
  const blankPath = join(directory, '合成扫描空白页.pdf')
  await writeFile(blankPath, createKnowledgePdf(['']))
  await app!.evaluate((_electron, path) => {
    ;(globalThis as typeof globalThis & { pdfPath: string }).pdfPath = path
  }, blankPath)
  await library(page).getByRole('button', { name: '导入本地 PDF', exact: true }).click()
  await expect
    .poll(
      async () => (await page.evaluate(() => window.examcraft!.listKnowledgeDocuments())).length,
    )
    .toBe(2)
  await expect(library(page)).toContainText(/无可检索文本|未提取到|OCR/)
  const corruptPath = join(directory, 'corrupt.pdf')
  await writeFile(corruptPath, '%PDF-1.7\nnot a real pdf')
  await app!.evaluate((_electron, path) => {
    ;(globalThis as typeof globalThis & { pdfPath: string }).pdfPath = path
  }, corruptPath)
  await library(page).getByRole('button', { name: '导入本地 PDF', exact: true }).click()
  await expect(library(page).getByRole('alert')).toBeVisible()
  expect(await page.evaluate(() => window.examcraft!.listKnowledgeDocuments())).toHaveLength(2)
  const failures = await page.evaluate(async (id) => {
    const operations = [
      () => window.examcraft!.getKnowledgePdf('../question-bank.json'),
      () => window.examcraft!.getKnowledgePdf('file:///etc/passwd'),
      () => window.examcraft!.getKnowledgePdf('https://example.test/private.pdf'),
      () =>
        window.examcraft!.searchKnowledge({
          documentId: id,
          query: '实践',
          startPage: 0,
          endPage: 1,
        }),
      () =>
        window.examcraft!.searchKnowledge({
          documentId: id,
          query: '实践',
          startPage: 1,
          endPage: 4,
        }),
    ]
    return Promise.all(
      operations.map(async (operation) => {
        try {
          await operation()
          return false
        } catch {
          return true
        }
      }),
    )
  }, document.id)
  expect(failures).toEqual([true, true, true, true, true])
  await assertNoPrivateReference(page)
})

test('a delayed search cannot repopulate results after query or physical scope changes', async () => {
  const page = await launch()
  const document = await importPdf(page)
  await app!.evaluate(({ ipcMain }, doc) => {
    const state = globalThis as typeof globalThis & {
      releasePdfSearch?: () => void
      pdfSearchCalls: number
      pdfSearchReplies: number
    }
    state.pdfSearchCalls = 0
    state.pdfSearchReplies = 0
    ipcMain.removeHandler('examcraft:search-knowledge')
    ipcMain.handle('examcraft:search-knowledge', async (_event, input: KnowledgeSearchInput) => {
      state.pdfSearchCalls++
      await new Promise<void>((resolve) => {
        state.releasePdfSearch = resolve
      })
      state.pdfSearchReplies++
      return [
        {
          chunkId: `${doc.id}:p1:c1`,
          documentId: doc.id,
          documentTitle: doc.title,
          subject: doc.subject,
          pageNumber: 1,
          text: 'STALE_SEARCH_RESULT_MUST_DISAPPEAR',
          score: 1,
        },
      ] satisfies KnowledgeHit[]
    })
  }, document)
  await search(page, '实践')
  await expect
    .poll(() =>
      app!.evaluate(
        () => (globalThis as typeof globalThis & { pdfSearchCalls: number }).pdfSearchCalls,
      ),
    )
    .toBe(1)
  await library(page).getByLabel('PDF 关键词', { exact: true }).fill('新的检索词')
  await app!.evaluate(() => {
    ;(globalThis as typeof globalThis & { releasePdfSearch?: () => void }).releasePdfSearch?.()
  })
  await expect
    .poll(() =>
      app!.evaluate(
        () => (globalThis as typeof globalThis & { pdfSearchReplies: number }).pdfSearchReplies,
      ),
    )
    .toBe(1)
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  await expect(
    library(page).getByText('STALE_SEARCH_RESULT_MUST_DISAPPEAR', { exact: true }),
  ).toHaveCount(0)
  expect(await library(page).evaluate((element) => element.textContent)).not.toContain(
    'STALE_SEARCH_RESULT_MUST_DISAPPEAR',
  )
  await assertNoPrivateReference(page)
})

test('changing optional PDF scope aborts a pending Advisor reply and suppresses its late citation', async () => {
  const page = await launch()
  await importPdf(page)
  await search(page, '反馈')
  await library(page)
    .getByRole('checkbox', { name: `选作 Advisor 证据：${TITLE}，第 2 页`, exact: true })
    .check()
  const panel = await selectAnswer(page)
  const include = panel.getByRole('checkbox', { name: /^本次附上知识库中已选的/ })
  const consent = panel.getByRole('checkbox', { name: /我同意将以上/ })
  await include.check()
  await consent.check()
  await app!.evaluate(() => {
    ;(globalThis as typeof globalThis & { pdfAdvisorMode: string }).pdfAdvisorMode = 'pending'
  })
  await panel.getByRole('button', { name: '确认并获取提示', exact: true }).click()
  await expect.poll(async () => (await advisorPayloads()).length).toBe(1)
  await include.uncheck()
  await expect(consent).not.toBeChecked()
  await expect(panel.getByRole('button', { name: '确认并获取提示', exact: true })).toBeDisabled()
  await app!.evaluate(() => {
    ;(globalThis as typeof globalThis & { releasePdfAdvisor?: () => void }).releasePdfAdvisor?.()
  })
  await expect
    .poll(() =>
      app!.evaluate(
        () =>
          (globalThis as typeof globalThis & { pdfAdvisorResponses: number }).pdfAdvisorResponses,
      ),
    )
    .toBe(1)
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  await expect(panel.locator('.advisor-hint')).toHaveCount(0)
  await expect(panel.getByRole('button', { name: /打开原页/ })).toHaveCount(0)
  await expect(page.locator('#answer-text')).toHaveValue('SECRET_BEFORE 自己的分析 SECRET_AFTER')
  expect(await advisorPayloads()).toHaveLength(1)
  await assertNoPrivateReference(page)
  // Cancellation hides the UI before its durable learning-history write settles.
  // Verify the actual canceled records before teardown asks Electron to drain writes.
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const graph = await window.examcraft!.getLearningGraph()
        return graph.events.filter((event) => event.type === 'help-canceled').length
      }),
    )
    .toBe(1)

})

test('a late chapter save cannot replace a newer physical search scope', async () => {
  const page = await launch()
  const document = await importPdf(page)
  await app!.evaluate(({ ipcMain }, doc) => {
    const state = globalThis as typeof globalThis & {
      releaseScopeSave?: () => void
      scopeSaveCalls: number
      scopeSaveReplies: number
    }
    state.scopeSaveCalls = 0
    state.scopeSaveReplies = 0
    ipcMain.removeHandler('examcraft:save-knowledge-scopes')
    ipcMain.handle(
      'examcraft:save-knowledge-scopes',
      async (_event, input: { scopes: typeof doc.scopes }) => {
        state.scopeSaveCalls++
        await new Promise<void>((resolve) => {
          state.releaseScopeSave = resolve
        })
        state.scopeSaveReplies++
        return { ...doc, scopes: input.scopes }
      },
    )
  }, document)
  const scope = library(page).getByLabel('检索范围', { exact: true })
  await scope.selectOption('custom')
  await library(page).getByLabel('起始物理页', { exact: true }).fill('2')
  await library(page).getByLabel('结束物理页', { exact: true }).fill('2')
  await library(page).getByLabel('章节标签（可选）', { exact: true }).fill('旧范围')
  await library(page).getByRole('button', { name: '保存章节范围', exact: true }).click()
  await expect
    .poll(() =>
      app!.evaluate(
        () => (globalThis as typeof globalThis & { scopeSaveCalls: number }).scopeSaveCalls,
      ),
    )
    .toBe(1)
  await scope.selectOption('all')
  await app!.evaluate(() => {
    ;(globalThis as typeof globalThis & { releaseScopeSave?: () => void }).releaseScopeSave?.()
  })
  await expect
    .poll(() =>
      app!.evaluate(
        () => (globalThis as typeof globalThis & { scopeSaveReplies: number }).scopeSaveReplies,
      ),
    )
    .toBe(1)
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  await expect(scope).toHaveValue('all')
  await assertNoPrivateReference(page)
})

async function createSubjectPack() {
  const path = join(directory, 'synthetic-private-pack')
  await mkdir(path)
  const documents = await Promise.all(
    subjects.map(async (subject) => {
      const bytes = createKnowledgePdf([
        `SYNTHETIC_${subject.toUpperCase()} ORIGINAL_PAGE_ONE\n共同检索词：${subject} 学科独有证据。`,
        `SYNTHETIC_${subject.toUpperCase()} ORIGINAL_PAGE_TWO\n第二物理页不应默认发送。`,
      ])
      const file = `${subject}.pdf`
      await writeFile(join(path, file), bytes)
      return {
        file,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        subject,
        title: subjectBookTitle(subject),
        edition: `测试推定版本 ${subject}`,
        editionConfirmed: false,
      }
    }),
  )
  await writeFile(
    join(path, 'pack.json'),
    JSON.stringify({ version: 1, title: PACK_TITLE, documents }),
  )
  return join(path, 'pack.json')
}
async function importSubjectPack(page: Page, path: string) {
  await app!.evaluate((_electron, path) => {
    ;(globalThis as typeof globalThis & { pdfPath: string }).pdfPath = path
  }, path)
  await library(page).getByRole('button', { name: '导入教材资料包', exact: true }).click()
  // Six bounded extraction workers run sequentially; the default 5 s locator
  // budget is shorter than a cold Windows batch, not an import deadline.
  await expect(library(page)).toContainText('新增 6 份，复用 0 份，失败 0 份', {
    timeout: 30_000,
  })
  return page.evaluate(() => window.examcraft!.listKnowledgeDocuments())
}

test('a private pack provides six separate reader subjects and same-subject Advisor evidence', async () => {
  test.setTimeout(120000)
  const path = await createSubjectPack()
  const page = await launch()
  const imported = await importSubjectPack(page, path)
  expect(imported.map((item) => item.subject).sort()).toEqual([...subjects].sort())
  expect(imported.every((item) => !item.editionConfirmed)).toBe(true)
  const subjectSelect = library(page).getByLabel('知识库学科', { exact: true })
  await expect(subjectSelect.locator('option')).toHaveCount(6)
  for (const subject of subjects) {
    await subjectSelect.selectOption(subject)
    await expect(
      library(page).getByLabel('PDF 文档', { exact: true }).locator('option'),
    ).toHaveCount(1)
    await expect(library(page).getByLabel('PDF 文档', { exact: true })).toContainText(
      subjectBookTitle(subject),
    )
    await expect(library(page)).toContainText('推定，待核对')
    await expect(
      library(page).getByRole('img', {
        name: `${subjectBookTitle(subject)}，PDF 物理第 1 页`,
        exact: true,
      }),
    ).toBeVisible()
    await search(page, '共同检索词')
    const evidence = library(page).getByRole('checkbox', { name: /^选作 Advisor 证据：/ })
    await expect(evidence).toHaveCount(1)
    await expect(library(page).getByRole('list', { name: 'PDF 检索结果' })).toContainText(
      `${subject} 学科独有证据`,
    )
    if (subject === 'politics') await expect(evidence).toBeEnabled()
    else await expect(evidence).toBeDisabled()
    if (subject === 'math') await expect(library(page)).toContainText('文本检索不验证公式或推导')
    await library(page).getByLabel('检索范围', { exact: true }).selectOption('custom')
    await expect(
      library(page).getByRole('button', { name: '使用必修四 1–5 课标签', exact: true }),
    ).toHaveCount(subject === 'politics' ? 1 : 0)
  }
  expect(await advisorPayloads()).toEqual([])

  await page
    .getByRole('navigation', { name: '工作区导航' })
    .getByRole('button', { name: /题目练习 Practice/ })
    .click()
  for (const subject of subjects) {
    await page
      .locator('.question-item')
      .filter({ hasText: subjectQuestionTitle(subject) })
      .click()
    await openLibrary(page)
    await expect(library(page).getByLabel('知识库学科', { exact: true })).toHaveValue(subject)
    await search(page, '共同检索词')
    await library(page)
      .getByRole('checkbox', { name: /^选作 Advisor 证据：/ })
      .check()
    const panel = await selectAnswer(page)
    await panel.getByRole('checkbox', { name: /^本次附上知识库中已选的/ }).check()
    await panel.getByRole('checkbox', { name: /我同意将以上/ }).check()
    await panel.getByRole('button', { name: '确认并获取提示', exact: true }).click()
    await expect(panel.locator('.advisor-hint')).toBeVisible()
    const payloads = await advisorPayloads()
    const evidence = payloads.at(-1).knowledgeExcerpts
    expect(evidence).toHaveLength(1)
    expect(evidence[0]).toMatchObject({
      subject,
      documentTitle: subjectBookTitle(subject),
      pageNumber: 1,
    })
    expect(evidence[0].text).toContain(`${subject} 学科独有证据`)
    expect(JSON.stringify(payloads.at(-1))).not.toContain(PRIVATE_REFERENCE)
    expect(JSON.stringify(payloads.at(-1))).not.toContain('第二物理页不应默认发送')
    await expect(page.locator('#answer-text')).toHaveValue('SECRET_BEFORE 自己的分析 SECRET_AFTER')
    await panel.getByRole('button', { name: '关闭 Advisor', exact: true }).click()
  }
  expect(await advisorPayloads()).toHaveLength(6)
  await assertNoPrivateReference(page)
})

test('editing book metadata preserves the PDF and resets evidence; changing browse subject resets consent', async () => {
  const page = await launch()
  const original = await importPdf(page)
  await search(page, '反馈')
  await library(page)
    .getByRole('checkbox', { name: /^选作 Advisor 证据：/ })
    .check()
  const panel = await selectAnswer(page)
  await panel.getByRole('checkbox', { name: /^本次附上知识库中已选的/ }).check()
  const consent = panel.getByRole('checkbox', { name: /我同意将以上/ })
  await consent.check()
  await library(page).getByLabel('知识库学科', { exact: true }).selectOption('math')
  await expect(consent).not.toBeChecked()
  await expect(panel.getByRole('checkbox', { name: /^本次附上知识库中已选的/ })).toBeDisabled()
  await expect(library(page)).toContainText('此学科尚无本地资料')
  await library(page).getByLabel('知识库学科', { exact: true }).selectOption('politics')
  await panel.getByRole('button', { name: '关闭 Advisor', exact: true }).click()
  await library(page).locator('.knowledge-metadata-editor > summary').click()
  await expect(
    library(page).getByRole('combobox', { name: '教材学科', exact: true }),
  ).toHaveAccessibleName('教材学科')
  await library(page).getByLabel('教材名称', { exact: true }).fill('已核对名称')
  await library(page).getByLabel('教材版本 / 册次', { exact: true }).fill('自编教材 · 2026 测试版')
  await library(page)
    .getByRole('checkbox', { name: '我已对照 PDF 封面 / 版权页核对上述版本', exact: true })
    .check()
  await library(page).getByRole('button', { name: '保存教材信息', exact: true }).click()
  await expect(library(page)).toContainText('教材名称、学科与版本已保存在本机')
  let saved = (await page.evaluate(() => window.examcraft!.listKnowledgeDocuments()))[0]
  expect(saved).toMatchObject({
    id: original.id,
    title: '已核对名称',
    subject: 'politics',
    edition: '自编教材 · 2026 测试版',
    editionConfirmed: true,
  })
  expect(saved.scopes).toEqual(original.scopes)
  await expect(
    library(page).getByRole('img', { name: '已核对名称，PDF 物理第 1 页', exact: true }),
  ).toBeVisible()
  await library(page).getByLabel('教材学科', { exact: true }).selectOption('math')
  await library(page).getByRole('button', { name: '保存教材信息', exact: true }).click()
  await expect(library(page).getByLabel('知识库学科', { exact: true })).toHaveValue('math')
  saved = (await page.evaluate(() => window.examcraft!.listKnowledgeDocuments()))[0]
  expect(saved.id).toBe(original.id)
  expect(saved.subject).toBe('math')
  await search(page, '反馈')
  await expect(library(page).getByRole('checkbox', { name: /^选作 Advisor 证据：/ })).toBeDisabled()
  expect(await advisorPayloads()).toEqual([])
  await assertNoPrivateReference(page)
})

test('canceling a pending private-pack manifest picker prevents late import and permits retry', async () => {
  const path = await createSubjectPack()
  const page = await launch()
  await app!.evaluate((_electron, path) => {
    const state = globalThis as typeof globalThis & { pdfPath: string; pdfPickerMode: string }
    state.pdfPath = path
    state.pdfPickerMode = 'pending'
  }, path)
  await library(page).getByRole('button', { name: '导入教材资料包', exact: true }).click()
  await expect
    .poll(() =>
      app!.evaluate(() => {
        const state = globalThis as typeof globalThis & {
          pdfPickerCalls: number
          releasePdfPicker?: () => void
        }
        return state.pdfPickerCalls === 1 && typeof state.releasePdfPicker === 'function'
      }),
    )
    .toBe(true)
  await library(page).getByRole('button', { name: '取消导入', exact: true }).click()
  await app!.evaluate(() => {
    const state = globalThis as typeof globalThis & { releasePdfPicker?: () => void }
    if (!state.releasePdfPicker) throw new Error('Expected an open synthetic picker')
    state.releasePdfPicker()
    delete state.releasePdfPicker
  })
  await expect(library(page)).toContainText('资料包导入已取消；已新增 0 份')
  await expect(
    library(page).getByRole('button', { name: '导入教材资料包', exact: true }),
  ).toBeEnabled()
  await expect
    .poll(() => page.evaluate(() => window.examcraft!.listKnowledgeDocuments()))
    .toEqual([])
  await app!.evaluate(() => {
    ;(globalThis as typeof globalThis & { pdfPickerMode: string }).pdfPickerMode = 'selected'
  })
  const imported = await importSubjectPack(page, path)
  expect(imported.map((item) => item.subject).sort()).toEqual([...subjects].sort())
  expect(
    await app!.evaluate(
      () => (globalThis as typeof globalThis & { pdfPickerCalls: number }).pdfPickerCalls,
    ),
  ).toBe(2)
  await assertNoPrivateReference(page)
})

test('canceling a partial pack keeps committed documents visible, blocks repeated clicks, and reports failures', async () => {
  const page = await launch()
  const document = await importPdf(page)
  // Delay only the pack-result boundary to deterministically test intermediate UI states.
  // The existing source PDF and its raster are still real, local persisted content.
  await app!.evaluate(({ ipcMain }, document) => {
    const state = globalThis as typeof globalThis & {
      releasePartialPack?: () => void
      partialPackCalls: number
    }
    state.partialPackCalls = 0
    ipcMain.removeHandler('examcraft:import-knowledge-pack')
    ipcMain.handle('examcraft:import-knowledge-pack', async () => {
      state.partialPackCalls++
      await new Promise<void>((resolve) => {
        state.releasePartialPack = resolve
      })
      return {
        canceled: true,
        validationPassed: true,
        packTitle: '部分导入测试',
        documents: [document],
        importedCount: 0,
        duplicateCount: 1,
        failedCount: 1,
        items: [
          {
            file: 'existing.pdf',
            title: document.title,
            subject: document.subject,
            status: 'duplicate',
            documentId: document.id,
          },
          {
            file: 'failed.pdf',
            title: '失败文档',
            subject: 'math',
            status: 'failed',
            error: '测试文件无法解析，请检查后重试。',
          },
          { file: 'pending.pdf', title: '尚未处理文档', subject: 'english', status: 'pending' },
        ],
      }
    })
  }, document)
  const importButton = library(page).getByRole('button', { name: '导入教材资料包', exact: true })
  await importButton.click()
  await expect(importButton).toBeDisabled()
  await importButton.evaluate((element) => (element as HTMLButtonElement).click())
  await library(page).getByRole('button', { name: '取消导入', exact: true }).click()
  await expect(library(page).getByRole('button', { name: '正在取消…', exact: true })).toBeDisabled()
  await expect(importButton).toBeDisabled()
  expect(
    await app!.evaluate(
      () => (globalThis as typeof globalThis & { partialPackCalls: number }).partialPackCalls,
    ),
  ).toBe(1)
  await app!.evaluate(() => {
    ;(globalThis as typeof globalThis & { releasePartialPack?: () => void }).releasePartialPack?.()
  })
  await expect(importButton).toBeEnabled()
  await expect(library(page)).toContainText('已新增 0 份，复用 1 份，失败 1 份，未处理 1 份')
  const report = library(page).getByRole('list', { name: '教材资料包导入结果', exact: true })
  await expect(report).toContainText('测试文件无法解析，请检查后重试。')
  await expect(report).toContainText('尚未处理文档')
  await expect(library(page).getByLabel('PDF 文档', { exact: true })).toContainText(document.title)
  await expect(
    library(page).getByRole('img', { name: `${document.title}，PDF 物理第 1 页`, exact: true }),
  ).toBeVisible()
  expect(await advisorPayloads()).toEqual([])
})
