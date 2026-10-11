import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelConsentStore } from '../src/adapters/model-consent-store'
import { AtomicJsonStore } from '../src/adapters/atomic-json-store'
import { validateBaseUrl } from '../src/adapters/model-transport'
import { ModelConsentSession } from '../src/components/ModelConsentControl'
import {
  canonicalModelConsentBaseUrl,
  emptyModelConsents,
  hasModelConsent,
  modelConsentGrantSchema,
  modelConsentRevokeSchema,
  modelConsentsStateSchema,
  type ModelConsentApi,
  type ModelConsentsState,
} from '../src/shared/model-consent'

const first = 'https://first.vendor.com/v1'
const second = 'https://second.vendor.com/v1'
const directories: string[] = []
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'examcraft-consent-'))
  directories.push(directory)
  return { directory, store: new ModelConsentStore(directory) }
}
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
const granted = (revision = 1): ModelConsentsState => ({
  version: 1,
  revision,
  grants: [
    {
      baseUrl: first,
      scopes: ['advisor', 'knowledge'],
      grantedAt: '2026-10-11T00:00:00.000Z',
    },
  ],
})
function apiMock(overrides: Partial<ModelConsentApi> = {}): ModelConsentApi {
  return {
    getModelConsents: vi.fn(async () => emptyModelConsents()),
    grantModelConsent: vi.fn(async () => granted()),
    revokeModelConsent: vi.fn(async () => ({ ...emptyModelConsents(), revision: 2 })),
    ...overrides,
  }
}

describe('explicit local model consent persistence', () => {
  it('starts without consent and neither reads nor old booleans implicitly write grants', async () => {
    const { directory, store } = await setup()
    await writeFile(join(directory, 'state.json'), JSON.stringify({ cloudConsent: true }))
    expect(await store.getModelConsents()).toEqual(emptyModelConsents())
    expect(await store.hasConsent(first, ['grading'])).toBe(false)
    expect(await readdir(directory)).toEqual(['state.json'])
  })
  it('persists only receiver, explicitly granted categories and timestamp across a restart', async () => {
    const { directory, store } = await setup()
    const result = await store.grantModelConsent({
      baseUrl: 'https://FIRST.vendor.com:443/v1/',
      scopes: ['knowledge', 'advisor'],
    })
    expect(result.revision).toBe(1)
    expect(result.grants[0].baseUrl).toBe(first)
    expect(result.grants[0].scopes).toEqual(['advisor', 'knowledge'])
    expect(await new ModelConsentStore(directory).getModelConsents()).toEqual(result)
    expect(await store.hasConsent(first, ['advisor'])).toBe(true)
    expect(await store.hasConsent(first, ['advisor', 'reference'])).toBe(false)
    expect(await store.hasConsent(second, ['advisor'])).toBe(false)
    expect(await store.hasConsent(`${first}/other`, ['advisor'])).toBe(false)
    const disk = JSON.parse(await readFile(join(directory, 'model-consents.json'), 'utf8'))
    expect(Object.keys(disk.grants[0]).sort()).toEqual(['baseUrl', 'grantedAt', 'scopes'])
    // Authorization never stores or selects question text, keys, file IDs or excerpts.
    expect(JSON.stringify(disk)).not.toMatch(/apiKey|questionId|chunkId|excerpt|model|profileId/)
  })
  it('merges explicit categories atomically and does not lose simultaneous changes', async () => {
    const { store } = await setup()
    await Promise.all([
      store.grantModelConsent({ baseUrl: first, scopes: ['advisor'] }),
      store.grantModelConsent({ baseUrl: first, scopes: ['reference'] }),
      store.grantModelConsent({ baseUrl: second, scopes: ['generation'] }),
    ])
    const state = await store.getModelConsents()
    expect(state.revision).toBe(3)
    expect(hasModelConsent(state, first, ['advisor', 'reference'])).toBe(true)
    expect(hasModelConsent(state, second, ['generation'])).toBe(true)
    expect((await store.grantModelConsent({ baseUrl: first, scopes: ['advisor'] })).revision).toBe(
      3,
    )
  })
  it('revokes scoped, receiver and all grants without broadening any surviving grant', async () => {
    const { store, directory } = await setup()
    await store.grantModelConsent({ baseUrl: first, scopes: ['advisor', 'reference', 'knowledge'] })
    await store.grantModelConsent({ baseUrl: second, scopes: ['generation', 'knowledge'] })
    await store.revokeModelConsent({ baseUrl: first, scopes: ['reference'] })
    expect(await store.hasConsent(first, ['advisor', 'knowledge'])).toBe(true)
    expect(await store.hasConsent(first, ['reference'])).toBe(false)
    await store.revokeModelConsent({ scopes: ['knowledge'] })
    expect(await store.hasConsent(first, ['knowledge'])).toBe(false)
    expect(await store.hasConsent(second, ['knowledge'])).toBe(false)
    await store.revokeModelConsent({ baseUrl: first })
    expect(await store.hasConsent(first, ['advisor'])).toBe(false)
    expect(await store.hasConsent(second, ['generation'])).toBe(true)
    await store.revokeModelConsent({})
    expect((await new ModelConsentStore(directory).getModelConsents()).grants).toEqual([])
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
  it('rejects unknown fields/categories, empty grants, duplicate scopes and unsafe recipients', async () => {
    const { store } = await setup()
    for (const input of [
      { baseUrl: first, scopes: [] },
      { baseUrl: first, scopes: ['all'] },
      { baseUrl: first, scopes: ['advisor', 'advisor'] },
      { baseUrl: first, scopes: ['advisor'], apiKey: 'synthetic-never-real' },
      { baseUrl: 'http://first.vendor.com', scopes: ['advisor'] },
      { baseUrl: 'https://127.0.0.1', scopes: ['advisor'] },
      { baseUrl: 'https://first.vendor.com/?key=synthetic', scopes: ['advisor'] },
    ]) {
      expect(modelConsentGrantSchema.safeParse(input).success).toBe(false)
      await expect(store.grantModelConsent(input as never)).rejects.toThrow()
    }
    expect(modelConsentRevokeSchema.safeParse({ scopes: [] }).success).toBe(false)
    expect(modelConsentRevokeSchema.safeParse({ all: true }).success).toBe(false)
    expect(await store.getModelConsents()).toEqual(emptyModelConsents())
  })
  it('fails closed on corrupt stored consent without replacing the original file', async () => {
    const { directory, store } = await setup()
    const filename = join(directory, 'model-consents.json')
    const corrupt =
      '{"version":1,"grants":[{"baseUrl":"https://first.vendor.com","scopes":["all"]}]}'
    await writeFile(filename, corrupt)
    await expect(store.getModelConsents()).rejects.toThrow('原文件未被覆盖')
    await expect(store.grantModelConsent({ baseUrl: first, scopes: ['advisor'] })).rejects.toThrow()
    await expect(store.revokeModelConsent({})).rejects.toThrow()
    expect(await readFile(filename, 'utf8')).toBe(corrupt)
  })
  it('uses the same endpoint normalization as transport and keeps different API paths separate', () => {
    for (const value of [
      first,
      `${first}/`,
      'https://FIRST.vendor.com:443/v1/',
      'https://api.deepseek.com',
      'https://api.vendor.com/v1//',
    ])
      expect(canonicalModelConsentBaseUrl(value)).toBe(validateBaseUrl(value))
    for (const value of [
      'http://first.vendor.com',
      'https://localhost',
      'https://127.0.0.1',
      'https://[::1]',
      'https://api.vendor.com:444',
      'https://user:password@api.vendor.com',
      'https://api.vendor.com?q=1',
      'https://api.vendor.com#fragment',
      'https://api.internal',
    ]) {
      expect(() => canonicalModelConsentBaseUrl(value)).toThrow()
      expect(() => validateBaseUrl(value)).toThrow()
    }
    expect(hasModelConsent(granted(), first, [])).toBe(false)
    expect(hasModelConsent(granted(), first, ['unknown'] as never)).toBe(false)
    expect(
      modelConsentsStateSchema.safeParse({
        ...granted(),
        grants: [...granted().grants, ...granted().grants],
      }).success,
    ).toBe(false)
  })
})

describe('main-process revocation overlay', () => {
  it('keeps a failed scoped revoke denied after a renderer reload in the same main process', async () => {
    const { directory, store } = await setup()
    await store.grantModelConsent({ baseUrl: first, scopes: ['advisor', 'knowledge'] })
    await store.grantModelConsent({ baseUrl: second, scopes: ['generation'] })
    vi.spyOn(AtomicJsonStore.prototype, 'update').mockRejectedValueOnce(
      new Error('Synthetic write failure'),
    )
    await expect(store.revokeModelConsent({ baseUrl: first, scopes: ['advisor'] })).rejects.toThrow(
      '完全退出应用后可能恢复旧授权',
    )
    expect(await store.hasConsent(first, ['advisor'])).toBe(false)
    expect(await store.hasConsent(first, ['knowledge'])).toBe(true)
    expect(await store.hasConsent(second, ['generation'])).toBe(true)
    const reloadedRenderer = new ModelConsentSession(store)
    await reloadedRenderer.load()
    expect(hasModelConsent(reloadedRenderer.getSnapshot().state, first, ['advisor'])).toBe(false)
    expect(hasModelConsent(reloadedRenderer.getSnapshot().state, first, ['knowledge'])).toBe(true)
    // A fresh main-process instance is a true app restart, unlike a renderer reload.
    // Failed writes cannot be claimed durable: the old disk grant still exists.
    expect(await new ModelConsentStore(directory).hasConsent(first, ['advisor'])).toBe(true)
  })
  it('revokes unknown receivers even after a read/write failure and persists only bounded explicit regrant', async () => {
    const { directory, store } = await setup()
    const filename = join(directory, 'model-consents.json')
    await writeFile(filename, '{corrupt synthetic file')
    await expect(store.getModelConsents()).rejects.toThrow()
    await expect(store.revokeModelConsent({})).rejects.toThrow('未能永久保存撤销')
    const previous = granted()
    previous.grants.push({ ...previous.grants[0], baseUrl: second })
    await writeFile(filename, JSON.stringify(previous))
    const reloadedRenderer = new ModelConsentSession(store)
    await reloadedRenderer.load()
    expect(reloadedRenderer.getSnapshot().state?.grants).toEqual([])
    expect(await store.hasConsent(first, ['advisor'])).toBe(false)
    expect(await store.hasConsent(second, ['knowledge'])).toBe(false)
    await store.grantModelConsent({ baseUrl: first, scopes: ['advisor'] })
    expect(await store.hasConsent(first, ['advisor'])).toBe(true)
    expect(await store.hasConsent(first, ['knowledge'])).toBe(false)
    expect(await store.hasConsent(second, ['advisor'])).toBe(false)
    // This successful write also durably completes the previously failed revocations.
    const restarted = new ModelConsentStore(directory)
    expect(await restarted.hasConsent(first, ['advisor'])).toBe(true)
    expect(await restarted.hasConsent(first, ['knowledge'])).toBe(false)
    expect(await restarted.hasConsent(second, ['advisor'])).toBe(false)
  })
  it('a failed regrant cannot clear a session revoke; scoped global revocation leaves other categories intact', async () => {
    const { store } = await setup()
    await store.grantModelConsent({ baseUrl: first, scopes: ['advisor', 'knowledge'] })
    await store.grantModelConsent({ baseUrl: second, scopes: ['generation', 'knowledge'] })
    const update = vi.spyOn(AtomicJsonStore.prototype, 'update')
    update.mockRejectedValueOnce(new Error('Synthetic revoke failure'))
    await expect(store.revokeModelConsent({ scopes: ['knowledge'] })).rejects.toThrow()
    update.mockRejectedValueOnce(new Error('Synthetic grant failure'))
    await expect(
      store.grantModelConsent({ baseUrl: first, scopes: ['knowledge'] }),
    ).rejects.toThrow()
    expect(await store.hasConsent(first, ['advisor'])).toBe(true)
    expect(await store.hasConsent(second, ['generation'])).toBe(true)
    expect(await store.hasConsent(first, ['knowledge'])).toBe(false)
    expect(await store.hasConsent(second, ['knowledge'])).toBe(false)
    await store.grantModelConsent({ baseUrl: first, scopes: ['knowledge'] })
    expect(await store.hasConsent(first, ['knowledge'])).toBe(true)
    expect(await store.hasConsent(second, ['knowledge'])).toBe(false)
  })
  it('a newer revoke wins over a grant already waiting to finish persistence', async () => {
    const { store } = await setup()
    const write = deferred<ModelConsentsState>()
    const update = vi.spyOn(AtomicJsonStore.prototype, 'update')
    update.mockImplementationOnce(() => write.promise)
    const granting = store.grantModelConsent({ baseUrl: first, scopes: ['advisor'] })
    update.mockRejectedValueOnce(new Error('Synthetic later revoke failure'))
    await expect(store.revokeModelConsent({ baseUrl: first })).rejects.toThrow()
    write.resolve(granted())
    const result = await granting
    expect(hasModelConsent(result, first, ['advisor'])).toBe(false)
    expect(hasModelConsent(result, first, ['knowledge'])).toBe(false)
  })
})

describe('shared renderer consent session', () => {
  it('loads once for simultaneous controls and never writes on read', async () => {
    const response = deferred<ModelConsentsState>()
    const api = apiMock({ getModelConsents: vi.fn(() => response.promise) })
    const session = new ModelConsentSession(api)
    const change = vi.fn()
    const unsubscribe = session.subscribe(change)
    const firstLoad = session.load()
    const secondLoad = session.load()
    response.resolve(granted())
    await Promise.all([firstLoad, secondLoad])
    expect(api.getModelConsents).toHaveBeenCalledTimes(1)
    expect(api.grantModelConsent).not.toHaveBeenCalled()
    expect(hasModelConsent(session.getSnapshot().state, first, ['advisor'])).toBe(true)
    expect(change).toHaveBeenCalled()
    unsubscribe()
  })
  it('masks revoked scopes immediately for every subscriber before disk confirms', async () => {
    const response = deferred<ModelConsentsState>()
    const api = apiMock({
      getModelConsents: async () => granted(),
      revokeModelConsent: () => response.promise,
    })
    const session = new ModelConsentSession(api)
    await session.load()
    const states: boolean[] = []
    session.subscribe(() =>
      states.push(hasModelConsent(session.getSnapshot().state, first, ['advisor'])),
    )
    const revoke = session.revoke({ baseUrl: first, scopes: ['advisor'] })
    expect(hasModelConsent(session.getSnapshot().state, first, ['advisor'])).toBe(false)
    expect(hasModelConsent(session.getSnapshot().state, first, ['knowledge'])).toBe(true)
    expect(states.every((value) => !value)).toBe(true)
    response.resolve({ ...granted(2), grants: [{ ...granted().grants[0], scopes: ['knowledge'] }] })
    await revoke
    expect(session.getSnapshot().pending).toBe(0)
  })
  it('ignores a late load so it cannot restore a revoked authorization', async () => {
    const response = deferred<ModelConsentsState>()
    const session = new ModelConsentSession(apiMock({ getModelConsents: () => response.promise }))
    const loading = session.load()
    await session.revoke({ baseUrl: first })
    response.resolve(granted())
    await loading
    expect(session.getSnapshot().state?.grants).toEqual([])
  })
  it('serializes grant then revoke and cannot reintroduce a stale grant while revocation waits', async () => {
    const grantResult = deferred<ModelConsentsState>()
    const revokeResult = deferred<ModelConsentsState>()
    const api = apiMock({
      grantModelConsent: vi.fn(() => grantResult.promise),
      revokeModelConsent: vi.fn(() => revokeResult.promise),
    })
    const session = new ModelConsentSession(api)
    await session.load()
    const granting = session.grant({ baseUrl: first, scopes: ['advisor'] })
    const revoking = session.revoke({})
    grantResult.resolve(granted())
    await granting
    expect(hasModelConsent(session.getSnapshot().state, first, ['advisor'])).toBe(false)
    revokeResult.resolve({ ...emptyModelConsents(), revision: 2 })
    await revoking
    expect(api.revokeModelConsent).toHaveBeenCalledOnce()
    expect(session.getSnapshot().state?.grants).toEqual([])
  })
  it('keeps a failed revoke denied for this session even when rereading disk; explicit regrant can restore it', async () => {
    const api = apiMock({
      getModelConsents: async () => granted(),
      revokeModelConsent: async () => {
        throw new Error('Synthetic disk failure')
      },
    })
    const session = new ModelConsentSession(api)
    await session.load()
    await expect(session.revoke({ baseUrl: first, scopes: ['advisor'] })).rejects.toThrow()
    expect(session.getSnapshot().error).toContain('未能保存撤销')
    await session.load()
    expect(hasModelConsent(session.getSnapshot().state, first, ['advisor'])).toBe(false)
    expect(hasModelConsent(session.getSnapshot().state, first, ['knowledge'])).toBe(true)
    await session.grant({ baseUrl: first, scopes: ['advisor'] })
    expect(hasModelConsent(session.getSnapshot().state, first, ['advisor'])).toBe(true)
  })
  it('denies revoke-all even if the receiver inventory was unreadable and persistence fails', async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error('Synthetic initial read failure'))
      .mockResolvedValue(granted())
    const api = apiMock({
      getModelConsents: read,
      revokeModelConsent: async () => {
        throw new Error('Synthetic disk failure')
      },
    })
    const session = new ModelConsentSession(api)
    await session.load()
    expect(session.getSnapshot().state).toBeNull()
    await expect(session.revoke({})).rejects.toThrow()
    await session.load()
    expect(hasModelConsent(session.getSnapshot().state, first, ['advisor'])).toBe(false)
    expect(hasModelConsent(session.getSnapshot().state, first, ['knowledge'])).toBe(false)
    expect(session.getSnapshot().error).toContain('未能保存撤销')
    await session.grant({ baseUrl: first, scopes: ['advisor'] })
    expect(hasModelConsent(session.getSnapshot().state, first, ['advisor'])).toBe(true)
    expect(hasModelConsent(session.getSnapshot().state, first, ['knowledge'])).toBe(false)
    expect(session.getSnapshot().error).toContain('未能保存撤销')
    await session.grant({ baseUrl: first, scopes: ['knowledge'] })
    expect(hasModelConsent(session.getSnapshot().state, first, ['knowledge'])).toBe(true)
    expect(session.getSnapshot().error).toBe('')
  })
  it('global scoped revoke with unknown receivers does not deny unrelated categories', async () => {
    const session = new ModelConsentSession(
      apiMock({
        getModelConsents: async () => granted(),
        revokeModelConsent: async () => {
          throw new Error('Synthetic disk failure')
        },
      }),
    )
    await expect(session.revoke({ scopes: ['knowledge'] })).rejects.toThrow()
    await session.load()
    expect(hasModelConsent(session.getSnapshot().state, first, ['advisor'])).toBe(true)
    expect(hasModelConsent(session.getSnapshot().state, first, ['knowledge'])).toBe(false)
  })
  it('fails closed on malformed reads or unavailable optional fixture APIs', async () => {
    const session = new ModelConsentSession(
      apiMock({ getModelConsents: async () => ({ ...granted(), extra: true }) as never }),
    )
    await session.load()
    expect(session.getSnapshot().state).toBeNull()
    expect(session.getSnapshot().error).toContain('无法读取')
    const unavailable = new ModelConsentSession({} as ModelConsentApi)
    await expect(unavailable.load()).resolves.toBeUndefined()
    expect(unavailable.getSnapshot().state).toBeNull()
  })
})
