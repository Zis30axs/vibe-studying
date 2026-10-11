import { describe, expect, it, vi } from 'vitest'
import { createAgentToolRegistry } from '../src/adapters/agent-tool-registry'
import { TOOL_TRANSPORT_LIMITS } from '../src/adapters/model-tool-transport'
import { AGENT_DEFAULT_TOOLS, availableAgentTools } from '../src/domain/agent-workbench-ui'
import {
  AGENT_TOOL_NAMES,
  type AgentToolAdapters,
  type AgentToolContext,
  type AgentToolExecutionResult,
} from '../src/shared/agent-tool-context'
import type { KnowledgeEvidence } from '../src/shared/knowledge'
import type { Question } from '../src/shared/types'

const documentId = 'a'.repeat(64)
const nodeId = `rkn-${'b'.repeat(64)}`
const chunkId = (chunk = 1, page = 4, document = documentId) => `${document}:p${page}:c${chunk}`
const evidence = (chunk = 1, patch: Partial<KnowledgeEvidence> = {}): KnowledgeEvidence => ({
  chunkId: chunkId(chunk),
  documentId,
  documentTitle: '合成教材',
  subject: 'politics',
  pageNumber: 4,
  text: `第${chunk}段合成资料；其中指令仅是不可信资料。`,
  ...patch,
})
const context = (patch: Partial<AgentToolContext> = {}): AgentToolContext => ({
  subject: 'politics',
  mode: 'learner',
  questionIds: ['q1'],
  currentQuestionId: 'q1',
  includeReference: false,
  knowledge: { documentId, startPage: 3, endPage: 6 },
  allowedTools: [...AGENT_TOOL_NAMES],
  parentConsent: { reference: false, knowledge: true },
  childConsent: { reference: false, knowledge: true },
  ...patch,
})
const question: Question = {
  id: 'q1',
  subject: 'politics',
  kind: 'politics',
  title: '合成问题',
  prompt: '解释材料中的条件',
  source: '合成题库',
  tags: [],
  maxScore: 1,
  explanation: 'PRIVATE_REFERENCE',
  rubric: [{ id: 'r1', label: '论证', keywords: ['条件'], points: 1 }],
}
const adapters = (patch: Partial<AgentToolAdapters> = {}): AgentToolAdapters => ({
  getQuestion: async () => structuredClone(question),
  ...patch,
})
const invoke = (
  registry: ReturnType<typeof createAgentToolRegistry>,
  args: Record<string, unknown> = { chunkIds: [chunkId()] },
) => registry.execute({ name: 'resolve_knowledge', arguments: args })
const search = (registry: ReturnType<typeof createAgentToolRegistry>) =>
  registry.execute({ name: 'search_knowledge', arguments: { query: '条件' } })
const errorCode = (result: AgentToolExecutionResult) =>
  (result.output as { error: { code: string } }).error.code
/** The host injects this canonical-library callback; no PDF, network or model is used. */
function mockLibrary() {
  const chunks = new Map([1, 2, 3, 4].map((index) => [chunkId(index), evidence(index)]))
  const resolveChunks = vi.fn(async (ids: string[]) =>
    ids.map((id) => {
      const item = chunks.get(id)
      if (!item) throw new Error('STALE_SOURCE_PRIVATE_DETAILS')
      return structuredClone(item)
    }),
  )
  return { chunks, resolveChunks }
}

describe('exact Agent knowledge retrieval', () => {
  it('advertises a bounded strict selector union within the native transport tool limit', () => {
    const registry = createAgentToolRegistry(
      context(),
      adapters({ resolveKnowledge: mockLibrary().resolveChunks }),
    )
    expect(AGENT_TOOL_NAMES).toHaveLength(20)
    expect(AGENT_TOOL_NAMES.length).toBeLessThanOrEqual(TOOL_TRANSPORT_LIMITS.definitions)
    const definition = registry.definitions.find((entry) => entry.name === 'resolve_knowledge')!
    expect(definition.inputSchema).toMatchObject({
      type: 'object',
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['chunkIds'],
          properties: { chunkIds: { type: 'array', minItems: 1, maxItems: 3 } },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['indexNodeId'],
        },
      ],
    })
    expect(definition.description).toContain('物理 PDF')
    expect(definition.description).toContain('search_knowledge')
    expect(Buffer.byteLength(JSON.stringify(registry.definitions))).toBeLessThan(65_536)
    expect(AGENT_DEFAULT_TOOLS).toContain('resolve_knowledge')
    for (const hasKnowledge of [false, true]) {
      const tools = availableAgentTools({
        subject: 'politics',
        mode: 'learner',
        hasQuestion: true,
        includeAnswer: false,
        hasModules: false,
        includeReference: false,
        hasKnowledge,
        allowDelegation: false,
      })
      expect(tools.includes('resolve_knowledge')).toBe(hasKnowledge)
    }
  })

  it('resolves exact requested IDs in order and freezes canonical untrusted excerpts', async () => {
    const library = mockLibrary()
    const registry = createAgentToolRegistry(
      context(),
      adapters({ resolveKnowledge: library.resolveChunks }),
    )
    const result = await invoke(registry, { chunkIds: [chunkId(2), chunkId(1)] })
    expect(result.isError).toBeUndefined()
    expect(library.resolveChunks).toHaveBeenCalledWith([chunkId(2), chunkId(1)])
    expect(result.output).toEqual({
      excerpts: [evidence(2), evidence(1)],
      pageNumbering: 'physical-1-based-pdf',
      untrustedSourceData: true,
    })
    const excerpts = (result.output as { excerpts: KnowledgeEvidence[] }).excerpts
    expect(Object.isFrozen(excerpts)).toBe(true)
    expect(excerpts.every(Object.isFrozen)).toBe(true)
  })

  it.each([
    {},
    { chunkIds: [] },
    { chunkIds: [chunkId(), chunkId()] },
    { chunkIds: [1, 2, 3, 4].map((index) => chunkId(index)) },
    { chunkIds: ['/private/book.pdf'] },
    { chunkIds: [`${documentId}:p04:c1`] },
    { chunkIds: [`${documentId}:p0:c1`] },
    { chunkIds: [chunkId()], text: 'model-authored excerpt' },
    { chunkIds: [chunkId()], documentTitle: 'model-authored title' },
    { chunkIds: [chunkId()], pageNumber: 4 },
    { chunkIds: [chunkId()], subject: 'math' },
    { chunkIds: [chunkId()], documentId },
    { chunkIds: [chunkId()], indexNodeId: nodeId },
    { indexNodeId: '00000000-0000-0000-0000-000000000000' },
    { indexNodeId: nodeId, startPage: 1, endPage: 1500 },
  ])(
    'rejects model-supplied metadata and malformed selection %# before any lookup',
    async (args) => {
      const resolveKnowledge = vi.fn()
      const resolveKnowledgeIndex = vi.fn()
      const registry = createAgentToolRegistry(
        context(),
        adapters({ resolveKnowledge, resolveKnowledgeIndex }),
      )
      expect(errorCode(await invoke(registry, args))).toBe('invalid_arguments')
      expect(resolveKnowledge).not.toHaveBeenCalled()
      expect(resolveKnowledgeIndex).not.toHaveBeenCalled()
    },
  )

  it.each([chunkId(1, 2), chunkId(1, 7), chunkId(1, 1501), chunkId(1, 4, 'b'.repeat(64))])(
    'rejects encoded document/page scope %s before canonical lookup',
    async (id) => {
      const resolveKnowledge = vi.fn()
      const registry = createAgentToolRegistry(context(), adapters({ resolveKnowledge }))
      expect(errorCode(await invoke(registry, { chunkIds: [id] }))).toBe('scope_violation')
      expect(resolveKnowledge).not.toHaveBeenCalled()
    },
  )

  it.each([
    { parentConsent: { reference: false, knowledge: false } },
    { knowledge: undefined },
    { allowedTools: ['search_knowledge'] as AgentToolContext['allowedTools'] },
  ])(
    'requires new selected scope, tool grant and parent consent despite known index IDs %#',
    async (patch) => {
      const resolveKnowledge = vi.fn()
      const resolveKnowledgeIndex = vi.fn()
      const input = context(patch)
      if (!input.knowledge) delete input.knowledge
      const registry = createAgentToolRegistry(
        input,
        adapters({ resolveKnowledge, resolveKnowledgeIndex }),
      )
      expect(registry.definitions.map((entry) => entry.name)).not.toContain('resolve_knowledge')
      expect(errorCode(await invoke(registry))).toBe('forbidden')
      expect(errorCode(await invoke(registry, { indexNodeId: nodeId }))).toBe('forbidden')
      expect(resolveKnowledge).not.toHaveBeenCalled()
      expect(resolveKnowledgeIndex).not.toHaveBeenCalled()
    },
  )

  it('requires the selected resolver adapter even if the other route is available', async () => {
    const none = createAgentToolRegistry(context(), adapters())
    expect(errorCode(await invoke(none))).toBe('forbidden')
    const indexOnly = createAgentToolRegistry(
      context(),
      adapters({ resolveKnowledgeIndex: vi.fn() }),
    )
    expect(errorCode(await invoke(indexOnly))).toBe('unavailable')
    const chunksOnly = createAgentToolRegistry(
      context(),
      adapters({ resolveKnowledge: mockLibrary().resolveChunks }),
    )
    expect(errorCode(await invoke(chunksOnly, { indexNodeId: nodeId }))).toBe('unavailable')
  })

  it.each([
    evidence(1, { subject: 'math' }),
    evidence(1, { documentId: 'b'.repeat(64) }),
    evidence(1, { pageNumber: 7, chunkId: chunkId(1, 7) }),
    evidence(1, { pageNumber: 5 }),
    evidence(1, { chunkId: chunkId(1, 5) }),
  ])('rejects canonical identity/scope mismatch %# after lookup', async (item) => {
    const registry = createAgentToolRegistry(
      context(),
      adapters({ resolveKnowledge: async () => [item] }),
    )
    expect(errorCode(await invoke(registry))).toBe('scope_violation')
  })

  it.each([
    { result: [], code: 'invalid_result' },
    { result: [evidence(1)], code: 'invalid_result' },
    { result: [evidence(2), evidence(1)], code: 'invalid_result' },
    { result: [evidence(1), evidence(3)], code: 'invalid_result' },
    { result: [evidence(1), evidence(1)], code: 'scope_violation' },
    { result: [evidence(1), evidence(2), evidence(3)], code: 'invalid_result' },
    { result: [evidence(1, { text: 'x'.repeat(1201) }), evidence(2)], code: 'invalid_result' },
  ])('rejects missing, reordered, duplicate, replaced and unbounded results %#', async (item) => {
    const registry = createAgentToolRegistry(
      context(),
      adapters({ resolveKnowledge: async () => item.result }),
    )
    expect(errorCode(await invoke(registry, { chunkIds: [chunkId(1), chunkId(2)] }))).toBe(
      item.code,
    )
  })

  it('keeps requested IDs immutable across an adapter that mutates its input', async () => {
    const registry = createAgentToolRegistry(
      context(),
      adapters({
        resolveKnowledge: async (ids) => {
          ids[0] = chunkId(2)
          return [evidence(2)]
        },
      }),
    )
    expect(errorCode(await invoke(registry))).toBe('invalid_result')
  })

  it('sanitizes stale chunk failures without disclosing source details', async () => {
    const library = mockLibrary()
    const registry = createAgentToolRegistry(
      context(),
      adapters({ resolveKnowledge: library.resolveChunks }),
    )
    library.chunks.delete(chunkId())
    const result = await invoke(registry)
    expect(errorCode(result)).toBe('tool_failed')
    expect(JSON.stringify(result)).not.toMatch(/STALE_SOURCE|excerpts|合成资料/)
  })

  it.each(['search-first', 'resolve-first'])(
    'shares the cumulative disclosure budget: %s',
    async (order) => {
      const library = mockLibrary()
      const searchKnowledge = vi.fn(async () => [evidence(1), evidence(2)])
      const registry = createAgentToolRegistry(
        context(),
        adapters({ searchKnowledge, resolveKnowledge: library.resolveChunks }),
      )
      if (order === 'search-first') {
        expect((await search(registry)).isError).toBeUndefined()
        expect(
          (await invoke(registry, { chunkIds: [chunkId(2), chunkId(3)] })).isError,
        ).toBeUndefined()
        expect(errorCode(await invoke(registry, { chunkIds: [chunkId(4)] }))).toBe(
          'knowledge_limit',
        )
        expect(library.resolveChunks).toHaveBeenCalledTimes(1)
      } else {
        expect(
          (await invoke(registry, { chunkIds: [chunkId(2), chunkId(3)] })).isError,
        ).toBeUndefined()
        expect((await search(registry)).isError).toBeUndefined()
        searchKnowledge.mockResolvedValueOnce([evidence(4)])
        expect(errorCode(await search(registry))).toBe('knowledge_limit')
      }
      expect(
        (await invoke(registry, { chunkIds: [chunkId(1), chunkId(2), chunkId(3)] })).isError,
      ).toBeUndefined()
    },
  )

  it.each(['search-first', 'resolve-first'])(
    'rejects changed text for an already disclosed ID: %s',
    async (order) => {
      const searchKnowledge = vi.fn(async () => [evidence()])
      const resolveKnowledge = vi.fn(async () => [evidence()])
      const registry = createAgentToolRegistry(
        context(),
        adapters({ searchKnowledge, resolveKnowledge }),
      )
      if (order === 'search-first') {
        await search(registry)
        resolveKnowledge.mockResolvedValueOnce([evidence(1, { text: 'CHANGED_PRIVATE_TEXT' })])
        expect(errorCode(await invoke(registry))).toBe('invalid_result')
      } else {
        await invoke(registry)
        searchKnowledge.mockResolvedValueOnce([evidence(1, { text: 'CHANGED_PRIVATE_TEXT' })])
        expect(errorCode(await search(registry))).toBe('invalid_result')
      }
      expect((await invoke(registry)).isError).toBeUndefined()
    },
  )

  it('does not consume the ledger after a rejected result', async () => {
    const resolveKnowledge = vi.fn(async () => [evidence(3), evidence(2)])
    const registry = createAgentToolRegistry(context(), adapters({ resolveKnowledge }))
    expect(errorCode(await invoke(registry, { chunkIds: [chunkId(1), chunkId(2)] }))).toBe(
      'invalid_result',
    )
    resolveKnowledge.mockResolvedValueOnce([evidence(1), evidence(2), evidence(4)])
    expect(
      (await invoke(registry, { chunkIds: [chunkId(1), chunkId(2), chunkId(4)] })).isError,
    ).toBeUndefined()
  })

  it('passes only successfully resolved frozen evidence to a consenting Advisor', async () => {
    const source = evidence()
    const adviseSelection = vi.fn<NonNullable<AgentToolAdapters['adviseSelection']>>(async () => ({
      requestId: 'unused',
      hint: '请核对条件。',
      evidenceStatus: 'supported',
      citations: [
        { chunkId: source.chunkId, documentId, documentTitle: 'ignored', pageNumber: 99 },
      ],
    }))
    const registry = createAgentToolRegistry(
      context(),
      adapters({ resolveKnowledge: async () => [source], adviseSelection }),
    )
    const advisorCall = {
      name: 'advise_selection',
      arguments: { source: 'question', selectedText: '解释材料', useKnowledge: true },
    }
    expect(errorCode(await registry.execute(advisorCall))).toBe('forbidden')
    const result = await invoke(registry)
    source.text = 'mutated after retrieval'
    expect(() => {
      ;(result.output as { excerpts: KnowledgeEvidence[] }).excerpts[0].text = 'mutated output'
    }).toThrow()
    const hint = await registry.execute(advisorCall)
    expect(hint.output).toMatchObject({
      citations: [{ chunkId: chunkId(), documentTitle: '合成教材', pageNumber: 4 }],
    })
    const [advisor, metadata] = adviseSelection.mock.calls[0]
    expect(advisor.knowledgeExcerpts?.[0].text).toBe(evidence().text)
    expect(Object.isFrozen(advisor.knowledgeExcerpts?.[0])).toBe(true)
    expect(metadata.evidence).toEqual([evidence()])
    expect(JSON.stringify(advisor)).not.toContain('PRIVATE_REFERENCE')

    const withoutChildConsent = createAgentToolRegistry(
      context({ childConsent: { reference: false, knowledge: false } }),
      adapters({ resolveKnowledge: async () => [evidence()], adviseSelection }),
    )
    await invoke(withoutChildConsent)
    expect(errorCode(await withoutChildConsent.execute(advisorCall))).toBe('forbidden')
    expect(adviseSelection).toHaveBeenCalledTimes(1)
  })
})

describe('review-index exact retrieval boundary', () => {
  it('injects only the selected scope and returns canonical source evidence without index metadata', async () => {
    const input = context()
    const resolveKnowledgeIndex = vi.fn(async () => [evidence()])
    const registry = createAgentToolRegistry(input, adapters({ resolveKnowledgeIndex }))
    input.knowledge!.startPage = 1
    input.subject = 'math'
    const result = await invoke(registry, { indexNodeId: nodeId })
    expect(resolveKnowledgeIndex).toHaveBeenCalledWith({
      nodeId,
      documentId,
      startPage: 3,
      endPage: 6,
      subject: 'politics',
    })
    expect(result.output).toEqual({
      excerpts: [evidence()],
      pageNumbering: 'physical-1-based-pdf',
      untrustedSourceData: true,
    })
    expect(JSON.stringify(result)).not.toMatch(/indexNodeId|reviewExcerpt|label/)
  })

  it.each(
    [
      [],
      [evidence(), evidence()],
      [evidence(1, { subject: 'math' })],
      [evidence(1, { documentId: 'b'.repeat(64), chunkId: chunkId(1, 4, 'b'.repeat(64)) })],
      [evidence(1, { pageNumber: 7, chunkId: chunkId(1, 7) })],
      [evidence(1), evidence(2), evidence(3), evidence(4)],
      [{ ...evidence(), reviewExcerpt: 'PRIVATE_REVIEW' }],
    ].map((items) => ({ items })),
  )(
    'rejects empty, duplicate, out-of-scope or metadata-bearing index results %#',
    async ({ items }) => {
      const registry = createAgentToolRegistry(
        context(),
        adapters({ resolveKnowledgeIndex: async () => items }),
      )
      const result = await invoke(registry, { indexNodeId: nodeId })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result)).not.toMatch(/excerpts|PRIVATE_REVIEW|合成资料/)
    },
  )

  it('keeps unknown or stale index details private and requires a valid canonical result', async () => {
    const resolveKnowledgeIndex = vi.fn(async () => {
      throw new Error('STALE_INDEX_PRIVATE_REVIEW')
    })
    const registry = createAgentToolRegistry(context(), adapters({ resolveKnowledgeIndex }))
    const result = await invoke(registry, { indexNodeId: nodeId })
    expect(errorCode(result)).toBe('tool_failed')
    expect(JSON.stringify(result)).not.toMatch(/STALE_INDEX|PRIVATE_REVIEW|excerpts/)
  })

  it('shares the three-excerpt budget and same-ID integrity with both other retrieval paths', async () => {
    const resolveKnowledgeIndex = vi.fn(async () => [evidence(1), evidence(2)])
    const searchKnowledge = vi.fn(async () => [evidence(3)])
    const registry = createAgentToolRegistry(
      context(),
      adapters({
        resolveKnowledgeIndex,
        searchKnowledge,
        resolveKnowledge: mockLibrary().resolveChunks,
      }),
    )
    expect((await invoke(registry, { indexNodeId: nodeId })).isError).toBeUndefined()
    expect((await search(registry)).isError).toBeUndefined()
    expect((await invoke(registry, { chunkIds: [chunkId(1), chunkId(3)] })).isError).toBeUndefined()
    resolveKnowledgeIndex.mockResolvedValueOnce([evidence(4)])
    expect(errorCode(await invoke(registry, { indexNodeId: nodeId }))).toBe('knowledge_limit')
    resolveKnowledgeIndex.mockResolvedValueOnce([evidence(1, { text: 'changed canonical text' })])
    expect(errorCode(await invoke(registry, { indexNodeId: nodeId }))).toBe('invalid_result')
    expect((await invoke(registry, { indexNodeId: nodeId })).isError).toBeUndefined()
  })
})
