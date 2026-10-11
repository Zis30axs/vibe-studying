import { z } from 'zod'

export const MAX_WALLPAPER_BYTES = 10 * 1024 * 1024
export const MAX_WALLPAPER_PIXELS = 24_000_000
export const MAX_WALLPAPER_DIMENSION = 8192
export const appearancePreferencesSchema = z
  .object({
    version: z.literal(1),
    theme: z.enum(['system', 'light', 'dark']),
    wallpaper: z
      .object({
        opacity: z.number().min(0).max(0.35),
        blur: z.number().min(0).max(24),
        position: z.enum(['center', 'top', 'bottom', 'left', 'right']),
        fit: z.enum(['cover', 'contain', 'tile']),
      })
      .strict(),
  })
  .strict()
export type AppearancePreferences = z.infer<typeof appearancePreferencesSchema>
export const defaultAppearancePreferences = (): AppearancePreferences => ({
  version: 1,
  theme: 'system',
  wallpaper: { opacity: 0.16, blur: 0, position: 'center', fit: 'cover' },
})
export interface AppearanceSnapshot {
  preferences: AppearancePreferences
  /** A main-process validated/re-encoded PNG, never an arbitrary URL or local path. */
  wallpaper: { dataUrl: string; width: number; height: number } | null
  warning?: string
}
export interface AppearanceApi {
  getAppearance(): Promise<AppearanceSnapshot>
  saveAppearance(preferences: AppearancePreferences): Promise<AppearancePreferences>
  chooseWallpaper(): Promise<{ canceled: boolean; appearance: AppearanceSnapshot }>
  removeWallpaper(): Promise<AppearanceSnapshot>
  resetAppearance(): Promise<AppearanceSnapshot>
}
