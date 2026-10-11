import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelService } from '../src/adapters/model-service'
import { DEFAULT_TERRAIN } from '../src/domain/terrain'
import type { ModelProtocol, Question } from '../src/shared/types'
const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})
function envelope(protocol: ModelProtocol, output: unknown) {
  const text = JSON.stringify(output)
  if (protocol === 'anthropic')
    return { stop_reason: 'end_turn', content: [{ type: 'text', text }] }
  if (protocol === 'gemini')
    return { candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] }
  if (protocol === 'openai-responses')
    return {
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
    }
  return { choices: [{ finish_reason: 'stop', message: { content: text } }] }
}
describe.each(['anthropic', 'gemini', 'openai-responses', 'openai-chat'] as const)(
  '%s structured terrain generation, mocked transport',
  (protocol) => {
    it('actually computes model-selected parameters and only persists reference answers after acceptance', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'terrain-generation-'))
      directories.push(directory)
      const response = {
        terrain: { ...DEFAULT_TERRAIN, preset: 'depression' },
        section: 'west-center',
      }
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(envelope(protocol, response))))
      const saved: Question[] = []
      const models = new ModelService(directory, {
        fetchImpl: fetcher,
        timeoutMs: 1000,
        listQuestions: async () => saved,
        persistGenerated: async (question) => {
          saved.push(question)
        },
      })
      const config = await models.saveConfig({
        protocol,
        baseUrl: 'https://api.vendor.com',
        model: 'synthetic-terrain-model',
        apiKey: 'synthetic-terrain-key',
      })
      const result = await models.generateGeographyQuestion({
        requestId: 'terrain-1',
        mode: 'terrain',
        syllabus: '高中地理',
        chapter: '等高线',
        difficulty: '基础',
        cloudConsent: true,
        configRevision: config.revision,
      })
      expect(fetcher).toHaveBeenCalledTimes(1)
      const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body))
      const input = JSON.parse(
        protocol === 'gemini'
          ? body.contents[0].parts[0].text
          : protocol === 'openai-responses'
            ? body.input
            : body.messages.at(-1).content,
      )
      expect(input).toEqual({
        syllabus: '高中地理',
        chapter: '等高线',
        difficulty: '基础',
        mode: 'terrain',
      })
      expect(result.question.terrain?.terrain.preset).toBe('depression')
      expect(result.question.prompt).toContain('A(250, 1000) 的高程为 325 m')
      expect(result.question.prompt).toContain('B(1000, 1000) 的高程为 100 m')
      expect(result.question).not.toHaveProperty('explanation')
      expect(result.question).not.toHaveProperty('rubric')
      expect(result.question).not.toHaveProperty('terrainEvidence')
      expect(saved).toEqual([])
      const accepted = await models.acceptGeneratedQuestion(result.token)
      expect(accepted).toEqual(result.question)
      expect(saved[0].explanation).toContain('-225 m')
      expect(saved[0].explanation).toContain('-30%')
      expect(saved[0].source).toContain('本地数值计算')
      expect(models.getGenerationStatus().used).toBe(1)
    })
  },
)
