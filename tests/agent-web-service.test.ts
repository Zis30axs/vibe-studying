import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_TERRAIN } from '../src/domain/terrain'
import { AgentService } from '../src/adapters/agent-service'
import { ModelService } from '../src/adapters/model-service'
import { emptyDraft, type Question } from '../src/shared/types'
import type { AgentRunRequest } from '../src/shared/agent-workbench'
import type { WebResearchSession, WebResearchSource } from '../src/shared/web-research'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})
const question: Question = {
  id: 'web-math-fixture',
  subject: 'math',
  kind: 'math',
  title: 'Fixture',
  prompt: 'Explain functions.',
  explanation: 'PRIVATE_REFERENCE_NOT_PUBLIC',
  tags: [],
  source: 'Synthetic',
  maxScore: 1,
  rubric: [{ id: 'r', label: 'Explain', keywords: ['function'], points: 1 }],
}
const source: WebResearchSource = {
  sourceId: 'web-12345678-1234-1234-1234-123456789abc-1',
  title: '2024 public functions reference',
  url: 'https://www.moe.gov.cn/public-functions',
  excerpt: 'A short untrusted public source about functions.',
  retrievedAt: '2026-10-11T00:00:00.000Z',
  retrieved: true,
  yearEvidence: [{ year: 2024, evidence: '2024 public functions reference' }],
  provenance: 'tavily-search',
  untrusted: true,
  verification: 'unverified',
}
const final = (content = 'Completed using public sources.') =>
  new Response(
    JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
    }),
  )
const call = (id: string, name: string, args: unknown) =>
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
async function fixture(respond: (n: number, body: any) => Response | Promise<Response>) {
  const dir = await mkdtemp(join(tmpdir(), 'examcraft-web-agent-'))
  dirs.push(dir)
  const payloads: any[] = []
  const models = new ModelService(dir, {
    apiKey: 'synthetic-model-only-key',
    fetchImpl: vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      payloads.push(body)
      return respond(payloads.length, body)
    }) as typeof fetch,
  })
  const config = await models.getConfig()
  let revision = 4
  let used = 0
  const sources: WebResearchSource[] = []
  const budget = () => ({
    searchesUsed: used,
    searchesLimit: 2 as const,
    fetchesUsed: 0,
    fetchesLimit: 2 as const,
    estimatedSearchCredits: used,
    reportedCredits: null,
  })
  const search = vi.fn(async (_input: { year?: number }) => {
    used++
    sources.push(structuredClone(source))
    return { sources: structuredClone(sources), budget: budget(), untrusted: true as const }
  })
  const fetchPage = vi.fn(async (_input: { sourceId: string }) => ({
    sources: structuredClone(sources),
    budget: budget(),
    untrusted: true as const,
  }))
  const session: WebResearchSession = {
    search,
    fetch: fetchPage,
    getSources: () => structuredClone(sources),
    getBudget: budget,
  }
  const createWebSession = vi.fn(async () => session)
  const agent = new AgentService(models, {
    getQuestion: async () => structuredClone(question),
    saveQuestion: async () => {},
    createWebSession,
    validateWebRevision: async (value) => {
      if (value !== revision) throw new Error('changed')
    },
  })
  const request: AgentRunRequest = {
    runId: 'web-run',
    task: 'Find relevant public sources. PRIVATE_TASK_NOT_NETWORK',
    subject: 'math',
    mode: 'learner',
    questionIds: [],
    includeReference: false,
    allowedTools: ['web_search', 'web_fetch'],
    configRevision: config.revision,
    parentConsent: true,
    childConsent: false,
    web: {
      provider: 'tavily',
      configRevision: 4,
      consent: true,
      scope: { subject: 'math', topic: '函数', region: '全国', years: [2024], approvedUrls: [] },
    },
  }
  const finish = async () => {
    await vi.waitFor(() => expect(agent.get(request.runId)?.status).not.toBe('running'))
    return agent.get(request.runId)!
  }
  return {
    agent,
    models,
    request,
    payloads,
    search,
    fetchPage,
    createWebSession,
    finish,
    changeRevision: () => revision++,
  }
}
describe('native Agent public research orchestration', () => {
  it('passes fixed public scope only to the network session and source output back to the main model', async () => {
    const f = await fixture((n) =>
      n === 1 ? call('search-1', 'web_search', { year: 2024 }) : final(),
    )
    f.request.questionIds = [question.id]
    f.request.currentQuestionId = question.id
    f.request.localDraft = { ...emptyDraft(), text: 'PRIVATE_DRAFT_NOT_PUBLIC' }
    await f.agent.start(f.request)
    const result = await f.finish()
    expect(result.status).toBe('complete')
    expect(result.web?.budget.searchesUsed).toBe(1)
    expect(f.search).toHaveBeenCalledWith({ year: 2024 }, expect.any(AbortSignal))
    const network = JSON.stringify(f.createWebSession.mock.calls)
    expect(network).not.toContain('PRIVATE_TASK')
    expect(network).not.toContain('PRIVATE_DRAFT')
    expect(network).not.toContain('PRIVATE_REFERENCE')
    expect(JSON.stringify(f.payloads)).not.toContain('PRIVATE_DRAFT')
    expect(JSON.stringify(f.payloads[1])).toContain(source.url)
  })
  it('rejects missing provider consent and wrong subject before dispatch', async () => {
    const f = await fixture(() => final())
    f.request.web!.consent = false
    await expect(f.agent.start(f.request)).rejects.toThrow('Tavily')
    f.request.web!.consent = true
    f.request.web!.scope.subject = 'history'
    await expect(f.agent.start(f.request)).rejects.toThrow('学科')
    expect(f.payloads).toHaveLength(0)
    expect(f.createWebSession).not.toHaveBeenCalled()
  })
  it('does not expose a network tool without explicit scope even if a model requested one', async () => {
    const f = await fixture(() => final())
    delete f.request.web
    await expect(f.agent.start(f.request)).rejects.toThrow('联网')
    expect(f.payloads).toHaveLength(0)
  })
  it('rejects arbitrary model query data without calling provider', async () => {
    const f = await fixture((n) =>
      n === 1 ? call('inject-query', 'web_search', { query: 'PRIVATE_DRAFT_NOT_PUBLIC' }) : final(),
    )
    await f.agent.start(f.request)
    await f.finish()
    expect(f.search).not.toHaveBeenCalled()
    expect(JSON.stringify(f.payloads[1])).toContain('invalid_arguments')
  })
  it('lets the child call the same limited web tool and sends actual sources back to both authorized receivers', async () => {
    const f = await fixture((n) =>
      n === 1
        ? call('advisor', 'advise_selection', {
            selectedText: 'Explain functions.',
            source: 'question',
          })
        : n === 2
          ? call('child-search', 'web_search', { year: 2024 })
          : n === 3
            ? final(
                JSON.stringify({
                  hint: '先想想函数的输入与输出关系。',
                  citations: [],
                  evidenceStatus: 'not-requested',
                }),
              )
            : final(),
    )
    f.request.questionIds = [question.id]
    f.request.currentQuestionId = question.id
    f.request.allowedTools.push('advise_selection')
    f.request.childConsent = true
    await f.agent.start(f.request)
    const result = await f.finish()
    expect(result.status).toBe('complete')
    expect(result.modelRequests).toBe(2)
    expect(result.delegatedCalls).toBe(2)
    expect(result.toolCalls).toBe(2)
    expect(f.search).toHaveBeenCalledTimes(1)
    expect(f.payloads[1].tools.map((tool: any) => tool.function.name)).toEqual([
      'web_search',
      'web_fetch',
    ])
    expect(JSON.stringify(f.payloads[2])).toContain(source.url)
    expect(JSON.stringify(f.payloads[3])).toContain(source.url)
    expect(
      result.events.some(
        (e) => e.role === 'child' && e.tool === 'web_search' && e.status === 'complete',
      ),
    ).toBe(true)
    expect(JSON.stringify(f.payloads)).not.toContain(question.explanation)
  })
  it('stops child repeated tool continuation at the shared two-request budget', async () => {
    const f = await fixture((n) =>
      n === 1
        ? call('advisor', 'advise_selection', {
            selectedText: 'Explain functions.',
            source: 'question',
          })
        : call(`child-${n}`, 'web_search', { year: 2024 }),
    )
    f.request.questionIds = [question.id]
    f.request.currentQuestionId = question.id
    f.request.allowedTools.push('advise_selection')
    f.request.childConsent = true
    await f.agent.start(f.request)
    const result = await f.finish()
    expect(result.status).toBe('failed')
    expect(result.message).toMatch(/续接轮次上限/)
    expect(f.payloads).toHaveLength(3)
    expect(f.search).toHaveBeenCalledTimes(1)
  })
  it('feeds actual retrieved sources into question generation and keeps host-built unverified attribution', async () => {
    const f = await fixture((n) =>
      n === 1
        ? call('search', 'web_search', { year: 2024 })
        : n === 2
          ? call('generate', 'generate_question', {
              topic: '等高线',
              difficulty: '基础',
              mode: 'terrain',
            })
          : n === 3
            ? final(JSON.stringify({ terrain: DEFAULT_TERRAIN, section: 'west-center' }))
            : final(),
    )
    f.request.subject = 'geography'
    f.request.mode = 'create'
    f.request.web!.scope.subject = 'geography'
    f.request.web!.scope.topic = '等高线'
    f.request.allowedTools.push('generate_question')
    await f.agent.start(f.request)
    const result = await f.finish()
    expect(result.status).toBe('complete')
    expect(result.proposals).toHaveLength(1)
    expect(JSON.stringify(f.payloads[2])).toContain(source.excerpt)
    const proposal = result.proposals[0].proposal
    expect(proposal.kind).toBe('question')
    if (proposal.kind === 'question') {
      expect(proposal.question.researchOrigin).toBe('unverified-source')
      expect(proposal.question.researchSources?.[0].url).toBe(source.url)
      expect(JSON.stringify(proposal.question.researchSources)).not.toContain(source.excerpt)
    }
  })
  it('invalidates a pending provider result when configuration changes', async () => {
    const f = await fixture((n) => (n === 1 ? call('search', 'web_search', {}) : final()))
    let resolve!: () => void
    f.search.mockImplementationOnce(async () => {
      await new Promise<void>((r) => {
        resolve = r
      })
      return {
        sources: [source],
        budget: {
          searchesUsed: 1,
          searchesLimit: 2,
          fetchesUsed: 0,
          fetchesLimit: 2,
          estimatedSearchCredits: 1,
          reportedCredits: null,
        },
        untrusted: true,
      }
    })
    await f.agent.start(f.request)
    await vi.waitFor(() => expect(f.search).toHaveBeenCalledTimes(1))
    f.changeRevision()
    resolve()
    expect((await f.finish()).status).toBe('failed')
    expect(f.payloads).toHaveLength(1)
  })
  it('clears proposed writes and suppresses late results on explicit cancellation', async () => {
    let resolve!: (value: Response) => void
    const f = await fixture(
      () =>
        new Promise<Response>((r) => {
          resolve = r
        }),
    )
    await f.agent.start(f.request)
    await vi.waitFor(() => expect(f.payloads).toHaveLength(1))
    f.agent.cancelCurrent()
    resolve(call('late-search', 'web_search', {}))
    await new Promise((r) => setTimeout(r, 10))
    expect(f.agent.get(f.request.runId)?.status).toBe('cancelled')
    expect(f.search).not.toHaveBeenCalled()
    expect(() => f.agent.discard(null)).toThrow('无效')
  })
})
