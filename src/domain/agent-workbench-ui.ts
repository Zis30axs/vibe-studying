import { canonicalModelConsentBaseUrl, type ModelConsentScope } from '../shared/model-consent'
import { AGENT_TOOL_NAMES, type AgentToolName } from '../shared/agent-tool-context'
import type { AgentRunRequest, AgentRunState, AgentWorkbenchApi } from '../shared/agent-workbench'
import type { AnswerDraft, ModelConfig, StudentQuestion, Subject } from '../shared/types'
import {
  buildWebResearchQuery,
  webResearchScopeSchema,
  type WebResearchScope,
} from '../shared/web-research'

export const AGENT_TOOL_LABELS: Record<AgentToolName, { label: string; description: string }> = {
  web_search: {
    label: '检索公开资料（Tavily）',
    description: '只发送下方预览的固定查询；每次 basic 搜索约 1 credit，主/子角色共享 2 次上限。',
  },
  web_fetch: {
    label: '读取本次公开来源（Fetch）',
    description: '只读取本次来源 ID 或已批准网址；公开 HTTPS、禁止跳转，共享 2 次上限。',
  },
  list_questions: { label: '查看题目列表', description: '仅本次确认的当前题目摘要。' },
  get_question: { label: '读取当前题目', description: '题干、选项和图形，不含参考答案。' },
  search_formulas: {
    label: '检索内置公式',
    description: '本学科公式、条件与例题；每次最多三条，不联网或读取教材。',
  },
  get_formula: {
    label: '按编号读取公式',
    description: '精确读取内置公式及来源，结果回传主模型并保留本地查阅凭据。',
  },
  search_knowledge: {
    label: '检索选定教材',
    description: '仅选定物理 PDF 页码，最多三段摘录；结果回传主模型。',
  },
  resolve_knowledge: {
    label: '精确读取教材片段或评阅索引',
    description: '仅选定物理 PDF 页码中的有效片段；与教材检索共享三段摘录额度。',
  },
  math_plot: {
    label: '函数数值采样',
    description: '安全算术表达式的有限数值采样，不生成图像或证明。',
  },
  math_measure: { label: '数学测量', description: '平面两点距离、三点夹角。' },
  geometry_calculate: {
    label: '空间几何与垂足计算',
    description: '真实三维坐标的向量、垂足、线面角与体积；有界本地计算。',
  },
  generate_geometry_question: {
    label: '参数化几何出题',
    description: '四类原创提示模板，输入有界参数，由本地工具计算并隔离参考答案，确认后入库。',
  },
  geography_measure: { label: '地理测量', description: '球面距离、比例尺换算和平均坡度。' },
  terrain_calculate: {
    label: '模拟地形计算',
    description: '确定性教学地形的高程、等高线层级和采样剖面。',
  },
  review_answer: {
    label: '评阅当前答卷',
    description: '本地规则或一次模型评阅；需要答卷与参考授权，不提交成绩。',
  },
  advise_selection: {
    label: '学习顾问委派',
    description: '对子题干或已授权作答中的精确选文调用子模型；联网续接计入共享委派预算。',
  },
  review_modules: {
    label: '模块检查委派',
    description: '调用子模型检查当前答卷模块，不直接修改；联网续接计入共享委派预算。',
  },
  generate_question: {
    label: '单次地理出题',
    description: '调用一次模型生成未核验题目，仅暂存待确认预览。',
  },
  propose_answer_edit: {
    label: '提出正文替换',
    description: '展示完整修改前后，确认后才应用；不自动提交。',
  },
  propose_question: {
    label: '提出新题目',
    description: '校验同学科题目并展示完整预览，确认后才保存题库。',
  },
}
export const AGENT_DELEGATE_TOOLS: readonly AgentToolName[] = [
  'review_answer',
  'advise_selection',
  'review_modules',
  'generate_question',
]
/** These tools transmit to the child receiver; other delegated calls use the parent. */
export const AGENT_CHILD_TOOLS: readonly AgentToolName[] = ['advise_selection', 'review_modules']
export const AGENT_DEFAULT_TOOLS: AgentToolName[] = [
  'list_questions',
  'get_question',
  'search_formulas',
  'get_formula',
  'search_knowledge',
  'resolve_knowledge',
  'math_plot',
  'math_measure',
  'geometry_calculate',
  // This default is visible only in math/create; it stages a preview and never saves.
  'generate_geometry_question',
  'geography_measure',
  'terrain_calculate',
]
export interface AgentToolUiScope {
  subject: Subject
  mode: AgentRunRequest['mode']
  hasQuestion: boolean
  includeAnswer: boolean
  hasModules: boolean
  includeReference: boolean
  hasKnowledge: boolean
  allowDelegation: boolean
  hasWeb?: boolean
}
export function availableAgentTools(scope: AgentToolUiScope): AgentToolName[] {
  return AGENT_TOOL_NAMES.filter((name) => {
    if (name === 'web_search' || name === 'web_fetch') return scope.hasWeb === true
    if (AGENT_DELEGATE_TOOLS.includes(name) && !scope.allowDelegation) return false
    if (['list_questions', 'get_question'].includes(name)) return scope.hasQuestion
    if (name === 'search_formulas' || name === 'get_formula')
      return scope.subject === 'math' || scope.subject === 'geography'
    if (name === 'search_knowledge' || name === 'resolve_knowledge') return scope.hasKnowledge
    if (['math_plot', 'math_measure', 'geometry_calculate'].includes(name))
      return scope.subject === 'math'
    if (['geography_measure', 'terrain_calculate'].includes(name))
      return scope.subject === 'geography'
    if (name === 'review_answer')
      return (
        scope.mode === 'review' &&
        scope.includeReference &&
        scope.includeAnswer &&
        scope.hasQuestion
      )
    if (name === 'advise_selection') return scope.hasQuestion
    if (name === 'review_modules')
      return scope.hasQuestion && scope.includeAnswer && scope.hasModules
    if (name === 'generate_geometry_question')
      return scope.mode === 'create' && scope.subject === 'math'
    if (name === 'generate_question')
      return scope.mode === 'create' && scope.subject === 'geography'
    if (name === 'propose_question') return scope.mode === 'create'
    if (name === 'propose_answer_edit') return scope.hasQuestion && scope.includeAnswer
    return false
  })
}
export function agentConsentScopes(scope: {
  includeAnswer: boolean
  includeReference: boolean
  hasKnowledge: boolean
  hasWeb?: boolean
}): ModelConsentScope[] {
  return [
    'agent',
    ...(scope.includeAnswer ? ['agent_answer' as const] : []),
    ...(scope.includeReference ? ['agent_reference' as const] : []),
    ...(scope.hasKnowledge ? ['agent_knowledge' as const] : []),
    ...(scope.hasWeb ? ['agent_web' as const] : []),
  ]
}

/** Only explicitly entered public labels enter search. No task, answer or textbook input. */
export function publicWebScopePreview(input: {
  subject: Subject
  topic: string
  region: string
  years: string
  approvedUrls: string
}): { scope: WebResearchScope; queries: string[]; error: '' } | { error: string } {
  try {
    const years = input.years
      .trim()
      .split(/[\s,，、]+/)
      .filter(Boolean)
    if (years.some((year) => !/^\d{4}$/.test(year))) throw new Error()
    const scope = webResearchScopeSchema.parse({
      subject: input.subject,
      topic: input.topic,
      region: input.region,
      years: [...new Set(years.map(Number))],
      approvedUrls: input.approvedUrls
        .split(/\r?\n/)
        .map((url) => url.trim())
        .filter(Boolean),
    })
    return {
      scope,
      queries: [
        ...new Set([
          buildWebResearchQuery(scope),
          ...scope.years.map((year) => buildWebResearchQuery(scope, year)),
        ]),
      ],
      error: '',
    }
  } catch {
    return {
      error:
        '请填写公开章节/主题、地区和 1–5 个年份（1990–2100）；网址每行一个，最多 3 个公开 HTTPS 地址。主题和地区只接受文字、数字、空格及常见分隔符。',
    }
  }
}
export function sameAgentReceiver(parent: ModelConfig | null, child: ModelConfig | null): boolean {
  try {
    return (
      !!parent &&
      !!child &&
      canonicalModelConsentBaseUrl(parent.baseUrl) === canonicalModelConsentBaseUrl(child.baseUrl)
    )
  } catch {
    return false
  }
}
export interface AgentAnswerApplication {
  questionId: string
  expectedText: string
  replacement: string
  baselineDraft: AnswerDraft
}
/** Reconcile a confirmed main-process write only while the full local baseline still matches. */
export function acceptedAgentDraft(
  current: AnswerDraft,
  input: AgentAnswerApplication,
): AnswerDraft | null {
  if (
    current.text !== input.expectedText ||
    JSON.stringify(current) !== JSON.stringify(input.baselineDraft)
  )
    return null
  return { ...current, text: input.replacement }
}
export interface AgentUiSnapshot {
  run: AgentRunState | null
  starting: boolean
  pendingProposal: string | null
  notice: string
}
/** Renderer-only race guard. No persistence, provider access or authorization decision. */
export class AgentUiSession {
  private state: AgentUiSnapshot = { run: null, starting: false, pendingProposal: null, notice: '' }
  private generation = 0
  private activeRunId: string | null = null
  private baseline?: AnswerDraft
  private listeners = new Set<() => void>()
  private polling = false
  private pendingAcceptance = false
  constructor(private readonly api: AgentWorkbenchApi) {}
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private publish(change: Partial<AgentUiSnapshot>) {
    this.state = { ...this.state, ...change }
    for (const listener of this.listeners) listener()
  }
  async start(request: AgentRunRequest): Promise<void> {
    if (this.state.starting || this.state.run?.status === 'running' || this.pendingAcceptance)
      return
    const generation = ++this.generation
    this.activeRunId = request.runId
    this.baseline = request.localDraft
      ? structuredClone(request.localDraft)
      : request.answer
        ? structuredClone(request.answer)
        : undefined
    this.publish({ starting: true, run: null, pendingProposal: null, notice: '' })
    try {
      const run = await this.api.startAgentRun(structuredClone(request))
      if (generation !== this.generation) {
        // Cancellation may have reached IPC before the initial reservation arrived.
        await this.api.cancelAgentRun(request.runId).catch(() => undefined)
        return
      }
      if (run.runId !== request.runId) throw new Error('Mismatched run')
      this.publish({ run })
    } catch {
      if (generation === this.generation) {
        this.activeRunId = null
        this.publish({ notice: '任务未启动。请检查模型配置、发送授权与会话预算后再试。' })
      }
    } finally {
      if (generation === this.generation) this.publish({ starting: false })
    }
  }
  async poll(): Promise<void> {
    if (this.polling || !this.activeRunId || this.state.run?.status !== 'running') return
    this.polling = true
    const runId = this.activeRunId,
      generation = this.generation
    try {
      const run = await this.api.getAgentRun(runId)
      if (generation !== this.generation) return
      if (!run || run.runId !== runId) {
        this.invalidate('本地任务已失效，请重新发起。')
        return
      }
      this.publish({ run })
    } catch {
      if (generation === this.generation)
        this.invalidate('无法读取本地任务状态，已请求停止。已发模型请求仍可能计费。')
    } finally {
      this.polling = false
    }
  }
  invalidate = (
    notice = '范围已更改，旧任务与待确认预览已停止。已发模型请求仍可能计费。',
  ): void => {
    const runId = this.activeRunId
    const generation = ++this.generation
    this.activeRunId = null
    this.baseline = undefined
    if (runId) {
      void this.api.cancelAgentRun(runId).catch(() => {
        if (generation === this.generation)
          this.publish({ notice: '未能确认停止。请勿继续发送；已发模型请求仍可能计费。' })
      })
      const run = this.state.run
      this.publish({
        starting: false,
        pendingProposal: null,
        notice,
        run: run
          ? {
              ...run,
              status: run.status === 'running' ? 'cancelled' : run.status,
              proposals: [],
              message: run.status === 'running' ? notice : run.message,
              events: run.events.map((event) =>
                event.status === 'running' ? { ...event, status: 'cancelled' } : event,
              ),
            }
          : null,
      })
    }
  }
  async accept(
    proposalId: string,
    current: () => { questionId?: string; draft?: AnswerDraft },
    applyAnswer: (input: AgentAnswerApplication) => boolean,
    acceptedQuestion: (question: StudentQuestion) => void,
  ): Promise<void> {
    const run = this.state.run,
      preview = run?.proposals.find((item) => item.proposalId === proposalId)
    if (
      !run ||
      run.status !== 'complete' ||
      !preview ||
      this.pendingAcceptance ||
      this.state.pendingProposal
    )
      return
    const live = current(),
      baseline = this.baseline ? structuredClone(this.baseline) : undefined
    if (
      preview.proposal.kind === 'answer-edit' &&
      (!baseline ||
        live.questionId !== preview.proposal.questionId ||
        JSON.stringify(live.draft) !== JSON.stringify(baseline))
    ) {
      this.publish({ notice: '当前题目或答卷已更改，旧建议不能应用。请重新发起帮助。' })
      return
    }
    this.pendingAcceptance = true
    const generation = this.generation
    this.publish({ pendingProposal: proposalId, notice: '' })
    try {
      const result = await this.api.acceptAgentProposal({
        runId: run.runId,
        proposalId,
        currentQuestionId: live.questionId,
        ...(live.draft ? { currentAnswer: structuredClone(live.draft) } : {}),
      })
      if (result.kind !== preview.proposal.kind) throw new Error('Mismatched proposal result')
      // Saving a question is already committed. Refresh the bank even if navigation occurred.
      if (result.kind === 'question') {
        if (
          preview.proposal.kind !== 'question' ||
          result.question.id !== preview.proposal.question.id
        )
          throw new Error('Mismatched saved question')
        acceptedQuestion(result.question)
      }
      if (result.kind === 'answer-edit') {
        const now = current()
        if (
          preview.proposal.kind !== 'answer-edit' ||
          !baseline ||
          result.questionId !== preview.proposal.questionId ||
          result.expectedText !== preview.proposal.expectedText ||
          result.replacement !== preview.proposal.replacement ||
          (generation === this.generation &&
            (now.questionId !== result.questionId ||
              JSON.stringify(now.draft) !== JSON.stringify(baseline))) ||
          !applyAnswer({ ...result, baselineDraft: baseline })
        ) {
          if (generation === this.generation)
            this.publish({
              run: {
                ...run,
                proposals: run.proposals.filter((item) => item.proposalId !== proposalId),
              },
              notice: '答卷已更新或预览已失效，未应用旧建议。',
            })
          return
        }
      }
      if (generation !== this.generation) return
      this.publish({
        run: { ...run, proposals: run.proposals.filter((item) => item.proposalId !== proposalId) },
        notice:
          result.kind === 'question'
            ? '已保存新题目到本地题库，当前答卷保持不变。'
            : '已应用到当前正文，未自动提交。',
      })
    } catch {
      if (generation === this.generation)
        this.publish({
          run: {
            ...run,
            proposals: run.proposals.filter((item) => item.proposalId !== proposalId),
          },
          notice: '未能确认应用。预览可能已失效；请检查当前答卷或题库，勿重复保存。',
        })
    } finally {
      this.pendingAcceptance = false
      if (generation === this.generation) this.publish({ pendingProposal: null })
    }
  }
  async discard(proposalId: string): Promise<void> {
    const run = this.state.run
    if (
      !run ||
      this.pendingAcceptance ||
      this.state.pendingProposal ||
      !run.proposals.some((item) => item.proposalId === proposalId)
    )
      return
    const generation = this.generation
    this.publish({ pendingProposal: proposalId })
    try {
      await this.api.discardAgentProposal({ runId: run.runId, proposalId })
      if (generation === this.generation)
        this.publish({
          run: {
            ...run,
            proposals: run.proposals.filter((item) => item.proposalId !== proposalId),
          },
          notice: '已丢弃预览，没有写入。',
        })
    } catch {
      if (generation === this.generation) this.publish({ notice: '未能丢弃预览，请重试。' })
    } finally {
      if (generation === this.generation) this.publish({ pendingProposal: null })
    }
  }
}
