import { lookup } from 'node:dns/promises'
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import { Agent, request as httpsRequest } from 'node:https'
import { isIP, type Socket } from 'node:net'
import { Readable } from 'node:stream'
import { checkServerIdentity, connect as tlsConnect, type TLSSocket } from 'node:tls'
import { modelNetworkSchema, type ModelNetworkConfig } from '../shared/model-network'
import { isPublicAddress, secureFetch, validateBaseUrl } from './model-transport'

export type SystemProxyResolver = (url: string) => Promise<string>

function networkError(code: string): Error & { code: string } {
  // Never expose proxy URLs, destination URLs, credentials or arbitrary proxy error text.
  return Object.assign(new Error('Model network connection unavailable'), { code })
}

function abortError(): Error & { code: string } {
  return Object.assign(networkError('ABORT_ERR'), { name: 'AbortError' })
}

function checkAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw abortError()
}

/** DNS/PAC lookups are not cancellable; prevent their late completion from opening a connection. */
function untilAborted<T>(operation: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return operation
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError())
    signal.addEventListener('abort', abort, { once: true })
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    if (signal.aborted) abort()
  })
}

/** Clash's default Fake-IP range is accepted only behind an explicitly chosen loopback proxy. */
export function isClashFakeAddress(address: string): boolean {
  if (isIP(address) !== 4) return false
  const [first, second] = address.split('.').map(Number)
  return first === 198 && (second === 18 || second === 19)
}

function validatedTarget(input: Parameters<typeof fetch>[0]): URL {
  try {
    // Model callers construct URLs themselves; Request objects and arbitrary request policies
    // are deliberately not accepted across this main-process transport boundary.
    if (typeof input !== 'string' && !(input instanceof URL)) throw new Error()
    const url = new URL(String(input))
    validateBaseUrl(url.origin)
    if (url.username || url.password || url.hash || url.href.length > 4096) throw new Error()
    return url
  } catch {
    throw networkError('ENDPOINT_NOT_PUBLIC')
  }
}

function localProxy(proxyUrl: string): URL {
  const parsed = modelNetworkSchema.safeParse({ mode: 'local', proxyUrl })
  if (!parsed.success || parsed.data.mode !== 'local') throw networkError('PROXY_CONFIG_INVALID')
  return new URL(parsed.data.proxyUrl)
}

function systemRoute(value: string): URL | undefined {
  if (typeof value !== 'string' || value.length > 512) throw networkError('PROXY_UNSUPPORTED')
  const routes = value.split(';').map((route) => route.trim())
  if (routes.length === 1 && routes[0] === 'DIRECT') return undefined
  // Chromium commonly reports "PROXY loopback:port; DIRECT". Select its first route,
  // never use the fallback after failure, and reject other route chains/schemes.
  if (routes.length > 2 || (routes.length === 2 && routes[1] !== 'DIRECT'))
    throw networkError('PROXY_UNSUPPORTED')
  const match = /^PROXY (127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$/.exec(routes[0])
  if (!match) throw networkError('PROXY_UNSUPPORTED')
  try {
    return localProxy(`http://${match[1]}:${match[2]}`)
  } catch {
    throw networkError('PROXY_UNSUPPORTED')
  }
}

async function guardProxyDestination(url: URL, signal?: AbortSignal | null): Promise<void> {
  checkAborted(signal)
  const addresses = await untilAborted(lookup(url.hostname, { all: true }), signal)
  checkAborted(signal)
  if (!addresses.length) throw networkError('DNS_NO_ADDRESS')
  if (addresses.some(({ address }) => !isPublicAddress(address) && !isClashFakeAddress(address)))
    throw networkError('ENDPOINT_NOT_PUBLIC')
}

function responseFromNode(response: IncomingMessage): Response {
  const headers = new Headers()
  for (const [key, value] of Object.entries(response.headers))
    if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
  const status = response.statusCode ?? 500
  const noBody = [204, 205, 304].includes(status)
  if (noBody) response.resume()
  return new Response(noBody ? null : (Readable.toWeb(response) as ReadableStream<Uint8Array>), {
    status,
    headers,
  })
}

/** One CONNECT + verified TLS session per request; there is no retry, redirect or connection pool. */
function proxyFetch(url: URL, proxy: URL, init?: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    let connectRequest: ClientRequest | undefined
    let request: ClientRequest | undefined
    let tunnel: Socket | undefined
    let tlsSocket: TLSSocket | undefined
    let response: IncomingMessage | undefined
    let agent: Agent | undefined
    let settled = false
    const signal = init?.signal
    const cleanup = () => signal?.removeEventListener('abort', abort)
    const dispose = () => {
      cleanup()
      connectRequest?.destroy()
      request?.destroy()
      response?.destroy()
      tlsSocket?.destroy()
      tunnel?.destroy()
      agent?.destroy()
    }
    const fail = (error: Error) => {
      if (!settled) {
        settled = true
        reject(error)
      }
      // A response already handed to the reader must error too, not appear truncated/successful.
      response?.destroy(error)
      dispose()
    }
    const abort = () => fail(abortError())
    try {
      checkAborted(signal)
      const method = init?.method?.toUpperCase() ?? 'POST'
      if (
        !['GET', 'POST'].includes(method) ||
        (init?.body != null && typeof init.body !== 'string')
      )
        throw networkError('INVALID_HTTP_REQUEST')
      const headers = new Headers(init?.headers)
      if (['host', 'proxy-authorization', 'proxy-connection'].some((header) => headers.has(header)))
        throw networkError('INVALID_HTTP_REQUEST')
      signal?.addEventListener('abort', abort, { once: true })
      const authority = `${url.hostname}:443`
      connectRequest = httpRequest({
        hostname: proxy.hostname.replace(/^\[|\]$/g, ''),
        port: Number(proxy.port || 80),
        method: 'CONNECT',
        path: authority,
        headers: { Host: authority },
        agent: false,
        maxHeaderSize: 16384,
      })
      connectRequest.once('error', fail)
      connectRequest.setTimeout(60000, () => fail(networkError('ETIMEDOUT')))
      connectRequest.once('response', (reply) => {
        reply.destroy()
        fail(
          networkError(reply.statusCode === 407 ? 'PROXY_AUTH_REQUIRED' : 'PROXY_CONNECT_FAILED'),
        )
      })
      connectRequest.once('connect', (reply, socket, head) => {
        tunnel = socket
        if (signal?.aborted) return abort()
        if (reply.statusCode !== 200 || head.length) {
          fail(
            networkError(reply.statusCode === 407 ? 'PROXY_AUTH_REQUIRED' : 'PROXY_CONNECT_FAILED'),
          )
          return
        }
        connectRequest?.setTimeout(0)
        tlsSocket = tlsConnect({
          socket,
          servername: url.hostname,
          rejectUnauthorized: true,
          checkServerIdentity,
          ALPNProtocols: ['http/1.1'],
        })
        tlsSocket.once('error', fail)
        tlsSocket.setTimeout(60000, () => fail(networkError('ETIMEDOUT')))
        tlsSocket.once('secureConnect', () => {
          if (signal?.aborted) return abort()
          if (!tlsSocket?.authorized) {
            fail(networkError('CERT_UNTRUSTED'))
            return
          }
          try {
            tlsSocket.setTimeout(0)
            agent = new Agent({ keepAlive: false, maxSockets: 1 })
            // The socket has already completed normal CA + destination hostname verification.
            // A dedicated agent prevents HTTPS from establishing a second, direct connection.
            agent.createConnection = () => tlsSocket!
            request = httpsRequest(
              url,
              { method, headers: Object.fromEntries(headers), agent, maxHeaderSize: 16384 },
              (reply) => {
                response = reply
                reply.once('error', fail)
                reply.once('close', dispose)
                try {
                  const result = responseFromNode(reply)
                  settled = true
                  resolve(result)
                } catch {
                  fail(networkError('INVALID_HTTP_RESPONSE'))
                }
              },
            )
            request.once('error', fail)
            request.end(method === 'GET' ? undefined : init?.body)
          } catch {
            fail(networkError('INVALID_HTTP_REQUEST'))
          }
        })
      })
      connectRequest.end()
    } catch (error) {
      fail(error instanceof Error ? error : networkError('PROXY_CONNECT_FAILED'))
    }
  })
}

/**
 * The explicit loopback proxy is a trusted routing/DNS boundary. Only it receives CONNECT's
 * hostname; API headers/body are written after destination TLS verification. Local private DNS
 * answers remain blocked, and no proxy failure falls back to the direct transport.
 */
export function createModelFetch(
  network?: ModelNetworkConfig,
  resolveSystemProxy?: SystemProxyResolver,
): typeof fetch {
  const parsed = modelNetworkSchema.safeParse(network ?? { mode: 'direct' })
  if (!parsed.success) throw networkError('PROXY_CONFIG_INVALID')
  const config = parsed.data
  return async (input, init) => {
    const url = validatedTarget(input)
    checkAborted(init?.signal)
    if (config.mode === 'direct') return secureFetch(url.href, init)
    let proxy: URL | undefined
    if (config.mode === 'local') proxy = localProxy(config.proxyUrl)
    else {
      if (!resolveSystemProxy) throw networkError('PROXY_UNAVAILABLE')
      let route: string
      try {
        route = await untilAborted(resolveSystemProxy(url.href), init?.signal)
      } catch {
        checkAborted(init?.signal)
        throw networkError('PROXY_UNAVAILABLE')
      }
      checkAborted(init?.signal)
      proxy = systemRoute(route)
    }
    if (!proxy) return secureFetch(url.href, init)
    await guardProxyDestination(url, init?.signal)
    return proxyFetch(url, proxy, init)
  }
}
