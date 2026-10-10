import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { McpAgentAdapter, McpQuestionBankAdapter } from '../src/adapters/mcp-adapters'
import { emptyDraft } from '../src/shared/types'

describe('real MCP stdio client/server', () => {
  let directory: string
  let client: Client
  let bank: McpQuestionBankAdapter
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'examcraft-mcp-'))
    const output = join(directory, 'server.cjs')
    await build({
      entryPoints: [resolve('mcp/server.ts')],
      outfile: output,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
    })
    client = new Client({ name: 'examcraft-integration-test', version: '1.0.0' })
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          output,
          '--subject',
          'geography',
          '--tag',
          '经纬网',
          '--question-id',
          'geo-choice-1',
        ],
        stderr: 'pipe',
      }),
    )
    bank = new McpQuestionBankAdapter(client)
  }, 30000)
  afterAll(async () => {
    await client?.close()
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  it('negotiates tools and reads only the server allowed scope', async () => {
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      'get_question',
      'list_questions',
      'review_answer',
    ])
    const questions = await bank.list()
    expect(questions.map((question) => question.id)).toEqual(['geo-choice-1'])
    expect((await bank.get('geo-choice-1')).title).toBe('经纬网中的方向')
  })
  it('cannot widen scope through list, get, or review', async () => {
    expect(await bank.list({ subject: 'politics' })).toEqual([])
    await expect(bank.get('pol-choice-1')).rejects.toThrow('MCP 工具返回错误')
    await expect(bank.get('geo-drawing-1')).rejects.toThrow('MCP 工具返回错误')
    const forbidden = await client.callTool({
      name: 'review_answer',
      arguments: { questionId: 'pol-choice-1', draft: { ...emptyDraft(), choiceId: 'A' } },
    })
    expect(forbidden.isError).toBe(true)
  })
  it('reviews a choice through the SDK adapter and rejects invalid draft input', async () => {
    const question = await bank.get('geo-choice-1')
    const agent = new McpAgentAdapter(client)
    expect((await agent.review(question, { ...emptyDraft(), choiceId: 'C' })).score).toBe(4)
    expect((await agent.review(question, { ...emptyDraft(), choiceId: 'A' })).score).toBe(0)
    const invalid = await client.callTool({
      name: 'review_answer',
      arguments: {
        questionId: question.id,
        draft: {
          ...emptyDraft(),
          drawing: { mode: 'cartesian', points: [{ id: 'x', x: 999, y: 0, label: '' }], lines: [] },
        },
      },
    })
    expect(invalid.isError).toBe(true)
  })
})
