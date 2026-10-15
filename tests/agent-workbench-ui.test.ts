import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  AgentWorkbench,
  AgentProposalContent,
  AgentWebSources,
} from '../src/components/AgentWorkbench'
import {
  AgentUiSession,
  AGENT_DEFAULT_TOOLS,
  AGENT_CHILD_TOOLS,
  acceptedAgentDraft,
  AGENT_DELEGATE_TOOLS,
  availableAgentTools,
  agentConsentScopes,
  sameAgentReceiver,
  publicWebScopePreview,
  type AgentToolUiScope,
} from '../src/domain/agent-workbench-ui'
import {
  AGENT_BUDGET,
  type AgentRunRequest,
  type AgentRunState,
  type AgentWorkbenchApi,
} from '../src/shared/agent-workbench'
import { emptyDraft, type AnswerDraft, type ModelConfig, type Question } from '../src/shared/types'
import { emptyModelConsents } from '../src/shared/model-consent'
import {
  buildWebResearchQuery,
  type WebResearchConfig,
  type WebResearchSource,
} from '../src/shared/web-research'
import { WebResearchSettings } from '../src/components/WebResearchSettings'

const webConfig: WebResearchConfig = {
  provider: 'tavily',
  revision: 1,
  configured: true,
  keyStatus: 'session',
  secureStorageAvailable: true,
}

const config: ModelConfig = {
  protocol: 'openai-chat',
  baseUrl: 'https://api.vendor.com/v1',
  model: 'synthetic-model',
  configured: true,
  revision: 1,
}
const draft = (): AnswerDraft => ({ ...emptyDraft(), text: 'Original answer' })
const request = (extra: Partial<AgentRunRequest> = {}): AgentRunRequest => ({
  runId: 'run-1',
  task: 'Inspect current question',
  subject: 'math',
  mode: 'learner',
  questionIds: ['q1'],
  currentQuestionId: 'q1',
  localDraft: draft(),
  answer: draft(),
  includeReference: false,
  allowedTools: ['get_question'],
  configRevision: 1,
  parentConsent: true,
  childConsent: false,
  ...extra,
})
const run = (extra: Partial<AgentRunState> = {}): AgentRunState => ({
  runId: 'run-1',
  status: 'running',
  startedAt: 1,
  elapsedMs: 350,
  modelRequests: 1,
  toolCalls: 0,
  delegatedCalls: 0,
  sessionRequests: 1,
  budget: AGENT_BUDGET,
  events: [],
  text: '',
  message: '',
  proposals: [],
  ...extra,
})
const proposed = () =>
  run({
    status: 'complete',
    text: '<script>untrusted text</script>',
    proposals: [
      {
        proposalId: 'p1',
        proposal: {
          kind: 'answer-edit',
          questionId: 'q1',
          expectedText: 'Original answer',
          replacement: 'Revised answer',
          reason: 'Clarify',
        },
      },
    ],
  })
const question: Question = {
  id: 'new-q',
  subject: 'math',
  kind: 'math',
  title: 'New question',
  prompt: 'Question prompt',
  source: 'AI',
  tags: ['test'],
  maxScore: 5,
  explanation: 'Reference explanation',
  rubric: [{ id: 'r1', label: 'Method', keywords: ['method'], points: 5 }],
}
function apiMock(overrides: Partial<AgentWorkbenchApi> = {}): AgentWorkbenchApi {
  return {
    startAgentRun: vi.fn(async () => run()),
    getAgentRun: vi.fn(async () => run()),
    cancelAgentRun: vi.fn(async () => {}),
    acceptAgentProposal: vi.fn(async () => ({
      kind: 'answer-edit' as const,
      questionId: 'q1',
      expectedText: 'Original answer',
      replacement: 'Revised answer',
    })),
    discardAgentProposal: vi.fn(async () => {}),
    ...overrides,
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((a, b) => {
    resolve = a
    reject = b
  })
  return { promise, resolve, reject }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const scope = (extra: Partial<AgentToolUiScope> = {}): AgentToolUiScope => ({
  subject: 'math',
  mode: 'learner',
  hasQuestion: true,
  includeAnswer: false,
  hasModules: false,
  includeReference: false,
  hasKnowledge: false,
  allowDelegation: false,
  ...extra,
})

describe('Agent renderer capability and consent scope', () => {
  it('defaults to reads/computation and a math-create-only staged generator without delegated calls or writes', () => {
    expect(AGENT_DEFAULT_TOOLS.some((name) => AGENT_DELEGATE_TOOLS.includes(name))).toBe(false)
    expect(AGENT_DEFAULT_TOOLS).not.toContain('propose_answer_edit')
    expect(AGENT_DEFAULT_TOOLS).toContain('generate_geometry_question')
    expect(availableAgentTools(scope({ mode: 'create' }))).toContain('generate_geometry_question')
    expect(availableAgentTools(scope({ mode: 'review' }))).not.toContain(
      'generate_geometry_question',
    )
    expect(availableAgentTools(scope())).toEqual([
      'list_skills',
      'run_skill',
      'list_questions',
      'get_question',
      'search_formulas',
      'get_formula',
      'math_plot',
      'math_measure',
      'geometry_calculate',
    ])
    expect(availableAgentTools(scope({ subject: 'geography' }))).toEqual([
      'list_skills',
      'run_skill',
      'list_questions',
      'get_question',
      'search_formulas',
      'get_formula',
      'geography_measure',
      'terrain_calculate',
    ])
  })
  it('filters review, creation, textbook and answer tools against explicit context', () => {
    const learner = availableAgentTools(scope({ allowDelegation: true }))
    expect(learner).toContain('advise_selection')
    expect(learner).not.toContain('review_answer')
    expect(learner).not.toContain('review_modules')
    expect(
      availableAgentTools(
        scope({
          mode: 'review',
          includeAnswer: true,
          includeReference: true,
          hasModules: true,
          hasKnowledge: true,
          allowDelegation: true,
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        'search_knowledge',
        'review_answer',
        'review_modules',
        'propose_answer_edit',
      ]),
    )
    expect(
      availableAgentTools(scope({ subject: 'geography', mode: 'create', allowDelegation: true })),
    ).toEqual(expect.arrayContaining(['generate_question', 'propose_question']))
    expect(
      availableAgentTools(scope({ subject: 'math', mode: 'create', allowDelegation: true })),
    ).not.toContain('generate_question')
    expect(
      availableAgentTools(
        scope({ hasQuestion: false, includeAnswer: true, hasModules: true, allowDelegation: true }),
      ),
    ).not.toEqual(expect.arrayContaining(['get_question', 'propose_answer_edit']))
  })
  it('separates paid delegation limits from child-receiver disclosure', () => {
    expect(AGENT_DELEGATE_TOOLS).toEqual(
      expect.arrayContaining([
        'review_answer',
        'generate_question',
        'advise_selection',
        'review_modules',
      ]),
    )
    expect(AGENT_CHILD_TOOLS).toEqual(['advise_selection', 'review_modules'])
  })
  it('uses distinct Agent grants, shares exactly canonical receivers, and fails closed', () => {
    expect(
      agentConsentScopes({ includeAnswer: false, includeReference: false, hasKnowledge: false }),
    ).toEqual(['agent'])
    expect(
      agentConsentScopes({ includeAnswer: true, includeReference: true, hasKnowledge: true }),
    ).toEqual(['agent', 'agent_answer', 'agent_reference', 'agent_knowledge'])
    expect(
      sameAgentReceiver(config, {
        ...config,
        baseUrl: 'https://API.vendor.com:443/v1/',
        model: 'other',
      }),
    ).toBe(true)
    expect(sameAgentReceiver(config, { ...config, baseUrl: 'https://api.vendor.com/v2' })).toBe(
      false,
    )
    expect(sameAgentReceiver(config, null)).toBe(false)
    expect(
      sameAgentReceiver({ ...config, baseUrl: 'not a URL' }, { ...config, baseUrl: 'not a URL' }),
    ).toBe(false)
  })
  it('enables bounded network tools only after opt-in across subjects and roles', () => {
    expect(AGENT_DEFAULT_TOOLS).not.toContain('web_search')
    expect(AGENT_DEFAULT_TOOLS).not.toContain('web_fetch')
    for (const subject of [
      'math',
      'geography',
      'history',
      'english',
      'chinese',
      'politics',
    ] as const) {
      for (const mode of ['learner', 'review', 'create'] as const) {
        expect(availableAgentTools(scope({ subject, mode }))).not.toContain('web_search')
        expect(availableAgentTools(scope({ subject, mode, hasWeb: true }))).toEqual(
          expect.arrayContaining(['web_search', 'web_fetch']),
        )
      }
    }
    expect(
      agentConsentScopes({
        includeAnswer: false,
        includeReference: false,
        hasKnowledge: false,
        hasWeb: true,
      }),
    ).toEqual(['agent', 'agent_web'])
  })
  it('previews exactly the public fixed templates and ignores unrelated private fields', () => {
    const input = {
      subject: 'math' as const,
      topic: '函数与导数',
      region: '全国卷',
      years: '2024，2023 2024',
      approvedUrls: 'https://education.gov.cn/papers/2024',
    }
    const preview = publicWebScopePreview({
      ...input,
      task: 'PRIVATE TASK',
      answer: 'PRIVATE ANSWER',
      textbook: 'PRIVATE TEXTBOOK',
    } as typeof input)
    expect(preview.error).toBe('')
    if (!('scope' in preview)) throw new Error('Expected valid public scope')
    expect(preview.scope.years).toEqual([2024, 2023])
    expect(preview.queries).toEqual([
      buildWebResearchQuery(preview.scope),
      buildWebResearchQuery(preview.scope, 2024),
      buildWebResearchQuery(preview.scope, 2023),
    ])
    expect(JSON.stringify(preview)).not.toContain('PRIVATE')
    expect(preview.queries[0]).toBe('数学 函数与导数 全国卷 2023 2024 历年试题 考点 公开资料')
    for (const change of [
      { topic: '' },
      { region: '' },
      { years: '' },
      { years: '2023-2025' },
      { years: '2020 2021 2022 2023 2024 2025' },
      { topic: 'Bearer secret: abc' },
      { approvedUrls: 'https://127.0.0.1/private' },
      { approvedUrls: 'https://school.edu.cn/paper?api_key=secret' },
      { approvedUrls: 'https://a.edu.cn\nhttps://b.edu.cn\nhttps://c.edu.cn\nhttps://d.edu.cn' },
    ])
      expect(publicWebScopePreview({ ...input, ...change }).error).toBeTruthy()
  })
})

describe('Agent renderer run/accept race guards without provider calls', () => {
  it('starts exactly once on repeated clicks; clones the task snapshot', async () => {
    const waiting = deferred<AgentRunState>(),
      api = apiMock({ startAgentRun: vi.fn(() => waiting.promise) }),
      session = new AgentUiSession(api),
      input = request()
    const first = session.start(input)
    await session.start(input)
    input.answer!.text = 'Changed after click'
    expect(api.startAgentRun).toHaveBeenCalledTimes(1)
    expect(vi.mocked(api.startAgentRun).mock.calls[0][0].answer?.text).toBe('Original answer')
    waiting.resolve(run())
    await first
    expect(session.getSnapshot().run?.status).toBe('running')
  })
  it('polls locally until a terminal result and never restarts a denied/budget-limited run', async () => {
    const api = apiMock({
        getAgentRun: vi.fn(async () =>
          run({
            status: 'failed',
            modelRequests: 3,
            toolCalls: 6,
            message: '本次 Agent 轮次或工具预算已用尽；没有自动重试。',
          }),
        ),
      }),
      session = new AgentUiSession(api)
    await session.start(request())
    await session.poll()
    await session.poll()
    expect(api.startAgentRun).toHaveBeenCalledTimes(1)
    expect(api.getAgentRun).toHaveBeenCalledTimes(1)
    expect(session.getSnapshot().run?.message).toContain('预算已用尽')
    const denied = new AgentUiSession(
      apiMock({
        startAgentRun: vi.fn(async () => {
          throw new Error('Bearer secret https://raw.provider/debug')
        }),
      }),
    )
    await denied.start(request())
    expect(denied.getSnapshot().notice).toContain('任务未启动')
    expect(JSON.stringify(denied.getSnapshot())).not.toMatch(/Bearer|raw.provider/)
  })
  it('cancels before a delayed start returns and discards its late response', async () => {
    const waiting = deferred<AgentRunState>(),
      api = apiMock({ startAgentRun: vi.fn(() => waiting.promise) }),
      session = new AgentUiSession(api)
    const first = session.start(request())
    session.invalidate('Newer input')
    waiting.resolve(proposed())
    await first
    expect(api.cancelAgentRun).toHaveBeenCalledWith('run-1')
    expect(session.getSnapshot().run).toBeNull()
    expect(session.getSnapshot().notice).toBe('Newer input')
  })
  it('never resurrects a canceled run from an in-flight poll and stops after read errors', async () => {
    const waiting = deferred<AgentRunState | null>(),
      api = apiMock({ getAgentRun: vi.fn(() => waiting.promise) }),
      session = new AgentUiSession(api)
    await session.start(request())
    const polling = session.poll()
    session.invalidate('Hidden')
    waiting.resolve(proposed())
    await polling
    expect(session.getSnapshot().run?.status).toBe('cancelled')
    expect(session.getSnapshot().run?.proposals).toEqual([])
    const brokenApi = apiMock({
        getAgentRun: vi.fn(async () => {
          throw new Error('Internal error')
        }),
      }),
      broken = new AgentUiSession(brokenApi)
    await broken.start(request())
    await broken.poll()
    await broken.poll()
    expect(brokenApi.getAgentRun).toHaveBeenCalledTimes(1)
    expect(brokenApi.cancelAgentRun).toHaveBeenCalledTimes(1)
  })
  it('does not let an old cancellation failure overwrite a newer run', async () => {
    const cancelled = deferred<void>(),
      api = apiMock({
        cancelAgentRun: vi.fn(() => cancelled.promise),
        startAgentRun: vi.fn(async (input) => run({ runId: input.runId })),
      }),
      session = new AgentUiSession(api)
    await session.start(request())
    session.invalidate()
    await session.start(request({ runId: 'run-2' }))
    cancelled.reject(new Error('Late'))
    await tick()
    expect(session.getSnapshot().run?.runId).toBe('run-2')
    expect(session.getSnapshot().notice).toBe('')
  })
  it('double acceptance issues one operation and applies only the exact frozen full draft', async () => {
    const waiting = deferred<Awaited<ReturnType<AgentWorkbenchApi['acceptAgentProposal']>>>(),
      api = apiMock({
        startAgentRun: vi.fn(async () => proposed()),
        acceptAgentProposal: vi.fn(() => waiting.promise),
      }),
      session = new AgentUiSession(api),
      apply = vi.fn(() => true),
      saved = vi.fn(),
      live = () => ({ questionId: 'q1', draft: draft() })
    await session.start(request())
    const first = session.accept('p1', live, apply, saved)
    await session.accept('p1', live, apply, saved)
    expect(api.acceptAgentProposal).toHaveBeenCalledTimes(1)
    expect(apply).not.toHaveBeenCalled()
    waiting.resolve({
      kind: 'answer-edit' as const,
      questionId: 'q1',
      expectedText: 'Original answer',
      replacement: 'Revised answer',
    })
    await first
    expect(apply).toHaveBeenCalledOnce()
    expect(saved).not.toHaveBeenCalled()
    expect(session.getSnapshot().run?.proposals).toEqual([])
    await session.accept('p1', live, apply, saved)
    expect(api.acceptAgentProposal).toHaveBeenCalledTimes(1)
  })
  it('rejects stale before acceptance, after acceptance and inside parent apply guard', async () => {
    for (const boundary of ['before', 'after', 'parent']) {
      const waiting = deferred<Awaited<ReturnType<AgentWorkbenchApi['acceptAgentProposal']>>>(),
        api = apiMock({
          startAgentRun: vi.fn(async () => proposed()),
          acceptAgentProposal: vi.fn(() => waiting.promise),
        }),
        session = new AgentUiSession(api),
        apply = vi.fn(() => boundary !== 'parent')
      let current = draft()
      await session.start(request())
      if (boundary === 'before') current.drawing.points.push({ id: 'point', x: 0, y: 0, label: '' })
      const acceptance = session.accept(
        'p1',
        () => ({ questionId: 'q1', draft: current }),
        apply,
        vi.fn(),
      )
      if (boundary === 'after') current = { ...draft(), text: 'Newer answer' }
      waiting.resolve({
        kind: 'answer-edit',
        questionId: 'q1',
        expectedText: 'Original answer',
        replacement: 'Revised answer',
      })
      await acceptance
      if (boundary === 'before') expect(api.acceptAgentProposal).not.toHaveBeenCalled()
      if (boundary !== 'parent') expect(apply).not.toHaveBeenCalled()
      expect(session.getSnapshot().notice).toMatch(/已更改|已更新/)
    }
  })
  it('discard is explicit, cannot race acceptance, and removes preview without applying', async () => {
    const waiting = deferred<void>(),
      api = apiMock({
        startAgentRun: vi.fn(async () => proposed()),
        discardAgentProposal: vi.fn(() => waiting.promise),
      }),
      session = new AgentUiSession(api),
      apply = vi.fn()
    await session.start(request())
    const discard = session.discard('p1')
    await session.accept('p1', () => ({ questionId: 'q1', draft: draft() }), apply, vi.fn())
    await session.discard('p1')
    expect(api.discardAgentProposal).toHaveBeenCalledTimes(1)
    expect(api.acceptAgentProposal).not.toHaveBeenCalled()
    waiting.resolve()
    await discard
    expect(session.getSnapshot().run?.proposals).toEqual([])
  })
  it('refreshes a committed new question after navigation without overwriting any draft', async () => {
    const waiting = deferred<Awaited<ReturnType<AgentWorkbenchApi['acceptAgentProposal']>>>(),
      api = apiMock({
        startAgentRun: vi.fn(async () =>
          run({
            status: 'complete',
            proposals: [{ proposalId: 'p1', proposal: { kind: 'question', question } }],
          }),
        ),
        acceptAgentProposal: vi.fn(() => waiting.promise),
      }),
      session = new AgentUiSession(api),
      apply = vi.fn(),
      saved = vi.fn()
    await session.start(request())
    const acceptance = session.accept(
      'p1',
      () => ({ questionId: 'q1', draft: draft() }),
      apply,
      saved,
    )
    session.invalidate('Left view')
    waiting.resolve({ kind: 'question', question })
    await acceptance
    expect(saved).toHaveBeenCalledWith(question)
    expect(apply).not.toHaveBeenCalled()
  })
  it('reconciles a committed answer after navigation while a live target CAS protects newer edits', async () => {
    for (const editedAfterNavigation of [false, true]) {
      const waiting = deferred<Awaited<ReturnType<AgentWorkbenchApi['acceptAgentProposal']>>>()
      const api = apiMock({
        startAgentRun: vi.fn(async () => proposed()),
        acceptAgentProposal: vi.fn(() => waiting.promise),
      })
      const session = new AgentUiSession(api)
      let stored = draft()
      const apply = vi.fn((input) => {
        const next = acceptedAgentDraft(stored, input)
        if (!next) return false
        stored = next
        return true
      })
      await session.start(request())
      const accepting = session.accept(
        'p1',
        () => ({ questionId: 'q1', draft: draft() }),
        apply,
        vi.fn(),
      )
      session.invalidate('Navigated to practice')
      if (editedAfterNavigation) stored = { ...stored, text: 'Newer practice edit' }
      waiting.resolve({
        kind: 'answer-edit',
        questionId: 'q1',
        expectedText: 'Original answer',
        replacement: 'Revised answer',
      })
      await accepting
      expect(apply).toHaveBeenCalledOnce()
      expect(stored.text).toBe(editedAfterNavigation ? 'Newer practice edit' : 'Revised answer')
      expect(session.getSnapshot().notice).toBe('Navigated to practice')
    }
  })
  it('removes an uncertain acceptance to prevent an accidental repeated write', async () => {
    const api = apiMock({
        startAgentRun: vi.fn(async () => proposed()),
        acceptAgentProposal: vi.fn(async () => {
          throw new Error('Uncertain IPC reply')
        }),
      }),
      session = new AgentUiSession(api)
    await session.start(request())
    await session.accept('p1', () => ({ questionId: 'q1', draft: draft() }), vi.fn(), vi.fn())
    await session.accept('p1', () => ({ questionId: 'q1', draft: draft() }), vi.fn(), vi.fn())
    expect(api.acceptAgentProposal).toHaveBeenCalledTimes(1)
    expect(session.getSnapshot().notice).toContain('勿重复保存')
  })
})

describe('Agent workbench safe static render', () => {
  it('renders bounded, opt-in scope with disabled start and no side effects', () => {
    const api = {
      ...apiMock(),
      getModelConsents: vi.fn(async () => emptyModelConsents()),
      grantModelConsent: vi.fn(async () => emptyModelConsents()),
      revokeModelConsent: vi.fn(async () => emptyModelConsents()),
      listKnowledgeDocuments: vi.fn(async () => []),
      getWebResearchConfig: vi.fn(async () => webConfig),
      saveWebResearchConfig: vi.fn(async () => webConfig),
    }
    const html = renderToStaticMarkup(
      createElement(AgentWorkbench, {
        api,
        parentConfig: config,
        childConfig: config,
        configRevision: 1,
        currentQuestion: question,
        currentAnswer: draft(),
        onApplyAnswer: vi.fn(),
        onAcceptedQuestion: vi.fn(),
      }),
    )
    expect(html).toContain('maxLength="4000"')
    expect(html).toContain('最多 100 页')
    expect(html).toContain('已发请求仍可能计费')
    expect(html).toContain('失败不会自动重试')
    expect(html).toMatch(/disabled=""[^>]*>开始本次 Agent 任务/)
    expect(html).not.toContain('propose_answer_edit')
    expect(html).not.toContain('dangerouslySetInnerHTML')
    expect(api.startAgentRun).not.toHaveBeenCalled()
    expect(api.listKnowledgeDocuments).not.toHaveBeenCalled()
    expect(api.getWebResearchConfig).not.toHaveBeenCalled()
    expect(html).toContain('本次任务允许联网')
    expect(html).not.toContain('实际外发查询预览')
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
    expect(app).toContain('latestStudyRef.current.drafts[input.questionId]')
    expect(app).toContain('acceptedAgentDraft(current, input)')
  })
  it('renders sources as escaped text, blocks unsafe links and never certifies exam years', () => {
    const source: WebResearchSource = {
      sourceId: 'web-id-1',
      title: '<script>Source title</script>',
      url: 'https://education.gov.cn/paper/2024',
      excerpt: '<img src=x onerror=alert(1)>',
      retrievedAt: '2026-10-11T00:00:00.000Z',
      retrieved: true,
      yearEvidence: [{ year: 2024, evidence: '<b>2024</b>' }],
      provenance: 'tavily-search',
      untrusted: true,
      verification: 'unverified',
    }
    const html = renderToStaticMarkup(
      createElement(AgentWebSources, {
        sources: [
          source,
          { ...source, sourceId: 'unsafe', url: 'javascript:alert(1)', yearEvidence: [] },
        ],
      }),
    )
    expect(html).toContain('&lt;script&gt;Source title&lt;/script&gt;')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('来源网址（可复制）')
    expect(html).toContain('readOnly=""')
    expect(html).not.toContain('<a ')
    expect(html).not.toContain('href="javascript:')
    expect(html).toContain('来源地址无效')
    expect(html).toContain('来源提及 2024')
    expect(html).toContain('未核验为官方真题')
    expect(html).toContain('未找到可展示的年份证据')
  })
  it('keeps Tavily keys independent, masked and opt-in without rendering credentials', () => {
    const api = {
      getWebResearchConfig: vi.fn(async () => webConfig),
      saveWebResearchConfig: vi.fn(async () => webConfig),
    }
    const html = renderToStaticMarkup(createElement(WebResearchSettings, { api }))
    expect(html).toContain('type="password"')
    expect(html).toContain('留空保留已有密钥')
    expect(html).toContain('新输入默认只用于本次应用会话')
    expect(html).toContain('清除已有 Tavily Key')
    expect(html).not.toContain('checked=""')
    expect(api.getWebResearchConfig).not.toHaveBeenCalled()
    expect(api.saveWebResearchConfig).not.toHaveBeenCalled()
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
    expect(app).toContain('<WebResearchSettings api={api!} />')
  })
  it('previews every validated question field and escapes model-looking HTML as text', () => {
    const edit = renderToStaticMarkup(
      createElement(AgentProposalContent, {
        proposal: {
          kind: 'answer-edit',
          questionId: 'q1',
          expectedText: '<script>before</script>',
          replacement: '<img src=x onerror=alert(1)>',
          reason: 'Reason',
        },
      }),
    )
    expect(edit).not.toContain('<script>')
    expect(edit).toContain('&lt;script&gt;')
    expect(edit).toContain('修改前完整正文')
    expect(edit).toContain('修改后完整正文')
    const full = renderToStaticMarkup(
      createElement(AgentProposalContent, { proposal: { kind: 'question', question } }),
    )
    for (const value of [question.id, question.explanation, 'keywords', 'points', '未核验'])
      expect(full).toContain(value)
  })
  it('labels adapted or unverified-source proposals from host provenance rather than claiming originals', () => {
    for (const [researchOrigin, label] of [
      ['adapted', 'AI 改编练习'],
      ['unverified-source', '来源未核验的 AI 练习'],
    ] as const) {
      const html = renderToStaticMarkup(
        createElement(AgentProposalContent, {
          proposal: { kind: 'question', question: { ...question, researchOrigin } },
        }),
      )
      expect(html).toContain(label)
      expect(html).toContain('尚未核验为官方真题')
      expect(html).not.toContain('AI 原创练习')
    }
  })
  it('uses existing theme tokens and responsive stacked layout', () => {
    const css = readFileSync(
      new URL('../src/components/agent-workbench.css', import.meta.url),
      'utf8',
    )
    expect(css).toContain('var(--app-surface)')
    expect(css).toContain('var(--app-text)')
    expect(css).toContain('max-width: 540px')
    expect(css).toContain(':focus-visible')
    expect(css).not.toMatch(/#[a-fA-F0-9]{3,8}\b/)
  })
})
