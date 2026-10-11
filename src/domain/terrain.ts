import { z } from 'zod'
import type {
  TerrainContour,
  TerrainGrid,
  TerrainPoint,
  TerrainPreset,
  TerrainSpec,
} from '../shared/terrain'

export const TERRAIN_PRESETS: Record<TerrainPreset, string> = {
  peak: '山峰',
  depression: '洼地',
  ridge: '山脊',
  saddle: '鞍部',
  plane: '均匀斜坡',
}
export const DEFAULT_TERRAIN: TerrainSpec = {
  version: 1,
  preset: 'peak',
  widthM: 2000,
  heightM: 2000,
  baseElevationM: 100,
  reliefM: 400,
  contourIntervalM: 50,
  gridCells: 32,
}
export const terrainSpecSchema = z
  .strictObject({
    version: z.literal(1),
    preset: z.enum(['peak', 'depression', 'ridge', 'saddle', 'plane']),
    widthM: z.number().finite().min(100).max(20000),
    heightM: z.number().finite().min(100).max(20000),
    baseElevationM: z.number().finite().min(-500).max(8000),
    reliefM: z.number().finite().min(20).max(2000),
    contourIntervalM: z.number().finite().min(5).max(500),
    gridCells: z
      .number()
      .int()
      .min(16)
      .max(64)
      .refine((n) => n % 2 === 0, '网格边数必须为偶数'),
  })
  .superRefine((spec, ctx) => {
    if (spec.reliefM / spec.contourIntervalM > 60)
      ctx.addIssue({
        code: 'custom',
        path: ['contourIntervalM'],
        message: '等高线层数不得超过 60 层',
      })
    if (spec.widthM / spec.heightM > 4 || spec.heightM / spec.widthM > 4)
      ctx.addIssue({
        code: 'custom',
        path: ['widthM'],
        message: '教学图长宽比须在 1:4 至 4:1 之间',
      })
  }) satisfies z.ZodType<TerrainSpec>
const coordinate = z.number().finite().min(0).max(20000)
export const terrainPointSchema = z.strictObject({ xM: coordinate, yM: coordinate })
export const terrainToolInputSchema = z
  .strictObject({
    terrain: terrainSpecSchema,
    probes: z
      .array(
        z.strictObject({
          id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/),
          ...terrainPointSchema.shape,
        }),
      )
      .max(8)
      .optional(),
    profile: z
      .strictObject({
        from: terrainPointSchema,
        to: terrainPointSchema,
        samples: z.number().int().min(2).max(65).optional(),
      })
      .optional(),
  })
  .superRefine((value, ctx) => {
    const points = [
      ...(value.probes ?? []),
      ...(value.profile ? [value.profile.from, value.profile.to] : []),
    ]
    if (points.some((p) => p.xM > value.terrain.widthM || p.yM > value.terrain.heightM))
      ctx.addIssue({ code: 'custom', message: '点必须位于教学地形范围内' })
    if (new Set(value.probes?.map((p) => p.id)).size !== (value.probes?.length ?? 0))
      ctx.addIssue({ code: 'custom', path: ['probes'], message: '探测点 ID 必须唯一' })
    if (value.profile && distanceM(value.profile.from, value.profile.to) < 0.01)
      ctx.addIssue({ code: 'custom', path: ['profile'], message: '剖面两端至少相距 0.01 m' })
  })
export type TerrainToolInput = z.infer<typeof terrainToolInputSchema>
/** Canonical property order plus FNV-1a yields a stable local identity, not a security digest. */
function terrainId(spec: TerrainSpec): string {
  const text = JSON.stringify(spec)
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
  return `terrain-v1-${(hash >>> 0).toString(16).padStart(8, '0')}`
}
function heightAtNode(spec: TerrainSpec, xM: number, yM: number): number {
  const x = (2 * xM) / spec.widthM - 1,
    y = (2 * yM) / spec.heightM - 1
  const shapes: Record<TerrainPreset, number> = {
    peak: Math.max(0, 1 - x * x - y * y),
    depression: Math.min(1, x * x + y * y),
    ridge: Math.max(0, 1 - y * y - 0.15 * x * x),
    saddle: (x * x - y * y) / 2,
    plane: xM / spec.widthM,
  }
  return spec.baseElevationM + spec.reliefM * shapes[spec.preset]
}
/** The authoritative surface is a sampled, piecewise-linear triangulated grid.
 * Every square is split southwest–northeast. Probe, contour and profile use this
 * same surface; displayed contour lines are exact on it, approximate to the preset. */
export function createTerrain(input: unknown): TerrainGrid {
  const spec = terrainSpecSchema.parse(input)
  const elevations: number[] = []
  for (let y = 0; y <= spec.gridCells; y++)
    for (let x = 0; x <= spec.gridCells; x++)
      elevations.push(
        heightAtNode(spec, (x * spec.widthM) / spec.gridCells, (y * spec.heightM) / spec.gridCells),
      )
  return {
    spec,
    id: terrainId(spec),
    elevations,
    minimumM: Math.min(...elevations),
    maximumM: Math.max(...elevations),
    cellWidthM: spec.widthM / spec.gridCells,
    cellHeightM: spec.heightM / spec.gridCells,
  }
}
function checkPoint(grid: TerrainGrid, input: TerrainPoint): TerrainPoint {
  const point = terrainPointSchema.parse(input)
  if (point.xM > grid.spec.widthM || point.yM > grid.spec.heightM)
    throw new Error('探测点超出教学地形范围')
  return point
}
export function elevationAt(grid: TerrainGrid, input: TerrainPoint): number {
  const point = checkPoint(grid, input),
    n = grid.spec.gridCells
  const gx = point.xM / grid.cellWidthM,
    gy = point.yM / grid.cellHeightM
  const x = Math.min(n - 1, Math.floor(gx)),
    y = Math.min(n - 1, Math.floor(gy))
  const u = gx - x,
    v = gy - y,
    i = y * (n + 1) + x
  const a = grid.elevations[i],
    b = grid.elevations[i + 1]
  const c = grid.elevations[i + n + 2],
    d = grid.elevations[i + n + 1]
  return u >= v ? a + u * (b - a) + v * (c - b) : a + u * (c - d) + v * (d - a)
}
export function distanceM(a: TerrainPoint, b: TerrainPoint): number {
  return Math.hypot(b.xM - a.xM, b.yM - a.yM)
}
export function terrainProfile(
  grid: TerrainGrid,
  start: TerrainPoint,
  end: TerrainPoint,
  samples = 33,
) {
  const from = checkPoint(grid, start),
    to = checkPoint(grid, end)
  const distance = distanceM(from, to)
  if (distance < 0.01) throw new Error('剖面两端至少相距 0.01 m')
  if (!Number.isInteger(samples) || samples < 2 || samples > 65)
    throw new Error('剖面采样数量必须为 2 至 65')
  const points = Array.from({ length: samples }, (_, index) => {
    const t = index / (samples - 1)
    const point = { xM: from.xM + (to.xM - from.xM) * t, yM: from.yM + (to.yM - from.yM) * t }
    return { ...point, distanceM: distance * t, elevationM: elevationAt(grid, point) }
  })
  const elevationChangeM = points.at(-1)!.elevationM - points[0].elevationM
  return {
    from,
    to,
    horizontalDistanceM: distance,
    elevationChangeM,
    meanSignedGradePercent: (100 * elevationChangeM) / distance,
    meanSignedAngleDegrees: (Math.atan2(elevationChangeM, distance) * 180) / Math.PI,
    /** Sampled profile extrema, explicitly not a claimed continuous global extremum. */
    sampledMinimumM: Math.min(...points.map((p) => p.elevationM)),
    sampledMaximumM: Math.max(...points.map((p) => p.elevationM)),
    points,
  }
}
export function contourLevels(grid: TerrainGrid): number[] {
  const interval = grid.spec.contourIntervalM
  const first = Math.ceil(grid.minimumM / interval - 1e-10)
  const last = Math.floor(grid.maximumM / interval + 1e-10)
  return Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => (first + i) * interval)
}
type Node = TerrainPoint & { id: number; z: number }
type Intersection = TerrainPoint & { key: string }
/** Marching triangles avoids ambiguous saddle-cell pairings. Shared vertex/edge
 * keys, exact-level handling, and edge deduplication preserve topology. Critical
 * vertices may legitimately have >2 branches; they are retained, never smoothed. */
export function terrainContours(grid: TerrainGrid): TerrainContour[] {
  const n = grid.spec.gridCells
  const nodes: Node[] = grid.elevations.map((z, id) => ({
    id,
    z,
    xM: (id % (n + 1)) * grid.cellWidthM,
    yM: Math.floor(id / (n + 1)) * grid.cellHeightM,
  }))
  const contours: TerrainContour[] = []
  let segmentCount = 0
  for (const level of contourLevels(grid)) {
    const vertices = new Map<string, Intersection>()
    const edges: [string, string][] = []
    const seen = new Set<string>()
    const vertex = (node: Node): Intersection => ({ key: `v${node.id}`, xM: node.xM, yM: node.yM })
    const intersect = (a: Node, b: Node): Intersection => {
      if (a.z === level) return vertex(a)
      if (b.z === level) return vertex(b)
      // Canonical order makes shared-edge interpolation bitwise identical.
      if (a.id > b.id) [a, b] = [b, a]
      const t = (level - a.z) / (b.z - a.z)
      return { key: `e${a.id}-${b.id}`, xM: a.xM + t * (b.xM - a.xM), yM: a.yM + t * (b.yM - a.yM) }
    }
    const add = (a: Intersection, b: Intersection) => {
      if (a.key === b.key || distanceM(a, b) < 1e-9) return
      const key = [a.key, b.key].sort().join(':')
      if (seen.has(key)) return
      if (++segmentCount > 30000) throw new Error('等高线几何超过安全复杂度限制')
      seen.add(key)
      vertices.set(a.key, a)
      vertices.set(b.key, b)
      edges.push([a.key, b.key])
    }
    const triangle = (a: Node, b: Node, c: Node) => {
      const tri = [a, b, c],
        equal = tri.filter((p) => p.z === level)
      if (equal.length === 3) return // Flat interiors do not have a unique contour.
      if (equal.length === 2) {
        add(vertex(equal[0]), vertex(equal[1]))
        return
      }
      const crossings = new Map<string, Intersection>()
      for (let i = 0; i < 3; i++) {
        const p = tri[i],
          q = tri[(i + 1) % 3]
        if ((p.z <= level && q.z >= level) || (q.z <= level && p.z >= level)) {
          const hit = intersect(p, q)
          crossings.set(hit.key, hit)
        }
      }
      if (crossings.size === 2) {
        const [p, q] = [...crossings.values()]
        add(p, q)
      }
    }
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const i = y * (n + 1) + x
        triangle(nodes[i], nodes[i + 1], nodes[i + n + 2])
        triangle(nodes[i], nodes[i + n + 2], nodes[i + n + 1])
      }
    const adjacency = new Map<string, number[]>()
    edges.forEach(([a, b], index) => {
      for (const key of [a, b]) adjacency.set(key, [...(adjacency.get(key) ?? []), index])
    })
    const used = new Set<number>()
    const follow = (start: string, initial: number) => {
      const keys = [start]
      let current = start,
        edge = initial
      while (!used.has(edge)) {
        used.add(edge)
        const [a, b] = edges[edge]
        current = a === current ? b : a
        keys.push(current)
        const next = adjacency.get(current)!
        if (current === start || next.length !== 2) break
        const unvisited = next.find((candidate) => !used.has(candidate))
        if (unvisited === undefined) break
        edge = unvisited
      }
      contours.push({
        id: `${grid.id}-c${contours.length}`,
        elevationM: level,
        points: keys.map((key) => ({ xM: vertices.get(key)!.xM, yM: vertices.get(key)!.yM })),
        closed: current === start,
      })
    }
    for (const [key, incident] of adjacency)
      if (incident.length !== 2) for (const edge of incident) if (!used.has(edge)) follow(key, edge)
    edges.forEach(([a], edge) => {
      if (!used.has(edge)) follow(a, edge)
    })
  }
  return contours
}
/** A bounded structured tool result, with no dense grid, executable content,
 * reference question, personal state, file paths, or external-resource access. */
export function executeTerrainTool(input: unknown) {
  const parsed = terrainToolInputSchema.parse(input),
    grid = createTerrain(parsed.terrain)
  return {
    id: grid.id,
    kind: 'synthetic-teaching-terrain' as const,
    terrain: grid.spec,
    units: { horizontal: 'm', elevation: 'm', slope: '%', angle: 'degrees' },
    method: 'piecewise-linear-triangles; southwest-northeast grid diagonals',
    disclaimer:
      '模拟教学地形，非实测 DEM；坐标为局部米制平面，非经纬度。剖面均坡为端点高差/水平距离，不是路径各处坡度。',
    resolution: { xM: grid.cellWidthM, yM: grid.cellHeightM },
    minimumM: grid.minimumM,
    maximumM: grid.maximumM,
    contourLevelsM: contourLevels(grid),
    probes: (parsed.probes ?? []).map((point) => ({
      ...point,
      elevationM: elevationAt(grid, { xM: point.xM, yM: point.yM }),
    })),
    ...(parsed.profile
      ? {
          profile: terrainProfile(
            grid,
            parsed.profile.from,
            parsed.profile.to,
            parsed.profile.samples,
          ),
        }
      : {}),
  }
}
