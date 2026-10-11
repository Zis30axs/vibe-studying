import {
  GEOMETRY_DEGENERACY_TOLERANCE,
  GEOMETRY_LIMITS,
  arePerpendicular,
  geometryToolInputSchema,
  isPlainGeometryData,
  vec2Schema,
  type Vec2,
  type Vec3,
} from '../shared/geometry'

export class GeometryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GeometryError'
  }
}
export const addVectors = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z })
export const subtractVectors = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z,
})
export const scaleVector = (a: Vec3, scale: number): Vec3 => ({
  x: a.x * scale,
  y: a.y * scale,
  z: a.z * scale,
})
export const dotVectors = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z
export const crossVectors = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
})
export const vectorNorm = (a: Vec3) => Math.hypot(a.x, a.y, a.z)
/** Scale before dividing, retaining direction even for tiny nonzero vectors. */
export function normalizeVector(a: Vec3): Vec3 {
  const scale = Math.max(Math.abs(a.x), Math.abs(a.y), Math.abs(a.z))
  if (!Number.isFinite(scale) || scale === 0)
    throw new GeometryError('A nonzero finite vector or two distinct line endpoints are required.')
  const scaled = { x: a.x / scale, y: a.y / scale, z: a.z / scale }
  return scaleVector(scaled, 1 / vectorNorm(scaled))
}

function planeNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ab = normalizeVector(subtractVectors(b, a))
  const ac = normalizeVector(subtractVectors(c, a))
  const normal = crossVectors(ab, ac)
  if (vectorNorm(normal) <= GEOMETRY_DEGENERACY_TOLERANCE)
    throw new GeometryError(
      'A plane needs three distinct, non-collinear points; near-collinear points are unstable.',
    )
  return normalizeVector(normal)
}
const clampUnit = (value: number) => Math.max(-1, Math.min(1, value))
const degrees = (radians: number) => (radians * 180) / Math.PI

export type GeometryToolResult =
  | {
      operation: 'vector_metrics'
      dot: number
      normA: number
      normB: number
      cosine: number
      angleDegrees: number
      orthogonal: boolean
    }
  | { operation: 'point_line_foot'; foot: Vec3; distance: number; direction: Vec3 }
  | {
      operation: 'point_plane_foot'
      foot: Vec3
      distance: number
      signedDistance: number
      normal: Vec3
    }
  | {
      operation: 'line_plane_angle'
      sine: number
      angleDegrees: number
      direction: Vec3
      normal: Vec3
    }
  | { operation: 'tetrahedron_volume'; volume: number }
  | { operation: 'plane_normal'; normal: Vec3 }

function boundedResult<T>(result: T): T {
  const visit = (value: unknown): void => {
    if (
      typeof value === 'number' &&
      (!Number.isFinite(value) || Math.abs(value) > GEOMETRY_LIMITS.outputMagnitude)
    )
      throw new GeometryError('The geometry result exceeds the supported finite numeric range.')
    if (value && typeof value === 'object') Object.values(value).forEach(visit)
  }
  visit(result)
  return result
}

/** Deterministic local arithmetic only. No expressions, code, files, or network inputs. */
export function executeGeometryTool(input: unknown): GeometryToolResult {
  if (!isPlainGeometryData(input, 100))
    throw new GeometryError(
      'Geometry input must be bounded plain data without prototypes, accessors, or cycles.',
    )
  const parsed = geometryToolInputSchema.safeParse(input)
  if (!parsed.success)
    throw new GeometryError(
      `Invalid geometry input: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`,
    )
  const request = parsed.data.request
  let result: GeometryToolResult
  switch (request.operation) {
    case 'vector_metrics': {
      const first = normalizeVector(request.a),
        second = normalizeVector(request.b)
      const cosine = clampUnit(dotVectors(first, second))
      const scalarProduct = dotVectors(request.a, request.b)
      const normA = vectorNorm(request.a),
        normB = vectorNorm(request.b)
      const normProduct = normA * normB
      if (
        scalarProduct === 0 &&
        cosine !== 0 &&
        (normProduct === 0 || Math.abs(cosine) < Number.MIN_VALUE / normProduct)
      )
        throw new GeometryError('The dot product is below the supported numeric range.')
      result = {
        operation: request.operation,
        dot: scalarProduct,
        normA,
        normB,
        cosine,
        // Vectors have an angle in [0, 180], rather than the acute angle between lines.
        angleDegrees: degrees(Math.atan2(vectorNorm(crossVectors(first, second)), cosine)),
        orthogonal: arePerpendicular(request.a, request.b),
      }
      break
    }
    case 'point_line_foot': {
      const direction = normalizeVector(subtractVectors(request.b, request.a))
      const along = dotVectors(subtractVectors(request.point, request.a), direction)
      const foot = addVectors(request.a, scaleVector(direction, along))
      result = {
        operation: request.operation,
        foot,
        distance: vectorNorm(subtractVectors(request.point, foot)),
        direction,
      }
      break
    }
    case 'point_plane_foot': {
      const normal = planeNormal(request.a, request.b, request.c)
      const signedDistance = dotVectors(subtractVectors(request.point, request.a), normal)
      const foot = subtractVectors(request.point, scaleVector(normal, signedDistance))
      result = {
        operation: request.operation,
        foot,
        normal,
        signedDistance,
        distance: Math.abs(signedDistance),
      }
      break
    }
    case 'line_plane_angle': {
      const direction = normalizeVector(subtractVectors(request.to, request.from))
      const normal = planeNormal(request.a, request.b, request.c)
      const sine = Math.abs(clampUnit(dotVectors(direction, normal)))
      // An unoriented line's angle to a plane is always in [0, 90].
      const angleDegrees = degrees(Math.atan2(sine, vectorNorm(crossVectors(direction, normal))))
      result = { operation: request.operation, sine, angleDegrees, direction, normal }
      break
    }
    case 'tetrahedron_volume': {
      const ab = subtractVectors(request.b, request.a),
        ac = subtractVectors(request.c, request.a),
        ad = subtractVectors(request.d, request.a)
      const relativeDeterminant = Math.abs(
        dotVectors(normalizeVector(ab), crossVectors(normalizeVector(ac), normalizeVector(ad))),
      )
      if (relativeDeterminant <= GEOMETRY_DEGENERACY_TOLERANCE)
        throw new GeometryError(
          'A tetrahedron needs four non-coplanar points; near-coplanar points are unstable.',
        )
      const lengths = [vectorNorm(ab), vectorNorm(ac), vectorNorm(ad)].sort(
        (first, second) => second - first,
      )
      const volume = (lengths[0] * lengths[1] * lengths[2] * relativeDeterminant) / 6
      if (volume === 0)
        throw new GeometryError('The tetrahedron volume is below the supported numeric range.')
      result = { operation: request.operation, volume }
      break
    }
    case 'plane_normal':
      result = {
        operation: request.operation,
        normal: planeNormal(request.a, request.b, request.c),
      }
      break
  }
  return boundedResult(result)
}

/** The returned unit direction remains perpendicular even when point lies on line AB. */
export function perpendicular2D(
  point: Vec2,
  a: Vec2,
  b: Vec2,
): {
  foot: Vec2
  perpendicularDirection: Vec2
  distance: number
} {
  for (const value of [point, a, b]) {
    if (!isPlainGeometryData(value, 10) || !vec2Schema.safeParse(value).success)
      throw new GeometryError(
        'Perpendicular construction needs finite 2D coordinates within ±10000.',
      )
  }
  const direction = normalizeVector({ x: b.x - a.x, y: b.y - a.y, z: 0 })
  const along = (point.x - a.x) * direction.x + (point.y - a.y) * direction.y
  const foot = { x: a.x + along * direction.x, y: a.y + along * direction.y }
  return boundedResult({
    foot,
    perpendicularDirection: { x: -direction.y, y: direction.x },
    distance: Math.hypot(point.x - foot.x, point.y - foot.y),
  })
}
