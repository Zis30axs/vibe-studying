import { describe, expect, it } from 'vitest'
import {
  angle,
  distance,
  parseExpression,
  parseFunctionExpression,
  sampleFunction,
} from '../src/domain/math'
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

describe('friendly expression input', () => {
  const examples: [string, string, number][] = [
    ['y = 2x+1', '2*x+1', 5],
    ['  y \t= \n 2(x+1) ', '2*(x+1)', 6],
    ['(x+1)(x-1)', '(x+1)*(x-1)', 3],
    ['ax^2+bx+c', 'a*x^2+b*x+c', 18],
    ['2abx', '2*a*b*x', 24],
    ['2sin(x)', '2*sin(x)', 2 * Math.sin(2)],
    ['sin(2x)cos(x)', 'sin(2*x)*cos(x)', Math.sin(4) * Math.cos(2)],
    ['2pi x', '2*pi*x', 4 * Math.PI],
    ['3e', '3*e', 3 * Math.E],
    ['e(x+1)', 'e*(x+1)', 3 * Math.E],
    ['sqrt(4)x', 'sqrt(4)*x', 4],
    ['x(x+1)', 'x*(x+1)', 6],
    ['(x+1)2', '(x+1)*2', 6],
    ['.5x + 2.0(x-1)', '.5*x+2.0*(x-1)', 3],
    ['2e3x+1e-2x', '2e3*x+1e-2*x', 4000.02],
    ['2E+3x', '2E+3*x', 4000],
    ['2e-3', '2e-3', 0.002],
    ['2e - 3', '2*e-3', 2 * Math.E - 3],
    ['2 * e + x', '2*e+x', 2 * Math.E + 2],
    ['e exp(x)', 'e*exp(x)', Math.E * Math.exp(2)],
    ['sin(x) cos(x)', 'sin(x)*cos(x)', Math.sin(2) * Math.cos(2)],
    ['2×x+3·x−4⋅x', '2*x+3*x-4*x', 2],
    ['2÷(x+1)', '2/(x+1)', 2 / 3],
    ['1/(2x)', '1/(2*x)', 0.25],
    ['(1/2)x', '(1/2)*x', 1],
    ['1/2*x', '1/2*x', 1],
    ['2x/2', '2*x/2', 2],
    ['2x^2', '2*x^2', 8],
    ['-2x^2', '-2*x^2', -8],
    ['(-2x)^2', '(-2*x)^2', 16],
    ['2^-2x', '2^-2*x', 0.5],
    ['2^3^2x', '2^3^2*x', 1024],
  ]
  it.each(examples)(
    'normalizes %s as %s without changing evaluation',
    (source, normalized, expected) => {
      const parsed = parseFunctionExpression(source)
      expect(parsed.normalizedExpression).toBe(normalized)
      expect(parsed.evaluate(2, { a: 2, b: 3, c: 4 })).toBeCloseTo(expected)
      const again = parseFunctionExpression(normalized)
      expect(again.normalizedExpression).toBe(normalized)
      for (const x of [-3, -0.5, 0, 0.25, 2, 10]) {
        expect(again.evaluate(x)).toBe(parsed.evaluate(x))
      }
      expect(
        mathWorkbenchSchema.safeParse({ ...emptyMathState(), expression: normalized }).success,
      ).toBe(true)
    },
  )
  it.each(['1/2x', '6/2(x+1)', '1/x(x+1)', 'a/bc', '1/2sin(x)', '1/2^2x', '1/-2x', 'sin(1/2x)'])(
    'rejects ambiguous denominator scope in %s with a fix',
    (source) => {
      expect(() => parseFunctionExpression(source)).toThrow(/含义不明确.*1\/\(2\*x\)/)
    },
  )
  it.each([
    'y=',
    'y = ',
    'y=x=2',
    'y==x',
    'f(x)=x',
    'x=2',
    '2 3',
    '1..2',
    '1.2.3',
    'x2',
    'pi2',
    '2e 3',
    '2e+',
    'sinx',
    'sin x',
    'sin^2(x)',
    'xsin(x)',
    'sin()',
    'sinh(x)',
    'log10(x)',
    'unknown(x)',
    'xy',
    'abz',
    'PI',
    'X',
    'pix',
    'ex',
    'Math.sin(x)',
    'x.constructor',
    'constructor(x)',
    '__proto__',
    'y=alert(1)',
    '[x]',
    '{x}',
    'x;2',
    'x,2',
    'x\u200b+1',
    '2**x',
    '(x)(window)',
  ])('does not guess unsupported or malformed syntax: %s', (source) => {
    expect(() => parseFunctionExpression(source)).toThrow()
  })
  it('keeps names and scientific notation intact and requires function parentheses', () => {
    expect(parseFunctionExpression('2exp(x)+log(e)').normalizedExpression).toBe('2*exp(x)+log(e)')
    expect(() => parseFunctionExpression('2sin x')).toThrow('sin 需要括号')
    expect(() => parseFunctionExpression('sinx')).toThrow('sin 需要括号')
    expect(() => parseFunctionExpression('y=x=2')).toThrow('只支持开头的 y =')
    expect(() => parseFunctionExpression('y=')).toThrow('y = 后请输入函数表达式')
  })
  it('counts inserted multiplication toward the same resource and persistence limits', () => {
    expect(() => parseFunctionExpression('x'.repeat(61))).toThrow('120')
    // Under 120 tokens and 160 source characters, but over 160 after inserting multiplication.
    const expanded = '123456789x+'.repeat(13) + '123456789x'
    expect(expanded.length).toBeLessThanOrEqual(160)
    expect(() => parseFunctionExpression(expanded)).toThrow('补全乘号后的表达式最多 160')
    expect(() => parseFunctionExpression('y=' + '1'.repeat(159))).toThrow('160')
    expect(() => parseFunctionExpression('2(' + '('.repeat(32) + 'x' + ')'.repeat(33))).toThrow(
      '32',
    )
    expect(() => parseFunctionExpression('1e999x')).toThrow('数字必须是有限值')
    const boundary = parseFunctionExpression('x'.repeat(60))
    expect(boundary.normalizedExpression).toHaveLength(119)
    expect(parseFunctionExpression(boundary.normalizedExpression).evaluate(1)).toBe(1)
  })
  it('samples shorthand identically to explicit expressions, including parameter changes', () => {
    for (const parameters of [
      { a: 1, b: 0, c: 0 },
      { a: -2, b: 0.5, c: 3 },
    ]) {
      expect(sampleFunction('y=ax^2+bx+c', parameters)).toEqual(
        sampleFunction('a*x^2+b*x+c', parameters),
      )
      expect(sampleFunction('2sin(x)', parameters)).toEqual(sampleFunction('2*sin(x)', parameters))
    }
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
  it('accepts optional canvas preferences without rewriting legacy math snapshots', () => {
    const { snapStep: _, showProjections: __, projectionColor: ___, ...legacy } = emptyMathState()
    expect(mathWorkbenchSchema.parse(legacy)).toEqual(legacy)
    expect(mathWorkbenchSchema.parse(legacy)).not.toHaveProperty('snapStep')
    for (const snapStep of [0.01, 0.125, 0.333333, 1, 10]) {
      const state = { ...legacy, snapStep, showProjections: false, projectionColor: '#AABBCC' }
      expect(mathWorkbenchSchema.parse(state)).toEqual(state)
    }
    for (const snapStep of [0, -1, 0.009, 11, NaN, Infinity, 0.0123456])
      expect(mathWorkbenchSchema.safeParse({ ...legacy, snapStep }).success).toBe(false)
    for (const projectionColor of ['red', '#abc', '#gggggg', 'url(example)', '#12345678'])
      expect(mathWorkbenchSchema.safeParse({ ...legacy, projectionColor }).success).toBe(false)
    expect(mathWorkbenchSchema.safeParse({ ...legacy, showProjections: 'false' }).success).toBe(
      false,
    )
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
