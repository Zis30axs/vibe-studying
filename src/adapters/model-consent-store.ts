import { join } from 'node:path'
import { AtomicJsonStore } from './atomic-json-store'
import { validateBaseUrl } from './model-transport'
import {
  emptyModelConsents,
  hasModelConsent,
  modelConsentGrantSchema,
  modelConsentRevokeSchema,
  modelConsentsStateSchema,
  modelConsentScopes,
  withoutModelConsents,
  type ModelConsentApi,
  type ModelConsentGrantInput,
  type ModelConsentRevokeInput,
  type ModelConsentScope,
  type ModelConsentsState,
} from '../shared/model-consent'

/** Main-process-only storage. Instantiate once per directory to serialize updates.
 * Nothing is migrated from old per-request booleans: only an explicit grant writes.
 * Revocation takes effect in this main-process session before disk writes finish.
 * If persistence fails, renderer reloads remain denied. A true application restart
 * cannot retain memory-only revocations, so write failures must still reach the UI. */
export class ModelConsentStore implements ModelConsentApi {
  private readonly store: AtomicJsonStore<ModelConsentsState>
  private sequence = 0
  private readonly globallyRevoked = new Map<ModelConsentScope, number>()
  private readonly revoked = new Map<string, Map<ModelConsentScope, number>>()
  private readonly explicitlyGranted = new Map<string, Map<ModelConsentScope, number>>()
  constructor(directory: string) {
    this.store = new AtomicJsonStore(
      join(directory, 'model-consents.json'),
      modelConsentsStateSchema,
      emptyModelConsents,
    )
  }
  private applySessionRevocations(state: ModelConsentsState): ModelConsentsState {
    return {
      ...state,
      grants: state.grants.flatMap((grant) => {
        const scopes = grant.scopes.filter((scope) => {
          const revokedAt = Math.max(
            this.globallyRevoked.get(scope) ?? 0,
            this.revoked.get(grant.baseUrl)?.get(scope) ?? 0,
          )
          return revokedAt <= (this.explicitlyGranted.get(grant.baseUrl)?.get(scope) ?? 0)
        })
        return scopes.length ? [{ ...grant, scopes }] : []
      }),
    }
  }
  async getModelConsents(): Promise<ModelConsentsState> {
    return this.applySessionRevocations(await this.store.load())
  }
  async grantModelConsent(input: ModelConsentGrantInput): Promise<ModelConsentsState> {
    const parsed = modelConsentGrantSchema.parse(input)
    // Keep the security-sensitive main-process transport validation as the final authority.
    parsed.baseUrl = validateBaseUrl(parsed.baseUrl)
    const sequence = ++this.sequence
    const result = await this.store.update((stored) => {
      // Persist outstanding revocations while saving the explicitly named new grant.
      // Merging directly with stale disk grants would reintroduce revoked categories.
      const state = this.applySessionRevocations(stored)
      const previous = state.grants.find((grant) => grant.baseUrl === parsed.baseUrl)
      let grants = state.grants
      if (!previous || !parsed.scopes.every((scope) => previous.scopes.includes(scope))) {
        if (!previous && state.grants.length >= 100)
          throw new Error('已保存 100 个接收方，请先撤销不再使用的授权。')
        const grant = {
          baseUrl: parsed.baseUrl,
          scopes: modelConsentScopes.filter(
            (scope) => parsed.scopes.includes(scope) || previous?.scopes.includes(scope),
          ),
          grantedAt: new Date().toISOString(),
        }
        grants = previous
          ? state.grants.map((item) => (item.baseUrl === parsed.baseUrl ? grant : item))
          : [...state.grants, grant]
      }
      const changed = JSON.stringify(grants) !== JSON.stringify(stored.grants)
      return changed ? { ...state, revision: stored.revision + 1, grants } : stored
    })
    // Only successful persistence can relax a tombstone. A newer revoke wins even
    // if an older grant response finishes later, because it has a greater sequence.
    const granted =
      this.explicitlyGranted.get(parsed.baseUrl) ?? new Map<ModelConsentScope, number>()
    for (const scope of parsed.scopes) granted.set(scope, sequence)
    this.explicitlyGranted.set(parsed.baseUrl, granted)
    return this.applySessionRevocations(result)
  }
  async revokeModelConsent(input: ModelConsentRevokeInput): Promise<ModelConsentsState> {
    const parsed = modelConsentRevokeSchema.parse(input)
    if (parsed.baseUrl) parsed.baseUrl = validateBaseUrl(parsed.baseUrl)
    const sequence = ++this.sequence
    const revoked = parsed.baseUrl
      ? (this.revoked.get(parsed.baseUrl) ?? new Map<ModelConsentScope, number>())
      : this.globallyRevoked
    for (const scope of parsed.scopes ?? modelConsentScopes) revoked.set(scope, sequence)
    if (parsed.baseUrl) this.revoked.set(parsed.baseUrl, revoked)
    try {
      const result = await this.store.update((state) => {
        const next = this.applySessionRevocations(withoutModelConsents(state, parsed))
        const changed = JSON.stringify(next.grants) !== JSON.stringify(state.grants)
        return changed ? { ...next, revision: state.revision + 1 } : state
      })
      return this.applySessionRevocations(result)
    } catch (error) {
      // Do not turn an in-memory denial into a false claim of durable persistence.
      throw new Error(
        '未能永久保存撤销。本次应用会话中已停止自动使用；完全退出应用后可能恢复旧授权，请在退出前重试。',
        { cause: error },
      )
    }
  }
  async hasConsent(baseUrl: string, scopes: ModelConsentScope[]): Promise<boolean> {
    return hasModelConsent(await this.getModelConsents(), baseUrl, scopes)
  }
}
