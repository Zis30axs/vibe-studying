import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelService } from '../src/adapters/model-service'
import { ModelProfileStore } from '../src/adapters/model-profile-store'
import { modelNetworkSchema } from '../src/shared/model-network'
import { osSecretStorage } from '../src/adapters/os-secret-storage'
import {
  emptyDraft,
  type AdvisorRequest,
  type GenerateGeographyRequest,
  type ModelDiagnosticInput,
  type ModelProfileInput,
  type ModelProfilesState,
  type ModuleReviewRequest,
  type Question,
} from '../src/shared/types'

// Synthetic values only. Every transport is injected, so these tests cannot call providers.
const parentKey = 'synthetic-parent-key-never-real'
const childKey = 'synthetic-child-key-never-real'
const replacementKey = 'synthetic-replacement-key-never-real'
const question: Question = {
  id: 'profile-test-question',
  subject: 'history',
  kind: 'choice',
  title: 'Synthetic routing test',
  prompt: 'Choose A.',
  source: 'Synthetic fixture',
  tags: [],
  maxScore: 1,
  explanation: 'A is correct.',
  choices: [
    { id: 'A', text: 'A' },
    { id: 'B', text: 'B' },
  ],
  correctAnswer: 'A',
}
const generated = {
  title: 'Synthetic geography test',
  prompt: 'Which direction is A from B? Explain using the diagram.',
  maxScore: 1,
  explanation: 'A is east of B.',
  rubric: [{ label: 'Direction', keywords: ['east'], points: 1 }],
  figure: {
    version: 1,
    kind: 'schematic',
    title: 'Two points',
    description: 'Right is east.',
    points: [
      { id: 'a', x: 20, y: 0, label: 'A' },
      { id: 'b', x: -20, y: 0, label: 'B' },
    ],
    segments: [],
    arrows: [],
    polylines: [],
    polygons: [],
    labels: [],
  },
}
function response(value: unknown) {
  return new Response(
    JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }],
    }),
  )
}
function secureStorage() {
  // An opaque-token mock of OS encryption, deliberately not a cryptographic implementation.
  const values = new Map<string, string>()
  return {
    isAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => {
      const ciphertext = Buffer.from(`mock-os-cipher:${randomUUID()}`).toString('base64')
      values.set(ciphertext, value)
      return ciphertext
    }),
    decryptString: vi.fn((ciphertext: string) => {
      const value = values.get(ciphertext)
      if (!value) throw new Error('Unknown mock OS ciphertext')
      return value
    }),
  }
}
const directories: string[] = []
type Options = NonNullable<ConstructorParameters<typeof ModelService>[1]>
async function setup(options: Options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'examcraft-model-profiles-'))
  directories.push(directory)
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
    throw new Error('Unexpected mocked provider call')
  })
  const defaults: Options = {
    fetchImpl,
    timeoutMs: 1000,
    resolveQuestion: (id) => (id === question.id ? question : undefined),
    listQuestions: async () => [],
    persistGenerated: async () => undefined,
    ...options,
  }
  return {
    directory,
    models: new ModelService(directory, defaults),
    restart: (overrides: Options = {}) =>
      new ModelService(directory, { ...defaults, ...overrides }),
  }
}
function profileInput(
  state: ModelProfilesState,
  overrides: Partial<ModelProfileInput> = {},
): ModelProfileInput {
  return {
    profileName: 'Synthetic parent',
    protocol: 'openai-chat',
    baseUrl: 'https://parent.vendor.com/v1',
    model: 'parent-model',
    apiKey: parentKey,
    persistApiKey: true,
    expectedRevision: state.revision,
    ...overrides,
  }
}
function editInput(
  state: ModelProfilesState,
  profileId: string,
  overrides: Partial<ModelProfileInput> = {},
): ModelProfileInput {
  const profile = state.profiles.find((item) => item.profileId === profileId)!
  return profileInput(state, {
    profileId,
    profileName: profile.profileName,
    protocol: profile.protocol,
    baseUrl: profile.baseUrl,
    model: profile.model,
    network: profile.network,
    apiKey: undefined,
    ...overrides,
  })
}
function advisorRequest(revision: number): AdvisorRequest {
  return {
    requestId: 'profile-advisor',
    questionId: question.id,
    selectedText: 'Selected evidence',
    source: 'answer',
    includeReference: false,
    cloudConsent: true,
    configRevision: revision,
  }
}
function moduleRequest(revision: number): ModuleReviewRequest {
  return {
    requestId: 'profile-modules',
    questionId: question.id,
    scope: 'selected',
    roots: [{ id: 'argument-1', kind: 'analysis', text: 'Selected argument', children: [] }],
    includeReference: false,
    cloudConsent: true,
    configRevision: revision,
  }
}
function generationRequest(revision: number): GenerateGeographyRequest {
  return {
    requestId: 'profile-generation',
    syllabus: 'Synthetic syllabus',
    chapter: 'Position',
    difficulty: '基础',
    cloudConsent: true,
    configRevision: revision,
  }
}
function diagnosticInput(
  state: ModelProfilesState,
  overrides: Partial<ModelDiagnosticInput> = {},
): ModelDiagnosticInput {
  const profile = state.profiles.find((item) => item.profileId === state.roles.parent)!
  return {
    requestId: 'profile-diagnostic',
    expectedRevision: state.revision,
    profileId: profile.profileId,
    protocol: profile.protocol,
    baseUrl: profile.baseUrl,
    model: profile.model,
    network: profile.network,
    kind: 'list',
    ...overrides,
  }
}
async function assertNoPlaintext(directory: string) {
  for (const name of await readdir(directory)) {
    const content = await readFile(join(directory, name), 'utf8')
    for (const key of [parentKey, childKey, replacementKey]) expect(content).not.toContain(key)
  }
}
async function twoProfiles(models: ModelService) {
  let state = await models.getProfiles()
  state = await models.saveProfile(profileInput(state))
  const parentId = state.profiles.find((item) => item.profileName === 'Synthetic parent')!.profileId
  state = await models.saveProfile(
    profileInput(state, {
      profileName: 'Synthetic child',
      baseUrl: 'https://child.vendor.com/v1',
      model: 'child-model',
      apiKey: childKey,
    }),
  )
  const childId = state.profiles.find((item) => item.profileName === 'Synthetic child')!.profileId
  state = await models.assignProfiles({
    expectedRevision: state.revision,
    roles: { parent: parentId, child: childId },
  })
  return { state, parentId, childId }
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('OS secret-storage adapter', () => {
  function electronStorage() {
    const encrypted = Buffer.from([0, 255, 14, 83, 92])
    return {
      isEncryptionAvailable: vi.fn(() => true),
      getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
      encryptString: vi.fn((_value: string) => encrypted),
      decryptString: vi.fn((_value: Buffer) => 'synthetic decrypted payload'),
    }
  }

  it.each(['basic_text', 'unknown', '', 'future_unrecognized_backend'])(
    'rejects Linux backend %j without invoking encryption or decryption',
    (backend) => {
      const electron = electronStorage()
      electron.getSelectedStorageBackend.mockReturnValue(backend)
      const storage = osSecretStorage(electron, 'linux')
      expect(storage.isAvailable()).toBe(false)
      expect(() => storage.encryptString(parentKey)).toThrow()
      expect(() => storage.decryptString('bW9jay1jaXBoZXI=')).toThrow()
      expect(electron.encryptString).not.toHaveBeenCalled()
      expect(electron.decryptString).not.toHaveBeenCalled()
    },
  )

  it.each(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])(
    'accepts Linux keyring %s and transfers ciphertext as base64',
    (backend) => {
      const electron = electronStorage()
      electron.getSelectedStorageBackend.mockReturnValue(backend)
      const storage = osSecretStorage(electron, 'linux')
      expect(storage.isAvailable()).toBe(true)
      const encrypted = storage.encryptString(parentKey)
      expect(encrypted).toBe(Buffer.from([0, 255, 14, 83, 92]).toString('base64'))
      expect(electron.encryptString).toHaveBeenCalledWith(parentKey)
      expect(storage.decryptString(encrypted)).toBe('synthetic decrypted payload')
      expect(electron.decryptString).toHaveBeenCalledWith(Buffer.from([0, 255, 14, 83, 92]))
    },
  )

  it.each(['darwin', 'win32'] as const)(
    'uses available platform encryption on %s without consulting Linux backend names',
    (platform) => {
      const electron = electronStorage()
      electron.getSelectedStorageBackend.mockImplementation(() => {
        throw new Error('Linux only')
      })
      const storage = osSecretStorage(electron, platform)
      expect(storage.isAvailable()).toBe(true)
      storage.encryptString(parentKey)
      expect(electron.getSelectedStorageBackend).not.toHaveBeenCalled()
    },
  )

  it('fails closed when availability changes or the OS availability check throws', () => {
    const electron = electronStorage()
    const storage = osSecretStorage(electron, 'linux')
    expect(storage.isAvailable()).toBe(true)
    electron.isEncryptionAvailable.mockReturnValue(false)
    expect(() => storage.encryptString(parentKey)).toThrow()
    expect(() => storage.decryptString('bW9jay1jaXBoZXI=')).toThrow()
    electron.isEncryptionAvailable.mockImplementation(() => {
      throw new Error('OS locked')
    })
    expect(storage.isAvailable()).toBe(false)
    expect(() => storage.encryptString(parentKey)).toThrow()
    expect(() => storage.decryptString('bW9jay1jaXBoZXI=')).toThrow()
    expect(electron.encryptString).not.toHaveBeenCalled()
    expect(electron.decryptString).not.toHaveBeenCalled()
  })
})

describe('model network configuration', () => {
  it.each(['http://127.0.0.1:80', 'http://127.0.0.1:7897/', 'http://[::1]:65535'])(
    'accepts explicit HTTP loopback proxy %s',
    (proxyUrl) => {
      expect(modelNetworkSchema.parse({ mode: 'local', proxyUrl })).toEqual({
        mode: 'local',
        proxyUrl,
      })
    },
  )

  it.each([
    'http://localhost:7897',
    'http://127.1:7897',
    'http://2130706433:7897',
    'http://0x7f000001:7897',
    'http://127.0.0.2:7897',
    'http://192.168.1.1:7897',
    'http://proxy.vendor.com:7897',
    'http://[::ffff:127.0.0.1]:7897',
    'https://127.0.0.1:7897',
    'socks5://127.0.0.1:7897',
    'http://127.0.0.1',
    'http://127.0.0.1:0',
    'http://127.0.0.1:65536',
    'http://127.0.0.1:07897',
    `http://${parentKey}@127.0.0.1:7897`,
    'http://127.0.0.1:7897/path',
    `http://127.0.0.1:7897/?key=${parentKey}`,
    `http://127.0.0.1:7897/#${parentKey}`,
    'http://127.0.0.1:7897/../',
    'http://127.0.0.1:7897\\',
    ' http://127.0.0.1:7897',
    'http://127.0.0.1:7897\n',
  ])('rejects alternate or credential-bearing proxy spelling %#', (proxyUrl) => {
    const result = modelNetworkSchema.safeParse({ mode: 'local', proxyUrl })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.message).not.toContain(parentKey)
      expect(result.error.issues[0].message).toContain('本机代理')
    }
  })

  it('rejects proxy metadata on direct/system modes and unknown network fields', () => {
    for (const mode of ['direct', 'system', 'local']) {
      expect(
        modelNetworkSchema.safeParse({
          mode,
          proxyUrl: 'http://127.0.0.1:7897',
          credentials: parentKey,
        }).success,
      ).toBe(false)
    }
  })

  it.each([true, false])(
    'persists per-profile network changes and preserves the same target key (persisted=%s)',
    async (persistApiKey) => {
      const encryption = secureStorage()
      const { models, directory, restart } = await setup({ secureStorage: encryption })
      let state = await models.saveProfile(
        profileInput(await models.getProfiles(), { persistApiKey }),
      )
      const profileId = state.profiles.find(
        (profile) => profile.profileName === 'Synthetic parent',
      )!.profileId
      state = await models.assignProfiles({
        roles: { parent: profileId, child: profileId },
        expectedRevision: state.revision,
      })
      const beforeRevision = state.revision
      const network = { mode: 'local', proxyUrl: 'http://127.0.0.1:7897' } as const
      state = await models.saveProfile(editInput(state, profileId, { network }))
      expect(state.revision).toBe(beforeRevision + 1)
      expect(state.profiles.find((profile) => profile.profileId === profileId)).toMatchObject({
        network,
        configured: true,
        keyStatus: persistApiKey ? 'saved' : 'session',
      })
      expect(await models.getConfig()).toMatchObject({ network, configured: true })
      const disk = JSON.parse(await readFile(join(directory, 'model-profiles.json'), 'utf8'))
      expect(
        disk.profiles.find((profile: { profileId: string }) => profile.profileId === profileId)
          .network,
      ).toEqual(network)
      expect(await restart().getConfig()).toMatchObject({ network, configured: persistApiKey })
      state = await models.saveProfile(editInput(state, profileId, { network: { mode: 'system' } }))
      expect(await models.getConfig()).toMatchObject({
        network: { mode: 'system' },
        configured: true,
      })
      expect(await restart().getConfig()).toMatchObject({ network: { mode: 'system' } })
      expect(JSON.stringify(state)).not.toContain(parentKey)
      await assertNoPlaintext(directory)
    },
  )

  it('loads pre-network named profiles as direct without modifying their revision or ciphertext', async () => {
    const encryption = secureStorage()
    const { models, directory, restart } = await setup({ secureStorage: encryption })
    const { state } = await twoProfiles(models)
    const file = join(directory, 'model-profiles.json')
    const disk = JSON.parse(await readFile(file, 'utf8'))
    for (const profile of disk.profiles) delete profile.network
    await writeFile(file, JSON.stringify(disk))
    const restored = await restart().getProfiles()
    expect(restored.revision).toBe(state.revision)
    expect(restored.profiles.every((profile) => profile.network?.mode === 'direct')).toBe(true)
    expect(restored.profiles.filter((profile) => profile.keyStatus === 'saved')).toHaveLength(2)
  })

  it('fails closed on invalid stored or submitted proxy data without overwriting the profile file', async () => {
    const { directory } = await setup()
    const store = new ModelProfileStore(directory)
    const state = await store.saveProfile(
      profileInput(await store.getProfiles(), { persistApiKey: false }),
    )
    const file = join(directory, 'model-profiles.json')
    const before = await readFile(file, 'utf8')
    await expect(
      store.saveProfile(
        profileInput(state, {
          persistApiKey: false,
          network: { mode: 'local', proxyUrl: `http://${parentKey}@127.0.0.1:7897` },
        }),
      ),
    ).rejects.toThrow('模型配置无效')
    expect(await readFile(file, 'utf8')).toBe(before)
    const corrupt = JSON.parse(before)
    corrupt.profiles[0].network = { mode: 'local', proxyUrl: 'http://192.168.1.1:7897' }
    await writeFile(file, JSON.stringify(corrupt))
    await expect(new ModelProfileStore(directory).getProfiles()).rejects.toThrow('原文件未覆盖')
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(corrupt)
  })
})

describe('named model profiles: encrypted persistence and public projection', () => {
  it('restores a local endpoint and a provider model name containing Chinese and ordinary symbols', async () => {
    const encryption = secureStorage()
    const { models, directory, restart } = await setup({ secureStorage: encryption })
    const model = 'agy-抗截断-gemini-3.8-flash-low + search'
    let state = await models.saveProfile(
      profileInput(await models.getProfiles(), {
        baseUrl: 'http://localhost:11434/v1/',
        model,
      }),
    )
    const profile = state.profiles.find((item) => item.model === model)!
    state = await models.assignProfiles({
      expectedRevision: state.revision,
      roles: { parent: profile.profileId, child: profile.profileId },
    })
    const restored = restart()
    expect(await restored.getConfig()).toMatchObject({
      baseUrl: 'http://localhost:11434/v1',
      model,
      configured: true,
    })
    // Native-tool calls must accept the same saved ID as model discovery and JSON tasks.
    await expect(restored.agentTransport(state.revision)).resolves.toHaveProperty('transport')
    await assertNoPlaintext(directory)
  })

  it('migrates legacy non-secret metadata to a stable default without inventing a key', async () => {
    const { models, directory, restart } = await setup()
    await writeFile(
      join(directory, 'model-config.json'),
      JSON.stringify({
        protocol: 'openai-chat',
        baseUrl: 'https://legacy.vendor.com/v1',
        model: 'legacy-model',
        revision: 7,
      }),
    )
    const state = await models.getProfiles()
    expect(state.profiles).toHaveLength(1)
    expect(state.profiles[0]).toMatchObject({
      profileId: 'legacy-default',
      protocol: 'openai-chat',
      baseUrl: 'https://legacy.vendor.com/v1',
      model: 'legacy-model',
      configured: false,
      keyStatus: 'missing',
      network: { mode: 'direct' },
    })
    expect(state.roles).toEqual({ parent: 'legacy-default', child: 'legacy-default' })
    expect(state.revision).toBeGreaterThanOrEqual(7)
    expect(await restart().getProfiles()).toEqual(state)
  })

  it('restores encrypted keys and role assignments after restart without exposing raw keys or ciphertext', async () => {
    const encryption = secureStorage()
    const { models, directory, restart } = await setup({ secureStorage: encryption })
    const { state, parentId, childId } = await twoProfiles(models)
    expect(parentId).not.toBe(childId)
    expect(state.secureStorageAvailable).toBe(true)
    const disk = await readFile(join(directory, 'model-profiles.json'), 'utf8')
    const ciphertexts = encryption.encryptString.mock.results.map((item) => item.value as string)
    expect(ciphertexts).toHaveLength(2)
    for (const ciphertext of ciphertexts) expect(disk).toContain(ciphertext)
    await assertNoPlaintext(directory)

    const restored = restart()
    const restoredState = await restored.getProfiles()
    expect(restoredState).toEqual(state)
    expect(
      restoredState.profiles.filter((item) => item.configured).map((item) => item.keyStatus),
    ).toEqual(['saved', 'saved'])
    const projections = JSON.stringify([
      state,
      restoredState,
      await restored.getConfig(),
      await restored.getConfig('parent'),
      await restored.getConfig('child'),
    ])
    for (const secret of [parentKey, childKey, ...ciphertexts])
      expect(projections).not.toContain(secret)
    expect(await restored.getConfig()).toMatchObject({
      profileId: parentId,
      model: 'parent-model',
      configured: true,
      revision: state.revision,
    })
    expect(await restored.getConfig('child')).toMatchObject({
      profileId: childId,
      model: 'child-model',
      configured: true,
      revision: state.revision,
    })
    expect(encryption.decryptString).toHaveBeenCalled()
  })

  it('keeps explicit session keys usable only until restart, even when encryption is available', async () => {
    const encryption = secureStorage()
    const { models, directory, restart } = await setup({ secureStorage: encryption })
    const initial = await models.getProfiles()
    const state = await models.saveProfile(profileInput(initial, { persistApiKey: false }))
    const profile = state.profiles.find((item) => item.profileName === 'Synthetic parent')!
    expect(profile).toMatchObject({ configured: true, keyStatus: 'session' })
    expect(encryption.encryptString).not.toHaveBeenCalled()
    expect(
      (await restart().getProfiles()).profiles.find((item) => item.profileId === profile.profileId),
    ).toMatchObject({ configured: false, keyStatus: 'missing' })
    await assertNoPlaintext(directory)
  })

  it('never persists a legacy saveConfig key and replaces a saved key with an explicit session key', async () => {
    const encryption = secureStorage()
    const { models, directory, restart } = await setup({ secureStorage: encryption })
    const { state, parentId } = await twoProfiles(models)
    const session = await models.saveProfile(
      editInput(state, parentId, { apiKey: replacementKey, persistApiKey: false }),
    )
    expect(session.profiles.find((item) => item.profileId === parentId)?.keyStatus).toBe('session')
    expect(
      (await restart().getProfiles()).profiles.find((item) => item.profileId === parentId)
        ?.keyStatus,
    ).toBe('missing')
    await models.saveConfig({
      protocol: 'openai-chat',
      baseUrl: 'https://parent.vendor.com/v1',
      model: 'legacy-session',
      apiKey: parentKey,
    })
    expect((await models.getConfig()).configured).toBe(true)
    expect((await restart().getConfig()).configured).toBe(false)
    await assertNoPlaintext(directory)
  })

  it.each(['unavailable', 'encrypt-failure'] as const)(
    'fails closed for %s storage without changing metadata or falling back to plaintext',
    async (mode) => {
      const encryption = secureStorage()
      const { models, directory } = await setup({ secureStorage: encryption })
      const { state, parentId } = await twoProfiles(models)
      const beforeDisk = await readFile(join(directory, 'model-profiles.json'), 'utf8')
      if (mode === 'unavailable') encryption.isAvailable.mockReturnValue(false)
      else
        encryption.encryptString.mockImplementation(() => {
          throw new Error(`OS failure: ${replacementKey}`)
        })
      const error = await models
        .saveProfile(
          editInput(state, parentId, {
            profileName: 'Must not commit',
            apiKey: replacementKey,
          }),
        )
        .catch((error: unknown) => error)
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).not.toContain(replacementKey)
      expect(await readFile(join(directory, 'model-profiles.json'), 'utf8')).toBe(beforeDisk)
      const after = await models.getProfiles()
      expect(after.revision).toBe(state.revision)
      expect(after.profiles.find((item) => item.profileId === parentId)?.profileName).toBe(
        'Synthetic parent',
      )
      await assertNoPlaintext(directory)
    },
  )

  it('permits an explicit session key when OS encryption is unavailable', async () => {
    const encryption = secureStorage()
    encryption.isAvailable.mockReturnValue(false)
    const { models, directory } = await setup({ secureStorage: encryption })
    const state = await models.saveProfile(
      profileInput(await models.getProfiles(), { persistApiKey: false }),
    )
    expect(state.secureStorageAvailable).toBe(false)
    expect(state.profiles.find((item) => item.profileName === 'Synthetic parent')).toMatchObject({
      configured: true,
      keyStatus: 'session',
    })
    expect(encryption.encryptString).not.toHaveBeenCalled()
    await assertNoPlaintext(directory)
  })

  it.each(['unavailable', 'decrypt-failure'] as const)(
    'retains locked ciphertext on %s and does not silently replace it',
    async (mode) => {
      const encryption = secureStorage()
      const fetcher = vi.fn<typeof fetch>()
      const { models, directory, restart } = await setup({
        secureStorage: encryption,
        fetchImpl: fetcher,
      })
      const { state, parentId } = await twoProfiles(models)
      const disk = await readFile(join(directory, 'model-profiles.json'), 'utf8')
      const lockedStorage = {
        ...encryption,
        isAvailable: vi.fn(() => mode !== 'unavailable'),
        decryptString: vi.fn(() => {
          throw new Error(`Cannot unlock ${parentKey}`)
        }),
      }
      const locked = restart({ secureStorage: lockedStorage })
      const profiles = await locked.getProfiles()
      expect(profiles.profiles.find((item) => item.profileId === parentId)).toMatchObject({
        keyStatus: 'locked',
        configured: false,
      })
      expect(await locked.getConfig()).toMatchObject({ configured: false, profileId: parentId })
      const error = await locked.reviewer(state.revision).catch((error: unknown) => error)
      expect(error).toBeInstanceOf(Error)
      expect(String(error)).not.toContain(parentKey)
      expect(fetcher).not.toHaveBeenCalled()
      expect(await readFile(join(directory, 'model-profiles.json'), 'utf8')).toBe(disk)
      expect(
        (await restart().getProfiles()).profiles.find((item) => item.profileId === parentId)
          ?.keyStatus,
      ).toBe('saved')
    },
  )

  it.each(['profile-copy', 'destination', 'protocol'] as const)(
    'refuses encrypted keys copied or rebound on disk: %s',
    async (tamper) => {
      const fetcher = vi.fn<typeof fetch>()
      const { models, directory, restart } = await setup({
        secureStorage: secureStorage(),
        fetchImpl: fetcher,
      })
      let { state, parentId, childId } = await twoProfiles(models)
      // Use the same destination to make the profile-copy case check profile identity itself.
      state = await models.saveProfile(
        editInput(state, childId, {
          baseUrl: 'https://parent.vendor.com/v1',
          apiKey: childKey,
        }),
      )
      const path = join(directory, 'model-profiles.json')
      const disk = JSON.parse(await readFile(path, 'utf8'))
      const parent = disk.profiles.find(
        (item: { profileId: string }) => item.profileId === parentId,
      )
      const child = disk.profiles.find((item: { profileId: string }) => item.profileId === childId)
      if (tamper === 'profile-copy') parent.encryptedApiKey = child.encryptedApiKey
      if (tamper === 'destination') parent.baseUrl = 'https://changed.vendor.com/v1'
      if (tamper === 'protocol') parent.protocol = 'anthropic'
      await writeFile(path, JSON.stringify(disk))
      const restored = restart()
      expect(
        (await restored.getProfiles()).profiles.find((item) => item.profileId === parentId),
      ).toMatchObject({ configured: false, keyStatus: 'locked' })
      await expect(restored.reviewer(state.revision)).rejects.toThrow()
      expect(fetcher).not.toHaveBeenCalled()
      await assertNoPlaintext(directory)
    },
  )

  it('rejects a broken encryption adapter returning plaintext without saving or leaking it', async () => {
    const encryption = secureStorage()
    encryption.encryptString.mockImplementation((value) => value)
    const { models, directory } = await setup({ secureStorage: encryption })
    const before = await models.getProfiles()
    const error = await models.saveProfile(profileInput(before)).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toContain(parentKey)
    expect(await models.getProfiles()).toEqual(before)
    await assertNoPlaintext(directory)
  })

  it('keeps an environment-provided legacy key session-only and destination-bound', async () => {
    const encryption = secureStorage()
    const { models, directory, restart } = await setup({
      secureStorage: encryption,
      apiKey: parentKey,
    })
    let state = await models.getProfiles()
    expect(state.profiles[0]).toMatchObject({ keyStatus: 'session', configured: true })
    expect(encryption.encryptString).not.toHaveBeenCalled()
    state = await models.saveProfile(
      editInput(state, state.roles.parent, {
        baseUrl: 'https://changed.vendor.com/v1',
      }),
    )
    expect((await models.getConfig()).configured).toBe(false)
    expect((await restart().getConfig()).configured).toBe(false)
    expect((await restart({ apiKey: undefined }).getProfiles()).profiles[0].keyStatus).toBe(
      'missing',
    )
    await assertNoPlaintext(directory)
  })
})

describe('named model profiles: updates, revision safety and deletion', () => {
  it('preserves omitted or blank keys and same-destination model edits without re-encryption', async () => {
    const encryption = secureStorage()
    const { models, restart } = await setup({ secureStorage: encryption })
    let { state, parentId } = await twoProfiles(models)
    const count = encryption.encryptString.mock.calls.length
    for (const apiKey of [undefined, '']) {
      state = await models.saveProfile(
        editInput(state, parentId, {
          profileName: 'Renamed',
          model: 'new-model',
          apiKey,
          persistApiKey: false,
        }),
      )
      expect(state.profiles.find((item) => item.profileId === parentId)).toMatchObject({
        keyStatus: 'saved',
        configured: true,
        model: 'new-model',
      })
    }
    expect(encryption.encryptString).toHaveBeenCalledTimes(count)
    expect((await restart().getConfig()).configured).toBe(true)
  })

  it.each([
    { baseUrl: 'https://new.vendor.com/v1' },
    { protocol: 'anthropic' as const },
    { clearApiKey: true },
    { clearApiKey: true, apiKey: replacementKey },
  ])('clears a credential on destination change or explicit clear: %j', async (change) => {
    const encryption = secureStorage()
    const { models, directory, restart } = await setup({ secureStorage: encryption })
    const { state, parentId, childId } = await twoProfiles(models)
    const next = await models.saveProfile(editInput(state, parentId, change))
    expect(next.profiles.find((item) => item.profileId === parentId)).toMatchObject({
      configured: false,
      keyStatus: 'missing',
    })
    expect(next.profiles.find((item) => item.profileId === childId)).toMatchObject({
      configured: true,
      keyStatus: 'saved',
    })
    expect((await restart().getConfig()).configured).toBe(false)
    await assertNoPlaintext(directory)
  })

  it('accepts only one concurrent write with the same expected revision and rejects stale deletes/assignments', async () => {
    const { models, directory } = await setup({ secureStorage: secureStorage() })
    const initial = await models.getProfiles()
    const results = await Promise.allSettled([
      models.saveProfile(profileInput(initial, { profileName: 'Concurrent A' })),
      models.saveProfile(profileInput(initial, { profileName: 'Concurrent B' })),
    ])
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((item) => item.status === 'rejected')).toHaveLength(1)
    const current = await models.getProfiles()
    expect(current.revision).toBe(initial.revision + 1)
    expect(current.profiles).toHaveLength(initial.profiles.length + 1)
    const currentDisk = await readFile(join(directory, 'model-profiles.json'), 'utf8')
    await expect(
      models.assignProfiles({ roles: initial.roles, expectedRevision: initial.revision }),
    ).rejects.toThrow()
    await expect(
      models.deleteProfile({ profileId: initial.roles.parent, expectedRevision: initial.revision }),
    ).rejects.toThrow()
    expect(await models.getProfiles()).toEqual(current)
    expect(await readFile(join(directory, 'model-profiles.json'), 'utf8')).toBe(currentDisk)
  })

  it('atomically reassigns deleted roles, persists the replacement, and refuses the last deletion', async () => {
    const { models, restart } = await setup({ secureStorage: secureStorage() })
    let { state, parentId, childId } = await twoProfiles(models)
    state = await models.assignProfiles({
      expectedRevision: state.revision,
      roles: { parent: parentId, child: parentId },
    })
    const replacement = state.profiles.find((item) => item.profileId !== parentId)!.profileId
    const revision = state.revision
    state = await models.deleteProfile({ profileId: parentId, expectedRevision: state.revision })
    expect(state.revision).toBe(revision + 1)
    expect(state.profiles.some((item) => item.profileId === parentId)).toBe(false)
    expect(state.roles).toEqual({ parent: replacement, child: replacement })
    expect(await restart().getProfiles()).toEqual(state)
    state = await models.deleteProfile({ profileId: childId, expectedRevision: state.revision })
    expect(state.profiles).toHaveLength(1)
    await expect(
      models.deleteProfile({
        profileId: state.profiles[0].profileId,
        expectedRevision: state.revision,
      }),
    ).rejects.toThrow()
    expect(await models.getProfiles()).toEqual(state)
  })

  it('rejects assignments to unknown IDs without changing either role', async () => {
    const { models } = await setup({ secureStorage: secureStorage() })
    const { state, parentId } = await twoProfiles(models)
    await expect(
      models.assignProfiles({
        expectedRevision: state.revision,
        roles: { parent: parentId, child: 'missing-profile' },
      }),
    ).rejects.toThrow()
    expect(await models.getProfiles()).toEqual(state)
  })
})

describe('named model profiles: role routing and cancellation', () => {
  it('routes grading and generation to parent, advisor and module checks to child after restart', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({ feedback: 'Correct.', explanation: 'A is correct.', rubric: [] }),
      )
      .mockResolvedValueOnce(response(generated))
      .mockResolvedValueOnce(response({ hint: 'Which evidence supports this?' }))
      .mockResolvedValueOnce(
        response({ summary: 'No material issues.', confirmations: [], suggestions: [] }),
      )
    const { models, restart } = await setup({ secureStorage: secureStorage(), fetchImpl: fetcher })
    const { state } = await twoProfiles(models)
    const restored = restart()
    const reviewer = await restored.reviewer(state.revision)
    await reviewer.review(question, { ...emptyDraft(), choiceId: 'A' })
    await restored.generateGeographyQuestion(generationRequest(state.revision))
    await restored.askAdvisor(advisorRequest(state.revision))
    await restored.reviewModules(moduleRequest(state.revision))
    expect(fetcher).toHaveBeenCalledTimes(4)
    for (const [index, [url, init]] of fetcher.mock.calls.entries()) {
      const isParent = index < 2
      expect(url).toBe(`https://${isParent ? 'parent' : 'child'}.vendor.com/v1/chat/completions`)
      expect(init?.headers).toHaveProperty(
        'Authorization',
        `Bearer ${isParent ? parentKey : childKey}`,
      )
      const body = JSON.parse(String(init?.body))
      expect(body.model).toBe(isParent ? 'parent-model' : 'child-model')
      for (const key of [parentKey, childKey]) expect(JSON.stringify(body)).not.toContain(key)
    }
  })

  it.each(['save', 'network', 'assign', 'delete'] as const)(
    'invalidates old consent across both roles after %s',
    async (mutation) => {
      const fetcher = vi.fn<typeof fetch>()
      const { models } = await setup({ secureStorage: secureStorage(), fetchImpl: fetcher })
      const { state, parentId, childId } = await twoProfiles(models)
      const previouslyCreatedReviewer = await models.reviewer(state.revision)
      if (mutation === 'save')
        await models.saveProfile(editInput(state, childId, { profileName: 'Renamed child' }))
      if (mutation === 'network')
        await models.saveProfile(editInput(state, parentId, { network: { mode: 'system' } }))
      if (mutation === 'assign')
        await models.assignProfiles({
          expectedRevision: state.revision,
          roles: { parent: childId, child: parentId },
        })
      if (mutation === 'delete')
        await models.deleteProfile({ expectedRevision: state.revision, profileId: childId })
      await expect(models.reviewer(state.revision)).rejects.toThrow()
      await expect(
        previouslyCreatedReviewer.review(question, { ...emptyDraft(), choiceId: 'A' }),
      ).rejects.toThrow()
      await expect(models.askAdvisor(advisorRequest(state.revision))).rejects.toThrow()
      await expect(models.reviewModules(moduleRequest(state.revision))).rejects.toThrow()
      await expect(
        models.generateGeographyQuestion(generationRequest(state.revision)),
      ).rejects.toThrow()
      expect(fetcher).not.toHaveBeenCalled()
    },
  )

  it.each(['save', 'network', 'assign', 'delete'] as const)(
    'aborts all running grading, advisor, module and generation calls on %s',
    async (mutation) => {
      const signals: AbortSignal[] = []
      const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
        signals.push(init!.signal!)
        return new Promise<Response>(() => {})
      })
      const { models } = await setup({ secureStorage: secureStorage(), fetchImpl: fetcher })
      const { state, parentId, childId } = await twoProfiles(models)
      const reviewer = await models.reviewer(state.revision)
      const pending = Promise.allSettled([
        models.askAdvisor(advisorRequest(state.revision)),
        models.reviewModules(moduleRequest(state.revision)),
        models.generateGeographyQuestion(generationRequest(state.revision)),
        reviewer.review(question, { ...emptyDraft(), choiceId: 'A' }),
      ])
      await vi.waitFor(() => expect(signals).toHaveLength(4))
      if (mutation === 'save')
        await models.saveProfile(editInput(state, childId, { profileName: 'Renamed child' }))
      if (mutation === 'network')
        await models.saveProfile(editInput(state, parentId, { network: { mode: 'system' } }))
      if (mutation === 'assign')
        await models.assignProfiles({
          expectedRevision: state.revision,
          roles: { parent: childId, child: parentId },
        })
      if (mutation === 'delete')
        await models.deleteProfile({ expectedRevision: state.revision, profileId: childId })
      const results = await pending
      expect(signals.every((signal) => signal.aborted)).toBe(true)
      expect(results.every((item) => item.status === 'rejected')).toBe(true)
      expect(models.getGenerationStatus().pending).toBe(0)
    },
  )

  it.each(['advisor', 'modules'] as const)(
    'does not dispatch stale %s credentials after a delayed local question resolution',
    async (kind) => {
      let release!: (question: Question) => void
      const resolving = new Promise<Question>((resolve) => {
        release = resolve
      })
      const resolver = vi.fn(() => resolving)
      const fetcher = vi.fn<typeof fetch>()
      const { models } = await setup({
        secureStorage: secureStorage(),
        fetchImpl: fetcher,
        resolveQuestion: resolver,
      })
      const { state, parentId, childId } = await twoProfiles(models)
      const pending = (
        kind === 'advisor'
          ? models.askAdvisor(advisorRequest(state.revision))
          : models.reviewModules(moduleRequest(state.revision))
      ).then(
        () => 'unexpected-success',
        (error: unknown) => error,
      )
      await vi.waitFor(() => expect(resolver).toHaveBeenCalled())
      await models.assignProfiles({
        expectedRevision: state.revision,
        roles: { parent: childId, child: parentId },
      })
      release(question)
      expect(await pending).toBeInstanceOf(Error)
      expect(fetcher).not.toHaveBeenCalled()
    },
  )
})

describe('model diagnostics through the main-process profile boundary', () => {
  it('lists models before selection using the saved exact-destination key after restart', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: 'available-model', display_name: 'Available model' }],
        }),
      ),
    )
    const { models, directory, restart } = await setup({
      secureStorage: secureStorage(),
      fetchImpl: fetcher,
    })
    const { state } = await twoProfiles(models)
    const before = await readFile(join(directory, 'model-profiles.json'), 'utf8')
    const restored = restart()
    const result = await restored.diagnoseModel(diagnosticInput(state, { model: '' }))
    expect(result).toEqual({ models: [{ id: 'available-model', name: 'Available model' }] })
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, init] = fetcher.mock.calls[0]
    expect(url).toBe('https://parent.vendor.com/v1/models')
    expect(init?.method).toBe('GET')
    expect(init?.body).toBeUndefined()
    expect(init?.headers).toHaveProperty('Authorization', `Bearer ${parentKey}`)
    expect(JSON.stringify([url, result])).not.toContain(parentKey)
    expect(await restored.getProfiles()).toEqual(state)
    expect(await readFile(join(directory, 'model-profiles.json'), 'utf8')).toBe(before)
  })

  it('tests an unsaved key at its explicitly supplied destination without altering saved profiles', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: 'OK' } }],
        }),
      ),
    )
    const encryption = secureStorage()
    const { models, directory, restart } = await setup({
      secureStorage: encryption,
      fetchImpl: fetcher,
    })
    const { state } = await twoProfiles(models)
    const before = await readFile(join(directory, 'model-profiles.json'), 'utf8')
    const encryptCount = encryption.encryptString.mock.calls.length
    const result = await models.diagnoseModel(
      diagnosticInput(state, {
        profileId: undefined,
        kind: 'test',
        baseUrl: 'https://unsaved.vendor.com/v1',
        model: 'unsaved-model',
        apiKey: replacementKey,
      }),
    )
    expect(result.error).toBeUndefined()
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    const [url, init] = fetcher.mock.calls[0]
    expect(url).toBe('https://unsaved.vendor.com/v1/chat/completions')
    expect(init?.headers).toHaveProperty('Authorization', `Bearer ${replacementKey}`)
    expect(JSON.parse(String(init?.body)).model).toBe('unsaved-model')
    expect(JSON.stringify([url, init?.body, result])).not.toContain(replacementKey)
    expect(encryption.encryptString).toHaveBeenCalledTimes(encryptCount)
    expect(await models.getProfiles()).toEqual(state)
    expect(await restart().getProfiles()).toEqual(state)
    expect(await readFile(join(directory, 'model-profiles.json'), 'utf8')).toBe(before)
    await assertNoPlaintext(directory)
  })

  it.each([
    { baseUrl: 'https://different.vendor.com/v1' },
    { protocol: 'anthropic' as const },
    { profileId: 'not-a-saved-profile' },
    { profileId: undefined },
  ])('refuses implicit saved-key reuse outside its profile and destination: %j', async (change) => {
    const fetcher = vi.fn<typeof fetch>()
    const { models } = await setup({ secureStorage: secureStorage(), fetchImpl: fetcher })
    const { state } = await twoProfiles(models)
    await expect(models.diagnoseModel(diagnosticInput(state, change))).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
    expect(await models.getProfiles()).toEqual(state)
  })

  it('rejects stale revision before resolving or transmitting diagnostic credentials', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const { models } = await setup({ secureStorage: secureStorage(), fetchImpl: fetcher })
    const { state } = await twoProfiles(models)
    await expect(
      models.diagnoseModel(
        diagnosticInput(state, {
          expectedRevision: state.revision - 1,
          apiKey: replacementKey,
        }),
      ),
    ).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each(['provider-error', 'credential-echo'] as const)(
    'returns a renderer-safe diagnostic error for %s',
    async (mode) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          mode === 'provider-error'
            ? new Response(`Upstream debug ${parentKey}`, { status: 401 })
            : new Response(JSON.stringify({ data: [{ id: parentKey }] })),
        )
      const { models } = await setup({ secureStorage: secureStorage(), fetchImpl: fetcher })
      const { state } = await twoProfiles(models)
      const result = await models.diagnoseModel(diagnosticInput(state))
      expect(result).toMatchObject({
        error: {
          code: mode === 'provider-error' ? 'auth' : 'invalid_response',
          message: expect.any(String),
        },
      })
      expect(result.models).toBeUndefined()
      expect(result.latencyMs).toBeUndefined()
      expect(JSON.stringify(result)).not.toContain(parentKey)
      expect(JSON.stringify(result)).not.toContain('Upstream debug')
    },
  )

  it.each(['save', 'network', 'assign', 'delete'] as const)(
    'cancels an in-flight diagnostic after %s without publishing models',
    async (mutation) => {
      let signal: AbortSignal | undefined
      const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
        signal = init!.signal!
        return new Promise<Response>(() => {})
      })
      const { models } = await setup({ secureStorage: secureStorage(), fetchImpl: fetcher })
      const { state, parentId, childId } = await twoProfiles(models)
      const pending = models.diagnoseModel(diagnosticInput(state))
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
      if (mutation === 'save')
        await models.saveProfile(editInput(state, childId, { profileName: 'Changed child' }))
      if (mutation === 'network')
        await models.saveProfile(editInput(state, parentId, { network: { mode: 'system' } }))
      if (mutation === 'assign')
        await models.assignProfiles({
          expectedRevision: state.revision,
          roles: { parent: childId, child: parentId },
        })
      if (mutation === 'delete')
        await models.deleteProfile({ expectedRevision: state.revision, profileId: childId })
      const result = await pending
      expect(signal?.aborted).toBe(true)
      expect(result).toMatchObject({ error: { code: 'cancelled' } })
      expect(result.models).toBeUndefined()
      expect(result.latencyMs).toBeUndefined()
    },
  )

  it('rejects repeated active diagnostics, hides late cancelled results, and allows a fresh retry', async () => {
    let release!: (response: Response) => void
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve
          }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'fresh-model' }] })))
    const { models } = await setup({ secureStorage: secureStorage(), fetchImpl: fetcher })
    const { state } = await twoProfiles(models)
    const input = diagnosticInput(state)
    const pending = models.diagnoseModel(input)
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    await expect(models.diagnoseModel(input)).rejects.toThrow()
    await expect(
      models.diagnoseModel({ ...input, requestId: 'another-diagnostic' }),
    ).rejects.toThrow()
    models.cancelModelDiagnostic(input.requestId)
    const cancelled = await pending
    release(new Response(JSON.stringify({ data: [{ id: 'stale-model' }] })))
    expect(cancelled).toMatchObject({ error: { code: 'cancelled' } })
    expect(cancelled.models).toBeUndefined()
    expect(await models.diagnoseModel(input)).toEqual({ models: [{ id: 'fresh-model' }] })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})

describe('profile recovery and legacy environment precedence', () => {
  it('can reload a repaired vault without restarting the same service instance', async () => {
    const { directory, models } = await setup()
    await writeFile(join(directory, 'model-profiles.json'), '{broken')
    await expect(models.getProfiles()).rejects.toThrow()
    await writeFile(
      join(directory, 'model-profiles.json'),
      JSON.stringify({
        version: 1,
        revision: 7,
        profiles: [
          {
            profileId: 'repaired',
            profileName: 'Repaired',
            protocol: 'openai-chat',
            baseUrl: 'https://api.deepseek.com',
            model: 'test',
          },
        ],
        roles: { parent: 'repaired', child: 'repaired' },
      }),
    )
    expect(await models.getProfiles()).toMatchObject({
      revision: 7,
      profiles: [{ profileId: 'repaired', configured: false }],
    })
  })
  it('never replaces an explicitly saved or locked key with a startup environment key', async () => {
    const storage = secureStorage()
    const { models, restart } = await setup({ apiKey: parentKey, secureStorage: storage })
    let state = await models.getProfiles()
    expect(state.profiles[0].keyStatus).toBe('session')
    state = await models.saveProfile(
      editInput(state, 'legacy-default', { apiKey: replacementKey, persistApiKey: true }),
    )
    expect((await restart().getProfiles()).profiles[0]).toMatchObject({
      keyStatus: 'saved',
      configured: true,
    })
    storage.isAvailable.mockReturnValue(false)
    expect((await restart().getProfiles()).profiles[0]).toMatchObject({
      keyStatus: 'locked',
      configured: false,
    })
  })
  it('does not resurrect an explicitly cleared legacy environment key after restart', async () => {
    const { models, restart } = await setup({ apiKey: parentKey })
    const state = await models.getProfiles()
    await models.saveProfile(
      editInput(state, 'legacy-default', {
        apiKey: undefined,
        clearApiKey: true,
        persistApiKey: false,
      }),
    )
    expect((await restart().getProfiles()).profiles[0]).toMatchObject({
      keyStatus: 'missing',
      configured: false,
    })
  })
})

it('correlates sanitized task schema diagnostics without retaining advisor/module/generation payloads', async () => {
  const secretText = 'synthetic-private-answer-marker'
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => response({ unexpected: secretText }))
  const { models } = await setup({ fetchImpl })
  const config = await models.saveConfig({
    protocol: 'openai-chat',
    baseUrl: 'https://api.deepseek.com',
    model: 'synthetic-model',
    apiKey: parentKey,
  })
  models.setModelDebugEnabled(true)
  await expect(
    models.askAdvisor({
      requestId: 'debug-advisor',
      selectedText: secretText,
      source: 'answer',
      questionId: question.id,
      includeReference: false,
      cloudConsent: true,
      configRevision: config.revision,
    }),
  ).rejects.toThrow()
  const logs = models.getModelDebug()
  const schema = logs.records.find((record) => record.stage === 'schema')
  expect(schema).toBeDefined()
  expect(
    logs.records.some(
      (record) => record.stage === 'json' && record.requestId === schema!.requestId,
    ),
  ).toBe(true)
  expect(JSON.stringify(logs)).not.toContain(parentKey)
  expect(JSON.stringify(logs)).not.toContain(secretText)
  expect(models.modelDebugText()).not.toContain(secretText)
  models.setModelDebugEnabled(false)
  expect(models.getModelDebug().records).toEqual([])
})

it('accepts opaque OS ciphertext even when its base64 alphabet coincidentally includes a short key', async () => {
  const storage = secureStorage()
  let envelope = ''
  storage.encryptString.mockImplementation((value) => {
    envelope = value
    return 'aaaa'
  })
  storage.decryptString.mockImplementation(() => envelope)
  const { models } = await setup({ secureStorage: storage })
  const state = await models.getProfiles()
  const next = await models.saveProfile(profileInput(state, { apiKey: 'a' }))
  expect(next.profiles.find((profile) => profile.profileName === 'Synthetic parent')).toMatchObject(
    { configured: true, keyStatus: 'saved' },
  )
})

it('records safe model-list and connection diagnostics only when Debug is enabled', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValue(
      Object.assign(new Error(parentKey), { code: 'ENOTFOUND', hostname: parentKey }),
    )
  const { models } = await setup({ secureStorage: secureStorage(), fetchImpl: fetcher })
  const { state } = await twoProfiles(models)
  const result = await models.diagnoseModel(diagnosticInput(state, { model: '' }))
  expect(result).toMatchObject({
    error: { code: 'dns', details: { stage: 'dns', networkCode: 'ENOTFOUND' } },
  })
  expect(models.getModelDebug().records).toEqual([])
  models.setModelDebugEnabled(true)
  await models.diagnoseModel(diagnosticInput(state, { model: '' }))
  expect(models.getModelDebug().records).toMatchObject([
    {
      operation: 'model_list',
      stage: 'request',
      category: 'network',
      connection: { stage: 'dns', networkCode: 'ENOTFOUND' },
    },
  ])
  fetcher.mockResolvedValueOnce(new Response(parentKey, { status: 503 }))
  await models.diagnoseModel(diagnosticInput(state, { kind: 'test' }))
  expect(models.getModelDebug().records[1]).toMatchObject({
    operation: 'connection_test',
    stage: 'http',
    category: 'http',
    httpStatus: 503,
  })
  expect(models.modelDebugText()).not.toContain(parentKey)
  expect(models.modelDebugText()).not.toContain('vendor.com')
  models.setModelDebugEnabled(false)
  expect(models.getModelDebug().records).toEqual([])
})
