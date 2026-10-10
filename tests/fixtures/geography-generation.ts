import type { GeographyFigure, Question } from '../../src/shared/types'

export const exampleFigure: GeographyFigure = {
  version: 1,
  kind: 'schematic',
  title: '河流上、下游示意图',
  description: '箭头表示河流流向；示意图不对应实际地点。',
  points: [
    { id: 'up', x: -50, y: 40, label: '上游' },
    { id: 'down', x: 50, y: -40, label: '下游' },
  ],
  segments: [],
  arrows: [{ id: 'flow', from: 'up', to: 'down' }],
  polylines: [],
  polygons: [],
  labels: [],
  grid: { step: 20 },
}
export const exampleGeneratedQuestion: Question = {
  id: 'generated-geography-example',
  subject: 'geography',
  kind: 'geography',
  title: '河流侵蚀与堆积',
  prompt: '读图，比较河流上游与下游的典型地貌过程。',
  source: 'AI 生成 · 未经人工核实',
  tags: ['河流地貌'],
  maxScore: 4,
  explanation: '一般情况下，上游坡降较大，侵蚀较强；下游流速减缓时易发生堆积。需结合具体条件判断。',
  rubric: [{ id: 'erosion', label: '侵蚀与堆积', keywords: ['侵蚀', '堆积'], points: 4 }],
  figure: exampleFigure,
  provenance: {
    kind: 'ai-generated',
    model: 'fixture-model',
    protocol: 'openai-chat',
    generatedAt: '2026-10-10T12:00:00Z',
    verified: false,
  },
}
