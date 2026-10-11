import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GeometryFigure, projectGeometryPoint } from '../src/components/GeometryFigure'
import { GeometryWorkbench } from '../src/components/GeometryWorkbench'
import { MathWorkbench, constructPerpendicularState } from '../src/components/MathWorkbench'
import { emptyMathState } from '../src/shared/types'
import { mathWorkbenchSchema } from '../src/domain/schemas'
import type { GeometryScene } from '../src/shared/geometry'

const scene: GeometryScene = {
  version: 1,
  kind: 'geometry-3d',
  title: '空间三角形',
  points: [
    { id: 'A', label: 'A', x: 0, y: 0, z: 0 },
    { id: 'B', label: 'B', x: 7, y: 0, z: 0 },
    { id: 'C', label: 'C', x: 0, y: 0, z: 11 },
  ],
  segments: [
    { id: 'AB', from: 'A', to: 'B' },
    { id: 'AC', from: 'A', to: 'C', dashed: true },
  ],
  faces: [{ id: 'ABC', points: ['A', 'B', 'C'] }],
  rightAngles: [{ id: 'rightA', vertex: 'A', from: 'B', to: 'C' }],
}
describe('geometry display', () => {
  it('renders three real axes, faces, explicit hidden edges and validated right-angle markers without answer metrics', () => {
    const html = renderToStaticMarkup(createElement(GeometryFigure, { scene }))
    expect(html).toContain('data-testid="geometry-face"')
    expect(html).toContain('data-testid="geometry-right-angle"')
    expect(html).toContain('stroke-dasharray="6 5"')
    for (const axis of ['x', 'y', 'z']) expect(html).toContain(`>${axis}</text>`)
    expect(html).toContain('方位角')
    expect(html).toContain('投影后的长度、角度不能直接用于空间计算')
    expect(html).not.toContain('(0, 0, 11)')
    expect(html).not.toContain('90°')
    expect(html).not.toContain('sqrt')
    expect(html).not.toContain('参考答案')
  })
  it('projects z numerically and changes projection only when the camera changes', () => {
    const view = { azimuth: 45, elevation: 25 }
    const a = projectGeometryPoint({ x: 1, y: 2, z: 0 }, view)
    const b = projectGeometryPoint({ x: 1, y: 2, z: 3 }, view)
    expect(a.x).toBeCloseTo(b.x)
    expect(a.y).not.toBeCloseTo(b.y)
    expect(a.depth).not.toBeCloseTo(b.depth)
    expect(projectGeometryPoint({ x: 1, y: 2, z: 3 }, { azimuth: 0, elevation: 0 })).toEqual({
      x: 1,
      y: -3,
      depth: 2,
    })
  })
  it('fails closed on invalid scenes and false right-angle claims', () => {
    const invalid = {
      ...scene,
      points: scene.points.map((p) => (p.id === 'C' ? { ...p, x: 1 } : p)),
    }
    const html = renderToStaticMarkup(createElement(GeometryFigure, { scene: invalid }))
    expect(html).toContain('三维几何格式无效')
    expect(html).not.toContain('<svg')
  })
  it('supports empty scratch scenes and disabled controls without changing old math drafts', () => {
    const old = emptyMathState()
    const before = JSON.stringify(old)
    const html = renderToStaticMarkup(
      createElement(MathWorkbench, { value: old, onChange: () => {}, disabled: true }),
    )
    expect(html).toContain('三维坐标工作台')
    expect(html).toContain('三维 Z 坐标')
    expect(html).not.toContain('三维几何格式无效')
    expect(JSON.stringify(old)).toBe(before)
    const standalone = renderToStaticMarkup(
      createElement(GeometryWorkbench, { value: scene, onChange: () => {}, disabled: true }),
    )
    expect(standalone).toMatch(/<fieldset[^>]*disabled=""[^>]*class="geometry-editors"/)
  })
  it('only renders persisted 2D right angles when current coordinates still support them', () => {
    const value = {
      ...emptyMathState(),
      drawing: {
        mode: 'cartesian' as const,
        points: scene.points.map(({ z: _z, ...p }) => ({ ...p, y: p.id === 'C' ? 5 : 0 })),
        lines: [],
      },
      rightAngles: [{ id: 'right-a', vertex: 'A', from: 'B', to: 'C' }],
    }
    const render = () =>
      renderToStaticMarkup(createElement(MathWorkbench, { value, onChange: () => {} }))
    expect(render()).toContain('data-testid="math-right-angle"')
    value.drawing.points[2].x = 2
    expect(render()).not.toContain('data-testid="math-right-angle"')
  })
})

describe('perpendicular construction UI state', () => {
  function draft(a: number[], b: number[], p: number[]) {
    return {
      ...emptyMathState(),
      drawing: {
        mode: 'cartesian' as const,
        points: [a, b, p].map(([x, y], i) => ({
          id: ['A', 'B', 'P'][i],
          label: ['A', 'B', 'P'][i],
          x,
          y,
        })),
        lines: [],
      },
    }
  }
  const selection = { point: 'P', from: 'A', to: 'B' }
  it.each([
    [
      [-3, 0],
      [3, 0],
      [1, 4],
      [1, 0],
    ],
    [
      [0, -3],
      [0, 3],
      [4, 1],
      [0, 1],
    ],
    [
      [-2, -2],
      [2, 2],
      [0, 4],
      [2, 2],
    ],
    [
      [0, 0],
      [1, 0],
      [3, 2],
      [3, 0],
    ],
  ])('builds schema-valid point/line/marker state from full GeoPoint objects', (a, b, p, foot) => {
    const value = draft(a, b, p)
    const before = JSON.stringify(value)
    const result = constructPerpendicularState(value, selection)
    expect(result.foot.x).toBeCloseTo(foot[0])
    expect(result.foot.y).toBeCloseTo(foot[1])
    expect(mathWorkbenchSchema.safeParse(result.state).success).toBe(true)
    expect(JSON.stringify(value)).toBe(before)
    const repeat = constructPerpendicularState(result.state, selection)
    expect(repeat.state.drawing.points.length).toBe(result.state.drawing.points.length)
    expect(repeat.state.drawing.lines.length).toBe(result.state.drawing.lines.length)
    expect(repeat.state.rightAngles!.length).toBe(1)
  })
  it.each([
    [
      [0, 0],
      [10, 10],
      [9.9, 9.9],
    ],
    [
      [-3, 0],
      [3, 0],
      [0, 0],
    ],
  ])('builds nonzero on-line perpendiculars even near the boundary', (a, b, p) => {
    const result = constructPerpendicularState(draft(a, b, p), selection)
    const angle = result.state.rightAngles![0]
    const endpoint = result.state.drawing.points.find((point) => point.id === angle.to)!
    expect(Math.hypot(endpoint.x - result.foot.x, endpoint.y - result.foot.y)).toBeGreaterThan(0)
    expect(Math.abs(endpoint.x)).toBeLessThanOrEqual(10)
    expect(Math.abs(endpoint.y)).toBeLessThanOrEqual(10)
    expect(mathWorkbenchSchema.safeParse(result.state).success).toBe(true)
  })
  it('rejects coincident endpoints, out-of-frame feet and impossible tangent corner segments', () => {
    expect(() => constructPerpendicularState(draft([1, 1], [1, 1], [2, 2]), selection)).toThrow(
      '不能重合',
    )
    expect(() =>
      constructPerpendicularState(draft([-10, 9], [-9, 10], [10, 10]), selection),
    ).toThrow('垂足超出')
    expect(() => constructPerpendicularState(draft([0, 0], [10, 10], [10, 10]), selection)).toThrow(
      '边界点',
    )
  })
  it('bounds persisted markers independently of point and line limits', () => {
    const value = {
      ...draft([-3, 0], [3, 0], [1, 4]),
      rightAngles: Array.from({ length: 100 }, (_, i) => ({
        id: `r-${i}`,
        vertex: 'A',
        from: 'B',
        to: 'P',
      })),
    }
    expect(() => constructPerpendicularState(value, selection)).toThrow('100 个直角标记')
  })
})
