import { AGENT_DEFAULT_TOOLS, availableAgentTools } from '../src/domain/agent-workbench-ui'
import { FORMULA_ENTRIES, FORMULA_CATALOG_VERSION } from '../src/domain/formula-catalog'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelService } from '../src/adapters/model-service'
import { LearningGraphService } from '../src/adapters/learning-graph-service'
import { learningHelpState } from '../src/domain/learning-graph'
import { StudyService } from '../src/domain/study-service'
import { LocalRuleAgent } from '../src/adapters/local-rule-agent'
import { AgentService } from '../src/adapters/agent-service'
import {
  AGENT_BUDGET,
  type AgentRunRequest,
  type AgentRunState,
} from '../src/shared/agent-workbench'
import { emptyDraft, type Question } from '../src/shared/types'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})
const question: Question = {
  id: 'math-agent-fixture',
  subject: 'math',
  kind: 'math',
  title: 'Synthetic question',
  prompt: 'Compute a distance.',
  explanation: 'PRIVATE_REFERENCE_FIXTURE',
  tags: [],
  source: 'Synthetic tests',
  maxScore: 1,
  rubric: [{ id: 'r1', label: 'Explain', keywords: ['distance'], points: 1 }],
}
const final = (text = 'Tool result received.') =>
  new Response(
    JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }],
    }),
  )
const call = (
  id: string,
  name = 'math_measure',
  args: unknown = { operation: 'distance', from: { x: 0, y: 0 }, to: { x: 3, y: 4 } },
) =>
  new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
            ],
          },
        },
      ],
    }),
  )
async function fixture(fetchImpl: typeof fetch) {
  const directory = await mkdtemp(join(tmpdir(), 'examcraft-agent-'))
  directories.push(directory)
  const models = new ModelService(directory, {
    apiKey: 'synthetic-agent-key-never-real',
    fetchImpl,
  })
  const config = await models.getConfig()
  const saves = vi.fn(async () => {})
  const agent = new AgentService(models, {
    getQuestion: async (id) => {
      if (id !== question.id) throw new Error()
      return structuredClone(question)
    },
    saveQuestion: saves,
    applyAnswer: async () => {},
  })
  const request: AgentRunRequest = {
    runId: 'run-test',
    task: 'Calculate distance using the allowed local tool.',
    subject: 'math',
    mode: 'learner',
    questionIds: [],
    includeReference: false,
    allowedTools: ['math_measure'],
    configRevision: config.revision,
    parentConsent: true,
    childConsent: false,
  }
  return { models, agent, request, saves, directory }
}
async function finished(agent: AgentService, runId: string): Promise<AgentRunState> {
  await vi.waitFor(() => expect(agent.get(runId)?.status).not.toBe('running'))
  return agent.get(runId)!
}

describe('learning skills through the bounded Agent service', () => {
  const skillArgs = {
    skillId: 'analytic-geometry-guide',
    input: { a: { x: 0, y: 0 }, b: { x: 0, y: 4 }, point: { x: 3, y: 2 }, step: 4 },
  }
  it('executes a local skill through native tools and charges its internal computation', async () => {
    const payloads: any[] = []
    const f = await fixture(
      vi.fn(async (_url, init) => {
        payloads.push(JSON.parse(String(init?.body)))
        return payloads.length === 1 ? call('skill-1', 'run_skill', skillArgs) : final()
      }) as typeof fetch,
    )
    await f.agent.start({
      ...f.request,
      allowedTools: ['list_skills', 'run_skill', 'geometry_calculate'],
    })
    const state = await finished(f.agent, f.request.runId)
    expect(state.status).toBe('complete')
    expect(state.toolCalls).toBe(2)
    expect(state.skillReceipts).toEqual([{ skillId: skillArgs.skillId, version: '1.0.0' }])
    expect(state.delegatedCalls).toBe(0)
    const output = JSON.parse(
      payloads[1].messages.find((message: any) => message.role === 'tool').content,
    )
    expect(output.skillId).toBe(skillArgs.skillId)
    expect(output.result.current.data.distance).toBe(3)
    expect(JSON.stringify(payloads)).not.toContain('PRIVATE_REFERENCE_FIXTURE')
    expect(f.saves).not.toHaveBeenCalled()
  })
  it('cannot multiply the shared six-call budget through nested skill execution', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: Array.from({ length: 4 }, (_, i) => ({
                    id: `skill-${i}`,
                    type: 'function',
                    function: { name: 'run_skill', arguments: JSON.stringify(skillArgs) },
                  })),
                },
              },
            ],
          }),
        ),
    ) as typeof fetch
    const f = await fixture(fetchImpl)
    await f.agent.start({ ...f.request, allowedTools: ['run_skill', 'geometry_calculate'] })
    const state = await finished(f.agent, f.request.runId)
    expect(state.status).toBe('failed')
    expect(state.toolCalls).toBe(6)
    expect(state.message).toContain('预算')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(f.saves).not.toHaveBeenCalled()
  })
})
describe('bounded native Agent service', () => {
  it('executes actual local tool and returns numeric result to the same model before final reply', async () => {
    const payloads: any[] = []
    const f = await fixture(
      vi.fn(async (_url, init) => {
        payloads.push(JSON.parse(String(init?.body)))
        return payloads.length === 1 ? call('distance-1') : final()
      }) as typeof fetch,
    )
    expect((await f.agent.start(f.request)).status).toBe('running')
    const state = await finished(f.agent, f.request.runId)
    expect(state.status).toBe('complete')
    expect(state.modelRequests).toBe(2)
    expect(state.toolCalls).toBe(1)
    const result = payloads[1].messages.find((m: any) => m.role === 'tool')
    expect(result.tool_call_id).toBe('distance-1')
    expect(result.content).toContain('5')
    expect(state.events.map((e) => e.kind)).toEqual(['model', 'tool', 'model'])
    expect(JSON.stringify(state)).not.toContain('synthetic-agent-key')
    expect(f.saves).not.toHaveBeenCalled()
  })
  it('returns canonical formulas through the native loop and records host citations without writes', async () => {
    const entry = FORMULA_ENTRIES.find((formula) => formula.subject === 'math')!
    const payloads: any[] = []
    const f = await fixture(
      vi.fn(async (_url, init) => {
        payloads.push(JSON.parse(String(init?.body)))
        return payloads.length === 1
          ? call('formula-1', 'get_formula', { formulaId: entry.id })
          : final('Model prose with a fabricated citation math.fake.citation')
      }) as typeof fetch,
    )
    await f.agent.start({ ...f.request, allowedTools: ['get_formula'] })
    const state = await finished(f.agent, f.request.runId)
    expect(state.status).toBe('complete')
    expect(state.toolCalls).toBe(1)
    expect(state.modelRequests).toBe(2)
    const result = JSON.parse(
      payloads[1].messages.find((message: any) => message.role === 'tool').content,
    )
    expect(result.formula).toEqual(entry)
    expect(result.catalogVersion).toBe(FORMULA_CATALOG_VERSION)
    expect(state.formulaReferences?.map((item) => item.formulaId)).toEqual([entry.id])
    expect(JSON.stringify(state.formulaReferences)).not.toContain('math.fake.citation')
    expect(state.proposals).toEqual([])
    expect(f.saves).not.toHaveBeenCalled()
    expect(JSON.stringify(payloads[0].messages)).toContain('确切公式 ID')
  })
  it('charges formula calls to the existing six-tool budget without bypassing model rounds', async () => {
    let requests = 0
    const f = await fixture(
      vi.fn(async () => {
        requests++
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: Array.from({ length: 4 }, (_, i) => ({
                    id: `formula-${requests}-${i}`,
                    type: 'function',
                    function: {
                      name: 'search_formulas',
                      arguments: JSON.stringify({ query: '数学' }),
                    },
                  })),
                },
              },
            ],
          }),
        )
      }) as typeof fetch,
    )
    await f.agent.start({ ...f.request, allowedTools: ['search_formulas'] })
    const state = await finished(f.agent, f.request.runId)
    expect(state.status).toBe('failed')
    expect(state.toolCalls).toBe(4)
    expect(state.modelRequests).toBe(2)
    expect(state.message).toContain('预算')
    expect(requests).toBe(2)
    expect(f.saves).not.toHaveBeenCalled()
  })
  it('never dispatches without explicit parent consent or required delegate consent', async () => {
    const fetch = vi.fn(async () => final())
    const f = await fixture(fetch as typeof globalThis.fetch)
    await expect(f.agent.start({ ...f.request, parentConsent: false })).rejects.toThrow('同意')
    await expect(
      f.agent.start({ ...f.request, allowedTools: ['advise_selection'] }),
    ).rejects.toThrow('子模型')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('rejects widening reference access in learner mode and out-of-subject question scope', async () => {
    const fetch = vi.fn(async () => final())
    const f = await fixture(fetch as typeof globalThis.fetch)
    await expect(f.agent.start({ ...f.request, includeReference: true })).rejects.toThrow('参考')
    await f.agent.start({ ...f.request, subject: 'history', questionIds: [question.id] })
    expect((await finished(f.agent, f.request.runId)).status).toBe('failed')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('keeps local-only graph baseline and reference fields out of initial model context', async () => {
    let payload = ''
    const f = await fixture(
      vi.fn(async (_url, init) => {
        payload = String(init?.body)
        return final()
      }) as typeof fetch,
    )
    await f.agent.start({
      ...f.request,
      currentQuestionId: question.id,
      questionIds: [question.id],
      localDraft: { ...emptyDraft(), text: 'LOCAL_GRAPH_DRAFT_NOT_SHARED' },
    })
    expect((await finished(f.agent, f.request.runId)).status).toBe('complete')
    expect(payload).not.toContain('LOCAL_GRAPH_DRAFT_NOT_SHARED')
    expect(payload).not.toContain('PRIVATE_REFERENCE_FIXTURE')
  })
  it('stops at native model round budget without executing tools that cannot be returned', async () => {
    let count = 0
    const f = await fixture(vi.fn(async () => call(`distance-${++count}`)) as typeof fetch)
    await f.agent.start(f.request)
    const state = await finished(f.agent, f.request.runId)
    expect(state.status).toBe('failed')
    expect(count).toBe(AGENT_BUDGET.modelRequests)
    expect(state.toolCalls).toBe(2)
    expect(state.message).toContain('预算')
    expect(state.proposals).toEqual([])
  })
  it('refusal and unknown tools fail closed without automatic retry', async () => {
    for (const response of [
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: { role: 'assistant', content: null, refusal: 'No.' },
            },
          ],
        }),
      ),
      call('bad-1', 'read_arbitrary_file', { path: '/private' }),
    ]) {
      const fetch = vi.fn(async () => response)
      const f = await fixture(fetch as typeof globalThis.fetch)
      await f.agent.start(f.request)
      expect((await finished(f.agent, f.request.runId)).status).toBe('failed')
      expect(fetch).toHaveBeenCalledTimes(1)
    }
  })
  it('guards repeated start, cancel, stale late results and replayed run IDs', async () => {
    let release!: () => void
    const f = await fixture(
      vi.fn(async () => {
        await new Promise<void>((resolve) => (release = resolve))
        return final('STALE_RESULT')
      }) as typeof fetch,
    )
    await f.agent.start(f.request)
    await expect(f.agent.start({ ...f.request, runId: 'other' })).rejects.toThrow('进行中')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    f.agent.cancel(f.request.runId)
    expect(f.agent.get(f.request.runId)?.status).toBe('cancelled')
    release()
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(f.agent.get(f.request.runId)?.text).toBe('')
    await expect(f.agent.start(f.request)).rejects.toThrow('标识')
  })
  it('profile changes cancel an in-flight Agent request and invalidate its outputs', async () => {
    let release!: () => void
    const f = await fixture(
      vi.fn(async () => {
        await new Promise<void>((resolve) => (release = resolve))
        return final()
      }) as typeof fetch,
    )
    await f.agent.start(f.request)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const config = await f.models.getConfig()
    await f.models.saveConfig({
      protocol: config.protocol,
      baseUrl: config.baseUrl,
      model: 'another-model',
    })
    expect(f.agent.get(f.request.runId)?.status).toBe('cancelled')
    release()
  })
  it('answer writes remain proposals until explicit acceptance, with full baseline stale checking', async () => {
    let count = 0
    const f = await fixture(
      vi.fn(async () =>
        ++count === 1
          ? call('proposal-1', 'propose_answer_edit', {
              expectedText: 'Original answer.',
              replacement: 'Improved answer.',
              reason: 'Synthetic edit.',
            })
          : final('Review the preview.'),
      ) as typeof fetch,
    )
    const draft = { ...emptyDraft(), text: 'Original answer.' }
    await f.agent.start({
      ...f.request,
      currentQuestionId: question.id,
      questionIds: [question.id],
      answer: draft,
      localDraft: draft,
      allowedTools: ['propose_answer_edit'],
    })
    const state = await finished(f.agent, f.request.runId)
    expect(state.status).toBe('complete')
    expect(state.proposals).toHaveLength(1)
    expect(f.saves).not.toHaveBeenCalled()
    const proposalId = state.proposals[0].proposalId
    await expect(
      f.agent.accept({
        runId: state.runId,
        proposalId,
        currentQuestionId: question.id,
        currentAnswer: { ...draft, text: 'Newer answer.' },
      }),
    ).rejects.toThrow('已更改')
    expect(
      await f.agent.accept({
        runId: state.runId,
        proposalId,
        currentQuestionId: question.id,
        currentAnswer: draft,
      }),
    ).toMatchObject({ kind: 'answer-edit', replacement: 'Improved answer.' })
    await expect(
      f.agent.accept({
        runId: state.runId,
        proposalId,
        currentQuestionId: question.id,
        currentAnswer: draft,
      }),
    ).rejects.toThrow('失效')
  })
})

it('stops the whole run when a third delegated model call is requested', async () => {
  let main = 0,
    child = 0
  const f = await fixture(
    vi.fn(async (_url, init) => {
      const data = JSON.parse(String(init?.body))
      if (data.tools) {
        main++
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [1, 2, 3].map((i) => ({
                    id: `advise-${i}`,
                    type: 'function',
                    function: {
                      name: 'advise_selection',
                      arguments: JSON.stringify({
                        source: 'question',
                        selectedText: question.prompt,
                      }),
                    },
                  })),
                },
              },
            ],
          }),
        )
      }
      child++
      return final(JSON.stringify({ hint: 'Synthetic hint from the selected child model.' }))
    }) as typeof fetch,
  )
  await f.agent.start({
    ...f.request,
    currentQuestionId: question.id,
    questionIds: [question.id],
    allowedTools: ['advise_selection'],
    childConsent: true,
  })
  const state = await finished(f.agent, f.request.runId)
  expect(state.status).toBe('failed')
  expect(state.message).toContain('委派模型请求预算')
  expect(main).toBe(1)
  expect(child).toBe(2)
  expect(state.delegatedCalls).toBe(2)
})

it('enforces the cumulative paid-dispatch session budget across independent runs', async () => {
  const fetch = vi.fn(async () => final())
  const f = await fixture(fetch as typeof globalThis.fetch)
  for (let i = 0; i < AGENT_BUDGET.sessionRequests; i++) {
    const runId = `session-${i}`
    await f.agent.start({ ...f.request, runId })
    expect((await finished(f.agent, runId)).status).toBe('complete')
  }
  await expect(f.agent.start({ ...f.request, runId: 'over-budget' })).rejects.toThrow('预算')
  expect(fetch).toHaveBeenCalledTimes(AGENT_BUDGET.sessionRequests)
})

it('closes a canceled old branch whose beginHelp resolves after a newer run starts', async () => {
  const f = await fixture(vi.fn(async () => final('NEW_RUN_ONLY')) as typeof fetch)
  const graph = new LearningGraphService(f.directory)
  const originalBegin = graph.beginHelp.bind(graph)
  let release!: () => void
  graph.beginHelp = async (input) => {
    await new Promise<void>((resolve) => (release = resolve))
    return originalBegin(input)
  }
  const agent = new AgentService(f.models, {
    getQuestion: async () => question,
    saveQuestion: async () => {},
    graph,
    captureSnapshot: async (questionId, draft) =>
      graph.capture({ questionId, subject: 'math', draft, initialOrigin: 'independent' }),
  })
  await agent.start({
    ...f.request,
    currentQuestionId: question.id,
    questionIds: [question.id],
    localDraft: emptyDraft(),
  })
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  agent.cancel(f.request.runId)
  await agent.start({ ...f.request, runId: 'new-run' })
  expect((await finished(agent, 'new-run')).text).toBe('NEW_RUN_ONLY')
  release()
  await vi.waitFor(async () => {
    const state = await graph.load()
    expect(state.branches).toHaveLength(1)
    expect(learningHelpState(state, state.branches[0].id)).toBe('canceled')
  })
  expect(agent.get('new-run')?.text).toBe('NEW_RUN_ONLY')
})

it('records one successful help branch and persists a real accepted merge before returning', async () => {
  let calls = 0
  const f = await fixture(
    vi.fn(async () =>
      ++calls === 1
        ? call('edit-confirm', 'propose_answer_edit', {
            expectedText: 'My original distance.',
            replacement: 'My improved distance.',
            reason: 'Synthetic explanation.',
          })
        : final('One suggestion is ready.'),
    ) as typeof fetch,
  )
  const graph = new LearningGraphService(f.directory)
  const bank = { name: 'Synthetic bank', list: async () => [question], get: async () => question }
  const study = new StudyService(
    f.directory,
    bank,
    new LocalRuleAgent(),
    undefined,
    undefined,
    graph,
  )
  const draft = { ...emptyDraft(), text: 'My original distance.' }
  await study.saveDraft(question.id, draft)
  const agent = new AgentService(f.models, {
    getQuestion: async () => question,
    saveQuestion: async () => {},
    graph,
    captureSnapshot: (id, value) => study.captureSnapshot(id, value),
    applyAnswer: async (id, baseline, replacement, learning) => {
      if (!learning) throw new Error('Missing branch')
      await study.applyLearningEdit(id, {
        branchId: learning.branchId,
        expectedSnapshotId: learning.snapshotId,
        draft: { ...baseline, text: replacement },
      })
    },
  })
  await agent.start({
    ...f.request,
    currentQuestionId: question.id,
    questionIds: [question.id],
    answer: draft,
    localDraft: draft,
    allowedTools: ['propose_answer_edit'],
  })
  const result = await finished(agent, f.request.runId)
  const before = await graph.load()
  expect(before.branches).toHaveLength(1)
  expect(learningHelpState(before, before.branches[0].id)).toBe('received')
  expect((await study.loadState()).drafts[question.id].text).toBe(draft.text)
  await agent.accept({
    runId: f.request.runId,
    proposalId: result.proposals[0].proposalId,
    currentQuestionId: question.id,
    currentAnswer: draft,
  })
  expect((await study.loadState()).drafts[question.id].text).toBe('My improved distance.')
  const after = await graph.load()
  expect(learningHelpState(after, after.branches[0].id)).toBe('merged')
  expect(after.events.filter((e) => e.type === 'help-merged')).toHaveLength(1)
  expect(after.events.filter((e) => e.type === 'tool')).toHaveLength(1)
  expect(JSON.stringify(after)).not.toContain('synthetic-agent-key')
})

it('does not create a snapshot after cancellation during a pending question lookup', async () => {
  const f = await fixture(vi.fn(async () => final()) as typeof fetch)
  let resolveQuestion!: (value: Question) => void
  let lookingUp = false
  const capture = vi.fn(async () => undefined)
  const graph = new LearningGraphService(f.directory)
  const agent = new AgentService(f.models, {
    getQuestion: async () => {
      lookingUp = true
      return new Promise<Question>((resolve) => {
        resolveQuestion = resolve
      })
    },
    saveQuestion: async () => {},
    graph,
    captureSnapshot: capture,
  })
  await agent.start({
    ...f.request,
    runId: 'cancel-before-snapshot',
    questionIds: [question.id],
    currentQuestionId: question.id,
    localDraft: emptyDraft(),
  })
  await vi.waitFor(() => expect(lookingUp).toBe(true))
  agent.cancelCurrent()
  resolveQuestion(structuredClone(question))
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(capture).not.toHaveBeenCalled()
  expect(agent.get('cancel-before-snapshot')?.status).toBe('cancelled')
  expect((await graph.load()).events).toHaveLength(0)
})

it('retrieves a persistent review index through an actual native tool loop without transmitting review history', async () => {
  const { ReviewKnowledgeIndex } = await import('../src/adapters/review-knowledge-index')
  const { resolveAgentKnowledgeIndex } = await import('../src/adapters/agent-knowledge')
  const { studentQuestionProjection } = await import('../src/domain/student-question')
  const documentId = 'a'.repeat(64)
  const excerpt = {
    chunkId: `${documentId}:p2:c1`,
    documentId,
    documentTitle: 'Synthetic PDF',
    subject: 'math' as const,
    pageNumber: 2,
    text: 'PDF_POINT_CANONICAL_EVIDENCE',
  }
  const canonicalAttempt = {
    id: 'index-attempt',
    questionId: question.id,
    questionSnapshot: studentQuestionProjection(question),
    submittedAt: '2026-10-11T00:00:00.000Z',
    draft: { ...emptyDraft(), text: 'PRIVATE_OLD_REVIEW_DRAFT' },
    score: 0,
    maxScore: 1,
    feedback: 'PRIVATE_REVIEW_HISTORY',
    explanation: 'PRIVATE_REVIEW_EXPLANATION',
    reviewer: 'Synthetic',
    rubric: [],
  }
  let nodeId = ''
  const payloads: any[] = []
  const f = await fixture(
    vi.fn(async (_url, init) => {
      payloads.push(JSON.parse(String(init?.body)))
      return payloads.length === 1
        ? call('resolve-index', 'resolve_knowledge', { indexNodeId: nodeId })
        : final()
    }) as typeof fetch,
  )
  const index = new ReviewKnowledgeIndex(f.directory, {
    resolveAttempt: async () => canonicalAttempt,
    resolveChunks: async () => [excerpt],
    verifyDocument: async () => {},
  })
  const [pending] = await index.refresh({ attemptIds: [canonicalAttempt.id] })
  await index.associate({
    nodeId: pending.id,
    expectedRevision: pending.revision,
    chunkIds: [excerpt.chunkId],
  })
  nodeId = pending.id
  const agent = new AgentService(f.models, {
    getQuestion: async () => question,
    saveQuestion: async () => {},
    validateKnowledgeScope: async () => {},
    resolveKnowledgeIndex: (input) => resolveAgentKnowledgeIndex(index, input),
  })
  await agent.start({
    ...f.request,
    runId: 'resolve-index-run',
    task: `Read public study excerpt identified by ${nodeId}`,
    allowedTools: ['resolve_knowledge'],
    knowledge: { documentId, startPage: 2, endPage: 2 },
  })
  const result = await finished(agent, 'resolve-index-run')
  expect(result.status).toBe('complete')
  expect(result.toolCalls).toBe(1)
  expect(JSON.stringify(payloads[1])).toContain(excerpt.text)
  expect(JSON.stringify(payloads)).not.toContain('PRIVATE_REVIEW')
  expect(JSON.stringify(payloads)).not.toContain('PRIVATE_OLD_REVIEW')
})

describe('geometry template native tool lifecycle', () => {
  it('generates one deterministic proposal inside shared budgets and saves only after explicit acceptance', async () => {
    const payloads: any[] = []
    const f = await fixture(
      vi.fn(async (_url, init) => {
        payloads.push(JSON.parse(String(init?.body)))
        return payloads.length === 1
          ? call('geometry-1', 'generate_geometry_question', {
              templateId: 'square-pyramid-locus',
              parameters: { side: 5 },
            })
          : final('已生成待确认的原创几何题。')
      }) as typeof fetch,
    )
    await f.agent.start({
      ...f.request,
      mode: 'create',
      allowedTools: ['generate_geometry_question'],
    })
    const state = await finished(f.agent, f.request.runId)
    expect(state.status).toBe('complete')
    expect(state.toolCalls).toBe(1)
    expect(state.modelRequests).toBe(2)
    expect(state.delegatedCalls).toBe(0)
    expect(state.proposals).toHaveLength(1)
    expect(f.saves).not.toHaveBeenCalled()
    const tool = JSON.parse(payloads[1].messages.find((m: any) => m.role === 'tool').content)
    expect(tool.question.geometry.kind).toBe('geometry-3d')
    expect(tool.question).not.toHaveProperty('explanation')
    expect(tool.question).not.toHaveProperty('rubric')
    const accepted = await f.agent.accept({
      runId: f.request.runId,
      proposalId: state.proposals[0].proposalId,
    })
    expect(accepted.kind).toBe('question')
    expect(f.saves).toHaveBeenCalledTimes(1)
    expect(accepted).not.toHaveProperty('question.explanation')
  })
  it('cancellation discards generated previews and prevents later acceptance', async () => {
    let count = 0
    const f = await fixture(
      vi.fn(async () =>
        ++count === 1
          ? call('geometry-cancel', 'generate_geometry_question', {
              templateId: 'square-pyramid-locus',
              parameters: { side: 3 },
            })
          : final(),
      ) as typeof fetch,
    )
    await f.agent.start({
      ...f.request,
      mode: 'create',
      allowedTools: ['generate_geometry_question'],
    })
    const state = await finished(f.agent, f.request.runId)
    expect(state.proposals).toHaveLength(1)
    f.agent.cancel(f.request.runId)
    await expect(
      f.agent.accept({ runId: f.request.runId, proposalId: state.proposals[0].proposalId }),
    ).rejects.toThrow()
    expect(f.saves).not.toHaveBeenCalled()
  })
})

describe('automatic host geometry teaching strategies', () => {
  it.each([
    ['出一道空间向量题', '空间向量', 'vector-angle-orthogonality'],
    ['出一道求三角形高线和平行线的题', '平面直线', 'triangle-altitude-parallel'],
    ['出一道斜平行六面体长度和夹角题', '斜平行六面体', 'oblique-parallelepiped'],
    ['出一道棱锥中动点在整个平面运动的角度范围题', '正方形底面棱锥', 'square-pyramid-locus'],
  ])(
    'ordinary request %s discovers an internal strategy and returns an illustrated staged question',
    async (task, topic, expectedTemplate) => {
      const payloads: any[] = []
      let selectedTemplate = ''
      const f = await fixture(
        vi.fn(async (_url, init) => {
          const payload = JSON.parse(String(init?.body))
          payloads.push(payload)
          if (payloads.length > 1) return final('已生成配套几何图，请查看待确认的新题。')
          const system = payload.messages.find((m: any) => m.role === 'system').content as string
          expect(system).toContain('应用宿主内置的可信数学出题策略')
          expect(system).toContain('不得要求用户阅读、复制、粘贴提示词')
          expect(system).toContain('geometry_calculate({request:{operation,...}})')
          const text = system
            .split('<geometry-template-catalog>\n')[1]
            ?.split('\n</geometry-template-catalog>')[0]
          expect(text).toBeTruthy()
          const catalog = JSON.parse(text)
          expect(catalog).toHaveLength(4)
          // Synthetic model consumes only the catalog actually sent by the host.
          // This proves the workflow, not the quality of any real model's topic selection.
          const strategy = catalog.find((item: any) => item.title.includes(topic))
          expect(strategy).toBeTruthy()
          expect(strategy.teachingConstraints).toBeTruthy()
          expect(strategy.parameters).toBeTruthy()
          expect(strategy).not.toHaveProperty('explanation')
          selectedTemplate = strategy.templateId
          expect(
            payload.tools.some((tool: any) => tool.function?.name === 'generate_geometry_question'),
          ).toBe(true)
          return call('automatic-geometry', 'generate_geometry_question', {
            templateId: strategy.templateId,
            parameters: strategy.defaultParameters,
          })
        }) as typeof fetch,
      )
      const enabled = availableAgentTools({
        subject: 'math',
        mode: 'create',
        hasQuestion: false,
        includeAnswer: false,
        hasModules: false,
        includeReference: false,
        hasKnowledge: false,
        allowDelegation: false,
      }).filter((name) => AGENT_DEFAULT_TOOLS.includes(name))
      await f.agent.start({ ...f.request, task, mode: 'create', allowedTools: enabled })
      const state = await finished(f.agent, f.request.runId)
      expect(state.status).toBe('complete')
      expect(selectedTemplate).toBe(expectedTemplate)
      expect(state.toolCalls).toBe(1)
      expect(state.modelRequests).toBe(2)
      expect(state.delegatedCalls).toBe(0)
      expect(state.proposals).toHaveLength(1)
      expect(f.saves).not.toHaveBeenCalled()
      const userInput = JSON.parse(payloads[0].messages.find((m: any) => m.role === 'user').content)
      expect(userInput.task).toBe(task)
      expect(userInput.task).not.toContain('generate_geometry_question')
      const tool = JSON.parse(payloads[1].messages.find((m: any) => m.role === 'tool').content)
      expect(tool.question.geometry.kind).toBe('geometry-3d')
      expect(tool.question.geometry.points.length).toBeGreaterThan(0)
      expect(tool.question).not.toHaveProperty('explanation')
      expect(tool.question).not.toHaveProperty('rubric')
      const saved = await f.agent.accept({
        runId: f.request.runId,
        proposalId: state.proposals[0].proposalId,
      })
      expect(saved.kind).toBe('question')
      expect(f.saves).toHaveBeenCalledTimes(1)
    },
  )
  it.each([
    ['learner', 'math', 'geometry_calculate'],
    ['review', 'math', 'geometry_calculate'],
    ['create', 'geography', 'geography_measure'],
    ['create', 'math', 'geometry_calculate'],
  ] as const)(
    'does not inject teaching strategies into %s/%s without the authorized generator',
    async (mode, subject, tool) => {
      const payloads: any[] = []
      const f = await fixture(
        vi.fn(async (_url, init) => {
          payloads.push(JSON.parse(String(init?.body)))
          return final()
        }) as typeof fetch,
      )
      await f.agent.start({
        ...f.request,
        mode,
        subject,
        allowedTools: [tool],
        ...(mode === 'review'
          ? {
              questionIds: [question.id],
              currentQuestionId: question.id,
              includeReference: true,
              answer: { ...emptyDraft(), text: 'Synthetic review draft' },
            }
          : {}),
      })
      const state = await finished(f.agent, f.request.runId)
      expect(state.status).toBe('complete')
      expect(JSON.stringify(payloads)).not.toContain('<geometry-template-catalog>')
      expect(JSON.stringify(payloads)).not.toContain('defaultParameters')
      expect(f.saves).not.toHaveBeenCalled()
    },
  )
})
