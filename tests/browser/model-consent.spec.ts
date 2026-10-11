import { test, expect, type Page } from '@playwright/test'
import type { ModelConsentsState } from '../../src/shared/model-consent'

declare global {
  interface Window {
    consentFixture: {
      grants: number
      revokes: number
      stored: ModelConsentsState
      delayGrant: boolean
      failRevoke: boolean
      releaseGrant: (() => void) | null
      reset(): void
      receiver(value: string): void
      model(value: string): void
      reference(value: boolean): void
      mounted(value: boolean): void
    }
  }
}
const first = 'https://first.vendor.com/v1'
const second = 'https://second.vendor.com/v1'
const label = '我同意本次发送选中文字'
const rememberLabel = '记住对此接收方和数据范围的同意，下次不再询问'

// Isolated renderer fixture: no provider calls, keys, question data or file access.
// Production AtomicJsonStore persistence is covered by model-consent.test.ts.
async function openFixture(page: Page) {
  await page.route('**/consent-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><body><div id="root"></div>
      <script type="module">
        import RefreshRuntime from '/@react-refresh';
        RefreshRuntime.injectIntoGlobalHook(window);
        window.$RefreshReg$ = () => {};
        window.$RefreshSig$ = () => type => type;
        window.__vite_plugin_react_preamble_installed__ = true;
      </script>
      <script type="module">
        import React, { useState } from '/node_modules/.vite/deps/react.js';
        import { createRoot } from '/node_modules/.vite/deps/react-dom_client.js';
        import { ModelConsentControl, ModelConsentSettings } from '/src/components/ModelConsentControl.tsx';
        const h = React.createElement;
        const f = window.consentFixture = {
          grants: 0, revokes: 0, delayGrant: false, failRevoke: false, releaseGrant: null,
          stored: JSON.parse(sessionStorage.getItem('synthetic-consent') || '{"version":1,"revision":0,"grants":[]}')
        };
        const save = () => { sessionStorage.setItem('synthetic-consent', JSON.stringify(f.stored)); return structuredClone(f.stored); };
        const api = {
          getModelConsents: async () => structuredClone(f.stored),
          grantModelConsent: async input => {
            f.grants++;
            if (f.delayGrant) await new Promise(resolve => { f.releaseGrant = resolve; });
            const old = f.stored.grants.find(item => item.baseUrl === input.baseUrl);
            const grant = { baseUrl: input.baseUrl, scopes: [...new Set([...(old?.scopes || []), ...input.scopes])], grantedAt: new Date().toISOString() };
            f.stored = { version: 1, revision: f.stored.revision + 1, grants: [...f.stored.grants.filter(item => item.baseUrl !== input.baseUrl), grant] };
            return save();
          },
          revokeModelConsent: async input => {
            f.revokes++;
            if (f.failRevoke) throw new Error('Synthetic disk failure');
            f.stored = { ...f.stored, revision: f.stored.revision + 1, grants: f.stored.grants.flatMap(grant => {
              if (input.baseUrl && input.baseUrl !== grant.baseUrl) return [grant];
              if (!input.scopes) return [];
              const scopes = grant.scopes.filter(scope => !input.scopes.includes(scope));
              return scopes.length ? [{ ...grant, scopes }] : [];
            }) };
            return save();
          }
        };
        function App() {
          const [checked, setChecked] = useState(false);
          const [other, setOther] = useState(false);
          const [receiver, setReceiver] = useState('${first}');
          const [model, setModel] = useState('synthetic-model');
          const [reference, setReference] = useState(false);
          const [mounted, setMounted] = useState(true);
          f.reset = () => { setChecked(false); setOther(false); };
          f.receiver = setReceiver; f.model = setModel; f.reference = setReference; f.mounted = setMounted;
          const config = { protocol: 'openai-chat', baseUrl: receiver, model, revision: 1, configured: true };
          const scopes = ['advisor', ...(reference ? ['reference'] : [])];
          return h(React.Fragment, null,
            mounted && h('section', { 'aria-label': 'Primary consent' }, h(ModelConsentControl, { api, config, scopes, checked, onChange: setChecked, label: '${label}' })),
            h('section', { 'aria-label': 'Other consent' }, h(ModelConsentControl, { api, config, scopes, checked: other, onChange: setOther, label: '我同意另一项本次发送' })),
            h(ModelConsentSettings, { api })
          );
        }
        createRoot(document.getElementById('root')).render(h(App));
      </script></body></html>`,
    }),
  )
  await page.goto('/consent-fixture')
  await expect(primary(page).getByRole('checkbox', { name: label, exact: true })).toBeVisible()
}
const primary = (page: Page) => page.getByRole('region', { name: 'Primary consent', exact: true })
const consent = (page: Page) => primary(page).getByRole('checkbox', { name: label, exact: true })
const remember = (page: Page) =>
  primary(page).getByRole('checkbox', { name: rememberLabel, exact: true })
async function grantRemembered(page: Page) {
  await remember(page).check()
  await consent(page).check()
  await expect(primary(page).getByText('已在本机记住同意 · 查看范围与撤销方式')).toBeVisible()
}

test('one-off consent stays one-off; explicit remembering survives new question, model change, remount and reload', async ({
  page,
}) => {
  await openFixture(page)
  await expect(consent(page)).not.toBeChecked()
  await expect(remember(page)).not.toBeChecked()
  await consent(page).check()
  expect(await page.evaluate(() => window.consentFixture.grants)).toBe(0)
  await page.evaluate(() => window.consentFixture.reset())
  await expect(consent(page)).not.toBeChecked()
  await grantRemembered(page)
  await page.evaluate(() => window.consentFixture.reset())
  await expect(consent(page)).toBeChecked()
  await page.evaluate(() => window.consentFixture.model('another-model-at-same-endpoint'))
  await expect(consent(page)).toBeChecked()
  await page.evaluate(() => window.consentFixture.mounted(false))
  await expect(primary(page)).toHaveCount(0)
  await page.evaluate(() => window.consentFixture.mounted(true))
  await expect(consent(page)).toBeChecked()
  expect(await page.evaluate(() => window.consentFixture.grants)).toBe(1)
  await page.reload()
  await expect(consent(page)).toBeChecked()
  expect(await page.evaluate(() => window.consentFixture.grants)).toBe(0)
})

test('a changed receiver or an expanded category requires fresh consent', async ({ page }) => {
  await openFixture(page)
  await grantRemembered(page)
  await page.evaluate((value) => window.consentFixture.receiver(value), second)
  await expect(consent(page)).not.toBeChecked()
  await expect(remember(page)).not.toBeChecked()
  await page.evaluate((value) => window.consentFixture.receiver(value), first)
  await expect(consent(page)).toBeChecked()
  await page.evaluate(() => window.consentFixture.reference(true))
  await expect(consent(page)).not.toBeChecked()
  await expect(remember(page)).not.toBeChecked()
  expect(await page.evaluate(() => window.consentFixture.stored.grants[0].scopes)).toEqual([
    'advisor',
  ])
  await grantRemembered(page)
  expect(await page.evaluate(() => window.consentFixture.stored.grants[0].scopes)).toEqual([
    'advisor',
    'reference',
  ])
})

test('settings revocation synchronizes every mounted control and failed revocation never rechecks this session', async ({
  page,
}) => {
  await openFixture(page)
  await grantRemembered(page)
  const other = page
    .getByRole('region', { name: 'Other consent', exact: true })
    .getByRole('checkbox', { name: '我同意另一项本次发送', exact: true })
  await expect(other).toBeChecked()
  await page.getByRole('button', { name: '撤销此接收方的同意', exact: true }).click()
  await expect(consent(page)).not.toBeChecked()
  await expect(other).not.toBeChecked()
  expect(await page.evaluate(() => window.consentFixture.stored.grants)).toEqual([])
  await grantRemembered(page)
  await page.evaluate(() => {
    window.consentFixture.failRevoke = true
  })
  await page.getByRole('button', { name: '撤销全部已记住的同意', exact: true }).click()
  await expect(consent(page)).not.toBeChecked()
  await expect(other).not.toBeChecked()
  await expect(primary(page).getByRole('alert')).toContainText('未能保存撤销')
  await page.evaluate(() => window.consentFixture.reset())
  await expect(consent(page)).not.toBeChecked()
})

test('opting out of remembering preserves this explicit one-off check but cannot authorize a new question', async ({
  page,
}) => {
  await openFixture(page)
  await grantRemembered(page)
  await remember(page).uncheck()
  await expect(consent(page)).toBeChecked()
  await expect(remember(page)).not.toBeChecked()
  expect(await page.evaluate(() => window.consentFixture.stored.grants)).toEqual([])
  await page.evaluate(() => window.consentFixture.reset())
  await expect(consent(page)).not.toBeChecked()
})

test('a late grant response cannot check a newer receiver or a remounted control at that receiver', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await openFixture(page)
  await page.evaluate(() => {
    window.consentFixture.delayGrant = true
  })
  await remember(page).check()
  await consent(page).click()
  await expect(primary(page).getByRole('status')).toHaveText('正在保存授权选择…')
  await page.evaluate((value) => window.consentFixture.receiver(value), second)
  await page.evaluate(() => window.consentFixture.mounted(false))
  await page.evaluate(() => window.consentFixture.releaseGrant?.())
  await page.evaluate(() => window.consentFixture.mounted(true))
  await expect(consent(page)).not.toBeChecked()
  await expect(remember(page)).not.toBeChecked()
  expect(
    await page.evaluate(() => window.consentFixture.stored.grants.map((grant) => grant.baseUrl)),
  ).toEqual([first])
  expect(errors).toEqual([])
})
