import { describe, expect, it } from 'vitest'
import {
  createTerrain,
  contourLevels,
  DEFAULT_TERRAIN,
  elevationAt,
  executeTerrainTool,
  terrainContours,
  terrainProfile,
  terrainSpecSchema,
  terrainToolInputSchema,
} from '../src/domain/terrain'

const plane = () =>
  createTerrain({
    ...DEFAULT_TERRAIN,
    preset: 'plane',
    widthM: 1000,
    heightM: 1000,
    baseElevationM: 0,
    reliefM: 100,
    contourIntervalM: 10,
  })
describe('deterministic teaching terrain arithmetic', () => {
  it('uses exact same piecewise-linear plane for elevation, contours and profile units', () => {
    const grid = plane()
    expect(elevationAt(grid, { xM: 125, yM: 375 })).toBe(12.5)
    expect(elevationAt(grid, { xM: 1000, yM: 1000 })).toBe(100)
    expect(elevationAt(grid, { xM: 0, yM: 0 })).toBe(0)
    const profile = terrainProfile(grid, { xM: 0, yM: 250 }, { xM: 1000, yM: 250 }, 5)
    expect(profile.points.map((p) => p.elevationM)).toEqual([0, 25, 50, 75, 100])
    expect(profile.horizontalDistanceM).toBe(1000)
    expect(profile.elevationChangeM).toBe(100)
    expect(profile.meanSignedGradePercent).toBe(10)
    expect(profile.meanSignedAngleDegrees).toBeCloseTo(5.710593, 6)
    const reverse = terrainProfile(grid, profile.to, profile.from)
    expect(reverse.meanSignedGradePercent).toBe(-10)
    expect(reverse.points[0]).toMatchObject({ xM: 1000, yM: 250, distanceM: 0, elevationM: 100 })
    expect(reverse.points.at(-1)).toMatchObject({ xM: 0, yM: 250, distanceM: 1000, elevationM: 0 })
  })
  it('keeps stable identities and deterministic outputs independent of input property order', () => {
    const a = createTerrain(DEFAULT_TERRAIN),
      b = createTerrain(Object.fromEntries(Object.entries(DEFAULT_TERRAIN).reverse()))
    expect(a).toEqual(b)
    expect(createTerrain({ ...DEFAULT_TERRAIN, contourIntervalM: 100 }).id).not.toBe(a.id)
    expect(terrainContours(a)).toEqual(terrainContours(b))
  })
  it('samples known peak, depression, ridge and saddle elevations', () => {
    const at = (preset: typeof DEFAULT_TERRAIN.preset, xM: number, yM: number) =>
      elevationAt(createTerrain({ ...DEFAULT_TERRAIN, preset }), { xM, yM })
    expect(at('peak', 1000, 1000)).toBe(500)
    expect(at('peak', 0, 0)).toBe(100)
    expect(at('depression', 1000, 1000)).toBe(100)
    expect(at('depression', 0, 0)).toBe(500)
    expect(at('ridge', 1000, 1000)).toBe(500)
    expect(at('ridge', 0, 1000)).toBe(440)
    expect(at('saddle', 1000, 1000)).toBe(100)
    expect(at('saddle', 0, 1000)).toBe(300)
    expect(at('saddle', 1000, 0)).toBe(-100)
  })
  it('distinguishes level endpoints from a flat profile and computes Euclidean horizontal distance', () => {
    const grid = createTerrain(DEFAULT_TERRAIN)
    const p = terrainProfile(grid, { xM: 250, yM: 1000 }, { xM: 1750, yM: 1000 })
    expect(p.meanSignedGradePercent).toBe(0)
    expect(p.sampledMaximumM).toBe(500)
    expect(p.sampledMaximumM).toBeGreaterThan(p.points[0].elevationM)
    expect(terrainProfile(grid, { xM: 0, yM: 0 }, { xM: 300, yM: 400 }).horizontalDistanceM).toBe(
      500,
    )
  })
  it('returns compact evidence with explicit units rather than dense grids', () => {
    const result = executeTerrainTool({
      terrain: DEFAULT_TERRAIN,
      probes: [{ id: 'summit', xM: 1000, yM: 1000 }],
      profile: { from: { xM: 0, yM: 1000 }, to: { xM: 1000, yM: 1000 }, samples: 3 },
    })
    expect(result.probes[0].elevationM).toBe(500)
    expect(result.units).toEqual({ horizontal: 'm', elevation: 'm', slope: '%', angle: 'degrees' })
    expect(result.resolution).toEqual({ xM: 62.5, yM: 62.5 })
    expect(result).not.toHaveProperty('elevations')
    expect(result).not.toHaveProperty('contours')
    expect(JSON.stringify(result).length).toBeLessThan(4000)
  })
})
describe('marching-triangle contour topology', () => {
  it('produces noncrossing straight contour lines at the correct levels on a plane', () => {
    const grid = plane(),
      contours = terrainContours(grid)
    expect(contourLevels(grid)).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100])
    expect(contours).toHaveLength(11)
    for (const contour of contours) {
      expect(contour.closed).toBe(false)
      expect(contour.points[0].yM).toBe(0)
      expect(contour.points.at(-1)!.yM).toBe(1000)
      for (const p of contour.points) {
        expect(p.xM).toBeCloseTo(contour.elevationM * 10, 9)
        expect(elevationAt(grid, p)).toBeCloseTo(contour.elevationM, 9)
      }
    }
  })
  it('creates closed, nested peak contours and preserves exact vertex intersections', () => {
    const grid = createTerrain(DEFAULT_TERRAIN)
    const lines = terrainContours(grid).filter((p) => p.elevationM > 100 && p.elevationM < 500)
    expect(lines).toHaveLength(7)
    for (const line of lines) {
      expect(line.closed).toBe(true)
      expect(line.points[0]).toEqual(line.points.at(-1))
      const edgeSet = new Set<string>()
      for (let i = 1; i < line.points.length; i++) {
        expect(line.points[i]).not.toEqual(line.points[i - 1])
        const key = [JSON.stringify(line.points[i - 1]), JSON.stringify(line.points[i])]
          .sort()
          .join(':')
        expect(edgeSet.has(key)).toBe(false)
        edgeSet.add(key)
        expect(elevationAt(grid, line.points[i])).toBeCloseTo(line.elevationM, 8)
      }
    }
    // Vertex-level crossings cannot create spurious four-armed branches on this hill.
    expect(lines.every((l) => l.closed)).toBe(true)
  })
  it('has no proper crossings between noncritical peak contour segments', () => {
    const lines = terrainContours(createTerrain({ ...DEFAULT_TERRAIN, gridCells: 16 })).filter(
      (l) => l.elevationM > 100 && l.elevationM < 500,
    )
    const segments = lines.flatMap((line) =>
      line.points.slice(1).map((point, i) => [line.points[i], point] as const),
    )
    const orient = (
      a: { xM: number; yM: number },
      b: { xM: number; yM: number },
      c: { xM: number; yM: number },
    ) => (b.xM - a.xM) * (c.yM - a.yM) - (b.yM - a.yM) * (c.xM - a.xM)
    for (let i = 0; i < segments.length; i++)
      for (let j = i + 1; j < segments.length; j++) {
        const [a, b] = segments[i],
          [c, d] = segments[j]
        const crosses =
          orient(a, b, c) * orient(a, b, d) < -1e-8 && orient(c, d, a) * orient(c, d, b) < -1e-8
        expect(crosses).toBe(false)
      }
  })
  it('handles a critical saddle without ambiguous cell pairings or fabricated bridges', () => {
    const grid = createTerrain({ ...DEFAULT_TERRAIN, preset: 'saddle' })
    const lines = terrainContours(grid)
    for (const line of lines)
      for (const p of line.points) expect(elevationAt(grid, p)).toBeCloseTo(line.elevationM, 8)
    const critical = lines.filter((line) => line.elevationM === 100)
    expect(critical).toHaveLength(4)
    for (const line of critical)
      expect(line.points.some((p) => p.xM === 1000 && p.yM === 1000)).toBe(true)
  })
  it('bounds maximum valid terrain computation', () => {
    const grid = createTerrain({
      ...DEFAULT_TERRAIN,
      reliefM: 1920,
      contourIntervalM: 32,
      gridCells: 64,
    })
    const contours = terrainContours(grid)
    expect(contours.flatMap((c) => c.points).length).toBeLessThan(30000)
    expect(contours.length).toBeGreaterThan(50)
  })
})
describe('terrain safety bounds', () => {
  it.each([NaN, Infinity, -Infinity, 0, -1, 0.1, 501])(
    'rejects unsafe contour interval %s',
    (contourIntervalM) => {
      expect(terrainSpecSchema.safeParse({ ...DEFAULT_TERRAIN, contourIntervalM }).success).toBe(
        false,
      )
    },
  )
  it('rejects huge or nonfinite terrain, code, extra fields, duplicate probes and invalid sections', () => {
    for (const value of [
      { ...DEFAULT_TERRAIN, gridCells: 128 },
      { ...DEFAULT_TERRAIN, gridCells: 17 },
      { ...DEFAULT_TERRAIN, widthM: Infinity },
      { ...DEFAULT_TERRAIN, widthM: 20000, heightM: 100 },
      { ...DEFAULT_TERRAIN, reliefM: 2000, contourIntervalM: 5 },
      { ...DEFAULT_TERRAIN, formula: 'process.exit()' },
      { ...DEFAULT_TERRAIN, preset: '<svg>' },
    ])
      expect(terrainSpecSchema.safeParse(value).success).toBe(false)
    for (const extra of [
      {
        probes: [
          { id: 'x', xM: 1, yM: 1 },
          { id: 'x', xM: 2, yM: 2 },
        ],
      },
      { probes: [{ id: 'x', xM: 2001, yM: 0 }] },
      { profile: { from: { xM: 0, yM: 0 }, to: { xM: 0, yM: 0 } } },
      { profile: { from: { xM: 0, yM: 0 }, to: { xM: 100, yM: 100 }, samples: 1000000 } },
    ])
      expect(terrainToolInputSchema.safeParse({ terrain: DEFAULT_TERRAIN, ...extra }).success).toBe(
        false,
      )
    expect(() => elevationAt(plane(), { xM: -1, yM: 0 })).toThrow()
    expect(() => terrainProfile(plane(), { xM: 0, yM: 0 }, { xM: 0, yM: 0 })).toThrow()
  })
})
