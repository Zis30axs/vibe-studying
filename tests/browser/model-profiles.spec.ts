import { test, expect, type Page } from '@playwright/test'
import type {
  ExamCraftApi,
  ModelDiagnosticInput,
  ModelDiagnosticResult,
  ModelProfileInput,
  ModelProfilesState,
} from '../../src/shared/types'

interface ModelTestFixture {
  state: ModelProfilesState
  saves: ModelProfileInput[]
  diagnostics: ModelDiagnosticInput[]
  canceled: string[]
  delaySave: boolean
  delayDiagnostic: boolean
  response: ModelDiagnosticResult | null
  releaseSaves: () => void
  releaseDiagnostics: () => void
}
declare global {
  interface Window {
    modelTest: ModelTestFixture
  }
}

async function openSettings(page: Page, secureStorageAvailable = true, locked = false) {
  await page.addInitScript(
    ({ secureStorageAvailable, locked }) => {
      const fixture: ModelTestFixture = {
        state: {
          revision: 1,
          secureStorageAvailable,
          profiles: [
            {
              profileId: 'parent',
              profileName: '正式审阅',
              protocol: 'openai-chat',
              baseUrl: 'https://parent.example/v1',
              model: 'parent-model',
              revision: 1,
              configured: !locked,
              keyStatus: locked ? 'locked' : 'session',
            },
            {
              profileId: 'child',
              profileName: '快速提示',
              protocol: 'anthropic',
              baseUrl: 'https://child.example/v1',
              model: 'child-model',
              revision: 1,
              configured: true,
              keyStatus: 'saved',
            },
          ],
          roles: { parent: 'parent', child: 'child' },
        },
        saves: [],
        diagnostics: [],
        canceled: [],
        delaySave: false,
        delayDiagnostic: false,
        response: null,
        releaseSaves: () => {},
        releaseDiagnostics: () => {},
      }
      const pendingSaves: (() => void)[] = []
      const pendingDiagnostics: (() => void)[] = []
      fixture.releaseSaves = () => {
        pendingSaves.splice(0).forEach((resolve) => resolve())
      }
      fixture.releaseDiagnostics = () => {
        pendingDiagnostics.splice(0).forEach((resolve) => resolve())
      }
      window.modelTest = fixture
      const snapshot = () => structuredClone(fixture.state)
      const bump = () => {
        fixture.state.revision += 1
        fixture.state.profiles.forEach((profile) => {
          profile.revision = fixture.state.revision
        })
      }
      const api: Partial<ExamCraftApi> = {
        getModelProfiles: async () => snapshot(),
        getModelConsents: async () => ({ version: 1, revision: 0, grants: [] }),
        getModelConfig: async (role = 'parent') =>
          structuredClone(
            fixture.state.profiles.find(
              (profile) => profile.profileId === fixture.state.roles[role],
            )!,
          ),
        saveModelProfile: async (input) => {
          fixture.saves.push(structuredClone(input))
          if (input.expectedRevision !== fixture.state.revision) throw new Error('Stale revision')
          const existing = fixture.state.profiles.find((item) => item.profileId === input.profileId)
          const destinationChanged =
            existing && (existing.protocol !== input.protocol || existing.baseUrl !== input.baseUrl)
          const profile = {
            profileId: existing?.profileId ?? `profile-${fixture.state.profiles.length + 1}`,
            profileName: input.profileName,
            protocol: input.protocol,
            baseUrl: input.baseUrl,
            model: input.model,
            revision: fixture.state.revision,
            configured:
              Boolean(input.apiKey) ||
              Boolean(!input.clearApiKey && !destinationChanged && existing?.configured),
            keyStatus: input.apiKey
              ? input.persistApiKey
                ? ('saved' as const)
                : ('session' as const)
              : input.clearApiKey || destinationChanged
                ? ('missing' as const)
                : (existing?.keyStatus ?? ('missing' as const)),
          }
          if (existing)
            fixture.state.profiles.splice(fixture.state.profiles.indexOf(existing), 1, profile)
          else fixture.state.profiles.push(profile)
          bump()
          const next = snapshot()
          if (fixture.delaySave) await new Promise<void>((resolve) => pendingSaves.push(resolve))
          return next
        },
        assignModelProfiles: async (input) => {
          fixture.state.roles = structuredClone(input.roles)
          bump()
          return snapshot()
        },
        deleteModelProfile: async (input) => {
          fixture.state.profiles = fixture.state.profiles.filter(
            (item) => item.profileId !== input.profileId,
          )
          for (const role of ['parent', 'child'] as const) {
            if (fixture.state.roles[role] === input.profileId)
              fixture.state.roles[role] = fixture.state.profiles[0].profileId
          }
          bump()
          return snapshot()
        },
        diagnoseModel: async (input) => {
          fixture.diagnostics.push(structuredClone(input))
          const response =
            fixture.response ??
            (input.kind === 'list'
              ? {
                  models: [
                    { id: 'model-small', name: 'Small' },
                    { id: 'model-large', name: 'Large' },
                  ],
                }
              : { latencyMs: 24 })
          if (fixture.delayDiagnostic)
            await new Promise<void>((resolve) => pendingDiagnostics.push(resolve))
          return response
        },
        cancelModelDiagnostic: async (requestId) => {
          fixture.canceled.push(requestId)
        },
        listQuestions: async () => [
          {
            id: 'chinese-q1',
            subject: 'chinese',
            kind: 'chinese',
            title: '阅读与表达',
            prompt: '请分析材料中的因果联系。',
            source: 'Synthetic browser fixture',
            tags: [],
            maxScore: 10,
          },
        ],
        loadState: async () => ({ version: 1, drafts: {}, attempts: [] }),
        getCapabilities: async () => ({
          questionBank: 'Browser fixture',
          reviewer: 'Local fixture',
          mcp: 'Fixture',
        }),
        getGitHubProfile: async () => null,
        listKnowledgeDocuments: async () => [],
        getGenerationStatus: async () => ({ used: 0, pending: 0, limit: 5 }),
        saveDraft: async () => {},
        cancelAdvisor: async () => {},
        cancelModuleReview: async () => {},
        cancelQuestionGeneration: async () => {},
      }
      window.examcraft = api as ExamCraftApi
    },
    { secureStorageAvailable, locked },
  )
  await page.goto('/')
  await expect(page.locator('#answer-text')).toBeVisible()
  await page.getByRole('button', { name: '配置模型 / 协议', exact: true }).click()
  await expect(page.getByRole('region', { name: '模型设置', exact: true })).toBeVisible()
}
const settings = (page: Page) => page.getByRole('region', { name: '模型设置', exact: true })
const save = (page: Page) =>
  settings(page).getByRole('button', { name: '保存模型设置', exact: true })
const key = (page: Page) => settings(page).locator('input[type=password]')
async function discard(page: Page) {
  await page
    .getByRole('dialog', { name: '放弃未保存的编辑？' })
    .getByRole('button', { name: '放弃更改并继续' })
    .click()
}

test('named profiles keep keys masked and require explicit encrypted persistence; blank input preserves saved key', async ({
  page,
}) => {
  await openSettings(page)
  const form = settings(page)
  expect(await page.evaluate(() => window.modelTest.diagnostics)).toHaveLength(0)
  await expect(form.getByRole('checkbox', { name: /使用操作系统加密/ })).not.toBeChecked()
  await key(page).fill('synthetic-session-key')
  await expect(key(page)).toHaveAttribute('type', 'password')
  await save(page).click()
  await expect(form.getByRole('status')).toContainText('密钥仅在本次应用会话中使用')
  await expect(key(page)).toHaveValue('')
  expect((await page.evaluate(() => window.modelTest.saves))[0].persistApiKey).toBe(false)
  await form.getByRole('button', { name: '新建配置' }).click()
  await form.getByLabel('配置名称', { exact: true }).fill('长期模型')
  await key(page).fill('synthetic-encrypted-key')
  await form.getByRole('checkbox', { name: /使用操作系统加密/ }).check()
  await save(page).click()
  await expect(form.getByRole('status')).toContainText('密钥已通过操作系统加密保存在本机')
  await expect(key(page)).toHaveValue('')
  await expect(form.getByRole('checkbox', { name: /使用操作系统加密/ })).not.toBeChecked()
  await form.getByLabel('模型名称', { exact: true }).fill('manual-new-model')
  await save(page).click()
  const calls = await page.evaluate(() => window.modelTest.saves)
  expect(calls[1]).toMatchObject({ profileName: '长期模型', persistApiKey: true })
  expect(calls[2].apiKey).toBeUndefined()
  await expect(form.locator('.model-key-status')).toContainText('已加密保存')
  expect(
    await page.evaluate(() =>
      JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
    ),
  ).not.toContain('synthetic-')
  await page.screenshot({ path: 'test-results/model-profiles-browser.png', fullPage: true })
})

test('unavailable secure storage offers session-only input and shows locked status without a reveal control', async ({
  page,
}) => {
  await openSettings(page, false, true)
  await expect(settings(page).getByRole('checkbox', { name: /使用操作系统加密/ })).toBeDisabled()
  await expect(settings(page).getByText(/不会降级为明文保存/)).toBeVisible()
  await expect(settings(page).locator('.model-key-status')).toContainText('暂不可读取')
  await expect(
    settings(page).getByRole('button', { name: /显示密钥|查看密钥|reveal/i }),
  ).toHaveCount(0)
  await key(page).fill('synthetic-session-only')
  await save(page).click()
  await expect(settings(page).getByRole('status')).toContainText('仅在本次应用会话')
  await expect(key(page)).toHaveValue('')
})

test('role edits survive metadata save; assigning and deleting updates actual role destinations', async ({
  page,
}) => {
  await openSettings(page)
  const form = settings(page)
  await form.getByLabel('父 Agent 模型', { exact: true }).selectOption('child')
  await form.getByLabel('配置名称', { exact: true }).fill('正式审阅 2')
  await save(page).click()
  await expect(form.getByLabel('父 Agent 模型', { exact: true })).toHaveValue('child')
  await form.getByRole('button', { name: '保存角色分配' }).click()
  await expect(form.getByRole('status')).toContainText('角色分配已保存')
  await page.getByRole('button', { name: /题目练习 Practice/ }).click()
  await page.getByRole('radio', { name: /自定义模型/ }).check()
  await expect(page.locator('.cloud-review-options')).toContainText('https://child.example/v1')
  await page.locator('#answer-text').fill('这是需要提示的选择片段。')
  await page.locator('#answer-text').evaluate((element) => {
    const input = element as HTMLTextAreaElement
    input.focus()
    input.setSelectionRange(0, input.value.length)
    input.dispatchEvent(new Event('select', { bubbles: true }))
  })
  await page.locator('.advisor-selection-action').click()
  await expect(page.getByRole('dialog', { name: 'Ask Advisor · 思路提示' })).toContainText(
    'https://child.example/v1',
  )
  await page.getByRole('button', { name: '关闭 Advisor' }).click()
  await page.getByRole('button', { name: '配置模型 / 协议', exact: true }).click()
  await form.getByLabel('当前编辑配置').selectOption('child')
  await form.getByRole('button', { name: '删除配置', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '删除配置「快速提示」？' })
  await expect(dialog).toContainText('正式审阅 2')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await form.getByRole('button', { name: '删除配置', exact: true }).click()
  await page.getByRole('button', { name: '确认删除配置', exact: true }).click()
  await expect(form.getByLabel('父 Agent 模型', { exact: true })).toHaveValue('parent')
  await expect(form.getByLabel('子 Agent 模型', { exact: true })).toHaveValue('parent')
  await expect(form.getByRole('button', { name: '删除配置', exact: true })).toBeDisabled()
})

test('dirty navigation can be canceled, discarding clears secrets, and refresh hydrates latest metadata', async ({
  page,
}) => {
  await openSettings(page)
  const form = settings(page)
  await key(page).fill('synthetic-discarded-key')
  await form.getByLabel('当前编辑配置').selectOption('child')
  await page.getByRole('button', { name: '继续编辑', exact: true }).click()
  await expect(key(page)).toHaveValue('synthetic-discarded-key')
  await form.getByLabel('当前编辑配置').selectOption('child')
  await discard(page)
  await expect(key(page)).toHaveValue('')
  await expect(form.getByLabel('模型名称', { exact: true })).toHaveValue('child-model')
  await key(page).fill('synthetic-destination-key')
  await form.getByLabel('接口基础地址', { exact: true }).fill('https://changed.example/v1')
  await expect(key(page)).toHaveValue('')
  await page.evaluate(() => {
    window.modelTest.state.profiles[1].model = 'new-server-model'
    window.modelTest.state.revision += 1
  })
  await form.getByRole('button', { name: '重新读取配置', exact: true }).click()
  await discard(page)
  await expect(form.getByLabel('模型名称', { exact: true })).toHaveValue('new-server-model')
  await expect(form.getByLabel('接口基础地址', { exact: true })).toHaveValue(
    'https://child.example/v1',
  )
  await key(page).fill('synthetic-navigation-key')
  await page.getByRole('button', { name: /题目练习 Practice/ }).click()
  await discard(page)
  await page.getByRole('button', { name: '配置模型 / 协议', exact: true }).click()
  await expect(key(page)).toHaveValue('')
})

test('diagnostics are explicit, searchable, bounded by edits/cancel/unmount, and repeated clicks do not duplicate requests', async ({
  page,
}) => {
  await openSettings(page)
  const form = settings(page)
  await form.getByLabel('模型名称', { exact: true }).fill('')
  await form.getByRole('button', { name: '获取模型', exact: true }).click()
  await expect(form.getByText(/已获取 2 个模型/)).toBeVisible()
  await form.getByLabel('搜索服务商模型').fill('large')
  await expect(form.getByLabel('选择获取的模型').locator('option')).toHaveCount(2)
  await form.getByLabel('选择获取的模型').selectOption('model-large')
  await expect(form.getByLabel('模型名称', { exact: true })).toHaveValue('model-large')
  await expect(form.getByText(/可能产生少量 API 费用/)).toBeVisible()
  await form.getByRole('button', { name: '测试 API 连接', exact: true }).click()
  await expect(form.getByText(/连接测试成功 · 24 ms/)).toBeVisible()
  await page.evaluate(() => {
    window.modelTest.delayDiagnostic = true
  })
  await form.getByRole('button', { name: '获取模型', exact: true }).evaluate((button) => {
    ;(button as HTMLButtonElement).click()
    ;(button as HTMLButtonElement).click()
  })
  await expect(form.getByRole('button', { name: '取消诊断' })).toBeVisible()
  expect(await page.evaluate(() => window.modelTest.diagnostics.length)).toBe(3)
  await form.getByLabel('模型名称', { exact: true }).fill('new-manual-model')
  await page.evaluate(() => window.modelTest.releaseDiagnostics())
  await expect(form.getByLabel('选择获取的模型')).toHaveCount(0)
  expect(await page.evaluate(() => window.modelTest.canceled.length)).toBe(1)
  await form.getByRole('button', { name: '测试 API 连接', exact: true }).click()
  await form.getByRole('button', { name: '取消诊断' }).click()
  await page.evaluate(() => window.modelTest.releaseDiagnostics())
  await expect(form.getByText('已取消诊断。', { exact: true })).toBeVisible()
  await form.getByRole('button', { name: '测试 API 连接', exact: true }).click()
  await page.getByRole('button', { name: /题目练习 Practice/ }).click()
  await discard(page)
  await page.evaluate(() => window.modelTest.releaseDiagnostics())
  await expect(page.getByText(/连接测试成功/)).toHaveCount(0)
  expect(await page.evaluate(() => window.modelTest.canceled.length)).toBe(3)
})

test('diagnostic errors use fixed categories and do not render arbitrary returned messages', async ({
  page,
}) => {
  await openSettings(page)
  for (const [code, expected] of [
    ['auth', '身份验证失败'],
    ['model', '服务不接受当前模型'],
    ['rate_limit', '请求受限或额度不足'],
    ['timeout', '模型请求超时'],
    ['network', '无法连接模型服务'],
  ]) {
    await page.evaluate((code) => {
      window.modelTest.response = { error: { code, message: 'DO_NOT_RENDER_PROVIDER_SECRET' } }
    }, code)
    await settings(page).getByRole('button', { name: '测试 API 连接', exact: true }).click()
    await expect(settings(page).getByText(new RegExp(expected))).toBeVisible()
    await expect(page.getByText('DO_NOT_RENDER_PROVIDER_SECRET')).toHaveCount(0)
  }
})

test('late saves cannot overwrite newer profile navigation and double submit is guarded', async ({
  page,
}) => {
  await openSettings(page)
  const form = settings(page)
  await form.getByLabel('配置名称', { exact: true }).fill('Delayed saved parent')
  await key(page).fill('synthetic-delayed-key')
  await page.evaluate(() => {
    window.modelTest.delaySave = true
  })
  await save(page).evaluate((button) => {
    ;(button as HTMLButtonElement).click()
    ;(button as HTMLButtonElement).click()
  })
  await expect(form.getByRole('button', { name: '保存中…' })).toBeDisabled()
  expect(await page.evaluate(() => window.modelTest.saves.length)).toBe(1)
  await expect(key(page)).toHaveValue('')
  await form.getByLabel('当前编辑配置').selectOption('child')
  await discard(page)
  await page.evaluate(() => window.modelTest.releaseSaves())
  await expect(form.getByLabel('当前编辑配置')).toHaveValue('child')
  await expect(form.getByLabel('模型名称', { exact: true })).toHaveValue('child-model')
  await expect(key(page)).toHaveValue('')
  await form.getByLabel('配置名称', { exact: true }).fill('Delayed saved child')
  await save(page).click()
  await page.getByRole('button', { name: /题目练习 Practice/ }).click()
  await discard(page)
  await page.evaluate(() => window.modelTest.releaseSaves())
  await page.getByRole('button', { name: '配置模型 / 协议', exact: true }).click()
  await form.getByLabel('当前编辑配置').selectOption('child')
  await expect(form.getByLabel('配置名称', { exact: true })).toHaveValue('Delayed saved child')
})
