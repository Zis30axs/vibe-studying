import { createElement } from 'react'
import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { LearningGraph } from '../src/components/LearningGraph'
import {
  appendLearningEvent,
  beginLearningHelp,
  captureLearningSnapshot,
  emptyLearningGraph,
} from '../src/domain/learning-graph'
import { emptyDraft } from '../src/shared/types'
it('renders semantic color plus labels, inert hint text and expandable trace without fake submissions', () => {
  let graph = captureLearningSnapshot(
    emptyLearningGraph(),
    {
      questionId: 'q1',
      subject: 'math',
      draft: { ...emptyDraft('math'), text: '自己的解法' },
      initialOrigin: 'independent',
    },
    's1',
    10,
  ).graph
  graph = beginLearningHelp(
    graph,
    { snapshotId: 's1', requestId: 'r1', kind: 'agent' },
    'b1',
    20,
  ).graph
  graph = appendLearningEvent(graph, {
    id: 'tool1',
    createdAt: 21,
    type: 'tool',
    branchId: 'b1',
    trace: { tool: 'get_question', outcome: 'completed' },
  })
  graph = appendLearningEvent(graph, {
    id: 'received',
    createdAt: 30,
    type: 'help-received',
    branchId: 'b1',
    detail: { response: '<script>alert("x")</script>' },
  })
  const html = renderToStaticMarkup(createElement(LearningGraph, { graph }))
  expect(html).toContain('参考过 AI')
  expect(html).toContain('已收到提示 · 未合并')
  expect(html).toContain('data-assistance="referenced-ai"')
  expect(html).toContain('工具轨迹')
  expect(html).toContain('&lt;script&gt;')
  expect(html).not.toContain('<script>')
  expect(html).not.toContain('查看真实提交')
  expect(html).not.toContain('恢复此快照')
})
