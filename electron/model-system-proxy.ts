import { session } from 'electron'

/** Read OS routes in an isolated in-memory session, without changing any OS settings. */
export function createSystemProxyResolver(): (url: string) => Promise<string> {
  let ready: Promise<Electron.Session> | undefined
  return async (url) => {
    ready ??= (async () => {
      const resolver = session.fromPartition('examcraft-model-proxy-resolver', { cache: false })
      await resolver.setProxy({ mode: 'system' })
      return resolver
    })()
    const resolver = await ready
    // Resolve only when the user chooses system mode and initiates a model request.
    return resolver.resolveProxy(url)
  }
}
