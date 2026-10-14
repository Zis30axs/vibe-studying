import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { AtomicJsonStore, readJsonFile } from './atomic-json-store'
import { protocolSchema, validateBaseUrl } from './model-transport'
import { modelNetworkSchema } from '../shared/model-network'
import { modelIdSchema } from '../shared/model-id'
import type {
  ModelConfig,
  ModelConfigInput,
  ModelProfileInput,
  ModelProfilesState,
  ModelRole,
  ModelRoleInput,
  ModelProfileDeleteInput,
} from '../shared/types'

export interface ModelSecretStorage {
  isAvailable(): boolean
  encryptString(value: string): string
  decryptString(value: string): string
}
export const modelMetadataSchema = z.strictObject({
  protocol: protocolSchema,
  baseUrl: z.string().transform(validateBaseUrl),
  network: modelNetworkSchema.default({ mode: 'direct' }),
  model: modelIdSchema,
})
export const modelKeySchema = z
  .string()
  .trim()
  .max(4096)
  .regex(/^[^\r\n]*$/)
const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)
const revisionSchema = z.number().int().nonnegative()
const storedProfileSchema = modelMetadataSchema
  .extend({
    profileId: idSchema,
    profileName: z.string().trim().min(1).max(60),
    encryptedApiKey: z.string().max(32768).optional(),
  })
  .strict()
const stateSchema = z
  .strictObject({
    version: z.literal(1),
    revision: revisionSchema,
    profiles: z.array(storedProfileSchema).min(1).max(30),
    roles: z.strictObject({ parent: idSchema, child: idSchema }),
  })
  .superRefine((value, ctx) => {
    const ids = new Set(value.profiles.map((p) => p.profileId))
    if (
      ids.size !== value.profiles.length ||
      !ids.has(value.roles.parent) ||
      !ids.has(value.roles.child)
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid profile roles' })
  })
const saveSchema = modelMetadataSchema
  .extend({
    profileId: idSchema.optional(),
    profileName: z.string().trim().min(1).max(60),
    apiKey: modelKeySchema.optional(),
    clearApiKey: z.boolean().optional(),
    persistApiKey: z.boolean(),
    expectedRevision: revisionSchema,
  })
  .strict()
const legacySchema = modelMetadataSchema.extend({ revision: revisionSchema }).strict()
const legacyInputSchema = modelMetadataSchema
  .extend({ apiKey: modelKeySchema.optional(), clearApiKey: z.boolean().optional() })
  .strict()
type StoredProfile = z.infer<typeof storedProfileSchema>
type StoredState = z.infer<typeof stateSchema>
const target = (profile: { protocol: string; baseUrl: string }) =>
  `${profile.protocol}|${profile.baseUrl}`
const stale = () => new Error('模型配置已更改，请重新打开设置并确认本次操作。')

/** Main-process vault. Only explicit public projections may cross IPC. */
export class ModelProfileStore {
  private initialization: Promise<AtomicJsonStore<StoredState>> | undefined
  private sessions = new Map<string, { key: string; target: string }>()
  constructor(
    private directory: string,
    private options: {
      apiKey?: string
      model?: string
      secureStorage?: ModelSecretStorage
    } = {},
  ) {
    if (options.apiKey?.trim())
      this.sessions.set('legacy-default', {
        key: options.apiKey.trim(),
        target: 'openai-chat|https://api.deepseek.com',
      })
  }
  private store() {
    if (this.initialization) return this.initialization
    const initialization = (async () => {
      let initial: StoredState
      try {
        initial = stateSchema.parse(await readJsonFile(join(this.directory, 'model-profiles.json')))
        // Legacy environment credentials are only an initial bootstrap. Once users save
        // profiles, explicit saved/session/cleared choices must never be overridden.
        this.sessions.delete('legacy-default')
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'))
          throw new Error('无法读取模型配置；原文件未覆盖，请恢复备份。')
        const bootstrapModel = modelIdSchema.safeParse(this.options.model)
        const legacy = await new AtomicJsonStore<z.infer<typeof legacySchema>>(
          join(this.directory, 'model-config.json'),
          legacySchema,
          () => ({
            protocol: 'openai-chat',
            baseUrl: 'https://api.deepseek.com',
            network: { mode: 'direct' },
            model: bootstrapModel.success ? bootstrapModel.data : 'deepseek-flash',
            revision: 0,
          }),
        ).load()
        initial = {
          version: 1,
          revision: legacy.revision,
          profiles: [
            {
              protocol: legacy.protocol,
              baseUrl: legacy.baseUrl,
              model: legacy.model,
              network: legacy.network,
              profileId: 'legacy-default',
              profileName: '默认配置',
            },
          ],
          roles: { parent: 'legacy-default', child: 'legacy-default' },
        }
      }
      return new AtomicJsonStore(
        join(this.directory, 'model-profiles.json'),
        stateSchema,
        () => initial,
      )
    })()
    this.initialization = initialization
    void initialization.catch(() => {
      if (this.initialization === initialization) this.initialization = undefined
    })
    return initialization
  }
  available() {
    try {
      return Boolean(this.options.secureStorage?.isAvailable())
    } catch {
      return false
    }
  }
  private secret(profile: StoredProfile): {
    key: string
    status: 'saved' | 'session' | 'missing' | 'locked'
  } {
    const session = this.sessions.get(profile.profileId)
    if (session && session.target === target(profile))
      return { key: session.key, status: 'session' }
    if (!profile.encryptedApiKey) return { key: '', status: 'missing' }
    if (!this.available()) return { key: '', status: 'locked' }
    try {
      const envelope = z
        .strictObject({
          profileId: idSchema,
          protocol: protocolSchema,
          baseUrl: z.string(),
          apiKey: modelKeySchema.min(1),
        })
        .parse(JSON.parse(this.options.secureStorage!.decryptString(profile.encryptedApiKey)))
      if (envelope.profileId !== profile.profileId || target(envelope) !== target(profile))
        throw new Error()
      return { key: envelope.apiKey, status: 'saved' }
    } catch {
      return { key: '', status: 'locked' }
    }
  }
  async getProfiles(): Promise<ModelProfilesState> {
    const state = await (await this.store()).load()
    return {
      revision: state.revision,
      roles: { ...state.roles },
      secureStorageAvailable: this.available(),
      profiles: state.profiles.map((profile) => {
        const secret = this.secret(profile)
        return {
          profileId: profile.profileId,
          profileName: profile.profileName,
          protocol: profile.protocol,
          baseUrl: profile.baseUrl,
          model: profile.model,
          network: { ...profile.network },
          revision: state.revision,
          configured: Boolean(secret.key),
          keyStatus: secret.status,
        }
      }),
    }
  }
  async getConfig(role: ModelRole = 'parent'): Promise<ModelConfig> {
    if (role !== 'parent' && role !== 'child') throw new Error('模型任务角色无效。')
    const state = await this.getProfiles()
    const p = state.profiles.find((p) => p.profileId === state.roles[role])!
    return {
      protocol: p.protocol,
      baseUrl: p.baseUrl,
      model: p.model,
      network: p.network ? { ...p.network } : { mode: 'direct' },
      revision: state.revision,
      configured: p.configured,
      profileId: p.profileId,
      profileName: p.profileName,
    }
  }
  /** Private credential resolution. Never expose this method through preload or IPC. */
  async resolve(role: ModelRole, revision: number) {
    const state = await (await this.store()).load()
    if (state.revision !== revision) throw stale()
    const profile = state.profiles.find((p) => p.profileId === state.roles[role])!
    const secret = this.secret(profile)
    if (!secret.key)
      throw new Error(
        secret.status === 'locked'
          ? '本机密钥暂时无法解锁，请检查系统密钥环或重新输入。'
          : '请先在模型设置中填写此任务配置的 API Key。',
      )
    return {
      config: {
        protocol: profile.protocol,
        baseUrl: profile.baseUrl,
        model: profile.model,
        network: { ...profile.network },
        revision: state.revision,
        configured: true,
        profileId: profile.profileId,
        profileName: profile.profileName,
      },
      key: secret.key,
    }
  }
  async diagnosticKey(input: {
    expectedRevision: number
    profileId?: string
    protocol: string
    baseUrl: string
    apiKey?: string
  }) {
    const state = await (await this.store()).load()
    if (state.revision !== input.expectedRevision) throw stale()
    if (input.apiKey) return input.apiKey
    const profile = state.profiles.find((p) => p.profileId === input.profileId)
    if (!profile || target(profile) !== target(input))
      throw new Error('请为当前接口输入 API Key；不会将其他地址的密钥发送到这里。')
    const secret = this.secret(profile)
    if (!secret.key)
      throw new Error(
        secret.status === 'locked' ? '本机密钥暂时无法解锁，请重新输入。' : '请先输入 API Key。',
      )
    return secret.key
  }
  async saveProfile(input: ModelProfileInput): Promise<ModelProfilesState> {
    let parsed: z.infer<typeof saveSchema>
    try {
      parsed = saveSchema.parse(input)
    } catch {
      throw new Error('模型配置无效，请检查名称、协议、地址、网络连接方式和模型。')
    }
    const store = await this.store()
    let sessionChange: { id: string; key?: string; target: string } | undefined
    await store.update((state) => {
      if (state.revision !== parsed.expectedRevision) throw stale()
      const previous = parsed.profileId
        ? state.profiles.find((p) => p.profileId === parsed.profileId)
        : undefined
      if (parsed.profileId && !previous) throw new Error('该配置已被删除，请重新选择。')
      if (!previous && state.profiles.length >= 30) throw new Error('最多保存 30 个模型配置。')
      if (
        state.profiles.some(
          (p) => p.profileId !== previous?.profileId && p.profileName === parsed.profileName,
        )
      )
        throw new Error('配置名称已存在，请使用不同名称。')
      const next: StoredProfile = {
        profileId: previous?.profileId ?? randomUUID(),
        profileName: parsed.profileName,
        protocol: parsed.protocol,
        baseUrl: parsed.baseUrl,
        model: parsed.model,
        network: parsed.network,
        ...(previous?.encryptedApiKey ? { encryptedApiKey: previous.encryptedApiKey } : {}),
      }
      if (!previous || target(previous) !== target(next) || parsed.clearApiKey) {
        delete next.encryptedApiKey
        sessionChange = { id: next.profileId, target: target(next) }
      }
      if (parsed.apiKey && !parsed.clearApiKey) {
        if (parsed.persistApiKey) {
          if (!this.available())
            throw new Error('系统安全存储不可用，密钥未保存。可取消本机保存，仅用于本次会话。')
          try {
            next.encryptedApiKey = this.options.secureStorage!.encryptString(
              JSON.stringify({
                profileId: next.profileId,
                protocol: next.protocol,
                baseUrl: next.baseUrl,
                apiKey: parsed.apiKey,
              }),
            )
            if (
              !next.encryptedApiKey ||
              next.encryptedApiKey === parsed.apiKey ||
              next.encryptedApiKey.length % 4 !== 0 ||
              !/^[A-Za-z0-9+/]+={0,2}$/.test(next.encryptedApiKey)
            )
              throw new Error()
          } catch {
            throw new Error('系统无法加密密钥，本次配置未保存；不会回退为明文。')
          }
          sessionChange = { id: next.profileId, target: target(next) }
        } else {
          delete next.encryptedApiKey
          sessionChange = { id: next.profileId, target: target(next), key: parsed.apiKey }
        }
      }
      return {
        ...state,
        revision: state.revision + 1,
        profiles: previous
          ? state.profiles.map((p) => (p.profileId === next.profileId ? next : p))
          : [...state.profiles, next],
      }
    })
    if (sessionChange) {
      if (sessionChange.key)
        this.sessions.set(sessionChange.id, {
          key: sessionChange.key,
          target: sessionChange.target,
        })
      else this.sessions.delete(sessionChange.id)
    }
    return this.getProfiles()
  }
  async assignProfiles(input: ModelRoleInput) {
    let parsed: ModelRoleInput
    try {
      parsed = z
        .strictObject({
          roles: z.strictObject({ parent: idSchema, child: idSchema }),
          expectedRevision: revisionSchema,
        })
        .parse(input)
    } catch {
      throw new Error('模型任务分配无效。')
    }
    await (
      await this.store()
    ).update((state) => {
      if (state.revision !== parsed.expectedRevision) throw stale()
      if (Object.values(parsed.roles).some((id) => !state.profiles.some((p) => p.profileId === id)))
        throw new Error('所选配置不存在。')
      return { ...state, revision: state.revision + 1, roles: parsed.roles }
    })
    return this.getProfiles()
  }
  async deleteProfile(input: ModelProfileDeleteInput) {
    let parsed: ModelProfileDeleteInput
    try {
      parsed = z
        .strictObject({ profileId: idSchema, expectedRevision: revisionSchema })
        .parse(input)
    } catch {
      throw new Error('要删除的模型配置无效。')
    }
    await (
      await this.store()
    ).update((state) => {
      if (state.revision !== parsed.expectedRevision) throw stale()
      if (!state.profiles.some((p) => p.profileId === parsed.profileId))
        throw new Error('该配置已被删除。')
      if (state.profiles.length === 1) throw new Error('请至少保留一个配置；可清除其中的密钥。')
      const profiles = state.profiles.filter((p) => p.profileId !== parsed.profileId)
      return {
        ...state,
        revision: state.revision + 1,
        profiles,
        roles: {
          parent:
            state.roles.parent === parsed.profileId ? profiles[0].profileId : state.roles.parent,
          child: state.roles.child === parsed.profileId ? profiles[0].profileId : state.roles.child,
        },
      }
    })
    this.sessions.delete(parsed.profileId)
    return this.getProfiles()
  }
  /** Backward-compatible session-only update of the assigned parent profile. */
  async saveConfig(input: ModelConfigInput) {
    let parsed: ModelConfigInput
    try {
      parsed = legacyInputSchema.parse(input)
    } catch {
      throw new Error('模型设置无效，请检查协议、Base URL、模型名称和 API Key。')
    }
    const state = await this.getProfiles()
    const profile = state.profiles.find((p) => p.profileId === state.roles.parent)!
    await this.saveProfile({
      ...parsed,
      profileId: profile.profileId,
      profileName: profile.profileName,
      expectedRevision: state.revision,
      persistApiKey: false,
    })
    return this.getConfig()
  }
}
