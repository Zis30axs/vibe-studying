import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { z } from 'zod'
import type { AnswerDraft, Question } from '../shared/types'
import {
  draftSchema,
  idSchema,
  questionSchema,
  reviewSchema,
  scopeSchema,
  type QuestionScope,
} from '../domain/schemas'
import type { AgentAdapter, QuestionBankAdapter, Review } from './contracts'

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<unknown> {
  const response = await client.callTool({ name, arguments: args })
  if (response.isError) throw new Error('MCP 工具返回错误，请检查服务器范围和输入')
  if (response.structuredContent) return response.structuredContent
  const content = response.content
  if (!Array.isArray(content)) throw new Error('MCP 返回格式错误')
  const text = content.find((item) => item && typeof item === 'object' && item.type === 'text')
  if (!text || typeof text.text !== 'string') throw new Error('MCP 未返回 JSON 结果')
  return JSON.parse(text.text) as unknown
}

/** The host owns the connected, trusted Client. Adapters never accept or launch commands. */
export class McpQuestionBankAdapter implements QuestionBankAdapter {
  readonly name = 'MCP 题库适配器'
  constructor(private readonly client: Client) {}
  async list(scope: QuestionScope = {}): Promise<Question[]> {
    const response = await call(this.client, 'list_questions', scopeSchema.parse(scope))
    return z.strictObject({ questions: z.array(questionSchema).max(1000) }).parse(response)
      .questions
  }
  async get(questionId: string, scope: QuestionScope = {}): Promise<Question> {
    // Locally enforce any additional caller scope as well as the server's scope.
    const id = idSchema.parse(questionId)
    if (
      Object.keys(scope).length &&
      !(await this.list(scope)).some((question) => question.id === id)
    )
      throw new Error('题目不在允许范围内')
    return z
      .strictObject({ question: questionSchema })
      .parse(await call(this.client, 'get_question', { questionId: id })).question
  }
}
export class McpAgentAdapter implements AgentAdapter {
  readonly name = 'MCP 评阅适配器'
  constructor(private readonly client: Client) {}
  async review(question: Question, draft: AnswerDraft): Promise<Review> {
    return z
      .strictObject({ review: reviewSchema })
      .parse(
        await call(this.client, 'review_answer', {
          questionId: idSchema.parse(question.id),
          draft: draftSchema.parse(draft),
        }),
      ).review
  }
}
