import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
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
    { name: 'examcraft-local', version: '0.1.0' },
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
  return server
}
