import {
  appearancePreferencesSchema,
  defaultAppearancePreferences,
  MAX_WALLPAPER_BYTES,
  MAX_WALLPAPER_DIMENSION,
  MAX_WALLPAPER_PIXELS,
  type AppearancePreferences,
  type AppearanceSnapshot,
} from '../shared/appearance'

export const APPEARANCE_STORAGE_KEY = 'examcraft.appearance.v1'
/** Local storage is an optional renderer cache of non-private controls only. */
export function parseAppearancePreferences(serialized: string | null): AppearancePreferences {
  try {
    const parsed = appearancePreferencesSchema.safeParse(JSON.parse(serialized ?? 'null'))
    return parsed.success ? parsed.data : defaultAppearancePreferences()
  } catch {
    return defaultAppearancePreferences()
  }
}
export function resolveTheme(theme: AppearancePreferences['theme'], systemDark: boolean) {
  return theme === 'system' ? (systemDark ? 'dark' : 'light') : theme
}
export function safeWallpaperDataUrl(wallpaper: AppearanceSnapshot['wallpaper']): string | null {
  if (
    !wallpaper ||
    !Number.isSafeInteger(wallpaper.width) ||
    !Number.isSafeInteger(wallpaper.height) ||
    wallpaper.width < 1 ||
    wallpaper.height < 1 ||
    wallpaper.width > MAX_WALLPAPER_DIMENSION ||
    wallpaper.height > MAX_WALLPAPER_DIMENSION ||
    wallpaper.width * wallpaper.height > MAX_WALLPAPER_PIXELS ||
    typeof wallpaper.dataUrl !== 'string' ||
    wallpaper.dataUrl.length > Math.ceil(MAX_WALLPAPER_BYTES / 3) * 4 + 22 ||
    !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(wallpaper.dataUrl)
  )
    return null
  return wallpaper.dataUrl
}
export function wallpaperStyle(preferences: AppearancePreferences, image: string | null) {
  return {
    backgroundImage: image ? `url("${image}")` : 'none',
    backgroundPosition: preferences.wallpaper.position,
    backgroundSize: preferences.wallpaper.fit === 'tile' ? 'auto' : preferences.wallpaper.fit,
    backgroundRepeat: preferences.wallpaper.fit === 'tile' ? 'repeat' : 'no-repeat',
    opacity: preferences.wallpaper.opacity,
    filter: `blur(${preferences.wallpaper.blur}px)`,
  }
}
