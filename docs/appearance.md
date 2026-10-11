# Appearance and private local wallpapers

ExamCraft 0.4.0 adds an **外观** shortcut in the top bar, opening **外观与本地壁纸** in the settings view.

- Choose **跟随系统**, **浅色**, or **深色**. System mode responds to OS changes while the app is running.
- **选择本地图片** uses the desktop's native file picker. PNG, JPEG, and static WebP are accepted, up to 10 MiB, 8192 pixels on either edge, and 24 million pixels total. The normalized PNG must also fit the byte limit. Animated WebP, SVG, remote URLs, symlinks, special files, and unsupported formats are rejected.
- Set opacity (0–35%), blur (0–24 px), position, and cover/contain/tile. Defaults are system theme, no wallpaper, and 16% opacity for a newly selected image.
- Wallpaper appears behind the workspace. Editing surfaces, questions, dialogs, and charts retain opaque, theme-aware backgrounds for readable text. Source PDF/terrain pixels are not inverted. Forced-colors and printing hide decorative wallpaper; reduced-motion removes UI transitions.
- **移除壁纸** keeps theme/controls; **恢复默认外观** resets them and removes app-owned image/temp copies. Both leave the user's original image untouched. Cancelling a picker leaves the previous wallpaper unchanged.
- Browser preview supports theme controls. The native local-file picker is available only in the desktop app.

## Storage and boundaries

Settings and a private, metadata-stripped PNG copy live under the app profile's `appearance/` directory, separate from learning data. Files are atomically written with private permissions where supported. An asset identifier rather than the original image path is stored. The original can be moved or removed without breaking the app-owned copy. Only non-sensitive theme/display controls are cached in renderer local storage.

The Electron main process checks input size, magic bytes, and dimensions before decoding, rejects animated/inconsistent WebP containers, then uses Electron's decoder to validate and re-encode the image as PNG. The renderer receives only a bounded PNG data URI; it cannot pass an arbitrary file path or URL to the wallpaper IPC. Existing sender validation, sandboxing, web security, and CSP stay unchanged.

Appearance does not enter question/answer state, model provider payloads, learning exports, or model debug records. Corrupt/missing copies are hidden with a warning; corrupt preferences fall back to defaults and can be reset. Reset invalidates older pending selections so a late chooser result cannot restore a removed wallpaper. Rapid setting changes serialize in order and are tracked by the existing app-close write drain; saving a slider value does not decode or transmit image data again.

## Verification

- Unit/adapter and static-render tests cover schema bounds, safe data representations, theme resolution, text contrast tokens, raster-header rejection, private persistence/restart, metadata/path separation, corrupt/missing files, reset/chooser ordering, rapid setting saves, directory symlinks, and owned-copy-only cleanup.
- `tests/browser/appearance.spec.ts` covers theme/OS changes, renderer restart, controls, chooser interruption/error, keyboard/narrow layouts, and forced colors with synthetic IPC fixtures.
- `tests/e2e/appearance.spec.ts` covers the actual Electron decoder, IPC, native chooser result handling, app-owned files, original-image movement, and restart.
- Browser/Electron execution requires a GUI-capable host. Test collection and typechecking do not establish that those interactive tests passed. In this implementation environment Chromium launch is blocked by socket `EPERM` and Electron GUI execution is unavailable; live screenshots and native interactive appearance verification remain outstanding.
