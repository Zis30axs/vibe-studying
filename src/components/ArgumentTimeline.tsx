import { useState } from 'react'
import type { ArgumentDocument } from '../shared/types'
import { hasArgumentDraftChanges } from '../domain/argument-revisions'
import './argument-timeline.css'

export function ArgumentTimeline({
  document,
  disabled = false,
  onCheckpoint,
  onRestore,
}: {
  document: ArgumentDocument
  disabled?: boolean
  onCheckpoint: (label: string) => void
  onRestore: (id: string) => void
}) {
  const [label, setLabel] = useState('')
  const [confirm, setConfirm] = useState<string | null>(null)
  const tree = document.revisions
  const nodes = tree?.nodes ?? []
  const dirty = hasArgumentDraftChanges(document)
  function depth(id: string): number {
    let node = nodes.find((value) => value.id === id),
      result = 0
    const visited = new Set<string>()
    while (node?.parentId && !visited.has(node.id)) {
      visited.add(node.id)
      result++
      node = nodes.find((value) => value.id === node!.parentId)
    }
    return Math.min(result, 8)
  }
  return (
    <details className="argument-timeline">
      <summary>
        版本时间树 · {nodes.length}/40 个检查点{dirty ? ' · 有未记录修改' : ''}
      </summary>
      <p>
        记录模块、大模块分组及布局；最终正文不受恢复影响。恢复旧版本后，新检查点会从它分支，原分支保留。
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          onCheckpoint(label.trim() || '手动检查点')
          setLabel('')
        }}
      >
        <label>
          检查点名称
          <input
            aria-label="检查点名称"
            value={label}
            maxLength={80}
            disabled={disabled}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="例如：补充史料之后"
          />
        </label>
        <button type="submit" disabled={disabled}>
          保存检查点
        </button>
      </form>
      {!nodes.length && <p>还没有检查点。手动保存或接受修改建议后，会记录可恢复版本。</p>}
      <ol aria-label="模块版本时间树">
        {nodes.map((node) => (
          <li key={node.id} style={{ marginLeft: depth(node.id) * 12 }} data-revision-id={node.id}>
            <span className="revision-branch" aria-hidden="true">
              {node.parentId ? '└' : '●'}
            </span>
            <div>
              <strong>{node.label}</strong>
              <small>
                {new Date(node.createdAt).toLocaleString('zh-CN')} ·{' '}
                {node.source === 'ai' ? '已接受的 AI 修改' : '手动记录'}
                {tree?.headId === node.id ? ' · 当前分支起点' : ''}
              </small>
              <small>
                {node.parentId
                  ? `源自：${nodes.find((parent) => parent.id === node.parentId)?.label ?? '未知'}`
                  : '根版本'}
              </small>
            </div>
            <button
              type="button"
              disabled={disabled || (tree?.headId === node.id && !dirty)}
              onClick={() => setConfirm(node.id)}
            >
              恢复此版本
            </button>
          </li>
        ))}
      </ol>
      {confirm && nodes.some((node) => node.id === confirm) && (
        <div className="revision-confirm" role="alertdialog" aria-label="确认恢复模块版本">
          <p>
            恢复“{nodes.find((node) => node.id === confirm)?.label}”？
            {dirty ? '当前未记录的模块修改会先保存为检查点。' : ''}最终正文保持原样。
          </p>
          <button type="button" disabled={disabled} onClick={() => setConfirm(null)}>
            取消恢复
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              onRestore(confirm)
              setConfirm(null)
            }}
          >
            确认恢复模块
          </button>
        </div>
      )}
      <small>最多 40 个版本、1 MiB 版本内容；达到上限会明确提示，不会自动删除旧分支。</small>
    </details>
  )
}
