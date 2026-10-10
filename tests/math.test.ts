import { describe, expect, it } from 'vitest'
import { angle, distance, parseExpression, sampleFunction } from '../src/domain/math'
import { draftSchema, mathWorkbenchSchema, studyStateSchema } from '../src/domain/schemas'
import { emptyDraft, emptyMathState } from '../src/shared/types'

describe('safe arithmetic expressions', () => {
  it('supports parameters, constants, functions and standard precedence', () => {
    expect(parseExpression('a*x^2+b*x+c')(2, { a: 2, b: 3, c: 4 })).toBe(18)
    expect(parseExpression('-2^2 + 2^-2 + 2^3^2')(0)).toBe(508.25)
    expect(parseExpression('sin(pi/2)+cos(0)+sqrt(9)+abs(-2)+log(e)+exp(0)+tan(0)')(0)).toBeCloseTo(
      9,
    )
    expect(parseExpression('+.5 + 1e-2')(0)).toBeCloseTo(0.51)
  })
  it.each([
    'alert(1)',
    'globalThis',
    'constructor',
    '__proto__',
    'x.constructor',
    'process.exit()',
    'Math.sin(x)',
    'x=2',
    '[1]',
    'x;1',
    '(() => 1)()',
    '2x',
    '2(x+1)',
    'sin x',
    'sin()',
    'x+',
    '(x',
    'x)',
    '',
    '1e999',
  ])('rejects unsupported or executable syntax: %s', (source) => {
    expect(() => parseExpression(source)).toThrow()
  })
  it('bounds source length, tokens and nesting', () => {
    expect(() => parseExpression(' '.repeat(160) + 'x')).toThrow()
    expect(() => parseExpression('1+'.repeat(61) + '1')).toThrow()
    expect(() => parseExpression('('.repeat(33) + 'x' + ')'.repeat(33))).toThrow()
    expect(() => parseExpression('-'.repeat(33) + 'x')).toThrow()
    expect(() => parseExpression('a')(0, { a: Infinity, b: 0, c: 0 })).toThrow()
    expect(() => parseExpression('a')(0, { a: 11, b: 0, c: 0 })).toThrow()
  })
})

describe('function sampling', () => {
  it('treats empty expressions as no function without relaxing the parser', () => {
    for (const source of ['', '  \t']) {
      expect(sampleFunction(source)).toEqual([])
      expect(() => parseExpression(source)).toThrow()
      expect(
        mathWorkbenchSchema.safeParse({ ...emptyMathState(), expression: source }).success,
      ).toBe(true)
    }
  })
  it('produces bounded coordinate-domain points for a continuous function', () => {
    const segments = sampleFunction('x')
    expect(segments).toHaveLength(1)
    expect(segments[0][0]).toEqual({ x: -10, y: -10 })
    expect(segments[0].at(-1)).toEqual({ x: 10, y: 10 })
  })
  it.each(['1/x', '1/(x-0.012)', 'tan(x)'])('does not bridge asymptotes for %s', (expression) => {
    const segments = sampleFunction(expression)
    expect(segments.length).toBeGreaterThan(1)
    for (const segment of segments) {
      for (let i = 1; i < segment.length; i++) {
        expect(Math.abs(segment[i].y - segment[i - 1].y)).toBeLessThanOrEqual(2)
      }
    }
    expect(
      segments
        .flat()
        .every(
          ({ x, y }) =>
            Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) <= 10 && Math.abs(y) <= 10,
        ),
    ).toBe(true)
    if (expression.startsWith('1/')) {
      const pole = expression === '1/x' ? 0 : 0.012
      expect(segments.every((segment) => !(segment[0].x < pole && segment.at(-1)!.x > pole))).toBe(
        true,
      )
    }
  })
  it('handles invalid domains and accepts pre-parsed functions', () => {
    expect(sampleFunction('sqrt(-1)')).toEqual([])
    expect(sampleFunction('exp(1000)')).toEqual([])
    expect(
      sampleFunction(parseExpression('sqrt(x)'))
        .flat()
        .every((point) => point.x >= 0),
    ).toBe(true)
  })
})

describe('geometry measurements', () => {
  it('calculates distances and angles with the middle point as vertex', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5)
    expect(angle({ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 })).toBeCloseTo(90)
    expect(angle({ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 })).toBeCloseTo(180)
    expect(angle({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 })).toBeNull()
  })
})

describe('persisted math state', () => {
  it('accepts new and old drafts without changing the original drawing', () => {
    const draft = emptyDraft()
    expect(draftSchema.parse(draft)).toEqual(draft)
    const { math: _, ...oldDraft } = draft
    expect(draftSchema.parse(oldDraft)).toEqual(oldDraft)
    expect(
      studyStateSchema.parse({ version: 1, drafts: { old: oldDraft }, attempts: [] }).drafts.old,
    ).not.toHaveProperty('math')
    draft.math!.drawing.points.push({ id: 'p1', x: 1, y: 2, label: 'A' })
    expect(draft.drawing.points).toEqual([])
    expect(emptyMathState().drawing.points).toEqual([])
  })
  it('validates Cartesian coordinates, syntax, bounded finite parameters and point references', () => {
    const state = emptyMathState()
    state.drawing.points = [{ id: 'p1', x: 1, y: 2, label: 'A' }]
    state.measurement = ['p1']
    expect(mathWorkbenchSchema.safeParse(state).success).toBe(true)
    expect(mathWorkbenchSchema.safeParse({ ...state, expression: 'x.constructor' }).success).toBe(
      false,
    )
    expect(mathWorkbenchSchema.safeParse({ ...state, expression: 'x'.repeat(161) }).success).toBe(
      false,
    )
    for (const a of [NaN, Infinity, -11, 11])
      expect(
        mathWorkbenchSchema.safeParse({ ...state, parameters: { a, b: 0, c: 0 } }).success,
      ).toBe(false)
    for (const measurement of [['missing'], ['p1', 'p1'], ['p1', 'p2', 'p3', 'p4']])
      expect(mathWorkbenchSchema.safeParse({ ...state, measurement }).success).toBe(false)
    expect(
      mathWorkbenchSchema.safeParse({ ...state, drawing: { ...state.drawing, mode: 'geographic' } })
        .success,
    ).toBe(false)
    expect(
      mathWorkbenchSchema.safeParse({
        ...state,
        drawing: { ...state.drawing, points: [{ id: 'p1', x: 11, y: 0, label: '' }] },
      }).success,
    ).toBe(false)
  })
})
