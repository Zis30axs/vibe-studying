import { z } from 'zod'

export interface Vec3 {
  x: number
  y: number
  z: number
}
export interface Vec2 {
  x: number
  y: number
}

/** Coordinates are mathematical coordinates; any screen projection is display-only. */
export const GEOMETRY_LIMITS = Object.freeze({
  coordinate: 10_000,
  sceneCoordinate: 100,
  points: 80,
  segments: 120,
  faces: 30,
  facePoints: 12,
  rightAngles: 80,
  outputMagnitude: 1e14,
})
export const GEOMETRY_ORTHOGONAL_TOLERANCE = 1e-8
export const GEOMETRY_DEGENERACY_TOLERANCE = 1e-10

const finiteCoordinate = (limit: number) => z.number().finite().min(-limit).max(limit)
export const vec3Schema = z.strictObject({
  x: finiteCoordinate(GEOMETRY_LIMITS.coordinate),
  y: finiteCoordinate(GEOMETRY_LIMITS.coordinate),
  z: finiteCoordinate(GEOMETRY_LIMITS.coordinate),
})
export const vec2Schema = z.strictObject({
  x: finiteCoordinate(GEOMETRY_LIMITS.coordinate),
  y: finiteCoordinate(GEOMETRY_LIMITS.coordinate),
})

/** Reject accessors, inherited payloads and cyclic/non-JSON values before evaluating geometry. */
export function isPlainGeometryData(value: unknown, maxNodes = 4_000): boolean {
  const seen = new Set<object>()
  const pending: { value: unknown; depth: number; leaving?: boolean }[] = [{ value, depth: 0 }]
  let nodes = 0
  try {
    while (pending.length) {
      const entry = pending.pop()!
      if (entry.leaving) {
        seen.delete(entry.value as object)
        continue
      }
      if (++nodes > maxNodes || entry.depth > 10) return false
      const current = entry.value
      if (current === null || current === undefined) continue
      if (typeof current === 'number') {
        if (!Number.isFinite(current)) return false
        continue
      }
      if (typeof current === 'string') {
        if (current.length > 1_000) return false
        continue
      }
      if (typeof current === 'boolean') continue
      if (typeof current !== 'object' || seen.has(current)) return false
      seen.add(current)
      pending.push({ value: current, depth: entry.depth, leaving: true })
      const isArray = Array.isArray(current)
      const prototype = Object.getPrototypeOf(current)
      if (
        isArray
          ? prototype !== Array.prototype
          : prototype !== Object.prototype && prototype !== null
      )
        return false
      const keys = Reflect.ownKeys(current)
      if (keys.length + nodes > maxNodes || (isArray && current.length > maxNodes)) return false
      for (const key of keys) {
        if (isArray && key === 'length') continue
        if (
          typeof key !== 'string' ||
          key.length > 100 ||
          ['__proto__', 'constructor', 'prototype'].includes(key)
        )
          return false
        if (isArray && !/^(0|[1-9]\d*)$/.test(key)) return false
        const descriptor = Object.getOwnPropertyDescriptor(current, key)!
        if (!('value' in descriptor) || !descriptor.enumerable) return false
        pending.push({ value: descriptor.value, depth: entry.depth + 1 })
      }
    }
    return true
  } catch {
    return false
  }
}

const difference = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
})
const norm = (a: Vec3) => Math.hypot(a.x, a.y, a.z)
const unit = (a: Vec3): Vec3 | null => {
  const scale = Math.max(Math.abs(a.x), Math.abs(a.y), Math.abs(a.z))
  if (!Number.isFinite(scale) || scale === 0) return null
  const scaled = { x: a.x / scale, y: a.y / scale, z: a.z / scale }
  const length = norm(scaled)
  return { x: scaled.x / length, y: scaled.y / length, z: scaled.z / length }
}
/** Relative, scale-invariant test; a zero ray never defines a right angle. */
export function arePerpendicular(a: Vec3, b: Vec3): boolean {
  const first = unit(a)
  const second = unit(b)
  return !!first && !!second && Math.abs(dot(first, second)) <= GEOMETRY_ORTHOGONAL_TOLERANCE
}

const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
const textSchema = (length: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(length)
    .regex(/^[^\u0000-\u001f\u007f]*$/)
export const geometryRightAngleSchema = z.strictObject({
  id: idSchema,
  vertex: idSchema,
  from: idSchema,
  to: idSchema,
})
const sceneObjectSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal('geometry-3d'),
  title: textSchema(160),
  points: z
    .array(
      z.strictObject({
        id: idSchema,
        label: textSchema(40),
        x: finiteCoordinate(GEOMETRY_LIMITS.sceneCoordinate),
        y: finiteCoordinate(GEOMETRY_LIMITS.sceneCoordinate),
        z: finiteCoordinate(GEOMETRY_LIMITS.sceneCoordinate),
      }),
    )
    .max(GEOMETRY_LIMITS.points),
  segments: z
    .array(
      z.strictObject({
        id: idSchema,
        from: idSchema,
        to: idSchema,
        dashed: z.boolean().optional(),
      }),
    )
    .max(GEOMETRY_LIMITS.segments),
  faces: z
    .array(
      z.strictObject({
        id: idSchema,
        points: z.array(idSchema).min(3).max(GEOMETRY_LIMITS.facePoints),
      }),
    )
    .max(GEOMETRY_LIMITS.faces)
    .optional(),
  rightAngles: z.array(geometryRightAngleSchema).max(GEOMETRY_LIMITS.rightAngles).optional(),
})
export type GeometryScene = z.infer<typeof sceneObjectSchema>

function validFace(points: Vec3[]): boolean {
  // Normalize around the first vertex to make all tolerances independent of size.
  const offsets = points.map((point) => difference(point, points[0]))
  const scale = Math.max(...offsets.map(norm))
  if (!scale) return false
  const normalized = offsets.map((point) => ({
    x: point.x / scale,
    y: point.y / scale,
    z: point.z / scale,
  }))
  let normal: Vec3 | null = null
  for (let i = 1; i < normalized.length && !normal; i++) {
    for (let j = i + 1; j < normalized.length; j++) {
      const candidate = cross(normalized[i], normalized[j])
      if (norm(candidate) > GEOMETRY_DEGENERACY_TOLERANCE) {
        normal = unit(candidate)
        break
      }
    }
  }
  if (
    !normal ||
    normalized.some((point) => Math.abs(dot(point, normal!)) > GEOMETRY_ORTHOGONAL_TOLERANCE)
  )
    return false
  const horizontal = unit(normalized[1])
  if (!horizontal) return false
  const vertical = cross(normal, horizontal)
  const flat = normalized.map((point) => ({ x: dot(point, horizontal), y: dot(point, vertical) }))
  const epsilon = GEOMETRY_DEGENERACY_TOLERANCE
  const orient = (a: Vec2, b: Vec2, c: Vec2) =>
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
  const onSegment = (a: Vec2, b: Vec2, p: Vec2) =>
    Math.abs(orient(a, b, p)) <= epsilon &&
    p.x >= Math.min(a.x, b.x) - epsilon &&
    p.x <= Math.max(a.x, b.x) + epsilon &&
    p.y >= Math.min(a.y, b.y) - epsilon &&
    p.y <= Math.max(a.y, b.y) + epsilon
  let area = 0
  for (let i = 0; i < flat.length; i++) {
    const a = flat[i]
    const b = flat[(i + 1) % flat.length]
    if (Math.hypot(a.x - b.x, a.y - b.y) <= epsilon) return false
    area += a.x * b.y - a.y * b.x
    for (let j = i + 1; j < flat.length; j++) {
      if (j === i + 1 || (i === 0 && j === flat.length - 1)) continue
      const c = flat[j]
      const d = flat[(j + 1) % flat.length]
      const abC = orient(a, b, c),
        abD = orient(a, b, d)
      const cdA = orient(c, d, a),
        cdB = orient(c, d, b)
      if (
        (abC * abD < 0 && cdA * cdB < 0) ||
        onSegment(a, b, c) ||
        onSegment(a, b, d) ||
        onSegment(c, d, a) ||
        onSegment(c, d, b)
      )
        return false
    }
  }
  return Math.abs(area) > epsilon
}

/** Strict, bounded scene validation, including references and true 3D right angles. */
export const geometrySceneSchema = z.preprocess(
  (input, context) => {
    if (!isPlainGeometryData(input)) {
      context.addIssue({
        code: 'custom',
        message:
          'Geometry must contain bounded plain data without prototypes, accessors, or cycles.',
      })
      return z.NEVER
    }
    return input
  },
  sceneObjectSchema.superRefine((scene, context) => {
    // Zod can run refinements after a size issue; do not iterate unbounded arrays.
    if (
      scene.points.length > GEOMETRY_LIMITS.points ||
      scene.segments.length > GEOMETRY_LIMITS.segments ||
      (scene.faces?.length ?? 0) > GEOMETRY_LIMITS.faces ||
      (scene.rightAngles?.length ?? 0) > GEOMETRY_LIMITS.rightAngles
    )
      return
    const issue = (path: (string | number)[], message: string) =>
      context.addIssue({ code: 'custom', path, message })
    const uniqueIds = (items: { id: string }[], field: string) => {
      const seen = new Set<string>()
      items.forEach((item, index) => {
        if (seen.has(item.id))
          issue([field, index, 'id'], 'Geometry IDs must be unique within their collection.')
        seen.add(item.id)
      })
    }
    uniqueIds(scene.points, 'points')
    uniqueIds(scene.segments, 'segments')
    uniqueIds(scene.faces ?? [], 'faces')
    uniqueIds(scene.rightAngles ?? [], 'rightAngles')
    const points = new Map(scene.points.map((point) => [point.id, point]))
    scene.segments.forEach((segment, index) => {
      const a = points.get(segment.from),
        b = points.get(segment.to)
      if (!a || !b) issue(['segments', index], 'Segment endpoints must reference existing points.')
      else if (!unit(difference(b, a)))
        issue(['segments', index], 'A segment needs two distinct positions.')
    })
    scene.faces?.forEach((face, index) => {
      if (face.points.length > GEOMETRY_LIMITS.facePoints) return
      const vertices = face.points.map((id) => points.get(id))
      if (new Set(face.points).size !== face.points.length || vertices.some((point) => !point))
        issue(['faces', index], 'A face must reference distinct existing points.')
      else if (!validFace(vertices as Vec3[]))
        issue(
          ['faces', index],
          'A face must be a nondegenerate, simple, planar polygon in boundary order.',
        )
    })
    scene.rightAngles?.forEach((marker, index) => {
      const vertex = points.get(marker.vertex),
        from = points.get(marker.from),
        to = points.get(marker.to)
      if (!vertex || !from || !to)
        issue(['rightAngles', index], 'Right-angle markers must reference existing points.')
      else if (!arePerpendicular(difference(from, vertex), difference(to, vertex)))
        issue(
          ['rightAngles', index],
          'A right-angle marker needs two nonzero, perpendicular 3D rays.',
        )
    })
  }),
)

export const geometryRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('vector_metrics'), a: vec3Schema, b: vec3Schema }),
  z.strictObject({
    operation: z.literal('point_line_foot'),
    point: vec3Schema,
    a: vec3Schema,
    b: vec3Schema,
  }),
  z.strictObject({
    operation: z.literal('point_plane_foot'),
    point: vec3Schema,
    a: vec3Schema,
    b: vec3Schema,
    c: vec3Schema,
  }),
  z.strictObject({
    operation: z.literal('line_plane_angle'),
    from: vec3Schema,
    to: vec3Schema,
    a: vec3Schema,
    b: vec3Schema,
    c: vec3Schema,
  }),
  z.strictObject({
    operation: z.literal('tetrahedron_volume'),
    a: vec3Schema,
    b: vec3Schema,
    c: vec3Schema,
    d: vec3Schema,
  }),
  z.strictObject({
    operation: z.literal('plane_normal'),
    a: vec3Schema,
    b: vec3Schema,
    c: vec3Schema,
  }),
])
/** Outer object exposes `.shape` for MCP registration; execution also checks raw plain data. */
export const geometryToolInputSchema = z.strictObject({ request: geometryRequestSchema })
export type GeometryRequest = z.infer<typeof geometryRequestSchema>
export type GeometryToolInput = z.infer<typeof geometryToolInputSchema>
