import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let app: ElectronApplication | undefined
let userData: string
async function launch() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  env.EXAMCRAFT_USER_DATA = userData
  delete env.ELECTRON_RUN_AS_NODE
  delete env.EXAMCRAFT_DEV_URL
  app = await electron.launch({ args: ['.'], env })
  const page = await app.firstWindow()
  await expect(page.getByRole('heading', { name: '今天，理解得更深一点。' })).toBeVisible()
  return page
}
test.beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'examcraft-agent-context-'))
})
test.afterEach(async () => {
  await app?.close()
  app = undefined
  await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

test('native study to Agent preserves fallback question, saved draft and explicit snapshot choice', async () => {
  let page = await launch()
  await page.getByRole('button', { name: '数学工作台 Math lab', exact: true }).click()
  const title = await page.locator('.question-prompt h2').innerText()
  const id = await page.locator('.question-id').innerText()
  await page.locator('#answer-text').fill('数学工作台中的独立草稿')
  await expect(page.getByRole('status').filter({ hasText: '已保存到本机' })).toBeVisible()
  await page.getByRole('button', { name: 'Agent 工作台 Bounded tools', exact: true }).click()
  await expect(page.getByRole('combobox', { name: '学科', exact: true })).toHaveValue('math')
  await expect(page.locator('.agent-scope-summary')).toContainText(title)
  const snapshot = page.getByRole('checkbox', { name: '附带当前答卷快照', exact: false })
  await expect(snapshot).toBeEnabled()
  await expect(snapshot).not.toBeChecked()
  await page.getByRole('combobox', { name: '工作模式', exact: true }).selectOption('create')
  await snapshot.check()
  await page.getByRole('button', { name: '数学工作台 Math lab', exact: true }).click()
  await expect(page.locator('.question-id')).toHaveText(id)
  await expect(page.locator('#answer-text')).toHaveValue('数学工作台中的独立草稿')
  await page.getByRole('button', { name: 'Agent 工作台 Bounded tools', exact: true }).click()
  await expect(snapshot).not.toBeChecked()
  await app!.close()
  app = undefined
  page = await launch()
  await page.getByRole('button', { name: '数学工作台 Math lab', exact: true }).click()
  await expect(page.locator('.question-id')).toHaveText(id)
  await expect(page.locator('#answer-text')).toHaveValue('数学工作台中的独立草稿')
})

test('native empty search never reintroduces an unseen question into Agent', async () => {
  const page = await launch()
  await page.getByRole('textbox', { name: '搜索题目', exact: true }).fill('不存在的题目 943a')
  await expect(page.locator('.question-prompt')).toHaveCount(0)
  await page.getByRole('button', { name: 'Agent 工作台 Bounded tools', exact: true }).click()
  await expect(
    page.getByRole('checkbox', { name: '附带当前答卷快照', exact: false }),
  ).toBeDisabled()
  await expect(page.locator('#agent-answer-unavailable')).toContainText('当前没有选中的题目')
  await page.getByRole('button', { name: '题目练习 Practice', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '搜索题目', exact: true })).toHaveValue(
    '不存在的题目 943a',
  )
  await expect(page.locator('.question-prompt')).toHaveCount(0)
  await page.getByRole('button', { name: '清除筛选', exact: true }).click()
  await expect(page.locator('.question-prompt')).toBeVisible()
})

test('history restore clears old study filters and review tab before practice and Agent', async () => {
  const page = await launch()
  await page.getByLabel('按学科筛选').getByRole('button', { name: '历史', exact: true }).click()
  await page.locator('.question-item').filter({ hasText: '从两则记录认识交通变化' }).click()
  await page.locator('#answer-text').fill('要恢复的史料解释')
  await expect(page.getByRole('status').filter({ hasText: '已保存到本机' })).toBeVisible()
  await page.locator('#answer-text').fill('新的历史草稿')
  await expect(page.getByRole('status').filter({ hasText: '已保存到本机' })).toBeVisible()
  // Typing only saves the draft; a real submission creates the next checkpoint.
  // The earlier baseline must no longer be the head before its Restore action exists.
  await page.getByRole('button', { name: '提交并审阅' }).click()
  await expect(page.getByRole('tab', { name: '审阅反馈', exact: false })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  const restoredScope = await page.evaluate(async () => {
    const graph = await window.examcraft!.getLearningGraph()
    const snapshot = graph.snapshots.find((item) => item.draft.text === '要恢复的史料解释')!
    return {
      snapshotId: snapshot.id,
      headId: graph.heads[`${snapshot.subject}:${snapshot.questionId}`],
    }
  })
  expect(restoredScope.snapshotId).not.toBe(restoredScope.headId)
  await page.getByLabel('按学科筛选').getByRole('button', { name: '数学', exact: true }).click()
  const mathTitle = await page.locator('.question-prompt h2').innerText()
  await page.getByRole('textbox', { name: '搜索题目', exact: true }).fill(mathTitle)
  await page.getByRole('radio').first().click()
  await page.getByRole('button', { name: '提交并审阅' }).click()
  await expect(page.getByRole('tab', { name: '审阅反馈', exact: false })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await page.getByRole('button', { name: '练习记录 Review & reflect', exact: true }).click()
  await page
    .locator(`[data-snapshot-id="${restoredScope.snapshotId}"]`)
    .getByRole('button', { name: '恢复此快照为新分支' })
    .click()
  await expect(page.getByRole('status').filter({ hasText: '已恢复为新的作答分支' })).toBeVisible()
  await page.getByRole('button', { name: '题目练习 Practice', exact: true }).click()
  await expect(page.locator('.question-prompt h2')).toHaveText('从两则记录认识交通变化')
  await expect(page.locator('#answer-text')).toHaveValue('要恢复的史料解释')
  await expect(page.getByRole('tab', { name: '我的作答', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(page.getByRole('textbox', { name: '搜索题目', exact: true })).toHaveValue('')
  await page.getByRole('button', { name: 'Agent 工作台 Bounded tools', exact: true }).click()
  await expect(page.getByRole('combobox', { name: '学科', exact: true })).toHaveValue('history')
  await expect(page.locator('.agent-scope-summary')).toContainText('从两则记录认识交通变化')
})
