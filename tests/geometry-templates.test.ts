import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  compileGeometryTemplate,
  geometryTemplateInputSchema,
} from '../src/domain/geometry-templates'
import { executeGeometryTool } from '../src/domain/geometry'
import { questionBankSchema } from '../src/domain/schemas'
import { studentQuestionProjection, studentQuestionSchema } from '../src/domain/student-question'
import { geometrySceneSchema, type Vec3 } from '../src/shared/geometry'
import {
  GEOMETRY_GENERATION_INSTRUCTIONS,
  GEOMETRY_TEMPLATE_CATALOG,
  geometryTemplatePrompt,
  geometryTemplateToolSchema,
} from '../src/shared/geometry-templates'

const number = (value: number) => Number(value.toFixed(6)).toString()
const defaults = (index: number) => ({
  templateId: GEOMETRY_TEMPLATE_CATALOG[index].id,
  parameters: GEOMETRY_TEMPLATE_CATALOG[index].defaultParameters,
})
const subtract = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z
const scenePoint = (question: ReturnType<typeof compileGeometryTemplate>, id: string) =>
  question.geometry!.points.find((point) => point.id === id)!

describe('bounded original geometry question templates', () => {
  it.each(GEOMETRY_TEMPLATE_CATALOG)(
    'compiles $id deterministically with host-owned references',
    (template) => {
      const input = { templateId: template.id, parameters: template.defaultParameters }
      const first = compileGeometryTemplate(input),
        second = compileGeometryTemplate(input)
      expect(first).toEqual(second)
      expect(first.subject).toBe('math')
      expect(first.kind).toBe('math')
      expect(first.source).toContain('原创')
      expect(first.source).toContain('非真题')
      expect(first.explanation).toContain('自行制定')
      expect(first.rubric!.reduce((total, item) => total + item.points, 0)).toBe(first.maxScore)
      expect(geometrySceneSchema.parse(first.geometry)).toEqual(first.geometry)
      expect(questionBankSchema.parse({ version: 1, questions: [first] }).questions[0]).toEqual(
        first,
      )
      expect(compileGeometryTemplate(input, 'geometry-custom-123').id).toBe('geometry-custom-123')
      const student = studentQuestionProjection(first)
      expect(studentQuestionSchema.parse(student)).toEqual(student)
      for (const key of ['explanation', 'rubric', 'correctAnswer', 'expectedAnswers', 'metrics'])
        expect(student).not.toHaveProperty(key)
      expect(student.geometry).toEqual(first.geometry)
      expect(student.geometry).not.toBe(first.geometry)
      expect(JSON.stringify(student)).not.toMatch(/"(foot|volume|cosine|normal|answer|reference)":/)
    },
  )

  it('exports copyable generation prompts with real signatures and a six-call budget', () => {
    for (const template of GEOMETRY_TEMPLATE_CATALOG) {
      const text = geometryTemplatePrompt(template.id)
      expect(text).toContain('generate_geometry_question(')
      expect(text).toContain(`"templateId":"${template.id}"`)
      expect(text).toContain('geometry_calculate({request:{operation,...}})')
      expect(text).toContain('最多调用6次工具')
      expect(text).toContain('不是隐式直线、3D作图或符号代数')
      expect(text).toContain('不自动保存')
      expect(text).not.toMatch(/https?:|<svg|eval\(/)
    }
    expect(GEOMETRY_GENERATION_INSTRUCTIONS).toContain('search_formulas({query,limit:1})')
  })

  it('publishes a top-level MCP object schema while rejecting mismatched parameter families', () => {
    const schema = z.toJSONSchema(geometryTemplateToolSchema) as Record<string, unknown>
    expect(schema.type).toBe('object')
    expect(schema.additionalProperties).toBe(false)
    expect(Object.keys(schema.properties as object)).toEqual(['templateId', 'parameters'])
    for (let i = 0; i < 4; i++)
      expect(geometryTemplateToolSchema.parse(defaults(i))).toEqual(defaults(i))
    const mismatch = { templateId: 'square-pyramid-locus', parameters: defaults(0).parameters }
    expect(geometryTemplateToolSchema.safeParse(mismatch).success).toBe(false)
    expect(geometryTemplateInputSchema.safeParse(mismatch).success).toBe(false)
  })

  it('rejects injected output fields, nonfinite numbers, wrong bounds and unsafe identifiers', () => {
    const valid = defaults(3)
    const invalid = [
      { ...valid, prompt: 'replace the question' },
      { ...valid, explanation: 'forged answer' },
      { ...valid, geometry: { points: [] } },
      { ...valid, maxScore: 100 },
      { ...valid, svg: '<svg/>' },
      { ...valid, url: 'https://example.com' },
      { ...valid, parameters: { side: 5, answers: [] } },
      { ...valid, parameters: { side: 1 } },
      { ...valid, parameters: { side: 13 } },
      { ...valid, parameters: { side: 2.5 } },
      { ...valid, parameters: { side: Infinity } },
      { ...valid, parameters: { side: NaN } },
      { ...valid, parameters: { side: '5' } },
      { ...valid, templateId: 'unknown' },
      { ...defaults(0), parameters: { ...defaults(0).parameters, bX: 0 } },
      { ...defaults(2), parameters: { ...defaults(2).parameters, leanX: 1 } },
      { ...defaults(2), parameters: { ...defaults(2).parameters, edgeFraction: 1 } },
    ]
    for (const input of invalid) expect(() => compileGeometryTemplate(input)).toThrow()
    for (const id of ['constructor', '../answer', '<script>', '', 'x'.repeat(81)])
      expect(() => compileGeometryTemplate(valid, id)).toThrow()
    let accessed = false
    const accessor = Object.defineProperty({}, 'templateId', {
      enumerable: true,
      get() {
        accessed = true
        return valid.templateId
      },
    })
    expect(() => compileGeometryTemplate(accessor)).toThrow()
    expect(accessed).toBe(false)
    expect(() => compileGeometryTemplate(Object.create(valid))).toThrow()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => compileGeometryTemplate(cyclic)).toThrow()
  })

  it('computes signed vector angles and both nonzero orthogonal-combination roots across boundary values', () => {
    for (const aX of [1, 6])
      for (const bX of [-6, -1, 1, 6])
        for (const bZ of [1, 6])
          for (const mix of [1, 4]) {
            const q = compileGeometryTemplate({
              templateId: 'vector-angle-orthogonality',
              parameters: { aX, bX, bZ, mix },
            })
            const aa = aX * aX + 1,
              bb = bX * bX + bZ * bZ,
              ab = aX * bX
            const coefficient = (1 - mix) * ab,
              discriminant = coefficient ** 2 + 4 * aa * mix * bb
            const cosine = ab / Math.sqrt(aa * bb)
            expect(q.explanation).toContain(`≈${number(cosine)}`)
            expect(q.explanation).toContain(bX < 0 ? '钝角' : '锐角')
            for (const sign of [-1, 1]) {
              const k = (-coefficient + sign * Math.sqrt(discriminant)) / (2 * aa)
              expect(q.explanation).toContain(number(k))
              const first = { x: k * aX + bX, y: k, z: bZ }
              const second = { x: k * aX - mix * bX, y: k, z: -mix * bZ }
              expect(dot(first, second)).toBeCloseTo(0, 8)
              expect(dot(first, first)).toBeGreaterThan(0)
              expect(dot(second, second)).toBeGreaterThan(0)
            }
          }
  })

  it('constructs altitude problems without leaking the solved foot and handles vertical altitude lines', () => {
    const q = compileGeometryTemplate(defaults(1))
    expect(q.explanation).toContain('4x + 2y + 5 = 0')
    expect(q.explanation).toContain('D=B+0.25BC=(-1, -0.5)')
    expect(q.explanation).toContain('x + 2y + 2 = 0')
    // The primitive equation is simplified by the compiler.
    const vertical = compileGeometryTemplate({
      templateId: 'triangle-altitude-parallel',
      parameters: { run: 4, rise: 0, footFraction: 0.5, height: 1, offsetX: -2, offsetY: -1 },
    })
    expect(vertical.explanation).toContain('化简为x = 0')
    expect(q.geometry!.points.map((point) => point.id)).toEqual(['A', 'B', 'C'])
    expect(q.geometry!.rightAngles).toBeUndefined()
    const invalid = {
      templateId: 'triangle-altitude-parallel',
      parameters: { run: 8, rise: 6, footFraction: 0.75, height: 4, offsetX: 5, offsetY: 5 },
    }
    expect(() => compileGeometryTemplate(invalid)).toThrow(/\[-10,10\]/)
  })

  it('validates planar canvas bounds jointly and computes each accepted triangle without degeneracy', () => {
    let accepted = 0,
      rejected = 0
    for (const run of [1, 4, 8])
      for (const rise of [-6, 0, 6])
        for (const height of [1, 4])
          for (const footFraction of [0.25, 0.5, 0.75]) {
            const input = {
              templateId: 'triangle-altitude-parallel',
              parameters: { run, rise, height, footFraction, offsetX: -2, offsetY: -1 },
            }
            if (!geometryTemplateInputSchema.safeParse(input).success) {
              rejected++
              continue
            }
            const q = compileGeometryTemplate(input)
            accepted++
            expect(
              q.geometry!.points.every(
                (p) => Math.abs(p.x) <= 10 && Math.abs(p.y) <= 10 && p.z === 0,
              ),
            ).toBe(true)
            const A = scenePoint(q, 'A'),
              B = scenePoint(q, 'B'),
              C = scenePoint(q, 'C')
            const areaTwice = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x)
            expect(Math.abs(areaTwice)).toBeGreaterThan(0)
          }
    expect(accepted).toBeGreaterThan(10)
    expect(rejected).toBeGreaterThan(10)
  })

  it('preserves genuinely oblique side edges and Gram-positive length and line-angle computations', () => {
    for (const baseA of [2, 10])
      for (const baseB of [2, 10])
        for (const side of [2, 10])
          for (const leanX of [0.25, 0.5])
            for (const leanY of [0.25, 0.5])
              for (const edgeFraction of [0.25, 0.5, 0.75]) {
                const q = compileGeometryTemplate({
                  templateId: 'oblique-parallelepiped',
                  parameters: { baseA, baseB, side, leanX, leanY, edgeFraction },
                })
                const c = scenePoint(q, 'A1'),
                  e = scenePoint(q, 'E')
                expect(c.x).toBeGreaterThan(0)
                expect(c.y).toBeGreaterThan(0)
                expect(c.z).toBeGreaterThan(0)
                expect(Math.hypot(c.x, c.y, c.z)).toBeCloseTo(side, 10)
                const squaredLength =
                  baseA ** 2 +
                  baseB ** 2 +
                  edgeFraction ** 2 * side ** 2 +
                  2 * edgeFraction * side * (baseA * leanX + baseB * leanY)
                expect(dot(e, e)).toBeCloseTo(squaredLength, 8)
                expect(q.explanation).toContain(
                  `AE=√${number(squaredLength)}≈${number(Math.sqrt(squaredLength))}`,
                )
                const cosine = (baseB + edgeFraction * side * leanY) / Math.sqrt(squaredLength)
                expect(q.explanation).toContain(`≈${number(cosine)}`)
                expect(q.geometry!.rightAngles).toEqual([
                  { id: 'given-base-right-angle', vertex: 'A', from: 'B', to: 'D' },
                ])
              }
  })

  it('proves the pyramid interior root, volume and whole-plane range at every supported scale', () => {
    for (let s = 2; s <= 12; s++) {
      const q = compileGeometryTemplate({
        templateId: 'square-pyramid-locus',
        parameters: { side: s },
      })
      const student = studentQuestionProjection(q)
      expect(q.geometry!.points.map((point) => point.id)).toEqual(['P', 'A', 'B', 'C', 'D', 'E'])
      expect(q.geometry!.rightAngles).toEqual([
        { id: 'given-square-angle', vertex: 'A', from: 'B', to: 'D' },
      ])
      expect(student.prompt).not.toContain('1/5')
      expect(JSON.stringify(student)).not.toContain('√(8/17)')
      expect(q.explanation).toContain('5t²−6t+1=0')
      expect(q.explanation).toContain('排除t=1')
      expect(q.explanation).toContain(`${s}³/90≈${number(s ** 3 / 90)}`)
      expect(q.explanation).toContain('完整范围为(0,√(8/17)]')
      expect(q.explanation).toContain('0取不到')
      expect(q.explanation).toContain('连续递减')
      expect(q.explanation).toContain('[2/√17,√(8/17)]')
      const A = { x: 0, y: 0, z: 0 },
        D = { x: 0, y: s, z: 0 }
      const F = { x: s / 5, y: s / 5, z: (4 * s) / 5 },
        G = { x: s / 3, y: 0, z: (2 * s) / 3 }
      for (const h of [-1e3, -s, 0, s / 2, s, 2 * s, 1e3]) {
        const result = executeGeometryTool({
          request: {
            operation: 'line_plane_angle',
            from: G,
            to: F,
            a: { x: h, y: -13, z: s - h },
            b: A,
            c: D,
          },
        })
        if (result.operation !== 'line_plane_angle') throw new Error('Wrong result')
        expect(result.sine).toBeCloseTo((2 * s) / Math.sqrt(17 * ((s - h) ** 2 + h ** 2)), 10)
        expect(result.sine).toBeGreaterThan(0)
        expect(result.sine).toBeLessThanOrEqual(Math.sqrt(8 / 17) + 1e-12)
        if (h === s / 2) expect(result.sine).toBeCloseTo(Math.sqrt(8 / 17), 10)
      }
    }
  })
})
