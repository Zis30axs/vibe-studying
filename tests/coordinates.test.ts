import { describe, expect, it } from 'vitest'
import type { GeoDrawing } from '../src/shared/types'
import {
  CANVAS,
  canConnectPoints,
  clientToCoordinate,
  coordinateToSvg,
  isValidCoordinate,
  removeDrawingPoint,
} from '../src/domain/coordinates'

describe('drawing coordinate transforms', () => {
  it.each(['cartesian', 'geographic'] as const)(
    'round trips %s coordinates through a resized and offset SVG',
    (mode) => {
      const point = mode === 'geographic' ? { x: 120, y: 30 } : { x: -3.25, y: 7.5 }
      const svg = coordinateToSvg(point, mode)
      const rect = { left: 100, top: 200, width: 400, height: 240 }
      expect(
        clientToCoordinate({ x: rect.left + svg.x / 2, y: rect.top + svg.y / 2 }, rect, mode),
      ).toEqual(point)
    },
  )

  it('accounts for horizontal and vertical letterboxing', () => {
    const svg = coordinateToSvg({ x: 4, y: -2 }, 'cartesian')
    expect(
      clientToCoordinate(
        { x: 200 + svg.x, y: svg.y },
        { left: 0, top: 0, width: 1200, height: 480 },
        'cartesian',
      ),
    ).toEqual({ x: 4, y: -2 })
    expect(
      clientToCoordinate(
        { x: svg.x, y: 240 + svg.y },
        { left: 0, top: 0, width: 800, height: 960 },
        'cartesian',
      ),
    ).toEqual({ x: 4, y: -2 })
  })

  it('includes the exact boundary and rejects margins, zero-size canvases and nonfinite input', () => {
    const rect = { left: 0, top: 0, width: 800, height: 480 }
    expect(clientToCoordinate({ x: CANVAS.left, y: CANVAS.top }, rect, 'geographic')).toEqual({
      x: -180,
      y: 90,
    })
    expect(clientToCoordinate({ x: CANVAS.right, y: CANVAS.bottom }, rect, 'geographic')).toEqual({
      x: 180,
      y: -90,
    })
    expect(clientToCoordinate({ x: CANVAS.left - 1, y: 100 }, rect, 'cartesian')).toBeNull()
    expect(clientToCoordinate({ x: 100, y: 10 }, rect, 'cartesian')).toBeNull()
    expect(clientToCoordinate({ x: 100, y: 100 }, { ...rect, width: 0 }, 'cartesian')).toBeNull()
    expect(clientToCoordinate({ x: NaN, y: 100 }, rect, 'cartesian')).toBeNull()
  })

  it('validates mode bounds without silently clamping manual input', () => {
    expect(isValidCoordinate({ x: 180, y: -90 }, 'geographic')).toBe(true)
    expect(isValidCoordinate({ x: 181, y: 0 }, 'geographic')).toBe(false)
    expect(isValidCoordinate({ x: 11, y: 0 }, 'cartesian')).toBe(false)
    expect(isValidCoordinate({ x: Infinity, y: 0 }, 'cartesian')).toBe(false)
  })
})

describe('point and edge integrity', () => {
  const drawing: GeoDrawing = {
    mode: 'cartesian',
    points: [
      { id: 'a', label: 'A', x: 1, y: 2 },
      { id: 'b', label: 'B', x: 3, y: 4 },
      { id: 'c', label: 'C', x: 5, y: 6 },
    ],
    lines: [
      { id: 'ab', from: 'a', to: 'b' },
      { id: 'bc', from: 'b', to: 'c' },
    ],
  }
  it('removes all incident edges while keeping the original drawing for undo', () => {
    const next = removeDrawingPoint(drawing, 'b')
    expect(next.points.map((point) => point.id)).toEqual(['a', 'c'])
    expect(next.lines).toEqual([])
    expect(drawing.points).toHaveLength(3)
    expect(drawing.lines).toHaveLength(2)
  })
  it('rejects duplicate undirected edges, self-loops and missing points', () => {
    expect(canConnectPoints(drawing, 'a', 'c')).toBe(true)
    expect(canConnectPoints(drawing, 'b', 'a')).toBe(false)
    expect(canConnectPoints(drawing, 'a', 'a')).toBe(false)
    expect(canConnectPoints(drawing, 'a', 'missing')).toBe(false)
  })
})
