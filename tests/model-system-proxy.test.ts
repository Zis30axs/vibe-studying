import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  setProxy: vi.fn(),
  resolveProxy: vi.fn(),
  fromPartition: vi.fn(),
}))
vi.mock('electron', () => ({ session: { fromPartition: mocks.fromPartition } }))
import { createSystemProxyResolver } from '../electron/model-system-proxy'

beforeEach(() => {
  vi.resetAllMocks()
  mocks.setProxy.mockResolvedValue(undefined)
  mocks.resolveProxy.mockResolvedValue('PROXY 127.0.0.1:7890')
  mocks.fromPartition.mockReturnValue({
    setProxy: mocks.setProxy,
    resolveProxy: mocks.resolveProxy,
  })
})

it('reads OS routes lazily using a shared memory-only session in explicit system mode', async () => {
  const resolve = createSystemProxyResolver()
  expect(mocks.fromPartition).not.toHaveBeenCalled()
  const routes = await Promise.all([
    resolve('https://api.vendor.com/v1/models'),
    resolve('https://api.vendor.com/v1/responses'),
  ])
  expect(routes).toEqual(['PROXY 127.0.0.1:7890', 'PROXY 127.0.0.1:7890'])
  expect(mocks.fromPartition).toHaveBeenCalledExactlyOnceWith('examcraft-model-proxy-resolver', {
    cache: false,
  })
  expect(mocks.setProxy).toHaveBeenCalledExactlyOnceWith({ mode: 'system' })
  expect(mocks.resolveProxy).toHaveBeenCalledTimes(2)
})

it('does not resolve or silently choose direct when system setup fails', async () => {
  mocks.setProxy.mockRejectedValue(new Error('synthetic setup failure'))
  const resolve = createSystemProxyResolver()
  await expect(resolve('https://api.vendor.com/v1/models')).rejects.toThrow()
  expect(mocks.resolveProxy).not.toHaveBeenCalled()
})
