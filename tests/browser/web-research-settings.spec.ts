import { expect, test, type Page } from '@playwright/test'
import type { WebResearchConfigInput } from '../../src/shared/web-research'

declare global {
  interface Window {
    webSettingsFixture: {
      saves: WebResearchConfigInput[]
      delay: boolean
      release: (() => void) | null
      mounted(value: boolean): void
    }
  }
}

async function openFixture(page: Page, secureStorageAvailable = true) {
  await page.route('**/web-research-settings-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html><body><div id="root"></div>
    <script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
    </script>
    <script type="module">
      import React, { useState, createRoot } from '/tests/browser/fixtures/react.ts';
      import { WebResearchSettings } from '/src/components/WebResearchSettings.tsx';
      import '/src/components/appearance.css';
      const h = React.createElement;
      let config = { provider: 'tavily', revision: 1, configured: true, keyStatus: 'saved', secureStorageAvailable: ${secureStorageAvailable} };
      const f = window.webSettingsFixture = { saves: [], delay: false, release: null };
      const api = {
        getWebResearchConfig: async () => structuredClone(config),
        saveWebResearchConfig: async input => {
          f.saves.push(structuredClone(input));
          if (f.delay) await new Promise(resolve => { f.release = resolve; });
          config = { ...config, revision: config.revision + 1, ...(input.clearApiKey ? { configured: false, keyStatus: 'missing' } : input.apiKey ? { configured: true, keyStatus: input.persistApiKey ? 'saved' : 'session' } : {}) };
          return structuredClone(config);
        }
      };
      function App() {
        const [mounted, setMounted] = useState(true); f.mounted = setMounted;
        return mounted ? h(WebResearchSettings, { api }) : h('p', null, 'Settings closed');
      }
      createRoot(document.getElementById('root')).render(h(App));
    </script></body></html>`,
    }),
  )
  await page.goto('/web-research-settings-fixture')
  await expect(page.getByRole('button', { name: '保存联网设置', exact: true })).toBeEnabled()
}

test('Tavily credentials remain masked, session-only by default, blank-retained and explicitly clearable', async ({
  page,
}) => {
  await openFixture(page)
  const key = page.getByLabel('Tavily API Key', { exact: true })
  const persist = page.getByRole('checkbox', {
    name: '使用系统加密保存这个新 Tavily Key',
    exact: false,
  })
  const save = page.getByRole('button', { name: '保存联网设置', exact: true })
  await expect(key).toHaveAttribute('type', 'password')
  await expect(key).toBeEmpty()
  await expect(persist).not.toBeChecked()
  await save.click()
  await expect(page.getByRole('status')).toContainText('未发出网络测试')
  expect(await page.evaluate(() => window.webSettingsFixture.saves[0])).toEqual({
    provider: 'tavily',
    expectedRevision: 1,
    persistApiKey: false,
    clearApiKey: false,
  })
  await key.fill('synthetic-session-key')
  await save.click()
  await expect(key).toBeEmpty()
  await expect(page.getByText('密钥状态：仅本次应用会话', { exact: true })).toBeVisible()
  expect((await page.evaluate(() => window.webSettingsFixture.saves[1])).persistApiKey).toBe(false)
  await key.fill('synthetic-saved-key')
  await persist.check()
  await save.click()
  await expect(key).toBeEmpty()
  await expect(persist).not.toBeChecked()
  expect((await page.evaluate(() => window.webSettingsFixture.saves[2])).persistApiKey).toBe(true)
  await page.getByRole('checkbox', { name: '清除已有 Tavily Key', exact: false }).check()
  await expect(key).toBeDisabled()
  await save.click()
  await expect(page.getByRole('status')).toHaveText('Tavily Key 已清除。')
  expect(await page.evaluate(() => window.webSettingsFixture.saves[3])).toMatchObject({
    clearApiKey: true,
    persistApiKey: false,
  })
  expect((await page.evaluate(() => window.webSettingsFixture.saves[3])).apiKey).toBeUndefined()
})

test('duplicate saves and closing while a save is pending do not resubmit or expose the key', async ({
  page,
}) => {
  await openFixture(page)
  await page.getByLabel('Tavily API Key', { exact: true }).fill('synthetic-pending-key')
  await page.evaluate(() => {
    window.webSettingsFixture.delay = true
  })
  await page.getByRole('button', { name: '保存联网设置', exact: true }).evaluate((element) => {
    ;(element as HTMLButtonElement).click()
    ;(element as HTMLButtonElement).click()
  })
  expect(await page.evaluate(() => window.webSettingsFixture.saves.length)).toBe(1)
  await expect(page.getByLabel('Tavily API Key', { exact: true })).toBeEmpty()
  await page.evaluate(() => window.webSettingsFixture.mounted(false))
  await page.evaluate(() => window.webSettingsFixture.release?.())
  await expect(page.getByText('Settings closed')).toBeVisible()
  await page.evaluate(() => window.webSettingsFixture.mounted(true))
  await expect(page.getByLabel('Tavily API Key', { exact: true })).toBeEmpty()
  await expect(
    page.getByRole('checkbox', { name: '使用系统加密保存这个新 Tavily Key', exact: false }),
  ).not.toBeChecked()
  expect(await page.evaluate(() => window.webSettingsFixture.saves.length)).toBe(1)
})

test('unavailable OS encryption disables persistence and narrow layout remains readable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 460, height: 900 })
  await openFixture(page, false)
  await page.getByLabel('Tavily API Key', { exact: true }).fill('synthetic-session-key')
  await expect(
    page.getByRole('checkbox', { name: '使用系统加密保存这个新 Tavily Key', exact: false }),
  ).toBeDisabled()
  await expect(
    page.getByText('系统安全存储不可用，仅支持会话密钥；不会改用明文保存。', { exact: true }),
  ).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
})
