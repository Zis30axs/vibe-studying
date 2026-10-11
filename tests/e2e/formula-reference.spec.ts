import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FORMULA_ENTRIES } from '../../src/domain/formula-catalog'

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
  userData = await mkdtemp(join(tmpdir(), 'examcraft-formula-e2e-'))
})
test.afterEach(async () => {
  await app?.close()
  app = undefined
  await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

test('offline formula lookup preserves answer and study filters; favorites survive app restart', async () => {
  let page = await launch()
  await page.getByLabel('按学科筛选').getByRole('button', { name: '数学', exact: true }).click()
  await page.locator('.question-item').filter({ hasText: '解一元一次方程' }).click()
  const originalAnswer = '公式速查前的未提交草稿，保留原文与计算步骤。'
  await page.getByLabel('解题步骤与结论').fill(originalAnswer)
  await expect(page.getByRole('status').filter({ hasText: '已保存到本机' })).toBeVisible()
  await page.getByRole('button', { name: /公式速查 Formula/ }).click()
  const formula = FORMULA_ENTRIES.find((entry) => entry.subject === 'math')!
  let reader = page.getByRole('region', { name: '公式速查', exact: true })
  await reader.getByRole('searchbox', { name: '搜索公式' }).fill(formula.id)
  await expect(reader.getByRole('heading', { name: formula.title, exact: true })).toBeVisible()
  await expect(reader.getByLabel('公式表达式')).toHaveText(formula.expression)
  await reader.getByRole('button', { name: `收藏：${formula.title}`, exact: true }).click()
  await expect(
    reader.getByRole('button', { name: `取消收藏：${formula.title}`, exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: /题目练习 Practice/ }).click()
  await expect(page.getByLabel('解题步骤与结论')).toHaveValue(originalAnswer)
  await expect(page.locator('.question-item')).toHaveCount(3)
  await page.getByRole('button', { name: /公式速查 Formula/ }).click()
  await expect(reader.getByRole('searchbox', { name: '搜索公式' })).toHaveValue(formula.id)
  await expect(reader.getByRole('heading', { name: formula.title, exact: true })).toBeVisible()
  await app!.close()
  app = undefined
  page = await launch()
  await page.getByRole('button', { name: /公式速查 Formula/ }).click()
  reader = page.getByRole('region', { name: '公式速查', exact: true })
  await reader.getByRole('button', { name: /只看收藏/ }).click()
  await expect(reader.getByRole('heading', { name: formula.title, exact: true })).toBeVisible()
  await expect(
    reader.getByRole('navigation', { name: '公式列表' }).getByRole('button'),
  ).toHaveCount(1)
  await reader.getByRole('button', { name: `取消收藏：${formula.title}`, exact: true }).click()
  await expect(reader.getByRole('heading', { name: '还没有收藏的公式' })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
})
