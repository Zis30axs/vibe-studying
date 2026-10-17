import { describe, expect, it } from 'vitest'
import { mathChallengePapers } from '../src/domain/math-challenge-papers'
import { mathChallengePaperSchema } from '../src/domain/math-challenge'

const paperA = mathChallengePapers[0]
const paperB = mathChallengePapers[1]
const question = (number: number) => paperA.questions[number - 1]
const dot = (a: number[], b: number[]) => a.reduce((sum, n, i) => sum + n * b[i], 0)
const norm = (a: number[]) => Math.hypot(...a)
const samples = Array.from({ length: 2001 }, (_, i) => (2 * Math.PI * i) / 2000)

describe('original stage-comprehensive mathematics papers', () => {
  it('validates both complete 150-point, 120-minute presets with usable reference rubrics', () => {
    expect(mathChallengePapers).toHaveLength(2)
    for (const paper of mathChallengePapers) {
      expect(mathChallengePaperSchema.parse(paper)).toEqual(paper)
      expect(paper.questions).toHaveLength(14 + paper.solutionCount)
      expect(paper.questions.reduce((sum, q) => sum + q.points, 0)).toBe(150)
      expect(paper.questions.slice(14).map((q) => q.points)).toEqual(
        paper.solutionCount === 5 ? [13, 15, 15, 17, 17] : [12, 12, 12, 13, 13, 15],
      )
      expect(paper.source).toContain('原创')
      expect(paper.source).toContain('非历年真题')
      for (const q of paper.questions) {
        expect(q.rubric.reduce((sum, item) => sum + item.points, 0)).toBe(q.points)
        expect(q.explanation.length).toBeGreaterThan(30)
      }
    }
    expect(paperA.questions[0]).not.toBe(paperB.questions[0])
    expect(paperA.questions[18].prompt).toContain('实数 m')
    expect(paperB.questions[18].prompt).not.toContain('实数 m')
    expect(paperB.questions[19].id).toBe('mc-q20')
  })

  it('checks the elementary single-choice keys against interval, trigonometric and vector calculations', () => {
    const inIntersection = (x: number) => x * x - 4 * x <= 0 && x > 1 && x < 5
    expect([1, 2, 4, 5].map(inIntersection)).toEqual([false, true, true, false])
    expect(question(1).correctChoiceIds).toEqual(['B'])
    const trig = (x: number) => 2 * Math.sin(x) ** 2 + 2 * Math.sin(x) * Math.cos(x)
    expect(trig((3 * Math.PI) / 8)).toBeCloseTo(1 + Math.sqrt(2), 12)
    expect(Math.max(...samples.map(trig))).toBeLessThanOrEqual(1 + Math.sqrt(2) + 1e-12)
    expect(question(2).correctChoiceIds).toEqual(['C'])
    // Check every candidate line passes through P, then distinguish perpendicularity.
    const lines = [
      [1, -2, -4],
      [2, -1, -5],
      [1, 2, 0],
      [2, 1, -3],
    ]
    const validLines = lines.flatMap(([a, b, c], i) =>
      2 * a - b + c === 0 && a - 2 * b === 0 ? ['ABCD'[i]] : [],
    )
    expect(question(3).correctChoiceIds).toEqual(validLines)
    expect(dot([1, 2, -1], [2, -1, 2])).toBe(-2)
    expect(question(4).choices?.find((c) => c.id === question(4).correctChoiceIds?.[0])?.text).toBe(
      '−2',
    )
    const linePlaneSin = 1 / norm([1, 1, 1])
    expect(linePlaneSin).toBeCloseTo(Math.sqrt(3) / 3, 12)
    expect(question(7).correctChoiceIds).toEqual(['D'])
  })

  it('checks circle extrema, attainable endpoints and the fixed-base area factor', () => {
    const radiusSquared = (m: number) => m * m - 2 * m + 4
    expect(radiusSquared(1)).toBe(3)
    for (const m of [-100, -2, 0, 1, 2, 100]) expect(radiusSquared(m)).toBeGreaterThanOrEqual(3)
    expect(question(5).correctChoiceIds).toEqual(['B'])
    const base = Math.hypot(4, 4)
    const areas = samples.map((theta) => {
      const x = 2 + Math.sqrt(2) * Math.cos(theta)
      const y = Math.sqrt(2) * Math.sin(theta)
      return (0.5 * base * Math.abs(x + y + 4)) / Math.sqrt(2)
    })
    expect(Math.min(...areas)).toBeCloseTo(8, 10)
    expect(Math.max(...areas)).toBeCloseTo(16, 10)
    expect(question(6).correctChoiceIds).toEqual(['C'])
    for (const theta of samples) {
      const slope = Math.sin(theta) / (Math.cos(theta) - 2)
      expect(Math.abs(slope)).toBeLessThanOrEqual(1 / Math.sqrt(3) + 1e-10)
    }
    // At a tangent the limiting value really is attained, so the interval is closed.
    const x = 0.5
    const y = Math.sqrt(3) / 2
    expect(Math.abs(y / (x - 2))).toBeCloseTo(1 / Math.sqrt(3), 12)
    expect(question(8).correctChoiceIds).toEqual(['A'])
  })

  it('verifies every multiselect assertion independently, including a quadratic-domain counterexample', () => {
    const circleTruth = [
      2 === 2,
      2 * Math.sqrt(2 ** 2 - 1 ** 2) === 2 * Math.sqrt(3),
      Math.sqrt(3 ** 2 - 2 ** 2) === Math.sqrt(5),
      Math.hypot(2, 1) < 2,
    ]
    expect(question(9).correctChoiceIds).toEqual(
      circleTruth.flatMap((truth, i) => (truth ? ['ABCD'[i]] : [])),
    )
    const a = [1, 0, 1],
      b = [0, 1, 1],
      c = [1, 1, 0]
    const bMinusC = b.map((n, i) => n - c[i])
    expect(dot(a, b)).toBe(1)
    expect(dot(a, bMinusC)).toBe(0)
    // First two coordinates force λ=μ=1; the third coordinate then contradicts c.
    expect(a[2] + b[2]).not.toBe(c[2])
    expect(question(10).correctChoiceIds).toEqual(['A', 'B'])
    const boundedMinimum = (t: number) => {
      const x = Math.max(0, Math.min(2, t))
      return x * x - 2 * t * x + 3
    }
    for (const t of [-10, -1, 0]) expect(boundedMinimum(t)).toBe(3)
    for (const t of [0, 0.5, 1, 2]) expect(boundedMinimum(t)).toBeCloseTo(3 - t * t, 12)
    expect(boundedMinimum(3)).toBe(-5)
    expect(boundedMinimum(3)).not.toBe(3 - 3 ** 2)
    expect(question(11).correctChoiceIds).toEqual(['A', 'B', 'D'])
  })

  it('checks all fill-in answers and verifies the area maximum occurs on an allowed secant', () => {
    const maximizingPoint = [1 + 3 / Math.sqrt(5), -2 + 6 / Math.sqrt(5)]
    expect((maximizingPoint[0] - 1) ** 2 + (maximizingPoint[1] + 2) ** 2).toBeCloseTo(9, 12)
    expect(maximizingPoint[0] + 2 * maximizingPoint[1]).toBeCloseTo(-3 + 3 * Math.sqrt(5), 12)
    expect(question(12).answer).toBe('−3＋3√5。')
    const cosine = dot([1, 0, 1], [0, 1, 1]) / (Math.sqrt(2) * Math.sqrt(2))
    expect(Math.acos(cosine)).toBeCloseTo(Math.PI / 3, 12)
    expect(question(13).answer).toContain('π/3')
    const k = Math.sqrt(3),
      radiusSquared = 2
    const distanceSquared = 4 / (1 + k * k)
    expect(distanceSquared).toBeGreaterThan(0)
    expect(distanceSquared).toBeLessThan(radiusSquared)
    expect(Math.sqrt(distanceSquared * (radiusSquared - distanceSquared))).toBeCloseTo(1, 12)
    expect(question(14).answer).toBe('1。')
    // This fill-in and the later long problem have distinct inputs and maxima.
    expect(question(14).answer).not.toBe('2。')
  })

  it('checks both endpoint and interior distance extrema over the entire moving circle', () => {
    for (const theta of samples) {
      const x = 2 + Math.cos(theta),
        y = Math.sin(theta)
      const op = Math.hypot(x, y),
        ap = Math.hypot(x - 4, y)
      expect(op * op).toBeCloseTo(4 * x - 3, 10)
      expect(op * ap).toBeGreaterThanOrEqual(3 - 1e-10)
      expect(op * ap).toBeLessThanOrEqual(5 + 1e-10)
      expect(op + ap).toBeGreaterThanOrEqual(4 - 1e-10)
      expect(op + ap).toBeLessThanOrEqual(2 * Math.sqrt(5) + 1e-10)
    }
    expect(Math.hypot(2, 1) ** 2).toBeCloseTo(5, 12)
    expect(question(16).answer).toContain('[3，5]')
    expect(question(16).answer).toContain('[4，2√5]')
  })

  it('checks the spatial construction, parallel separation and angle/distance projections', () => {
    const normal = [1, 1, 1],
      e = [2, 0, 1],
      f = [0, 2, 1]
    expect(dot(normal, [0, 0, 2])).toBe(2)
    expect(dot(normal, e)).toBe(3)
    expect(dot(normal, f)).toBe(3)
    expect(
      dot(
        normal,
        f.map((n, i) => n - e[i]),
      ),
    ).toBe(0)
    expect(Math.abs(dot(e, normal)) / (norm(e) * norm(normal))).toBeCloseTo(Math.sqrt(15) / 5, 12)
    expect(Math.abs(dot([2, 2, 2], normal) - 2) / norm(normal)).toBeCloseTo(
      (4 * Math.sqrt(3)) / 3,
      12,
    )
    expect(question(17).answer).toContain('√15/5')
    expect(question(17).answer).toContain('4√3/3')
  })

  it('checks secant restrictions, attainable area optimum, and both directions of the midpoint locus', () => {
    for (const k of [-100, -10, -2, -1.2, 1.2, 2, 10, 100]) {
      const x = (-3 * k) / (1 + k * k),
        y = 3 / (1 + k * k)
      const dSquared = x * x + y * y
      expect(dSquared).toBeCloseTo(3 * y, 12)
      expect(dSquared).toBeGreaterThan(0)
      expect(dSquared).toBeLessThan(4)
      // Reconstruct the unique finite slope, rather than adding the origin to the locus.
      expect(-x / y).toBeCloseTo(k, 10)
    }
    expect(9 / (1 + (Math.sqrt(5) / 2) ** 2)).toBeCloseTo(4, 12)
    for (const k of [-Math.sqrt(14) / 2, Math.sqrt(14) / 2]) {
      const dSquared = 9 / (1 + k * k)
      expect(Math.sqrt(dSquared * (4 - dSquared))).toBeCloseTo(2, 12)
    }
    expect(question(18).answer).toContain('0<x²＋y²<4')
    expect(question(18).answer).toContain('k＝±√14/2')
  })

  it('verifies the ratio endpoints and the universal parameter bound using actual equality/counterexample points', () => {
    for (const theta of samples) {
      const x = 2 + Math.cos(theta),
        y = Math.sin(theta)
      const ratio = (y + 1) / x
      expect(ratio).toBeGreaterThanOrEqual(-1e-10)
      expect(ratio).toBeLessThanOrEqual(4 / 3 + 1e-10)
    }
    expect((-1 + 1) / 2).toBe(0)
    expect((3 / 5 + 1) / (6 / 5)).toBeCloseTo(4 / 3, 12)
    for (const m of [-4, -3, 0, 3, 4]) {
      const length = Math.hypot(4, m)
      const x = 2 - 4 / length,
        y = m / length
      expect((x - 2) ** 2 + y * y).toBeCloseTo(1, 12)
      const minimum = x * x + y * y - m * y
      expect(minimum).toBeCloseTo(5 - length, 12)
      if (Math.abs(m) > 3) expect(minimum).toBeLessThan(0)
      else expect(minimum).toBeGreaterThanOrEqual(-1e-12)
    }
    expect(question(19).answer).toContain('−3≤m≤3')
  })

  it('checks the six-solution extension including signs of the two equality points', () => {
    for (const t of [-3, -2.5, 0, 2.5, 3]) {
      const length = Math.hypot(6, t)
      const x = 3 - 12 / length,
        y = (2 * t) / length
      expect((x - 3) ** 2 + y * y).toBeCloseTo(4, 12)
      expect(x * x + y * y - t * y).toBeCloseTo(13 - 2 * length, 12)
      if (Math.abs(t) > 2.5) expect(13 - 2 * length).toBeLessThan(0)
      else expect(13 - 2 * length).toBeGreaterThanOrEqual(-1e-12)
    }
    for (const sign of [-1, 1]) {
      const t = sign * 2.5,
        x = 15 / 13,
        y = (sign * 10) / 13
      expect((x - 3) ** 2 + y * y).toBeCloseTo(4, 12)
      expect(x * x + y * y).toBeCloseTo(t * y, 12)
    }
    expect(paperB.questions[19].answer).toContain('−5/2≤t≤5/2')
  })
})
