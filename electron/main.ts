import { resolveAgentKnowledgeIndex } from '../src/adapters/agent-knowledge'
import { ReviewKnowledgeIndex, ReviewKnowledgeError } from '../src/adapters/review-knowledge-index'
import { bindWindowWorkCancellation } from './window-work-lifecycle'
import { createSystemProxyResolver } from './model-system-proxy'
import { WebResearchStore } from '../src/adapters/web-research-store'
import { TavilyWebResearchProvider } from '../src/adapters/web-research-provider'
import type { WebResearchConfigInput } from '../src/shared/web-research'
import { LearningHelpCoordinator } from '../src/adapters/learning-help-coordinator'
import { LearningGraphService } from '../src/adapters/learning-graph-service'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  session,
  safeStorage,
  clipboard,
  nativeImage,
  type IpcMainInvokeEvent,
} from 'electron'
import { WallpaperStore, WallpaperError, inspectWallpaperRaster } from './wallpaper-store'
import { readFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  MAX_KNOWLEDGE_PDF_BYTES,
  knowledgeRequestIdSchema,
  knowledgeImportOptionsSchema,
} from '../src/shared/knowledge'
import { KnowledgeLibraryError, LocalKnowledgeLibrary } from '../src/adapters/knowledge-library'
import {
  KnowledgePackError,
  importKnowledgePackFromSelectedManifest,
} from '../src/adapters/knowledge-pack'
import { canceledKnowledgePackImport } from '../src/shared/knowledge-pack'
import { readSelectedPdf } from '../src/adapters/local-pdf-file'
import { LocalQuestionBank } from '../src/adapters/local-question-bank'
import { GitHubProfileService } from '../src/adapters/github-profile-service'
import { modelConsentRevokeSchema, type ModelConsentGrantInput } from '../src/shared/model-consent'
import { ModelConsentStore } from '../src/adapters/model-consent-store'
import { ModelService } from '../src/adapters/model-service'
import { AgentService, AgentRunError } from '../src/adapters/agent-service'
import { osSecretStorage } from '../src/adapters/os-secret-storage'
import { DeepSeekAgent } from '../src/adapters/deepseek-agent'
import { LocalRuleAgent } from '../src/adapters/local-rule-agent'
import { readJsonFile } from '../src/adapters/atomic-json-store'
import { StudyService } from '../src/domain/study-service'
import { listStudentQuestions } from '../src/domain/student-question'
import type {
  AdvisorRequest,
  GenerateGeographyRequest,
  ModuleReviewRequest,
  ModelConfigInput,
  ModelRole,
  ModelProfileInput,
  ModelRoleInput,
  ModelProfileDeleteInput,
  ModelDiagnosticInput,
  AnswerDraft,
  SubmissionOptions,
} from '../src/shared/types'

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
let cancelWindowWork = () => {}
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

function registerIpc(
  service: StudyService,
  bank: LocalQuestionBank,
  models: ModelService,
  knowledge: LocalKnowledgeLibrary,
): void {
  function handle(channel: string, listener: (...args: unknown[]) => unknown, writesState = false) {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      validateSender(event)
      const result = listener(...args)
      if (!writesState) return result
      // Track the complete pipeline, including validation and asynchronous bank lookup.
      return trackWrite(Promise.resolve(result))
    })
  }
  // Appearance is intentionally outside StudyService, model payloads, exports and debug logs.
  const appearance = new WallpaperStore(app.getPath('userData'), (bytes) => {
    inspectWallpaperRaster(bytes)
    const image = nativeImage.createFromBuffer(bytes)
    if (image.isEmpty())
      throw new WallpaperError('图片无法解码，请选择其他 PNG、JPEG 或 WebP 图片。')
    const size = image.getSize()
    if (
      size.width < 1 ||
      size.height < 1 ||
      size.width > 8192 ||
      size.height > 8192 ||
      size.width * size.height > 24_000_000
    )
      throw new WallpaperError('图片尺寸超过壁纸限制。')
    const clean = image.toPNG()
    inspectWallpaperRaster(clean)
    return clean
  })
  const safeAppearance = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation()
    } catch (error) {
      throw new Error(
        error instanceof WallpaperError ? error.message : '无法处理本地外观设置，请重试。',
      )
    }
  }
  let wallpaperPickerOpen = false
  handle('examcraft:get-appearance', () => safeAppearance(() => appearance.get()))
  handle('examcraft:save-appearance', (input) => safeAppearance(() => appearance.save(input)), true)
  handle('examcraft:remove-wallpaper', () => safeAppearance(() => appearance.remove()), true)
  handle('examcraft:reset-appearance', () => safeAppearance(() => appearance.remove(true)), true)
  handle('examcraft:choose-wallpaper', () =>
    safeAppearance(async () => {
      if (!mainWindow || wallpaperPickerOpen)
        throw new WallpaperError('请先完成已打开的图片选择窗口。')
      wallpaperPickerOpen = true
      const owner = mainWindow
      const ticket = appearance.beginSelection()
      try {
        const selection = await dialog.showOpenDialog(owner, {
          title: '选择本机壁纸（仅存储在本机，不发送给模型）',
          properties: ['openFile'],
          filters: [
            { name: '静态壁纸 · PNG / JPEG / WebP', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
          ],
        })
        if (selection.canceled || !selection.filePaths[0] || owner.isDestroyed())
          return { canceled: true, appearance: await appearance.get() }
        return await trackWrite(appearance.importSelectedFile(selection.filePaths[0], ticket))
      } finally {
        wallpaperPickerOpen = false
      }
    }),
  )
  const knowledgeImports = new Map<string, AbortController>()
  cancelWindowWork = () => {
    models.cancelAll()
    service.cancelCloudReview()
    for (const controller of knowledgeImports.values()) controller.abort()
  }
  const reviewKnowledge = new ReviewKnowledgeIndex(app.getPath('userData'), {
    resolveAttempt: async (id) =>
      (await service.loadState()).attempts.find((attempt) => attempt.id === id),
    resolveChunks: (ids) => knowledge.resolveChunks(ids),
    verifyDocument: async (id) => {
      await knowledge.getBytes(id)
    },
  })
  const safeReviewKnowledge = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work()
    } catch (error) {
      throw new Error(
        error instanceof ReviewKnowledgeError
          ? error.message
          : '知识点索引操作未完成；请刷新索引，核对提交、PDF 来源和当前版本后重试。原 PDF 不会修改。',
      )
    }
  }
  handle(
    'examcraft:refresh-review-knowledge',
    (input) => safeReviewKnowledge(() => reviewKnowledge.refresh(input)),
    true,
  )
  handle('examcraft:list-review-knowledge', (input) =>
    safeReviewKnowledge(() => reviewKnowledge.list(input)),
  )
  handle(
    'examcraft:update-review-knowledge-label',
    (input) => safeReviewKnowledge(() => reviewKnowledge.updateLabel(input)),
    true,
  )
  handle(
    'examcraft:associate-review-knowledge',
    (input) => safeReviewKnowledge(() => reviewKnowledge.associate(input)),
    true,
  )
  handle(
    'examcraft:remove-review-knowledge-association',
    (input) => safeReviewKnowledge(() => reviewKnowledge.removeAssociation(input)),
    true,
  )
  handle(
    'examcraft:remove-review-knowledge-node',
    (input) => safeReviewKnowledge(() => reviewKnowledge.removeNode(input)),
    true,
  )
  const webResearch = new WebResearchStore(app.getPath('userData'), {
    secureStorage: osSecretStorage(safeStorage),
  })
  const agent = new AgentService(models, {
    validateWebRevision: async (revision) => {
      const config = await webResearch.getConfig()
      if (config.revision !== revision || !config.configured)
        throw new AgentRunError('联网配置已更改或 Tavily 密钥不可用，请重新确认。')
    },
    createWebSession: async (request) => {
      try {
        const { key } = await webResearch.resolve(request.configRevision)
        return new TavilyWebResearchProvider({ apiKey: key }).createSession(request.scope)
      } catch {
        throw new AgentRunError('公开联网范围无效或 Tavily 配置不可用，请重新确认。')
      }
    },
    graph: service.graph,
    captureSnapshot: (id, draft) => service.captureSnapshot(id, draft),
    applyAnswer: async (questionId, baseline, replacement, learning) => {
      if (!learning) throw new AgentRunError('建议缺少可确认的作答基线，未应用。')
      await service.applyLearningEdit(questionId, {
        branchId: learning.branchId,
        expectedSnapshotId: learning.snapshotId,
        draft: { ...baseline, text: replacement },
      })
    },
    trackWrite,
    getQuestion: (id) => bank.get(id),
    resolveKnowledge: (ids) => knowledge.resolveChunks(ids),
    resolveKnowledgeIndex: (input) => resolveAgentKnowledgeIndex(reviewKnowledge, input),
    searchKnowledge: async (input) =>
      (await knowledge.search(input)).map(({ score: _score, ...evidence }) => evidence),
    validateKnowledgeScope: async (scope, subject) => {
      const document = (await knowledge.list()).find((item) => item.id === scope.documentId)
      if (!document || document.subject !== subject || scope.endPage > document.pageCount)
        throw new Error('教材或物理页码不在本次已确认范围内。')
    },
    saveQuestion: async (question) => {
      const questions = await bank.list()
      if (
        questions.some(
          (item) =>
            item.id === question.id ||
            item.prompt.normalize('NFKC').replace(/\s+/gu, '') ===
              question.prompt.normalize('NFKC').replace(/\s+/gu, ''),
        )
      )
        throw new AgentRunError('题目已存在，未覆盖或重复保存。')
      return bank.importBank({ version: 1, questions: [question] })
    },
  })
  const safeAgent = async <T>(work: () => Promise<T>) => {
    try {
      return await work()
    } catch (error) {
      throw new Error(
        error instanceof AgentRunError
          ? error.message
          : 'Agent 操作未完成；请确认范围和当前作答版本后重试。',
      )
    }
  }
  handle('examcraft:get-web-research-config', async () => {
    try {
      return await webResearch.getConfig()
    } catch {
      throw new Error('无法读取联网配置；原文件未覆盖，请恢复备份。')
    }
  })
  handle(
    'examcraft:save-web-research-config',
    async (input) => {
      agent.cancelCurrent()
      try {
        return await webResearch.saveConfig(input as WebResearchConfigInput)
      } catch {
        throw new Error('联网配置未保存；请检查密钥、配置版本和系统安全存储，或选择仅本次会话。')
      }
    },
    true,
  )
  handle('examcraft:start-agent-run', (input) => safeAgent(() => agent.start(input)))
  handle('examcraft:get-agent-run', (id) => (typeof id === 'string' ? agent.get(id) : null))
  handle('examcraft:cancel-agent-run', (id) => {
    if (typeof id === 'string') agent.cancel(id)
  })
  handle(
    'examcraft:accept-agent-proposal',
    (input) => safeAgent(() => agent.accept(input as Parameters<AgentService['accept']>[0])),
    true,
  )
  handle('examcraft:discard-agent-proposal', (input) => safeAgent(async () => agent.discard(input)))
  const safeKnowledge = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof KnowledgeLibraryError) throw new Error(error.message)
      throw new Error('无法处理本地 PDF；请检查文件、所选资料及页码范围后重试。')
    }
  }
  handle('examcraft:list-knowledge-documents', () => safeKnowledge(() => knowledge.list()))
  handle('examcraft:get-knowledge-pdf', (id) =>
    safeKnowledge(() => knowledge.getBytes(id as string)),
  )
  handle('examcraft:search-knowledge', (input) => safeKnowledge(() => knowledge.search(input)))
  handle(
    'examcraft:save-knowledge-scopes',
    (input) => safeKnowledge(() => knowledge.saveScopes(input)),
    true,
  )
  handle(
    'examcraft:update-knowledge-metadata',
    (input) => safeKnowledge(() => knowledge.updateDocumentMetadata(input)),
    true,
  )
  handle('examcraft:cancel-knowledge-import', (rawId) => {
    const id = knowledgeRequestIdSchema.parse(rawId)
    knowledgeImports.get(id)?.abort()
  })
  handle('examcraft:import-knowledge-pdf', async (rawId, rawOptions) => {
    const options = knowledgeImportOptionsSchema.parse(rawOptions ?? {})
    const id = knowledgeRequestIdSchema.parse(rawId)
    if (!mainWindow) throw new Error('窗口已关闭')
    if (knowledgeImports.size) throw new Error('已有 PDF 导入正在处理，请完成或取消后再试。')
    const owner = mainWindow
    const controller = new AbortController()
    knowledgeImports.set(id, controller)
    try {
      const selection = await dialog.showOpenDialog(owner, {
        title: '导入本机教材 PDF（仅存储在本机）',
        properties: ['openFile'],
        filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
      })
      if (
        selection.canceled ||
        !selection.filePaths[0] ||
        owner.isDestroyed() ||
        controller.signal.aborted
      )
        return { canceled: true }
      const path = selection.filePaths[0]
      const result = await trackWrite(
        (async () => {
          let bytes: Uint8Array
          try {
            bytes = await readSelectedPdf(path, MAX_KNOWLEDGE_PDF_BYTES, controller.signal)
          } catch {
            throw new Error('无法读取 PDF；请确认文件可读、未发生变化且不超过 50 MiB。')
          }
          const title = basename(path, extname(path)).trim().slice(0, 200) || '本地 PDF'
          return knowledge.importBytes(title, bytes, { ...options, signal: controller.signal })
        })().catch((error) => {
          if (controller.signal.aborted) return null
          throw error
        }),
      )
      if (!result) return { canceled: true }
      return result
    } catch (error) {
      if (controller.signal.aborted) return { canceled: true }
      if (error instanceof KnowledgeLibraryError) throw new Error(error.message)
      throw new Error('无法导入 PDF；请确认文件可读、未损坏且不超过 50 MiB。')
    } finally {
      knowledgeImports.delete(id)
    }
  })
  handle('examcraft:import-knowledge-pack', async (rawId) => {
    const id = knowledgeRequestIdSchema.parse(rawId)
    if (!mainWindow) throw new Error('窗口已关闭')
    if (knowledgeImports.size) throw new Error('已有教材导入正在处理，请完成或取消后再试。')
    const owner = mainWindow
    const controller = new AbortController()
    knowledgeImports.set(id, controller)
    try {
      const selection = await dialog.showOpenDialog(owner, {
        title: '导入私有教材资料包：请选择完整资料目录中的 pack.json',
        properties: ['openFile'],
        filters: [{ name: '教材资料清单 pack.json', extensions: ['json'] }],
      })
      if (
        selection.canceled ||
        !selection.filePaths[0] ||
        owner.isDestroyed() ||
        controller.signal.aborted
      )
        return canceledKnowledgePackImport()
      return await trackWrite(
        importKnowledgePackFromSelectedManifest(selection.filePaths[0], knowledge, {
          signal: controller.signal,
        }),
      )
    } catch (error) {
      if (controller.signal.aborted) return canceledKnowledgePackImport()
      if (error instanceof KnowledgePackError) throw new Error(error.message)
      throw new Error('无法打开教材资料包，请确认 pack.json 与全部原 PDF 或分片都在同一文件夹。')
    } finally {
      knowledgeImports.delete(id)
    }
  })
  app.on('before-quit', () => {
    for (const controller of knowledgeImports.values()) controller.abort()
  })
  const profiles = new GitHubProfileService(app.getPath('userData'))
  handle('examcraft:get-github-profile', () => profiles.get())
  handle('examcraft:set-github-profile', (input) => profiles.bind(input), true)
  handle('examcraft:clear-github-profile', () => profiles.clear(), true)
  handle('examcraft:get-model-config', (role) => models.getConfig(role as ModelRole | undefined))
  const modelConsents = new ModelConsentStore(app.getPath('userData'))
  handle('examcraft:get-model-consents', () => modelConsents.getModelConsents())
  handle(
    'examcraft:grant-model-consent',
    (input) => modelConsents.grantModelConsent(input as ModelConsentGrantInput),
    true,
  )
  handle(
    'examcraft:revoke-model-consent',
    async (input) => {
      const parsed = modelConsentRevokeSchema.parse(input)
      service.cancelCloudReview()
      models.cancelAll()
      return modelConsents.revokeModelConsent(parsed)
    },
    true,
  )
  handle('examcraft:cancel-model-review', () => {
    service.cancelCloudReview()
    models.cancelGrading()
  })
  handle('examcraft:get-model-debug', () => models.getModelDebug())
  handle('examcraft:set-model-debug-enabled', (enabled) =>
    models.setModelDebugEnabled(enabled as boolean),
  )
  handle('examcraft:clear-model-debug', () => models.clearModelDebug())
  handle('examcraft:copy-model-debug', () => clipboard.writeText(models.modelDebugText()))
  handle('examcraft:get-model-profiles', () => models.getProfiles())
  handle(
    'examcraft:save-model-profile',
    (input) => models.saveProfile(input as ModelProfileInput),
    true,
  )
  handle(
    'examcraft:assign-model-profiles',
    (input) => models.assignProfiles(input as ModelRoleInput),
    true,
  )
  handle(
    'examcraft:delete-model-profile',
    (input) => models.deleteProfile(input as ModelProfileDeleteInput),
    true,
  )
  handle('examcraft:diagnose-model', (input) => models.diagnoseModel(input as ModelDiagnosticInput))
  handle('examcraft:cancel-model-diagnostic', (id) => models.cancelModelDiagnostic(id as string))
  handle(
    'examcraft:save-model-config',
    (input) => models.saveConfig(input as ModelConfigInput),
    true,
  )
  const learningHelp = new LearningHelpCoordinator(service)
  models.onCancelAll(() => learningHelp.cancelAll())
  handle(
    'examcraft:restore-learning-snapshot',
    (input) =>
      service.restoreLearningSnapshot(input as { snapshotId: string; expectedHeadId: string }),
    true,
  )
  handle('examcraft:get-learning-graph', () => service.graph?.load())
  handle(
    'examcraft:accept-module-suggestion',
    (input) =>
      learningHelp.acceptModule(input as Parameters<LearningHelpCoordinator['acceptModule']>[0]),
    true,
  )
  handle('examcraft:reject-learning-help', (id) => learningHelp.reject(id as string), true)
  handle(
    'examcraft:ask-advisor',
    (input, localDraft) => {
      const request = input as AdvisorRequest
      return learningHelp.run(
        {
          requestId: request.requestId,
          questionId: request.questionId,
          kind: 'selection',
          draft: localDraft as AnswerDraft | undefined,
          prompt: request.selectedText,
        },
        () => models.askAdvisor(request),
        (result) => result.hint,
      )
    },
    true,
  )
  handle('examcraft:cancel-advisor', (id) => {
    learningHelp.cancel(id as string)
    return models.cancelAdvisor(id as string)
  })
  handle(
    'examcraft:review-modules',
    (input, localDraft) => {
      const request = input as ModuleReviewRequest
      return learningHelp.run(
        {
          requestId: request.requestId,
          questionId: request.questionId,
          kind: 'module-review',
          draft: localDraft as AnswerDraft | undefined,
          prompt: request.scope === 'all' ? '检查全部模块' : '检查所选模块',
        },
        () => models.reviewModules(request),
        (result) =>
          [
            result.summary,
            ...result.suggestions.map(
              (suggestion) =>
                `${suggestion.reason}：${suggestion.edit?.replacement ?? suggestion.evidence}`,
            ),
          ].join('\n'),
      )
    },
    true,
  )
  handle('examcraft:cancel-module-review', (id) => {
    learningHelp.cancel(id as string)
    return models.cancelModuleReview(id as string)
  })
  const generatedHelpRequests = new Map<string, string>()
  handle(
    'examcraft:generate-geography-question',
    (input, localContext) => {
      const request = input as GenerateGeographyRequest
      const context = localContext as { questionId: string; draft: AnswerDraft } | undefined
      if (!context) return models.generateGeographyQuestion(request)
      return learningHelp
        .run(
          {
            requestId: request.requestId,
            questionId: context.questionId,
            kind: 'geography-generation',
            draft: context.draft,
            prompt: `${request.syllabus} / ${request.chapter} / ${request.difficulty}`,
          },
          () => models.generateGeographyQuestion(request),
          (result) => `${result.question.title}\n${result.question.prompt}`,
        )
        .then((result) => {
          generatedHelpRequests.set(result.token, request.requestId)
          return result
        })
    },
    true,
  )
  handle(
    'examcraft:accept-generated-question',
    (token) => models.acceptGeneratedQuestion(token as string),
    true,
  )
  handle(
    'examcraft:reject-generated-question',
    async (token) => {
      const requestId = generatedHelpRequests.get(token as string)
      await models.rejectGeneratedQuestion(token as string)
      if (requestId) {
        generatedHelpRequests.delete(token as string)
        await learningHelp.reject(requestId).catch(() => undefined)
      }
    },
    true,
  )
  handle(
    'examcraft:cancel-question-generation',
    (id) => (learningHelp.cancel(id as string), models.cancelQuestionGeneration(id as string)),
  )
  handle('examcraft:generation-status', () => models.getGenerationStatus())
  app.on('before-quit', () => models.cancelAll())
  handle('examcraft:list-questions', () => listStudentQuestions(bank))
  handle('examcraft:load-state', () => service.loadState())
  handle(
    'examcraft:save-draft',
    (questionId, draft) => service.saveDraft(questionId as string, draft as AnswerDraft),
    true,
  )
  handle(
    'examcraft:submit-answer',
    (questionId, draft, options) => {
      // Legacy callers must use the migrated named profile so no desktop model request
      // can bypass its explicit network route, revision check and cancellation lifecycle.
      if ((options as SubmissionOptions | undefined)?.provider === 'deepseek')
        throw new Error('请在模型设置中使用已迁移的模型配置，并重新确认本次发送。')
      return service.submitAnswer(
        questionId as string,
        draft as AnswerDraft,
        options as SubmissionOptions | undefined,
      )
    },
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
    '.mjs': 'text/javascript',
    '.bcmap': 'application/octet-stream',
    '.pfb': 'application/octet-stream',
    '.ttf': 'font/ttf',
    '.woff': 'font/woff',
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
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; font-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'",
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
  bindWindowWorkCancellation(window, () => cancelWindowWork())
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
      const knowledge = new LocalKnowledgeLibrary(app.getPath('userData'), {
        workerPath: join(__dirname, 'knowledge-pdf-worker.cjs'),
      })
      const models = new ModelService(app.getPath('userData'), {
        resolveSystemProxy: createSystemProxyResolver(),
        secureStorage: osSecretStorage(safeStorage),
        resolveQuestion: (id) => bank.get(id),
        resolveKnowledgeChunks: (ids) => knowledge.resolveChunks(ids),
        listQuestions: () => bank.list(),
        persistGenerated: (question) => bank.importBank({ version: 1, questions: [question] }),
        apiKey: deepseekKey,
        model: process.env.EXAMCRAFT_DEEPSEEK_MODEL,
      })
      registerIpc(
        new StudyService(
          app.getPath('userData'),
          bank,
          new LocalRuleAgent(),
          deepseek?.configured ? deepseek : undefined,
          (revision) => models.reviewer(revision),
          new LearningGraphService(app.getPath('userData')),
        ),
        bank,
        models,
        knowledge,
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
