import { useEffect, useRef, useState } from 'react'
import {
  APPEARANCE_STORAGE_KEY,
  parseAppearancePreferences,
  resolveTheme,
  safeWallpaperDataUrl,
} from '../domain/appearance'
import {
  defaultAppearancePreferences,
  type AppearancePreferences,
  type AppearanceSnapshot,
} from '../shared/appearance'

function cachedPreferences() {
  try {
    return parseAppearancePreferences(window.localStorage.getItem(APPEARANCE_STORAGE_KEY))
  } catch {
    return defaultAppearancePreferences()
  }
}
function prefersDark() {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  )
}
export function useAppearance() {
  const [preferences, setPreferences] = useState(cachedPreferences)
  const preferencesRef = useRef(preferences)
  const [wallpaper, setWallpaper] = useState<AppearanceSnapshot['wallpaper']>(null)
  const [systemDark, setSystemDark] = useState(prefersDark)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const operation = useRef(0)
  const mounted = useRef(false)
  const api = typeof window !== 'undefined' ? window.examcraft : undefined
  const nativeAvailable =
    typeof api?.getAppearance === 'function' &&
    typeof api?.saveAppearance === 'function' &&
    typeof api?.chooseWallpaper === 'function' &&
    typeof api?.removeWallpaper === 'function' &&
    typeof api?.resetAppearance === 'function'
  function apply(snapshot: AppearanceSnapshot) {
    const next = parseAppearancePreferences(JSON.stringify(snapshot.preferences))
    setPreferences(next)
    preferencesRef.current = next
    setWallpaper(safeWallpaperDataUrl(snapshot.wallpaper) ? snapshot.wallpaper : null)
    setNotice(snapshot.warning ?? '')
  }
  useEffect(() => {
    mounted.current = true
    if (!nativeAvailable) {
      setLoading(false)
      return () => {
        mounted.current = false
      }
    }
    let active = true
    void api!
      .getAppearance()
      .then((snapshot) => {
        if (active) apply(snapshot)
      })
      .catch(() => {
        if (active) setError('无法读取本地外观，暂用缓存主题。可重试或恢复默认。')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => setSystemDark(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  const resolvedTheme = resolveTheme(preferences.theme, systemDark)
  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme
    document.documentElement.style.colorScheme = resolvedTheme
    try {
      window.localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(preferences))
    } catch {
      /* Optional cache contains only preferences; main-process persistence remains authoritative. */
    }
  }, [preferences, resolvedTheme])
  function update(next: AppearancePreferences) {
    const clean = parseAppearancePreferences(JSON.stringify(next))
    setPreferences(clean)
    preferencesRef.current = clean
    setError('')
    const current = ++operation.current
    if (!nativeAvailable) return
    setSaving(true)
    // Invoke immediately so the main process tracks pending writes even when the window closes.
    void api!
      .saveAppearance(clean)
      .then(() => {
        if (mounted.current && current === operation.current) setNotice('外观已保存。')
      })
      .catch(() => {
        if (mounted.current && current === operation.current)
          setError('外观尚未保存。请检查本机存储空间，再调整设置重试。')
      })
      .finally(() => {
        if (mounted.current && current === operation.current) setSaving(false)
      })
  }
  async function act(action: 'choose' | 'remove' | 'reset') {
    if (loading || !nativeAvailable || (busy && action !== 'reset')) return
    const current = ++operation.current
    setBusy(true)
    setSaving(false)
    setError('')
    try {
      // Preserve the currently displayed controls when replacing or removing a wallpaper.
      if (action !== 'reset') await api!.saveAppearance(preferencesRef.current)
      if (current !== operation.current) return
      const result = action === 'choose' ? await api!.chooseWallpaper() : null
      const snapshot = result
        ? result.appearance
        : action === 'remove'
          ? await api!.removeWallpaper()
          : await api!.resetAppearance()
      if (mounted.current && current === operation.current) {
        apply(snapshot)
        if (!snapshot.warning)
          setNotice(
            result?.canceled
              ? '已取消选择，原壁纸保持不变。'
              : action === 'reset'
                ? '已恢复默认主题并移除本机壁纸副本。'
                : action === 'remove'
                  ? '已移除本机壁纸副本，原图片保留。'
                  : '壁纸已保存到本机。',
          )
      }
    } catch (reason) {
      if (mounted.current && current === operation.current) {
        // Main process already strips local paths and decoder details; never display unknown raw errors.
        const message =
          reason instanceof Error
            ? reason.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
            : ''
        setError(
          /^(请选择|请先完成|图片|无法保存|无法重置|无法处理)/.test(message)
            ? message
            : '本地壁纸操作失败，请重新选择图片或重试。',
        )
      }
    } finally {
      if (mounted.current && current === operation.current) setBusy(false)
    }
  }
  function reset() {
    if (nativeAvailable) void act('reset')
    else {
      update(defaultAppearancePreferences())
      setWallpaper(null)
      setNotice('已恢复默认外观。')
    }
  }
  return {
    preferences,
    resolvedTheme,
    wallpaper,
    loading,
    busy,
    saving,
    notice,
    error,
    nativeAvailable,
    update,
    choose: () => void act('choose'),
    remove: () => void act('remove'),
    reset,
  }
}
export type AppearanceController = ReturnType<typeof useAppearance>
