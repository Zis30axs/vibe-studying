import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createServer, type ViteDevServer } from 'vite'

test('development renderer loads with CSP and submits a choice through desktop IPC', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'examcraft-development-'))
  let server: ViteDevServer | undefined
  let app: ElectronApplication | undefined
  try {
    server = await createServer()
    await server.listen()
    const env: Record<string, string> = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    )
    env.EXAMCRAFT_USER_DATA = userData
    env.EXAMCRAFT_DEV_URL = 'http://127.0.0.1:5173'
    delete env.ELECTRON_RUN_AS_NODE
    app = await electron.launch({ args: ['.'], env })
    const page = await app.firstWindow()
    const pageErrors: string[] = []
    const cspErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    page.on('console', (message) => {
      if (
        message.type() === 'error' &&
        /content security policy|violat(?:es|ion)|refused to (?:load|execute|connect)/i.test(
          message.text(),
        )
      ) {
        cspErrors.push(message.text())
      }
    })
    // Reload after listeners attach so even early Refresh/CSP failures are observed.
    await page.waitForURL('http://127.0.0.1:5173/')
    await page.reload()
    await expect(page).toHaveURL('http://127.0.0.1:5173/')
    await expect(page.getByRole('heading', { name: '今天，理解得更深一点。' })).toBeVisible()
    await expect(page.getByRole('button', { name: '提交并审阅' })).toBeDisabled()
    await page.getByRole('radio').first().click()
    await page.getByLabel('思考笔记').fill('开发模式：通过试点检验认识。')
    await page.getByRole('button', { name: '提交并审阅' }).click()
    await expect(page.getByLabel('审阅结果').locator('.score')).toHaveText('4 / 4')
    await expect(page.getByRole('alert')).toHaveCount(0)
    const stored = await page.evaluate(() => window.examcraft!.loadState())
    expect(stored.attempts).toHaveLength(1)
    expect(stored.attempts[0]).toMatchObject({
      questionId: 'pol-choice-1',
      score: 4,
      draft: { choiceId: 'A', text: '开发模式：通过试点检验认识。' },
    })
    expect(pageErrors).toEqual([])
    expect(cspErrors).toEqual([])
  } finally {
    try {
      await app?.close()
    } finally {
      try {
        await server?.close()
      } finally {
        if (
          dirname(resolve(userData)) !== resolve(tmpdir()) ||
          !basename(userData).startsWith('examcraft-development-')
        )
          throw new Error('Unexpected test cleanup path')
        await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      }
    }
  }
})
