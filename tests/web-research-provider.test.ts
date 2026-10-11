import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { lookup } from 'node:dns'
import type { request, RequestOptions } from 'node:https'
import { describe, expect, it, vi } from 'vitest'
import {
  buildWebResearchQuery,
  canonicalPublicResearchUrl,
  webResearchScopeSchema,
  webResearchResultSchema,
  webResearchSourceSchema,
  WEB_RESEARCH_LIMITS,
  type WebResearchScope,
} from '../src/shared/web-research'
import {
  createPublicResearchFetch,
  isPublicResearchAddress,
  TavilyWebResearchProvider,
  WebResearchError,
} from '../src/adapters/web-research-provider'

// Synthetic-only tests: all provider and connection I/O are injected; no live credentials/calls.
const key = 'tvly-synthetic-only-never-real'
const scope: WebResearchScope = {
  subject: 'history',
  topic: '工业革命',
  region: '全国',
  years: [2024, 2025],
  approvedUrls: [],
}
const source = {
  title: '2024 history topic',
  url: 'https://public.publisher.com/exams/2024',
  content: 'The source mentions 2024. Its exam identity is unverified.',
}
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
function fixture(
  options: {
    response?: Response
    timeoutMs?: number
    scope?: WebResearchScope
    fetchImpl?: typeof fetch
  } = {},
) {
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockImplementation(
      options.fetchImpl ??
        (async () => options.response ?? json({ results: [source], usage: { credits: 1 } })),
    )
  const provider = new TavilyWebResearchProvider({
    apiKey: key,
    fetchImpl,
    timeoutMs: options.timeoutMs,
  })
  return { fetchImpl, provider, session: provider.createSession(options.scope ?? scope) }
}

describe('public research scope and SSRF syntax gate', () => {
  it('uses only public scope labels in exact stable query templates', () => {
    expect(buildWebResearchQuery(scope)).toBe('历史 工业革命 全国 2024 2025 历年试题 考点 公开资料')
    expect(buildWebResearchQuery(scope, 2025)).toBe(
      '历史 工业革命 全国 2025 历年试题 考点 公开资料',
    )
    expect(() => buildWebResearchQuery(scope, 2023)).toThrow()
    expect(webResearchScopeSchema.safeParse({ ...scope, answer: 'private answer' }).success).toBe(
      false,
    )
    expect(
      webResearchScopeSchema.safeParse({ ...scope, topic: 'https://private.example/answer' })
        .success,
    ).toBe(false)
    expect(
      webResearchScopeSchema.safeParse({ ...scope, approvedUrls: ['https://localhost/private'] })
        .success,
    ).toBe(false)
    expect(
      webResearchScopeSchema.safeParse({ ...scope, approvedUrls: Array(4).fill(source.url) })
        .success,
    ).toBe(false)
  })
  it.each([
    'http://public.publisher.com',
    'https://u:p@public.publisher.com',
    'https://127.0.0.1',
    'https://2130706433',
    'https://0x7f000001',
    'https://[::1]',
    'https://localhost',
    'https://host.internal',
    'https://host.local',
    'https://foo.onion',
    'https://public.publisher.com:8443',
    'https://public.publisher.com/#fragment',
    'https://public.publisher.com/?token=secret',
    'https://public.publisher.com/?%61pi_key=secret',
    'https://public.publisher.com/?redirect=https://localhost',
    'https://public.publisher.com/secret:abc',
    'https://public.publisher.com/%00',
    'https://public.publisher.com./',
    'https://public.publisher.com\\@localhost/',
  ])('rejects unsafe URL %s', (url) => {
    expect(() => canonicalPublicResearchUrl(url)).toThrow()
  })
  it('canonicalizes public URLs, allowing ordinary resource query parameters', () => {
    expect(
      canonicalPublicResearchUrl('https://Public.Publisher.com:443/资料?year=2024&page=2'),
    ).toBe('https://public.publisher.com/%E8%B5%84%E6%96%99?year=2024&page=2')
  })
  it.each([
    '127.0.0.1',
    '0.0.0.0',
    '10.1.2.3',
    '169.254.169.254',
    '100.64.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '192.0.2.1',
    '198.51.100.1',
    '203.0.113.1',
    '198.18.0.1',
    '192.88.99.1',
    '224.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    '2001:db8::1',
    '2001:0:1234::1',
    '2002:7f00:1::',
    '3fff::1',
  ])('rejects nonpublic IP %s', (address) => expect(isPublicResearchAddress(address)).toBe(false))
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888'])(
    'accepts global unicast %s',
    (address) => expect(isPublicResearchAddress(address)).toBe(true),
  )
  it('validates every DNS answer in the connection lookup and pins the checked answers', async () => {
    let connection: RequestOptions | undefined
    const responses = [{ address: '8.8.8.8', family: 4 }]
    const lookupImpl = vi.fn((host: string, options: unknown, callback: Function) =>
      callback(null, responses),
    ) as unknown as typeof lookup
    const requestImpl = vi.fn((url: string, options: RequestOptions, callback: Function) => {
      connection = options
      const req = new EventEmitter() as EventEmitter & { end(): void }
      req.end = () => {
        const check = options.lookup as Function
        check(new URL(url).hostname, { all: true }, (error: Error | null, addresses: unknown) => {
          if (error) {
            req.emit('error', error)
            return
          }
          expect(addresses).toEqual(responses)
          const body = Readable.from([Buffer.from('public text')]) as Readable & {
            headers: Record<string, string>
            statusCode: number
          }
          body.headers = { 'content-type': 'text/plain' }
          body.statusCode = 200
          callback(body)
        })
      }
      return req
    }) as unknown as typeof request
    const transport = createPublicResearchFetch({ lookupImpl, requestImpl })
    const response = await transport(source.url, { method: 'GET' })
    expect(await response.text()).toBe('public text')
    expect(connection?.agent).toBe(false)
    expect(lookupImpl).toHaveBeenCalledTimes(1)
    responses.push({ address: '127.0.0.1', family: 4 })
    await expect(transport(source.url)).rejects.toThrow('Public endpoint unavailable')
    expect(lookupImpl).toHaveBeenCalledTimes(2)
  })
})

describe('bounded Tavily search sessions', () => {
  it('sends the fixed basic wire request, returns short untrusted evidence and clones scope/results', async () => {
    const mutable = structuredClone(scope)
    const { fetchImpl, session } = fixture({ scope: mutable })
    mutable.topic = 'Changed'
    const result = await session.search({})
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://api.tavily.com/search')
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: { Authorization: `Bearer ${key}`, 'Accept-Encoding': 'identity' },
    })
    expect(JSON.parse(init!.body as string)).toEqual({
      query: buildWebResearchQuery(scope),
      search_depth: 'basic',
      auto_parameters: false,
      topic: 'general',
      chunks_per_source: 1,
      max_results: 5,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      include_favicon: false,
      include_usage: true,
    })
    expect(webResearchResultSchema.safeParse(result).success).toBe(true)
    expect(result.sources[0]).toMatchObject({
      retrieved: true,
      provenance: 'tavily-search',
      untrusted: true,
      verification: 'unverified',
      yearEvidence: [{ year: 2024, evidence: expect.any(String) }],
    })
    expect(result.budget).toMatchObject({
      searchesUsed: 1,
      estimatedSearchCredits: 1,
      reportedCredits: 1,
    })
    result.sources[0].url = 'https://evil.publisher.com'
    expect(session.getSources()[0].url).toBe(source.url)
  })
  it('rejects model queries, out-of-scope years and another session source ID before I/O', async () => {
    const { session, provider, fetchImpl } = fixture()
    await expect(session.search({ query: 'private answer' } as never)).rejects.toMatchObject({
      code: 'scope',
    })
    await expect(session.search({ year: 2023 })).rejects.toMatchObject({ code: 'scope' })
    const second = provider.createSession({ ...scope, approvedUrls: [source.url] })
    await expect(
      session.fetch({ sourceId: second.getSources()[0].sourceId }),
    ).rejects.toMatchObject({ code: 'url' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it('coalesces repeated calls, counts failed requests, and refuses extra distinct searches', async () => {
    const { session, fetchImpl } = fixture({ fetchImpl: async () => json({ results: [source] }) })
    const [one, two] = await Promise.all([session.search({}), session.search({})])
    expect(one.sources).toEqual(two.sources)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await session.search({ year: 2024 })
    await expect(session.search({ year: 2025 })).rejects.toMatchObject({ code: 'budget' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
  it('bounds provider results/excerpts, drops unsafe URLs, ignores model answers/raw content', async () => {
    const { session } = fixture({
      response: json({
        results: [
          { ...source, content: 'x'.repeat(10000) },
          { ...source, url: 'https://127.0.0.1/' },
          { ...source, url: 'https://public.publisher.com/?token=private' },
        ],
        answer: 'Claim of official answers',
        raw_content: 'Entire exam',
      }),
    })
    const result = await session.search({})
    expect(result.sources).toHaveLength(1)
    expect(result.sources[0].excerpt).toHaveLength(1200)
    expect(JSON.stringify(result)).not.toContain('Entire exam')
    expect(JSON.stringify(result)).not.toContain('official answers')
  })
  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [429, 'quota'],
    [432, 'quota'],
    [433, 'quota'],
    [500, 'http'],
    [302, 'redirect'],
  ] as const)('sanitizes status %s and never retries/reads error text', async (status, code) => {
    const { session, fetchImpl } = fixture({
      response: new Response(`internal error ${key}`, { status }),
    })
    await expect(session.search({})).rejects.toMatchObject({ code })
    await expect(session.search({})).rejects.toMatchObject({ code })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(session.getBudget().searchesUsed).toBe(1)
    expect(session.getSources()).toEqual([])
  })
  it('sanitizes transport errors, malformed JSON and credential reflection including escaped JSON', async () => {
    const failed = fixture({
      fetchImpl: async () => {
        throw new Error(key)
      },
    })
    await expect(failed.session.search({})).rejects.toEqual(new WebResearchError('network'))
    for (const body of [
      JSON.stringify({ results: [{ ...source, content: key }] }),
      JSON.stringify({ results: [], key: Buffer.from(key).toString('base64') }),
      JSON.stringify({ results: [{ ...source, content: key }] }).replaceAll('t', '\\u0074'),
    ]) {
      const reflected = fixture({
        response: new Response(body, { headers: { 'content-type': 'application/json' } }),
      })
      await expect(reflected.session.search({})).rejects.toMatchObject({ code: 'reflection' })
      expect(reflected.session.getSources()).toEqual([])
    }
    await expect(
      fixture({
        response: new Response('{bad', { headers: { 'content-type': 'application/json' } }),
      }).session.search({}),
    ).rejects.toMatchObject({ code: 'response' })
  })
  it('blocks percent/nested/entity encoded credentials before source admission and outbound URLs', async () => {
    const encoded = [...key].map((letter) => '%' + letter.charCodeAt(0).toString(16)).join('')
    const nested = encoded.replaceAll('%', '%25')
    const entity = [...key].map((letter) => `&#${letter.charCodeAt(0)};`).join('')
    for (const url of [
      `https://public.publisher.com/${encoded}`,
      `https://public.publisher.com/?q=${encoded}`,
      `https://${encoded}.publisher.com/`,
      `https://public.publisher.com/${nested}`,
      `https://public.publisher.com/${entity}`,
    ]) {
      const blocked = fixture({ response: json({ results: [{ ...source, url }] }) })
      await expect(blocked.session.search({})).rejects.toMatchObject({ code: 'reflection' })
      expect(blocked.session.getSources()).toEqual([])
      expect(blocked.fetchImpl).toHaveBeenCalledTimes(1)
      expect(() => blocked.provider.createSession({ ...scope, approvedUrls: [url] })).toThrow(
        WebResearchError,
      )
    }
  })
  it('reprojects cached sources and budget after later search/fetch updates', async () => {
    const { session, fetchImpl } = fixture({
      fetchImpl: async (_url, init) =>
        init?.method === 'POST'
          ? json({ results: [source], usage: { credits: 1 } })
          : new Response('Fetched 2025 evidence', { headers: { 'content-type': 'text/plain' } }),
    })
    const searched = await session.search({})
    const fetched = await session.fetch({ sourceId: searched.sources[0].sourceId })
    await session.search({ year: 2025 })
    const cached = await session.search({})
    expect(cached.sources).toEqual(session.getSources())
    expect(cached.sources[0].provenance).toBe('direct-fetch')
    expect(cached.budget).toEqual(session.getBudget())
    expect(cached.budget).toMatchObject({ searchesUsed: 2, fetchesUsed: 1, reportedCredits: 2 })
    expect((await session.fetch({ sourceId: fetched.sources[0].sourceId })).sources).toEqual(
      session.getSources(),
    )
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })
  it('deduplicates equivalent results and cancels a repeated observer without a second request', async () => {
    const duplicate = fixture({ response: json({ results: [source, source] }) })
    expect((await duplicate.session.search({})).sources).toHaveLength(1)
    let finish: (value: Response) => void = () => {}
    const pending = fixture({
      fetchImpl: async () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
    })
    const first = pending.session.search({})
    const controller = new AbortController()
    const second = pending.session.search({}, controller.signal)
    controller.abort()
    await expect(second).rejects.toMatchObject({ code: 'cancelled' })
    finish(json({ results: [source] }))
    expect((await first).sources).toHaveLength(1)
    expect(pending.fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('aborts before transport without spending; timeouts and cancellation prevent late source mutation', async () => {
    const early = fixture()
    const controller = new AbortController()
    controller.abort()
    await expect(early.session.search({}, controller.signal)).rejects.toMatchObject({
      code: 'cancelled',
    })
    expect(early.fetchImpl).not.toHaveBeenCalled()
    expect(early.session.getBudget().searchesUsed).toBe(0)
    let finish: (value: Response) => void = () => {}
    const delayed = fixture({
      timeoutMs: 10,
      fetchImpl: async () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
    })
    await expect(delayed.session.search({})).rejects.toMatchObject({ code: 'timeout' })
    finish(json({ results: [source] }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(delayed.session.getSources()).toEqual([])
    await expect(delayed.session.search({})).rejects.toMatchObject({ code: 'timeout' })
    expect(delayed.fetchImpl).toHaveBeenCalledTimes(1)
    const cancelled = fixture({ fetchImpl: async () => new Promise<Response>(() => {}) })
    const active = new AbortController()
    const pending = cancelled.session.search({}, active.signal)
    active.abort()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
  })
  it('cancels a stalled body stream and rejects advertised/streamed oversize payloads', async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream({ cancel })
    const stalled = fixture({
      response: new Response(stream, { headers: { 'content-type': 'application/json' } }),
      timeoutMs: 10,
    })
    await expect(stalled.session.search({})).rejects.toMatchObject({ code: 'timeout' })
    expect(cancel).toHaveBeenCalledTimes(1)
    for (const headers of [
      { 'content-type': 'application/json', 'content-length': '99999999' },
      { 'content-type': 'application/json' },
    ]) {
      const big = fixture({
        response: new Response('x'.repeat(WEB_RESEARCH_LIMITS.responseBytes + 1), {
          headers: headers as Record<string, string>,
        }),
      })
      await expect(big.session.search({})).rejects.toMatchObject({ code: 'size' })
    }
  })
})

describe('direct public text fetch', () => {
  it('uses only this-session source IDs, sends no Tavily key, strips non-text and caches repeats', async () => {
    const { session, fetchImpl } = fixture({
      scope: { ...scope, approvedUrls: [source.url] },
      response: new Response(
        '<title>2025 Topic</title><script>secret script</script><form>secret form</form><p>Public &amp; useful 2025</p>',
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
      ),
    })
    const placeholder = session.getSources()[0]
    expect(placeholder).toMatchObject({
      retrieved: false,
      retrievedAt: null,
      excerpt: '',
      provenance: 'user-approved-url',
    })
    expect(webResearchSourceSchema.safeParse({ ...placeholder, retrieved: true }).success).toBe(
      false,
    )
    const result = await session.fetch({ sourceId: placeholder.sourceId })
    expect(result.sources[0]).toMatchObject({
      sourceId: placeholder.sourceId,
      retrieved: true,
      provenance: 'direct-fetch',
      title: '2025 Topic',
      excerpt: '2025 Topic Public & useful 2025',
    })
    expect(result.sources[0].yearEvidence.map((item) => item.year)).toEqual([2024, 2025])
    expect(fetchImpl.mock.calls[0][0]).toBe(source.url)
    expect(fetchImpl.mock.calls[0][1]?.headers).toEqual({
      Accept: 'text/html, text/plain',
      'Accept-Encoding': 'identity',
    })
    expect(fetchImpl.mock.calls[0][1]?.body).toBeUndefined()
    await session.fetch({ sourceId: placeholder.sourceId })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(session.getBudget()).toMatchObject({
      fetchesUsed: 1,
      searchesUsed: 0,
      estimatedSearchCredits: 0,
    })
  })
  it.each([
    'application/pdf',
    'application/octet-stream',
    'application/xhtml+xml',
    'text/html; charset=gbk',
  ])('rejects unsafe or unsupported content %s', async (type) => {
    const { session } = fixture({
      scope: { ...scope, approvedUrls: [source.url] },
      response: new Response('unsafe body', { headers: { 'content-type': type } }),
    })
    await expect(
      session.fetch({ sourceId: session.getSources()[0].sourceId }),
    ).rejects.toMatchObject({ code: 'content' })
    expect(session.getSources()[0].retrieved).toBe(false)
  })
  it('rejects a substituted transport that already followed a redirect', async () => {
    const response = new Response('Wrong destination', {
      headers: { 'content-type': 'text/plain' },
    })
    Object.defineProperty(response, 'redirected', { value: true })
    const { session } = fixture({ scope: { ...scope, approvedUrls: [source.url] }, response })
    await expect(
      session.fetch({ sourceId: session.getSources()[0].sourceId }),
    ).rejects.toMatchObject({ code: 'redirect' })
    expect(session.getSources()[0].retrieved).toBe(false)
  })
  it('blocks HTML-entity credential reflection and follows no redirect', async () => {
    const escaped = [...key].map((letter) => `&#${letter.charCodeAt(0)};`).join('')
    const reflected = fixture({
      scope: { ...scope, approvedUrls: [source.url] },
      response: new Response(`<p>${escaped}</p>`, { headers: { 'content-type': 'text/html' } }),
    })
    await expect(
      reflected.session.fetch({ sourceId: reflected.session.getSources()[0].sourceId }),
    ).rejects.toMatchObject({ code: 'reflection' })
    const redirect = fixture({
      scope: { ...scope, approvedUrls: [source.url] },
      response: new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/' },
      }),
    })
    await expect(
      redirect.session.fetch({ sourceId: redirect.session.getSources()[0].sourceId }),
    ).rejects.toMatchObject({ code: 'redirect' })
    expect(redirect.fetchImpl).toHaveBeenCalledTimes(1)
  })
  it('shares the two-fetch budget across all callers and rejects raw URLs', async () => {
    const { session, fetchImpl } = fixture({
      scope: { ...scope, approvedUrls: [source.url, `${source.url}/b`, `${source.url}/c`] },
      fetchImpl: async () =>
        new Response('Public page', { headers: { 'content-type': 'text/plain' } }),
    })
    await expect(session.fetch({ sourceId: source.url })).rejects.toMatchObject({ code: 'url' })
    const sources = session.getSources()
    await session.fetch({ sourceId: sources[0].sourceId })
    await session.fetch({ sourceId: sources[1].sourceId })
    await expect(session.fetch({ sourceId: sources[2].sourceId })).rejects.toMatchObject({
      code: 'budget',
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
