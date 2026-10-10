import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitHubProfileService } from '../src/adapters/github-profile-service'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function setup(fetcher = vi.fn<typeof fetch>()) {
  const path = await mkdtemp(join(tmpdir(), 'examcraft-github-'))
  directories.push(path)
  return { service: new GitHubProfileService(path, fetcher), fetcher, path }
}
const publicResponse = (extra = {}) =>
  new Response(JSON.stringify({ login: 'octocat', name: 'Octo Cat', ...extra }))
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

describe('public GitHub display association', () => {
  it('stores only public display fields, caches allowlisted raster, loads offline and clears', async () => {
    const { service, fetcher, path } = await setup()
    fetcher
      .mockResolvedValueOnce(
        publicResponse({
          avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
          email: 'ignored@example.com',
          private_repos: 9,
        }),
      )
      .mockResolvedValueOnce(new Response(png))
    expect(await service.get()).toBeNull()
    const profile = await service.bind('Octocat')
    expect(profile).toEqual({
      login: 'octocat',
      name: 'Octo Cat',
      avatarDataUrl: `data:image/png;base64,${png.toString('base64')}`,
    })
    expect(fetcher.mock.calls[0][0]).toBe('https://api.github.com/users/Octocat')
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'error', credentials: 'omit' })
    expect(fetcher.mock.calls[0][1]?.headers).not.toHaveProperty('Authorization')
    expect(fetcher.mock.calls[1][0]).toBe('https://avatars.githubusercontent.com/u/1?s=128')
    expect(JSON.parse(await readFile(join(path, 'github-display-profile.json'), 'utf8'))).toEqual(
      profile,
    )
    expect(await new GitHubProfileService(path, vi.fn()).get()).toEqual(profile)
    await service.clear()
    expect(await service.get()).toBeNull()
  })
  it.each(['../admin', 'https://evil.test', '-start', 'end-', 'a--b', '', 'a'.repeat(40), 12])(
    'rejects invalid input %s before network',
    async (input) => {
      const { service, fetcher } = await setup()
      expect(() => service.bind(input)).toThrow('用户名')
      expect(fetcher).not.toHaveBeenCalled()
    },
  )
  it.each([
    'https://evil.test/u/1',
    'http://avatars.githubusercontent.com/u/1',
    'https://avatars.githubusercontent.com.evil.test/u/1',
    'https://avatars.githubusercontent.com@evil.test/u/1',
    'https://avatars.githubusercontent.com:444/u/1',
    'https://avatars.githubusercontent.com/anything',
  ])('does not fetch arbitrary avatar URL %s', async (avatar_url) => {
    const { service, fetcher } = await setup()
    fetcher.mockResolvedValueOnce(publicResponse({ avatar_url }))
    expect((await service.bind('octocat')).avatarDataUrl).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it.each([404, 403, 429, 500])(
    'handles HTTP %s without overwriting existing display',
    async (status) => {
      const { service, fetcher } = await setup()
      fetcher.mockResolvedValueOnce(publicResponse())
      const old = await service.bind('octocat')
      fetcher.mockResolvedValueOnce(new Response('', { status }))
      await expect(service.bind('other')).rejects.toThrow('GitHub')
      expect(await service.get()).toEqual(old)
    },
  )
  it('rejects mismatched account, malformed JSON, large streamed data, and offline failures', async () => {
    const { service, fetcher } = await setup()
    fetcher.mockResolvedValueOnce(publicResponse({ login: 'other' }))
    await expect(service.bind('octocat')).rejects.toThrow('不一致')
    fetcher.mockResolvedValueOnce(new Response('no json'))
    await expect(service.bind('octocat')).rejects.toThrow('网络')
    fetcher.mockResolvedValueOnce(new Response(' '.repeat(65537)))
    await expect(service.bind('octocat')).rejects.toThrow('过大')
    fetcher.mockRejectedValueOnce(new TypeError('network down'))
    await expect(service.bind('octocat')).rejects.toThrow('网络')
    expect(await service.get()).toBeNull()
  })
  it.each([
    new Response('<svg onload="alert(1)"/>'),
    new Response('x'.repeat(524289)),
    new Response('tiny', { headers: { 'content-length': '99999999' } }),
  ])('falls back when avatar is unsafe or oversized', async (response) => {
    const { service, fetcher } = await setup()
    fetcher
      .mockResolvedValueOnce(
        publicResponse({ avatar_url: 'https://avatars.githubusercontent.com/u/1' }),
      )
      .mockResolvedValueOnce(response)
    expect((await service.bind('octocat')).avatarDataUrl).toBeNull()
  })
  it('serializes bind then unbind so late requests cannot restore cleared data', async () => {
    const { service, fetcher } = await setup()
    fetcher.mockResolvedValueOnce(publicResponse())
    const bind = service.bind('octocat')
    const clear = service.clear()
    await Promise.all([bind, clear])
    expect(await service.get()).toBeNull()
  })
})

describe('GitHub response timeout and safe errors', () => {
  it('does not expose arbitrary provider error messages', async () => {
    const { service, fetcher } = await setup()
    fetcher.mockRejectedValueOnce(new Error('GitHub transport secret-marker'))
    await expect(service.bind('octocat')).rejects.toThrow('请检查网络')
  })
  it('times out a stalled response body even when its source ignores AbortSignal', async () => {
    const { service, fetcher } = await setup()
    fetcher.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start() {
            /* Never yields. */
          },
        }),
      ),
    )
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const pending = service.bind('octocat')
      const assertion = expect(pending).rejects.toThrow('超时')
      while (fetcher.mock.calls.length === 0)
        await new Promise<void>((resolve) => setImmediate(resolve))
      await vi.advanceTimersByTimeAsync(10_001)
      await assertion
      expect(await service.get()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
