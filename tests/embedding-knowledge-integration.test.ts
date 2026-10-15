import { build } from 'esbuild'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { LocalKnowledgeLibrary } from '../src/adapters/knowledge-library'
import { EmbeddingService } from '../src/adapters/embedding-service'
import { createAgentToolRegistry } from '../src/adapters/agent-tool-registry'
import { createKnowledgePdf } from './fixtures/knowledge-pdf'

let directory: string
let workerPath: string
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'examcraft-vector-integration-'))
  workerPath = resolve(`dist-electron/knowledge-${basename(directory)}.cjs`)
  await build({
    entryPoints: ['src/adapters/knowledge-pdf-worker.ts'],
    outfile: workerPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['pdfjs-dist/*'],
  })
})
afterAll(async () => {
  await rm(workerPath, { force: true })
  await rm(directory, { recursive: true, force: true })
})

it('connects real PDF evidence, confirmed vectors and Agent skills without granting other pages or profiles', async () => {
  const library = new LocalKnowledgeLibrary(directory, { workerPath })
  const imported = await library.importBytes(
    '合成数学资料',
    createKnowledgePdf([
      '椭圆焦点定义与离心率。此页为原创测试内容。',
      'PRIVATE_OTHER_PAGE_TEST：另一页不在本次确认范围。',
    ]),
    { subject: 'math' },
  )
  if (imported.canceled) throw new Error('Unexpected import cancellation')
  const documentId = imported.document.id
  const scope = { subject: 'math' as const, documentId, startPage: 1, endPage: 1 }
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          data: [{ index: 0, embedding: [1, 0, 0] }],
        }),
      ),
  )
  const embeddings = new EmbeddingService(directory, { library, fetchImpl })
  const config = await embeddings.saveConfig({
    enabled: true,
    baseUrl: 'https://synthetic.example/v1',
    model: 'test-vector',
    apiKey: 'synthetic-integration-key-never-real',
    expectedRevision: 0,
  })
  const hits = (await embeddings.searchLocal({ ...scope, query: '椭圆' })).hits!
  expect(hits).toHaveLength(1)
  const index = await embeddings.prepare({
    ...scope,
    kind: 'index',
    chunkIds: [hits[0].chunkId],
    expectedRevision: config.revision,
  })
  expect(fetchImpl).not.toHaveBeenCalled()
  await embeddings.confirm({ previewId: index.previewId, cloudConsent: true })
  // This query has no lexical overlap with the synthetic page. It must still be possible
  // to explicitly embed it and retrieve the already indexed page without uploading again.
  const query = 'conic eccentricity'
  expect(await library.search({ ...scope, query })).toEqual([])
  const search = await embeddings.prepare({
    ...scope,
    kind: 'search',
    chunkIds: [],
    query,
    expectedRevision: config.revision,
  })
  expect(search.texts.map((text) => text.text)).toEqual([query])
  const result = await embeddings.confirm({ previewId: search.previewId, cloudConsent: true })
  expect(result.mode).toBe('vector')
  expect(result.hits?.map((hit) => hit.chunkId)).toEqual([hits[0].chunkId])
  const registry = createAgentToolRegistry(
    {
      subject: 'math',
      mode: 'learner',
      questionIds: [],
      includeReference: false,
      allowedTools: ['run_skill', 'search_knowledge'],
      knowledge: { documentId, startPage: 1, endPage: 1 },
      parentConsent: { knowledge: true, reference: false },
      childConsent: { knowledge: false, reference: false },
    },
    {
      getQuestion: async () => {
        throw new Error('No question authorized')
      },
      searchKnowledge: async (input) =>
        ((await embeddings.searchLocal(input)).hits ?? []).map(
          ({ score: _score, ...evidence }) => evidence,
        ),
    },
  )
  const response = await registry.execute({
    name: 'run_skill',
    arguments: {
      skillId: 'textbook-evidence-search',
      input: { query },
    },
  })
  expect(response.isError).toBeUndefined()
  expect(JSON.stringify(response)).toContain(hits[0].chunkId)
  expect(JSON.stringify(response)).not.toContain('PRIVATE_OTHER_PAGE_TEST')
  expect(fetchImpl).toHaveBeenCalledTimes(2)
  const otherProfile = new EmbeddingService(join(directory, 'other-profile'), {
    library,
    fetchImpl,
  })
  expect(await otherProfile.getConfig()).toMatchObject({ enabled: false, configured: false })
  expect((await otherProfile.searchLocal({ ...scope, query })).mode).toBe('keyword')
  // Tampering with the content-addressed source invalidates cached vectors and keywords.
  const source = join(directory, 'knowledge-library', documentId, 'source.pdf')
  const original = await readFile(source)
  await writeFile(source, Buffer.concat([original, Buffer.from('tampered')]))
  await expect(embeddings.searchLocal({ ...scope, query })).rejects.toThrow()
  expect(fetchImpl).toHaveBeenCalledTimes(2)
})
