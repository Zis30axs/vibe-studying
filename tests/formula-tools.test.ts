import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { createAgentToolRegistry, AGENT_TOOL_LIMITS } from '../src/adapters/agent-tool-registry'
import { FORMULA_CATALOG_VERSION, FORMULA_ENTRIES } from '../src/domain/formula-catalog'
import { searchFormulas } from '../src/domain/formula-reference'
import { AgentFormulaReferences } from '../src/components/AgentWorkbench'
import { availableAgentTools } from '../src/domain/agent-workbench-ui'
import type { AgentToolContext } from '../src/shared/agent-tool-context'
import { FORMULA_PROVENANCE, FORMULA_TOOL_LIMITS } from '../src/shared/formula-tools'

const context = (extra: Partial<AgentToolContext> = {}): AgentToolContext => ({
  subject: 'math',
  mode: 'learner',
  questionIds: [],
  includeReference: false,
  allowedTools: ['search_formulas', 'get_formula'],
  parentConsent: { reference: false, knowledge: false },
  childConsent: { reference: false, knowledge: false },
  ...extra,
})
const create = (extra: Partial<AgentToolContext> = {}) => {
  const getQuestion = vi.fn(async () => {
    throw new Error('No question access expected')
  })
  const onProposal = vi.fn(async () => ({ proposalId: 'must-not-be-used' }))
  return {
    registry: createAgentToolRegistry(context(extra), { getQuestion, onProposal }),
    getQuestion,
    onProposal,
  }
}
const math = () => FORMULA_ENTRIES.find((entry) => entry.subject === 'math')!
const geography = () => FORMULA_ENTRIES.find((entry) => entry.subject === 'geography')!
const invoke = (
  registry: ReturnType<typeof createAgentToolRegistry>,
  name: string,
  args: Record<string, unknown>,
) => registry.execute({ name, arguments: args })
const errorCode = (result: { output: unknown }) =>
  (result.output as { error: { code: string } }).error.code

describe('formula references through the bounded Agent registry', () => {
  it('provides general formulas in learner mode without reference answers, knowledge consent or questions', async () => {
    const { registry, getQuestion, onProposal } = create()
    expect(registry.definitions.map((tool) => tool.name)).toEqual([
      'search_formulas',
      'get_formula',
    ])
    const result = await invoke(registry, 'get_formula', { formulaId: math().id })
    expect(result.isError).toBeUndefined()
    expect(result.output).toEqual({
      catalogVersion: FORMULA_CATALOG_VERSION,
      provenance: FORMULA_PROVENANCE,
      formula: math(),
    })
    expect(getQuestion).not.toHaveBeenCalled()
    expect(onProposal).not.toHaveBeenCalled()
  })
  it('uses the same canonical full entries as the UI search with a strict three-result bound', async () => {
    const { registry } = create()
    const result = await invoke(registry, 'search_formulas', { query: math().chapter })
    expect(result.isError).toBeUndefined()
    const output = result.output as { formulas: typeof FORMULA_ENTRIES }
    expect(output.formulas).toEqual(searchFormulas(math().chapter, { subject: 'math', limit: 3 }))
    expect(output.formulas.length).toBeLessThanOrEqual(FORMULA_TOOL_LIMITS.results)
    for (const formula of output.formulas) {
      expect(formula.conditions.length).toBeGreaterThan(0)
      expect(formula.example.steps.length).toBeGreaterThan(0)
      expect(formula.sources.length).toBeGreaterThan(0)
    }
    expect(Buffer.byteLength(JSON.stringify(result.output))).toBeLessThan(
      AGENT_TOOL_LIMITS.resultBytes,
    )
  })
  it('rejects unknown IDs rather than returning invented or unrelated formulas', async () => {
    const { registry } = create()
    expect(
      errorCode(await invoke(registry, 'get_formula', { formulaId: 'math.not.in.catalog' })),
    ).toBe('not_found')
    expect(registry.getFormulaReferences()).toEqual([])
    expect(
      (await invoke(registry, 'search_formulas', { query: 'unlikely-unlisted-formula-xyz' }))
        .output,
    ).toMatchObject({ formulas: [] })
    expect(registry.getFormulaReferences()).toEqual([])
  })
  it('enforces immutable subject scope, tool enablement and unsupported subjects', async () => {
    const { registry } = create()
    expect(errorCode(await invoke(registry, 'get_formula', { formulaId: geography().id }))).toBe(
      'scope_violation',
    )
    expect(
      errorCode(
        await invoke(registry, 'search_formulas', { query: '比例尺', subject: 'geography' }),
      ),
    ).toBe('invalid_arguments')
    expect(
      (await invoke(registry, 'search_formulas', { query: geography().id })).output,
    ).toMatchObject({ formulas: [] })
    expect(
      errorCode(
        await invoke(create({ allowedTools: ['search_formulas'] }).registry, 'get_formula', {
          formulaId: math().id,
        }),
      ),
    ).toBe('forbidden')
    const unsupported = create({ subject: 'history' }).registry
    expect(unsupported.definitions).toEqual([])
    expect(errorCode(await invoke(unsupported, 'get_formula', { formulaId: math().id }))).toBe(
      'forbidden',
    )
  })
  it.each([
    ['search_formulas', { query: '' }],
    ['search_formulas', { query: 'x'.repeat(121) }],
    ['search_formulas', { query: 'vector', limit: 4 }],
    ['search_formulas', { query: 'vector', limit: 0 }],
    ['search_formulas', { query: 'vector', chapter: 'x'.repeat(81) }],
    ['search_formulas', { query: 'vector', sources: [{ url: 'https://attacker.test' }] }],
    ['get_formula', { formulaId: '../../secret' }],
    ['get_formula', { formulaId: 'math.vector.dot', expression: 'forged' }],
  ] as const)('rejects invalid formula input %s %j', async (name, args) => {
    expect(errorCode(await invoke(create().registry, name, args))).toBe('invalid_arguments')
  })
  it('records only canonical returned entries, deduplicates receipts and isolates all returned mutations', async () => {
    const { registry } = create()
    const result = await invoke(registry, 'get_formula', { formulaId: math().id })
    const original = structuredClone(math())
    const output = result.output as { formula: { title: string; sources: { title: string }[] } }
    output.formula.title = 'FORGED'
    output.formula.sources[0].title = 'FORGED SOURCE'
    const receipts = registry.getFormulaReferences()
    expect(receipts).toEqual([
      {
        formulaId: original.id,
        catalogVersion: FORMULA_CATALOG_VERSION,
        entryVersion: 1,
        title: original.title,
        expression: original.expression,
        conditions: original.conditions,
        sources: original.sources,
        provenance: FORMULA_PROVENANCE,
      },
    ])
    ;(receipts[0] as { title: string }).title = 'FORGED RECEIPT'
    await invoke(registry, 'get_formula', { formulaId: math().id })
    expect(registry.getFormulaReferences()).toHaveLength(1)
    expect(registry.getFormulaReferences()[0].title).toBe(original.title)
    expect(math()).toEqual(original)
  })
  it('keeps formula tools read-only and available without a current question only for supported subjects', () => {
    const scope = {
      subject: 'math' as const,
      mode: 'learner' as const,
      hasQuestion: false,
      includeAnswer: false,
      hasModules: false,
      includeReference: false,
      hasKnowledge: false,
      allowDelegation: false,
    }
    expect(availableAgentTools(scope)).toEqual(
      expect.arrayContaining(['search_formulas', 'get_formula']),
    )
    expect(availableAgentTools({ ...scope, subject: 'history' })).not.toContain('search_formulas')
  })
  it('renders local receipts with conditions, exact ID and copyable source addresses, with escaped text', async () => {
    const { registry } = create()
    await invoke(registry, 'get_formula', { formulaId: math().id })
    const receipts = registry.getFormulaReferences()
    const html = renderToStaticMarkup(
      createElement(AgentFormulaReferences, {
        references: [{ ...receipts[0], title: '<script>not markup</script>' }],
      }),
    )
    expect(html).toContain('&lt;script&gt;not markup&lt;/script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).toContain(math().id)
    expect(html).toContain(FORMULA_CATALOG_VERSION)
    expect(html).toMatch(/readonly/i)
    expect(html).toContain('查阅记录不代表模型正确运用了公式')
  })
})
