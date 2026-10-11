import { expect, test, type Page } from '@playwright/test'
import type { AnswerDraft, ExamCraftApi, StudyState } from '../../src/shared/types'
import { FORMULA_ENTRIES } from '../../src/domain/formula-catalog'
import { FORMULA_FAVORITES_STORAGE_KEY } from '../../src/domain/formula-reference'

declare global {
  interface Window {
    formulaFixture: { saves: AnswerDraft[]; mathNode?: Element | null }
  }
}
const reference = (page: Page) => page.getByRole('region', { name: '公式速查', exact: true })
const detail = (page: Page) => reference(page).locator('#formula-detail')
const search = (page: Page) => reference(page).getByRole('searchbox', { name: '搜索公式' })
const vector = FORMULA_ENTRIES.find((entry) => entry.id === 'math.vector.dot')!
const scale = FORMULA_ENTRIES.find((entry) => entry.id === 'geo.scale.distance')!
async function enterReference(page: Page) {
  await page.getByRole('button', { name: '公式速查 Formula reference', exact: true }).click()
  await expect(reference(page)).toBeVisible()
}
async function openWorkspace(page: Page) {
  await page.addInitScript(() => {
    const state: StudyState = JSON.parse(
      sessionStorage.getItem('formula-study-fixture') || '{"version":1,"drafts":{},"attempts":[]}',
    )
    window.formulaFixture = { saves: [] }
    const api: Partial<ExamCraftApi> = {
      listQuestions: async () => [
        {
          id: 'formula-math',
          subject: 'math',
          kind: 'math',
          title: '函数与思路',
          prompt: '观察函数并说明理由。',
          source: 'Synthetic formula fixture',
          tags: [],
          maxScore: 10,
        },
        {
          id: 'formula-geography',
          subject: 'geography',
          kind: 'geography',
          title: '地理与距离',
          prompt: '根据比例尺计算距离。',
          source: 'Synthetic formula fixture',
          tags: [],
          maxScore: 10,
        },
      ],
      loadState: async () => structuredClone(state),
      getCapabilities: async () => ({
        questionBank: 'fixture',
        reviewer: 'fixture',
        mcp: 'fixture',
      }),
      getModelProfiles: async () => ({
        revision: 1,
        secureStorageAvailable: false,
        profiles: [],
        roles: { parent: '', child: '' },
      }),
      getModelConsents: async () => ({ version: 1, revision: 0, grants: [] }),
      getGitHubProfile: async () => null,
      listKnowledgeDocuments: async () => [],
      getGenerationStatus: async () => ({ used: 0, pending: 0, limit: 5 }),
      saveDraft: async (id, draft) => {
        state.drafts[id] = structuredClone(draft)
        window.formulaFixture.saves.push(structuredClone(draft))
        sessionStorage.setItem('formula-study-fixture', JSON.stringify(state))
      },
      cancelAdvisor: async () => {},
      cancelModuleReview: async () => {},
      cancelQuestionGeneration: async () => {},
    }
    window.examcraft = api as ExamCraftApi
  })
  await page.goto('/')
  await expect(page.locator('#answer-text')).toBeVisible()
}

async function openMath(page: Page) {
  await page.getByRole('button', { name: '数学工作台 Math lab', exact: true }).click()
  if (await page.locator('#tools-panel').isHidden())
    await page.getByRole('button', { name: '工具与顾问', exact: true }).click()
  await expect(page.locator('#tools-panel').getByLabel('函数表达式')).toBeEnabled()
}

test('offline search, subject/chapter filters, no-match recovery and help are usable', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await openWorkspace(page)
  await enterReference(page)
  await search(page).fill('ｍａｔｈ 点积')
  await reference(page)
    .getByRole('navigation', { name: '公式列表' })
    .getByRole('button')
    .filter({ hasText: vector.title })
    .click()
  await expect(detail(page).getByRole('heading', { name: vector.title, exact: true })).toBeVisible()
  await expect(detail(page)).toContainText('适用条件')
  await expect(detail(page)).toContainText('易错提醒')
  await expect(detail(page)).toContainText('小例题')
  await expect(detail(page)).toContainText(vector.id)
  await search(page).fill('')
  await reference(page).getByLabel('学科', { exact: true }).selectOption('geography')
  await reference(page).getByLabel('章节', { exact: true }).selectOption(scale.chapter)
  await search(page).fill('比例尺')
  await reference(page)
    .getByRole('navigation', { name: '公式列表' })
    .getByRole('button')
    .filter({ hasText: scale.title })
    .click()
  await expect(detail(page).getByRole('heading', { name: scale.title, exact: true })).toBeVisible()
  await reference(page).getByLabel('学科', { exact: true }).selectOption('math')
  await expect(reference(page).getByLabel('章节', { exact: true })).toHaveValue('')
  await expect(reference(page).getByText('没有找到匹配的公式', { exact: true })).toBeVisible()
  await reference(page).getByRole('button', { name: '浏览全部公式', exact: true }).click()
  await expect(search(page)).toHaveValue('')
  await expect(reference(page).getByLabel('学科', { exact: true })).toHaveValue('all')
  await search(page).fill('不存在的公式 abcdefg')
  await expect(reference(page).getByText('没有找到匹配的公式', { exact: true })).toBeVisible()
  await reference(page).getByRole('button', { name: '清除筛选', exact: true }).click()
  await reference(page).getByText('如何使用公式速查', { exact: true }).click()
  await expect(
    reference(page).getByText(/收藏只保存在当前设备；切换页面会保留本次搜索和选择/),
  ).toBeVisible()
  expect(errors).toEqual([])
})

test('favorite changes survive reload, and empty favorites have a clear recovery path', async ({
  page,
}) => {
  await openWorkspace(page)
  await enterReference(page)
  await reference(page)
    .getByRole('button', { name: /只看收藏/ })
    .click()
  await expect(reference(page).getByText('还没有收藏的公式', { exact: true })).toBeVisible()
  await reference(page).getByRole('button', { name: '浏览全部公式', exact: true }).click()
  await search(page).fill(vector.id)
  await detail(page)
    .getByRole('button', { name: `收藏：${vector.title}`, exact: true })
    .click()
  await expect(
    detail(page).getByRole('button', { name: `取消收藏：${vector.title}`, exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
  const stored = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!),
    FORMULA_FAVORITES_STORAGE_KEY,
  )
  expect(stored.version).toBe(1)
  expect(stored.ids).toEqual([vector.id])
  await page.reload()
  await expect(page.locator('#answer-text')).toBeVisible()
  await enterReference(page)
  await reference(page)
    .getByRole('button', { name: /只看收藏/ })
    .click()
  await expect(
    reference(page).getByRole('navigation', { name: '公式列表' }).getByRole('button'),
  ).toHaveCount(1)
  await expect(detail(page).getByRole('heading', { name: vector.title, exact: true })).toBeVisible()
  await detail(page)
    .getByRole('button', { name: `取消收藏：${vector.title}`, exact: true })
    .click()
  await expect(reference(page).getByText('还没有收藏的公式', { exact: true })).toBeVisible()
})

test('formula roundtrip preserves study filters, answer, mounted math work and unapplied expression', async ({
  page,
}) => {
  await openWorkspace(page)
  await openMath(page)
  await page.getByRole('textbox', { name: '搜索题目', exact: true }).fill('函数')
  await page.locator('#answer-text').fill('这份答案不应被速查修改。')
  const expression = page.locator('#tools-panel').getByLabel('函数表达式')
  await expression.fill('2(x+1)')
  // Deliberately do not apply: this component-local edit and its DOM must survive the lookup.
  await page.evaluate(() => {
    window.formulaFixture.mathNode = document.querySelector('#tools-panel .math-workbench')
  })
  const before = await page.evaluate(() => window.formulaFixture.saves.length)
  await enterReference(page)
  await expect(page.getByRole('region', { name: '学习工作台', exact: true })).toBeHidden()
  await search(page).fill('数学')
  await reference(page).getByLabel('章节', { exact: true }).selectOption(vector.chapter)
  await reference(page)
    .getByRole('navigation', { name: '公式列表' })
    .getByRole('button')
    .filter({ hasText: vector.title })
    .click()
  await detail(page)
    .getByRole('button', { name: `收藏：${vector.title}`, exact: true })
    .click()
  await page.getByRole('button', { name: '数学工作台 Math lab', exact: true }).click()
  await expect(page.locator('#answer-text')).toHaveValue('这份答案不应被速查修改。')
  await expect(page.getByRole('textbox', { name: '搜索题目', exact: true })).toHaveValue('函数')
  await expect(expression).toHaveValue('2(x+1)')
  expect(
    await page.evaluate(
      () =>
        window.formulaFixture.mathNode === document.querySelector('#tools-panel .math-workbench'),
    ),
  ).toBe(true)
  expect(await page.evaluate(() => window.formulaFixture.saves.length)).toBe(before)
  await enterReference(page)
  await expect(search(page)).toHaveValue('数学')
  await expect(reference(page).getByLabel('章节', { exact: true })).toHaveValue(vector.chapter)
  await expect(detail(page).getByRole('heading', { name: vector.title, exact: true })).toBeVisible()
  await expect(
    detail(page).getByRole('button', { name: `取消收藏：${vector.title}`, exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
  // A different destination follows ordinary navigation and clears the math-only query.
  await page.getByRole('button', { name: '地理工作台 Geo canvas', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '搜索题目', exact: true })).toHaveValue('')
  await expect(page.locator('#answer-text')).toBeVisible()
  await expect(page.getByText('地理与距离', { exact: true }).first()).toBeVisible()
})

test('legacy favorites migrate and corrupt data recovers without crashing', async ({ page }) => {
  await page.addInitScript(
    ({ key, id }) => {
      if (!sessionStorage.getItem('formula-seeded')) {
        localStorage.setItem(key, JSON.stringify([id, id, 'unknown-id']))
        sessionStorage.setItem('formula-seeded', 'yes')
      }
    },
    { key: FORMULA_FAVORITES_STORAGE_KEY, id: vector.id },
  )
  await openWorkspace(page)
  await enterReference(page)
  await expect(reference(page).getByRole('button', { name: /只看收藏（1）/ })).toBeVisible()
  const stored = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!),
    FORMULA_FAVORITES_STORAGE_KEY,
  )
  expect(stored).toMatchObject({ version: 1, ids: [vector.id] })
  await page.evaluate(
    (key) => localStorage.setItem(key, '{broken json'),
    FORMULA_FAVORITES_STORAGE_KEY,
  )
  await page.reload()
  await expect(page.locator('#answer-text')).toBeVisible()
  await enterReference(page)
  await expect(reference(page).getByText(/原收藏数据无法读取/)).toBeVisible()
  await expect(reference(page).getByRole('button', { name: /只看收藏（0）/ })).toBeVisible()
  await search(page).fill(vector.id)
  await detail(page)
    .getByRole('button', { name: `收藏：${vector.title}`, exact: true })
    .click()
  await expect(reference(page).getByText(/已保存到本机/)).toBeVisible()
})

test('storage write failures keep usable session favorites and explicitly warn about persistence', async ({
  page,
}) => {
  await page.addInitScript((key) => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException('Synthetic full storage', 'QuotaExceededError')
      original.call(this, name, value)
    }
  }, FORMULA_FAVORITES_STORAGE_KEY)
  await openWorkspace(page)
  await enterReference(page)
  await search(page).fill(vector.id)
  await detail(page)
    .getByRole('button', { name: `收藏：${vector.title}`, exact: true })
    .click()
  await expect(reference(page).getByText(/收藏暂时只保留在本次会话，无法保存到本机/)).toBeVisible()
  await expect(
    detail(page).getByRole('button', { name: `取消收藏：${vector.title}`, exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: '题目练习 Practice', exact: true }).click()
  await enterReference(page)
  await expect(
    detail(page).getByRole('button', { name: `取消收藏：${vector.title}`, exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
})

test('narrow and dark layouts wrap formulas and source URLs and remain keyboard accessible', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await openWorkspace(page)
  await enterReference(page)
  await search(page).fill(scale.id)
  await search(page).press('Tab')
  await expect(reference(page).getByLabel('学科', { exact: true })).toBeFocused()
  await expect(detail(page).getByRole('heading', { name: scale.title, exact: true })).toBeVisible()
  await detail(page).getByText('参考来源与别名', { exact: true }).click()
  const source = detail(page).getByRole('textbox', { name: '来源网址（可复制）' }).first()
  await expect(source).toHaveValue(scale.sources[0].url)
  await source.focus()
  expect(
    await source.evaluate((node) => {
      const input = node as HTMLTextAreaElement
      return input.selectionEnd === input.value.length && input.selectionStart === 0
    }),
  ).toBe(true)
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true)
  await page.screenshot({ path: 'test-results/formula-reference-mobile-dark.png', fullPage: true })
})
