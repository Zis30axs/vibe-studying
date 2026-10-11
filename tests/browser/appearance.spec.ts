import { test, expect, type Page } from '@playwright/test'
import type { ExamCraftApi } from '../../src/shared/types'
import type { AppearancePreferences, AppearanceSnapshot } from '../../src/shared/appearance'

interface AppearanceFixture {
  state: AppearanceSnapshot
  saves: AppearancePreferences[]
  choice: 'success' | 'cancel' | 'error' | 'wait'
  chooseCalls: number
  release(): void
}
declare global {
  interface Window {
    appearanceFixture: AppearanceFixture
  }
}
const pngData =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNocDjwHwAFRAKAb2WvNQAAAABJRU5ErkJggg=='
async function openSettings(page: Page) {
  await page.addInitScript(
    ({ pngData }) => {
      const defaults = (): AppearancePreferences => ({
        version: 1,
        theme: 'system',
        wallpaper: { opacity: 0.16, blur: 0, position: 'center', fit: 'cover' },
      })
      const fixture: AppearanceFixture = {
        state: JSON.parse(sessionStorage.getItem('synthetic-appearance') || 'null') ?? {
          preferences: defaults(),
          wallpaper: null,
        },
        saves: [],
        choice: 'success',
        chooseCalls: 0,
        release: () => {},
      }
      window.appearanceFixture = fixture
      const snapshot = () => structuredClone(fixture.state)
      const save = () =>
        sessionStorage.setItem('synthetic-appearance', JSON.stringify(fixture.state))
      const api: Partial<ExamCraftApi> = {
        getAppearance: async () => snapshot(),
        saveAppearance: async (preferences) => {
          fixture.saves.push(structuredClone(preferences))
          fixture.state.preferences = structuredClone(preferences)
          save()
          return structuredClone(preferences)
        },
        chooseWallpaper: async () => {
          fixture.chooseCalls++
          if (fixture.choice === 'cancel') return { canceled: true, appearance: snapshot() }
          if (fixture.choice === 'error')
            throw new Error('请选择未损坏的 PNG、JPEG 或 WebP 图片，大小不超过 10 MiB。')
          const selected = { ...snapshot(), wallpaper: { dataUrl: pngData, width: 1, height: 1 } }
          if (fixture.choice === 'wait') {
            await new Promise<void>((resolve) => {
              fixture.release = resolve
            })
            return { canceled: false, appearance: selected }
          }
          fixture.state = selected
          save()
          return { canceled: false, appearance: snapshot() }
        },
        removeWallpaper: async () => {
          fixture.state.wallpaper = null
          save()
          return snapshot()
        },
        resetAppearance: async () => {
          fixture.state = { preferences: defaults(), wallpaper: null }
          save()
          return snapshot()
        },
        listQuestions: async () => [],
        loadState: async () => ({ version: 1, drafts: {}, attempts: [] }),
        getCapabilities: async () => ({
          questionBank: 'Synthetic',
          reviewer: 'Synthetic',
          mcp: 'Synthetic',
        }),
        getModelProfiles: async () => ({
          revision: 0,
          profiles: [
            {
              profileId: 'fixture',
              profileName: 'Fixture',
              protocol: 'openai-chat',
              baseUrl: 'https://fixture.invalid/v1',
              model: 'synthetic',
              revision: 0,
              configured: false,
              keyStatus: 'missing',
            },
          ],
          roles: { parent: 'fixture', child: 'fixture' },
          secureStorageAvailable: false,
        }),
        getModelConsents: async () => ({ version: 1, revision: 0, grants: [] }),
        getModelDebug: async () => ({ enabled: false, limit: 80, records: [] }),
        getGitHubProfile: async () => null,
        listKnowledgeDocuments: async () => [],
      }
      window.examcraft = api as ExamCraftApi
    },
    { pngData },
  )
  await page.goto('/')
  await page.getByRole('button', { name: '外观', exact: true }).click()
  await expect(page.getByRole('heading', { name: '外观与本地壁纸', exact: true })).toBeVisible()
  await expect(page.getByRole('radio', { name: '跟随系统 自动随系统切换' })).toBeEnabled()
}

test('theme follows OS, explicit choice survives reload, and local cache contains no image or path', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await openSettings(page)
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.getByRole('radio', { name: '浅色 明亮纸面' }).check()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.getByRole('button', { name: '外观', exact: true }).click()
  await page.getByRole('radio', { name: '跟随系统 自动随系统切换' }).check()
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  const cache = await page.evaluate(() => localStorage.getItem('examcraft.appearance.v1'))
  expect(cache).not.toContain('data:image')
  expect(cache).not.toContain('file:')
})

test('local wallpaper controls preview, preserve opaque input surfaces and reset only appearance', async ({
  page,
}) => {
  await openSettings(page)
  await page.getByRole('button', { name: '选择本地图片', exact: true }).click()
  const layer = page.getByTestId('workspace-wallpaper')
  await expect(layer).toHaveCSS('pointer-events', 'none')
  await page.getByRole('slider', { name: '壁纸不透明度' }).fill('35')
  await page.getByRole('slider', { name: '壁纸模糊' }).fill('12')
  await page.getByRole('combobox', { name: '壁纸位置' }).selectOption('right')
  await page.getByRole('combobox', { name: '壁纸填充方式' }).selectOption('contain')
  await expect(layer).toHaveCSS('opacity', '0.35')
  await expect(layer).toHaveCSS('filter', 'blur(12px)')
  await expect(layer).toHaveCSS('background-size', 'contain')
  await page.getByRole('radio', { name: '深色 柔和暗色' }).check()
  await expect(page.locator('#appearance-settings')).toHaveCSS(
    'background-color',
    'rgb(36, 38, 46)',
  )
  await page.reload()
  await expect(layer).toHaveCSS('opacity', '0.35')
  await page.getByRole('button', { name: '外观', exact: true }).click()
  await page.getByRole('button', { name: '恢复默认外观', exact: true }).click()
  await expect(layer).toHaveCount(0)
  await expect(page.getByRole('radio', { name: '跟随系统 自动随系统切换' })).toBeChecked()
})

test('chooser cancellation and invalid images preserve prior wallpaper; a late chooser cannot undo reset', async ({
  page,
}) => {
  await openSettings(page)
  await page.getByRole('button', { name: '选择本地图片', exact: true }).click()
  const layer = page.getByTestId('workspace-wallpaper')
  const before = await layer.getAttribute('style')
  await page.evaluate(() => {
    window.appearanceFixture.choice = 'cancel'
  })
  await page.getByRole('button', { name: '更换本地图片', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '已取消选择' })).toBeVisible()
  await expect(layer).toHaveAttribute('style', before!)
  await page.evaluate(() => {
    window.appearanceFixture.choice = 'error'
  })
  await page.getByRole('button', { name: '更换本地图片', exact: true }).click()
  await expect(page.locator('#appearance-settings [role="alert"]')).toContainText('请选择未损坏')
  await expect(layer).toHaveAttribute('style', before!)
  await page.evaluate(() => {
    window.appearanceFixture.choice = 'wait'
  })
  await page.getByRole('button', { name: '更换本地图片', exact: true }).click()
  await expect(page.getByRole('button', { name: '正在处理…', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '恢复默认外观', exact: true }).click()
  await page.evaluate(() => window.appearanceFixture.release())
  await expect(layer).toHaveCount(0)
  await expect(page.getByRole('radio', { name: '跟随系统 自动随系统切换' })).toBeChecked()
})

test('narrow appearance controls remain reachable by keyboard and forced colors suppress wallpaper', async ({
  page,
}) => {
  await page.setViewportSize({ width: 620, height: 840 })
  await openSettings(page)
  await expect(page.locator('#appearance-settings')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('radio', { name: '跟随系统 自动随系统切换' })).toBeFocused()
  await page.getByRole('button', { name: '选择本地图片', exact: true }).click()
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' })
  await expect(page.getByTestId('workspace-wallpaper')).toBeHidden()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
