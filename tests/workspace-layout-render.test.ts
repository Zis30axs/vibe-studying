import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { PanelDivider } from '../src/components/PanelDivider'
import { PANEL_LIMITS } from '../src/domain/workspace-layout'

// Static markup coverage only; browser specs exercise keyboard, pointer capture, and cleanup.
describe('workspace panel separator rendering', () => {
  it.each([
    ['navigation', '调整导航栏宽度', 'workspace-navigation', false],
    ['questions', '调整题目列表宽度', 'workspace-questions', false],
    ['tools', '调整工具面板宽度', 'workspace-tools', true],
  ] as const)(
    'exposes a focusable, named vertical separator for %s',
    (panel, label, controls, reverse) => {
      const limits = PANEL_LIMITS[panel]
      const onResize = vi.fn()
      const onReset = vi.fn()
      const html = renderToStaticMarkup(
        createElement(PanelDivider, {
          label,
          controls,
          value: limits.default,
          min: limits.min,
          max: limits.max,
          reverse,
          onResize,
          onReset,
        }),
      )
      expect(html).toContain('class="panel-divider"')
      expect(html.match(/role="separator"/g)).toHaveLength(1)
      expect(html).toContain('tabindex="0"')
      expect(html).toContain(`aria-label="${label}"`)
      expect(html).toContain('aria-orientation="vertical"')
      expect(html).toContain(`aria-controls="${controls}"`)
      expect(html).toContain(`aria-valuemin="${limits.min}"`)
      expect(html).toContain(`aria-valuemax="${limits.max}"`)
      expect(html).toContain(`aria-valuenow="${limits.default}"`)
      expect(html).toContain(`aria-valuetext="${limits.default} 像素；`)
      expect(html).not.toContain('aria-hidden="true"')
      expect(html).not.toContain('disabled=')
      expect(onResize).not.toHaveBeenCalled()
      expect(onReset).not.toHaveBeenCalled()
    },
  )

  it('provides readable keyboard instructions and a pointer-reset hint', () => {
    const html = renderToStaticMarkup(
      createElement(PanelDivider, {
        label: '调整工具面板宽度',
        controls: 'workspace-tools',
        value: 440,
        min: 340,
        max: 960,
        onResize: () => {},
        onReset: () => {},
      }),
    )
    expect(html).toContain('方向键调整')
    expect(html).toContain('Shift 加速')
    expect(html).toContain('Home / End 最小 / 最大')
    expect(html).toContain('Enter 重置')
    expect(html).toContain('title="调整工具面板宽度 · 拖动或方向键调整 · 双击重置"')
  })

  it.each([
    [340, 340],
    [440.49, 440],
    [440.5, 441],
    [960, 960],
  ])('announces the rendered width %s consistently as %i pixels', (value, expected) => {
    const html = renderToStaticMarkup(
      createElement(PanelDivider, {
        label: '调整工具面板宽度',
        controls: 'workspace-tools',
        value,
        min: 340,
        max: 960,
        reverse: true,
        onResize: () => {},
        onReset: () => {},
      }),
    )
    expect(html).toContain(`aria-valuenow="${expected}"`)
    expect(html).toContain(`aria-valuetext="${expected} 像素；`)
  })

  it('escapes labels and controlled IDs without changing separator semantics', () => {
    const html = renderToStaticMarkup(
      createElement(PanelDivider, {
        label: '调整 "题目" & 工具 <宽度>',
        controls: 'panel-"quoted"',
        value: 224,
        min: 190,
        max: 380,
        onResize: () => {},
        onReset: () => {},
      }),
    )
    expect(html).toContain('aria-label="调整 &quot;题目&quot; &amp; 工具 &lt;宽度&gt;"')
    expect(html).toContain('aria-controls="panel-&quot;quoted&quot;"')
    expect(html).toContain('role="separator"')
    expect(html).not.toContain('<宽度>')
  })
})
