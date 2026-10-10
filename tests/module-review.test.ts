import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelService } from '../src/adapters/model-service'
import { DeepSeekAgent } from '../src/adapters/deepseek-agent'
import { emptyDraft } from '../src/shared/types'
import {
  applyModuleSuggestion,
  MODULE_REVIEW_PROMPT,
  validateModuleReviewRequest,
  validateModuleReviewResult,
} from '../src/domain/module-review'
import type {
  ArgumentDocument,
  ModelProtocol,
  ModuleReviewRequest,
  ModuleReviewSuggestion,
  Question,
} from '../src/shared/types'

const trustedQuestion: Question = {
  id: 'private-question-id',
  subject: 'history',
  kind: 'history',
  prompt: '解释这一因果关系。',
  title: '合成题',
  source: '合成测试',
  tags: [],
  maxScore: 1,
  explanation: 'PRIVATE_REFERENCE',
  rubric: [{ id: 'logic', label: 'PRIVATE_RUBRIC', keywords: ['原因'], points: 1 }],
}
const request = (): ModuleReviewRequest => ({
  requestId: 'review-1',
  cloudConsent: true,
  configRevision: 1,
  scope: 'selected',
  questionId: 'private-question-id',
  includeReference: false,
  roots: [{ id: 'module-1', kind: 'analysis', text: '只有一个原因。', children: [] }],
})
const suggestion = (): ModuleReviewSuggestion => ({
  id: 'issue-1',
  moduleId: 'module-1',
  priority: 'must-fix',
  reason: '单一归因缺少依据。',
  evidence: '“只有”排除了未经讨论的可能性。',
  edit: {
    operation: 'replace',
    baseText: '只有一个原因。',
    start: 0,
    end: 2,
    expectedText: '只有',
    replacement: '其中',
  },
})
const raw = () => ({
  summary: '有一处需要收窄结论。',
  confirmations: [],
  suggestions: [suggestion()],
})
const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})
async function service(fetchImpl: typeof fetch, protocol: ModelProtocol = 'openai-chat') {
  const directory = await mkdtemp(join(tmpdir(), 'module-review-'))
  directories.push(directory)
  const models = new ModelService(directory, {
    fetchImpl,
    resolveQuestion: (id) => (id === trustedQuestion.id ? trustedQuestion : undefined),
  })
  const config = await models.saveConfig({
    protocol,
    baseUrl: 'https://api.vendor.com/v1',
    model: 'test-model',
    apiKey: 'synthetic-key-never-real',
  })
  return { models, config }
}
function envelope(protocol: ModelProtocol, output: unknown) {
  const text = JSON.stringify(output)
  if (protocol === 'anthropic')
    return { stop_reason: 'end_turn', content: [{ type: 'text', text }] }
  if (protocol === 'gemini')
    return { candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] }
  if (protocol === 'openai-responses')
    return {
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
    }
  return { choices: [{ finish_reason: 'stop', message: { content: text } }] }
}

describe('module review trust boundaries', () => {
  it('allows a grounded clean review with no suggestions or praise', () => {
    expect(
      validateModuleReviewResult(
        { summary: '未发现值得修改的实质问题。', confirmations: [], suggestions: [] },
        request(),
      ).suggestions,
    ).toEqual([])
    expect(MODULE_REVIEW_PROMPT).toContain('允许零建议')
    expect(MODULE_REVIEW_PROMPT).toContain('不得编造评分项')
  })
  it('validates and clones exact bounded logical roots without trimming', () => {
    const input = request()
    input.roots[0].text = '  保留原文  '
    const result = validateModuleReviewRequest(input)
    input.roots[0].text = 'changed'
    expect(result.roots[0].text).toBe('  保留原文  ')
  })
  it.each([
    (r: any) => {
      r.cloudConsent = false
    },
    (r: any) => {
      r.roots[0].canvas = {}
    },
    (r: any) => {
      r.history = []
    },
    (r: any) => {
      r.finalAnswer = 'private'
    },
    (r: any) => {
      r.question = { explanation: 'private', rubric: [] }
    },
    (r: any) => {
      r.roots.push(structuredClone(r.roots[0]))
    },
    (r: any) => {
      r.roots[0].text = 'x'.repeat(4001)
    },
    (r: any) => {
      r.roots[0].kind = 'cause'
      r.roots[0].children.push(r.roots[0])
    },
    (r: any) => {
      r.roots = []
    },
    (r: any) => {
      r.selectedSpans = [{ moduleId: 'module-1', start: 0, end: 2, expectedText: 'wrong' }]
    },
  ])('rejects unauthorized or malformed input before transport', (mutate) => {
    const input = request()
    mutate(input)
    expect(() => validateModuleReviewRequest(input)).toThrow(/范围/)
  })
  it.each([
    (r: any) => {
      r.suggestions[0].moduleId = 'outside'
    },
    (r: any) => {
      r.suggestions[0].edit.operation = 'delete'
    },
    (r: any) => {
      r.suggestions[0].edit.baseText = 'stale'
    },
    (r: any) => {
      r.suggestions[0].edit.start = -1
    },
    (r: any) => {
      r.suggestions[0].edit.start = 0.5
    },
    (r: any) => {
      r.suggestions[0].edit.end = 4000
    },
    (r: any) => {
      r.suggestions[0].edit.expectedText = 'wrong'
    },
    (r: any) => {
      r.suggestions[0].edit.replacement = 'x'.repeat(4000)
    },
    (r: any) => {
      r.suggestions[0].priority = 'uncertain'
    },
    (r: any) => {
      r.suggestions[0].action = 'execute'
    },
    (r: any) => {
      r.suggestions = Array.from({ length: 6 }, (_, i) => ({ ...suggestion(), id: `issue-${i}` }))
    },
    (r: any) => {
      r.suggestions.push(suggestion())
    },
    (r: any) => {
      r.confirmations = [{ moduleId: 'outside', text: 'good' }]
    },
  ])('rejects malformed, stale or out-of-scope model actions', (mutate) => {
    const output = raw()
    mutate(output)
    expect(() => validateModuleReviewResult(output, request())).toThrow(/范围/)
  })
  it('binds focused edits to the exact selected span, other modules are context only', () => {
    const input = request()
    input.selectedSpans = [{ moduleId: 'module-1', start: 0, end: 2, expectedText: '只有' }]
    expect(validateModuleReviewResult(raw(), input).suggestions).toHaveLength(1)
    input.selectedSpans[0] = { moduleId: 'module-1', start: 1, end: 2, expectedText: '有' }
    expect(() => validateModuleReviewResult(raw(), input)).toThrow()
    input.roots.push({ id: 'context', kind: 'material', text: '背景', children: [] })
    input.selectedSpans = [{ moduleId: 'context', start: 0, end: 2, expectedText: '背景' }]
    expect(() => validateModuleReviewResult(raw(), input)).toThrow()
  })
  it('rejects surrogate-splitting text ranges', () => {
    const input = request()
    input.roots[0].text = '🙂文字'
    input.selectedSpans = [{ moduleId: 'module-1', start: 1, end: 2, expectedText: '\ude42' }]
    expect(() => validateModuleReviewRequest(input)).toThrow()
  })
  it('treats prototype-named suggestion IDs as opaque strings', () => {
    const output = raw()
    output.suggestions[0].id = 'constructor'
    expect(validateModuleReviewResult(output, request()).suggestions[0].id).toBe('constructor')
    output.suggestions[0].id = 'toString'
    expect(validateModuleReviewResult(output, request()).suggestions[0].id).toBe('toString')
  })
  it('acceptance edits only target text without mutation or geometry loss', () => {
    const document: ArgumentDocument = {
      version: 1,
      roots: request().roots,
      canvas: { positions: { 'module-1': { x: 50, y: 20 } }, viewport: { x: 1, y: 2, zoom: 1 } },
    }
    document.revisions = {
      headId: 'revision-1',
      nodes: [
        {
          id: 'revision-1',
          parentId: null,
          label: 'Original',
          createdAt: 1,
          source: 'manual',
          snapshot: { roots: structuredClone(document.roots) },
        },
      ],
    }
    const before = structuredClone(document)
    const next = applyModuleSuggestion(document, suggestion())
    expect(next.roots[0].text).toBe('其中一个原因。')
    expect(document.roots[0].text).toBe('只有一个原因。')
    expect(next.canvas).toEqual(document.canvas)
    expect(next.revisions).toEqual(document.revisions)
    expect(document).toEqual(before)
    expect(() => applyModuleSuggestion(next, suggestion())).toThrow(/已更改/)
    const malicious = suggestion()
    malicious.edit!.operation = 'delete' as any
    expect(() => applyModuleSuggestion(document, malicious)).toThrow()
    malicious.edit!.operation = 'replace'
    malicious.moduleId = 'missing'
    expect(() => applyModuleSuggestion(document, malicious)).toThrow()
  })
})

describe.each<ModelProtocol>(['anthropic', 'gemini', 'openai-responses', 'openai-chat'])(
  '%s module review transport (mock only)',
  (protocol) => {
    it('uses trusted reference and rubric only with explicit reference consent', async () => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => new Response(JSON.stringify(envelope(protocol, raw()))))
      const { models } = await service(fetcher, protocol)
      for (const includeReference of [false, true]) {
        await models.reviewModules({ ...request(), includeReference })
        const body = JSON.parse(String(fetcher.mock.calls.at(-1)![1]?.body))
        const data = JSON.parse(
          protocol === 'gemini'
            ? body.contents[0].parts[0].text
            : protocol === 'openai-responses'
              ? body.input
              : body.messages.at(-1).content,
        )
        expect(data.question.reference).toBe(
          includeReference ? trustedQuestion.explanation : undefined,
        )
        expect(data.question.rubric).toEqual(includeReference ? trustedQuestion.rubric : undefined)
        expect(data.roots).toEqual(request().roots)
        expect(Object.keys(data)).toEqual(['scope', 'question', 'roots'])
      }
    })
    it('sends bounded logical context, not identity, final body, geometry, history or consent tokens', async () => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(envelope(protocol, raw()))))
      const { models } = await service(fetcher, protocol)
      const result = await models.reviewModules(request())
      expect(result.suggestions).toHaveLength(1)
      expect(result.configRevision).toBe(1)
      const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body))
      const data = JSON.parse(
        protocol === 'gemini'
          ? body.contents[0].parts[0].text
          : protocol === 'openai-responses'
            ? body.input
            : body.messages.at(-1).content,
      )
      expect(data).toEqual({
        scope: 'selected',
        question: { subject: 'history', prompt: '解释这一因果关系。' },
        roots: request().roots,
      })
      expect(JSON.stringify(data)).not.toMatch(
        /private-question-id|configRevision|cloudConsent|"canvas":|"history":|"revisions":|"finalAnswer":|"account":/,
      )
    })
  },
)
it('refuses no consent and stale model consent without any network request', async () => {
  const fetcher = vi.fn<typeof fetch>()
  const { models } = await service(fetcher)
  await expect(models.reviewModules({ ...request(), cloudConsent: false })).rejects.toThrow()
  await expect(models.reviewModules({ ...request(), configRevision: 0 })).rejects.toThrow(/更改/)
  expect(fetcher).not.toHaveBeenCalled()
})
it('cancels module work even when the mocked provider never resolves', async () => {
  let called!: () => void
  const started = new Promise<void>((resolve) => {
    called = resolve
  })
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
    called()
    return new Promise(() => {})
  })
  const { models } = await service(fetcher)
  const pending = models.reviewModules(request())
  await started
  models.cancelAdvisor('review-1') // Separate namespace.
  models.cancelModuleReview('review-1')
  await expect(pending).rejects.toThrow(/取消/)
})
it('cancels an in-flight review on model configuration changes', async () => {
  let called!: () => void
  const started = new Promise<void>((resolve) => {
    called = resolve
  })
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
    called()
    return new Promise(() => {})
  })
  const { models } = await service(fetcher)
  const pending = models.reviewModules(request())
  const assertion = expect(pending).rejects.toThrow(/取消|更改/)
  await started
  await models.saveConfig({
    protocol: 'openai-chat',
    baseUrl: 'https://api.vendor.com/v1',
    model: 'next-model',
  })
  await assertion
})

it('cloud graders omit revision snapshots and geometry (mock-only)', async () => {
  const document: ArgumentDocument = {
    version: 1,
    roots: request().roots,
    canvas: { positions: { 'module-1': { x: 222, y: 333 } }, viewport: { x: 0, y: 0, zoom: 1 } },
    revisions: {
      headId: 'revision-1',
      nodes: [
        {
          id: 'revision-1',
          parentId: null,
          label: 'private-history-label',
          createdAt: 1,
          source: 'manual',
          snapshot: {
            roots: [
              { id: 'module-1', kind: 'analysis', text: 'private historical answer', children: [] },
            ],
          },
        },
      ],
    },
  }
  const question = {
    ...trustedQuestion,
    kind: 'history' as const,
    title: '题目',
    source: '合成测试',
    tags: [],
    maxScore: 1,
    explanation: '参考',
    rubric: [{ id: 'logic', label: '逻辑', keywords: ['原因'], points: 1 }],
  }
  const draft = { ...emptyDraft(), text: 'Current final answer.', argument: document }
  for (const protocol of [
    'anthropic',
    'gemini',
    'openai-responses',
    'openai-chat',
    'legacy-deepseek',
  ] as const) {
    const provider = protocol === 'legacy-deepseek' ? 'openai-chat' : protocol
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify(
          envelope(provider, {
            feedback: '已检查',
            explanation: '依据',
            rubric: [{ id: 'logic', earned: 1, feedback: '已检查' }],
          }),
        ),
      ),
    )
    if (protocol === 'legacy-deepseek')
      await new DeepSeekAgent({ apiKey: 'synthetic-key-never-real', fetchImpl: fetcher }).review(
        question,
        draft,
      )
    else {
      const { models } = await service(fetcher, provider)
      await (await models.reviewer(1)).review(question, draft)
    }
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body))
    const data = JSON.parse(
      provider === 'gemini'
        ? body.contents[0].parts[0].text
        : provider === 'openai-responses'
          ? body.input
          : body.messages.at(-1).content,
    )
    expect(data.answer.argument).toEqual({ version: 1, roots: document.roots })
    expect(JSON.stringify(data)).not.toMatch(
      /private historical|private-history-label|revision-1|"canvas":|"revisions":/,
    )
  }
})

it('rejects missing or unknown question IDs, missing reference choice, and renderer-authored reference data', async () => {
  const fetcher = vi.fn<typeof fetch>()
  const { models } = await service(fetcher)
  for (const input of [
    { ...request(), questionId: undefined },
    { ...request(), questionId: 'missing' },
    { ...request(), includeReference: undefined },
    { ...request(), question: trustedQuestion },
    { ...request(), rubric: trustedQuestion.rubric },
  ])
    await expect(models.reviewModules(input as any)).rejects.toThrow()
  expect(fetcher).not.toHaveBeenCalled()
})
