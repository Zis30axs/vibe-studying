import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type {
  AnswerDraft,
  ExamCraftApi,
  ModuleReviewRequest,
  ModuleReviewResult,
} from '../../src/shared/types'
import { applyModuleSuggestion } from '../../src/domain/module-review'
import { checkpointAcceptedEdit } from '../../src/domain/argument-revisions'

type ModuleAcceptance = Parameters<ExamCraftApi['acceptModuleSuggestion']>[0]
type ModuleFixtureState = typeof globalThis & {
  moduleRequests: ModuleReviewRequest[]
  moduleReviews: { draft: AnswerDraft; result: ModuleReviewResult }[]
  moduleAccepts: ModuleAcceptance[]
  moduleCancels: string[]
  moduleMode: string
  releaseModule?: () => void
  preparedAcceptance?: { request: ModuleAcceptance; draft: AnswerDraft }
}

// UI contracts use an IPC fake, never a real model, credential, or network request.
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
  env.EXAMCRAFT_USER_DATA = directory
  delete env.DEEPSEEK_API_KEY
  app = await electron.launch({ args: ['.'], env })
  // Startup registers IPC handlers before creating the window. Replacing them
  // earlier can race that registration and leave startup in an error dialog.
  const page = await app.firstWindow()
  // CI can clamp the initial native window into the narrow drawer layout.
  // These flows deliberately exercise the desktop answer/tools layout.
  const nativeWindow = await app.browserWindow(page)
  await nativeWindow.evaluate((browserWindow) => browserWindow.setContentSize(1440, 960))
  await app.evaluate(({ ipcMain }) => {
    const state = globalThis as ModuleFixtureState
    state.moduleRequests = []
    state.moduleReviews = []
    state.moduleAccepts = []
    state.moduleCancels = []
    state.moduleMode = 'success'
    const profile = {
      protocol: 'openai-chat' as const,
      baseUrl: 'https://review.example.com',
      model: 'mock-review',
      configured: true,
      revision: 1,
      profileId: 'mock-review-profile',
      profileName: 'Mock review',
      keyStatus: 'session' as const,
    }
    ipcMain.removeHandler('examcraft:get-model-config')
    ipcMain.handle('examcraft:get-model-config', () => profile)
    ipcMain.removeHandler('examcraft:get-model-profiles')
    ipcMain.handle('examcraft:get-model-profiles', () => ({
      revision: 1,
      profiles: [profile],
      roles: { parent: profile.profileId, child: profile.profileId },
      secureStorageAvailable: false,
    }))
    ipcMain.removeHandler('examcraft:accept-module-suggestion')
    ipcMain.handle('examcraft:accept-module-suggestion', (_event, input: ModuleAcceptance) => {
      const prepared = state.preparedAcceptance
      if (!prepared || JSON.stringify(input) !== JSON.stringify(prepared.request))
        throw new Error('Unexpected or stale mock acceptance')
      state.moduleAccepts.push(input)
      delete state.preparedAcceptance
      return prepared.draft
    })
    ipcMain.removeHandler('examcraft:review-modules')
    ipcMain.handle(
      'examcraft:review-modules',
      async (_event, input: ModuleReviewRequest, draft: AnswerDraft) => {
        state.moduleRequests.push(input)
        const node = input.roots[0]
        const span = input.selectedSpans?.[0]
        const response: ModuleReviewResult = {
          requestId: input.requestId,
          configRevision: input.configRevision,
          summary: '论证方向成立，只需补足一个关键条件。',
          confirmations: [{ moduleId: node.id, text: '保留这条材料与观点之间的联系。' }],
          suggestions: [
            {
              // A model-provided ID must never inherit a decision from Object.prototype.
              id: 'constructor',
              moduleId: node.id,
              priority: 'must-fix',
              reason: '这条结论需要保留适用条件。',
              evidence: '题干中的条件限定了推论范围。',
              edit: {
                operation: 'replace',
                baseText: node.text,
                start: span?.start ?? 0,
                end: span?.end ?? node.text.length,
                expectedText: span?.expectedText ?? node.text,
                replacement: '在材料所给条件下，这一结论成立。',
              },
            },
          ],
        }
        if (state.moduleMode === 'clean') {
          response.suggestions = []
          response.summary = '关键论证完整，可以保留。'
        }
        state.moduleReviews.push({ draft, result: response })
        if (state.moduleMode === 'pending')
          await new Promise<void>((resolve) => {
            state.releaseModule = resolve
          })
        if (state.moduleMode === 'invalid') response.suggestions[0].edit!.baseText = 'wrong source'
        return response
      },
    )
    ipcMain.removeHandler('examcraft:cancel-module-review')
    ipcMain.handle('examcraft:cancel-module-review', (_event, id: string) => {
      state.moduleCancels.push(id)
    })
  })
  await page.reload()
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1440)
  await page
    .getByRole('navigation', { name: '工作区导航' })
    .getByRole('button', { name: /文科组装 Argument/ })
    .click()
  await expect(page.locator('#tools-panel')).toBeVisible()
  await expect(page.getByRole('button', { name: /^(?:◫\s*)?工具与顾问$/ })).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  await expect(page.getByTestId('palette-analysis')).toBeEnabled()
  await page.getByTestId('palette-analysis').click()
  await page.getByTestId('place-center').click()
  const text = page.getByTestId('argument-canvas').locator('[data-block-id] textarea').last()
  await text.fill('材料说明这一结论始终成立。')
  return { page, text }
}
function panel(page: Page) {
  return page.getByRole('dialog', { name: '模块检查 · 保留好思路' })
}
async function requestCount() {
  return app!.evaluate(
    () => (globalThis as typeof globalThis & { moduleRequests: unknown[] }).moduleRequests.length,
  )
}
async function send(page: Page) {
  await panel(page)
    .getByRole('checkbox', { name: /我同意将上述检查内容/ })
    .check()
  await panel(page).getByRole('button', { name: '确认并检查模块' }).click()
}
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'examcraft-module-review-'))
})
test.afterEach(async () => {
  await app?.close()
  app = undefined
  if (
    dirname(resolve(directory)) !== resolve(tmpdir()) ||
    !basename(directory).startsWith('examcraft-module-review-')
  )
    throw new Error('Unexpected cleanup path')
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

test('explicit scope and consent; grounded finding accepts only its module and preserves final draft', async () => {
  const { page, text } = await launch()
  const finalBefore = await page.locator('#answer-text').inputValue()
  await page.getByRole('button', { name: '✦ 检查模块', exact: true }).click()
  await expect(panel(page).getByText('https://review.example.com', { exact: true })).toBeVisible()
  await expect(panel(page).getByRole('button', { name: '确认并检查模块' })).toBeDisabled()
  expect(await requestCount()).toBe(0)
  await send(page)
  await expect(
    panel(page).getByText('保留这条材料与观点之间的联系。', { exact: false }),
  ).toBeVisible()
  await panel(page).getByRole('button', { name: '定位原文' }).click()
  await expect(text).toBeFocused()
  await expect(panel(page).getByRole('button', { name: '接受此修改' })).toBeEnabled()
  // The review boundary is fake. Use the real edit/checkpoint functions to
  // prepare the matching host acceptance result, including its revision tree.
  const reviewed = await app!.evaluate(() => (globalThis as ModuleFixtureState).moduleReviews[0])
  const suggestion = reviewed.result.suggestions[0]
  const edited = applyModuleSuggestion(reviewed.draft.argument!, suggestion)
  const acceptance = {
    request: {
      requestId: reviewed.result.requestId,
      suggestionId: suggestion.id,
      expectedDraft: reviewed.draft,
    },
    draft: {
      ...reviewed.draft,
      argument: checkpointAcceptedEdit(
        reviewed.draft.argument!,
        edited.roots,
        `接受建议：${suggestion.reason.slice(0, 55)}`,
      ),
    },
  }
  await app!.evaluate((_electron, prepared) => {
    ;(globalThis as ModuleFixtureState).preparedAcceptance = prepared
  }, acceptance)
  await panel(page).getByRole('button', { name: '接受此修改' }).click()
  await expect(text).toHaveValue('在材料所给条件下，这一结论成立。')
  await expect(panel(page).getByText('已接受', { exact: true })).toBeVisible()
  expect(await app!.evaluate(() => (globalThis as ModuleFixtureState).moduleAccepts)).toEqual([
    acceptance.request,
  ])
  await expect(page.locator('#answer-text')).toHaveValue(finalBefore)
  await page.locator('.argument-timeline > summary').click()
  const revisions = page.locator('[data-revision-id]')
  await expect(revisions).toHaveCount(2)
  await revisions.first().getByRole('button', { name: '恢复此版本' }).click()
  await page.getByRole('button', { name: '确认恢复模块', exact: true }).click()
  await expect(text).toHaveValue('材料说明这一结论始终成立。')
  await text.fill('从原版本继续发展的另一条论证。')
  await page.getByRole('textbox', { name: '检查点名称' }).fill('另一条分支')
  await page.getByRole('button', { name: '保存检查点', exact: true }).click()
  await expect(revisions).toHaveCount(3)
  await expect(page.locator('#answer-text')).toHaveValue(finalBefore)
})

test('selected span is explicit and changing scope resets consent; rejection preserves source', async ({}, testInfo) => {
  const { page, text } = await launch()
  const before = await text.inputValue()
  await page.getByRole('button', { name: '✦ 检查模块', exact: true }).click()
  const consent = panel(page).getByRole('checkbox', { name: /我同意将上述检查内容/ })
  await consent.check()
  // Focusing this readonly snapshot alone does not establish a Windows keyboard caret.
  // Drag over the rendered text, just as a user selects a review fragment.
  const snapshot = panel(page).getByLabel('模块原文快照')
  await snapshot.evaluate((element) => {
    const events: unknown[] = []
    const state = window as typeof window & { moduleSelectionEvents?: unknown[] }
    state.moduleSelectionEvents = events
    for (const type of [
      'focusin',
      'focusout',
      'mousedown',
      'mouseup',
      'select',
      'selectionchange',
    ]) {
      document.addEventListener(type, (event) => {
        const area = element as HTMLTextAreaElement
        events.push({
          type,
          target:
            event.target instanceof Element ? event.target.outerHTML.slice(0, 240) : 'document',
          focused: document.activeElement === area,
          documentFocused: document.hasFocus(),
          start: area.selectionStart,
          end: area.selectionEnd,
          defaultPrevented: event.defaultPrevented,
        })
      })
    }
  })
  await snapshot.scrollIntoViewIfNeeded()
  const selectionPoints = await snapshot.evaluate(async (element) => {
    await document.fonts.ready
    const area = element as HTMLTextAreaElement
    const style = getComputedStyle(area)
    const box = area.getBoundingClientRect()
    const context = document.createElement('canvas').getContext('2d')!
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
    const spacing = Number.parseFloat(style.letterSpacing) || 0
    const prefixWidth = (end: number) =>
      context.measureText(area.value.slice(0, end)).width + end * spacing
    const left =
      box.left + Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.paddingLeft)
    const y =
      box.top +
      Number.parseFloat(style.borderTopWidth) +
      Number.parseFloat(style.paddingTop) +
      Number.parseFloat(style.lineHeight) / 2
    const contentWidth =
      area.clientWidth -
      Number.parseFloat(style.paddingLeft) -
      Number.parseFloat(style.paddingRight)
    if (prefixWidth(8) >= contentWidth)
      throw new Error('Selection fixture must fit on the first line')
    return { start: { x: left + prefixWidth(4), y }, end: { x: left + prefixWidth(8), y } }
  })
  await page.mouse.move(selectionPoints.start.x, selectionPoints.start.y)
  await page.mouse.down()
  try {
    await page.mouse.move(selectionPoints.end.x, selectionPoints.end.y, { steps: 12 })
  } finally {
    await page.mouse.up()
  }
  await expect(snapshot).toBeFocused()
  await testInfo.attach('module-selection-events', {
    body: JSON.stringify(
      await page.evaluate(
        () =>
          (window as typeof window & { moduleSelectionEvents?: unknown[] }).moduleSelectionEvents,
      ),
      null,
      2,
    ),
    contentType: 'application/json',
  })
  await expect
    .poll(() =>
      snapshot.evaluate((element) => {
        const area = element as HTMLTextAreaElement
        return {
          focused: document.activeElement === area,
          start: area.selectionStart,
          end: area.selectionEnd,
        }
      }),
    )
    .toEqual({ focused: true, start: 4, end: 8 })
  await expect(
    panel(page).getByText(`限定片段：${before.slice(4, 8)}`, { exact: true }),
  ).toBeVisible()
  await expect(consent).not.toBeChecked()
  await send(page)
  await expect.poll(requestCount).toBe(1)
  const requests = await app!.evaluate(
    () =>
      (globalThis as typeof globalThis & { moduleRequests: ModuleReviewRequest[] }).moduleRequests,
  )
  expect(requests[0].selectedSpans?.[0]).toMatchObject({
    start: 4,
    end: 8,
    expectedText: before.slice(4, 8),
  })
  await panel(page).getByRole('button', { name: '拒绝此建议' }).click()
  await expect(text).toHaveValue(before)
  await consent.check()
  await panel(page).getByRole('radio', { name: '全部模块', exact: true }).check()
  await expect(consent).not.toBeChecked()
  await send(page)
  await expect.poll(requestCount).toBe(2)
  const allRequest = await app!.evaluate(() =>
    (globalThis as typeof globalThis & { moduleRequests: ModuleReviewRequest[] }).moduleRequests.at(
      -1,
    ),
  )
  expect(allRequest?.scope).toBe('all')
  expect(allRequest?.selectedSpans).toBeUndefined()
})

test('editing invalidates pending requests and late responses cannot restore an applicable proposal', async () => {
  const { page, text } = await launch()
  await app!.evaluate(() => {
    ;(globalThis as typeof globalThis & { moduleMode: string }).moduleMode = 'pending'
  })
  await page.getByRole('button', { name: '✦ 检查模块', exact: true }).click()
  await send(page)
  await expect.poll(requestCount).toBe(1)
  await text.fill('用户正在重新组织这条分析。')
  await expect
    .poll(() =>
      app!.evaluate(
        () => (globalThis as typeof globalThis & { moduleCancels: string[] }).moduleCancels.length,
      ),
    )
    .toBe(1)
  await app!.evaluate(() => {
    ;(globalThis as typeof globalThis & { releaseModule?: () => void }).releaseModule?.()
  })
  await expect(panel(page).getByRole('button', { name: '接受此修改' })).toHaveCount(0)
  await expect(
    panel(page).getByRole('checkbox', { name: /我同意将上述检查内容/ }),
  ).not.toBeChecked()
  await expect(text).toHaveValue('用户正在重新组织这条分析。')
})

test('invalid edits fail closed and closing aborts requests', async () => {
  const { page, text } = await launch()
  const before = await text.inputValue()
  await app!.evaluate(() => {
    ;(globalThis as typeof globalThis & { moduleMode: string }).moduleMode = 'invalid'
  })
  await page.getByRole('button', { name: '✦ 检查模块', exact: true }).click()
  await send(page)
  await expect(panel(page).getByRole('alert')).toContainText('返回内容无效')
  await expect(panel(page).getByRole('button', { name: '接受此修改' })).toHaveCount(0)
  await expect(text).toHaveValue(before)
  await app!.evaluate(() => {
    ;(globalThis as typeof globalThis & { moduleMode: string }).moduleMode = 'pending'
  })
  await send(page)
  await expect.poll(requestCount).toBe(2)
  await panel(page).getByRole('button', { name: '关闭模块检查' }).click()
  await expect(panel(page)).toHaveCount(0)
  await expect
    .poll(() =>
      app!.evaluate(
        () => (globalThis as typeof globalThis & { moduleCancels: string[] }).moduleCancels.length,
      ),
    )
    .toBe(1)
})

test('a restrained clean review offers no unnecessary edit; external changes disable existing edits', async () => {
  const { page, text } = await launch()
  await app!.evaluate(() => {
    ;(globalThis as typeof globalThis & { moduleMode: string }).moduleMode = 'clean'
  })
  await page.getByRole('button', { name: '✦ 检查模块', exact: true }).click()
  await send(page)
  await expect(panel(page).getByText('没有需要优先修改的问题，可以保留当前表达。')).toBeVisible()
  await expect(panel(page).getByRole('button', { name: '接受此修改' })).toHaveCount(0)
  await app!.evaluate(() => {
    ;(globalThis as typeof globalThis & { moduleMode: string }).moduleMode = 'success'
  })
  await send(page)
  await expect(panel(page).getByRole('button', { name: '接受此修改' })).toBeEnabled()
  await text.fill('新的自主表达。')
  await expect(panel(page).getByRole('button', { name: '接受此修改' })).toBeDisabled()
  await expect(panel(page).getByText(/剩余建议已失效/)).toBeVisible()
})

test('reference permission changes cancel review and stale suggestions cannot write modules', async () => {
  const { page, text } = await launch()
  const original = await text.inputValue()
  const finalBefore = await page.locator('#answer-text').inputValue()
  await app!.evaluate(() => {
    ;(globalThis as typeof globalThis & { moduleMode: string }).moduleMode = 'pending'
  })
  await page.getByRole('button', { name: '✦ 检查模块', exact: true }).click()
  const reference = panel(page).getByRole('checkbox', { name: /允许顾问参考本题解析和评分依据/ })
  const consent = panel(page).getByRole('checkbox', { name: /我同意将上述检查内容/ })
  await expect(reference).not.toBeChecked()
  await send(page)
  await expect.poll(requestCount).toBe(1)
  const first = await app!.evaluate(
    () =>
      (globalThis as typeof globalThis & { moduleRequests: ModuleReviewRequest[] })
        .moduleRequests[0],
  )
  expect(first.includeReference).toBe(false)
  expect(first.questionId).toEqual(expect.any(String))
  expect(first).not.toHaveProperty('question')
  await reference.check()
  await expect(consent).not.toBeChecked()
  await expect
    .poll(() =>
      app!.evaluate(
        () => (globalThis as typeof globalThis & { moduleCancels: string[] }).moduleCancels.length,
      ),
    )
    .toBe(1)
  await app!.evaluate(() => {
    ;(globalThis as typeof globalThis & { releaseModule?: () => void }).releaseModule?.()
    ;(globalThis as typeof globalThis & { moduleMode: string }).moduleMode = 'success'
  })
  await expect(panel(page).getByRole('button', { name: '接受此修改' })).toHaveCount(0)
  await expect(text).toHaveValue(original)
  await send(page)
  await expect(panel(page).getByRole('button', { name: '接受此修改' })).toBeEnabled()
  const latest = await app!.evaluate(() =>
    (globalThis as typeof globalThis & { moduleRequests: ModuleReviewRequest[] }).moduleRequests.at(
      -1,
    ),
  )
  expect(latest?.includeReference).toBe(true)
  await reference.uncheck()
  await expect(panel(page).getByRole('button', { name: '接受此修改' })).toBeDisabled()
  await expect(text).toHaveValue(original)
  await expect(page.locator('#answer-text')).toHaveValue(finalBefore)
})
