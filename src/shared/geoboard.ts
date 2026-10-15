import { z } from 'zod'
import { assertGeoboard } from '../domain/geoboard'
import type { GeoboardState } from './geoboard-types'
const id = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
const coordinate = z.number().finite().min(-10000).max(10000)
const base = {
  id,
  label: z.string().max(80),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  visible: z.boolean(),
  fill: z.boolean(),
}
const point = z.discriminatedUnion('kind', [
  z.strictObject({
    ...base,
    kind: z.literal('free'),
    x: coordinate,
    y: coordinate,
    locked: z.boolean(),
  }),
  z.strictObject({ ...base, kind: z.literal('midpoint'), a: id, b: id }),
  z.strictObject({ ...base, kind: z.literal('projection'), point: id, line: id }),
  z.strictObject({ ...base, kind: z.literal('reflection'), point: id, line: id }),
  z.strictObject({
    ...base,
    kind: z.literal('intersection'),
    a: id,
    b: id,
    branch: z.union([z.literal(0), z.literal(1)]),
  }),
  z.strictObject({
    ...base,
    kind: z.literal('on-object'),
    object: id,
    parameter: z.number().finite().min(-1000000).max(1000000),
  }),
])
const object = z.union([
  z.strictObject({ ...base, kind: z.enum(['segment', 'line', 'ray']), from: id, to: id }),
  z.strictObject({ ...base, kind: z.enum(['parallel', 'perpendicular']), through: id, line: id }),
  z.strictObject({ ...base, kind: z.literal('circle'), center: id, through: id }),
  z.strictObject({
    ...base,
    kind: z.literal('fixed-circle'),
    center: id,
    radius: z.number().finite().positive().max(10000),
  }),
  z.strictObject({ ...base, kind: z.literal('circumcircle'), a: id, b: id, c: id }),
  z.strictObject({ ...base, kind: z.literal('polygon'), points: z.array(id).min(3).max(80) }),
  z.strictObject({ ...base, kind: z.literal('arc'), center: id, start: id, end: id }),
  z.strictObject({
    ...base,
    kind: z.literal('tangent'),
    point: id,
    circle: id,
    branch: z.union([z.literal(0), z.literal(1)]),
  }),
])
/** Concrete wire shape keeps MCP / JSON Schema conversion possible. Semantic guard detects cycles. */
export const geoboardSchema = z
  .strictObject({
    version: z.literal(1),
    points: z.array(point).max(200),
    objects: z.array(object).max(300),
    view: z.strictObject({
      x: coordinate,
      y: coordinate,
      scale: z.number().finite().min(8).max(160),
      grid: z.enum(['square', 'isometric', 'circular', 'none']),
      step: z.number().finite().min(0.01).max(100),
      snap: z.boolean(),
      axes: z.boolean(),
      labels: z.boolean(),
    }),
  })
  .superRefine((value, ctx) => {
    try {
      assertGeoboard(value)
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        message: error instanceof Error ? error.message : '钉板数据无效',
      })
    }
  }) satisfies z.ZodType<GeoboardState>
