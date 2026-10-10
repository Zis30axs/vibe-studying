import { z } from 'zod'
import type { GeographyFigure, QuestionProvenance } from '../shared/types'

export const MAX_GEOGRAPHY_PRIMITIVES = 80
const id = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
  .refine((value) => !['__proto__', 'prototype', 'constructor'].includes(value))
const coordinate = z.number().finite().min(-100).max(100)
// Text is rendered as React text, never interpreted as markup. Reject markup-shaped
// inputs too so imported/model-produced documents cannot smuggle executable formats.
const plainText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(
      (value) => !/[<>]|(?:javascript|data):|&#(?:x[0-9a-f]+|\d+);/i.test(value),
      '示意图只允许纯文本',
    )
const edge = z.strictObject({ id, from: id, to: id })
const path = (minimum: number) =>
  z.strictObject({
    id,
    points: z.array(id).min(minimum).max(MAX_GEOGRAPHY_PRIMITIVES),
  })
/** Flat references only target terminal points. Cyclic object graphs/element
 * references cannot be represented. Polygon closure is implicit and intentional;
 * repeated vertices (including repeated first vertices) are rejected. Directed
 * arrows may form a physical cycle (e.g. circulation), without recursive expansion. */
export const geographyFigureSchema = z
  .strictObject({
    version: z.literal(1),
    kind: z.literal('schematic'),
    title: plainText(120),
    description: plainText(500),
    points: z
      .array(z.strictObject({ id, x: coordinate, y: coordinate, label: plainText(120).optional() }))
      .max(80),
    segments: z.array(edge).max(80),
    arrows: z.array(edge).max(80),
    polylines: z.array(path(2)).max(80),
    polygons: z.array(path(3)).max(80),
    labels: z
      .array(z.strictObject({ id, x: coordinate, y: coordinate, text: plainText(120) }))
      .max(80),
    grid: z.strictObject({ step: z.number().finite().min(10).max(100) }).optional(),
  })
  .superRefine((figure, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message })
    const all = [
      ...figure.points,
      ...figure.segments,
      ...figure.arrows,
      ...figure.polylines,
      ...figure.polygons,
      ...figure.labels,
    ]
    if (!all.length || all.length > MAX_GEOGRAPHY_PRIMITIVES) fail('示意图需要 1 至 80 个元素')
    if (new Set(all.map((item) => item.id)).size !== all.length) fail('示意图元素 ID 必须唯一')
    const points = new Set(figure.points.map((point) => point.id))
    for (const line of [...figure.segments, ...figure.arrows]) {
      if (line.from === line.to || !points.has(line.from) || !points.has(line.to))
        fail('连线必须引用两个不同的已有点')
    }
    for (const line of [...figure.polylines, ...figure.polygons]) {
      if (
        line.points.some((ref) => !points.has(ref)) ||
        new Set(line.points).size !== line.points.length
      )
        fail('路径必须引用不同的已有点，闭合多边形无需重复起点')
    }
  }) satisfies z.ZodType<GeographyFigure>

export const questionProvenanceSchema = z.strictObject({
  kind: z.literal('ai-generated'),
  model: z.string().trim().min(1).max(200),
  protocol: z.enum(['anthropic', 'gemini', 'openai-responses', 'openai-chat']),
  generatedAt: z.iso.datetime(),
  verified: z.literal(false),
}) satisfies z.ZodType<QuestionProvenance>
