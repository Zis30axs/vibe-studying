import { useEffect, useRef, useState } from 'react'
import type { WebResearchApi, WebResearchConfig } from '../shared/web-research'
import { WEB_RESEARCH_ENDPOINT, WEB_RESEARCH_LIMITS } from '../shared/web-research'
import './web-research-settings.css'

const keyLabels: Record<WebResearchConfig['keyStatus'], string> = {
  saved: '已通过系统加密保存',
  session: '仅本次应用会话',
  missing: '尚未配置',
  locked: '已保存的密钥暂不可读取',
}

/** Stores only masked metadata after save. No network test or automatic credential save. */
export function WebResearchSettings({ api }: { api: WebResearchApi }) {
  const [config, setConfig] = useState<WebResearchConfig | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [persistApiKey, setPersistApiKey] = useState(false)
  const [clearApiKey, setClearApiKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const mounted = useRef(false)
  const operation = useRef(false)
  const epoch = useRef(0)

  async function load() {
    if (operation.current) return
    operation.current = true
    const current = ++epoch.current
    setBusy(true)
    setError('')
    try {
      const next = await api.getWebResearchConfig()
      if (mounted.current && current === epoch.current) setConfig(next)
    } catch {
      if (mounted.current && current === epoch.current) {
        setConfig(null)
        setError('无法读取本地联网设置。请重新读取；没有发出搜索或测试请求。')
      }
    } finally {
      if (mounted.current && current === epoch.current) {
        operation.current = false
        setBusy(false)
      }
    }
  }
  useEffect(() => {
    mounted.current = true
    operation.current = false
    void load()
    return () => {
      mounted.current = false
      ++epoch.current
    }
  }, [api])

  async function save() {
    if (!config || operation.current) return
    operation.current = true
    const current = ++epoch.current
    const input = {
      provider: 'tavily' as const,
      expectedRevision: config.revision,
      ...(apiKey.trim() && !clearApiKey ? { apiKey: apiKey.trim() } : {}),
      persistApiKey:
        !!apiKey.trim() && !clearApiKey && persistApiKey && config.secureStorageAvailable,
      clearApiKey,
    }
    setBusy(true)
    setMessage('')
    setError('')
    setApiKey('')
    setPersistApiKey(false)
    setClearApiKey(false)
    try {
      const next = await api.saveWebResearchConfig(input)
      if (mounted.current && current === epoch.current) {
        setConfig(next)
        setMessage(
          input.clearApiKey ? 'Tavily Key 已清除。' : '联网设置已保存到本机；未发出网络测试。',
        )
      }
    } catch {
      if (mounted.current && current === epoch.current)
        setError(
          '保存失败或设置已变化。请重新读取设置后重试；输入的密钥已从表单清空，没有自动重试。',
        )
    } finally {
      if (mounted.current && current === epoch.current) {
        operation.current = false
        setBusy(false)
      }
    }
  }
  return (
    <section
      className="card adapter-card wide web-research-settings"
      aria-labelledby="web-research-settings-title"
    >
      <span className="eyebrow">BOUNDED PUBLIC RESEARCH</span>
      <h2 id="web-research-settings-title">公开联网研究</h2>
      <p>
        Tavily Search 与直接 Fetch 可供 Agent
        主/子角色按本次授权范围调用。默认不联网，每次在工作台选择公开章节、地区、年份和可选网址。
      </p>
      <p>
        搜索接收方：{WEB_RESEARCH_ENDPOINT}。Tavily Key 独立于模型 API
        Key，不会发送给模型或被抓取的网站。
      </p>
      <p className="web-research-muted">
        每次 basic 搜索约 1 credit；一次任务共享最多 {WEB_RESEARCH_LIMITS.searches} 次搜索和{' '}
        {WEB_RESEARCH_LIMITS.fetches} 次 Fetch。直接 Fetch 不消耗 Tavily
        搜索额度。取消后已发请求仍可能计费，失败不会自动重试。
      </p>
      <p>密钥状态：{config ? keyLabels[config.keyStatus] : '尚未读取'}</p>
      <label className="web-research-field">
        Tavily API Key
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          maxLength={512}
          value={apiKey}
          disabled={busy || !config || clearApiKey}
          placeholder="留空保留已有密钥"
          onChange={(event) => {
            setApiKey(event.target.value)
            setMessage('')
          }}
        />
      </label>
      <p className="web-research-muted">
        已有密钥不回填。留空保留已有密钥；新输入默认只用于本次应用会话。输入内容在保存后清空。
      </p>
      <label className="web-research-check">
        <input
          type="checkbox"
          checked={persistApiKey}
          disabled={busy || !config?.secureStorageAvailable || !apiKey.trim() || clearApiKey}
          onChange={(event) => setPersistApiKey(event.target.checked)}
        />
        使用系统加密保存这个新 Tavily Key，供下次应用启动使用
      </label>
      {config && !config.secureStorageAvailable && (
        <p className="web-research-warning">
          系统安全存储不可用，仅支持会话密钥；不会改用明文保存。
        </p>
      )}
      <label className="web-research-check">
        <input
          type="checkbox"
          checked={clearApiKey}
          disabled={busy || !config || config.keyStatus === 'missing'}
          onChange={(event) => {
            setClearApiKey(event.target.checked)
            setApiKey('')
            setPersistApiKey(false)
            setMessage('')
          }}
        />
        清除已有 Tavily Key（点击保存后生效）
      </label>
      <div className="web-research-actions">
        <button
          type="button"
          className="primary"
          disabled={busy || !config}
          onClick={() => void save()}
        >
          保存联网设置
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={() => void load()}>
          重新读取联网设置
        </button>
      </div>
      <p className="web-research-muted">
        保存或清除会使旧的联网运行失效。设置凭据不会启动检索，也不会开启工作台的本次联网开关。
      </p>
      {busy && <p role="status">正在处理本地联网设置…</p>}
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className="web-research-warning">
          {error}
        </p>
      )}
    </section>
  )
}
