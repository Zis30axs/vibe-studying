import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

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
  env.DEEPSEEK_API_KEY = 'synthetic-advisor-marker-not-a-credential'
  env.EXAMCRAFT_DEEPSEEK_MODEL = 'deepseek-flash'
  app = await electron.launch({ args: ['.'], env })
  // The main-process provider boundary is mocked before any user-authorized request.
  await app.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      advisorBodies: unknown[]
      advisorMode: string
      advisorAborts: number
    }
    state.advisorBodies = []
    state.advisorMode = 'success'
    state.advisorAborts = 0
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
    globalThis.fetch = async (_input, init) => {
      state.advisorBodies.push(JSON.parse(String(init?.body)))
      if (state.advisorMode === 'failure') throw new Error('Synthetic offline test')
      if (state.advisorMode === 'pending')
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              state.advisorAborts++
              reject(new DOMException('Aborted', 'AbortError'))
            },
            { once: true },
          )
        })
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({ hint: '先找出材料中的因果关系，再考虑它支持哪个观点。' }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
  })
  const page = await app.firstWindow()
  // This suite exercises the desktop side-by-side Advisor. CI display bounds
  // can clamp the constructor size into drawer mode; size the real window now.
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1440, 960),
  )
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1440)
  await expect(page.getByRole('button', { name: '工具与顾问', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  await expect(page.locator('#answer-text')).toBeVisible()
  return page
}
async function selectAnswer(page: Page, text: string, start: number, end: number) {
  await page.locator('#answer-text').fill(text)
  await page.locator('#answer-text').evaluate(
    (element, selection) => {
      const input = element as HTMLTextAreaElement
      input.focus()
      input.setSelectionRange(selection.start, selection.end)
      input.dispatchEvent(new Event('select', { bubbles: true }))
    },
    { start, end },
  )
  await expect(page.locator('.advisor-selection-action')).toBeVisible()
}
async function bodyData() {
  return app!.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      advisorBodies: { messages: { content: string }[] }[]
    }
    return state.advisorBodies.map((body) => JSON.parse(body.messages[1].content))
  })
}
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'examcraft-advisor-e2e-'))
})
test.afterEach(async () => {
  await app?.close()
  app = undefined
  if (
    dirname(resolve(directory)) !== resolve(tmpdir()) ||
    !basename(directory).startsWith('examcraft-advisor-e2e-')
  )
    throw new Error('Unexpected cleanup path')
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

test('selection snapshot requires payload and destination consent, sends no full answer and never replaces it', async () => {
  const page = await launch()
  const answer = 'SECRET BEFORE selected thought SECRET AFTER'
  await selectAnswer(page, answer, 14, 30)
  await page.locator('.advisor-selection-action').click()
  const panel = page.getByRole('dialog', { name: 'Ask Advisor · 思路提示' })
  await expect(panel.getByLabel('本次发送的选中文字')).toHaveValue('selected thought')
  await expect(panel.getByText('https://api.deepseek.com', { exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: '确认并获取提示' })).toBeDisabled()
  expect(await bodyData()).toEqual([])
  await panel.getByRole('checkbox', { name: /我同意将以上/ }).check()
  await panel.getByRole('button', { name: '确认并获取提示' }).click()
  await expect(panel.getByText('先找出材料中的因果关系，再考虑它支持哪个观点。')).toBeVisible()
  const payloads = await bodyData()
  expect(payloads).toHaveLength(1)
  expect(payloads[0]).toMatchObject({ selectedText: 'selected thought', source: 'answer' })
  expect(payloads[0].question).toMatchObject({
    subject: expect.any(String),
    prompt: expect.any(String),
  })
  expect(
    Object.keys(payloads[0].question).every((key) =>
      ['subject', 'prompt', 'choices'].includes(key),
    ),
  ).toBe(true)
  expect(JSON.stringify(payloads)).not.toContain('SECRET BEFORE')
  expect(JSON.stringify(payloads)).not.toContain('SECRET AFTER')
  await expect(page.locator('#answer-text')).toHaveValue(answer)
  await expect(panel.getByRole('checkbox', { name: /我同意将以上/ })).not.toBeChecked()
  await panel.getByRole('button', { name: '关闭 Advisor' }).click()
  await expect(panel).toHaveCount(0)
})

test('keyboard toolbar captures read-only prompt; reference access is opt-in and resets consent', async () => {
  const page = await launch()
  const excerpt = await page.locator('.question-prompt p').evaluate((element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }))
    return element.textContent!.trim()
  })
  const toolbar = page.locator('.advisor-toolbar button')
  await toolbar.focus()
  await toolbar.press('Enter')
  const panel = page.getByRole('dialog')
  await expect(panel.getByLabel('本次发送的选中文字')).toHaveValue(excerpt)
  await expect(panel.getByRole('button', { name: '关闭 Advisor' })).toBeFocused()
  const consent = panel.getByRole('checkbox', { name: /我同意将以上/ })
  await consent.check()
  const reference = panel.getByRole('checkbox', { name: /允许顾问参考本题解析和评分依据/ })
  await expect(reference).not.toBeChecked()
  await reference.check()
  await expect(consent).not.toBeChecked()
  await expect(panel.getByText(/本次会由主进程按题号补充/)).toBeVisible()
  await consent.check()
  await panel.getByRole('button', { name: '确认并获取提示' }).click()
  await expect(panel.locator('.advisor-hint')).toBeVisible()
  const payloads = await bodyData()
  expect(payloads).toHaveLength(1)
  expect(payloads[0]).toMatchObject({ selectedText: excerpt, source: 'question' })
  expect(payloads[0].question.reference).toEqual(expect.any(String))
  expect(payloads[0].questionContext).toBeUndefined()
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(toolbar).toBeFocused()
})

test('cancel and changed selection abort pending requests; failures preserve answer and require new consent', async () => {
  const page = await launch()
  await app!.evaluate(() => {
    ;(globalThis as typeof globalThis & { advisorMode: string }).advisorMode = 'pending'
  })
  await selectAnswer(page, 'first phrase and second phrase', 0, 12)
  await page.locator('.advisor-selection-action').click()
  const panel = page.getByRole('dialog')
  const consent = panel.getByRole('checkbox', { name: /我同意将以上/ })
  const send = panel.getByRole('button', { name: '确认并获取提示' })
  await consent.check()
  await send.click()
  await expect(panel.getByText(/顾问提示请求进行中/)).toBeVisible()
  await expect(panel.getByRole('timer')).toContainText(/已用时 [1-9]\d* 秒/)
  await panel.getByRole('button', { name: '取消请求' }).click()
  await expect(panel.getByText('已取消请求。')).toBeVisible()
  await expect(panel.getByRole('timer')).toHaveCount(0)
  await expect(consent).not.toBeChecked()
  await expect
    .poll(() =>
      app!.evaluate(
        () => (globalThis as typeof globalThis & { advisorAborts: number }).advisorAborts,
      ),
    )
    .toBe(1)
  await consent.check()
  await send.click()
  await expect.poll(async () => (await bodyData()).length).toBe(2)
  await page.locator('#answer-text').evaluate((element) => {
    const input = element as HTMLTextAreaElement
    input.focus()
    input.setSelectionRange(17, 30)
    input.dispatchEvent(new Event('select', { bubbles: true }))
  })
  await expect(panel.getByLabel('本次发送的选中文字')).toHaveValue('second phrase')
  await expect(consent).not.toBeChecked()
  await expect
    .poll(() =>
      app!.evaluate(
        () => (globalThis as typeof globalThis & { advisorAborts: number }).advisorAborts,
      ),
    )
    .toBe(2)
  await app!.evaluate(() => {
    ;(globalThis as typeof globalThis & { advisorMode: string }).advisorMode = 'failure'
  })
  await consent.check()
  await send.click()
  await expect(panel.getByRole('alert')).toContainText('请求未完成')
  await expect(page.locator('#answer-text')).toHaveValue('first phrase and second phrase')
  await expect(consent).not.toBeChecked()
})

test('closing or switching questions cancels an outstanding hint and never shows it on the next question', async () => {
  const page = await launch()
  await app!.evaluate(() => {
    ;(globalThis as typeof globalThis & { advisorMode: string }).advisorMode = 'pending'
  })
  await selectAnswer(page, 'A selected learning question', 2, 10)
  await page.locator('.advisor-selection-action').click()
  const panel = page.getByRole('dialog')
  await panel.getByRole('checkbox', { name: /我同意将以上/ }).check()
  await panel.getByRole('button', { name: '确认并获取提示' }).click()
  await expect.poll(async () => (await bodyData()).length).toBe(1)
  await panel.getByRole('button', { name: '关闭 Advisor' }).click()
  await expect(panel).toHaveCount(0)
  await expect
    .poll(() =>
      app!.evaluate(
        () => (globalThis as typeof globalThis & { advisorAborts: number }).advisorAborts,
      ),
    )
    .toBe(1)
  await selectAnswer(page, 'A selected learning question', 2, 10)
  await page.locator('.advisor-toolbar button').click()
  await panel.getByRole('checkbox', { name: /我同意将以上/ }).check()
  await panel.getByRole('button', { name: '确认并获取提示' }).click()
  await expect.poll(async () => (await bodyData()).length).toBe(2)
  await page.locator('.question-item:not(.selected)').first().click()
  await expect(panel).toHaveCount(0)
  await expect
    .poll(() =>
      app!.evaluate(
        () => (globalThis as typeof globalThis & { advisorAborts: number }).advisorAborts,
      ),
    )
    .toBe(2)
  await expect(page.locator('.advisor-hint')).toHaveCount(0)
  await expect(page.locator('.advisor-selection-action')).toHaveCount(0)
})

test('reference scope change cancels an in-flight hint and requires fresh consent without writing an answer', async () => {
  const page = await launch()
  await app!.evaluate(() => {
    ;(globalThis as typeof globalThis & { advisorMode: string }).advisorMode = 'pending'
  })
  const original = '自主作答内容保持不变。'
  await selectAnswer(page, original, 0, 4)
  await page.locator('.advisor-selection-action').click()
  const panel = page.getByRole('dialog', { name: 'Ask Advisor · 思路提示' })
  const consent = panel.getByRole('checkbox', { name: /我同意将以上/ })
  const reference = panel.getByRole('checkbox', { name: /允许顾问参考本题解析和评分依据/ })
  await expect(reference).not.toBeChecked()
  await consent.check()
  await panel.getByRole('button', { name: '确认并获取提示' }).click()
  await expect.poll(async () => (await bodyData()).length).toBe(1)
  await reference.check()
  await expect(consent).not.toBeChecked()
  await expect(panel.getByRole('button', { name: '确认并获取提示' })).toBeDisabled()
  await expect
    .poll(() =>
      app!.evaluate(
        () => (globalThis as typeof globalThis & { advisorAborts: number }).advisorAborts,
      ),
    )
    .toBe(1)
  await expect(page.locator('#answer-text')).toHaveValue(original)
  expect((await bodyData())[0].question.reference).toBeUndefined()
  await panel.getByRole('button', { name: '关闭 Advisor' }).click()
  await selectAnswer(page, original, 0, 4)
  await page.locator('.advisor-toolbar button').click()
  await expect(reference).not.toBeChecked()
})

test('student question API contains no teacher reference fields before submission', async () => {
  const page = await launch()
  const questions = await page.evaluate(() => window.examcraft!.listQuestions())
  expect(questions.length).toBeGreaterThan(0)
  for (const question of questions) {
    expect(question).not.toHaveProperty('explanation')
    expect(question).not.toHaveProperty('rubric')
    expect(question).not.toHaveProperty('correctAnswer')
    expect(question).not.toHaveProperty('blocks')
  }
})

test('programmatic module checkpoint restore invalidates a pending selection hint', async () => {
  const page = await launch()
  await page
    .getByRole('navigation', { name: '工作区导航' })
    .getByRole('button', { name: /文科组装 Argument/ })
    .click()
  await page.getByTestId('palette-analysis').click()
  await page.getByTestId('place-center').click()
  const moduleText = page.getByTestId('argument-canvas').locator('[data-block-id] textarea').last()
  await moduleText.fill('检查点中的自主分析。')
  await page.locator('.argument-timeline > summary').click()
  await page.getByRole('textbox', { name: '检查点名称' }).fill('原始分析')
  await page.getByRole('button', { name: '保存检查点', exact: true }).click()
  await moduleText.fill('当前修改后的分析。')
  const finalText = '最终答案保持独立。'
  await selectAnswer(page, finalText, 0, 4)
  await app!.evaluate(() => {
    ;(globalThis as typeof globalThis & { advisorMode: string }).advisorMode = 'pending'
  })
  await page.locator('.advisor-selection-action').click()
  const panel = page.getByRole('dialog', { name: 'Ask Advisor · 思路提示' })
  await panel.getByRole('checkbox', { name: /我同意将以上/ }).check()
  await panel.getByRole('button', { name: '确认并获取提示' }).click()
  await expect.poll(async () => (await bodyData()).length).toBe(1)
  // Restoring updates React state directly: no DOM input event is emitted.
  const restore = page
    .locator('[data-revision-id]')
    .first()
    .getByRole('button', { name: '恢复此版本' })
  await restore.focus()
  await restore.press('Enter')
  const confirm = page.getByRole('button', { name: '确认恢复模块', exact: true })
  await confirm.focus()
  await confirm.press('Enter')
  await expect(moduleText).toHaveValue('检查点中的自主分析。')
  await expect(panel).toHaveCount(0)
  await expect(page.locator('.advisor-selection-action')).toHaveCount(0)
  await expect(page.locator('.advisor-hint')).toHaveCount(0)
  await expect
    .poll(() =>
      app!.evaluate(
        () => (globalThis as typeof globalThis & { advisorAborts: number }).advisorAborts,
      ),
    )
    .toBe(1)
  await expect(page.locator('#answer-text')).toHaveValue(finalText)
})

test('collapsing a textarea selection removes the action and cannot reopen an old snapshot', async () => {
  const page = await launch()
  await selectAnswer(page, 'one selected phrase', 4, 12)
  await page.locator('#answer-text').press('ArrowRight')
  await expect(page.locator('.advisor-selection-action')).toHaveCount(0)
  await page.locator('.advisor-toolbar button').click()
  await expect(page.getByRole('dialog', { name: 'Ask Advisor · 思路提示' })).toHaveCount(0)
  await expect(page.locator('.advisor-toolbar [role="status"]')).toContainText('请先选择')
  expect(await bodyData()).toEqual([])
})

test('native document deselection, outside clicks and question changes dismiss the floating action', async () => {
  const page = await launch()
  const selectPrompt = async () => {
    await page.locator('.question-prompt p').evaluate((element) => {
      const range = document.createRange()
      range.selectNodeContents(element)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      // Native text selection may leave keyboard focus on body.
      document.body.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }))
    })
    await expect(page.locator('.advisor-selection-action')).toBeVisible()
  }
  await selectPrompt()
  await page.evaluate(() => window.getSelection()!.removeAllRanges())
  await expect(page.locator('.advisor-selection-action')).toHaveCount(0)
  await selectPrompt()
  await page.locator('.brand').click()
  await expect(page.locator('.advisor-selection-action')).toHaveCount(0)
  // A delayed event after clicking elsewhere must not resurrect the old range.
  await page.evaluate(() => document.dispatchEvent(new Event('selectionchange')))
  await expect(page.locator('.advisor-selection-action')).toHaveCount(0)
  await selectPrompt()
  await page.locator('.question-item:not(.selected)').first().click()
  await expect(page.locator('.advisor-selection-action')).toHaveCount(0)
  expect(await bodyData()).toEqual([])
})

test('keyboard activation preserves the textarea excerpt; closing requires a fresh selection', async () => {
  const page = await launch()
  await selectAnswer(page, 'before selected after', 7, 15)
  const action = page.locator('.advisor-selection-action')
  await action.focus()
  await action.press('Enter')
  const panel = page.getByRole('dialog', { name: 'Ask Advisor · 思路提示' })
  await expect(panel.getByLabel('本次发送的选中文字')).toHaveValue('selected')
  await panel.getByLabel('本次发送的选中文字').click()
  await panel.locator('.advisor-context summary').click()
  await panel.getByRole('checkbox', { name: /允许顾问参考本题解析/ }).check()
  await expect(panel.getByLabel('本次发送的选中文字')).toHaveValue('selected')
  expect(await bodyData()).toEqual([])
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(page.locator('.advisor-toolbar button')).toBeFocused()
  await expect(action).toHaveCount(0)
  await page.locator('.advisor-toolbar button').press('Enter')
  await expect(panel).toHaveCount(0)
  await selectAnswer(page, 'before fresh after', 7, 12)
  await action.click()
  await expect(panel.getByLabel('本次发送的选中文字')).toHaveValue('fresh')
})

test('editing and undoing an answer never restore an obsolete Advisor snapshot', async () => {
  const page = await launch()
  const answer = page.locator('#answer-text')
  await selectAnswer(page, 'selected original answer', 0, 8)
  await answer.press('Backspace')
  await expect(page.locator('.advisor-selection-action')).toHaveCount(0)
  await answer.press('ControlOrMeta+z')
  await expect(answer).toHaveValue('selected original answer')
  await expect(page.locator('.advisor-selection-action')).toHaveCount(0)
  await page.locator('.advisor-toolbar button').click()
  await expect(page.getByRole('dialog', { name: 'Ask Advisor · 思路提示' })).toHaveCount(0)
  expect(await bodyData()).toEqual([])
})

test('leaving the window or moving focus to another control clears the floating action', async () => {
  const page = await launch()
  await selectAnswer(page, 'selected phrase', 0, 8)
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await expect(page.locator('.advisor-selection-action')).toHaveCount(0)
  await page.evaluate(() => document.dispatchEvent(new Event('selectionchange')))
  await expect(page.locator('.advisor-selection-action')).toHaveCount(0)
  await selectAnswer(page, 'selected phrase', 0, 8)
  await page.locator('.question-item:not(.selected)').first().focus()
  await expect(page.locator('.advisor-selection-action')).toHaveCount(0)
  expect(await bodyData()).toEqual([])
})

test('outside dismissal cancels an outstanding request and the closed dialog stays closed', async () => {
  const page = await launch()
  await app!.evaluate(() => {
    ;(globalThis as typeof globalThis & { advisorMode: string }).advisorMode = 'pending'
  })
  await selectAnswer(page, 'selected phrase', 0, 8)
  await page.locator('.advisor-selection-action').click()
  const panel = page.getByRole('dialog', { name: 'Ask Advisor · 思路提示' })
  await panel.getByRole('checkbox', { name: /我同意将以上/ }).check()
  await panel.getByRole('button', { name: '确认并获取提示' }).click()
  await expect.poll(async () => (await bodyData()).length).toBe(1)
  await page.locator('.brand').click()
  await expect(panel).toHaveCount(0)
  await expect(page.locator('.advisor-selection-action')).toHaveCount(0)
  await expect
    .poll(() =>
      app!.evaluate(
        () => (globalThis as typeof globalThis & { advisorAborts: number }).advisorAborts,
      ),
    )
    .toBe(1)
  await page.locator('.advisor-toolbar button').click()
  await expect(panel).toHaveCount(0)
  expect(await bodyData()).toHaveLength(1)
})

test('Advisor matches the light workspace and honors reduced motion without transforms', async () => {
  const page = await launch()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await selectAnswer(page, 'selected phrase', 0, 8)
  const action = page.locator('.advisor-selection-action')
  const actionStyle = await action.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      background: style.backgroundColor,
      color: style.color,
      radius: style.borderRadius,
      animation: style.animationName,
      transform: style.transform,
    }
  })
  expect(actionStyle).toEqual({
    background: 'rgb(255, 255, 255)',
    color: 'rgb(22, 125, 134)',
    radius: '7px',
    animation: 'none',
    transform: 'none',
  })
  await action.click()
  const panel = page.getByRole('dialog', { name: 'Ask Advisor · 思路提示' })
  await expect(panel).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect(panel).toHaveCSS('border-radius', '11px')
  await expect(panel).toHaveCSS('animation-name', 'none')
  await expect(panel).toHaveCSS('transform', 'none')
})

test('explicitly remembered Advisor consent carries to a new question but not extra reference data', async () => {
  const page = await launch()
  await selectAnswer(page, 'first selected phrase', 0, 5)
  await page.locator('.advisor-selection-action').click()
  const panel = page.getByRole('dialog', { name: 'Ask Advisor · 思路提示' })
  const consent = panel.getByRole('checkbox', { name: /我同意将以上/ })
  const remember = panel.getByRole('checkbox', { name: /记住对此接收方和数据范围/ })
  await expect(remember).not.toBeChecked()
  await consent.check()
  await remember.check()
  await expect(panel.getByText('已在本机记住同意 · 查看范围与撤销方式')).toBeVisible()
  await page.locator('.question-item:not(.selected)').first().click()
  await expect(panel).toHaveCount(0)
  await selectAnswer(page, 'second selected phrase', 0, 6)
  await page.locator('.advisor-selection-action').click()
  await expect(consent).toBeChecked()
  await expect(panel.getByLabel('本次发送的选中文字')).toHaveValue('second')
  expect(await bodyData()).toEqual([])
  await panel.getByRole('checkbox', { name: /允许顾问参考本题解析/ }).check()
  await expect(consent).not.toBeChecked()
  await expect(remember).not.toBeChecked()
  await expect(panel.getByRole('button', { name: '确认并获取提示' })).toBeDisabled()
  expect(await bodyData()).toEqual([])
})
