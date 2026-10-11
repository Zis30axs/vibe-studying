import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createExamCraftMcpServer } from '../mcp/create-server'
import { LocalQuestionBank } from '../src/adapters/local-question-bank'
import { LocalRuleAgent } from '../src/adapters/local-rule-agent'
import { GEOMETRY_TEMPLATE_CATALOG } from '../src/shared/geometry-templates'
import { questionSchema } from '../src/domain/schemas'

const clients: Client[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()))
})
async function fixture(access: 'student' | 'full', subject: 'math' | 'geography' = 'math') {
  const server = createExamCraftMcpServer(
    new LocalQuestionBank(),
    new LocalRuleAgent(),
    { subject },
    { referenceAccess: access },
  )
  const client = new Client({ name: 'geometry-test', version: '1' })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  await client.connect(ct)
  clients.push(client)
  return client
}
describe('geometry teaching tools over real MCP protocol', () => {
  it('exposes bounded geometry calculators only to startup full math role', async () => {
    const full = await fixture('full')
    const names = (await full.listTools()).tools.map((t) => t.name)
    expect(names).toContain('geometry_calculate')
    expect(names).toContain('generate_geometry_question')
    for (const client of [await fixture('student'), await fixture('full', 'geography')]) {
      const n = (await client.listTools()).tools.map((t) => t.name)
      expect(n).not.toContain('geometry_calculate')
      expect(n).not.toContain('generate_geometry_question')
      expect(
        (
          await client.callTool({
            name: 'generate_geometry_question',
            arguments: { templateId: 'square-pyramid-locus', parameters: { side: 5 } },
          })
        ).isError,
      ).toBe(true)
    }
  })
  it('publishes object JSON Schemas and computes each template with no bank writes', async () => {
    const client = await fixture('full')
    const tools = (await client.listTools()).tools
    for (const name of ['geometry_calculate', 'generate_geometry_question'])
      expect(tools.find((t) => t.name === name)?.inputSchema.type).toBe('object')
    expect(
      tools.find((t) => t.name === 'generate_geometry_question')?.inputSchema.properties,
    ).toHaveProperty('templateId')
    expect(
      tools.find((t) => t.name === 'generate_geometry_question')?.inputSchema.properties,
    ).toHaveProperty('parameters')
    for (const template of GEOMETRY_TEMPLATE_CATALOG) {
      const result = await client.callTool({
        name: 'generate_geometry_question',
        arguments: { templateId: template.id, parameters: template.defaultParameters },
      })
      expect(result.isError).not.toBe(true)
      const data = result.structuredContent as { question: unknown; saved: boolean }
      expect(questionSchema.safeParse(data.question).success).toBe(true)
      expect(data.saved).toBe(false)
    }
    const bank = await client.callTool({ name: 'list_questions', arguments: {} })
    expect((bank.structuredContent as { questions: unknown[] }).questions).toHaveLength(3)
    const metric = await client.callTool({
      name: 'geometry_calculate',
      arguments: {
        request: {
          operation: 'tetrahedron_volume',
          a: { x: 0, y: 0, z: 0 },
          b: { x: 3, y: 0, z: 0 },
          c: { x: 0, y: 4, z: 0 },
          d: { x: 0, y: 0, z: 5 },
        },
      },
    })
    expect(metric.isError).not.toBe(true)
    expect(metric.structuredContent).toMatchObject({ result: { volume: 10 } })
  })
  it('rejects bad coordinates, degenerate geometry, unsupported parameters and widening access', async () => {
    const client = await fixture('full')
    for (const args of [
      {
        request: {
          operation: 'point_line_foot',
          point: { x: 0, y: 0, z: 0 },
          a: { x: 1, y: 1, z: 1 },
          b: { x: 1, y: 1, z: 1 },
        },
      },
      {
        request: {
          operation: 'vector_metrics',
          a: { x: 1e9, y: 0, z: 0 },
          b: { x: 1, y: 0, z: 0 },
        },
      },
    ])
      expect((await client.callTool({ name: 'geometry_calculate', arguments: args })).isError).toBe(
        true,
      )
    for (const args of [
      { templateId: 'square-pyramid-locus', parameters: { side: 0 } },
      { templateId: 'square-pyramid-locus', parameters: { side: 5 }, referenceAccess: 'full' },
      { templateId: 'square-pyramid-locus', parameters: { side: 5, answer: 1 } },
    ])
      expect(
        (await client.callTool({ name: 'generate_geometry_question', arguments: args })).isError,
      ).toBe(true)
  })
})
