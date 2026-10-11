import { expect, test, type Page } from '@playwright/test'
import type { AgentRunRequest } from '../../src/shared/agent-workbench'

declare global {
  interface Window {
    agentFixture: {
      starts: number
      polls: number
      cancels: number
      accepts: number
      applies: number
      saves: number
      metadataReads: number
      mode: 'normal' | 'denied' | 'budget'
      lastRequest?: AgentRunRequest
      delayAccept: boolean
      releaseAccept: (() => void) | null
      finish(): void
      answer(text: string): void
      revision(value: number): void
      mounted(value: boolean): void
    }
  }
}
const parentConsent = '我同意向主模型发送本次任务、所选数据与工具结果'
const startLabel = '开始本次 Agent 任务'
async function openFixture(page: Page, rememberedWeb = false) {
  await page.route('**/agent-workbench-fixture', (route) =>
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
    import React, { useRef, useState, createRoot } from '/tests/browser/fixtures/react.ts';
    import { AgentWorkbench } from '/src/components/AgentWorkbench.tsx';
    import '/src/components/appearance.css';
    const h = React.createElement;
    const baseline = { text: 'Original answer', blocks: [], drawing: { points: [], lines: [], mode: 'cartesian' } };
    const q = { id: 'q1', subject: 'math', kind: 'math', title: 'Synthetic current question', prompt: 'Compute distance', source: 'fixture', tags: [], maxScore: 5 };
    const f = window.agentFixture = { starts: 0, polls: 0, cancels: 0, accepts: 0, applies: 0, saves: 0, metadataReads: 0, mode: 'normal', delayAccept: false, releaseAccept: null };
    let run = null;
    f.finish = () => { run = { ...run, status: 'complete', elapsedMs: 750, modelRequests: 2, toolCalls: 1, sessionRequests: 2, text: '<scr' + 'ipt>plain model output</scr' + 'ipt>', message: '任务结束。预览尚未写入。', events: [{ sequence: 1, kind: 'tool', tool: 'math_measure', status: 'complete', elapsedMs: 5 }], proposals: f.lastRequest.allowedTools.includes('propose_answer_edit') ? [{ proposalId: 'p1', proposal: { kind: 'answer-edit', questionId: 'q1', expectedText: 'Original answer', replacement: 'Revised answer', reason: 'Synthetic revision' } }] : [] }; };
    const api = {
      getWebResearchConfig: async () => ({ provider: 'tavily', revision: 1, configured: true, keyStatus: 'session', secureStorageAvailable: true }),
      saveWebResearchConfig: async () => { throw new Error('Settings are not part of this fixture'); },
      listKnowledgeDocuments: async () => { f.metadataReads++; return [{ id: 'a'.repeat(64), subject: 'math', title: 'Synthetic textbook', pageCount: 200, textPageCount: 200, scopes: [], edition: '', editionConfirmed: false, byteLength: 100, importedAt: new Date().toISOString() }]; },
      getModelConsents: async () => ({ version: 1, revision: 0, grants: ${JSON.stringify(
        rememberedWeb
          ? [
              {
                baseUrl: 'https://api.tavily.com',
                scopes: ['web_public'],
                grantedAt: '2026-10-11T00:00:00.000Z',
              },
              {
                baseUrl: 'https://api.vendor.com/v1',
                scopes: ['agent', 'agent_web'],
                grantedAt: '2026-10-11T00:00:00.000Z',
              },
            ]
          : [],
      )} }),
      grantModelConsent: async () => ({ version: 1, revision: 0, grants: [] }),
      revokeModelConsent: async () => ({ version: 1, revision: 0, grants: [] }),
      startAgentRun: async request => {
        f.starts++; f.lastRequest = structuredClone(request);
        if (f.mode === 'denied') throw new Error('Synthetic authorization denied');
        run = { runId: request.runId, status: 'running', startedAt: Date.now(), elapsedMs: 0, modelRequests: 1, toolCalls: 0, delegatedCalls: 0, sessionRequests: 1, budget: { modelRequests: 3, toolCalls: 6, delegatedCalls: 2, timeoutMs: 120000, sessionRequests: 30 }, events: [], text: '', message: '', proposals: [] };
        return structuredClone(run);
      },
      getAgentRun: async id => {
        f.polls++;
        if (f.mode === 'budget') run = { ...run, status: 'failed', modelRequests: 3, toolCalls: 6, sessionRequests: 3, message: '本次 Agent 轮次或工具预算已用尽；没有自动重试。' };
        return structuredClone(run);
      },
      cancelAgentRun: async () => { f.cancels++; if (run) run = { ...run, status: 'cancelled', proposals: [] }; },
      acceptAgentProposal: async () => {
        f.accepts++;
        if (f.delayAccept) await new Promise(resolve => { f.releaseAccept = resolve; });
        return { kind: 'answer-edit', questionId: 'q1', expectedText: 'Original answer', replacement: 'Revised answer' };
      },
      discardAgentProposal: async () => { run.proposals = []; }
    };
    function App() {
      const [draft, setDraft] = useState(structuredClone(baseline));
      const liveDraft = useRef(draft); liveDraft.current = draft;
      const [revision, setRevision] = useState(1);
      const [mounted, setMounted] = useState(true);
      f.answer = text => { liveDraft.current = { ...liveDraft.current, text }; setDraft(liveDraft.current); }; f.revision = setRevision; f.mounted = setMounted;
      const config = { protocol: 'openai-chat', baseUrl: 'https://api.vendor.com/v1', model: 'synthetic', configured: true, revision };
      return h(React.Fragment, null, h('p', { 'aria-label': 'Current answer' }, draft.text), mounted && h(AgentWorkbench, { api, parentConfig: config, childConfig: config, configRevision: revision, currentQuestion: q, currentAnswer: draft, onApplyAnswer: input => { if (JSON.stringify(input.baselineDraft) !== JSON.stringify(liveDraft.current)) return false; f.applies++; liveDraft.current = { ...liveDraft.current, text: input.replacement }; setDraft(liveDraft.current); return true; }, onAcceptedQuestion: () => { f.saves++; } }));
    }
    createRoot(document.getElementById('root')).render(h(App));
  </script></body></html>`,
    }),
  )
  await page.goto('/agent-workbench-fixture')
  await expect(page.getByRole('heading', { name: '有界 Agent 工作台' })).toBeVisible()
}
async function ready(page: Page, proposals = false) {
  await page
    .getByRole('textbox', { name: '本次任务', exact: true })
    .fill('Use the selected bounded tools')
  if (proposals) {
    await page.getByRole('checkbox', { name: '附带当前答卷快照', exact: false }).check()
    await page.getByRole('checkbox', { name: '提出正文替换', exact: false }).check()
  }
  await page.getByRole('checkbox', { name: parentConsent, exact: true }).check()
  await expect(page.getByRole('button', { name: startLabel, exact: true })).toBeEnabled()
}

test('normal run sends only chosen scope and displays real result metadata as escaped text', async ({
  page,
}) => {
  await openFixture(page)
  await expect(page.getByRole('button', { name: startLabel, exact: true })).toBeDisabled()
  expect(await page.evaluate(() => window.agentFixture.starts)).toBe(0)
  await ready(page)
  await page.getByRole('button', { name: startLabel, exact: true }).click()
  const sent = await page.evaluate(() => window.agentFixture.lastRequest)
  expect(sent?.questionIds).toEqual(['q1'])
  expect(sent?.answer).toBeUndefined()
  expect(sent?.localDraft?.text).toBe('Original answer')
  expect(sent?.allowedTools).toEqual([
    'list_questions',
    'get_question',
    'math_plot',
    'math_measure',
  ])
  await page.evaluate(() => window.agentFixture.finish())
  await expect(page.getByText('<script>plain model output</script>', { exact: true })).toBeVisible()
  const measurementEvent = page
    .getByLabel('本次运行状态')
    .getByRole('listitem')
    .filter({ has: page.getByText('math_measure', { exact: true }) })
  await expect(measurementEvent).toHaveCount(1)
  await expect(measurementEvent).toContainText('数学测量')
  await expect(measurementEvent).toContainText('完成')
  await expect(page.getByText('主模型 2 / 3', { exact: true })).toBeVisible()
  expect(await page.locator('.agent-output script').count()).toBe(0)
  expect(await page.evaluate(() => window.agentFixture.starts)).toBe(1)
})

test('denied and budget-limited runs never automatically retry', async ({ page }) => {
  await openFixture(page)
  await ready(page)
  await page.evaluate(() => {
    window.agentFixture.mode = 'denied'
  })
  await page.getByRole('button', { name: startLabel, exact: true }).click()
  await expect(page.getByRole('status')).toContainText('任务未启动')
  expect(await page.evaluate(() => window.agentFixture.starts)).toBe(1)
  await page.evaluate(() => {
    window.agentFixture.mode = 'budget'
  })
  await page.getByRole('button', { name: startLabel, exact: true }).click()
  await expect(page.getByLabel('本次运行状态').getByRole('status')).toContainText('预算已用尽')
  expect(await page.evaluate(() => window.agentFixture.starts)).toBe(2)
  const polls = await page.evaluate(() => window.agentFixture.polls)
  await page.waitForTimeout(900)
  expect(await page.evaluate(() => window.agentFixture.polls)).toBe(polls)
})

test('cancel, newer task input, profile revision and unmount all stop the old task', async ({
  page,
}) => {
  await openFixture(page)
  await ready(page)
  await page.getByRole('button', { name: startLabel, exact: true }).click()
  await page.getByRole('button', { name: '取消任务', exact: true }).click()
  await expect(page.getByRole('button', { name: '取消任务', exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => window.agentFixture.cancels)).toBe(1)
  await page.getByRole('button', { name: startLabel, exact: true }).click()
  await page.getByRole('textbox', { name: '本次任务', exact: true }).fill('Newer task')
  await expect(page.getByRole('checkbox', { name: parentConsent, exact: true })).not.toBeChecked()
  expect(await page.evaluate(() => window.agentFixture.cancels)).toBe(2)
  await page.getByRole('checkbox', { name: parentConsent, exact: true }).check()
  await page.getByRole('button', { name: startLabel, exact: true }).click()
  await page.evaluate(() => window.agentFixture.revision(2))
  await expect(page.getByRole('checkbox', { name: parentConsent, exact: true })).not.toBeChecked()
  expect(await page.evaluate(() => window.agentFixture.cancels)).toBe(3)
  await page.getByRole('checkbox', { name: parentConsent, exact: true }).check()
  await page.getByRole('button', { name: startLabel, exact: true }).click()
  await page.evaluate(() => window.agentFixture.mounted(false))
  await expect(page.getByRole('heading', { name: '有界 Agent 工作台' })).toHaveCount(0)
  expect(await page.evaluate(() => window.agentFixture.cancels)).toBe(4)
})

test('full preview requires explicit acceptance; repeated clicks dispatch once', async ({
  page,
}) => {
  await openFixture(page)
  await ready(page, true)
  await page.getByRole('button', { name: startLabel, exact: true }).click()
  await page.evaluate(() => window.agentFixture.finish())
  await expect(page.getByLabel('修改前完整正文')).toContainText('Original answer')
  await expect(page.getByLabel('修改后完整正文')).toContainText('Revised answer')
  await page.evaluate(() => {
    window.agentFixture.delayAccept = true
  })
  await page.getByRole('button', { name: '确认应用正文修改', exact: true }).evaluate((element) => {
    ;(element as HTMLButtonElement).click()
    ;(element as HTMLButtonElement).click()
  })
  await expect(page.getByRole('button', { name: '正在处理…', exact: true })).toBeDisabled()
  expect(await page.evaluate(() => window.agentFixture.accepts)).toBe(1)
  expect(await page.evaluate(() => window.agentFixture.applies)).toBe(0)
  await page.evaluate(() => window.agentFixture.releaseAccept?.())
  await expect(page.getByLabel('Current answer', { exact: true })).toHaveText('Revised answer')
  expect(await page.evaluate(() => window.agentFixture.applies)).toBe(1)
})

test('newer answer during pending acceptance cannot be overwritten by a late result', async ({
  page,
}) => {
  await openFixture(page)
  await ready(page, true)
  await page.getByRole('button', { name: startLabel, exact: true }).click()
  await page.evaluate(() => window.agentFixture.finish())
  await page.evaluate(() => {
    window.agentFixture.delayAccept = true
  })
  await page.getByRole('button', { name: '确认应用正文修改', exact: true }).click()
  await page.evaluate(() => window.agentFixture.answer('Newer answer'))
  await page.evaluate(() => window.agentFixture.releaseAccept?.())
  await expect(page.getByLabel('Current answer', { exact: true })).toHaveText('Newer answer')
  expect(await page.evaluate(() => window.agentFixture.applies)).toBe(0)
  await expect(page.getByRole('button', { name: '确认应用正文修改', exact: true })).toHaveCount(0)
})

test('textbook scope is opt-in and stops invalid ranges; narrow view remains readable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 460, height: 900 })
  await openFixture(page)
  await ready(page)
  await page.getByText('可选：限定本地教材与物理页码', { exact: true }).click()
  await page.getByRole('combobox', { name: '教材', exact: true }).selectOption('a'.repeat(64))
  await page.getByRole('spinbutton', { name: '物理 PDF 结束页', exact: true }).fill('101')
  await expect(page.getByRole('button', { name: startLabel, exact: true })).toBeDisabled()
  await expect(
    page.getByText('请选择有效的物理 PDF 页码，连续范围不能超过 100 页。', { exact: true }),
  ).toBeVisible()
  expect(await page.evaluate(() => window.agentFixture.starts)).toBe(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
})

test('committed answer reconciles after navigating away while newer practice edits win', async ({
  page,
}) => {
  for (const editAfterNavigation of [false, true]) {
    await openFixture(page)
    await ready(page, true)
    await page.getByRole('button', { name: startLabel, exact: true }).click()
    await page.evaluate(() => window.agentFixture.finish())
    await page.evaluate(() => {
      window.agentFixture.delayAccept = true
    })
    await page.getByRole('button', { name: '确认应用正文修改', exact: true }).click()
    await page.evaluate(() => window.agentFixture.mounted(false))
    await expect(page.getByRole('heading', { name: '有界 Agent 工作台' })).toHaveCount(0)
    if (editAfterNavigation)
      await page.evaluate(() => window.agentFixture.answer('Newer practice edit'))
    await page.evaluate(() => window.agentFixture.releaseAccept?.())
    await expect(page.getByLabel('Current answer', { exact: true })).toHaveText(
      editAfterNavigation ? 'Newer practice edit' : 'Revised answer',
    )
    expect(await page.evaluate(() => window.agentFixture.applies)).toBe(editAfterNavigation ? 0 : 1)
  }
})

test('remembered grants do not enable network and exact public scope changes cancel the run', async ({
  page,
}) => {
  await openFixture(page, true)
  const toggle = page.getByRole('checkbox', { name: '本次任务允许联网', exact: false })
  await expect(toggle).not.toBeChecked()
  await expect(page.getByLabel('实际外发查询预览')).toHaveCount(0)
  await page.getByRole('textbox', { name: '本次任务', exact: true }).fill('PRIVATE TASK TEXT')
  await toggle.check()
  await expect(page.getByRole('textbox', { name: '公开章节 / 主题', exact: true })).toBeEmpty()
  await expect(page.getByRole('textbox', { name: '公开地区 / 试卷范围', exact: true })).toBeEmpty()
  await expect(page.getByRole('button', { name: startLabel, exact: true })).toBeDisabled()
  await page.getByRole('textbox', { name: '公开章节 / 主题', exact: true }).fill('函数与导数')
  await page.getByRole('textbox', { name: '公开地区 / 试卷范围', exact: true }).fill('全国卷')
  await page.getByRole('textbox', { name: '公开年份（最多 5 个）', exact: true }).fill('2023,2024')
  const query = page.getByLabel('实际外发查询预览')
  await expect(query).toContainText('数学 函数与导数 全国卷 2023 2024 历年试题 考点 公开资料')
  await expect(query).not.toContainText('PRIVATE TASK')
  await expect(query).not.toContainText('Original answer')
  const webConsent = page.getByRole('checkbox', { name: '我同意向 Tavily', exact: false })
  await expect(webConsent).toBeChecked()
  // Scope edits cancel prior work, but the same receiver/data-category grant
  // remains valid. Repeated edits must not race the child consent reconciliation.
  await page.getByRole('textbox', { name: '公开章节 / 主题', exact: true }).fill('数列')
  await expect(webConsent).toBeChecked()
  await page.getByRole('textbox', { name: '公开章节 / 主题', exact: true }).fill('函数与导数')
  await page.getByRole('textbox', { name: '公开年份（最多 5 个）', exact: true }).fill('2022')
  await expect(webConsent).toBeChecked()
  await page.getByRole('textbox', { name: '公开年份（最多 5 个）', exact: true }).fill('2023,2024')
  await expect(webConsent).toBeChecked()
  expect(await page.evaluate(() => window.agentFixture.starts)).toBe(0)
  await expect(page.getByRole('button', { name: startLabel, exact: true })).toBeEnabled()
  await page.getByRole('button', { name: startLabel, exact: true }).click()
  const request = await page.evaluate(() => window.agentFixture.lastRequest)
  expect(request?.web).toEqual({
    provider: 'tavily',
    configRevision: 1,
    consent: true,
    scope: {
      subject: 'math',
      topic: '函数与导数',
      region: '全国卷',
      years: [2023, 2024],
      approvedUrls: [],
    },
  })
  expect(request?.allowedTools).toEqual(expect.arrayContaining(['web_search', 'web_fetch']))
  await page.getByRole('textbox', { name: '公开章节 / 主题', exact: true }).fill('数列')
  expect(await page.evaluate(() => window.agentFixture.cancels)).toBe(1)
  await toggle.uncheck()
  await page.getByRole('button', { name: startLabel, exact: true }).click()
  expect(await page.evaluate(() => window.agentFixture.lastRequest?.web)).toBeUndefined()
  expect(await page.evaluate(() => window.agentFixture.lastRequest?.allowedTools)).not.toContain(
    'web_search',
  )
})

test('network URLs fail closed and a remount still starts offline with remembered grants', async ({
  page,
}) => {
  await page.setViewportSize({ width: 460, height: 900 })
  await openFixture(page, true)
  await page.getByRole('checkbox', { name: '本次任务允许联网', exact: false }).check()
  await page.getByRole('textbox', { name: '本次任务', exact: true }).fill('Public research')
  await page.getByRole('textbox', { name: '公开章节 / 主题', exact: true }).fill('函数')
  await page.getByRole('textbox', { name: '公开地区 / 试卷范围', exact: true }).fill('全国卷')
  await page.getByRole('textbox', { name: '公开年份（最多 5 个）', exact: true }).fill('2024')
  await page
    .getByRole('textbox', { name: '已批准的公开 HTTPS 网址', exact: false })
    .fill('https://127.0.0.1/private')
  await expect(page.getByRole('button', { name: startLabel, exact: true })).toBeDisabled()
  await expect(page.getByLabel('实际外发查询预览')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
  await page.evaluate(() => window.agentFixture.mounted(false))
  await page.evaluate(() => window.agentFixture.mounted(true))
  await expect(
    page.getByRole('checkbox', { name: '本次任务允许联网', exact: false }),
  ).not.toBeChecked()
  expect(await page.evaluate(() => window.agentFixture.starts)).toBe(0)
})
