import { expect, test, type Page } from '@playwright/test'
import type { AgentRunRequest, AgentRunState } from '../../src/shared/agent-workbench'
import type { ExamCraftApi, StudentQuestion, StudyState } from '../../src/shared/types'
import { emptyDraft } from '../../src/shared/types'
import { captureLearningSnapshot, emptyLearningGraph } from '../../src/domain/learning-graph'

const questions: StudentQuestion[] = [
  {
    id: 'politics-first',
    subject: 'politics',
    kind: 'choice',
    title: '默认政治题',
    prompt: '选择观点',
    choices: [{ id: 'A', text: '观点' }],
    source: 'fixture',
    tags: [],
    maxScore: 5,
  },
  {
    id: 'math-first',
    subject: 'math',
    kind: 'choice',
    title: '第一道数学题',
    prompt: '选择函数',
    choices: [{ id: 'A', text: '函数' }],
    source: 'fixture',
    tags: [],
    maxScore: 5,
  },
  {
    id: 'math-second',
    subject: 'math',
    kind: 'math',
    title: '第二道数学题',
    prompt: '解释函数',
    source: 'fixture',
    tags: [],
    maxScore: 5,
  },
  {
    id: 'geography-current',
    subject: 'geography',
    kind: 'geography',
    title: '当前地理题',
    prompt: '描述方向',
    source: 'fixture',
    tags: [],
    maxScore: 5,
  },
  {
    id: 'history-current',
    subject: 'history',
    kind: 'history',
    title: '当前历史题',
    prompt: '分析史料',
    source: 'fixture',
    tags: [],
    maxScore: 5,
  },
]
const mathDraft = emptyDraft('choice')
mathDraft.text = '数学题独立草稿'
mathDraft.math!.parameters.a = 3
mathDraft.drawing.points = [{ id: 'point-a', label: 'A', x: 2, y: 3 }]
mathDraft.blocks = [{ id: 'block-a', category: 'analysis', label: '分析', text: '模块推理' }]
mathDraft.argument = {
  version: 1,
  roots: [{ id: 'node-a', kind: 'analysis', text: '嵌套模块推理', children: [] }],
}
const initial: StudyState = {
  version: 1,
  attempts: [],
  drafts: {
    'math-first': mathDraft,
    'politics-first': { ...emptyDraft('choice'), text: '不应发送的政治草稿' },
  },
}

declare global {
  interface Window {
    questionContextFixture: {
      state: StudyState
      requests: AgentRunRequest[]
      cancels: string[]
      delayStart: boolean
      delayRestore: boolean
      releaseRestore?: () => void
      releaseStart?: () => void
    }
  }
}
const snapshot = (page: Page) =>
  page.getByRole('checkbox', { name: '附带当前答卷快照', exact: false })
const agentSubject = (page: Page) => page.getByRole('combobox', { name: '学科', exact: true })
const summary = (page: Page) => page.locator('.agent-scope-summary')
const start = (page: Page) => page.getByRole('button', { name: '开始本次 Agent 任务', exact: true })
const go = (page: Page, label: string) =>
  page.getByRole('button', { name: label, exact: true }).click()
const enterAgent = (page: Page) => go(page, 'Agent 工作台 Bounded tools')

async function openWorkspace(page: Page, bank = questions) {
  const historyDraft = { ...emptyDraft('history'), text: '历史题恢复的独立草稿' }
  let graph = captureLearningSnapshot(
    emptyLearningGraph(),
    {
      questionId: 'history-current',
      subject: 'history',
      draft: historyDraft,
      initialOrigin: 'independent',
    },
    'history-old',
    10,
  ).graph
  graph = captureLearningSnapshot(
    graph,
    {
      questionId: 'history-current',
      subject: 'history',
      draft: { ...historyDraft, text: '后来的历史草稿' },
    },
    'history-new',
    20,
  ).graph
  await page.addInitScript(
    ({ bank, initial, graph }) => {
      const state: StudyState = JSON.parse(
        sessionStorage.getItem('question-context-state') || JSON.stringify(initial),
      )
      const f = (window.questionContextFixture = {
        state,
        requests: [] as AgentRunRequest[],
        cancels: [] as string[],
        delayStart: false,
        delayRestore: false,
        releaseRestore: undefined as (() => void) | undefined,
        releaseStart: undefined as (() => void) | undefined,
      })
      let run: AgentRunState | null = null
      const api: Partial<ExamCraftApi> = {
        listQuestions: async () => structuredClone(bank),
        loadState: async () => structuredClone(state),
        getLearningGraph: async () => structuredClone(graph),
        restoreLearningSnapshot: async ({ snapshotId }) => {
          if (f.delayRestore)
            await new Promise<void>((resolve) => {
              f.releaseRestore = resolve
            })
          const source = graph.snapshots.find((item) => item.id === snapshotId)!
          const restored = {
            ...structuredClone(source),
            id: 'history-restored',
            parentId: 'history-new',
            reason: 'restore' as const,
            restoredFromSnapshotId: source.id,
          }
          state.drafts[source.questionId] = structuredClone(source.draft)
          graph.snapshots.push(restored)
          graph.heads['history:history-current'] = restored.id
          return restored
        },
        getCapabilities: async () => ({
          questionBank: 'fixture',
          reviewer: 'fixture',
          mcp: 'fixture',
        }),
        getModelProfiles: async () => ({
          revision: 1,
          secureStorageAvailable: false,
          profiles: [
            {
              profileId: 'test',
              profileName: 'Synthetic model',
              keyStatus: 'session',
              protocol: 'openai-chat',
              baseUrl: 'https://api.vendor.com/v1',
              model: 'synthetic',
              configured: true,
              revision: 1,
            },
          ],
          roles: { parent: 'test', child: 'test' },
        }),
        getModelConsents: async () => ({ version: 1, revision: 0, grants: [] }),
        getGitHubProfile: async () => null,
        listKnowledgeDocuments: async () => [],
        getWebResearchConfig: async () => ({
          provider: 'tavily',
          revision: 1,
          configured: false,
          keyStatus: 'missing',
          secureStorageAvailable: false,
        }),
        getGenerationStatus: async () => ({ used: 0, pending: 0, limit: 5 }),
        saveDraft: async (id, draft) => {
          state.drafts[id] = structuredClone(draft)
          sessionStorage.setItem('question-context-state', JSON.stringify(state))
        },
        cancelAdvisor: async () => {},
        cancelModuleReview: async () => {},
        cancelQuestionGeneration: async () => {},
        startAgentRun: async (request) => {
          f.requests.push(structuredClone(request))
          const result: AgentRunState = {
            runId: request.runId,
            status: 'running',
            startedAt: Date.now(),
            elapsedMs: 0,
            modelRequests: 1,
            toolCalls: 0,
            delegatedCalls: 0,
            sessionRequests: 1,
            budget: {
              modelRequests: 3,
              toolCalls: 6,
              delegatedCalls: 2,
              timeoutMs: 120000,
              sessionRequests: 30,
            },
            events: [],
            text: '',
            message: '',
            proposals: [],
          }
          run = result
          if (f.delayStart)
            await new Promise<void>((resolve) => {
              f.releaseStart = resolve
            })
          return { ...result, text: f.delayStart ? 'LATE_CONTEXT_RESULT' : '' }
        },
        getAgentRun: async () => structuredClone(run),
        cancelAgentRun: async (id) => {
          f.cancels.push(id)
          if (run) run = { ...run, status: 'cancelled' }
        },
      }
      window.examcraft = api as ExamCraftApi
    },
    { bank, initial, graph },
  )
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '今天，理解得更深一点。' })).toBeVisible()
}
async function send(page: Page) {
  await page.getByRole('textbox', { name: '本次任务', exact: true }).fill('检查当前范围')
  await page
    .getByRole('checkbox', { name: '我同意向主模型发送本次任务、所选数据与工具结果', exact: true })
    .check()
  await expect(start(page)).toBeEnabled()
  await start(page).click()
  await expect
    .poll(() => page.evaluate(() => window.questionContextFixture.requests.length))
    .toBeGreaterThan(0)
  return page.evaluate(() => window.questionContextFixture.requests.at(-1)!)
}

test('default politics to math fallback carries the exact question and opt-in full snapshot', async ({
  page,
}) => {
  await openWorkspace(page)
  await expect(page.locator('.question-prompt h2')).toHaveText('默认政治题')
  await go(page, '数学工作台 Math lab')
  await expect(page.locator('.question-prompt h2')).toHaveText('第一道数学题')
  await enterAgent(page)
  await expect(agentSubject(page)).toHaveValue('math')
  await expect(summary(page)).toContainText('第一道数学题（数学）')
  await expect(snapshot(page)).toBeEnabled()
  await expect(snapshot(page)).not.toBeChecked()
  const withoutAnswer = await send(page)
  expect(withoutAnswer.questionIds).toEqual(['math-first'])
  expect(withoutAnswer.currentQuestionId).toBe('math-first')
  expect(withoutAnswer.localDraft).toEqual(mathDraft)
  expect(withoutAnswer.answer).toBeUndefined()
  await go(page, '取消任务')
  await snapshot(page).check()
  const withAnswer = await send(page)
  expect(withAnswer.answer).toEqual(mathDraft)
  expect(JSON.stringify(withAnswer)).not.toContain('不应发送的政治草稿')
})

test('explicit selection, search fallback and formula roundtrip retain current identity and draft', async ({
  page,
}) => {
  await openWorkspace(page)
  await go(page, '数学工作台 Math lab')
  await page.locator('.question-item').filter({ hasText: '第二道数学题' }).click()
  await page.locator('#answer-text').fill('第二题更新后的独立推理')
  await page.getByRole('textbox', { name: '搜索题目', exact: true }).fill('第一道')
  await expect(page.locator('.question-prompt h2')).toHaveText('第一道数学题')
  await go(page, '公式速查 Formula reference')
  await enterAgent(page)
  await expect(summary(page)).toContainText('第一道数学题（数学）')
  await go(page, '数学工作台 Math lab')
  await expect(page.getByRole('textbox', { name: '搜索题目', exact: true })).toHaveValue('第一道')
  await page.getByRole('textbox', { name: '搜索题目', exact: true }).fill('')
  await expect(page.locator('.question-prompt h2')).toHaveText('第一道数学题')
  await page.locator('.question-item').filter({ hasText: '第二道数学题' }).click()
  await expect(page.locator('#answer-text')).toHaveValue('第二题更新后的独立推理')
  await enterAgent(page)
  await expect(summary(page)).toContainText('第二道数学题（数学）')
  await expect(snapshot(page)).not.toBeChecked()
  await snapshot(page).check()
  const request = await send(page)
  expect(request.answer?.text).toBe('第二题更新后的独立推理')
  expect(request.questionIds).toEqual(['math-second'])
  await go(page, '取消任务')
  await agentSubject(page).selectOption('history')
  await expect(snapshot(page)).toBeDisabled()
  await expect(snapshot(page)).not.toBeChecked()
  await expect(page.locator('#agent-answer-unavailable')).toContainText(
    '当前题目属于数学，本次范围为历史',
  )
  await agentSubject(page).selectOption('math')
  await expect(snapshot(page)).toBeEnabled()
  await expect(snapshot(page)).not.toBeChecked()
  await page.getByRole('combobox', { name: '工作模式', exact: true }).selectOption('create')
  await snapshot(page).check()
  await expect(snapshot(page)).toBeChecked()
})

for (const [route, title, subject] of [
  ['地理工作台 Geo canvas', '当前地理题', 'geography'],
  ['文科组装 Argument builder', '当前历史题', 'history'],
])
  test(`${route} carries its fallback question without a card click`, async ({ page }) => {
    await openWorkspace(page)
    await go(page, route)
    if (subject === 'history') await page.getByRole('button', { name: '历史', exact: true }).click()
    await expect(page.locator('.question-prompt h2')).toHaveText(title)
    await page.locator('#answer-text').fill(`${title}的草稿`)
    await enterAgent(page)
    await expect(agentSubject(page)).toHaveValue(subject)
    await expect(summary(page)).toContainText(title)
    await snapshot(page).check()
    const request = await send(page)
    expect(request.subject).toBe(subject)
    expect(request.answer?.text).toBe(`${title}的草稿`)
  })

for (const reason of ['search', 'subject', 'empty-bank'])
  test(`${reason} has no hidden question to attach or transmit`, async ({ page }) => {
    await openWorkspace(page, reason === 'empty-bank' ? [] : questions)
    if (reason === 'search')
      await page.getByRole('textbox', { name: '搜索题目', exact: true }).fill('不存在的题目')
    if (reason === 'subject') await page.getByRole('button', { name: '英语', exact: true }).click()
    await expect(page.locator('.question-prompt')).toHaveCount(0)
    await enterAgent(page)
    await expect(snapshot(page)).toBeDisabled()
    await expect(page.locator('#agent-answer-unavailable')).toContainText('当前没有选中的题目')
    const request = await send(page)
    expect(request.questionIds).toEqual([])
    expect(request.currentQuestionId).toBeUndefined()
    expect(request.localDraft).toBeUndefined()
    expect(request.answer).toBeUndefined()
    await go(page, '题目练习 Practice')
    await expect(page.locator('.question-prompt')).toHaveCount(0)
    if (reason !== 'empty-bank') {
      await go(page, '清除筛选')
      await expect(page.locator('.question-prompt h2')).toHaveText('默认政治题')
    }
  })

test('empty answer is attachable in create mode; leaving a pending run cancels and suppresses late results', async ({
  page,
}) => {
  await openWorkspace(page)
  await go(page, '数学工作台 Math lab')
  await page.locator('.question-item').filter({ hasText: '第二道数学题' }).click()
  await enterAgent(page)
  await page.getByRole('combobox', { name: '工作模式', exact: true }).selectOption('create')
  await snapshot(page).check()
  await page.evaluate(() => {
    window.questionContextFixture.delayStart = true
  })
  const request = await send(page)
  expect(request.answer?.text).toBe('')
  expect(request.questionIds).toEqual(['math-second'])
  await go(page, '数学工作台 Math lab')
  await expect
    .poll(() => page.evaluate(() => window.questionContextFixture.cancels))
    .toContain(request.runId)
  await page.locator('#answer-text').fill('离开任务后继续作答')
  await page.evaluate(() => window.questionContextFixture.releaseStart?.())
  await expect.poll(() => page.evaluate(() => window.questionContextFixture.cancels.length)).toBe(2)
  await enterAgent(page)
  await expect(summary(page)).toContainText('第二道数学题')
  await expect(snapshot(page)).not.toBeChecked()
  await expect(page.getByText('LATE_CONTEXT_RESULT')).toHaveCount(0)
  await go(page, '数学工作台 Math lab')
  await expect(page.locator('#answer-text')).toHaveValue('离开任务后继续作答')
  await page.reload()
  await go(page, '数学工作台 Math lab')
  await page.locator('.question-item').filter({ hasText: '第二道数学题' }).click()
  await expect(page.locator('#answer-text')).toHaveValue('离开任务后继续作答')
})

test('explicit history restoration reveals the selected snapshot despite previous study filters', async ({
  page,
}) => {
  await openWorkspace(page)
  await page.getByRole('button', { name: '数学', exact: true }).click()
  await page.getByRole('textbox', { name: '搜索题目', exact: true }).fill('第一道')
  await go(page, '练习记录 Review & reflect')
  await page
    .locator('[data-snapshot-id="history-old"]')
    .getByRole('button', { name: '恢复此快照为新分支' })
    .click()
  await expect(page.getByRole('status').filter({ hasText: '已恢复为新的作答分支' })).toBeVisible()
  await go(page, '题目练习 Practice')
  await expect(page.locator('.question-prompt h2')).toHaveText('当前历史题')
  await expect(page.getByRole('textbox', { name: '搜索题目', exact: true })).toHaveValue('')
  await expect(page.locator('#answer-text')).toHaveValue('历史题恢复的独立草稿')
  await enterAgent(page)
  await expect(agentSubject(page)).toHaveValue('history')
  await expect(summary(page)).toContainText('当前历史题')
})

test('a late history restoration cannot replace a newer visible selection', async ({ page }) => {
  await openWorkspace(page)
  await go(page, '练习记录 Review & reflect')
  await page.evaluate(() => {
    window.questionContextFixture.delayRestore = true
  })
  await page
    .locator('[data-snapshot-id="history-old"]')
    .getByRole('button', { name: '恢复此快照为新分支' })
    .click()
  await go(page, '数学工作台 Math lab')
  await page.locator('.question-item').filter({ hasText: '第二道数学题' }).click()
  await page.locator('#answer-text').fill('新的数学作答')
  await page.evaluate(() => window.questionContextFixture.releaseRestore?.())
  await expect(page.getByRole('status').filter({ hasText: '已恢复为新的作答分支' })).toBeVisible()
  await expect(page.locator('.question-prompt h2')).toHaveText('第二道数学题')
  await expect(page.locator('#answer-text')).toHaveValue('新的数学作答')
  await enterAgent(page)
  await expect(summary(page)).toContainText('第二道数学题')
})
