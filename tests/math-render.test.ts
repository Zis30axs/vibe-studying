import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MathWorkbench } from '../src/components/MathWorkbench'
import { emptyMathState } from '../src/shared/types'

// Complements browser interactions; does not claim to execute event handlers or Electron IPC.
describe('math expression renderer', () => {
  it.each([
    ['y = 2x+1', '2*x+1'],
    ['2(x+1)', '2*(x+1)'],
    ['(x+1)(x-1)', '(x+1)*(x-1)'],
    ['ax^2+bx+c', 'a*x^2+b*x+c'],
  ])('shows the parsed form of %s with a plotted curve', (expression, normalized) => {
    const html = renderToStaticMarkup(
      createElement(MathWorkbench, {
        value: { ...emptyMathState(), expression },
        onChange: () => {},
      }),
    )
    expect(html).toContain(`识别为：y = ${normalized}`)
    expect(html).toContain('data-testid="function-curve"')
    expect(html).toContain('aria-invalid="false"')
    expect(html).toContain('aria-describedby=')
    expect(html).toContain('函数必须加括号')
    expect(html).not.toContain('暂无法解析')
  })
  it('keeps readonly saved snapshots disabled and displays their normalized interpretation', () => {
    const html = renderToStaticMarkup(
      createElement(MathWorkbench, {
        value: { ...emptyMathState(), expression: '2sin(x)' },
        disabled: true,
        onChange: () => {},
      }),
    )
    expect(html).toContain('识别为：y = 2*sin(x)')
    expect(html).toMatch(/<input[^>]*aria-label="函数表达式"[^>]*disabled=""/)
    expect(html).toContain('a*sin(b*x)+c')
    expect(html).toContain('a/(x-b)+c')
  })
  it('renders no curve for an empty expression and explains how to clear it', () => {
    const html = renderToStaticMarkup(
      createElement(MathWorkbench, {
        value: { ...emptyMathState(), expression: '' },
        onChange: () => {},
      }),
    )
    expect(html).not.toContain('data-testid="function-curve"')
    expect(html).toContain('留空后应用可清除函数，保留几何图形。')
    expect(html).toContain('aria-invalid="false"')
  })
  it('shows default canvas settings and distance projections for marked points without hover', () => {
    const value = emptyMathState()
    value.drawing.points = [{ id: 'p', label: 'P', x: -2, y: -3 }]
    const html = renderToStaticMarkup(createElement(MathWorkbench, { value, onChange: () => {} }))
    expect(html).toContain('data-testid="math-projection-x"')
    expect(html).toContain('stroke="#b8c0c8"')
    expect(html).toContain('stroke-dasharray="4 4"')
    expect(html).toContain('到 x 轴 3')
    expect(html).toContain('到 y 轴 2')
    expect(html).toContain('坐标吸附步长')
    expect(html).toContain('显示轴距投影（I）')
    expect(html).toContain('pointer-events="none"')
    const hidden = renderToStaticMarkup(
      createElement(MathWorkbench, {
        value: { ...value, showProjections: false },
        onChange: () => {},
      }),
    )
    expect(hidden).not.toContain('data-testid="math-projection-x"')
  })
})
