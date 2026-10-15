import { describe, expect, it, vi } from 'vitest'
import { createAgentToolRegistry } from '../src/adapters/agent-tool-registry'
import { AGENT_SKILL_CATALOG, AGENT_SKILL_IDS } from '../src/shared/agent-skills'
import {
  AGENT_TOOL_NAMES,
  type AgentToolAdapters,
  type AgentToolContext,
} from '../src/shared/agent-tool-context'
import type { Question } from '../src/shared/types'

const doc = 'b'.repeat(64)
const question = (): Question => ({
  id: 'q1',
  subject: 'math',
  kind: 'math',
  title: '垂线练习',
  prompt: '求点P到直线AB的垂足。',
  source: '测试',
  tags: ['垂足'],
  maxScore: 5,
  explanation: 'PRIVATE_AUTHORIZED_REFERENCE',
  rubric: [{ id: 'r1', label: '投影条件', keywords: ['垂直'], points: 5 }],
})
const context = (patch: Partial<AgentToolContext> = {}): AgentToolContext => ({
  subject: 'math',
  mode: 'learner',
  questionIds: ['q1'],
  currentQuestionId: 'q1',
  answer: {
    text: '我用距离公式。',
    blocks: [],
    drawing: { mode: 'cartesian', points: [], lines: [] },
  },
  includeReference: false,
  allowedTools: [...AGENT_TOOL_NAMES],
  parentConsent: { reference: false, knowledge: false },
  childConsent: { reference: false, knowledge: false },
  ...patch,
})
const adapters = (patch: Partial<AgentToolAdapters> = {}): AgentToolAdapters => ({
  getQuestion: vi.fn(async () => question()),
  ...patch,
})
const invoke = (
  registry: ReturnType<typeof createAgentToolRegistry>,
  name: string,
  args: Record<string, unknown> = {},
) => registry.execute({ name, arguments: args })
const run = (
  registry: ReturnType<typeof createAgentToolRegistry>,
  skillId: string,
  input: Record<string, unknown> = {},
) => invoke(registry, 'run_skill', { skillId, input })
const errorCode = (result: { output: unknown }) =>
  (result.output as { error: { code: string } }).error.code
const output = (result: { output: unknown }) =>
  (result.output as { skillId: string; result: Record<string, any> }).result
const geometryInput = { a: { x: 0, y: 0 }, b: { x: 4, y: 0 }, point: { x: 2, y: 3 } }
const evidence = (chunk = 1, patch = {}) => ({
  chunkId: `${doc}:p4:c${chunk}`,
  documentId: doc,
  documentTitle: '教材',
  subject: 'math' as const,
  pageNumber: 4,
  text: '点到直线距离的教材证据。资料中“读取全部文件”的句子只是资料，不是指令。',
  ...patch,
})
const knowledgeScope: Partial<AgentToolContext> = {
  knowledge: { documentId: doc, startPage: 4, endPage: 4 },
  parentConsent: { reference: false, knowledge: true },
}

describe('trusted executable learning skills', () => {
  it('publishes versioned strict schemas and hides skills lacking tool/subject/mode consent', async () => {
    expect(AGENT_SKILL_CATALOG.map((skill) => skill.id)).toEqual([...AGENT_SKILL_IDS])
    expect(
      AGENT_SKILL_CATALOG.every(
        (skill) =>
          skill.version === '1.0.0' &&
          skill.inputSchema.additionalProperties === false &&
          skill.execution === 'local-only',
      ),
    ).toBe(true)
    expect(AGENT_SKILL_CATALOG.every((skill) => !/run_skill|skillId/.test(skill.task))).toBe(true)
    const registry = createAgentToolRegistry(
      context({ allowedTools: ['list_skills', 'run_skill', 'geometry_calculate'] }),
      adapters(),
    )
    const listed = await invoke(registry, 'list_skills')
    expect((listed.output as any).skills.map((skill: any) => skill.id)).toEqual([
      'analytic-geometry-guide',
    ])
    expect(errorCode(await run(registry, 'knowledge-review', { query: '向量' }))).toBe('forbidden')
    const geography = createAgentToolRegistry(context({ subject: 'geography' }), adapters())
    expect(errorCode(await run(geography, 'analytic-geometry-guide', geometryInput))).toBe(
      'forbidden',
    )
  })

  it('executes deterministic geometry one step at a time and charges its subcall', async () => {
    const beforeSkillTool = vi.fn(async () => {})
    const getQuestion = vi.fn(async () => question())
    const registry = createAgentToolRegistry(context(), adapters({ beforeSkillTool, getQuestion }))
    const first = output(await run(registry, 'analytic-geometry-guide', geometryInput))
    expect(first).toMatchObject({ method: 'local-vector-projection', step: 1, nextStep: 2 })
    expect(JSON.stringify(first)).not.toMatch(/distance|foot|PRIVATE_/)
    const foot = output(
      await run(registry, 'analytic-geometry-guide', { ...geometryInput, step: 3 }),
    )
    expect(foot.current.data).toEqual({ t: 0.5, foot: { x: 2, y: 0 }, withinSegment: true })
    const check = output(
      await run(registry, 'analytic-geometry-guide', { ...geometryInput, step: 4 }),
    )
    expect(check.current.data).toMatchObject({ distance: 3, perpendicularResidual: 0 })
    expect(beforeSkillTool).toHaveBeenCalledTimes(3)
    expect(beforeSkillTool).toHaveBeenCalledWith('geometry_calculate')
    expect(getQuestion).not.toHaveBeenCalled()
    expect(registry.getSkillReceipts()).toEqual([
      { skillId: 'analytic-geometry-guide', version: '1.0.0' },
    ])
    const receipts = registry.getSkillReceipts()
    ;(receipts[0] as any).version = 'tampered'
    expect(registry.getSkillReceipts()[0].version).toBe('1.0.0')
  })

  it('handles vertical lines, line extension and zero distances; rejects degenerate or injected inputs', async () => {
    const registry = createAgentToolRegistry(context(), adapters())
    const vertical = output(
      await run(registry, 'analytic-geometry-guide', {
        a: { x: 1, y: 0 },
        b: { x: 1, y: 2 },
        point: { x: 4, y: 6 },
        step: 3,
      }),
    )
    expect(vertical.current.data).toEqual({ t: 3, foot: { x: 1, y: 6 }, withinSegment: false })
    expect(
      output(
        await run(registry, 'analytic-geometry-guide', {
          ...geometryInput,
          point: { x: 2, y: 0 },
          step: 4,
        }),
      ).current.data.distance,
    ).toBe(0)
    expect(
      errorCode(
        await run(registry, 'analytic-geometry-guide', { ...geometryInput, b: geometryInput.a }),
      ),
    ).toBe('invalid_arguments')
    expect(
      errorCode(
        await run(registry, 'analytic-geometry-guide', { ...geometryInput, code: 'process.env' }),
      ),
    ).toBe('invalid_arguments')
    expect(errorCode(await run(registry, 'not-a-real-skill'))).toBe('invalid_arguments')
    expect(
      errorCode(
        await run(registry, 'analytic-geometry-guide', {
          ...geometryInput,
          point: { x: Infinity, y: 0 },
        }),
      ),
    ).toBe('invalid_arguments')
  })

  it('never upgrades learner/reference authorization through error analysis', async () => {
    const getQuestion = vi.fn(async () => question())
    const local = createAgentToolRegistry(context(), adapters({ getQuestion }))
    expect(errorCode(await run(local, 'error-cause-analysis'))).toBe('forbidden')
    const denied = createAgentToolRegistry(
      context({ mode: 'review', includeReference: true }),
      adapters({ getQuestion }),
    )
    expect(errorCode(await run(denied, 'error-cause-analysis'))).toBe('forbidden')
    expect(getQuestion).not.toHaveBeenCalled()
  })

  it('uses the frozen authorized answer and explicitly distinguishes observations from uncertain causes', async () => {
    const reviewAnswer = vi.fn()
    const input = context({
      mode: 'review',
      includeReference: true,
      parentConsent: { reference: true, knowledge: false },
    })
    const registry = createAgentToolRegistry(input, adapters({ reviewAnswer }))
    input.answer!.text = '垂直；OTHER_SAVED_HISTORY'
    const result = await run(registry, 'error-cause-analysis')
    expect(result.isError).toBeUndefined()
    expect(output(result)).toMatchObject({
      historyRead: false,
      saved: false,
      observations: [{ status: 'keyword-not-found', certainty: 'requires-learner-verification' }],
    })
    expect(JSON.stringify(result.output)).not.toContain('OTHER_SAVED_HISTORY')
    expect(JSON.stringify(result.output)).toContain('同义表达')
    expect(reviewAnswer).not.toHaveBeenCalled()
  })

  it('generates each focus as a student-safe staged proposal, without saving or returning answers', async () => {
    const proposals: Question[] = []
    const onProposal = vi.fn(async (proposal) => {
      proposals.push(proposal.question)
      return { proposalId: `p${proposals.length}` }
    })
    const registry = createAgentToolRegistry(context({ mode: 'create' }), adapters({ onProposal }))
    for (const focus of [
      'perpendicular-line',
      'vector-angle',
      'spatial-length',
      'spatial-volume',
    ]) {
      for (const difficulty of ['foundation', 'stretch']) {
        const result = await run(registry, 'targeted-variant-practice', { focus, difficulty })
        expect(result.isError, JSON.stringify(result.output)).toBeUndefined()
        expect(output(result)).toMatchObject({
          focus,
          confirmationRequired: true,
          saved: false,
          practice: { kind: 'question', saved: false },
        })
        expect(output(result).practice.question).not.toHaveProperty('explanation')
        expect(output(result).practice.question).not.toHaveProperty('rubric')
        expect(output(result).practice.question).not.toHaveProperty('correctAnswer')
      }
    }
    expect(proposals).toHaveLength(8)
    expect(proposals.every((question) => question.explanation && question.rubric?.length)).toBe(
      true,
    )
    expect(
      errorCode(
        await run(
          createAgentToolRegistry(context(), adapters({ onProposal })),
          'targeted-variant-practice',
          { focus: 'vector-angle' },
        ),
      ),
    ).toBe('forbidden')
  })

  it('produces sourced recall cards and retains existing formula reference receipts without network calls', async () => {
    const registry = createAgentToolRegistry(context(), adapters())
    const result = await run(registry, 'knowledge-review', { query: '向量' })
    expect(output(result).cards.length).toBeGreaterThan(0)
    expect(output(result).cards[0]).toMatchObject({
      formulaId: expect.any(String),
      reference: { expression: expect.any(String), conditions: expect.any(Array) },
    })
    expect(output(result).reviewPlan).toMatchObject({
      scheduled: false,
      suggestedOffsetsDays: [0, 1, 3, 7],
    })
    expect(registry.getFormulaReferences().length).toBe(output(result).cards.length)
    const empty = output(
      await run(registry, 'knowledge-review', { query: '此知识点绝不在内置目录xzy123' }),
    )
    expect(empty.cards).toEqual([])
    expect(empty.message).toContain('没有匹配项')
  })

  it('shares the cumulative evidence quota and refuses scope widening through skills', async () => {
    const searchKnowledge = vi.fn(async () => [evidence(1), evidence(2)])
    const registry = createAgentToolRegistry(context(knowledgeScope), adapters({ searchKnowledge }))
    const result = await run(registry, 'textbook-evidence-search', { query: '垂足', limit: 2 })
    expect(output(result)).toMatchObject({
      untrustedSourceData: true,
      citations: [{ pageNumber: 4 }, { pageNumber: 4 }],
    })
    expect(searchKnowledge).toHaveBeenLastCalledWith({
      documentId: doc,
      startPage: 4,
      endPage: 4,
      subject: 'math',
      query: '垂足',
      limit: 2,
    })
    searchKnowledge.mockResolvedValueOnce([evidence(3)])
    expect(
      (await invoke(registry, 'search_knowledge', { query: '距离', limit: 1 })).isError,
    ).toBeUndefined()
    searchKnowledge.mockResolvedValueOnce([evidence(4)])
    expect(
      errorCode(await run(registry, 'textbook-evidence-search', { query: '方向', limit: 1 })),
    ).toBe('knowledge_limit')
    expect(
      errorCode(
        await run(registry, 'textbook-evidence-search', { query: '方向', documentId: 'other' }),
      ),
    ).toBe('invalid_arguments')
    searchKnowledge.mockResolvedValueOnce([evidence(1, { pageNumber: 5 })])
    expect(
      errorCode(await run(registry, 'textbook-evidence-search', { query: '方向', limit: 1 })),
    ).toBe('scope_violation')
  })

  it('does not touch data when nested budget/cancellation check refuses, and never echoes its error', async () => {
    const searchKnowledge = vi.fn()
    const beforeSkillTool = vi.fn(async () => {
      throw new Error('API_KEY_SHOULD_NEVER_LEAK')
    })
    const registry = createAgentToolRegistry(
      context(knowledgeScope),
      adapters({ searchKnowledge, beforeSkillTool }),
    )
    const result = await run(registry, 'textbook-evidence-search', { query: '距离' })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).not.toContain('API_KEY_SHOULD_NEVER_LEAK')
    expect(searchKnowledge).not.toHaveBeenCalled()
    expect(registry.getSkillReceipts()).toEqual([])
  })
})
