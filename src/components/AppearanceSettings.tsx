import { useMemo } from 'react'
import type { AppearanceController } from './useAppearance'
import { safeWallpaperDataUrl, wallpaperStyle } from '../domain/appearance'

export function WallpaperLayer({ appearance }: { appearance: AppearanceController }) {
  const image = useMemo(() => safeWallpaperDataUrl(appearance.wallpaper), [appearance.wallpaper])
  return image ? (
    <div
      className="workspace-wallpaper"
      aria-hidden="true"
      data-testid="workspace-wallpaper"
      style={wallpaperStyle(appearance.preferences, image)}
    />
  ) : null
}
export function AppearanceSettings({ appearance }: { appearance: AppearanceController }) {
  const { preferences, wallpaper, loading, busy } = appearance
  const controlsDisabled = loading || busy
  const setWallpaper = (patch: Partial<typeof preferences.wallpaper>) =>
    appearance.update({ ...preferences, wallpaper: { ...preferences.wallpaper, ...patch } })
  return (
    <section
      id="appearance-settings"
      className="appearance-settings card"
      aria-labelledby="appearance-title"
      tabIndex={-1}
    >
      <div className="appearance-heading">
        <div>
          <span className="eyebrow">APPEARANCE</span>
          <h2 id="appearance-title">外观与本地壁纸</h2>
        </div>
        <span className="appearance-current">
          当前：{appearance.resolvedTheme === 'dark' ? '深色' : '浅色'}
        </span>
      </div>
      <p className="appearance-help">让工作台保持专注，也留一点自己的风格。设置自动保存在本机。</p>
      <fieldset disabled={controlsDisabled} className="appearance-theme">
        <legend>界面主题</legend>
        {(
          [
            ['system', '跟随系统', '自动随系统切换'],
            ['light', '浅色', '明亮纸面'],
            ['dark', '深色', '柔和暗色'],
          ] as const
        ).map(([value, label, description]) => (
          <label
            key={value}
            className={`appearance-theme-option ${preferences.theme === value ? 'selected' : ''}`}
          >
            <input
              type="radio"
              name="appearance-theme"
              value={value}
              checked={preferences.theme === value}
              onChange={() => appearance.update({ ...preferences, theme: value })}
            />
            <span>
              <strong>{label}</strong>
              <small>{description}</small>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="appearance-wallpaper-heading">
        <h3>本地壁纸</h3>
        <span className="appearance-help">
          {wallpaper ? `${wallpaper.width} × ${wallpaper.height} · 私有副本` : '未设置壁纸'}
        </span>
      </div>
      <p className="appearance-help" id="wallpaper-privacy">
        只从本机选择 PNG、JPEG 或静态 WebP。最大 10 MiB、8192 像素长边、2400
        万像素。不上传、不发送给模型，也不写入学习导出或模型调试记录。
      </p>
      <div className="appearance-actions">
        <button
          type="button"
          disabled={controlsDisabled || !appearance.nativeAvailable}
          onClick={appearance.choose}
          aria-describedby="wallpaper-privacy"
        >
          {busy ? '正在处理…' : wallpaper ? '更换本地图片' : '选择本地图片'}
        </button>
        <button type="button" disabled={controlsDisabled || !wallpaper} onClick={appearance.remove}>
          移除壁纸
        </button>
      </div>
      {!appearance.nativeAvailable && (
        <p className="appearance-help">浏览器预览可切换主题；选择本机壁纸需要桌面版。</p>
      )}
      <fieldset className="appearance-wallpaper-controls" disabled={controlsDisabled || !wallpaper}>
        <legend>壁纸显示</legend>
        <label>
          不透明度 <output>{Math.round(preferences.wallpaper.opacity * 100)}%</output>
          <input
            aria-label="壁纸不透明度"
            type="range"
            min="0"
            max="35"
            step="1"
            value={Math.round(preferences.wallpaper.opacity * 100)}
            onChange={(event) => setWallpaper({ opacity: Number(event.target.value) / 100 })}
          />
        </label>
        <label>
          模糊 <output>{preferences.wallpaper.blur} px</output>
          <input
            aria-label="壁纸模糊"
            type="range"
            min="0"
            max="24"
            step="1"
            value={preferences.wallpaper.blur}
            onChange={(event) => setWallpaper({ blur: Number(event.target.value) })}
          />
        </label>
        <label>
          位置
          <select
            aria-label="壁纸位置"
            value={preferences.wallpaper.position}
            onChange={(event) =>
              setWallpaper({
                position: event.target.value as typeof preferences.wallpaper.position,
              })
            }
          >
            {(
              [
                ['center', '居中'],
                ['top', '顶部'],
                ['bottom', '底部'],
                ['left', '靠左'],
                ['right', '靠右'],
              ] as const
            ).map(([value, label]) => (
              <option value={value} key={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          填充方式
          <select
            aria-label="壁纸填充方式"
            value={preferences.wallpaper.fit}
            onChange={(event) =>
              setWallpaper({ fit: event.target.value as typeof preferences.wallpaper.fit })
            }
          >
            <option value="cover">填满（裁切边缘）</option>
            <option value="contain">完整显示</option>
            <option value="tile">平铺</option>
          </select>
        </label>
      </fieldset>
      <p className="appearance-help">
        壁纸位于工作区背景；题目、作答、图表与弹窗保持不透明，确保文字清晰。恢复默认只删除应用保存的壁纸副本，保留原图片。
      </p>
      <div className="appearance-actions">
        <button type="button" disabled={loading} onClick={appearance.reset}>
          恢复默认外观
        </button>
        <span className="appearance-help" role="status">
          {loading ? '正在读取外观…' : appearance.saving ? '正在保存…' : appearance.notice}
        </span>
      </div>
      {appearance.error && (
        <p className="appearance-error" role="alert">
          {appearance.error}
        </p>
      )}
    </section>
  )
}
