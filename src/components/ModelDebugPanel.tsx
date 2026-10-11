import { connectionStageLabels } from '../shared/model-connection-diagnostics'
import { useEffect, useRef, useState } from 'react'
import type {
  ModelDebugApi,
  ModelDebugCategory,
  ModelDebugStage,
  ModelDebugState,
} from '../shared/model-debug'

const stageLabels: Record<ModelDebugStage, string> = {
  request: '发送请求',
  http: 'HTTP 状态',
  response: '读取响应',
  envelope: '协议响应结构',
  json: '模型 JSON',
  schema: '结果字段校验',
}
const categoryLabels: Record<ModelDebugCategory, string> = {
  ok: '通过',
  auth: '身份验证失败',
  rate_limit: '请求或额度受限',
  network: '网络失败',
  timeout: '超时',
  cancelled: '已取消',
  http: 'HTTP 请求失败',
  parse: 'JSON 或文本解码失败',
  truncated: '输出达到长度限制',
  refusal: '明确拒绝或过滤',
  envelope: '响应结构不符',
  schema: '字段或评分项不符',
  credential_reflection: '敏感信息反射已拦截',
  response_too_large: '响应超过安全大小限制',
}

export function ModelDebugPanel({ api }: { api: ModelDebugApi }) {
  const [state, setState] = useState<ModelDebugState | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const mounted = useRef(false)
  const epoch = useRef(0)
  const mutating = useRef(false)

  async function refresh() {
    if (mutating.current) return
    const version = ++epoch.current
    try {
      const result = await api.getModelDebug()
      if (mounted.current && epoch.current === version) setState(result)
    } catch {
      if (mounted.current && epoch.current === version) setMessage('无法读取本地诊断，请稍后刷新。')
    }
  }
  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => {
      mounted.current = false
      epoch.current += 1
    }
  }, [api])
  useEffect(() => {
    if (!state?.enabled) return
    const interval = setInterval(() => {
      void refresh()
    }, 2000)
    return () => clearInterval(interval)
  }, [api, state?.enabled])

  async function update(action: 'enable' | 'disable' | 'clear' | 'copy') {
    if (mutating.current) return
    mutating.current = true
    const version = ++epoch.current
    setBusy(true)
    setMessage('')
    try {
      if (action === 'copy') {
        await api.copyModelDebug()
        if (mounted.current && epoch.current === version)
          setMessage('已将脱敏诊断复制到本机剪贴板。')
      } else {
        const result =
          action === 'clear'
            ? await api.clearModelDebug()
            : await api.setModelDebugEnabled(action === 'enable')
        if (mounted.current && epoch.current === version) {
          setState(result)
          setMessage(
            action === 'disable'
              ? 'Debug 已关闭，记录已清空。'
              : action === 'clear'
                ? '记录已清空。'
                : 'Debug 已开启。请手动重现问题，再查看下面的记录。',
          )
        }
      }
    } catch {
      if (mounted.current && epoch.current === version) setMessage('本地诊断操作失败，请稍后重试。')
    } finally {
      mutating.current = false
      if (mounted.current && epoch.current === version) setBusy(false)
    }
  }

  return (
    <section className="model-diagnostics" aria-labelledby="model-debug-title">
      <h3 id="model-debug-title">Debug · 本地脱敏诊断</h3>
      <p className="model-key-status">
        默认关闭，仅保留本次应用会话最近 {state?.limit ?? 80} 条记录，关闭或退出应用即清除。
        只记录阶段、固定网络错误码、耗时、HTTP 状态、协议、模型和字段位置，不记录 API
        Key、请求或响应原文、作答与教材正文。
      </p>
      <p className="model-key-status">
        覆盖提交作答、顾问提示、模块检查、生成题目、连接测试和获取模型列表。开启 Debug
        不会发起请求、自动重试或上传日志。
      </p>
      <label>
        <input
          type="checkbox"
          checked={state?.enabled ?? false}
          disabled={!state || busy}
          onChange={(event) => void update(event.target.checked ? 'enable' : 'disable')}
        />{' '}
        开启本次会话 Debug
      </label>
      <div className="model-profile-actions" style={{ marginTop: 12 }}>
        <button type="button" className="ghost" disabled={busy} onClick={() => void refresh()}>
          刷新记录
        </button>
        <button
          type="button"
          className="ghost"
          disabled={busy || !state?.records.length}
          onClick={() => void update('clear')}
        >
          清空记录
        </button>
        <button
          type="button"
          className="ghost"
          disabled={busy || !state?.records.length}
          onClick={() => void update('copy')}
        >
          复制脱敏诊断
        </button>
      </div>
      <p role="status" className="model-key-status">
        {message}
      </p>
      {!state?.records.length ? (
        <p className="model-key-status">
          {state?.enabled ? '暂无记录。手动重现问题后，诊断会显示在这里。' : 'Debug 已关闭。'}
        </p>
      ) : (
        <ol aria-label="模型诊断记录" style={{ maxHeight: 360, overflow: 'auto', paddingLeft: 24 }}>
          {[...state.records].reverse().map((record) => (
            <li
              key={record.id}
              style={{ marginBottom: 12, fontSize: 12, lineHeight: 1.7, overflowWrap: 'anywhere' }}
            >
              <strong>
                {record.operation === 'model_list'
                  ? '获取模型 · '
                  : record.operation === 'connection_test'
                    ? '连接测试 · '
                    : ''}
                {stageLabels[record.stage]} · {categoryLabels[record.category]}
              </strong>
              <div>
                {record.protocol} · {record.model} · {record.elapsedMs} ms
                {record.httpStatus ? ` · HTTP ${record.httpStatus}` : ''}
              </div>
              {record.connection && (
                <div>
                  {connectionStageLabels[record.connection.stage]}
                  {record.connection.networkCode ? ` · ${record.connection.networkCode}` : ''}
                </div>
              )}
              {record.schemaPaths?.length ? (
                <div>字段位置：{record.schemaPaths.join('、')}</div>
              ) : null}
              <div>
                请求 {record.requestId} · {record.category}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
