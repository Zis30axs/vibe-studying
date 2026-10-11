import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebResearchStore } from '../src/adapters/web-research-store'
import type { ModelSecretStorage } from '../src/adapters/model-profile-store'
import type { WebResearchConfigInput } from '../src/shared/web-research'

const key = 'tvly-synthetic-only-never-real'
const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})
function secureStorage() {
  const contents = new Map<string, string>()
  return {
    isAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => {
      const opaque = Buffer.from(`mock-os-cipher:${randomUUID()}`).toString('base64')
      contents.set(opaque, value)
      return opaque
    }),
    decryptString: vi.fn((value: string) => {
      const found = contents.get(value)
      if (!found) throw new Error('synthetic failure')
      return found
    }),
    contents,
  }
}
async function fixture(secure?: ModelSecretStorage) {
  const directory = await mkdtemp(join(tmpdir(), 'examcraft-web-research-'))
  directories.push(directory)
  return {
    directory,
    path: join(directory, 'web-research-credentials.json'),
    store: new WebResearchStore(directory, { secureStorage: secure }),
    restart: () => new WebResearchStore(directory, { secureStorage: secure }),
  }
}
const input = (
  expectedRevision: number,
  extra: Partial<WebResearchConfigInput> = {},
): WebResearchConfigInput => ({
  provider: 'tavily',
  apiKey: key,
  persistApiKey: false,
  expectedRevision,
  ...extra,
})

describe('separate Tavily main-process credential vault', () => {
  it('defaults to unavailable/missing and never bootstraps or reuses a model key', async () => {
    const { store, directory } = await fixture()
    await writeFile(join(directory, 'model-config.json'), JSON.stringify({ apiKey: key }))
    expect(await store.getConfig()).toEqual({
      provider: 'tavily',
      revision: 0,
      configured: false,
      keyStatus: 'missing',
      secureStorageAvailable: false,
    })
    await expect(store.resolve(0)).rejects.toThrow('Tavily API Key')
    expect(await readdir(directory)).toEqual(['model-config.json'])
  })
  it('keeps session key only in memory, masks projections, clears old encrypted key on replacement', async () => {
    const secure = secureStorage()
    const { store, path, restart } = await fixture(secure)
    const state = await store.saveConfig(input(0))
    expect(state).toMatchObject({ configured: true, keyStatus: 'session', revision: 1 })
    expect(JSON.stringify(state)).not.toContain(key)
    expect((await store.resolve(1)).key).toBe(key)
    expect(await readFile(path, 'utf8')).not.toContain(key)
    expect((await restart().getConfig()).keyStatus).toBe('missing')
    expect(secure.encryptString).not.toHaveBeenCalled()
    // POSIX mode bits are not an ACL guarantee on Windows; credential-state and plaintext-exclusion checks remain platform-independent.
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
    await store.saveConfig(input(1, { persistApiKey: true }))
    expect((await restart().getConfig()).keyStatus).toBe('saved')
    await store.saveConfig(input(2, { apiKey: 'replacement-synthetic-key', persistApiKey: false }))
    expect(await readFile(path, 'utf8')).not.toContain('encryptedApiKey')
    expect((await restart().getConfig()).keyStatus).toBe('missing')
  })
  it('persists only opaque OS-encrypted envelope bound to provider and endpoint, never exposes cipher', async () => {
    const secure = secureStorage()
    const { store, path, restart } = await fixture(secure)
    const state = await store.saveConfig(input(0, { persistApiKey: true }))
    const persisted = JSON.parse(await readFile(path, 'utf8'))
    expect(persisted).toEqual({
      version: 1,
      provider: 'tavily',
      revision: 1,
      encryptedApiKey: expect.any(String),
    })
    expect(secure.encryptString).toHaveBeenCalledWith(
      JSON.stringify({
        version: 1,
        provider: 'tavily',
        endpoint: 'https://api.tavily.com',
        apiKey: key,
      }),
    )
    expect(JSON.stringify(state)).not.toContain(persisted.encryptedApiKey)
    expect((await restart().resolve(1)).key).toBe(key)
    expect(await readFile(path, 'utf8')).not.toContain(key)
    expect(await readdir(join(path, '..'))).toEqual(['web-research-credentials.json'])
  })
  it('rejects changed-provider/endpoint envelopes and inaccessible keyrings without leaking or overwriting', async () => {
    const secure = secureStorage()
    const { store, path, restart } = await fixture(secure)
    await store.saveConfig(input(0, { persistApiKey: true }))
    const previous = await readFile(path, 'utf8')
    const cipher = JSON.parse(previous).encryptedApiKey
    for (const update of [{ provider: 'other' }, { endpoint: 'https://evil.publisher.com' }]) {
      secure.contents.set(
        cipher,
        JSON.stringify({
          version: 1,
          provider: 'tavily',
          endpoint: 'https://api.tavily.com',
          apiKey: key,
          ...update,
        }),
      )
      expect((await restart().getConfig()).keyStatus).toBe('locked')
      await expect(restart().resolve(1)).rejects.toThrow('无法解锁')
      expect(await readFile(path, 'utf8')).toBe(previous)
    }
    secure.isAvailable.mockReturnValue(false)
    expect((await restart().getConfig()).keyStatus).toBe('locked')
  })
  it('rejects storage failures and plain/base64-plaintext fallback, preserving last committed key', async () => {
    const secure = secureStorage()
    const { store, path } = await fixture(secure)
    await store.saveConfig(input(0))
    const previous = await readFile(path, 'utf8')
    secure.isAvailable.mockReturnValue(false)
    await expect(store.saveConfig(input(1, { persistApiKey: true }))).rejects.toThrow(
      '安全存储不可用',
    )
    secure.isAvailable.mockReturnValue(true)
    for (const impl of [
      (text: string) => text,
      (text: string) => Buffer.from(text).toString('base64'),
      () => key,
      () => Buffer.from(key).toString('base64'),
      () => {
        throw new Error(key)
      },
    ]) {
      secure.encryptString.mockImplementation(impl)
      await expect(
        store.saveConfig(input(1, { apiKey: key, persistApiKey: true })),
      ).rejects.toThrow('不会回退明文')
      expect(await readFile(path, 'utf8')).toBe(previous)
      expect((await store.resolve(1)).key).toBe(key)
    }
  })
  it('accepts legitimate opaque ciphertext containing a short key as an incidental substring', async () => {
    const secure = secureStorage()
    const cipher = 'YWFhYWFhYWFhYWFh'
    secure.encryptString.mockImplementation((text) => {
      secure.contents.set(cipher, text)
      return cipher
    })
    const { store } = await fixture(secure)
    await expect(
      store.saveConfig(input(0, { apiKey: 'YWFh', persistApiKey: true })),
    ).resolves.toMatchObject({ keyStatus: 'saved' })
    expect((await store.resolve(1)).key).toBe('YWFh')
  })
  it('blank input retains keys, clear removes both session and persisted keys, strict revisions serialize repeated writes', async () => {
    const { store, path, restart } = await fixture(secureStorage())
    await store.saveConfig(input(0))
    await store.saveConfig(input(1, { apiKey: '   ', persistApiKey: false }))
    expect((await store.resolve(2)).key).toBe(key)
    const outcomes = await Promise.allSettled([
      store.saveConfig(input(2, { apiKey: 'replacement' })),
      store.saveConfig(input(2, { apiKey: 'other' })),
    ])
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect((await store.resolve(3)).key).toBe('replacement')
    await expect(store.resolve(2)).rejects.toThrow('更改')
    await store.saveConfig(input(3, { apiKey: undefined, clearApiKey: true }))
    expect((await store.getConfig()).keyStatus).toBe('missing')
    expect((await restart().getConfig()).keyStatus).toBe('missing')
    expect(await readFile(path, 'utf8')).not.toContain('encryptedApiKey')
    await expect(store.saveConfig(input(4, { provider: 'other' as never }))).rejects.toThrow('无效')
    await expect(
      store.saveConfig({ ...input(4), endpoint: 'https://evil.publisher.com' } as never),
    ).rejects.toThrow('无效')
    await expect(store.saveConfig(input(4, { apiKey: `${key}\r\nheader` }))).rejects.toThrow('无效')
  })
  it('fails closed on corrupt data repeatedly without overwriting it or leaking causes', async () => {
    const { store, path } = await fixture(secureStorage())
    const corrupted = `{bad ${key}`
    await writeFile(path, corrupted)
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(store.getConfig()).rejects.toThrow('原文件未覆盖')
      await expect(store.saveConfig(input(0))).rejects.toThrow('原文件未覆盖')
      expect(await readFile(path, 'utf8')).toBe(corrupted)
    }
  })
})
