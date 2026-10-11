import { describe, expect, it, vi } from 'vitest'
import { ModelTransport } from '../src/adapters/model-transport'
import { ModelToolTransport } from '../src/adapters/model-tool-transport'
import type { ModelProtocol } from '../src/shared/types'
const key = 'sk-synthetic-encoded-model-key-never-real'
const protocols: ModelProtocol[] = ['anthropic', 'gemini', 'openai-responses', 'openai-chat']
const encodings = [
  [...key].map((c) => `%${c.charCodeAt(0).toString(16)}`).join(''),
  [...key].map((c) => `&#${c.charCodeAt(0)};`).join(''),
  Buffer.from(key).toString('base64url'),
  Buffer.from(key).toString('hex').toUpperCase(),
]
function envelope(protocol: ModelProtocol, text: string) {
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
describe.each(protocols)('%s encoded credential reflection', (protocol) => {
  it.each(encodings)(
    'rejects reversible encoding from JSON and native outputs without raw diagnostic data',
    async (encoded) => {
      const recorded: unknown[] = []
      const config = { protocol, baseUrl: 'https://api.vendor.com', model: 'synthetic-model' }
      const fetcher = vi.fn(
        async () =>
          new Response(JSON.stringify(envelope(protocol, JSON.stringify({ text: encoded })))),
      ) as typeof fetch
      const json = new ModelTransport(config, key, fetcher, 1000, (e) => recorded.push(e))
      await expect(json.json('test', { synthetic: true })).rejects.toMatchObject({
        category: 'credential_reflection',
      })
      const native = new ModelToolTransport(config, key, fetcher, 1000, (e) => recorded.push(e))
      await expect(
        native.start('test', { synthetic: true }, [
          {
            name: 'safe_tool',
            description: 'Synthetic',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          },
        ]),
      ).rejects.toMatchObject({ category: 'credential_reflection' })
      expect(JSON.stringify(recorded)).not.toContain(key)
      expect(JSON.stringify(recorded)).not.toContain(encoded)
    },
  )
})
