import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EmbeddingService } from '../src/adapters/embedding-service'
import { KnowledgeVectorIndex, embeddingFingerprint } from '../src/adapters/knowledge-vector-index'
import {
  canonicalEmbeddingBaseUrl,
  embeddingConfigInputSchema,
  EMBEDDING_DIAGNOSTIC_TEXT,
  type EmbeddingConfigInput,
  type EmbeddingPrepareInput,
} from '../src/shared/embeddings'
import type { KnowledgeEvidence } from '../src/shared/knowledge'

// Synthetic credentials and canonical source fixtures only; every provider request is mocked.
const secret = 'synthetic-embedding-key-never-real'
const documentId = 'a'.repeat(64)
const scope = { subject: 'math' as const, documentId, startPage: 1, endPage: 3 }
const evidence: KnowledgeEvidence[] = [
  {
    chunkId: `${documentId}:p1:c1`,
    documentId,
    subject: 'math',
    documentTitle: 'Synthetic Geometry',
    pageNumber: 1,
    text: '圆锥曲线的焦点与离心率。',
  },
  {
    chunkId: `${documentId}:p2:c1`,
    documentId,
    subject: 'math',
    documentTitle: 'Synthetic Geometry',
    pageNumber: 2,
    text: '椭圆方程与几何条件。',
  },
]
const dirs: string[] = []
function response(
  vectors = [
    [1, 0, 0],
    [0, 1, 0],
  ],
) {
  return new Response(
    JSON.stringify({ data: vectors.map((embedding, index) => ({ index, embedding })) }),
  )
}
function vault() {
  const envelopes = new Map<string, string>()
  return {
    isAvailable: vi.fn(() => true),
    encryptString: vi.fn((plain: string) => {
      const cipher = Buffer.from(`mock-os-encrypted:${randomUUID()}`).toString('base64')
      envelopes.set(cipher, plain)
      return cipher
    }),
    decryptString: vi.fn((cipher: string) => {
      if (!envelopes.has(cipher)) throw new Error(secret)
      return envelopes.get(cipher)!
    }),
  }
}
async function setup(extra: Partial<ConstructorParameters<typeof EmbeddingService>[1]> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'examcraft-embedding-'))
  dirs.push(directory)
  let canonical = structuredClone(evidence)
  const library = {
    resolveChunks: vi.fn(async (ids: string[]) =>
      ids.map((id) => {
        const item = canonical.find((item) => item.chunkId === id)
        if (!item) throw new Error('Missing source')
        return structuredClone(item)
      }),
    ),
    search: vi.fn(async () => [{ ...canonical[0], score: 100 }]),
  }
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
    throw new Error(`Unexpected request ${secret}`)
  })
  const options = { library, fetchImpl, timeoutMs: 1000, ...extra }
  const service = new EmbeddingService(directory, options)
  const save = async (overrides: Partial<EmbeddingConfigInput> = {}) =>
    service.saveConfig({
      enabled: true,
      baseUrl: 'https://embedding.vendor.example/v1',
      model: 'embed-model',
      apiKey: secret,
      persistApiKey: false,
      expectedRevision: (await service.getConfig()).revision,
      ...overrides,
    })
  const prepare = async (
    kind: 'index' | 'search' = 'index',
    overrides: Partial<EmbeddingPrepareInput> = {},
  ) =>
    service.prepare({
      ...scope,
      kind,
      chunkIds: evidence.map((item) => item.chunkId),
      expectedRevision: (await service.getConfig()).revision,
      ...(kind === 'search' ? { query: '离心率' } : {}),
      ...overrides,
    })
  return {
    directory,
    service,
    save,
    prepare,
    fetchImpl,
    library,
    changeSource: (items: KnowledgeEvidence[]) => {
      canonical = structuredClone(items)
    },
    restart: () => new EmbeddingService(directory, options),
  }
}
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('independent Embedding configuration and credential boundary', () => {
  it('returns a safe schema failure instead of throwing from an invalid endpoint transform', async () => {
    const invalid = {
      enabled: true,
      baseUrl: 'http://example.com',
      model: 'embed',
      expectedRevision: 0,
    }
    expect(() => embeddingConfigInputSchema.safeParse(invalid)).not.toThrow()
    expect(embeddingConfigInputSchema.safeParse(invalid).success).toBe(false)
    const s = await setup()
    await expect(s.service.saveConfig(invalid)).rejects.toThrow('设置无效')
    expect(s.fetchImpl).not.toHaveBeenCalled()
  })
  it('defaults disabled, saves session-only without network, never inherits or persists a chat key', async () => {
    const s = await setup()
    expect(await s.service.getConfig()).toMatchObject({
      enabled: false,
      configured: false,
      keyStatus: 'missing',
    })
    const state = await s.save()
    expect(state).toMatchObject({ enabled: true, keyStatus: 'session', configured: true })
    expect(JSON.stringify(state)).not.toContain(secret)
    expect(await readFile(join(s.directory, 'embedding-config.json'), 'utf8')).not.toContain(secret)
    expect(await s.restart().getConfig()).toMatchObject({
      enabled: true,
      keyStatus: 'missing',
      configured: false,
    })
    expect(s.fetchImpl).not.toHaveBeenCalled()
  })
  it('persists only OS ciphertext bound to its own endpoint and fails closed if locked', async () => {
    const secureStorage = vault()
    const s = await setup({ secureStorage })
    await s.save({ persistApiKey: true })
    expect(await s.restart().getConfig()).toMatchObject({ keyStatus: 'saved', configured: true })
    const disk = await readFile(join(s.directory, 'embedding-config.json'), 'utf8')
    expect(disk).not.toContain(secret)
    secureStorage.isAvailable.mockReturnValue(false)
    expect(await s.restart().getConfig()).toMatchObject({ keyStatus: 'locked', configured: false })
    await expect(s.save({ persistApiKey: true })).rejects.toThrow('安全存储')
    expect(await readFile(join(s.directory, 'embedding-config.json'), 'utf8')).toBe(disk)
  })
  it('clears the key when changing provider and rejects stale revisions without a request', async () => {
    const s = await setup({ secureStorage: vault() })
    await s.save({ persistApiKey: true })
    const revision = (await s.service.getConfig()).revision
    expect(
      await s.save({ baseUrl: 'https://different.vendor.example/v1', apiKey: undefined }),
    ).toMatchObject({ keyStatus: 'missing', configured: false })
    await expect(
      s.service.prepare({
        ...scope,
        kind: 'index',
        chunkIds: [evidence[0].chunkId],
        expectedRevision: revision,
      }),
    ).rejects.toThrow('更改')
    expect((await s.service.diagnose({ expectedRevision: revision, cloudConsent: true })).ok).toBe(
      false,
    )
    expect(s.fetchImpl).not.toHaveBeenCalled()
  })
  it.each([
    'http://embedding.example/v1',
    'http://192.168.1.2/v1',
    'http://127.1/v1',
    'http://2130706433/v1',
    'https://user:password@host/v1',
    'https://host/v1?key=secret',
    'https://host/v1#secret',
    'file:///tmp/key',
  ])('rejects insecure or credential-bearing endpoint %s', (url) => {
    expect(() => canonicalEmbeddingBaseUrl(url)).toThrow()
  })
  it.each([
    'https://embedding.example/v1',
    'http://127.0.0.1:1234/v1',
    'http://localhost:1234/v1',
    'http://[::1]:1234/v1',
  ])('accepts explicit secure/local endpoint %s', (url) => {
    expect(canonicalEmbeddingBaseUrl(url)).toBe(url)
  })
  it('preserves a corrupt configuration rather than overwriting it', async () => {
    const s = await setup()
    await writeFile(join(s.directory, 'embedding-config.json'), '{broken')
    await expect(s.service.getConfig()).rejects.toThrow('保留')
    await expect(s.save()).rejects.toThrow()
    expect(await readFile(join(s.directory, 'embedding-config.json'), 'utf8')).toBe('{broken')
  })
})

describe('OpenAI-compatible mock transport and safe diagnostics', () => {
  it('sends only the documented fixed test text to the independent endpoint', async () => {
    const s = await setup()
    const config = await s.save()
    s.fetchImpl.mockResolvedValueOnce(response([[1, 2, 3]]))
    expect(
      await s.service.diagnose({ expectedRevision: config.revision, cloudConsent: true }),
    ).toMatchObject({ ok: true, dimensions: 3 })
    const [url, init] = s.fetchImpl.mock.calls[0]
    expect(url).toBe('https://embedding.vendor.example/v1/embeddings')
    expect(init?.redirect).toBe('error')
    expect(init?.headers).toHaveProperty('Authorization', `Bearer ${secret}`)
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'embed-model',
      encoding_format: 'float',
      input: [EMBEDDING_DIAGNOSTIC_TEXT],
    })
    expect(String(init?.body)).not.toContain(evidence[0].text)
    await expect(
      s.service.diagnose({ expectedRevision: config.revision, cloudConsent: false }),
    ).rejects.toThrow('确认')
  })
  it.each([
    'http-error',
    'network-error',
    'reflection',
    'invalid-vectors',
    'duplicate-index',
    'dimension-mismatch',
    'oversized',
  ] as const)('sanitizes %s without provider body/key/path disclosure', async (mode) => {
    const s = await setup()
    const config = await s.save()
    if (mode === 'http-error')
      s.fetchImpl.mockResolvedValueOnce(new Response(`Provider debug ${secret}`, { status: 401 }))
    if (mode === 'network-error')
      s.fetchImpl.mockRejectedValueOnce(new Error(`C:/private/${secret}`))
    if (mode === 'reflection')
      s.fetchImpl.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }], ignored: secret })),
      )
    if (mode === 'invalid-vectors') s.fetchImpl.mockResolvedValueOnce(response([[0, 0, 0]]))
    if (mode === 'duplicate-index')
      s.fetchImpl.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ index: 2, embedding: [1] }] })),
      )
    if (mode === 'dimension-mismatch')
      s.fetchImpl.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 'invalid'] }] })),
      )
    if (mode === 'oversized')
      s.fetchImpl.mockResolvedValueOnce(new Response('x'.repeat(1024 * 1024 + 1)))
    const result = await s.service.diagnose({
      expectedRevision: config.revision,
      cloudConsent: true,
    })
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(result)).not.toContain('Provider debug')
    expect(JSON.stringify(result)).not.toContain('C:/private')
  })
  it('bounds an uncooperative mock request and aborts active calls when settings change', async () => {
    const s = await setup({ timeoutMs: 15 })
    const config = await s.save()
    s.fetchImpl.mockImplementation(() => new Promise<Response>(() => {}))
    const pending = s.service.diagnose({ expectedRevision: config.revision, cloudConsent: true })
    expect(await pending).toMatchObject({ ok: false, error: expect.stringContaining('取消') })
    const next = s.service.diagnose({ expectedRevision: config.revision, cloudConsent: true })
    await vi.waitFor(() => expect(s.fetchImpl).toHaveBeenCalledTimes(2))
    await s.save({ model: 'replacement-model' })
    expect(await next).toMatchObject({ ok: false })
    expect(s.fetchImpl.mock.calls[1][1]?.signal?.aborted).toBe(true)
  })
})

describe('payload-bound confirmation and local retrieval', () => {
  it('prepares exact canonical strings without network, confirms once, and saves no source text', async () => {
    const s = await setup()
    await s.save()
    const preview = await s.prepare()
    expect(preview.texts.map((item) => item.text)).toEqual(evidence.map((item) => item.text))
    expect(s.fetchImpl).not.toHaveBeenCalled()
    await expect(
      s.service.confirm({ previewId: preview.previewId, cloudConsent: false }),
    ).rejects.toThrow('确认')
    s.fetchImpl.mockResolvedValueOnce(response())
    expect(await s.service.confirm({ previewId: preview.previewId, cloudConsent: true })).toEqual({
      mode: 'indexed',
      indexedCount: 2,
    })
    await expect(
      s.service.confirm({ previewId: preview.previewId, cloudConsent: true }),
    ).rejects.toThrow('更改')
    const files = await readdir(join(s.directory, 'knowledge-vectors'))
    const text = await readFile(join(s.directory, 'knowledge-vectors', files[0]), 'utf8')
    expect(text).not.toContain(evidence[0].text)
    expect(text).not.toContain(secret)
    expect(JSON.parse(text).entries).toHaveLength(2)
  })
  it('rejects wrong subject/pages, stale source/config, and expired previews before upload', async () => {
    let now = Date.now()
    const s = await setup({ now: () => now })
    await s.save()
    await expect(s.prepare('index', { subject: 'history' })).rejects.toThrow('授权')
    await expect(s.prepare('index', { startPage: 3 })).rejects.toThrow('授权')
    const first = await s.prepare()
    s.changeSource(evidence.map((item) => ({ ...item, text: 'Changed extracted text' })))
    await expect(
      s.service.confirm({ previewId: first.previewId, cloudConsent: true }),
    ).rejects.toThrow('更改')
    const second = await s.prepare()
    await s.save({ model: 'new-model' })
    await expect(
      s.service.confirm({ previewId: second.previewId, cloudConsent: true }),
    ).rejects.toThrow('更改')
    const third = await s.prepare()
    now += 5 * 60000 + 1
    await expect(
      s.service.confirm({ previewId: third.previewId, cloudConsent: true }),
    ).rejects.toThrow('更改')
    expect(s.fetchImpl).not.toHaveBeenCalled()
  })
  it('has a usable keyword fallback with no API, and never uploads an ordinary query', async () => {
    const s = await setup()
    expect(await s.service.searchLocal({ ...scope, query: '离心率' })).toMatchObject({
      mode: 'keyword',
      hits: [{ text: evidence[0].text }],
    })
    await s.save()
    expect((await s.service.searchLocal({ ...scope, query: '离心率' })).mode).toBe('keyword')
    expect(s.fetchImpl).not.toHaveBeenCalled()
  })
  it('uses approved query vectors locally, persists document index across restart, isolates scope and fingerprint', async () => {
    const s = await setup()
    await s.save()
    s.fetchImpl.mockResolvedValueOnce(response()).mockResolvedValueOnce(response([[1, 0, 0]]))
    const indexed = await s.prepare()
    await s.service.confirm({ previewId: indexed.previewId, cloudConsent: true })
    const query = await s.prepare('search')
    expect(query.texts).toHaveLength(1)
    expect(query.texts[0].text).toBe('离心率')
    const result = await s.service.confirm({ previewId: query.previewId, cloudConsent: true })
    expect(result).toMatchObject({ mode: 'vector', hits: [{ chunkId: evidence[0].chunkId }] })
    expect((await s.service.searchLocal({ ...scope, query: '离心率' })).mode).toBe('vector')
    expect((await s.service.searchLocal({ ...scope, query: 'another query' })).mode).toBe('keyword')
    expect((await s.service.searchLocal({ ...scope, startPage: 2, query: '离心率' })).mode).toBe(
      'keyword',
    )
    expect(s.fetchImpl).toHaveBeenCalledTimes(2)
    const restarted = s.restart()
    expect((await restarted.searchLocal({ ...scope, query: '离心率' })).mode).toBe('keyword')
    const index = new KnowledgeVectorIndex(s.directory)
    expect(
      (
        await index.search(
          scope,
          embeddingFingerprint('https://embedding.vendor.example/v1', 'embed-model'),
          [1, 0, 0],
          s.library.resolveChunks,
        )
      ).valid,
    ).toBe(true)
    expect(
      (
        await index.search(
          scope,
          embeddingFingerprint('https://embedding.vendor.example/v1', 'other-model'),
          [1, 0, 0],
          s.library.resolveChunks,
        )
      ).valid,
    ).toBe(false)
  })
  it('can search semantically without lexical matches or selected chunks, while uploading only the confirmed query', async () => {
    const s = await setup()
    await s.save()
    s.fetchImpl.mockResolvedValueOnce(response()).mockResolvedValueOnce(response([[1, 0, 0]]))
    const indexed = await s.prepare()
    await s.service.confirm({ previewId: indexed.previewId, cloudConsent: true })
    s.library.search.mockResolvedValue([])
    const preview = await s.prepare('search', { chunkIds: [], query: '未在教材中出现的同义表述' })
    expect(preview.texts).toEqual([
      { text: '未在教材中出现的同义表述', sha256: expect.any(String) },
    ])
    const result = await s.service.confirm({ previewId: preview.previewId, cloudConsent: true })
    expect(result).toMatchObject({ mode: 'vector', hits: [{ chunkId: evidence[0].chunkId }] })
    expect(JSON.parse(String(s.fetchImpl.mock.calls[1][1]?.body)).input).toEqual([
      '未在教材中出现的同义表述',
    ])
    expect(s.library.search).toHaveBeenCalledWith({
      ...scope,
      query: '未在教材中出现的同义表述',
      limit: 1,
    })
  })
  it('stops a pending local revalidation before dispatch when canceled', async () => {
    const s = await setup()
    await s.save()
    const preview = await s.prepare()
    let release!: (items: KnowledgeEvidence[]) => void
    s.library.resolveChunks.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const pending = s.service.confirm({ previewId: preview.previewId, cloudConsent: true }).then(
      () => 'published',
      (error: unknown) => error,
    )
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    s.service.cancelAll()
    release(evidence)
    expect(await pending).toBeInstanceOf(Error)
    expect(s.fetchImpl).not.toHaveBeenCalled()
  })
  it('falls back on provider failure, stale vectors, dimensional mismatch and corrupt indexes', async () => {
    const s = await setup()
    await s.save()
    s.fetchImpl.mockResolvedValueOnce(response())
    let preview = await s.prepare()
    await s.service.confirm({ previewId: preview.previewId, cloudConsent: true })
    s.fetchImpl.mockRejectedValueOnce(new Error(secret))
    preview = await s.prepare('search')
    expect(
      (await s.service.confirm({ previewId: preview.previewId, cloudConsent: true })).mode,
    ).toBe('keyword')
    const index = new KnowledgeVectorIndex(s.directory)
    const fingerprint = embeddingFingerprint('https://embedding.vendor.example/v1', 'embed-model')
    expect((await index.search(scope, fingerprint, [1, 0], s.library.resolveChunks)).valid).toBe(
      false,
    )
    await index.put(scope, fingerprint, evidence, [
      [1, 0, 0],
      [0, 1, 0],
    ])
    s.changeSource(evidence.map((item) => ({ ...item, text: 'New source text' })))
    expect((await index.search(scope, fingerprint, [1, 0, 0], s.library.resolveChunks)).valid).toBe(
      false,
    )
    const file = join(s.directory, 'knowledge-vectors', `math-${documentId}-${fingerprint}.json`)
    await writeFile(file, '{corrupt')
    expect((await index.search(scope, fingerprint, [1, 0, 0], s.library.resolveChunks)).valid).toBe(
      false,
    )
    // A corrupt derived cache is invalidated and rebuildable; canonical knowledge is untouched.
    await index.put(scope, fingerprint, evidence, [
      [1, 0, 0],
      [0, 1, 0],
    ])
    expect(JSON.parse(await readFile(file, 'utf8')).entries).toHaveLength(2)
  })
  it('does not publish indexes after the canonical source changes during the response', async () => {
    const s = await setup()
    await s.save()
    const preview = await s.prepare()
    s.fetchImpl.mockImplementationOnce(async () => {
      s.changeSource(evidence.map((item) => ({ ...item, text: 'Modified during provider call' })))
      return response()
    })
    await expect(
      s.service.confirm({ previewId: preview.previewId, cloudConsent: true }),
    ).rejects.toThrow('更改')
    await expect(readdir(join(s.directory, 'knowledge-vectors'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
  it.each(['clear', 'cancel'] as const)(
    'does not repopulate cache after %s during an in-flight request',
    async (action) => {
      const s = await setup()
      await s.save()
      const preview = await s.prepare()
      let release!: (response: Response) => void
      s.fetchImpl.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve
          }),
      )
      const pending = s.service.confirm({ previewId: preview.previewId, cloudConsent: true }).then(
        () => 'published',
        (error: unknown) => error,
      )
      await vi.waitFor(() => expect(s.fetchImpl).toHaveBeenCalledOnce())
      if (action === 'clear') await s.service.clearIndex(scope)
      else s.service.cancelAll()
      release(response())
      expect(await pending).toBeInstanceOf(Error)
      expect((await s.service.searchLocal({ ...scope, query: '离心率' })).mode).toBe('keyword')
      const files = await readdir(join(s.directory, 'knowledge-vectors')).catch(() => [])
      expect(files).toHaveLength(0)
    },
  )
  it('clears only authorized pages and falls back when cosine scores are nonpositive', async () => {
    const s = await setup()
    const index = new KnowledgeVectorIndex(s.directory)
    const fingerprint = embeddingFingerprint('https://embedding.vendor.example/v1', 'embed-model')
    await index.put(scope, fingerprint, evidence, [
      [1, 0, 0],
      [0, 1, 0],
    ])
    expect(
      (await index.search(scope, fingerprint, [-1, -1, 0], s.library.resolveChunks)).valid,
    ).toBe(false)
    await index.clear({ ...scope, startPage: 1, endPage: 1 })
    const result = await index.search(scope, fingerprint, [0, 1, 0], s.library.resolveChunks)
    expect(result.hits.map((item) => item.pageNumber)).toEqual([2])
  })
  it('rejects traversal before invalidation and rebuilds a valid-schema cache with mismatched identity', async () => {
    const s = await setup()
    const index = new KnowledgeVectorIndex(s.directory)
    const fingerprint = embeddingFingerprint('https://embedding.vendor.example/v1', 'embed-model')
    expect(() => index.search(scope, '../../outside', [1], s.library.resolveChunks)).toThrow()
    expect(() =>
      index.search(
        { ...scope, documentId: '../../outside' },
        fingerprint,
        [1],
        s.library.resolveChunks,
      ),
    ).toThrow()
    await index.put(scope, fingerprint, evidence, [
      [1, 0, 0],
      [0, 1, 0],
    ])
    const file = join(s.directory, 'knowledge-vectors', `math-${documentId}-${fingerprint}.json`)
    const wrong = JSON.parse(await readFile(file, 'utf8'))
    wrong.fingerprint = 'b'.repeat(64)
    await writeFile(file, JSON.stringify(wrong))
    await index.put(scope, fingerprint, evidence, [
      [1, 0, 0],
      [0, 1, 0],
    ])
    expect((await index.search(scope, fingerprint, [1, 0, 0], s.library.resolveChunks)).valid).toBe(
      true,
    )
  })
})
