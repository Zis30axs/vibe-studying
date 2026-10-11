import { createHash } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { createKnowledgePdf } from '../fixtures/knowledge-pdf'

// Renderer fixture only. All feedback, chunks and PDF pages are authored test data.
// Host hash/CAS persistence is covered separately by review-knowledge-index.test.ts.
const pdf = createKnowledgePdf([
  'Synthetic physical page one',
  'Synthetic physical page two',
  'Synthetic physical page three',
])
const documentId = createHash('sha256').update(pdf).digest('hex')
const nodeId = `rkn-${'a'.repeat(64)}`
const secondNodeId = `rkn-${'b'.repeat(64)}`
const fixture = async (page: Page) => {
  await page.route('**/review-knowledge-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><body><div id="root"></div>
    <script type="module">
      import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
    </script>
    <script type="module">
      import React, { createRoot } from '/tests/browser/fixtures/react.ts';
      import { ReviewKnowledgePanel } from '/src/components/ReviewKnowledgePanel.tsx';
      import { emptyDraft } from '/src/shared/types.ts';
      import '/src/components/appearance.css';
      const documentId = ${JSON.stringify(documentId)};
      const bytes = new Uint8Array(${JSON.stringify(Array.from(pdf))});
      const knowledgeDocument = { id: documentId, title: '原创测试 PDF', subject: 'politics', edition: '', editionConfirmed: false,
        byteLength: bytes.length, pageCount: 3, textPageCount: 3, scopes: [], importedAt: '2026-10-11T00:00:00.000Z' };
      const foreign = { ...knowledgeDocument, id: 'f'.repeat(64), title: '不可跨科选择的历史 PDF', subject: 'history' };
      const question = { id: 'saved-question', subject: 'politics', kind: 'essay', title: 'Original question', prompt: 'Original prompt', source: 'fixture', tags: [], maxScore: 2 };
      const attempt = { id: 'saved-attempt', questionId: question.id, questionSnapshot: question, draft: emptyDraft(), submittedAt: '2026-10-11T00:00:00.000Z', score: 1, maxScore: 2, feedback: '依法监督', rubric: [], explanation: '', reviewer: '本地规则' };
      const base = { id: ${JSON.stringify(nodeId)}, attemptId: attempt.id, questionId: attempt.questionId, subject: 'politics', reviewId: 'c'.repeat(64),
        source: { kind: 'feedback' }, label: '依法监督', reviewExcerpt: '<img src=x onerror=alert(1)> 原始反馈', excerptTruncated: false,
        references: [], revision: 1, createdAt: attempt.submittedAt, updatedAt: attempt.submittedAt, status: 'pending' };
      const second = { ...base, id: ${JSON.stringify(secondNodeId)}, attemptId: 'other-attempt', label: '另一份真实提交' };
      let nodes = [base, second];
      let activeAttempt = attempt;
      const calls = { refresh: [], search: [], label: [], associate: [], unlink: [], remove: [], pdf: [] };
      const control = window.reviewFixture = { calls, deferSearch: false, deferLabel: false, deferRefresh: false, noMatch: false, rejectAssociation: false };
      const delayed = (name, action) => new Promise((resolve) => { control['resolve' + name] = () => resolve(action()); });
      const hits = Array.from({length: 4}, (_, index) => ({ chunkId: documentId + ':p2:c' + (index + 1), documentId, documentTitle: knowledgeDocument.title,
        subject: knowledgeDocument.subject, pageNumber: 2, text: '<scr' + 'ipt>not executable</scr' + 'ipt> Original excerpt ' + (index + 1), score: 1 }));
      const update = (input, patch) => {
        const current = nodes.find(node => node.id === input.nodeId);
        if (!current || current.revision !== input.expectedRevision) throw new Error('索引版本冲突');
        const changed = { ...current, ...patch, revision: current.revision + 1 };
        nodes = nodes.map(node => node.id === changed.id ? changed : node);
        return changed;
      };
      const api = {
        refreshReviewKnowledge: async input => { calls.refresh.push(input); const run = () => nodes.filter(node => input.attemptIds.includes(node.attemptId)); return control.deferRefresh ? delayed('Refresh', run) : run(); },
        listReviewKnowledge: async input => nodes.filter(node => node.attemptId === input.attemptId),
        listKnowledgeDocuments: async () => [knowledgeDocument, foreign],
        searchKnowledge: async input => { calls.search.push(input); const run = () => control.noMatch ? [] : hits; return control.deferSearch ? delayed('Search', run) : run(); },
        updateReviewKnowledgeLabel: async input => { calls.label.push(input); const run = () => update(input, { label: input.label.trim() }); return control.deferLabel ? delayed('Label', run) : run(); },
        associateReviewKnowledge: async input => { calls.associate.push(input); if (control.rejectAssociation) throw new Error('索引版本冲突'); return update(input, { status: 'linked', references: input.chunkIds.map(chunkId => ({ chunkId, documentId, documentSha256: documentId, documentTitle: knowledgeDocument.title, subject: 'politics', pageNumber: 2, textSha256: 'd'.repeat(64) })) }); },
        removeReviewKnowledgeAssociation: async input => { calls.unlink.push(input); return update(input, { status: 'pending', references: [] }); },
        removeReviewKnowledgeNode: async input => { calls.remove.push(input); update(input, {}); nodes = nodes.filter(node => node.id !== input.nodeId); },
        getKnowledgePdf: async id => { calls.pdf.push(id); return bytes.slice(); },
      };
      const root = createRoot(document.getElementById('root'));
      const render = () => root.render(React.createElement(ReviewKnowledgePanel, { api, attempt: activeAttempt }));
      control.switchAttempt = () => { activeAttempt = { ...attempt, id: second.attemptId }; render(); };
      control.unmount = () => root.render(null);
      control.remount = render;
      control.markStale = () => { nodes = nodes.map(node => ({ ...node, status: 'stale', staleReason: 'evidence-changed' })); };
      control.bumpLabel = () => { nodes = nodes.map(node => ({ ...node, label: '另一窗口的新标签', revision: node.revision + 1 })); };
      render();
    </script></body></html>`,
    }),
  )
  await page.goto('/review-knowledge-fixture')
  await expect(page.getByLabel('知识点标签', { exact: true })).toHaveValue('依法监督')
  await expect(page.getByRole('button', { name: '刷新索引', exact: true })).toBeEnabled()
}

type FixtureControl = {
  calls: Record<
    'refresh' | 'search' | 'label' | 'associate' | 'unlink' | 'remove' | 'pdf',
    unknown[]
  >
  deferSearch: boolean
  deferLabel: boolean
  deferRefresh: boolean
  noMatch: boolean
  rejectAssociation: boolean
  resolveSearch(): void
  resolveLabel(): void
  resolveRefresh(): void
  switchAttempt(): void
  unmount(): void
  remount(): void
  markStale(): void
  bumpLabel(): void
}
declare global {
  interface Window {
    reviewFixture: FixtureControl
  }
}

async function openSearch(page: Page) {
  await page.getByRole('button', { name: '关联 PDF 片段', exact: true }).click()
  await expect(page.getByLabel('物理起始页')).toHaveValue('1')
  await expect(page.getByLabel('物理结束页')).toHaveValue('1')
  await page.getByLabel('物理起始页').fill('2')
  await page.getByLabel('物理结束页').fill('2')
  await page.getByRole('button', { name: '在所选页码检索', exact: true }).click()
}

test('only explicitly confirmed same-subject bounded chunks persist, open real physical page, unlink preserves PDF', async ({
  page,
}) => {
  await fixture(page)
  const panel = page.getByTestId('review-knowledge')
  await panel.getByText('查看反馈来源', { exact: true }).click()
  await expect(
    panel.getByText('<img src=x onerror=alert(1)> 原始反馈', { exact: true }),
  ).toBeVisible()
  await expect(panel.locator('img')).toHaveCount(0)
  await openSearch(page)
  await expect(page.getByLabel('同学科已导入 PDF').locator('option')).toHaveCount(1)
  await expect(panel.locator('.review-knowledge-hits > li')).toHaveCount(4)
  await expect(panel.locator('.review-knowledge-hits script')).toHaveCount(0)
  expect(await page.evaluate(() => window.reviewFixture.calls.associate)).toEqual([])
  const choices = panel.getByRole('checkbox')
  await choices.nth(0).check()
  await choices.nth(1).check()
  await choices.nth(2).check()
  await expect(choices.nth(3)).toBeDisabled()
  await page
    .getByRole('button', { name: '确认关联所选 3 段', exact: true })
    .evaluate((button: HTMLButtonElement) => {
      button.click()
      button.click()
    })
  await expect(panel.getByText('已关联 · 用户确认', { exact: true })).toBeVisible()
  const calls = await page.evaluate(() => window.reviewFixture.calls)
  expect(calls.search).toEqual([
    { documentId, subject: 'politics', query: '依法监督', startPage: 2, endPage: 2, limit: 12 },
  ])
  expect(calls.associate).toEqual([
    { nodeId, expectedRevision: 1, chunkIds: [1, 2, 3].map((n) => `${documentId}:p2:c${n}`) },
  ])
  await panel.getByText('在 Agent 中使用此关联', { exact: true }).click()
  await expect(panel.getByLabel('Agent 索引编号', { exact: true })).toHaveValue(nodeId)
  await panel
    .getByRole('button', { name: '原创测试 PDF · PDF 物理第 2 页', exact: true })
    .first()
    .click()
  await expect(
    panel.getByRole('img', { name: '原创测试 PDF，PDF 物理第 2 页', exact: true }),
  ).toBeVisible()
  expect(await page.evaluate(() => window.reviewFixture.calls.pdf)).toEqual([documentId])
  await panel.getByRole('button', { name: '移除关联（保留 PDF）', exact: true }).click()
  await expect(panel.getByText('待关联', { exact: true })).toBeVisible()
  await expect(panel.getByText('关联已移除，PDF 原文件保留。', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.reviewFixture.calls.unlink)).toEqual([
    { nodeId, expectedRevision: 2 },
  ])
})

test('cancel, changed query and navigation suppress delayed results and never write to another attempt', async ({
  page,
}) => {
  await fixture(page)
  await page.evaluate(() => {
    window.reviewFixture.deferSearch = true
  })
  await openSearch(page)
  await page.getByRole('button', { name: '取消关联', exact: true }).click()
  await page.evaluate(() => window.reviewFixture.resolveSearch())
  await expect(page.locator('.review-knowledge-hits > li')).toHaveCount(0)
  await openSearch(page)
  await page.getByLabel('本地检索词', { exact: true }).fill('更新的检索词')
  await page.evaluate(() => window.reviewFixture.resolveSearch())
  await expect(page.locator('.review-knowledge-hits > li')).toHaveCount(0)
  await page.getByRole('button', { name: '在所选页码检索', exact: true }).click()
  await page.evaluate(() => {
    window.reviewFixture.switchAttempt()
    window.reviewFixture.resolveSearch()
  })
  await expect(page.getByLabel('知识点标签', { exact: true })).toHaveValue('另一份真实提交')
  await expect(page.locator('.review-knowledge-hits > li')).toHaveCount(0)
  expect(await page.evaluate(() => window.reviewFixture.calls.associate)).toEqual([])
  await expect(page.locator(`[data-node-id="${nodeId}"]`)).toHaveCount(0)
})

test('late label saves and refresh preserve newer edits; conflicts require refreshed explicit confirmation', async ({
  page,
}) => {
  await fixture(page)
  await page.evaluate(() => {
    window.reviewFixture.deferLabel = true
  })
  const input = page.getByLabel('知识点标签', { exact: true })
  await input.fill('提交的标签')
  await page
    .getByRole('button', { name: '保存标签', exact: true })
    .evaluate((button: HTMLButtonElement) => {
      button.click()
      button.click()
    })
  await input.fill('保存期间继续输入')
  await page.evaluate(() => window.reviewFixture.resolveLabel())
  await expect(page.getByText('标签已保存。', { exact: true })).toBeVisible()
  await expect(input).toHaveValue('保存期间继续输入')
  expect(await page.evaluate(() => window.reviewFixture.calls.label)).toEqual([
    { nodeId, expectedRevision: 1, label: '提交的标签' },
  ])
  await page.evaluate(() => window.reviewFixture.bumpLabel())
  await page.getByRole('button', { name: '刷新索引', exact: true }).click()
  await expect(page.getByRole('button', { name: '刷新索引', exact: true })).toBeEnabled()
  await expect(input).toHaveValue('保存期间继续输入')
  await page.evaluate(() => {
    window.reviewFixture.rejectAssociation = true
  })
  await openSearch(page)
  await page.getByRole('checkbox').first().check()
  await page.getByRole('button', { name: '确认关联所选 1 段', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('索引版本冲突')
  await expect(input).toHaveValue('保存期间继续输入')
  await expect(page.locator('.review-knowledge-hits > li')).toHaveCount(0)
  await expect(page.getByText('待关联', { exact: true })).toBeVisible()
})

test('no match stays pending, unmounted search stays ignored, and changed references cannot open a PDF', async ({
  page,
}) => {
  await fixture(page)
  await page.evaluate(() => {
    window.reviewFixture.noMatch = true
  })
  await openSearch(page)
  await expect(page.getByRole('status')).toContainText('未找到匹配片段')
  await expect(page.getByText('待关联', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.reviewFixture.calls.associate)).toEqual([])
  await page.evaluate(() => {
    window.reviewFixture.noMatch = false
    window.reviewFixture.deferSearch = true
  })
  await page.getByRole('button', { name: '在所选页码检索', exact: true }).click()
  await page.evaluate(() => {
    window.reviewFixture.unmount()
  })
  await expect(page.getByTestId('review-knowledge')).toHaveCount(0)
  await page.evaluate(() => {
    window.reviewFixture.resolveSearch()
    window.reviewFixture.deferSearch = false
    window.reviewFixture.remount()
  })
  await expect(page.getByRole('button', { name: '刷新索引', exact: true })).toBeEnabled()
  await openSearch(page)
  await page.getByRole('checkbox').first().check()
  await page.getByRole('button', { name: '确认关联所选 1 段', exact: true }).click()
  await page.evaluate(() => window.reviewFixture.markStale())
  await page.getByRole('button', { name: '原创测试 PDF · PDF 物理第 2 页', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('此关联已失效')
  await expect(page.getByText('已失效 · 待核对', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.reviewFixture.calls.pdf)).toEqual([])
})

for (const state of ['pending', 'linked', 'stale'] as const) {
  test(`explicitly removes a ${state} index once, preserves source, and refresh does not resurrect it`, async ({
    page,
  }) => {
    await fixture(page)
    if (state !== 'pending') {
      await openSearch(page)
      await page.getByRole('checkbox').first().check()
      await page.getByRole('button', { name: '确认关联所选 1 段', exact: true }).click()
    }
    if (state === 'stale') {
      await page.evaluate(() => window.reviewFixture.markStale())
      await page.getByRole('button', { name: '刷新索引', exact: true }).click()
      await expect(page.getByText('已失效 · 待核对', { exact: true })).toBeVisible()
    }
    await page.getByRole('button', { name: '移除此知识点索引', exact: true }).click()
    expect(await page.evaluate(() => window.reviewFixture.calls.remove)).toEqual([])
    await page.getByRole('button', { name: '保留知识点', exact: true }).click()
    await expect(page.getByLabel('知识点标签', { exact: true })).toHaveCount(1)
    await page.getByRole('button', { name: '移除此知识点索引', exact: true }).click()
    await page
      .getByRole('button', { name: '确认移除知识点', exact: true })
      .evaluate((button: HTMLButtonElement) => {
        button.click()
        button.click()
      })
    await expect(page.getByLabel('知识点标签', { exact: true })).toHaveCount(0)
    await expect(
      page.getByText('知识点索引已移除；提交记录与 PDF 均保留，刷新不会自动恢复。', {
        exact: true,
      }),
    ).toBeVisible()
    expect(await page.evaluate(() => window.reviewFixture.calls.remove)).toEqual([
      { nodeId, expectedRevision: state === 'pending' ? 1 : 2 },
    ])
    await page.getByRole('button', { name: '刷新索引', exact: true }).click()
    await expect(page.getByRole('button', { name: '刷新索引', exact: true })).toBeEnabled()
    await expect(page.getByLabel('知识点标签', { exact: true })).toHaveCount(0)
    expect(await page.evaluate(() => window.reviewFixture.calls.unlink)).toEqual([])
  })
}

test('refresh preserves edits made during the read even when the user returns to the old saved text', async ({
  page,
}) => {
  await fixture(page)
  const input = page.getByLabel('知识点标签', { exact: true })
  await page.evaluate(() => {
    window.reviewFixture.deferRefresh = true
    window.reviewFixture.bumpLabel()
  })
  await page.getByRole('button', { name: '刷新索引', exact: true }).click()
  await input.fill('X')
  await input.fill('依法监督')
  await page.evaluate(() => window.reviewFixture.resolveRefresh())
  await expect(page.getByRole('button', { name: '刷新索引', exact: true })).toBeEnabled()
  await expect(input).toHaveValue('依法监督')
  await expect(page.getByRole('button', { name: '保存标签', exact: true })).toBeEnabled()
  expect(await page.evaluate(() => window.reviewFixture.calls.label)).toEqual([])
})
