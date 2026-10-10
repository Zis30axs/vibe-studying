import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { McpAgentAdapter, McpQuestionBankAdapter } from '../src/adapters/mcp-adapters'
import { emptyDraft, type ArgumentNode } from '../src/shared/types'

function structured(response: Record<string, unknown>): Record<string, unknown> {
  expect(response.structuredContent).toBeTruthy()
  return response.structuredContent as Record<string, unknown>
}

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
          '--reference-access',
          'full',
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
    expect((await bank.get('geo-choice-1')).correctAnswer).toBe('C')
    expect((await bank.get('geo-choice-1')).explanation).toBeTruthy()
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

describe('new subjects over real MCP stdio', () => {
  let directory: string
  let output: string
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'examcraft-mcp-subjects-'))
    output = join(directory, 'server.cjs')
    await build({
      entryPoints: [resolve('mcp/server.ts')],
      outfile: output,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
    })
  }, 30000)
  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
  })
  it('defaults to student projection and tool arguments cannot grant reference access', async () => {
    const client = new Client({ name: 'student-access-test', version: '1.0.0' })
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [output, '--subject', 'geography'],
          stderr: 'pipe',
        }),
      )
      const listed = await client.callTool({ name: 'list_questions', arguments: {} })
      expect(listed.isError).not.toBe(true)
      const questions = structured(listed).questions as Record<string, unknown>[]
      expect(questions.length).toBeGreaterThan(0)
      const publicKeys = [
        'id',
        'subject',
        'kind',
        'title',
        'prompt',
        'source',
        'tags',
        'maxScore',
        'choices',
      ]
      for (const question of questions) {
        expect(Object.keys(question).every((key) => publicKeys.includes(key))).toBe(true)
        for (const key of ['explanation', 'rubric', 'correctAnswer', 'blocks'])
          expect(question).not.toHaveProperty(key)
        const got = await client.callTool({
          name: 'get_question',
          arguments: { questionId: question.id },
        })
        expect(structured(got).question).toEqual(question)
      }
      for (const name of ['list_questions', 'get_question']) {
        const attempted = await client.callTool({
          name,
          arguments: {
            ...(name === 'get_question' ? { questionId: questions[0].id } : {}),
            referenceAccess: 'full',
          },
        })
        // SDK may reject unknown keys or strip them; neither path grants access.
        if (!attempted.isError) {
          const result = structured(attempted)
          const returned =
            name === 'get_question' ? [result.question] : (result.questions as unknown[])
          for (const question of returned)
            for (const key of ['explanation', 'rubric', 'correctAnswer', 'blocks'])
              expect(question).not.toHaveProperty(key)
        }
      }
      const outside = await client.callTool({
        name: 'get_question',
        arguments: { questionId: 'pol-choice-1' },
      })
      expect(outside.isError).toBe(true)
      const narrowed = await client.callTool({
        name: 'list_questions',
        arguments: { subject: 'politics' },
      })
      expect(structured(narrowed).questions).toEqual([])
      const adapter = new McpQuestionBankAdapter(client)
      await expect(adapter.list()).rejects.toThrow('reference access')
      await expect(adapter.get('geo-choice-1')).rejects.toThrow('reference access')
      const empty = await client.callTool({
        name: 'review_answer',
        arguments: { questionId: 'geo-choice-1', draft: emptyDraft() },
      })
      expect(empty.isError).toBe(true)
      const submitted = await client.callTool({
        name: 'review_answer',
        arguments: { questionId: 'geo-choice-1', draft: { ...emptyDraft(), choiceId: 'A' } },
      })
      expect(submitted.isError).not.toBe(true)
      expect(structured(submitted).review).toHaveProperty('explanation')
    } finally {
      await client.close()
    }
  })
  it.each(['chinese', 'math', 'english', 'history'] as const)(
    '%s supports list/get/review and cannot widen scope',
    async (subject) => {
      const client = new Client({ name: 'new-subject-test', version: '1.0.0' })
      try {
        await client.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [output, '--reference-access', 'full', '--subject', subject],
            stderr: 'pipe',
          }),
        )
        const bank = new McpQuestionBankAdapter(client)
        const questions = await bank.list({ subject })
        expect(questions).toHaveLength(3)
        expect(questions.every((q) => q.subject === subject)).toBe(true)
        expect(await bank.list({ subject: 'politics' })).toEqual([])
        await expect(bank.get('pol-choice-1')).rejects.toThrow('MCP 工具返回错误')
        const written = questions.find((q) => q.kind === subject)!
        expect(await bank.get(written.id)).toEqual(written)
        const review = await new McpAgentAdapter(client).review(written, {
          ...emptyDraft(),
          text: written.rubric!.map((r) => r.keywords[0]).join(' '),
          ...(subject === 'math'
            ? {
                math: {
                  expression: 'a*x^2+b*x+c',
                  parameters: { a: 1, b: 0, c: -1 },
                  drawing: {
                    mode: 'cartesian' as const,
                    points: [
                      { id: 'A', x: 0, y: 0, label: 'A' },
                      { id: 'B', x: 3, y: 4, label: 'B' },
                    ],
                    lines: [],
                  },
                  measurement: ['A', 'B'],
                },
              }
            : {}),
        })
        expect(review.score).toBe(written.maxScore)
        if (subject === 'math') {
          const invalidMath = await client.callTool({
            name: 'review_answer',
            arguments: {
              questionId: written.id,
              draft: {
                ...emptyDraft(),
                text: '合成数学答案',
                math: {
                  expression: 'x^2',
                  parameters: { a: 1, b: 0, c: 0 },
                  drawing: { mode: 'cartesian', points: [], lines: [] },
                  measurement: ['missing-point'],
                },
              },
            },
          })
          expect(invalidMath.isError).toBe(true)
        }
        const forbidden = await client.callTool({
          name: 'review_answer',
          arguments: { questionId: 'pol-choice-1', draft: { ...emptyDraft(), choiceId: 'A' } },
        })
        expect(forbidden.isError).toBe(true)
      } finally {
        await client.close()
      }
    },
  )
  it('publishes bounded argument input and reviews only the current final answer over stdio', async () => {
    const client = new Client({ name: 'nested-argument-test', version: '1.0.0' })
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [output, '--reference-access', 'full', '--subject', 'history'],
          stderr: 'pipe',
        }),
      )
      const tools = await client.listTools()
      const schema = tools.tools.find((tool) => tool.name === 'review_answer')!.inputSchema
      expect(JSON.stringify(schema)).toContain('"argument"')
      expect(JSON.stringify(schema)).toContain('"cause"')
      const bank = new McpQuestionBankAdapter(client)
      const question = (await bank.list()).find((q) => q.kind === 'history')!
      const current = question.rubric!.map((r) => r.keywords[0]).join(' ')
      const roots: ArgumentNode[] = [
        {
          id: 'point',
          kind: 'point',
          text: '观点',
          children: [
            {
              id: 'cause',
              kind: 'cause',
              text: '因果',
              children: [{ id: 'material', kind: 'material', text: current, children: [] }],
            },
          ],
        },
      ]
      const draft = { ...emptyDraft(), text: current, argument: { version: 1 as const, roots } }
      const agent = new McpAgentAdapter(client)
      expect((await agent.review(question, draft)).score).toBe(question.maxScore)
      expect((await agent.review(question, { ...draft, text: '未覆盖要点的答案' })).score).toBe(0)
      for (const invalidRoots of [
        [roots[0], structuredClone(roots[0])],
        [{ id: 'leaf', kind: 'analysis', text: '', children: roots }],
        [
          {
            id: 'too-many',
            kind: 'point',
            text: '',
            children: Array.from({ length: 80 }, (_, i) => ({
              id: `child-${i}`,
              kind: 'analysis',
              text: '',
              children: [],
            })),
          },
        ],
      ]) {
        const invalid = await client.callTool({
          name: 'review_answer',
          arguments: {
            questionId: question.id,
            draft: {
              ...draft,
              argument: { version: 1, roots: invalidRoots },
            },
          },
        })
        expect(invalid.isError).toBe(true)
      }
      const missingFinal = await client.callTool({
        name: 'review_answer',
        arguments: {
          questionId: question.id,
          draft: { ...draft, text: '' },
        },
      })
      expect(missingFinal.isError).toBe(true)
      // A rejected structured draft must not break the server or widen its scope.
      expect((await bank.list()).every((q) => q.subject === 'history')).toBe(true)
      expect((await agent.review(question, { ...emptyDraft(), text: current })).score).toBe(
        question.maxScore,
      )
    } finally {
      await client.close()
    }
  })
})
