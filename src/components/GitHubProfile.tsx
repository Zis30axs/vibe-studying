import { useEffect, useRef, useState } from 'react'
import type { GitHubDisplayProfile } from '../shared/github-profile'
import './github-profile.css'

export function GitHubProfile({ className = '' }: { className?: string }) {
  const [profile, setProfile] = useState<GitHubDisplayProfile | null>(null)
  const [editing, setEditing] = useState(false)
  const [username, setUsername] = useState('')
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [imageFailed, setImageFailed] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  function closeEditor() {
    setEditing(false)
    setError('')
    requestAnimationFrame(() => trigger.current?.focus())
  }
  const mounted = useRef(false)
  const available = Boolean(window.examcraft?.getGitHubProfile)
  useEffect(() => {
    mounted.current = true
    if (window.examcraft?.getGitHubProfile) {
      void window.examcraft
        .getGitHubProfile()
        .then((value) => {
          if (mounted.current) setProfile(value)
        })
        .catch(() => {
          if (mounted.current) setError('本地展示资料读取失败，请检查数据文件。')
        })
        .finally(() => {
          if (mounted.current) setBusy(false)
        })
    } else setBusy(false)
    return () => {
      mounted.current = false
    }
  }, [])
  async function bind() {
    if (!window.examcraft || busy) return
    setBusy(true)
    setError('')
    try {
      const value = await window.examcraft.setGitHubProfile(username)
      if (mounted.current) {
        setProfile(value)
        setImageFailed(false)
        closeEditor()
      }
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error
            ? cause.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
            : '获取失败，请重试。',
        )
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  async function unbind() {
    if (!window.examcraft || busy) return
    setBusy(true)
    setError('')
    try {
      await window.examcraft.clearGitHubProfile()
      if (mounted.current) {
        setProfile(null)
        setUsername('')
        setEditing(false)
      }
    } catch {
      if (mounted.current) setError('解除展示关联失败，请重试。')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <section
      className={`github-profile ${className}`}
      aria-label="GitHub 公开资料展示"
      aria-busy={busy}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && editing && !busy) {
          event.preventDefault()
          closeEditor()
        }
      }}
    >
      <div className="github-profile-summary">
        {profile?.avatarDataUrl && !imageFailed ? (
          <img
            className="github-profile-avatar"
            src={profile.avatarDataUrl}
            alt=""
            onError={() => setImageFailed(true)}
          />
        ) : (
          <span className="github-profile-avatar github-profile-initial" aria-hidden="true">
            {profile?.login.slice(0, 2).toUpperCase() || 'GH'}
          </span>
        )}
        <div className="github-profile-identity">
          <strong>{profile?.name || profile?.login || 'GitHub 个人展示'}</strong>
          <span>{profile ? `@${profile.login} · 未验证归属` : '关联公开头像与用户名'}</span>
        </div>
        {
          <div className="github-profile-actions">
            <button
              type="button"
              ref={trigger}
              aria-expanded={editing}
              aria-controls="github-profile-editor"
              disabled={busy || !available}
              onClick={() => {
                if (editing) {
                  closeEditor()
                  return
                }
                setUsername(profile?.login || '')
                setError('')
                setEditing(true)
              }}
            >
              {profile ? '更换' : '关联'}
            </button>
            {profile && (
              <button type="button" disabled={busy} onClick={() => void unbind()}>
                解除
              </button>
            )}
          </div>
        }
      </div>
      {editing && (
        <form
          id="github-profile-editor"
          className="github-profile-form"
          onSubmit={(event) => {
            event.preventDefault()
            void bind()
          }}
        >
          <label htmlFor="github-display-username">GitHub 用户名</label>
          <div className="github-profile-input-row">
            <input
              id="github-display-username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="例如 octocat"
              autoComplete="off"
              spellCheck={false}
              maxLength={39}
              autoFocus
              disabled={busy}
              required
            />
            <button type="submit" disabled={busy || !username.trim()}>
              {busy ? '获取中…' : '保存展示'}
            </button>
            <button type="button" disabled={busy} onClick={closeEditor}>
              取消
            </button>
          </div>
          <p>
            将向 GitHub 查询此用户名的公开资料，并在本机保存头像和名称。仅用于展示，不验证账号归属。
          </p>
          {error && (
            <p className="github-profile-error" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
      {!available && <p className="github-profile-note">在桌面应用中关联公开资料。</p>}
      {!editing && error && (
        <p className="github-profile-error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
