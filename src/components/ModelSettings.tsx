import { useEffect, useState } from 'react'
import type { ExamCraftApi, ModelConfig, ModelProtocol } from '../shared/types'
import './advisor.css'

interface Props {
  api: ExamCraftApi
  config: ModelConfig | null
  onChange: (config: ModelConfig) => void
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
export function ModelSettings({ api, config, onChange }: Props) {
  const [protocol, setProtocol] = useState<ModelProtocol>(config?.protocol ?? 'openai-chat')
  const [baseUrl, setBaseUrl] = useState(config?.baseUrl ?? defaults['openai-chat'].baseUrl)
  const [model, setModel] = useState(config?.model ?? defaults['openai-chat'].model)
  const [apiKey, setApiKey] = useState('')
  const [clearApiKey, setClearApiKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => {
    if (!config) return
    setProtocol(config.protocol)
    setBaseUrl(config.baseUrl)
    setModel(config.model)
    setApiKey('')
    setClearApiKey(false)
  }, [config])
  async function save(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setMessage('')
    const secret = apiKey
    setApiKey('')
    try {
      const next = await api.saveModelConfig({
        protocol,
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        ...(secret ? { apiKey: secret } : {}),
        clearApiKey,
      })
      onChange(next)
      setMessage(
        next.configured
          ? '设置已保存。密钥仅在本次应用会话中使用。'
          : '设置已保存；请提供密钥后再发送请求。',
      )
    } catch {
      setMessage('设置未保存。请检查接口地址和模型名称；密钥需要重新输入。')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="model-settings" aria-labelledby="model-settings-title">
      <div>
        <span className="eyebrow">MODEL CONNECTION</span>
        <h2 id="model-settings-title">模型设置</h2>
      </div>
      <p className="advisor-muted">
        配置接口后，每次 Ask Advisor 都会先让你核对发送内容。保存设置不会调用模型。
      </p>
      <form onSubmit={save}>
        <div className="model-settings-grid">
          <label>
            API 协议
            <select
              aria-label="API 协议"
              value={protocol}
              disabled={busy}
              onChange={(event) => {
                const next = event.target.value as ModelProtocol
                setProtocol(next)
                setBaseUrl(defaults[next].baseUrl)
                setModel(defaults[next].model)
                setApiKey('')
                setMessage('协议或地址改变后，请重新输入密钥。')
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
              value={model}
              disabled={busy}
              onChange={(event) => setModel(event.target.value)}
              placeholder="输入服务商支持的模型 ID"
            />
          </label>
          <label className="model-settings-wide">
            接口基础地址
            <input
              type="url"
              required
              value={baseUrl}
              disabled={busy}
              onChange={(event) => {
                setBaseUrl(event.target.value)
                setApiKey('')
              }}
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <label className="model-settings-wide">
            API Key（仅本次会话）
            <input
              type="password"
              value={apiKey}
              disabled={busy || clearApiKey}
              onChange={(event) => setApiKey(event.target.value)}
              autoComplete="new-password"
              spellCheck={false}
              placeholder={
                config?.configured ? '已配置；留空保留当前密钥' : '输入密钥，保存后输入框立即清空'
              }
            />
          </label>
        </div>
        <label className="advisor-check">
          <input
            type="checkbox"
            checked={clearApiKey}
            disabled={busy}
            onChange={(event) => {
              setClearApiKey(event.target.checked)
              setApiKey('')
            }}
          />
          清除本次会话的密钥
        </label>
        <p className="advisor-muted">
          密钥不会保存在本机文件或浏览器存储中，重启后需重新输入。修改协议或接口地址会清除旧密钥。请只使用你信任的服务商地址。
        </p>
        <button type="submit" disabled={busy}>
          {busy ? '保存中…' : '保存模型设置'}
        </button>
        <p role="status" className="advisor-muted">
          {message ||
            (config?.configured ? '已配置 · 可请求提示' : '尚未配置密钥 · 本地练习不受影响')}
        </p>
      </form>
    </section>
  )
}
