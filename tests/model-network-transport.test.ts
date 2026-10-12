import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { lookup } from 'node:dns/promises'
import { lookup as directLookup } from 'node:dns'
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect as tcpConnect, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { once } from 'node:events'
import { createModelFetch, isClashFakeAddress } from '../src/adapters/model-network-transport'
import { listRemoteModels } from '../src/adapters/model-diagnostics'
import fixture from './fixtures/model-network-tls.json'

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }))
vi.mock('node:dns', () => ({ lookup: vi.fn() }))
vi.mock('node:tls', async (original) => {
  const actual = await original<typeof import('node:tls')>()
  return { ...actual, connect: vi.fn(actual.connect) }
})
const actualTls = await vi.importActual<typeof import('node:tls')>('node:tls')
const target = 'https://api.vendor.com/v1/models'
const syntheticKey = 'synthetic-proxy-regression-secret-never-real'
const cleanup: (() => Promise<void>)[] = []

beforeEach(() => {
  vi.mocked(lookup).mockResolvedValue([{ address: '198.18.0.7', family: 4 }] as never)
  vi.mocked(directLookup).mockImplementation(((
    _host: string,
    _options: unknown,
    callback: Function,
  ) => callback(null, [{ address: '198.18.0.7', family: 4 }])) as never)
  // Trust only this synthetic fixture inside tests, while retaining normal certificate and
  // hostname verification. Production code has no custom CA/verification bypass option.
  vi.mocked(tlsConnect).mockImplementation(((options: import('node:tls').ConnectionOptions) =>
    actualTls.connect({ ...options, ca: fixture.cert })) as typeof tlsConnect)
})
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.clearAllMocks()
})

async function localServers(
  handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => res.end('ok'),
  connectStatus = 200,
  stall?: 'connect' | 'tls',
) {
  const sockets = new Set<Socket>()
  const origin = createHttpsServer({ key: fixture.key, cert: fixture.cert }, handler)
  origin.on('tlsClientError', () => {})
  const proxy = createHttpServer()
  for (const server of [origin, proxy])
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
  const requests: { method?: string; url?: string; headers: IncomingMessage['headers'] }[] = []
  const tunnelBytes: Buffer[] = []
  let connected!: () => void
  let closed!: () => void
  const proxyConnected = new Promise<void>((resolve) => {
    connected = resolve
  })
  const proxyClosed = new Promise<void>((resolve) => {
    closed = resolve
  })
  origin.listen(0, '127.0.0.1')
  await once(origin, 'listening')
  const originPort = (origin.address() as { port: number }).port
  proxy.on('connect', (request, socket, head) => {
    requests.push({ method: request.method, url: request.url, headers: request.headers })
    socket.on('data', (chunk: Buffer) => tunnelBytes.push(chunk))
    socket.on('error', () => socket.destroy())
    socket.once('end', () => {
      closed()
      socket.destroy()
    })
    socket.once('close', closed)
    connected()
    if (stall === 'connect') return
    if (stall === 'tls') {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      return
    }
    if (connectStatus !== 200) {
      socket.end(`HTTP/1.1 ${connectStatus} Unavailable\r\nContent-Length: 0\r\n\r\n`)
      return
    }
    const upstream = tcpConnect({ host: '127.0.0.1', port: originPort }, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    sockets.add(upstream)
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
    socket.once('close', () => upstream.destroy())
    upstream.once('close', () => {
      sockets.delete(upstream)
      socket.destroy()
    })
  })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy()
    await Promise.all(
      [origin, proxy].map(
        (server) => new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    )
  })
  return { proxyUrl, requests, tunnelBytes, proxyConnected, proxyClosed }
}

describe('explicit model network routes', () => {
  it('reproduces the old failure: direct requests reject Clash Fake-IP before sending', async () => {
    await expect(createModelFetch()(target, { method: 'GET' })).rejects.toMatchObject({
      code: 'ENDPOINT_NOT_PUBLIC',
    })
    expect(tlsConnect).not.toHaveBeenCalled()
  })

  it('does not silently fall back to direct when a selected proxy is unreachable', async () => {
    const fetchImpl = createModelFetch({ mode: 'local', proxyUrl: 'http://127.0.0.1:1' })
    await expect(
      fetchImpl('https://api.vendor.com/v1/models', { method: 'GET' }),
    ).rejects.toMatchObject({
      code: 'ECONNREFUSED',
    })
    expect(directLookup).not.toHaveBeenCalled()
  })

  it('uses a real CONNECT tunnel, destination TLS/SNI and chunked streaming with Fake-IP DNS', async () => {
    let receivedBody = ''
    let receivedAuthorization: string | undefined
    const wire = await localServers((request, response) => {
      receivedAuthorization = request.headers.authorization
      request.on('data', (chunk) => {
        receivedBody += chunk
      })
      request.on('end', () => {
        response.write('first ')
        setImmediate(() => response.end('second'))
      })
    })
    const response = await createModelFetch({ mode: 'local', proxyUrl: wire.proxyUrl })(target, {
      method: 'POST',
      headers: { Authorization: `Bearer ${syntheticKey}` },
      body: '{"synthetic":true}',
    })
    expect(await response.text()).toBe('first second')
    expect(receivedBody).toBe('{"synthetic":true}')
    expect(receivedAuthorization).toBe(`Bearer ${syntheticKey}`)
    expect(wire.requests).toHaveLength(1)
    expect(wire.requests[0]).toMatchObject({
      method: 'CONNECT',
      url: 'api.vendor.com:443',
      headers: { host: 'api.vendor.com:443' },
    })
    expect(JSON.stringify(wire.requests)).not.toContain(syntheticKey)
    expect(Buffer.concat(wire.tunnelBytes).toString()).not.toContain(syntheticKey)
    expect(tlsConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        servername: 'api.vendor.com',
        rejectUnauthorized: true,
        checkServerIdentity: expect.any(Function),
      }),
    )
    expect(directLookup).not.toHaveBeenCalled()
  })

  it('uses the selected system route without trying its DIRECT fallback', async () => {
    const wire = await localServers()
    const resolver = vi.fn().mockResolvedValue(`PROXY ${new URL(wire.proxyUrl).host}; DIRECT`)
    const response = await createModelFetch({ mode: 'system' }, resolver)(target, { method: 'GET' })
    expect(await response.text()).toBe('ok')
    expect(resolver).toHaveBeenCalledWith(target)
    expect(wire.requests).toHaveLength(1)
    expect(directLookup).not.toHaveBeenCalled()
  })

  it('keeps ordinary public destination DNS working through the selected proxy', async () => {
    const wire = await localServers()
    vi.mocked(lookup).mockResolvedValue([{ address: '93.184.215.14', family: 4 }] as never)
    const response = await createModelFetch({ mode: 'local', proxyUrl: wire.proxyUrl })(target, {
      method: 'GET',
    })
    expect(await response.text()).toBe('ok')
  })

  it('keeps the direct DNS guard when the system explicitly resolves DIRECT', async () => {
    await expect(
      createModelFetch({ mode: 'system' }, async () => 'DIRECT')(target),
    ).rejects.toMatchObject({ code: 'ENDPOINT_NOT_PUBLIC' })
  })

  it.each([
    'SOCKS5 127.0.0.1:7890',
    'PROXY 192.168.1.1:7890',
    'PROXY localhost:7890',
    'PROXY proxy.vendor.com:7890',
    'DIRECT; PROXY 127.0.0.1:7890',
    'PROXY 127.0.0.1:7890; PROXY 127.0.0.1:7891',
    'PROXY user:password@127.0.0.1:7890',
  ])('fails closed on unsupported system route %s', async (route) => {
    await expect(
      createModelFetch({ mode: 'system' }, async () => route)(target),
    ).rejects.toMatchObject({ code: 'PROXY_UNSUPPORTED' })
    expect(lookup).not.toHaveBeenCalled()
    expect(directLookup).not.toHaveBeenCalled()
  })

  it('requires a usable system proxy resolver', async () => {
    await expect(createModelFetch({ mode: 'system' })(target)).rejects.toMatchObject({
      code: 'PROXY_UNAVAILABLE',
    })
    await expect(
      createModelFetch({ mode: 'system' }, async () => {
        throw new Error(syntheticKey)
      })(target),
    ).rejects.toMatchObject({ code: 'PROXY_UNAVAILABLE' })
  })

  it.each([
    'http://127.1:7890',
    'http://localhost:7890',
    'http://2130706433:7890',
    'http://192.168.1.1:7890',
    'http://127.0.0.1:7890/path',
    'http://user:password@127.0.0.1:7890',
  ])('rejects unsafe explicit proxy URLs: %s', (proxyUrl) => {
    expect(() => createModelFetch({ mode: 'local', proxyUrl })).toThrow(
      expect.objectContaining({ code: 'PROXY_CONFIG_INVALID' }),
    )
  })

  it('limits the Fake-IP exception to exactly 198.18.0.0/15', () => {
    expect(isClashFakeAddress('198.18.0.0')).toBe(true)
    expect(isClashFakeAddress('198.19.255.255')).toBe(true)
    expect(isClashFakeAddress('198.17.255.255')).toBe(false)
    expect(isClashFakeAddress('198.20.0.1')).toBe(false)
    expect(isClashFakeAddress('::ffff:198.18.0.7')).toBe(false)
  })

  it.each([
    '127.0.0.1',
    '10.0.0.7',
    '169.254.169.254',
    '192.168.1.2',
    '::1',
    'fc00::1',
    '::ffff:127.0.0.1',
    '198.51.100.1',
  ])('blocks private/reserved DNS answer %s before contacting the proxy', async (address) => {
    const wire = await localServers()
    vi.mocked(lookup).mockResolvedValue([
      { address, family: address.includes(':') ? 6 : 4 },
    ] as never)
    await expect(
      createModelFetch({ mode: 'local', proxyUrl: wire.proxyUrl })(target),
    ).rejects.toMatchObject({ code: 'ENDPOINT_NOT_PUBLIC' })
    expect(wire.requests).toHaveLength(0)
  })

  it('rejects mixed public/Fake-IP and private DNS results', async () => {
    const wire = await localServers()
    vi.mocked(lookup).mockResolvedValue([
      { address: '198.18.0.7', family: 4 },
      { address: '10.0.0.7', family: 4 },
    ] as never)
    await expect(
      createModelFetch({ mode: 'local', proxyUrl: wire.proxyUrl })(target),
    ).rejects.toMatchObject({ code: 'ENDPOINT_NOT_PUBLIC' })
    expect(wire.requests).toHaveLength(0)
  })

  it('does not contact the proxy when destination DNS has no addresses', async () => {
    const wire = await localServers()
    vi.mocked(lookup).mockResolvedValue([] as never)
    await expect(
      createModelFetch({ mode: 'local', proxyUrl: wire.proxyUrl })(target),
    ).rejects.toMatchObject({ code: 'DNS_NO_ADDRESS' })
    expect(wire.requests).toHaveLength(0)
  })

  it('does not contact the proxy when destination DNS fails', async () => {
    const wire = await localServers()
    vi.mocked(lookup).mockRejectedValue(
      Object.assign(new Error('synthetic DNS error'), { code: 'ENOTFOUND' }),
    )
    await expect(
      createModelFetch({ mode: 'local', proxyUrl: wire.proxyUrl })(target),
    ).rejects.toMatchObject({ code: 'ENOTFOUND' })
    expect(wire.requests).toHaveLength(0)
  })

  it.each([
    'https://127.0.0.1/v1/models',
    'https://[::1]/v1/models',
    'https://metadata.internal/v1/models',
    'https://api.vendor.com:8443/v1/models',
    'http://api.vendor.com/v1/models',
    'https://user:password@api.vendor.com/v1/models',
  ])('rejects prohibited endpoint %s before resolving proxies or DNS', async (url) => {
    const resolver = vi.fn().mockResolvedValue('PROXY 127.0.0.1:7890')
    await expect(createModelFetch({ mode: 'system' }, resolver)(url)).rejects.toMatchObject({
      code: 'ENDPOINT_NOT_PUBLIC',
    })
    expect(resolver).not.toHaveBeenCalled()
    expect(lookup).not.toHaveBeenCalled()
  })

  it.each([302, 407, 502])(
    'does not follow proxy status %i or transmit API credentials',
    async (status) => {
      const wire = await localServers(undefined, status)
      await expect(
        createModelFetch({ mode: 'local', proxyUrl: wire.proxyUrl })(target, {
          headers: { Authorization: syntheticKey },
        }),
      ).rejects.toMatchObject({
        code: status === 407 ? 'PROXY_AUTH_REQUIRED' : 'PROXY_CONNECT_FAILED',
      })
      expect(tlsConnect).not.toHaveBeenCalled()
      expect(directLookup).not.toHaveBeenCalled()
      expect(JSON.stringify(wire.requests)).not.toContain(syntheticKey)
    },
  )

  it('returns endpoint redirects without following or forwarding API credentials', async () => {
    let received = 0
    const wire = await localServers((_request, response) => {
      received++
      response.writeHead(302, { Location: 'https://other.vendor.com/steal' })
      response.end()
    })
    const response = await createModelFetch({ mode: 'local', proxyUrl: wire.proxyUrl })(target, {
      redirect: 'follow',
      headers: { Authorization: syntheticKey },
    })
    expect(response.status).toBe(302)
    await response.body?.cancel()
    expect(received).toBe(1)
    expect(wire.requests).toHaveLength(1)
  })

  it('rejects an untrusted TLS certificate before sending API headers', async () => {
    const handler = vi.fn((_request: IncomingMessage, response: ServerResponse) =>
      response.end('unexpected'),
    )
    const wire = await localServers(handler)
    vi.mocked(tlsConnect).mockImplementation(actualTls.connect)
    await expect(
      createModelFetch({ mode: 'local', proxyUrl: wire.proxyUrl })(target, {
        headers: { Authorization: syntheticKey },
      }),
    ).rejects.toMatchObject({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })
    expect(handler).not.toHaveBeenCalled()
    expect(Buffer.concat(wire.tunnelBytes).toString()).not.toContain(syntheticKey)
  })

  it('rejects a trusted certificate for the wrong destination hostname', async () => {
    const handler = vi.fn((_request: IncomingMessage, response: ServerResponse) =>
      response.end('unexpected'),
    )
    const wire = await localServers(handler)
    await expect(
      createModelFetch({ mode: 'local', proxyUrl: wire.proxyUrl })(
        'https://other.vendor.com/v1/models',
        { headers: { Authorization: syntheticKey } },
      ),
    ).rejects.toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' })
    expect(handler).not.toHaveBeenCalled()
  })

  it('cancels delayed DNS and does not connect after the lookup eventually completes', async () => {
    const wire = await localServers()
    let finish!: (addresses: never) => void
    vi.mocked(lookup).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }) as never,
    )
    const controller = new AbortController()
    const result = createModelFetch({ mode: 'local', proxyUrl: wire.proxyUrl })(target, {
      signal: controller.signal,
    })
    controller.abort()
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    finish([{ address: '198.18.0.7', family: 4 }] as never)
    await new Promise((resolve) => setImmediate(resolve))
    expect(wire.requests).toHaveLength(0)
  })

  it('cancels delayed system route resolution without opening a later connection', async () => {
    let finish!: (route: string) => void
    const controller = new AbortController()
    const result = createModelFetch(
      { mode: 'system' },
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )(target, { signal: controller.signal })
    controller.abort()
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    finish('PROXY 127.0.0.1:7890')
    await new Promise((resolve) => setImmediate(resolve))
    expect(lookup).not.toHaveBeenCalled()
  })

  it.each(['connect', 'tls'] as const)(
    'cancels while the %s handshake is stalled',
    async (phase) => {
      const wire = await localServers(undefined, 200, phase)
      const controller = new AbortController()
      const result = createModelFetch({ mode: 'local', proxyUrl: wire.proxyUrl })(target, {
        signal: controller.signal,
        headers: { Authorization: syntheticKey },
      })
      const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' })
      await wire.proxyConnected
      // Allow the client to consume CONNECT's success before cancelling the TLS case.
      if (phase === 'tls') await new Promise((resolve) => setImmediate(resolve))
      controller.abort()
      await rejection
      await wire.proxyClosed
      expect(Buffer.concat(wire.tunnelBytes).toString()).not.toContain(syntheticKey)
      expect(directLookup).not.toHaveBeenCalled()
    },
  )

  it('rejects attempts to override Host or send proxy credentials in API headers', async () => {
    const wire = await localServers()
    for (const header of ['Host', 'Proxy-Authorization', 'Proxy-Connection']) {
      await expect(
        createModelFetch({ mode: 'local', proxyUrl: wire.proxyUrl })(target, {
          headers: { [header]: syntheticKey },
        }),
      ).rejects.toMatchObject({ code: 'INVALID_HTTP_REQUEST' })
    }
    expect(wire.requests).toHaveLength(0)
  })

  it('aborts an active streamed body and closes the tunnel', async () => {
    let closed!: () => void
    const originClosed = new Promise<void>((resolve) => {
      closed = resolve
    })
    const wire = await localServers((_request, response) => {
      response.on('close', closed)
      response.write('chunk')
    })
    const controller = new AbortController()
    const response = await createModelFetch({ mode: 'local', proxyUrl: wire.proxyUrl })(target, {
      method: 'GET',
      signal: controller.signal,
    })
    const reader = response.body!.getReader()
    expect((await reader.read()).value).toBeDefined()
    const pending = reader.read()
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await originClosed
  })

  it('body.cancel also closes the proxy tunnel', async () => {
    let closed!: () => void
    const originClosed = new Promise<void>((resolve) => {
      closed = resolve
    })
    const wire = await localServers((_request, response) => {
      response.on('close', closed)
      response.write('chunk')
    })
    const response = await createModelFetch({ mode: 'local', proxyUrl: wire.proxyUrl })(target, {
      method: 'GET',
    })
    await response.body?.cancel()
    await originClosed
  })

  it('the diagnostic deadline covers a stalled response body over the proxy', async () => {
    let closed!: () => void
    const originClosed = new Promise<void>((resolve) => {
      closed = resolve
    })
    const wire = await localServers((_request, response) => {
      response.on('close', closed)
      response.write('{"data":[')
    })
    await expect(
      listRemoteModels(
        { protocol: 'openai-chat', baseUrl: 'https://api.vendor.com/v1', model: '' },
        syntheticKey,
        {
          fetchImpl: createModelFetch({ mode: 'local', proxyUrl: wire.proxyUrl }),
          timeoutMs: 150,
        },
      ),
    ).rejects.toMatchObject({ code: 'timeout' })
    await originClosed
  })
})
