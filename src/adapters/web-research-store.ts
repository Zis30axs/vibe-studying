import { join } from 'node:path'
import { z } from 'zod'
import { AtomicJsonStore } from './atomic-json-store'
import type { ModelSecretStorage } from './model-profile-store'
import {
  WEB_RESEARCH_ENDPOINT,
  type WebResearchConfig,
  type WebResearchConfigInput,
} from '../shared/web-research'

export const webResearchKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .regex(/^[A-Za-z0-9_.-]+$/)
const revisionSchema = z.number().int().nonnegative()
const stateSchema = z.strictObject({
  version: z.literal(1),
  provider: z.literal('tavily'),
  revision: revisionSchema,
  encryptedApiKey: z.string().max(32768).optional(),
})
const inputSchema = z.strictObject({
  provider: z.literal('tavily'),
  apiKey: z.preprocess(
    (value) => (typeof value === 'string' && !value.trim() ? undefined : value),
    webResearchKeySchema.optional(),
  ),
  persistApiKey: z.boolean(),
  clearApiKey: z.boolean().optional(),
  expectedRevision: revisionSchema,
})
const envelopeSchema = z.strictObject({
  version: z.literal(1),
  provider: z.literal('tavily'),
  endpoint: z.literal(WEB_RESEARCH_ENDPOINT),
  apiKey: webResearchKeySchema,
})
type State = z.infer<typeof stateSchema>
const stale = () => new Error('联网配置已更改，请重新确认本次操作。')

/** Main-process-only, separate from model credentials and all workspace exports. */
export class WebResearchStore {
  private readonly store: AtomicJsonStore<State>
  private sessionKey = ''
  private queue: Promise<unknown> = Promise.resolve()
  constructor(
    directory: string,
    private options: { secureStorage?: ModelSecretStorage } = {},
  ) {
    this.store = new AtomicJsonStore(
      join(directory, 'web-research-credentials.json'),
      stateSchema,
      () => ({ version: 1, provider: 'tavily', revision: 0 }),
    )
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation)
    this.queue = result.catch(() => undefined)
    return result
  }
  private async load() {
    try {
      return await this.store.load()
    } catch {
      throw new Error('无法读取联网配置；原文件未覆盖，请恢复备份。')
    }
  }
  private available() {
    try {
      return Boolean(this.options.secureStorage?.isAvailable())
    } catch {
      return false
    }
  }
  private secret(state: State): { key: string; status: WebResearchConfig['keyStatus'] } {
    if (this.sessionKey) return { key: this.sessionKey, status: 'session' }
    if (!state.encryptedApiKey) return { key: '', status: 'missing' }
    if (!this.available()) return { key: '', status: 'locked' }
    try {
      const envelope = envelopeSchema.parse(
        JSON.parse(this.options.secureStorage!.decryptString(state.encryptedApiKey)),
      )
      return { key: envelope.apiKey, status: 'saved' }
    } catch {
      return { key: '', status: 'locked' }
    }
  }
  private project(state: State): WebResearchConfig {
    const secret = this.secret(state)
    return {
      provider: 'tavily',
      revision: state.revision,
      configured: Boolean(secret.key),
      keyStatus: secret.status,
      secureStorageAvailable: this.available(),
    }
  }
  getConfig(): Promise<WebResearchConfig> {
    return this.serialize(async () => this.project(await this.load()))
  }
  saveConfig(input: WebResearchConfigInput): Promise<WebResearchConfig> {
    return this.serialize(async () => {
      const parsed = inputSchema.safeParse(input)
      if (!parsed.success) throw new Error('联网配置无效，请检查 Tavily 密钥和保存选项。')
      const value = parsed.data
      let nextSession = this.sessionKey
      // Detect unreadable state before updating, without exposing the file/ciphertext/cause.
      await this.load()
      let next: State
      try {
        next = await this.store.update((state) => {
          if (state.revision !== value.expectedRevision) throw stale()
          const updated = { ...state, revision: state.revision + 1 }
          if (value.clearApiKey) {
            delete updated.encryptedApiKey
            nextSession = ''
          } else if (value.apiKey) {
            if (value.persistApiKey) {
              if (!this.available())
                throw new Error('系统安全存储不可用；可选择仅本次会话，不会回退明文保存。')
              const envelope = JSON.stringify({
                version: 1,
                provider: 'tavily',
                endpoint: WEB_RESEARCH_ENDPOINT,
                apiKey: value.apiKey,
              })
              let cipher: string
              try {
                cipher = this.options.secureStorage!.encryptString(envelope)
                if (
                  !cipher ||
                  cipher === value.apiKey ||
                  cipher === envelope ||
                  cipher.length % 4 !== 0 ||
                  !/^[A-Za-z0-9+/]+={0,2}$/.test(cipher) ||
                  [value.apiKey, envelope].includes(Buffer.from(cipher, 'base64').toString('utf8'))
                )
                  throw new Error()
              } catch {
                throw new Error('系统无法加密密钥；本次未保存，不会回退明文。')
              }
              updated.encryptedApiKey = cipher
              nextSession = ''
            } else {
              delete updated.encryptedApiKey
              nextSession = value.apiKey
            }
          }
          return updated
        })
      } catch (error) {
        // Only local allowlisted failures, never lower-level error text or causes.
        const allowed = [
          stale().message,
          '系统安全存储不可用；可选择仅本次会话，不会回退明文保存。',
          '系统无法加密密钥；本次未保存，不会回退明文。',
        ]
        throw new Error(
          error instanceof Error && allowed.includes(error.message)
            ? error.message
            : '联网配置未保存，请检查本机存储后重试。',
        )
      }
      this.sessionKey = nextSession
      return this.project(next)
    })
  }
  /** Never expose through IPC/preload. Bound only to the fixed Tavily provider endpoint. */
  resolve(revision: number): Promise<{ key: string; config: WebResearchConfig }> {
    return this.serialize(async () => {
      const state = await this.load()
      if (state.revision !== revision) throw stale()
      const secret = this.secret(state)
      if (!secret.key)
        throw new Error(
          secret.status === 'locked'
            ? 'Tavily 密钥无法解锁，请检查系统安全存储或重新输入。'
            : '请先配置 Tavily API Key。',
        )
      return { key: secret.key, config: this.project(state) }
    })
  }
}
