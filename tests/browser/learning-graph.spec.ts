import { expect, test } from '@playwright/test'

test('help reference, accepted merge, subject isolation, inert text and explicit restore controls', async ({
  page,
}) => {
  await page.route('**/learning-graph-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><body><div id="root"></div>
  <script type="module">
    import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type;
    window.__vite_plugin_react_preamble_installed__ = true;
  </script>
  <script type="module">
    import React from '/node_modules/.vite/deps/react.js';
    import { createRoot } from '/node_modules/.vite/deps/react-dom_client.js';
    import { LearningGraph } from '/src/components/LearningGraph.tsx';
    import { emptyDraft } from '/src/shared/types.ts';
    import { emptyLearningGraph, captureLearningSnapshot, beginLearningHelp, appendLearningEvent, acceptLearningHelp } from '/src/domain/learning-graph.ts';
    import '/src/components/appearance.css';
    const base = { ...emptyDraft('math'), text: 'Independent answer' };
    let graph = captureLearningSnapshot(emptyLearningGraph(), { questionId: 'math-q', subject: 'math', draft: base, initialOrigin: 'independent' }, 's1', 10).graph;
    graph = beginLearningHelp(graph, { snapshotId: 's1', requestId: 'r1', kind: 'agent' }, 'b1', 20).graph;
    graph = appendLearningEvent(graph, { id: 't1', type: 'tool', branchId: 'b1', createdAt: 21, trace: { tool: 'math_measure', outcome: 'completed' } });
    graph = appendLearningEvent(graph, { id: 'e1', type: 'help-received', branchId: 'b1', createdAt: 30, detail: { prompt: 'Why?', response: '<img src=x onerror=alert(1)> Think about the conditions.' } });
    graph = acceptLearningHelp(graph, { branchId: 'b1', expectedSnapshotId: 's1', draft: { ...base, text: 'Accepted answer' } }, 's2', 'e2', 40).graph;
    graph = captureLearningSnapshot(graph, { questionId: 'history-q', subject: 'history', draft: emptyDraft('history') }, 's3', 50).graph;
    window.graphRestores = 0;
    createRoot(document.getElementById('root')).render(React.createElement(LearningGraph, { graph, onRestore: async () => { window.graphRestores++; } }));
  </script></body></html>`,
    }),
  )
  await page.goto('/learning-graph-fixture')
  const graph = page.getByTestId('learning-graph')
  await expect(graph.getByRole('heading', { name: '作答与 AI 求助分支' })).toBeVisible()
  await expect(graph.locator('.learning-snapshot')).toHaveCount(3)
  await expect(graph.locator('[data-snapshot-id="s1"] .assistance-badge').first()).toHaveText(
    '参考过 AI',
  )
  await expect(graph.locator('[data-snapshot-id="s2"] .assistance-badge').first()).toHaveText(
    '采纳过 AI 修改',
  )
  await graph.getByText('查看求助与提示', { exact: true }).click()
  await expect(
    graph.getByText('<img src=x onerror=alert(1)> Think about the conditions.', { exact: true }),
  ).toBeVisible()
  await expect(graph.locator('img')).toHaveCount(0)
  await graph.getByText('工具轨迹', { exact: false }).click()
  await expect(graph.getByText('数学测量 · 完成')).toBeVisible()
  await expect(graph.getByRole('button', { name: '查看真实提交', exact: false })).toHaveCount(0)
  await expect(graph.getByRole('button', { name: '恢复此快照为新分支' })).toHaveCount(1)
  expect(
    await page.evaluate(() => (window as unknown as { graphRestores: number }).graphRestores),
  ).toBe(0)
  await graph.getByRole('button', { name: '恢复此快照为新分支' }).click()
  expect(
    await page.evaluate(() => (window as unknown as { graphRestores: number }).graphRestores),
  ).toBe(1)
  await graph.getByLabel('学科', { exact: true }).selectOption('history')
  await expect(graph.locator('.learning-snapshot')).toHaveCount(1)
  await expect(graph.locator('.learning-snapshot .assistance-badge')).toHaveText('来源未记录')
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark'
  })
  await expect(graph).toBeVisible()
})
