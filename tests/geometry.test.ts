import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { executeGeometryTool, GeometryError, perpendicular2D } from '../src/domain/geometry'
import {
  GEOMETRY_LIMITS,
  arePerpendicular,
  geometrySceneSchema,
  geometryToolInputSchema,
  type GeometryRequest,
  type GeometryScene,
  type Vec3,
} from '../src/shared/geometry'

const v = (x: number, y: number, z = 0): Vec3 => ({ x, y, z })
const origin = v(0, 0, 0)
const run = (request: GeometryRequest) => executeGeometryTool({ request })
const diff = (a: Vec3, b: Vec3) => v(a.x - b.x, a.y - b.y, a.z - b.z)
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z
const expectPoint = (actual: Vec3, expected: Vec3) => {
  expect(actual.x).toBeCloseTo(expected.x, 10)
  expect(actual.y).toBeCloseTo(expected.y, 10)
  expect(actual.z).toBeCloseTo(expected.z, 10)
}
const scene = (): GeometryScene => ({
  version: 1,
  kind: 'geometry-3d',
  title: 'A true 3D triangle',
  points: [
    { id: 'A', label: 'A', ...v(0, 0, 0) },
    { id: 'B', label: 'B', ...v(3, 0, 0) },
    { id: 'C', label: 'C', ...v(0, 0, 4) },
  ],
  segments: [
    { id: 'AB', from: 'A', to: 'B' },
    { id: 'BC', from: 'B', to: 'C', dashed: true },
    { id: 'CA', from: 'C', to: 'A' },
  ],
  faces: [{ id: 'ABC', points: ['A', 'B', 'C'] }],
  rightAngles: [{ id: 'rightA', vertex: 'A', from: 'B', to: 'C' }],
})

describe('bounded deterministic geometry operations', () => {
  it('exposes an object-shaped MCP input schema and machine-readable operation alternatives', () => {
    expect(geometryToolInputSchema.shape.request).toBeDefined()
    const schema = z.toJSONSchema(geometryToolInputSchema)
    expect(schema.type).toBe('object')
    expect(schema.additionalProperties).toBe(false)
    expect(JSON.stringify(schema)).toContain('tetrahedron_volume')
  })

  it('computes dot products, norms, cosine and the vector angle from independent known values', () => {
    const result = run({ operation: 'vector_metrics', a: v(1, 2, 2), b: v(2, -1, 2) })
    expect(result.operation).toBe('vector_metrics')
    if (result.operation !== 'vector_metrics') return
    expect(result.dot).toBe(4)
    expect(result.normA).toBe(3)
    expect(result.normB).toBe(3)
    expect(result.cosine).toBeCloseTo(4 / 9, 13)
    expect(result.angleDegrees).toBeCloseTo((Math.acos(4 / 9) * 180) / Math.PI, 11)
    expect(result.orthogonal).toBe(false)
  })

  it.each([
    [v(3, 0), v(0, -7), 90, true],
    [v(3, 0), v(-7, 0), 180, false],
    [v(3, 0), v(7, 0), 0, false],
  ] as const)(
    'distinguishes right, antiparallel and parallel vectors',
    (a, b, angle, orthogonal) => {
      const result = run({ operation: 'vector_metrics', a, b })
      expect(result).toMatchObject({ angleDegrees: angle, orthogonal })
    },
  )

  it('computes the foot on an infinite line rather than clamping to its segment', () => {
    const result = run({
      operation: 'point_line_foot',
      point: v(7, 4, -3),
      a: v(1, 2, 3),
      b: v(2, 2, 3),
    })
    if (result.operation !== 'point_line_foot') throw new Error('Wrong result type')
    expectPoint(result.foot, v(7, 2, 3))
    expect(result.distance).toBeCloseTo(Math.sqrt(40), 12)
    expect(result.direction).toEqual(v(1, 0, 0))
  })

  it('checks the foot against two independent line equations in oblique 3D', () => {
    const a = v(2, -3, 4),
      b = v(5, 1, 9),
      point = v(10, -2, 7)
    const result = run({ operation: 'point_line_foot', point, a, b })
    if (result.operation !== 'point_line_foot') throw new Error('Wrong result type')
    const direction = diff(b, a),
      offset = diff(point, a)
    const t = dot(offset, direction) / dot(direction, direction)
    expectPoint(result.foot, v(a.x + t * direction.x, a.y + t * direction.y, a.z + t * direction.z))
    expect(dot(diff(point, result.foot), direction)).toBeCloseTo(0, 10)
  })

  it('computes an oblique point-to-plane foot, signed distance, and unit normal', () => {
    // x + y + z = 6; the origin projects to (2,2,2).
    const result = run({
      operation: 'point_plane_foot',
      point: origin,
      a: v(6, 0, 0),
      b: v(0, 6, 0),
      c: v(0, 0, 6),
    })
    if (result.operation !== 'point_plane_foot') throw new Error('Wrong result type')
    expectPoint(result.foot, v(2, 2, 2))
    expect(result.distance).toBeCloseTo(2 * Math.sqrt(3), 12)
    expect(result.signedDistance).toBeCloseTo(-2 * Math.sqrt(3), 12)
    expect(dot(result.normal, result.normal)).toBeCloseTo(1, 13)
    expect(result.foot.x + result.foot.y + result.foot.z).toBeCloseTo(6, 12)
  })

  it('reverses normal orientation without changing plane foot or distance', () => {
    const parameters = { point: v(1, 2, 5), a: origin, b: v(3, 0), c: v(0, 4) }
    const first = run({ operation: 'point_plane_foot', ...parameters })
    const second = run({
      operation: 'point_plane_foot',
      ...parameters,
      b: parameters.c,
      c: parameters.b,
    })
    if (first.operation !== 'point_plane_foot' || second.operation !== 'point_plane_foot')
      throw new Error('Wrong result type')
    expect(first.foot).toEqual(second.foot)
    expect(first.distance).toBe(second.distance)
    expect(first.signedDistance).toBe(-second.signedDistance)
    expect(dot(first.normal, second.normal)).toBeCloseTo(-1, 13)
  })

  it.each([
    [v(4, 0, 0), 0],
    [v(0, 0, -4), 90],
    [v(1, 0, -1), 45],
    [v(-1, 0, 1), 45],
  ])('returns acute line-to-plane angles independent of line orientation', (to, angle) => {
    const result = run({
      operation: 'line_plane_angle',
      from: origin,
      to,
      a: origin,
      b: v(2, 0),
      c: v(0, 3),
    })
    if (result.operation !== 'line_plane_angle') throw new Error('Wrong result type')
    expect(result.angleDegrees).toBeCloseTo(angle as number, 12)
    expect(result.sine).toBeCloseTo(Math.sin(((angle as number) * Math.PI) / 180), 12)
  })

  it('returns a unit plane normal perpendicular to both true 3D spanning vectors', () => {
    const a = v(1, 2, 3),
      b = v(3, 4, 5),
      c = v(-1, 5, 4)
    const result = run({ operation: 'plane_normal', a, b, c })
    if (result.operation !== 'plane_normal') throw new Error('Wrong result type')
    expect(dot(result.normal, diff(b, a))).toBeCloseTo(0, 12)
    expect(dot(result.normal, diff(c, a))).toBeCloseTo(0, 12)
    expect(dot(result.normal, result.normal)).toBeCloseTo(1, 12)
  })

  it('uses absolute scalar-triple-product volume with translation and vertex-order invariance', () => {
    const a = v(7, -2, 8),
      b = v(9, -2, 8),
      c = v(7, 1, 8),
      d = v(7, -2, 12)
    expect(run({ operation: 'tetrahedron_volume', a, b, c, d })).toMatchObject({ volume: 4 })
    expect(run({ operation: 'tetrahedron_volume', a, b: c, c: b, d })).toMatchObject({ volume: 4 })
  })

  it.each([1e-100, 1e-6, 1, 1e3])(
    'preserves directions and angles under uniform scaling %s',
    (scale) => {
      const scaled = (x: number, y: number, z: number) => v(x * scale, y * scale, z * scale)
      const metrics = run({ operation: 'vector_metrics', a: scaled(1, 1, 0), b: scaled(0, 0, 2) })
      expect(metrics).toMatchObject({ angleDegrees: 90, orthogonal: true })
      const normal = run({
        operation: 'plane_normal',
        a: origin,
        b: scaled(1, 0, 0),
        c: scaled(0, 1, 0),
      })
      expect(normal).toMatchObject({ normal: v(0, 0, 1) })
      const volume = run({
        operation: 'tetrahedron_volume',
        a: origin,
        b: scaled(2, 0, 0),
        c: scaled(0, 3, 0),
        d: scaled(0, 0, 4),
      })
      if (volume.operation !== 'tetrahedron_volume') throw new Error('Wrong result type')
      expect(volume.volume / (4 * scale ** 3)).toBeCloseTo(1, 12)
    },
  )

  it.each([
    { operation: 'vector_metrics', a: origin, b: v(1, 0) },
    { operation: 'point_line_foot', point: v(1, 0), a: origin, b: origin },
    { operation: 'plane_normal', a: origin, b: v(1, 1), c: v(2, 2) },
    { operation: 'plane_normal', a: origin, b: v(1, 0), c: v(2, 1e-12) },
    { operation: 'point_plane_foot', point: v(1, 0), a: origin, b: origin, c: v(0, 1) },
    { operation: 'line_plane_angle', from: origin, to: origin, a: origin, b: v(1, 0), c: v(0, 1) },
    { operation: 'tetrahedron_volume', a: origin, b: v(1, 0), c: v(0, 1), d: v(1, 1) },
    { operation: 'tetrahedron_volume', a: origin, b: v(1, 0), c: v(0, 1), d: v(1, 1, 1e-12) },
  ] as GeometryRequest[])(
    'rejects undefined or numerically unstable geometry: $operation',
    (request) => {
      expect(() => run(request)).toThrow(GeometryError)
    },
  )

  it('rejects dot-product underflow instead of reporting false zero while preserving tiny perpendicular vectors', () => {
    expect(() => run({ operation: 'vector_metrics', a: v(1e-200, 0), b: v(1e-200, 0) })).toThrow(
      /numeric range/,
    )
    expect(run({ operation: 'vector_metrics', a: v(1e-200, 0), b: v(0, 1e-200) })).toMatchObject({
      dot: 0,
      orthogonal: true,
      angleDegrees: 90,
    })
  })

  it('rejects underflow instead of claiming a nondegenerate tetrahedron has zero volume', () => {
    expect(() =>
      run({
        operation: 'tetrahedron_volume',
        a: origin,
        b: v(1e-120, 0),
        c: v(0, 1e-120),
        d: v(0, 0, 1e-120),
      }),
    ).toThrow(/numeric range/)
  })

  it('keeps all result numbers finite and bounded at the permitted coordinate extremes', () => {
    const min = v(-10_000, -10_000, -10_000),
      max = v(10_000, 10_000, 10_000)
    const requests: GeometryRequest[] = [
      { operation: 'vector_metrics', a: min, b: max },
      { operation: 'point_line_foot', point: max, a: min, b: v(-9999, -9998, -9997) },
      {
        operation: 'point_plane_foot',
        point: max,
        a: min,
        b: v(10_000, -10_000, -10_000),
        c: v(-10_000, 10_000, -10_000),
      },
      {
        operation: 'tetrahedron_volume',
        a: min,
        b: v(10_000, -10_000, -10_000),
        c: v(-10_000, 10_000, -10_000),
        d: v(-10_000, -10_000, 10_000),
      },
    ]
    const check = (value: unknown): void => {
      if (typeof value === 'number') {
        expect(Number.isFinite(value)).toBe(true)
        expect(Math.abs(value)).toBeLessThanOrEqual(GEOMETRY_LIMITS.outputMagnitude)
      } else if (value && typeof value === 'object') Object.values(value).forEach(check)
    }
    requests.forEach((request) => check(run(request)))
  })

  it.each([
    null,
    { request: { operation: 'eval', expression: 'process.exit()' } },
    { request: { operation: 'vector_metrics', a: v(1, 0), b: v(0, 1), expression: '1+1' } },
    { request: { operation: 'vector_metrics', a: { ...v(1, 0), file: '/private' }, b: v(0, 1) } },
    { request: { operation: 'vector_metrics', a: v(Infinity, 0), b: v(0, 1) } },
    { request: { operation: 'vector_metrics', a: v(NaN, 0), b: v(0, 1) } },
    { request: { operation: 'vector_metrics', a: v(10001, 0), b: v(0, 1) } },
    { request: { operation: 'vector_metrics', a: v(Number.MAX_VALUE, 0), b: v(0, 1) } },
    { request: { operation: 'vector_metrics', a: v(1, 0), b: v(0, 1) }, extra: true },
    { request: new Array(10000).fill(1) },
  ])('rejects untrusted, oversized, unknown or nonfinite input', (input) => {
    expect(() => executeGeometryTool(input)).toThrow(GeometryError)
  })

  it('rejects inherited values, prototype keys, accessors and cycles without running getters', () => {
    const good = { request: { operation: 'vector_metrics', a: v(1, 0), b: v(0, 1) } }
    expect(() => executeGeometryTool(Object.create(good))).toThrow(GeometryError)
    expect(() =>
      executeGeometryTool({ request: { ...good.request, a: Object.create(v(1, 0)) } }),
    ).toThrow(GeometryError)
    expect(() => executeGeometryTool(JSON.parse('{"__proto__":{},"request":{}}'))).toThrow(
      GeometryError,
    )
    let getterRan = false
    const getter = Object.defineProperty({}, 'request', {
      enumerable: true,
      get: () => {
        getterRan = true
        return good.request
      },
    })
    expect(() => executeGeometryTool(getter)).toThrow(GeometryError)
    expect(getterRan).toBe(false)
    const cyclic: { request?: unknown } = {}
    cyclic.request = cyclic
    expect(() => executeGeometryTool(cyclic)).toThrow(GeometryError)
  })

  it('does not confuse reused plain vectors with cyclic data or mutate caller inputs', () => {
    const point = Object.freeze(v(3, 4, 0))
    const input = Object.freeze({
      request: Object.freeze({ operation: 'vector_metrics' as const, a: point, b: point }),
    })
    expect(executeGeometryTool(input)).toMatchObject({ dot: 25, normA: 5, angleDegrees: 0 })
    expect(point).toEqual(v(3, 4, 0))
  })
})

describe('2D perpendicular construction', () => {
  it('returns the known foot and a unit perpendicular for an oblique line', () => {
    const result = perpendicular2D({ x: 4, y: 0 }, { x: 0, y: 0 }, { x: 2, y: 2 })
    expect(result.foot.x).toBeCloseTo(2, 12)
    expect(result.foot.y).toBeCloseTo(2, 12)
    expect(result.distance).toBeCloseTo(Math.sqrt(8), 12)
    expect(result.perpendicularDirection.x + result.perpendicularDirection.y).toBeCloseTo(0, 12)
    expect(
      Math.hypot(result.perpendicularDirection.x, result.perpendicularDirection.y),
    ).toBeCloseTo(1, 12)
  })

  it.each([
    [
      { x: 3, y: 2 },
      { x: 0, y: 2 },
      { x: 4, y: 2 },
    ],
    [
      { x: -1, y: 4 },
      { x: -1, y: 0 },
      { x: -1, y: 8 },
    ],
    [
      { x: 2, y: 2 },
      { x: 0, y: 0 },
      { x: 4, y: 4 },
    ],
  ])(
    'creates a nonzero perpendicular even when the chosen point is already on the line',
    (point, a, b) => {
      const result = perpendicular2D(point, a, b)
      expect(result.foot.x).toBeCloseTo(point.x, 12)
      expect(result.foot.y).toBeCloseTo(point.y, 12)
      expect(result.distance).toBeCloseTo(0, 12)
      expect(
        Math.hypot(result.perpendicularDirection.x, result.perpendicularDirection.y),
      ).toBeCloseTo(1, 12)
      expect(
        (b.x - a.x) * result.perpendicularDirection.x +
          (b.y - a.y) * result.perpendicularDirection.y,
      ).toBeCloseTo(0, 12)
    },
  )

  it('rejects coincident endpoints, nonfinite coordinates and unexpected payload fields', () => {
    expect(() => perpendicular2D({ x: 1, y: 2 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toThrow(/nonzero/)
    expect(() => perpendicular2D({ x: Infinity, y: 2 }, { x: 0, y: 0 }, { x: 1, y: 0 })).toThrow(
      GeometryError,
    )
    expect(() =>
      perpendicular2D({ x: 1, y: 2, z: 0 } as never, { x: 0, y: 0 }, { x: 1, y: 0 }),
    ).toThrow(GeometryError)
  })
})

describe('true-3D bounded geometry scene validation', () => {
  it('accepts an empty scratchpad but not dangling geometry in an empty scene', () => {
    const empty = { version: 1, kind: 'geometry-3d', title: 'Empty', points: [], segments: [] }
    expect(geometrySceneSchema.safeParse(empty).success).toBe(true)
    expect(
      geometrySceneSchema.safeParse({ ...empty, segments: [{ id: 'AB', from: 'A', to: 'B' }] })
        .success,
    ).toBe(false)
  })

  it('preserves mathematical coordinates, typed references and true right angles', () => {
    const original = scene()
    expect(geometrySceneSchema.parse(original)).toEqual(original)
    expect(geometrySceneSchema.parse(original)).not.toBe(original)
    expect(
      geometrySceneSchema.parse({ ...original, faces: undefined, rightAngles: undefined }),
    ).toBeDefined()
  })

  it('accepts a simple concave planar face and harmless label markup as literal text', () => {
    const points = [
      [0, 0],
      [4, 0],
      [2, 1],
      [4, 4],
      [0, 4],
    ].map(([x, y], index) => ({ id: `P${index}`, label: '<P>', x, y, z: 3 }))
    expect(
      geometrySceneSchema.safeParse({
        version: 1,
        kind: 'geometry-3d',
        title: 'Face',
        points,
        segments: [],
        faces: [{ id: 'face', points: points.map((point) => point.id) }],
      }).success,
    ).toBe(true)
  })

  it.each([
    (value: GeometryScene) => {
      value.points[1].id = 'A'
    },
    (value: GeometryScene) => {
      value.points[1].x = 101
    },
    (value: GeometryScene) => {
      value.points[1].x = Infinity
    },
    (value: GeometryScene) => {
      value.points[1].label = 'x'.repeat(41)
    },
    (value: GeometryScene) => {
      value.points[1].label = '\u0000'
    },
    (value: GeometryScene) => {
      value.segments[0].to = 'MISSING'
    },
    (value: GeometryScene) => {
      value.segments[0].to = 'A'
    },
    (value: GeometryScene) => {
      value.segments[1].id = value.segments[0].id
    },
    (value: GeometryScene) => {
      value.points[1].x = 0
    },
    (value: GeometryScene) => {
      value.faces![0].points = ['A', 'B', 'MISSING']
    },
    (value: GeometryScene) => {
      value.faces![0].points = ['A', 'B', 'A']
    },
    (value: GeometryScene) => {
      value.rightAngles![0].to = 'MISSING'
    },
    (value: GeometryScene) => {
      value.rightAngles![0].to = 'A'
    },
    (value: GeometryScene) => {
      value.points[2].x = 1
    },
  ])('rejects malformed references, duplicate IDs and degenerate constructions', (mutate) => {
    const value = scene()
    mutate(value)
    expect(geometrySceneSchema.safeParse(value).success).toBe(false)
  })

  it('rejects screen-right angles that are not perpendicular in true 3D coordinates', () => {
    const value = scene()
    value.faces = undefined
    value.points[1] = { id: 'B', label: 'B', ...v(1, 0, 1) }
    value.points[2] = { id: 'C', label: 'C', ...v(0, 1, 1) }
    expect(geometrySceneSchema.safeParse(value).success).toBe(false)
  })

  it('uses a scale-invariant relative right-angle tolerance and rejects zero rays', () => {
    for (const scale of [1e-100, 1, 1e100]) {
      expect(arePerpendicular(v(scale, 0), v(0, scale))).toBe(true)
      expect(arePerpendicular(v(scale, 0), v(scale * 1e-7, scale))).toBe(false)
      expect(arePerpendicular(v(scale, 0), v(scale * 1e-9, scale))).toBe(true)
    }
    expect(arePerpendicular(origin, v(1, 0))).toBe(false)
  })

  it.each(
    [
      [
        [0, 0, 0],
        [1, 0, 0],
        [2, 0, 0],
      ],
      [
        [0, 0, 0],
        [2, 0, 0],
        [2, 2, 1],
        [0, 2, 0],
      ],
      [
        [0, 0, 0],
        [2, 2, 0],
        [0, 2, 0],
        [2, 0, 0],
      ],
      [
        [0, 0, 0],
        [3, 2, 0],
        [0, 3, 0],
        [2, 0, 0],
      ],
    ].map((coordinates) => ({ coordinates })),
  )('rejects collinear, nonplanar and self-intersecting face boundaries', ({ coordinates }) => {
    const points = coordinates.map(([x, y, z], index) => ({
      id: `P${index}`,
      label: `P${index}`,
      x,
      y,
      z,
    }))
    expect(
      geometrySceneSchema.safeParse({
        version: 1,
        kind: 'geometry-3d',
        title: 'Bad face',
        points,
        segments: [],
        faces: [{ id: 'face', points: points.map((point) => point.id) }],
      }).success,
    ).toBe(false)
  })

  it('enforces collection, nested polygon and text limits', () => {
    const base = scene()
    const tooManyPoints = Array.from({ length: 81 }, (_, index) => ({
      id: `P${index}`,
      label: 'P',
      ...origin,
    }))
    expect(geometrySceneSchema.safeParse({ ...base, points: tooManyPoints }).success).toBe(false)
    expect(
      geometrySceneSchema.safeParse({
        ...base,
        segments: Array.from({ length: 121 }, (_, index) => ({
          id: `s${index}`,
          from: 'A',
          to: 'B',
        })),
      }).success,
    ).toBe(false)
    expect(
      geometrySceneSchema.safeParse({
        ...base,
        faces: Array.from({ length: 31 }, (_, index) => ({
          id: `f${index}`,
          points: ['A', 'B', 'C'],
        })),
      }).success,
    ).toBe(false)
    expect(
      geometrySceneSchema.safeParse({
        ...base,
        rightAngles: Array.from({ length: 81 }, (_, index) => ({
          id: `r${index}`,
          vertex: 'A',
          from: 'B',
          to: 'C',
        })),
      }).success,
    ).toBe(false)
    expect(
      geometrySceneSchema.safeParse({
        ...base,
        faces: [{ id: 'f', points: new Array(13).fill('A') }],
      }).success,
    ).toBe(false)
    expect(geometrySceneSchema.safeParse({ ...base, title: 't'.repeat(161) }).success).toBe(false)
  })

  it('rejects unknown scene fields, prototype payloads and accessor data', () => {
    const value = scene()
    expect(geometrySceneSchema.safeParse({ ...value, html: '<script>bad</script>' }).success).toBe(
      false,
    )
    expect(
      geometrySceneSchema.safeParse({
        ...value,
        points: value.points.map((point) => ({ ...point, answer: 42 })),
      }).success,
    ).toBe(false)
    expect(geometrySceneSchema.safeParse(Object.create(value)).success).toBe(false)
    expect(
      geometrySceneSchema.safeParse({ ...value, points: [Object.create(value.points[0])] }).success,
    ).toBe(false)
    let getterRan = false
    const accessor = Object.defineProperty({ ...value }, 'title', {
      enumerable: true,
      get: () => {
        getterRan = true
        return 'Test'
      },
    })
    expect(geometrySceneSchema.safeParse(accessor).success).toBe(false)
    expect(getterRan).toBe(false)
  })
})
