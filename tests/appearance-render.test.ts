import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AppearanceSettings, WallpaperLayer } from '../src/components/AppearanceSettings'
import type { AppearanceController } from '../src/components/useAppearance'
import { defaultAppearancePreferences } from '../src/shared/appearance'

const controller = (overrides: Partial<AppearanceController> = {}): AppearanceController => ({
  preferences: defaultAppearancePreferences(),
  resolvedTheme: 'light',
  wallpaper: null,
  loading: false,
  busy: false,
  saving: false,
  notice: '',
  error: '',
  nativeAvailable: true,
  update: vi.fn(),
  choose: vi.fn(),
  remove: vi.fn(),
  reset: vi.fn(),
  ...overrides,
})
const render = (overrides: Partial<AppearanceController> = {}) =>
  renderToStaticMarkup(createElement(AppearanceSettings, { appearance: controller(overrides) }))

describe('appearance settings static rendering', () => {
  it('presents an accessible named section and three native radio options with no default wallpaper', () => {
    const html = render()
    expect(html).toContain('id="appearance-settings"')
    expect(html).toContain('aria-labelledby="appearance-title"')
    expect(html).toContain('tabindex="-1"')
    expect(html.match(/type="radio"/g)).toHaveLength(3)
    expect(html).toMatch(/type="radio" name="appearance-theme" checked="" value="system"/)
    expect(html).toContain('未设置壁纸')
    expect(html).toContain('不上传、不发送给模型')
    expect(renderToStaticMarkup(createElement(WallpaperLayer, { appearance: controller() }))).toBe(
      '',
    )
  })
  it('clearly disables a native-only chooser in browser preview while keeping theme controls available', () => {
    const html = render({ nativeAvailable: false })
    expect(html).toContain('浏览器预览可切换主题；选择本机壁纸需要桌面版。')
    expect(html).toMatch(
      /<button type="button" disabled="" aria-describedby="wallpaper-privacy">选择本地图片/,
    )
    expect(html).not.toMatch(/<fieldset disabled="" class="appearance-theme"/)
  })
  it('labels bounded opacity, blur, position, and fit controls; reset remains reachable during selection', () => {
    const wallpaper = { dataUrl: 'data:image/png;base64,iVBORw0KGgo=', width: 1, height: 1 }
    const html = render({ wallpaper })
    for (const label of ['壁纸不透明度', '壁纸模糊', '壁纸位置', '壁纸填充方式'])
      expect(html).toContain(`aria-label="${label}"`)
    expect(html).toContain('max="35"')
    expect(html).toContain('max="24"')
    expect(html).toContain('value="cover"')
    expect(html).toContain('value="contain"')
    expect(html).toContain('value="tile"')
    const busy = render({ busy: true })
    expect(busy).toContain('<button type="button">恢复默认外观</button>')
    expect(busy).toContain('正在处理…')
  })
  it('renders a noninteractive decorative image layer and rejects any external/image-script URL', () => {
    const good = renderToStaticMarkup(
      createElement(WallpaperLayer, {
        appearance: controller({
          wallpaper: { width: 1, height: 1, dataUrl: 'data:image/png;base64,AA==' },
        }),
      }),
    )
    expect(good).toContain('aria-hidden="true"')
    expect(good).toContain('data-testid="workspace-wallpaper"')
    expect(good).toContain('opacity:0.16')
    expect(good).toContain('background-size:cover')
    for (const dataUrl of [
      'https://invalid.example/photo.png',
      'file:///private/photo.png',
      'data:image/svg+xml,<svg/>',
    ])
      expect(
        renderToStaticMarkup(
          createElement(WallpaperLayer, {
            appearance: controller({ wallpaper: { width: 1, height: 1, dataUrl } }),
          }),
        ),
      ).toBe('')
  })
  it('announces progress/errors without using raw HTML', () => {
    expect(render({ saving: true })).toContain('正在保存…')
    const html = render({ error: 'Synthetic <unsafe> error', notice: 'Already reset' })
    expect(html).toContain('role="alert"')
    expect(html).toContain('Synthetic &lt;unsafe&gt; error')
    expect(html).toContain('role="status"')
  })
})

const css = readFileSync(new URL('../src/components/appearance.css', import.meta.url), 'utf8')
const declarations = (selector: string) => {
  const block = css.slice(css.indexOf(selector)).split('}')[0]
  return Object.fromEntries(
    [...block.matchAll(/(--[\w-]+):\s*(#[\da-f]{6});/g)].map((match) => [match[1], match[2]]),
  )
}
const luminance = (hex: string) => {
  const values = [1, 3, 5]
    .map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722
}
function contrast(a: string, b: string) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (values[0] + 0.05) / (values[1] + 0.05)
}

describe('theme token and security regression checks (not live visual QA)', () => {
  it.each([':root {', ":root[data-theme='dark'] {"])(
    'keeps readable primary/muted/accent/status text in %s',
    (selector) => {
      const colors = declarations(selector)
      for (const text of ['--app-text', '--app-muted', '--app-accent'])
        for (const surface of [
          '--app-background',
          '--app-surface',
          '--app-surface-muted',
          '--app-input',
        ])
          expect(
            contrast(colors[text], colors[surface]),
            `${selector}: ${text} on ${surface}`,
          ).toBeGreaterThanOrEqual(4.5)
      for (const [foreground, background] of [
        ['--app-success', '--app-success-soft'],
        ['--app-warning-text', '--app-warning-soft'],
        ['--app-error', '--app-error-soft'],
        ['--plot-label', '--plot-background'],
      ])
        expect(contrast(colors[foreground], colors[background])).toBeGreaterThanOrEqual(4.5)
      expect(contrast('#ffffff', colors['--app-accent-solid'])).toBeGreaterThanOrEqual(4.5)
    },
  )
  it('keeps semantic chart colors distinct, protects panels, and supports high contrast/reduced motion', () => {
    expect(css).toContain('pointer-events: none')
    expect(css).toContain('prefers-reduced-motion: reduce')
    expect(css).toContain('forced-colors: active')
    expect(css).toContain('background: var(--app-surface)')
    expect(css).toContain('color-scheme: dark')
    expect(css).toContain('.math-projections .math-projection-label')
    expect(css).toContain('.free-group-handle')
    expect(css).toContain('--geo-admin-text:')
    expect(css).not.toMatch(/filter:\s*invert/)
  })
  it('keeps wallpaper IPC sender-validated and uses no new URL scheme/CSP exemption', () => {
    const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8')
    const preload = readFileSync(new URL('../electron/preload.ts', import.meta.url), 'utf8')
    expect(main).toContain('validateSender(event)')
    expect(main).toContain("handle('examcraft:choose-wallpaper'")
    expect(preload).toContain(
      "chooseWallpaper: () => ipcRenderer.invoke('examcraft:choose-wallpaper')",
    )
    expect(main).toContain('nativeImage.createFromBuffer(bytes)')
    expect(main).toContain('image.toPNG()')
    expect(main).not.toContain('registerFileProtocol')
    expect(main).not.toContain('webSecurity: false')
  })
})
