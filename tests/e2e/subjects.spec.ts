import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let app: ElectronApplication | undefined
let userData: string
async function launch() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
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
  userData = await mkdtemp(join(tmpdir(), 'examcraft-subject-e2e-'))
})
test.afterEach(async () => {
  await app?.close()
  app = undefined
  await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

for (const item of [
  {
    label: '语文',
    title: '旧书摊前的停留',
    answerLabel: '阅读分析 / 表达作答',
    text: '车流与纸页的沙沙声形成对比，表现专注的变化。',
  },
  {
    label: '数学',
    title: '解一元一次方程',
    answerLabel: '解题步骤与结论',
    text: '3x - 6 = 2x + 5，所以 x = 11。代回两边均为27。',
  },
  {
    label: '英语',
    title: 'A library experiment',
    answerLabel: 'English answer / 英语作答',
    text: 'More students stopped to browse, but books borrowed did not increase. The librarian wanted to learn what they wanted.',
  },
  {
    label: '历史',
    title: '从两则记录认识交通变化',
    answerLabel: '史料依据与历史解释',
    text: '铁路投入使用，运输效率可能提高；但不能据此确定所有居民都受益。',
  },
]) {
  test(`${item.label}: filter, draft isolation, submit, retry, history and restart`, async () => {
    let page = await launch()
    const filters = page.getByLabel('按学科筛选')
    await expect(filters.getByRole('button')).toHaveCount(7)
    await filters.getByRole('button', { name: item.label, exact: true }).click()
    await expect(page.locator('.question-item')).toHaveCount(3)
    await page.locator('.question-item').filter({ hasText: item.title }).click()
    await expect(page.locator('.explanation')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '提交并审阅' })).toBeDisabled()
    await page.getByLabel(item.answerLabel).fill(item.text)
    await expect(page.getByRole('status').filter({ hasText: '已保存到本机' })).toBeVisible()
    if (item.label === '英语') await expect(page.getByText(/词数参考：\d+ words/)).toBeVisible()
    await page.getByLabel('按学科筛选').getByRole('button', { name: '政治', exact: true }).click()
    await expect(page.getByLabel('思考笔记')).toHaveValue('')
    await page
      .getByLabel('按学科筛选')
      .getByRole('button', { name: item.label, exact: true })
      .click()
    await page.locator('.question-item').filter({ hasText: item.title }).click()
    await expect(page.getByLabel(item.answerLabel)).toHaveValue(item.text)
    await page.getByRole('button', { name: '提交并审阅' }).click()
    await expect(page.getByLabel('审阅结果').locator('.score')).toHaveText('6 / 6')
    await expect(page.getByText(/不代表考试阅卷分数/)).toBeVisible()
    await page.getByRole('button', { name: '重新练习' }).click()
    await expect(page.getByLabel(item.answerLabel)).toHaveValue('')
    await page.getByLabel(item.answerLabel).fill('第二份草稿尚未提交')
    await expect(page.getByRole('status').filter({ hasText: '已保存到本机' })).toBeVisible()
    await app!.close()
    app = undefined
    page = await launch()
    await page
      .getByLabel('按学科筛选')
      .getByRole('button', { name: item.label, exact: true })
      .click()
    await page.locator('.question-item').filter({ hasText: item.title }).click()
    await expect(page.getByLabel(item.answerLabel)).toHaveValue('第二份草稿尚未提交')
    await page.getByRole('button', { name: /练习记录 Review/ }).click()
    await expect(page.locator('.history-item')).toHaveCount(1)
    await page.locator('.history-item').click()
    await page.getByText(/查看本次提交的答案/).click()
    await expect(page.getByText(item.text, { exact: true })).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
  })
}
