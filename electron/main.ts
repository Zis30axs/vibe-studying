import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  session,
  type IpcMainInvokeEvent,
} from 'electron'
import { readFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { LocalQuestionBank } from '../src/adapters/local-question-bank'
import { DeepSeekAgent } from '../src/adapters/deepseek-agent'
import { LocalRuleAgent } from '../src/adapters/local-rule-agent'
import { readJsonFile } from '../src/adapters/atomic-json-store'
import { StudyService } from '../src/domain/study-service'
import type { AnswerDraft, SubmissionOptions } from '../src/shared/types'

// Read only at application start; never expose credentials through IPC or to spawned renderers.
const deepseekKey = process.env.DEEPSEEK_API_KEY
delete process.env.DEEPSEEK_API_KEY
let deepseek: DeepSeekAgent | undefined
let deepseekConfigError: string | undefined
try {
  deepseek = new DeepSeekAgent({ apiKey: deepseekKey, model: process.env.EXAMCRAFT_DEEPSEEK_MODEL })
} catch {
  deepseekConfigError =
    'DeepSeek 模型配置无效，请检查 EXAMCRAFT_DEEPSEEK_MODEL 后重启；本地模式仍可使用。'
}
app.setName('ExamCraft')
// An explicit CLI profile works in portable builds too, including isolated release smoke tests.
// Ambient EXAMCRAFT_USER_DATA is still honored only in development.
const userDataOverride =
  app.commandLine.getSwitchValue('user-data-dir') ||
  (!app.isPackaged ? process.env.EXAMCRAFT_USER_DATA : undefined)
if (userDataOverride) {
  if (!isAbsolute(userDataOverride)) throw new Error('User data directory must be an absolute path')
  mkdirSync(userDataOverride, { recursive: true })
  app.setPath('userData', userDataOverride)
}
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'examcraft',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
])

const developmentUrl =
  !app.isPackaged && process.env.EXAMCRAFT_DEV_URL ? process.env.EXAMCRAFT_DEV_URL : undefined
if (developmentUrl && developmentUrl !== 'http://127.0.0.1:5173')
  throw new Error('Development URL must be http://127.0.0.1:5173')
const productionUrl = 'examcraft://app/index.html'
let mainWindow: BrowserWindow | null = null
const pendingWrites = new Set<Promise<unknown>>()

function trackWrite<T>(operation: Promise<T>): Promise<T> {
  pendingWrites.add(operation)
  void operation.then(
    () => pendingWrites.delete(operation),
    () => pendingWrites.delete(operation),
  )
  return operation
}

function validateSender(event: IpcMainInvokeEvent): void {
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== event.sender.mainFrame
  )
    throw new Error('Unauthorized IPC sender')
  const url = new URL(event.senderFrame.url)
  const trusted = developmentUrl
    ? url.origin === developmentUrl && url.pathname === '/' && !url.username && !url.password
    : url.protocol === 'examcraft:' &&
      url.hostname === 'app' &&
      url.pathname === '/index.html' &&
      !url.port &&
      !url.username &&
      !url.password
  if (!trusted) throw new Error('Unauthorized IPC origin')
}

function registerIpc(service: StudyService, bank: LocalQuestionBank): void {
  function handle(channel: string, listener: (...args: unknown[]) => unknown, writesState = false) {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      validateSender(event)
      const result = listener(...args)
      if (!writesState) return result
      // Track the complete pipeline, including validation and asynchronous bank lookup.
      return trackWrite(Promise.resolve(result))
    })
  }
  handle('examcraft:list-questions', () => bank.list())
  handle('examcraft:load-state', () => service.loadState())
  handle(
    'examcraft:save-draft',
    (questionId, draft) => service.saveDraft(questionId as string, draft as AnswerDraft),
    true,
  )
  handle(
    'examcraft:submit-answer',
    (questionId, draft, options) =>
      service.submitAnswer(
        questionId as string,
        draft as AnswerDraft,
        options as SubmissionOptions | undefined,
      ),
    true,
  )
  handle('examcraft:capabilities', () => ({
    questionBank: bank.name,
    reviewer: service.agent.name,
    deepseek: {
      configured: deepseek?.configured ?? false,
      model: deepseek?.model ?? '未配置',
      endpoint: 'https://api.deepseek.com',
      error: deepseekConfigError,
    },
    mcp: '内置 stdio MCP：list_questions / get_question / review_answer；可限定学科、标签和题目 ID',
  }))
  handle('examcraft:import-bank', async () => {
    if (!mainWindow) throw new Error('窗口已关闭')
    const owner = mainWindow
    const result = await dialog.showOpenDialog(owner, {
      title: '导入 ExamCraft JSON 题库',
      properties: ['openFile'],
      filters: [{ name: 'JSON 题库', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePaths[0] || owner.isDestroyed())
      return { count: 0, canceled: true }
    // A waiting native dialog is never tracked. Once a file is selected, finish its
    // read/validation/write pipeline before permitting the window to close.
    const count = await trackWrite(
      readJsonFile(result.filePaths[0]).then((input) => bank.importBank(input)),
    )
    return { count, canceled: false }
  })
}

async function registerAppProtocol(): Promise<void> {
  const root = resolve(__dirname, '../dist')
  const mimeTypes: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
  }
  protocol.handle('examcraft', async (request) => {
    try {
      const url = new URL(request.url)
      if (
        url.hostname !== 'app' ||
        url.port ||
        url.username ||
        url.password ||
        !['GET', 'HEAD'].includes(request.method)
      )
        return new Response('Forbidden', { status: 403 })
      const path = resolve(root, `.${decodeURIComponent(url.pathname)}`)
      const within = relative(root, path)
      if (
        !within ||
        within === '..' ||
        within.startsWith(`..${sep}`) ||
        isAbsolute(within) ||
        !mimeTypes[extname(path)]
      )
        return new Response('Forbidden', { status: 403 })
      const body = await readFile(path)
      return new Response(request.method === 'HEAD' ? null : new Uint8Array(body), {
        headers: {
          'Content-Type': `${mimeTypes[extname(path)]}; charset=utf-8`,
          'Content-Security-Policy':
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'",
          'X-Content-Type-Options': 'nosniff',
        },
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1000,
    minHeight: 700,
    title: 'ExamCraft · 学科工作台',
    backgroundColor: '#f5f4ef',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  mainWindow.webContents.on('will-redirect', (event) => event.preventDefault())
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())
  const window = mainWindow
  let draining = false
  window.on('close', (event) => {
    if (!pendingWrites.size) return
    event.preventDefault()
    if (draining) return
    draining = true
    window.hide()
    void (async () => {
      let failed = false
      while (pendingWrites.size) {
        const results = await Promise.allSettled([...pendingWrites])
        failed ||= results.some((result) => result.status === 'rejected')
      }
      if (window.isDestroyed()) return
      if (failed) {
        draining = false
        window.show()
        window.focus()
        dialog.showErrorBox(
          '部分更改未能保存',
          '本次关闭已取消。请查看窗口中的错误提示；已有数据未被覆盖。',
        )
      } else window.destroy()
    })()
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  void mainWindow.loadURL(developmentUrl ?? productionUrl)
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore()
    mainWindow?.focus()
  })
  app
    .whenReady()
    .then(async () => {
      session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
        callback(false),
      )
      session.defaultSession.setPermissionCheckHandler(() => false)
      await registerAppProtocol()
      const bank = new LocalQuestionBank(app.getPath('userData'))
      registerIpc(
        new StudyService(
          app.getPath('userData'),
          bank,
          new LocalRuleAgent(),
          deepseek?.configured ? deepseek : undefined,
        ),
        bank,
      )
      createWindow()
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
      })
    })
    .catch((error) => {
      dialog.showErrorBox(
        'ExamCraft 无法启动',
        error instanceof Error ? error.message : String(error),
      )
      app.quit()
    })
}
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
