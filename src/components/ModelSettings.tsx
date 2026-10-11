import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import type {
  ExamCraftApi,
  ModelKeyStatus,
  ModelProfile,
  ModelProfilesState,
  ModelProtocol,
  ModelRole,
} from '../shared/types'
import './advisor.css'

interface Props {
  api: ExamCraftApi
  state: ModelProfilesState | null
  onChange: (state: ModelProfilesState) => void
  navigationGuardRef: RefObject<((navigate: () => void) => void) | null>
}
const defaults: Record<ModelProtocol, { baseUrl: string; model: string }> = {
  anthropic: { baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-6' },
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.5-flash',
  },
  'openai-responses': { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' },
  'openai-chat': { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' },
}
const keyLabels: Record<ModelKeyStatus, string> = {
  saved: '已加密保存',
  session: '仅本次会话',
  missing: '尚未配置密钥',
  locked: '已保存的密钥暂不可读取',
}
const diagnosticErrors: Record<string, string> = {
  auth: '身份验证失败，请检查 API Key 和服务访问权限。',
  not_found: '服务接口或模型不存在，请检查接口地址、协议和模型名称。',
  model: '服务不接受当前模型或请求参数，请检查模型名称和所选协议。',
  rate_limit: '请求受限或额度不足，请稍后重试或检查服务额度。',
  timeout: '模型请求超时，请稍后重试。',
  network: '无法连接模型服务，请检查网络和接口地址。',
  invalid_response: '服务返回格式无效，请检查所选协议。',
  cancelled: '请求已取消。',
  invalid_config: '模型配置无效，请检查公开 HTTPS 接口地址、协议和模型名称。',
  incomplete_list: '模型列表过大或分页未完成，未使用不完整结果。请手动填写模型名称。',
}
interface Editor {
  profileId?: string
  profileName: string
  protocol: ModelProtocol
  baseUrl: string
  model: string
  apiKey: string
  clearApiKey: boolean
  persistApiKey: boolean
}
function editorFor(profile?: ModelProfile): Editor {
  return {
    ...(profile ? { profileId: profile.profileId } : {}),
    profileName: profile?.profileName ?? '',
    protocol: profile?.protocol ?? 'openai-chat',
    baseUrl: profile?.baseUrl ?? defaults['openai-chat'].baseUrl,
    model: profile?.model ?? defaults['openai-chat'].model,
    apiKey: '',
    clearApiKey: false,
    // Persisting a newly entered key always needs an explicit opt-in.
    persistApiKey: false,
  }
}
function SettingsDialog({
  titleId,
  onDismiss,
  children,
}: {
  titleId: string
  onDismiss: () => void
  children: ReactNode
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const previous = document.activeElement
    dialog.current?.showModal()
    return () => {
      dialog.current?.close()
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])
  return (
    <dialog
      className="model-settings-dialog"
      ref={dialog}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        onDismiss()
      }}
    >
      {children}
    </dialog>
  )
}
export function ModelSettings({ api, state, onChange, navigationGuardRef }: Props) {
  const firstProfile = state?.profiles.find((profile) => profile.profileId === state.roles.parent)
  const [editor, setEditor] = useState<Editor>(() => editorFor(firstProfile))
  const [roles, setRoles] = useState<Record<ModelRole, string>>(
    state?.roles ?? { parent: '', child: '' },
  )
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [pendingNavigation, setPendingNavigation] = useState<{ action: () => void } | null>(null)
  const [deleteConfirmation, setDeleteConfirmation] = useState<string | null>(null)
  const [diagnostic, setDiagnostic] = useState<'list' | 'test' | null>(null)
  const [diagnosticMessage, setDiagnosticMessage] = useState('')
  const [models, setModels] = useState<{ id: string; name?: string }[]>([])
  const [modelSearch, setModelSearch] = useState('')
  const mounted = useRef(true)
  const initialized = useRef(Boolean(state))
  const navigationEpoch = useRef(0)
  const mutationPending = useRef(false)
  const diagnosticRequest = useRef<string | null>(null)
  const rolesSnapshot = useRef(state?.roles)
  const latestState = useRef(state)
  latestState.current = state
  const profile = state?.profiles.find((item) => item.profileId === editor.profileId)
  const destinationChanged = Boolean(
    profile && (editor.protocol !== profile.protocol || editor.baseUrl.trim() !== profile.baseUrl),
  )
  const editorDirty = profile
    ? editor.profileName !== profile.profileName ||
      editor.protocol !== profile.protocol ||
      editor.baseUrl !== profile.baseUrl ||
      editor.model !== profile.model ||
      Boolean(editor.apiKey) ||
      editor.clearApiKey
    : Boolean(editor.profileName || editor.apiKey) ||
      editor.protocol !== 'openai-chat' ||
      editor.baseUrl !== defaults['openai-chat'].baseUrl ||
      editor.model !== defaults['openai-chat'].model
  const rolesDirty = Boolean(
    state && (roles.parent !== state.roles.parent || roles.child !== state.roles.child),
  )

  function cancelDiagnostic(clearResults = true) {
    const requestId = diagnosticRequest.current
    diagnosticRequest.current = null
    if (requestId) void api.cancelModelDiagnostic(requestId).catch(() => {})
    setDiagnostic(null)
    if (clearResults) {
      setDiagnosticMessage('')
      setModels([])
      setModelSearch('')
    }
  }
  function navigate(action: () => void) {
    cancelDiagnostic()
    navigationEpoch.current += 1
    setEditor((current) => ({ ...current, apiKey: '', clearApiKey: false, persistApiKey: false }))
    setMessage('')
    setDeleteConfirmation(null)
    setPendingNavigation(null)
    action()
  }
  function requestNavigation(action: () => void) {
    if (editorDirty || rolesDirty) setPendingNavigation({ action })
    else navigate(action)
  }
  useEffect(() => {
    navigationGuardRef.current = requestNavigation
    return () => {
      navigationGuardRef.current = null
    }
  })
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      navigationEpoch.current += 1
      const requestId = diagnosticRequest.current
      diagnosticRequest.current = null
      if (requestId) void api.cancelModelDiagnostic(requestId).catch(() => {})
    }
  }, [api])
  useEffect(() => {
    if (!state) return
    const previousRoles = rolesSnapshot.current
    setRoles((current) => {
      const keepEdit = (role: ModelRole) =>
        current[role] !== previousRoles?.[role] &&
        state.profiles.some((item) => item.profileId === current[role])
      return {
        parent: keepEdit('parent') ? current.parent : state.roles.parent,
        child: keepEdit('child') ? current.child : state.roles.child,
      }
    })
    rolesSnapshot.current = state.roles
    if (!initialized.current) {
      initialized.current = true
      setEditor(editorFor(state.profiles.find((item) => item.profileId === state.roles.parent)))
    }
  }, [state?.revision])

  function edit(patch: Partial<Editor>, destinationChanged = false) {
    navigationEpoch.current += 1
    cancelDiagnostic()
    setEditor((current) => ({
      ...current,
      ...patch,
      ...(destinationChanged ? { apiKey: '', clearApiKey: false, persistApiKey: false } : {}),
    }))
    setMessage(destinationChanged ? '协议或地址改变后，请重新输入密钥。' : '')
  }
  function selectProfile(profileId: string) {
    if (profileId === editor.profileId) return
    requestNavigation(() => {
      setEditor(
        editorFor(latestState.current?.profiles.find((item) => item.profileId === profileId)),
      )
      if (latestState.current) setRoles(latestState.current.roles)
    })
  }
  async function refresh() {
    const epoch = navigationEpoch.current
    const selectedId = editor.profileId
    try {
      const next = await api.getModelProfiles()
      onChange(next)
      if (
        !mounted.current ||
        navigationEpoch.current !== epoch ||
        next.revision < (latestState.current?.revision ?? 0)
      )
        return
      setEditor(
        editorFor(
          next.profiles.find((item) => item.profileId === selectedId) ??
            next.profiles.find((item) => item.profileId === next.roles.parent),
        ),
      )
      setRoles(next.roles)
      setMessage('模型配置已重新读取。')
    } catch {
      if (mounted.current && navigationEpoch.current === epoch)
        setMessage('模型配置暂时无法读取。本地练习仍可使用，请检查配置文件或恢复备份。')
    }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (mutationPending.current || !state) return
    mutationPending.current = true
    const epoch = navigationEpoch.current
    const input = {
      ...(editor.profileId ? { profileId: editor.profileId } : {}),
      profileName: editor.profileName.trim(),
      protocol: editor.protocol,
      baseUrl: editor.baseUrl.trim(),
      model: editor.model.trim(),
      ...(editor.apiKey ? { apiKey: editor.apiKey } : {}),
      clearApiKey: editor.clearApiKey,
      persistApiKey: editor.persistApiKey,
      expectedRevision: state.revision,
    }
    cancelDiagnostic()
    setBusy(true)
    setMessage('')
    setEditor((current) => ({ ...current, apiKey: '' }))
    try {
      const next = await api.saveModelProfile(input)
      onChange(next)
      if (
        !mounted.current ||
        navigationEpoch.current !== epoch ||
        next.revision < (latestState.current?.revision ?? 0)
      )
        return
      const saved = next.profiles.find((item) =>
        input.profileId
          ? item.profileId === input.profileId
          : item.profileName === input.profileName,
      )
      setEditor(editorFor(saved))
      setMessage(
        saved?.keyStatus === 'saved'
          ? '设置已保存。密钥已通过操作系统加密保存在本机。'
          : saved?.keyStatus === 'session'
            ? '设置已保存。密钥仅在本次应用会话中使用。'
            : saved?.keyStatus === 'locked'
              ? '设置已保存；原密钥暂不可读取，可重新输入密钥后使用。'
              : '设置已保存；请提供密钥后再发送请求。',
      )
    } catch {
      if (!mounted.current || navigationEpoch.current !== epoch) return
      setMessage(
        '设置未保存。请检查配置名称、接口地址、模型与系统安全存储；若配置已变更，请重新读取。密钥需要重新输入。',
      )
    } finally {
      mutationPending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  async function assignRoles() {
    if (mutationPending.current || !state || !rolesDirty) return
    mutationPending.current = true
    const epoch = navigationEpoch.current
    cancelDiagnostic()
    setBusy(true)
    setMessage('')
    try {
      const next = await api.assignModelProfiles({ roles, expectedRevision: state.revision })
      onChange(next)
      if (mounted.current && navigationEpoch.current === epoch)
        setMessage('角色分配已保存。后续请求将使用对应配置及接收方授权。')
    } catch {
      if (mounted.current && navigationEpoch.current === epoch)
        setMessage('角色分配未保存；请重新读取最新配置后重试。')
    } finally {
      mutationPending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  async function removeProfile() {
    if (mutationPending.current || !state || !deleteConfirmation) return
    mutationPending.current = true
    const profileId = deleteConfirmation
    const epoch = navigationEpoch.current
    cancelDiagnostic()
    setEditor((current) => ({ ...current, apiKey: '' }))
    setDeleteConfirmation(null)
    setBusy(true)
    setMessage('')
    try {
      const next = await api.deleteModelProfile({ profileId, expectedRevision: state.revision })
      onChange(next)
      if (
        !mounted.current ||
        navigationEpoch.current !== epoch ||
        next.revision < (latestState.current?.revision ?? 0)
      )
        return
      setEditor(editorFor(next.profiles[0]))
      setMessage('配置及其密钥已删除。使用它的角色已切换至第一个剩余配置。')
    } catch {
      if (mounted.current && navigationEpoch.current === epoch)
        setMessage('配置未删除；至少需保留一个配置。若配置已变更，请重新读取后重试。')
    } finally {
      mutationPending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  async function diagnose(kind: 'list' | 'test') {
    if (diagnosticRequest.current || mutationPending.current || !state || editor.clearApiKey) return
    const requestId = crypto.randomUUID()
    const epoch = navigationEpoch.current
    diagnosticRequest.current = requestId
    setDiagnostic(kind)
    setDiagnosticMessage('')
    setModels([])
    setModelSearch('')
    try {
      const result = await api.diagnoseModel({
        requestId,
        expectedRevision: state.revision,
        ...(editor.profileId ? { profileId: editor.profileId } : {}),
        protocol: editor.protocol,
        baseUrl: editor.baseUrl.trim(),
        model: editor.model.trim(),
        ...(editor.apiKey ? { apiKey: editor.apiKey } : {}),
        kind,
      })
      if (
        !mounted.current ||
        diagnosticRequest.current !== requestId ||
        navigationEpoch.current !== epoch
      )
        return
      if (result.error) {
        setDiagnosticMessage(
          diagnosticErrors[result.error.code] ?? '诊断未完成，请检查配置后重试。',
        )
        return
      }
      if (kind === 'list') {
        setModels(result.models ?? [])
        setDiagnosticMessage(
          result.models?.length
            ? `已获取 ${result.models.length} 个模型。可搜索并选择，也可继续手动填写模型名称。`
            : '服务商未返回可用模型列表。你仍可手动填写模型名称。',
        )
      } else {
        setDiagnosticMessage(
          `连接测试成功${result.latencyMs !== undefined ? ` · ${result.latencyMs} ms` : ''}。这次测试未发送学习内容，也未保存配置。`,
        )
      }
    } catch {
      if (
        !mounted.current ||
        diagnosticRequest.current !== requestId ||
        navigationEpoch.current !== epoch
      )
        return
      setDiagnosticMessage(
        kind === 'list'
          ? '获取模型失败；部分服务商不提供模型列表。请检查地址、密钥与网络，或手动填写模型名称。'
          : '连接测试失败。请检查协议、地址、模型、密钥与网络；修改接收方后需重新输入密钥。',
      )
    } finally {
      if (diagnosticRequest.current === requestId) {
        diagnosticRequest.current = null
        if (mounted.current) setDiagnostic(null)
      }
    }
  }
  const filteredModels = models.filter((item) =>
    `${item.id} ${item.name ?? ''}`.toLowerCase().includes(modelSearch.toLowerCase()),
  )
  const deleteTarget = state?.profiles.find((item) => item.profileId === deleteConfirmation)
  const roleTarget = (role: ModelRole) =>
    state?.profiles.find((item) => item.profileId === roles[role])

  return (
    <section className="model-settings" aria-labelledby="model-settings-title">
      <div>
        <span className="eyebrow">MODEL CONNECTIONS</span>
        <h2 id="model-settings-title">模型设置</h2>
      </div>
      <p className="advisor-muted">
        将服务商、协议、模型和密钥保存为具名配置，按任务选择使用。保存设置不会调用模型；发送学习内容时会核对接收方与授权范围。
      </p>
      {!state ? (
        <div className="model-profile-notice">
          模型配置暂不可读取。本地练习仍可使用。
          <button type="button" onClick={() => void refresh()}>
            重新读取模型配置
          </button>
        </div>
      ) : (
        <>
          <div className="model-profile-toolbar">
            <label>
              当前编辑配置
              <select
                value={editor.profileId ?? ''}
                onChange={(event) => selectProfile(event.target.value)}
              >
                {!editor.profileId && <option value="">新配置（尚未保存）</option>}
                {state.profiles.map((item) => (
                  <option key={item.profileId} value={item.profileId}>
                    {item.profileName} · {keyLabels[item.keyStatus]}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() =>
                requestNavigation(() => {
                  setEditor(editorFor())
                  if (latestState.current) setRoles(latestState.current.roles)
                })
              }
            >
              新建配置
            </button>
            <button
              type="button"
              disabled={busy || !profile || state.profiles.length < 2}
              onClick={() => setDeleteConfirmation(editor.profileId!)}
            >
              删除配置
            </button>
          </div>
          {profile && (
            <p className="model-key-status">
              密钥状态：{keyLabels[profile.keyStatus]}
              {profile.keyStatus === 'locked' &&
                '。当前系统无法解密，请重新输入；不会回显已保存的密钥。'}
            </p>
          )}
          <form onSubmit={save}>
            <div className="model-settings-grid">
              <label className="model-settings-wide">
                配置名称
                <input
                  required
                  maxLength={60}
                  value={editor.profileName}
                  disabled={busy}
                  onChange={(event) => edit({ profileName: event.target.value })}
                  placeholder="例如：日常提示 / 深度审阅"
                  autoComplete="off"
                />
              </label>
              <label>
                API 协议
                <select
                  aria-label="API 协议"
                  value={editor.protocol}
                  disabled={busy}
                  onChange={(event) => {
                    const protocol = event.target.value as ModelProtocol
                    edit({ protocol, ...defaults[protocol] }, true)
                  }}
                >
                  <option value="anthropic">Anthropic Messages</option>
                  <option value="gemini">Gemini Generate Content</option>
                  <option value="openai-responses">OpenAI Responses</option>
                  <option value="openai-chat">OpenAI Chat Completions（兼容接口）</option>
                </select>
              </label>
              <label>
                模型名称
                <input
                  required
                  maxLength={120}
                  value={editor.model}
                  disabled={busy}
                  onChange={(event) => edit({ model: event.target.value })}
                  placeholder="输入服务商支持的模型 ID"
                  autoComplete="off"
                />
              </label>
              <label className="model-settings-wide">
                接口基础地址
                <input
                  type="url"
                  maxLength={300}
                  required
                  value={editor.baseUrl}
                  disabled={busy}
                  onChange={(event) => edit({ baseUrl: event.target.value }, true)}
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
              <label className="model-settings-wide">
                {editor.persistApiKey ? 'API Key（加密保存到本机）' : 'API Key（仅本次会话）'}
                <input
                  type="password"
                  maxLength={4096}
                  value={editor.apiKey}
                  disabled={busy || editor.clearApiKey}
                  onChange={(event) => edit({ apiKey: event.target.value })}
                  autoComplete="new-password"
                  spellCheck={false}
                  placeholder={
                    destinationChanged
                      ? '接收方已改变，请重新输入密钥'
                      : profile && profile.keyStatus !== 'missing'
                        ? '已配置；留空保留当前密钥及保存方式'
                        : '输入密钥，保存后输入框立即清空'
                  }
                />
              </label>
            </div>
            <label className="advisor-check">
              <input
                type="checkbox"
                checked={editor.persistApiKey}
                disabled={busy || editor.clearApiKey || !state.secureStorageAvailable}
                onChange={(event) => edit({ persistApiKey: event.target.checked })}
              />
              使用操作系统加密，将本次输入的密钥保存到本机（可跨重启使用）
            </label>
            {!state.secureStorageAvailable && (
              <p className="model-profile-notice">
                当前系统的安全加密存储不可用，不能保存新密钥。你仍可使用仅本次会话的密钥，退出后需重新输入；不会降级为明文保存。
              </p>
            )}
            <label className="advisor-check">
              <input
                type="checkbox"
                checked={editor.clearApiKey}
                disabled={busy || !profile}
                onChange={(event) =>
                  edit({ clearApiKey: event.target.checked, apiKey: '', persistApiKey: false })
                }
              />
              清除该配置的密钥（包含已保存及本次会话密钥，保存后生效）
            </label>
            <p className="advisor-muted">
              不勾选加密保存时，新输入的密钥仅本次会话有效，并替换该配置原有的已存密钥。留空会保留已有密钥及保存方式；修改协议或接口地址会在保存时清除旧密钥。切换配置或离开此页会清空未保存的密钥。请只使用你信任的服务商地址。
            </p>
            <div className="model-profile-actions">
              <button type="submit" disabled={busy}>
                {busy ? '保存中…' : '保存模型设置'}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => requestNavigation(() => void refresh())}
              >
                重新读取配置
              </button>
            </div>
          </form>
          <section className="model-diagnostics" aria-label="模型连接诊断">
            <h3>获取模型与连接测试</h3>
            <p className="advisor-muted model-destination-preview">
              当前编辑接收方：{editor.baseUrl || '尚未填写'} · {editor.protocol} ·{' '}
              {editor.model || '尚未填写模型'}
            </p>
            <p className="advisor-muted">
              仅点击时联网，使用上方当前填写的配置与密钥。获取模型会读取服务商模型列表；连接测试会发送一条极短的固定测试内容，可能产生少量
              API 费用，不会发送题目、答案或学习记录，也不会自动保存配置。
            </p>
            <div className="model-profile-actions">
              <button
                type="button"
                disabled={
                  busy || Boolean(diagnostic) || editor.clearApiKey || !editor.baseUrl.trim()
                }
                onClick={() => void diagnose('list')}
              >
                {diagnostic === 'list' ? '正在获取…' : '获取模型'}
              </button>
              <button
                type="button"
                disabled={
                  busy ||
                  Boolean(diagnostic) ||
                  editor.clearApiKey ||
                  !editor.baseUrl.trim() ||
                  !editor.model.trim()
                }
                onClick={() => void diagnose('test')}
              >
                {diagnostic === 'test' ? '正在测试…' : '测试 API 连接'}
              </button>
              {diagnostic && (
                <button
                  type="button"
                  onClick={() => {
                    cancelDiagnostic()
                    setDiagnosticMessage('已取消诊断。')
                  }}
                >
                  取消诊断
                </button>
              )}
            </div>
            {diagnosticMessage && (
              <p className="advisor-muted" aria-live="polite">
                {diagnosticMessage}
              </p>
            )}
            {models.length > 0 && (
              <div className="model-list-picker">
                <label>
                  搜索服务商模型
                  <input
                    type="search"
                    value={modelSearch}
                    onChange={(event) => setModelSearch(event.target.value)}
                    placeholder="按模型 ID 或名称搜索"
                  />
                </label>
                <label>
                  选择获取的模型
                  <select
                    value=""
                    onChange={(event) => {
                      if (event.target.value) edit({ model: event.target.value })
                    }}
                  >
                    <option value="">选择后填入模型名称</option>
                    {filteredModels.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.id}
                        {item.name ? ` · ${item.name}` : ''}
                      </option>
                    ))}
                  </select>
                </label>
                {!filteredModels.length && (
                  <p className="advisor-muted">没有匹配的模型，可继续手动填写。</p>
                )}
              </div>
            )}
          </section>
          <section className="model-role-settings" aria-label="模型角色分配">
            <h3>父 / 子 Agent 模型分配</h3>
            <p className="advisor-muted">
              父模型负责正式审阅、地理出题及 Agent 工作台的有界工具编排；子模型负责 Ask Advisor
              思路提示与文科模块检查。Agent 可委派受限单次任务，不创建无限递归的代理。
            </p>
            <div className="model-settings-grid">
              {(['parent', 'child'] as const).map((role) => (
                <label key={role}>
                  {role === 'parent' ? '父 Agent 模型' : '子 Agent 模型'}
                  <select
                    aria-label={role === 'parent' ? '父 Agent 模型' : '子 Agent 模型'}
                    value={roles[role]}
                    disabled={busy}
                    onChange={(event) => {
                      cancelDiagnostic()
                      setRoles((current) => ({ ...current, [role]: event.target.value }))
                      setMessage('')
                    }}
                  >
                    {state.profiles.map((item) => (
                      <option key={item.profileId} value={item.profileId}>
                        {item.profileName} · {item.model}
                      </option>
                    ))}
                  </select>
                  <span className="advisor-muted model-destination-preview">
                    {roleTarget(role)?.protocol} · {roleTarget(role)?.baseUrl} ·{' '}
                    {roleTarget(role) ? keyLabels[roleTarget(role)!.keyStatus] : ''}
                  </span>
                </label>
              ))}
            </div>
            <p className="advisor-muted">
              可为两个角色选择同一配置。新建或编辑配置不会自动更改角色分配；更改分配会取消进行中的模型请求。
            </p>
            <button type="button" disabled={busy || !rolesDirty} onClick={() => void assignRoles()}>
              保存角色分配
            </button>
          </section>
        </>
      )}
      <p role="status" className="advisor-muted">
        {message ||
          (profile
            ? `当前配置：${profile.profileName} · ${keyLabels[profile.keyStatus]}`
            : '本地练习不受模型设置影响')}
      </p>
      {pendingNavigation && (
        <SettingsDialog titleId="model-discard-title" onDismiss={() => setPendingNavigation(null)}>
          <h3 id="model-discard-title">放弃未保存的编辑？</h3>
          <p>
            配置和角色分配的未保存更改将丢失，密钥输入也会清空。
            {busy && '已发送的保存操作仍可能完成。'}
          </p>
          <div className="model-profile-actions">
            <button type="button" autoFocus onClick={() => setPendingNavigation(null)}>
              继续编辑
            </button>
            <button type="button" onClick={() => navigate(pendingNavigation.action)}>
              放弃更改并继续
            </button>
          </div>
        </SettingsDialog>
      )}
      {deleteTarget && (
        <SettingsDialog titleId="model-delete-title" onDismiss={() => setDeleteConfirmation(null)}>
          <h3 id="model-delete-title">删除配置「{deleteTarget.profileName}」？</h3>
          <p>
            这会删除此配置和它保存的密钥，不能撤销。正在使用此配置的父 / 子角色将切换至「
            {state?.profiles.find((item) => item.profileId !== deleteTarget.profileId)?.profileName}
            」，进行中的模型请求会被取消。
          </p>
          <div className="model-profile-actions">
            <button type="button" autoFocus onClick={() => setDeleteConfirmation(null)}>
              保留配置
            </button>
            <button type="button" disabled={busy} onClick={() => void removeProfile()}>
              确认删除配置
            </button>
          </div>
        </SettingsDialog>
      )}
    </section>
  )
}
