import { describe, it, expect } from 'vitest'
import { boardStyle, emptyGeoboard } from '../src/shared/geoboard-types'
import type { BoardPoint, BoardObject, GeoboardState } from '../src/shared/geoboard-types'
import {
  solveGeoboard,
  movePoint,
  intersections,
  polygonMetrics,
  removeNodes,
  transformedCopy,
  snapPosition,
  BoardHistory,
  assertGeoboard,
} from '../src/domain/geoboard'
const free = (id: string, x: number, y: number): Extract<BoardPoint, { kind: 'free' }> => ({
  id,
  ...boardStyle(id),
  kind: 'free',
  x,
  y,
  locked: false,
})
const fixture = (): GeoboardState => ({
  ...emptyGeoboard(),
  points: [free('O', 0, 0), free('A', 3, 0), free('P', 5, 0)],
  objects: [{ id: 'c', ...boardStyle('C'), kind: 'circle', center: 'O', through: 'A' }],
})
const tangents = (): GeoboardState => {
  const s = fixture()
  for (const branch of [0, 1] as const)
    s.objects.push({
      id: `t${branch}`,
      ...boardStyle(),
      kind: 'tangent',
      point: 'P',
      circle: 'c',
      branch,
    })
  return s
}
const point = (s: GeoboardState, id: string) => {
  const r = solveGeoboard(s).values.get(id)
  if (r?.type !== 'point') throw new Error(`Missing point ${id}`)
  return r.p
}
describe('dynamic geometry numerical kernel', () => {
  it('recomputes a midpoint without mutating its source', () => {
    const s = fixture()
    s.points.push({ id: 'M', ...boardStyle(), kind: 'midpoint', a: 'O', b: 'A' })
    const bytes = JSON.stringify(s)
    expect(point(movePoint(s, 'A', { x: 8, y: 2 }), 'M')).toEqual({ x: 4, y: 1 })
    expect(JSON.stringify(s)).toBe(bytes)
  })
  it('both tangents remain tangent under 200 deterministic point moves', () => {
    const original = tangents()
    for (let i = 0; i < 200; i++) {
      const t = i * 0.39,
        d = 3.2 + (i % 17) / 3
      const s = movePoint(original, 'P', { x: d * Math.cos(t), y: d * Math.sin(t) })
      const r = solveGeoboard(s)
      expect(r.errors.size).toBe(0)
      for (const id of ['t0', 't1']) {
        const l = r.values.get(id)
        expect(l?.type).toBe('line')
        if (l?.type === 'line') expect(Math.abs(l.p.x * l.d.y - l.p.y * l.d.x)).toBeCloseTo(3, 8)
      }
    }
  })
  it('hides interior tangents and recovers their original definitions', () => {
    const s = tangents(),
      inside = movePoint(s, 'P', { x: 1, y: 0 })
    expect(solveGeoboard(inside).errors.size).toBe(2)
    expect(solveGeoboard(movePoint(inside, 'P', { x: 5, y: 0 })).errors.size).toBe(0)
    expect(inside.objects).toEqual(s.objects)
  })
  it('deduplicates tangency and respects segment bounds', () => {
    const circle = { type: 'circle' as const, center: { x: 0, y: 0 }, radius: 5 }
    expect(
      intersections(
        { type: 'line', p: { x: 0, y: 5 }, d: { x: 1, y: 0 }, min: -Infinity, max: Infinity },
        circle,
      ),
    ).toEqual([{ x: 0, y: 5 }])
    expect(
      intersections({ type: 'line', p: { x: 0, y: 0 }, d: { x: 1, y: 0 }, min: 0, max: 2 }, circle),
    ).toEqual([])
  })
  it('computes circle-circle intersections satisfying both equations', () => {
    const ps = intersections(
      { type: 'circle', center: { x: 0, y: 0 }, radius: 5 },
      { type: 'circle', center: { x: 6, y: 0 }, radius: 5 },
    )
    expect(ps).toHaveLength(2)
    for (const p of ps) {
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(5, 9)
      expect(Math.hypot(p.x - 6, p.y)).toBeCloseTo(5, 9)
    }
  })
  it('rejects a unique answer for concentric or coincident circles', () => {
    for (const radius of [3, 5])
      expect(
        intersections(
          { type: 'circle', center: { x: 0, y: 0 }, radius: 5 },
          { type: 'circle', center: { x: 0, y: 0 }, radius },
        ),
      ).toEqual([])
  })
  it('projects a dragged circle point back to its circumference', () => {
    const s = fixture()
    s.points.push({ id: 'Q', ...boardStyle(), kind: 'on-object', object: 'c', parameter: 0 })
    const q = point(movePoint(s, 'Q', { x: 8, y: 8 }), 'Q')
    expect(Math.hypot(q.x, q.y)).toBeCloseTo(3, 9)
  })
  it('preserves the fractional position of a segment-bound point', () => {
    const s = fixture()
    s.objects.push({ id: 's', ...boardStyle(), kind: 'segment', from: 'O', to: 'A' })
    s.points.push({ id: 'Q', ...boardStyle(), kind: 'on-object', object: 's', parameter: 0.5 })
    expect(point(movePoint(s, 'A', { x: 8, y: 4 }), 'Q')).toEqual({ x: 4, y: 2 })
  })
  it('deletes dependent circles and tangents without changing the old state', () => {
    const s = tangents(),
      before = JSON.stringify(s)
    expect(removeNodes(s, ['O']).objects).toEqual([])
    expect(JSON.stringify(s)).toBe(before)
  })
  it('returns ordinary area only for simple polygons', () => {
    expect(
      polygonMetrics([
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 3 },
        { x: 0, y: 3 },
      ]),
    ).toEqual({ area: 12, perimeter: 14, simple: true })
    expect(
      polygonMetrics([
        { x: 0, y: 0 },
        { x: 4, y: 3 },
        { x: 4, y: 0 },
        { x: 0, y: 3 },
      ]).area,
    ).toBeNull()
  })
  it('transformed copies do not move the source circle', () => {
    let n = 0
    const s = fixture()
    const result = transformedCopy(
      s,
      'c',
      { pivot: { x: 0, y: 0 }, dx: 2, dy: 1, angle: 90, scale: 2, reflect: false },
      () => `copy-${++n}`,
    )
    const circle = solveGeoboard(result).values.get(result.objects.at(-1)!.id)
    expect(circle).toEqual({ type: 'circle', center: { x: 2, y: 1 }, radius: 6 })
    expect(result.objects[0]).toEqual(s.objects[0])
  })
  it('locked points cannot be dragged', () => {
    const s = fixture()
    s.points[0] = { ...free('O', 0, 0), locked: true }
    expect(() => movePoint(s, 'O', { x: 2, y: 2 })).toThrow(/锁定/)
  })
  it('undo restores a whole scene and a new commit clears redo', () => {
    const s = fixture(),
      h = new BoardHistory(s)
    h.commit(movePoint(s, 'P', { x: 8, y: 2 }))
    expect(h.undo()).toEqual(s)
    h.commit(movePoint(s, 'P', { x: 9, y: 1 }))
    expect(h.canRedo).toBe(false)
    h.reset(emptyGeoboard())
    expect(h.canUndo).toBe(false)
  })
  it('fractional square and triangular snapping agree with peg positions', () => {
    const v = { ...emptyGeoboard().view, step: 0.25 }
    expect(snapPosition({ x: 0.36, y: 0.51 }, v)).toEqual({ x: 0.25, y: 0.5 })
    const p = snapPosition({ x: 0.4, y: 0.2 }, { ...v, grid: 'isometric' })
    expect(p.y / ((0.25 * Math.sqrt(3)) / 2)).toBeCloseTo(1, 6)
  })
  it('rejects a cyclic dependent graph', () => {
    const s = fixture()
    s.points[0] = { id: 'O', ...boardStyle(), kind: 'on-object', object: 'c', parameter: 0 }
    expect(() => assertGeoboard(s)).toThrow(/循环/)
  })
  it('keeps collinear three-point circles as recoverable data', () => {
    const s = fixture()
    const c: BoardObject = {
      id: 'three',
      ...boardStyle(),
      kind: 'circumcircle',
      a: 'O',
      b: 'A',
      c: 'P',
    }
    s.objects.push(c)
    assertGeoboard(s)
    expect(solveGeoboard(s).errors.has('three')).toBe(true)
    expect(solveGeoboard(movePoint(s, 'P', { x: 0, y: 3 })).errors.has('three')).toBe(false)
  })
})
