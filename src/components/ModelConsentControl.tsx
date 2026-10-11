import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { ModelConfig } from '../shared/types'
import {
  canonicalModelConsentBaseUrl,
  emptyModelConsents,
  hasModelConsent,
  modelConsentDescriptions,
  modelConsentGrantSchema,
  modelConsentRevokeSchema,
  modelConsentsStateSchema,
  modelConsentScopes,
  withoutModelConsents,
  type ModelConsentApi,
  type ModelConsentGrantInput,
  type ModelConsentRevokeInput,
  type ModelConsentsState,
  type ModelConsentScope,
} from '../shared/model-consent'

interface ConsentSnapshot {
  state: ModelConsentsState | null
  loading: boolean
  pending: number
  error: string
}
/** One renderer session per API object. A shared cache lets settings revoke every
 * mounted control immediately. Writes serialize and late reads cannot undo them. */
export class ModelConsentSession {
  private snapshot: ConsentSnapshot = { state: null, loading: false, pending: 0, error: '' }
  private listeners = new Set<() => void>()
  private initial: Promise<void> | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private sequence = 0
  private revoked = new Map<string, Map<ModelConsentScope, number>>()
  private requestedGrants = new Map<number, ModelConsentGrantInput>()
  private globalRevoked = new Map<ModelConsentScope, number>()
  private grantedAfterGlobalRevoke = new Map<string, Map<ModelConsentScope, number>>()
  private writeError = ''
  private readonly revokeError =
    '未能保存撤销。本次会话已停止自动使用；如需永久撤销，请在关闭前重试。'
  constructor(private readonly api: ModelConsentApi) {}
  getSnapshot = (): ConsentSnapshot => this.snapshot
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private publish(update: Partial<ConsentSnapshot>) {
    this.snapshot = { ...this.snapshot, ...update }
    for (const listener of this.listeners) listener()
  }
  private masked(state: ModelConsentsState): ModelConsentsState {
    for (const [baseUrl, scopes] of this.revoked) {
      if (scopes.size) state = withoutModelConsents(state, { baseUrl, scopes: [...scopes.keys()] })
    }
    return {
      ...state,
      grants: state.grants.flatMap((grant) => {
        const scopes = grant.scopes.filter(
          (scope) =>
            (this.globalRevoked.get(scope) ?? 0) <=
            (this.grantedAfterGlobalRevoke.get(grant.baseUrl)?.get(scope) ?? 0),
        )
        return scopes.length ? [{ ...grant, scopes }] : []
      }),
    }
  }
  load = (): Promise<void> => {
    if (this.initial) return this.initial
    const sequence = this.sequence
    this.publish({ loading: true, error: this.writeError })
    this.initial = Promise.resolve()
      .then(() => this.api.getModelConsents())
      .then((value) => {
        const state = modelConsentsStateSchema.parse(value)
        if (sequence === this.sequence)
          this.publish({ state: this.masked(state), error: this.writeError })
      })
      .catch(() => {
        if (sequence === this.sequence)
          this.publish({
            error: this.writeError || '无法读取本机已记住的同意。可以仅同意本次，或稍后重试。',
          })
      })
      .finally(() => {
        this.publish({ loading: false })
        this.initial = undefined
      })
    return this.initial
  }
  private mutate(
    sequence: number,
    operation: () => Promise<ModelConsentsState>,
    errorMessage: string,
    afterSuccess?: () => void,
  ): Promise<void> {
    this.publish({ pending: this.snapshot.pending + 1, error: this.writeError })
    const result = this.queue
      .then(operation)
      .then((value) => {
        const state = modelConsentsStateSchema.parse(value)
        afterSuccess?.()
        if (sequence === this.sequence) {
          const masked = this.masked(state)
          this.writeError =
            JSON.stringify(masked.grants) === JSON.stringify(state.grants) ? '' : this.revokeError
          this.publish({ state: masked, error: this.writeError })
        }
      })
      .catch(() => {
        this.writeError = errorMessage
        if (sequence === this.sequence) this.publish({ error: this.writeError })
        throw new Error('未能保存本机授权更改。')
      })
      .finally(() => {
        this.requestedGrants.delete(sequence)
        this.publish({ pending: this.snapshot.pending - 1 })
      })
    this.queue = result.catch(() => undefined)
    return result
  }
  grant = (input: ModelConsentGrantInput): Promise<void> => {
    const parsed = modelConsentGrantSchema.parse(input)
    const sequence = ++this.sequence
    this.requestedGrants.set(sequence, parsed)
    return this.mutate(
      sequence,
      () => this.api.grantModelConsent(parsed),
      '未能记住本次同意。请重试，或取消记住后仅同意本次。',
      () => {
        const denied = this.revoked.get(parsed.baseUrl)
        const allowed =
          this.grantedAfterGlobalRevoke.get(parsed.baseUrl) ?? new Map<ModelConsentScope, number>()
        for (const scope of parsed.scopes) {
          if ((denied?.get(scope) ?? Infinity) <= sequence) denied?.delete(scope)
          allowed.set(scope, sequence)
        }
        this.grantedAfterGlobalRevoke.set(parsed.baseUrl, allowed)
      },
    )
  }
  revoke = (input: ModelConsentRevokeInput): Promise<void> => {
    const parsed = modelConsentRevokeSchema.parse(input)
    const sequence = ++this.sequence
    if (!parsed.baseUrl) {
      for (const scope of parsed.scopes ?? modelConsentScopes)
        this.globalRevoked.set(scope, sequence)
    }
    const receivers = parsed.baseUrl
      ? [parsed.baseUrl]
      : [
          ...(this.snapshot.state?.grants.map((grant) => grant.baseUrl) ?? []),
          ...[...this.requestedGrants.values()].map((grant) => grant.baseUrl),
        ]
    for (const baseUrl of receivers) {
      const scopes = this.revoked.get(baseUrl) ?? new Map<ModelConsentScope, number>()
      for (const scope of parsed.scopes ?? modelConsentScopes) scopes.set(scope, sequence)
      this.revoked.set(baseUrl, scopes)
    }
    if (this.snapshot.state) this.publish({ state: this.masked(this.snapshot.state) })
    return this.mutate(sequence, () => this.api.revokeModelConsent(parsed), this.revokeError)
  }
}
const sessions = new WeakMap<ModelConsentApi, ModelConsentSession>()
function sessionFor(api: ModelConsentApi): ModelConsentSession {
  let session = sessions.get(api)
  if (!session) {
    session = new ModelConsentSession(api)
    sessions.set(api, session)
  }
  return session
}
function useModelConsents(api: ModelConsentApi) {
  const session = sessionFor(api)
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
  useEffect(() => {
    if (!session.getSnapshot().state && !session.getSnapshot().loading) void session.load()
  }, [session])
  return { session, ...snapshot }
}

export interface ModelConsentControlProps {
  api: ModelConsentApi
  config: ModelConfig | null
  scopes: ModelConsentScope[]
  checked: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
  label: string
}
export function ModelConsentControl({
  api,
  config,
  scopes,
  checked,
  onChange,
  disabled,
  label,
}: ModelConsentControlProps) {
  const { session, state, pending, error } = useModelConsents(api)
  const [remember, setRemember] = useState(false)
  const [busy, setBusy] = useState(false)
  const detailsId = useId()
  let receiver = ''
  try {
    if (config) receiver = canonicalModelConsentBaseUrl(config.baseUrl)
  } catch {
    /* Fail closed. */
  }
  const scopeKey = [...new Set(scopes)].sort().join('|')
  const target = `${receiver}|${scopeKey}`
  const currentTarget = useRef(target)
  currentTarget.current = target
  const mounted = useRef(true)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const prior = useRef({ target, remembered: false })
  // A local one-off remains allowed after opting out of remembering; other controls
  // still clear their inherited checkmark when the shared grant is revoked.
  const keepOnce = useRef(false)
  const action = useRef(false)
  const remembered = hasModelConsent(state, receiver, scopes)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (prior.current.target !== target) {
      prior.current = { target, remembered: false }
      keepOnce.current = false
      setRemember(false)
      // The caller may still hold a checkmark from the old receiver or data categories.
      if (checked && !remembered) onChangeRef.current(false)
    }
    if (action.current) return
    if (remembered) {
      setRemember(true)
      if (!checked) onChangeRef.current(true)
    } else if (prior.current.remembered) {
      setRemember(false)
      if (checked && !keepOnce.current) onChangeRef.current(false)
    }
    prior.current = { target, remembered }
  }, [target, remembered, checked, pending, busy])
  async function update(value: boolean, remembering: boolean) {
    const boundTarget = target
    if (action.current) return
    action.current = true
    setBusy(true)
    keepOnce.current = value && !remembering
    // Never recheck from an old saved grant while a revocation is in flight.
    if (!value) onChangeRef.current(false)
    try {
      if (value && remembering) await session.grant({ baseUrl: receiver, scopes })
      else if (remembered) await session.revoke({ baseUrl: receiver, scopes })
      if (mounted.current && currentTarget.current === boundTarget) onChangeRef.current(value)
    } catch {
      if (mounted.current && currentTarget.current === boundTarget) {
        // A failed save must not imply a remembered grant. Explicit one-off consent
        // is still valid, and a failed revoke remains denied within this session.
        setRemember(false)
        onChangeRef.current(value && !remembering)
      }
    } finally {
      action.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const unavailable = disabled || busy || pending > 0 || !receiver || !scopes.length
  return (
    <div className="model-consent-control" style={{ fontSize: 12, lineHeight: 1.55 }}>
      <label
        className="advisor-check"
        style={{ display: 'flex', alignItems: 'flex-start', gap: 8, margin: '10px 0' }}
      >
        <input
          type="checkbox"
          checked={checked}
          disabled={unavailable}
          aria-describedby={detailsId}
          onChange={(event) => {
            void update(event.target.checked, remember)
          }}
        />
        {label}
      </label>
      <label
        className="advisor-check"
        style={{ display: 'flex', alignItems: 'flex-start', gap: 8, margin: '10px 0' }}
      >
        <input
          type="checkbox"
          checked={remember}
          disabled={unavailable}
          onChange={(event) => {
            const value = event.target.checked
            setRemember(value)
            if (checked || remembered) void update(checked, value)
          }}
        />
        记住对此接收方和数据范围的同意，下次不再询问
      </label>
      <details id={detailsId}>
        <summary>
          {remembered ? '已在本机记住同意 · 查看范围与撤销方式' : '查看接收方与数据范围'}
        </summary>
        <p>接收方：{receiver || '尚未配置有效接口'}</p>
        <ul>
          {modelConsentScopes
            .filter((scope) => scopes.includes(scope))
            .map((scope) => (
              <li key={scope}>{modelConsentDescriptions[scope]}</li>
            ))}
        </ul>
        <p>
          同意只保存在本机。相同接口和已同意的数据范围可在新题中继续使用；更换接收方或增加数据范围需要重新同意。可取消勾选或在模型设置中撤销。调用可能产生服务商费用。
        </p>
        {scopes.includes('knowledge') && (
          <p>记住同意不会自动选择教材或新增摘录；仍只发送每次明确选择的内容。</p>
        )}
      </details>
      {busy && <p role="status">正在保存授权选择…</p>}
      {error && (
        <p role="alert" className="advisor-error">
          {error}
        </p>
      )}
    </div>
  )
}

export function ModelConsentSettings({ api }: { api: ModelConsentApi }) {
  const { session, state, loading, pending, error } = useModelConsents(api)
  const revoke = (input: ModelConsentRevokeInput) => {
    void session.revoke(input).catch(() => undefined)
  }
  return (
    <section className="model-consent-settings" aria-label="已记住的 AI 数据发送同意">
      <h3>已记住的数据发送同意</h3>
      <p>以下选择只保存在本机，按接收方接口与数据范围生效。撤销后，下次调用需要重新同意。</p>
      {loading && <p role="status">正在读取本机同意记录…</p>}
      {state?.grants.length === 0 && <p>尚未记住任何接收方的同意。</p>}
      {state?.grants.map((grant) => (
        <div key={grant.baseUrl}>
          <strong>{grant.baseUrl}</strong>
          <ul>
            {grant.scopes.map((scope) => (
              <li key={scope}>{modelConsentDescriptions[scope]}</li>
            ))}
          </ul>
          <button
            type="button"
            className="secondary"
            disabled={pending > 0}
            onClick={() => revoke({ baseUrl: grant.baseUrl })}
          >
            撤销此接收方的同意
          </button>
        </div>
      ))}
      {(Boolean(state?.grants.length) || Boolean(error)) && (
        <button
          type="button"
          className="secondary"
          disabled={pending > 0}
          onClick={() => revoke({})}
        >
          撤销全部已记住的同意
        </button>
      )}
      {pending > 0 && <p role="status">正在保存授权更改…</p>}
      {error && (
        <p role="alert" className="advisor-error">
          {error}
        </p>
      )}
      {!state && !loading && (
        <button
          type="button"
          className="secondary"
          disabled={pending > 0}
          onClick={() => {
            void session.load()
          }}
        >
          重新读取同意记录
        </button>
      )}
    </section>
  )
}
