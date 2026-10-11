import { describe, expect, it } from 'vitest'
import {
  parseAppearancePreferences,
  resolveTheme,
  safeWallpaperDataUrl,
  wallpaperStyle,
} from '../src/domain/appearance'
import { appearancePreferencesSchema, defaultAppearancePreferences } from '../src/shared/appearance'

describe('non-sensitive appearance preferences', () => {
  it('defaults to the system theme with gentle wallpaper controls', () => {
    expect(defaultAppearancePreferences()).toEqual({
      version: 1,
      theme: 'system',
      wallpaper: { opacity: 0.16, blur: 0, position: 'center', fit: 'cover' },
    })
    expect(parseAppearancePreferences(null)).toEqual(defaultAppearancePreferences())
  })
  it.each([
    'not json',
    '{}',
    'null',
    '{"version":2}',
    '{"version":1,"theme":"file:///private/image"}',
  ])('recovers from corrupt cache %s', (value) => {
    expect(parseAppearancePreferences(value)).toEqual(defaultAppearancePreferences())
  })
  it('allows only bounded controls, never paths, URL, image bytes, or other hidden fields', () => {
    const defaults = defaultAppearancePreferences()
    for (const theme of ['light', 'dark', 'system'])
      expect(appearancePreferencesSchema.safeParse({ ...defaults, theme }).success).toBe(true)
    for (const patch of [
      { opacity: -1 },
      { opacity: 1 },
      { opacity: NaN },
      { blur: Infinity },
      { blur: 100 },
      { fit: 'url(https://invalid.example)' },
      { position: 'fixed' },
      { filePath: '/private/photo.png' },
      { dataUrl: 'data:image/png;base64,PRIVATE' },
    ]) {
      expect(
        appearancePreferencesSchema.safeParse({
          ...defaults,
          wallpaper: { ...defaults.wallpaper, ...patch },
        }).success,
      ).toBe(false)
    }
    expect(
      appearancePreferencesSchema.safeParse({ ...defaults, filePath: '/private/photo.png' })
        .success,
    ).toBe(false)
  })
  it('resolves explicit and OS-driven theme changes', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })
  it('accepts only bounded PNG data representations for rendering', () => {
    const safe = { width: 1, height: 1, dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }
    expect(safeWallpaperDataUrl(safe)).toBe(safe.dataUrl)
    for (const dataUrl of [
      'https://invalid.example/wallpaper.png',
      'file:///private/photo.png',
      'data:image/svg+xml,<svg/>',
      'data:image/png;base64,abc");url(https://invalid.example)',
      'data:image/png;base64,',
    ]) {
      expect(safeWallpaperDataUrl({ ...safe, dataUrl })).toBeNull()
    }
    for (const dimensions of [
      { width: 0 },
      { width: 8193 },
      { width: 5000, height: 5000 },
      { width: NaN },
      { height: 1.2 },
    ])
      expect(safeWallpaperDataUrl({ ...safe, ...dimensions })).toBeNull()
    expect(safeWallpaperDataUrl(null)).toBeNull()
  })
  it('supports all image positioning and fit controls without using file URLs', () => {
    const preferences = defaultAppearancePreferences()
    expect(wallpaperStyle(preferences, null).backgroundImage).toBe('none')
    expect(
      wallpaperStyle(
        {
          ...preferences,
          wallpaper: {
            ...preferences.wallpaper,
            fit: 'tile',
            position: 'right',
            opacity: 0.35,
            blur: 24,
          },
        },
        'data:image/png;base64,AA==',
      ),
    ).toEqual({
      backgroundImage: 'url("data:image/png;base64,AA==")',
      backgroundPosition: 'right',
      backgroundSize: 'auto',
      backgroundRepeat: 'repeat',
      opacity: 0.35,
      filter: 'blur(24px)',
    })
  })
})
