import { randomUUID } from 'node:crypto'
import { geometryToolInputSchema } from '../src/shared/geometry'
import { executeGeometryTool } from '../src/domain/geometry'
import { compileGeometryTemplate } from '../src/domain/geometry-templates'
import { geometryTemplateToolSchema } from '../src/shared/geometry-templates'
import { FORMULA_CATALOG_VERSION } from '../src/domain/formula-catalog'
import { getFormula, searchFormulas } from '../src/domain/formula-reference'
import {
  formulaSearchInputSchema,
  formulaGetInputSchema,
  FORMULA_PROVENANCE,
} from '../src/shared/formula-tools'
import { executeTerrainTool, terrainToolInputSchema } from '../src/domain/terrain'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { version as appVersion } from '../package.json'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { AgentAdapter, QuestionBankAdapter } from '../src/adapters/contracts'
import { matchesScope } from '../src/adapters/local-question-bank'
import { studentQuestionProjection } from '../src/domain/student-question'
import {
  draftWireSchema,
  idSchema,
  scopeSchema,
  validateAnswer,
  type QuestionScope,
} from '../src/domain/schemas'

export interface McpReferenceOptions {
  /** Trusted hosts opt in explicitly. Never give a full-reference server to a solver. */
  referenceAccess?: 'student' | 'full'
}

export function createExamCraftMcpServer(
  bank: QuestionBankAdapter,
  agent: AgentAdapter,
  inputScope: QuestionScope = {},
  options: McpReferenceOptions = {},
): McpServer {
  const allowedScope = scopeSchema.parse(inputScope)
  const referenceAccess = options.referenceAccess ?? 'student'
  if (referenceAccess !== 'student' && referenceAccess !== 'full')
    throw new Error('referenceAccess must be student or full')
  // Capture once at startup. Tool arguments cannot change this capability.
  const project = (question: Awaited<ReturnType<QuestionBankAdapter['get']>>) =>
    referenceAccess === 'full' ? question : studentQuestionProjection(question)
  const server = new McpServer(
    { name: 'examcraft-local', version: appVersion },
    { maxToolInputElements: 10000 },
  )
  const result = (value: Record<string, unknown>): CallToolResult => ({
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  })
  const run = async (
    operation: () => Promise<Record<string, unknown>>,
  ): Promise<CallToolResult> => {
    try {
      return result(await operation())
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: error instanceof Error ? error.message : '操作失败' }],
      }
    }
  }
  const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  server.registerTool(
    'list_questions',
    {
      title: '列出范围内的题目',
      description: `列出允许范围内的本地题目。过滤只能缩小启动范围。启动参考权限：${referenceAccess}；student 仅返回题干、选项和公开元数据，full 包含参考答案。`,
      inputSchema: scopeSchema.shape,
      annotations,
    },
    async (scope) =>
      run(async () => ({
        questions: (await bank.list(allowedScope))
          .filter((question) => matchesScope(question, scope))
          .map(project),
      })),
  )
  server.registerTool(
    'get_question',
    {
      title: '读取题目',
      description: `读取范围内的一道题。启动参考权限：${referenceAccess}；student 不含答案、解析、评分规则或参考模块；full 仅供可信题库/评阅宿主。`,
      inputSchema: { questionId: idSchema },
      annotations,
    },
    async ({ questionId }) =>
      run(async () => ({ question: project(await bank.get(questionId, allowedScope)) })),
  )
  server.registerTool(
    'review_answer',
    {
      title: '本地规则评阅',
      description:
        '选择题精确对照答案；主观题仅做关键词匹配，不理解语义、嵌套或绘图。含 argument 的作答只检查最终 text；旧版 blocks 仍支持。必须提交有效作答，评阅结果会包含解析和评分反馈，因此只应授予明确的提交评阅角色，不应加入解题/Advisor 上下文。评阅不保存桌面作答记录。',
      inputSchema: { questionId: idSchema, draft: draftWireSchema },
      annotations,
    },
    async ({ questionId, draft }) =>
      run(async () => {
        const question = await bank.get(questionId, allowedScope)
        return { review: await agent.review(question, validateAnswer(question, draft, true)) }
      }),
  )
  // General teaching formulas are public bundled references, available without
  // answer-key access. A startup subject can only narrow the catalog.
  if (
    !allowedScope.subject ||
    allowedScope.subject === 'math' ||
    allowedScope.subject === 'geography'
  ) {
    const formulaSubject = allowedScope.subject as 'math' | 'geography' | undefined
    server.registerTool(
      'search_formulas',
      {
        title: '检索内置公式速查',
        description:
          '只读离线公式库，每次最多三条，含适用条件、符号、例题及来源。不能改变启动学科范围；不读取题目答案或教材，不访问来源网页。引用须保留确切 ID 与公式库版本。',
        inputSchema: formulaSearchInputSchema,
        annotations,
      },
      async (input) =>
        run(async () => ({
          catalogVersion: FORMULA_CATALOG_VERSION,
          provenance: FORMULA_PROVENANCE,
          formulas: searchFormulas(input.query, {
            subject: formulaSubject,
            chapter: input.chapter,
            limit: input.limit ?? 3,
          }),
        })),
    )
    server.registerTool(
      'get_formula',
      {
        title: '按编号读取内置公式',
        description:
          '读取内置公式的完整适用条件、例题及来源，未知或跨启动学科编号失败；不计算当前题目，不改写答卷。',
        inputSchema: formulaGetInputSchema,
        annotations,
      },
      async ({ formulaId }) =>
        run(async () => {
          const formula = getFormula(formulaId)
          if (!formula) throw new Error('内置公式编号不存在；请先检索并使用返回的确切编号。')
          if (formulaSubject && formula.subject !== formulaSubject)
            throw new Error('公式不在启动时允许的学科范围内。')
          return {
            catalogVersion: FORMULA_CATALOG_VERSION,
            provenance: FORMULA_PROVENANCE,
            formula,
          }
        }),
    )
  }
  // A teaching calculator can disclose computed answers. Expose it only to the
  // startup-authorized teaching role, never through a student request parameter.
  if (
    referenceAccess === 'full' &&
    (!allowedScope.subject || allowedScope.subject === 'geography')
  ) {
    server.registerTool(
      'terrain_calculate',
      {
        title: '计算模拟教学地形',
        description:
          '严格有界的本地地形计算器。输入模拟地形规格和可选探测点/剖面，返回米制高程、等高线层级、分辨率、水平距离、有符号高差、端点平均坡度百分数和倾角。非真实 DEM 或经纬度。不读取题库答案、不联网、不执行代码；不返回密集网格。计算结果可用于出题或获准的解析，不能当作实测数据。',
        inputSchema: terrainToolInputSchema,
        annotations,
      },
      async (input) => run(async () => ({ result: executeTerrainTool(input) })),
    )
  }
  if (referenceAccess === 'full' && (!allowedScope.subject || allowedScope.subject === 'math')) {
    server.registerTool(
      'geometry_calculate',
      {
        title: '计算三维几何与垂足',
        description:
          '有界本地几何计算器。使用真实xyz坐标，支持向量角、垂足、线面角及体积；拒绝退化输入，不联网、不执行代码、不修改题库。计算结果可能揭示答案，仅限启动时full教学权限。',
        inputSchema: geometryToolInputSchema,
        annotations,
      },
      async (input) => run(async () => ({ result: executeGeometryTool(input) })),
    )
    server.registerTool(
      'generate_geometry_question',
      {
        title: '生成参数化几何题',
        description:
          '四类原创几何提示模板的本地编译器：只收有界模板参数，宿主计算真实三维场景和参考解，返回完整待审核题目，不保存题库。含参考答案，仅限启动时full教学权限；student不可通过参数扩大权限。',
        inputSchema: geometryTemplateToolSchema,
        annotations,
      },
      async (input) =>
        run(async () => ({
          question: compileGeometryTemplate(input, `geometry-${randomUUID()}`),
          saved: false,
        })),
    )
  }
  return server
}
