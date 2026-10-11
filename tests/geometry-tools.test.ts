import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createAgentToolRegistry, AGENT_TOOL_LIMITS } from '../src/adapters/agent-tool-registry'
import { availableAgentTools } from '../src/domain/agent-workbench-ui'
import { compileGeometryTemplate } from '../src/domain/geometry-templates'
import { GEOMETRY_TEMPLATE_CATALOG, geometryTemplatePrompt } from '../src/shared/geometry-templates'
import { questionBankSchema, mathWorkbenchSchema } from '../src/domain/schemas'
import { studentQuestionProjection, studentQuestionSchema } from '../src/domain/student-question'
import { buildAdvisorContext, buildGradingContext } from '../src/adapters/review-contexts'
import { emptyDraft, emptyMathState, type Question } from '../src/shared/types'
import type { AgentToolContext, AgentToolProposal } from '../src/shared/agent-tool-context'

const make = (extra: Partial<AgentToolContext> = {}) => {
  let proposed: AgentToolProposal | undefined
  const onProposal = vi.fn(async (proposal: AgentToolProposal) => {
    proposed = proposal
    return { proposalId: 'geometry-preview' }
  })
  const getQuestion = vi.fn(async (): Promise<Question> => {
    throw new Error('no bank access')
  })
  const registry = createAgentToolRegistry(
    {
      subject: 'math',
      mode: 'create',
      questionIds: [],
      includeReference: false,
      allowedTools: ['geometry_calculate', 'generate_geometry_question'],
      parentConsent: { reference: false, knowledge: false },
      childConsent: { reference: false, knowledge: false },
      ...extra,
    },
    { onProposal, getQuestion },
  )
  return { registry, onProposal, getQuestion, proposed: () => proposed }
}
const firstInput = () => ({
  templateId: GEOMETRY_TEMPLATE_CATALOG[0].id,
  parameters: GEOMETRY_TEMPLATE_CATALOG[0].defaultParameters,
})
const invoke = (registry: ReturnType<typeof make>['registry'], name: string, args: object) =>
  registry.execute({ name, arguments: args as Record<string, unknown> })

describe('geometry Agent integration and privacy', () => {
  it('ships copyable plain text exactly matching the active in-app prompts', () => {
    const text = readFileSync('docs/math-generation-prompts.txt', 'utf8')
    for (const template of GEOMETRY_TEMPLATE_CATALOG)
      expect(text).toContain(geometryTemplatePrompt(template.id))
  })
  it('runs true xyz calculation without bank, network or proposals', async () => {
    const { registry, onProposal, getQuestion } = make({ mode: 'learner' })
    const output = await invoke(registry, 'geometry_calculate', {
      request: { operation: 'vector_metrics', a: { x: 1, y: 0, z: 1 }, b: { x: 1, y: 0, z: -1 } },
    })
    expect(output.isError).toBeUndefined()
    expect(output.output).toMatchObject({ dot: 0, orthogonal: true })
    expect(getQuestion).not.toHaveBeenCalled()
    expect(onProposal).not.toHaveBeenCalled()
  })
  it.each(GEOMETRY_TEMPLATE_CATALOG)(
    'compiles and stages $id with answers only in host proposal',
    async (template) => {
      const { registry, onProposal, proposed } = make()
      const output = await invoke(registry, 'generate_geometry_question', {
        templateId: template.id,
        parameters: template.defaultParameters,
      })
      expect(output.isError).toBeUndefined()
      const data = output.output as { question: Question; saved: boolean }
      expect(data.saved).toBe(false)
      expect(onProposal).toHaveBeenCalledTimes(1)
      expect(proposed()?.kind).toBe('question')
      expect(data.question).not.toHaveProperty('explanation')
      expect(data.question).not.toHaveProperty('rubric')
      expect(studentQuestionSchema.safeParse(data.question).success).toBe(true)
      expect(Buffer.byteLength(JSON.stringify(data))).toBeLessThan(AGENT_TOOL_LIMITS.resultBytes)
    },
  )
  it('enforces subject, mode and explicitly enabled capability', async () => {
    for (const scope of [
      { subject: 'history' as const },
      { mode: 'learner' as const },
      { allowedTools: ['geometry_calculate' as const] },
    ]) {
      const { registry, onProposal } = make(scope)
      expect((await invoke(registry, 'generate_geometry_question', firstInput())).isError).toBe(
        true,
      )
      expect(onProposal).not.toHaveBeenCalled()
    }
    expect(make({ subject: 'geography' }).registry.definitions).toEqual([])
  })
  it('rejects caller answers, images, scene overrides and hostile object properties', async () => {
    const { registry, onProposal } = make()
    for (const extra of [
      { explanation: 'leak' },
      { geometry: { kind: 'svg' } },
      { image: 'https://private.example/image.png' },
      { parameters: { ...firstInput().parameters, answer: 42 } },
    ]) {
      expect(
        (await invoke(registry, 'generate_geometry_question', { ...firstInput(), ...extra }))
          .isError,
      ).toBe(true)
    }
    expect(
      (
        await invoke(
          registry,
          'geometry_calculate',
          JSON.parse('{"request":{"operation":"vector_metrics","__proto__":{}}}'),
        )
      ).isError,
    ).toBe(true)
    expect(onProposal).not.toHaveBeenCalled()
  })
  it('uses a strict bounded tool schema and does not advertise generation to learners', () => {
    const definitions = make().registry.definitions
    expect(definitions.every((d) => d.inputSchema.type === 'object')).toBe(true)
    expect(make({ mode: 'learner' }).registry.definitions.map((d) => d.name)).toEqual([
      'geometry_calculate',
    ])
    const scope = {
      subject: 'math' as const,
      mode: 'create' as const,
      hasQuestion: false,
      includeAnswer: false,
      hasModules: false,
      includeReference: false,
      hasKnowledge: false,
      allowDelegation: false,
    }
    expect(availableAgentTools(scope)).toContain('generate_geometry_question')
    expect(availableAgentTools({ ...scope, mode: 'learner' })).not.toContain(
      'generate_geometry_question',
    )
  })
  it('preserves geometry in question import, snapshots and explicitly scoped contexts', () => {
    const question = compileGeometryTemplate(firstInput(), 'geometry-test')
    const parsed = questionBankSchema.parse({ version: 1, questions: [question] }).questions[0]
    const student = studentQuestionProjection(parsed)
    expect(student.geometry).toEqual(parsed.geometry)
    expect(JSON.stringify(student)).not.toContain('explanation')
    const draft = emptyDraft()
    draft.math = { ...emptyMathState(), geometry: parsed.geometry }
    const grading = buildGradingContext(parsed, draft)
    expect(grading.question.geometry).toEqual(parsed.geometry)
    expect(grading.answer.math?.geometry).toEqual(parsed.geometry)
    expect(
      studentQuestionSchema.safeParse({ ...student, subject: 'geography', kind: 'geography' })
        .success,
    ).toBe(false)
  })
  it('keeps old mathematical drafts readable and rejects forged right-angle markers', () => {
    expect(mathWorkbenchSchema.parse(emptyMathState())).toEqual(emptyMathState())
    const state = {
      ...emptyMathState(),
      drawing: {
        mode: 'cartesian' as const,
        points: [
          { id: 'O', label: 'O', x: 0, y: 0 },
          { id: 'A', label: 'A', x: 1, y: 0 },
          { id: 'B', label: 'B', x: 0, y: 2 },
        ],
        lines: [],
      },
      rightAngles: [{ id: 'r', vertex: 'O', from: 'A', to: 'B' }],
    }
    expect(mathWorkbenchSchema.safeParse(state).success).toBe(true)
    expect(
      mathWorkbenchSchema.safeParse({
        ...state,
        rightAngles: [{ id: 'r', vertex: 'A', from: 'O', to: 'B' }],
      }).success,
    ).toBe(false)
  })
})
