import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { AgentAdapter, QuestionBankAdapter } from '../src/adapters/contracts'
import { matchesScope } from '../src/adapters/local-question-bank'
import {
  draftSchema,
  idSchema,
  scopeSchema,
  validateAnswer,
  type QuestionScope,
} from '../src/domain/schemas'

export function createExamCraftMcpServer(
  bank: QuestionBankAdapter,
  agent: AgentAdapter,
  inputScope: QuestionScope = {},
): McpServer {
  const allowedScope = scopeSchema.parse(inputScope)
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
      description:
        '列出允许学科、全部指定标签和题目 ID 范围内的本地题目。请求过滤只会缩小启动时限定的范围。',
      inputSchema: scopeSchema.shape,
      annotations,
    },
    async (scope) =>
      run(async () => ({
        questions: (await bank.list(allowedScope)).filter((question) =>
          matchesScope(question, scope),
        ),
      })),
  )
  server.registerTool(
    'get_question',
    {
      title: '读取题目',
      description: '读取范围内的一道练习题（包含参考答案和解析，适合学习而非考试监考）。',
      inputSchema: { questionId: idSchema },
      annotations,
    },
    async ({ questionId }) =>
      run(async () => ({ question: await bank.get(questionId, allowedScope) })),
  )
  server.registerTool(
    'review_answer',
    {
      title: '本地规则评阅',
      description:
        '选择题精确对照答案；主观题仅做关键词匹配，不理解语义或绘图。评阅不保存桌面作答记录。',
      inputSchema: { questionId: idSchema, draft: draftSchema },
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
