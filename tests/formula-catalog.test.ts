import { describe, expect, it } from 'vitest'
import { FORMULA_CATALOG_VERSION, FORMULA_ENTRIES } from '../src/domain/formula-catalog'

const byId = new Map(FORMULA_ENTRIES.map((entry) => [entry.id, entry]))
function formula(id: string) {
  const entry = byId.get(id)
  if (!entry) throw new Error(`Missing formula: ${id}`)
  return entry
}
function guidance(id: string) {
  const entry = formula(id)
  return [...entry.conditions, ...entry.pitfalls].join('\n')
}
const dot = (a: number[], b: number[]) => a.reduce((sum, value, i) => sum + value * b[i], 0)
const norm = (a: number[]) => Math.hypot(...a)
const degrees = (radians: number) => (radians * 180) / Math.PI
const radians = (degrees: number) => (degrees * Math.PI) / 180
const roundAngle = (angle: number) => Math.round(degrees(angle))
const unicodeNumber = (value: number) => String(value).replace('-', '−')
const vector = (values: number[]) => `(${values.map(unicodeNumber).join(', ')})`

// These calculations are independent of the display strings, with pinned question inputs.
// A changed example must update both the reviewed question and its independently computed result.
const examples = [
  {
    id: 'math.vector.components',
    question: 'A(1, −2, 3)，B(4, 2, −1)，求 AB。',
    answer: `AB = ${vector([4 - 1, 2 - -2, -1 - 3])}`,
  },
  {
    id: 'math.vector.magnitude',
    question: '求 a = (2, −3, 6) 的模。',
    answer: `|a| = ${norm([2, -3, 6])}`,
  },
  {
    id: 'math.vector.dot',
    question: 'a = (1, 2, −1)，b = (3, 0, 4)，求 a·b。',
    answer: `a·b = ${unicodeNumber(dot([1, 2, -1], [3, 0, 4]))}`,
  },
  {
    id: 'math.vector.angle',
    question: 'a = (1, 1, 0)，b = (1, 0, 1)，求夹角。',
    answer: `θ = ${roundAngle(Math.acos(dot([1, 1, 0], [1, 0, 1]) / (norm([1, 1, 0]) * norm([1, 0, 1]))))}°`,
  },
  {
    id: 'math.vector.projection',
    question: 'a = (3, 4, 0)，b = (2, 0, 0)，求沿 b 的数量投影及投影向量。',
    answer: `数量投影为 ${dot([3, 4, 0], [2, 0, 0]) / norm([2, 0, 0])}；投影向量为 ${vector([2, 0, 0].map((value) => (dot([3, 4, 0], [2, 0, 0]) / norm([2, 0, 0]) ** 2) * value))}`,
  },
  {
    id: 'math.vector.parallel',
    question: 'a = (1, −2, 3)，b = (−2, 4, −6)，是否平行？',
    answer: `b = ${unicodeNumber(-2 / 1)}a，两向量平行且反向`,
  },
  {
    id: 'math.space.line-angle',
    question: '两条直线方向向量为 u = (1, 1, 0)，v = (−1, 0, 1)，求所成的角。',
    answer: `θ = ${roundAngle(Math.acos(Math.abs(dot([1, 1, 0], [-1, 0, 1])) / (norm([1, 1, 0]) * norm([-1, 0, 1]))))}°`,
  },
  {
    id: 'math.space.line-plane-angle',
    question: 'u = (1, 0, 1)，平面法向量 n = (0, 0, 1)，求线面角。',
    answer: `α = ${roundAngle(Math.asin(Math.abs(dot([1, 0, 1], [0, 0, 1])) / (norm([1, 0, 1]) * norm([0, 0, 1]))))}°`,
  },
  {
    id: 'math.space.point-plane-distance',
    question: '求 P(1, 2, 3) 到平面 2x − y + 2z − 3 = 0 的距离。',
    answer: `d = ${Math.abs(dot([1, 2, 3], [2, -1, 2]) - 3) / norm([2, -1, 2])}`,
  },
  {
    id: 'math.line.slope',
    question: '直线经过 (1, 2) 与 (4, 8)，求斜率。',
    answer: `k = ${(8 - 2) / (4 - 1)}`,
  },
  {
    id: 'math.line.point-slope',
    question: '求过 (2, 3) 且斜率为 −2 的直线方程。',
    answer: `y = ${unicodeNumber(-2)}x + ${3 - -2 * 2}`,
  },
  {
    id: 'math.line.general',
    question: '求 2x − y + 3 = 0 的一个方向向量和斜率。',
    answer: `方向向量可取 ${vector([-(-1), 2])}；k = ${-2 / -1}`,
  },
  {
    id: 'math.line.point-distance',
    question: '求 P(1, 2) 到 3x + 4y − 1 = 0 的距离。',
    answer: `d = ${Math.abs(dot([1, 2], [3, 4]) - 1) / norm([3, 4])}`,
  },
  {
    id: 'math.line.parallel-distance',
    question: '求 3x + 4y − 5 = 0 与 6x + 8y + 10 = 0 的距离。',
    answer: `d = ${Math.abs(10 / 2 - -5) / norm([3, 4])}`,
  },
  {
    id: 'math.circle.standard',
    question: '圆心为 (2, −1)，半径为 3，写出圆的方程。',
    answer: `(x − ${2})² + (y + ${-(-1)})² = ${3 ** 2}`,
  },
  {
    id: 'math.circle.general',
    question: '求 x² + y² − 4x + 6y − 12 = 0 的圆心与半径。',
    answer: `圆心为 ${vector([-(-4) / 2, -6 / 2])}；r = ${Math.sqrt(((-4) ** 2 + 6 ** 2 - 4 * -12) / 4)}`,
  },
  {
    id: 'math.circle.line-position',
    question: '判断直线 y = 3 与圆 x² + y² = 25 的位置关系。',
    answer: Math.abs(3) < Math.sqrt(25) ? '相交于两点' : '非相交',
  },
  {
    id: 'math.circle.chord',
    question: '半径为 5 的圆中，一条弦到圆心的距离为 3，求弦长。',
    answer: `L = ${2 * Math.sqrt(5 ** 2 - 3 ** 2)}`,
  },
  {
    id: 'geo.scale.ratio',
    question: '图上 2 cm 对应实地 1 km，求数字比例尺。',
    answer: `比例尺为 1∶${((1 * 100_000) / 2).toLocaleString('en-US').replace(',', ' ')}`,
  },
  {
    id: 'geo.scale.distance',
    question: '1∶50 000 地图上两点相距 3.2 cm，实地水平距离是多少？',
    answer: `L = ${(50_000 * 3.2) / 100_000} km`,
  },
  {
    id: 'geo.scale.area',
    question: '1∶50 000 地图上一块地面积为 4 cm²，实地水平面积是多少？',
    answer: `A = ${(4 * 50_000 ** 2) / 100_000 ** 2} km²`,
  },
  {
    id: 'geo.time.longitude',
    question: '同一时刻，90°E 的地方时为 08:00，120°E 的地方时为多少？',
    answer: `同日 ${8 + ((120 - 90) * 4) / 60}:00`,
  },
  {
    id: 'geo.time.standard-meridian',
    question: '按 UTC+8 标准时间 12:00，求 105°E 的地方平太阳时（无夏令时）。',
    answer: `同日 ${12 + ((105 - 15 * 8) * 4) / 60}:00（地方平太阳时）`,
  },
  {
    id: 'geo.solar.noon-altitude',
    question: '春分日按太阳赤纬 0° 计算，30°N 的正午太阳高度是多少？',
    answer: `H = ${90 - Math.abs(30 - 0)}°`,
  },
  {
    id: 'geo.solar.altitude',
    question: '赤道上、太阳赤纬为 0°，当地真太阳时 16:00 的太阳高度是多少？',
    answer: `h = ${roundAngle(Math.asin(Math.sin(0) * Math.sin(0) + Math.cos(0) * Math.cos(0) * Math.cos(radians(15 * (16 - 12)))))}°`,
  },
  {
    id: 'geo.contour.interval',
    question: '100 m 与 200 m 两条等高线之间有 4 条基本等高线，沿途高度连续上升，求等高距。',
    answer: `Δh = ${(200 - 100) / (4 + 1)} m`,
  },
  {
    id: 'geo.contour.interpolation',
    question: '均匀坡段上，100 m 与 120 m 等高线水平间距 50 m；某点距低线 20 m，估计海拔。',
    answer: `H ≈ ${100 + (20 / 50) * (120 - 100)} m`,
  },
  {
    id: 'geo.contour.relative-height',
    question:
      '甲海拔在 100 m 与 120 m 之间，乙在 160 m 与 180 m 之间，均不在线上，求相对高度范围。',
    answer: `${160 - 120} m < H乙 − H甲 < ${180 - 100} m`,
  },
  {
    id: 'geo.contour.slope',
    question: '沿某剖面水平前进 200 m，高程上升 40 m，求坡度百分比和坡角。',
    answer: `坡度为 ${(40 / 200) * 100}%；α ≈ ${degrees(Math.atan(40 / 200)).toFixed(2)}°`,
  },
]

describe('curated formula catalog contract', () => {
  it('has a versioned, unique and bounded collection covering both subjects', () => {
    expect(FORMULA_CATALOG_VERSION).toBe('2026.10.1')
    expect(FORMULA_ENTRIES.length).toBeGreaterThanOrEqual(24)
    expect(FORMULA_ENTRIES.length).toBeLessThanOrEqual(30)
    expect(byId.size).toBe(FORMULA_ENTRIES.length)
    expect(FORMULA_ENTRIES.filter((entry) => entry.subject === 'math')).toHaveLength(18)
    expect(FORMULA_ENTRIES.filter((entry) => entry.subject === 'geography')).toHaveLength(11)
  })

  it.each(FORMULA_ENTRIES)(
    '$id has complete, safe display text and verified-source URLs',
    (entry) => {
      expect(entry.version).toBe(1)
      expect(entry.id).toMatch(/^(math|geo)\.[a-z-]+\.[a-z-]+$/)
      expect(entry.id.startsWith(entry.subject === 'math' ? 'math.' : 'geo.')).toBe(true)
      for (const text of [
        entry.title,
        entry.chapter,
        entry.expression,
        entry.example.question,
        entry.example.answer,
      ]) {
        expect(text.trim().length).toBeGreaterThan(0)
        expect(text).not.toMatch(/<\/?[a-z][^>]*>|\\(?:frac|sqrt|begin)\b|\$\$/i)
      }
      for (const items of [entry.aliases, entry.conditions, entry.pitfalls, entry.example.steps]) {
        expect(items.length).toBeGreaterThan(0)
        expect(items.every((text) => typeof text === 'string' && text.trim().length > 0)).toBe(true)
      }
      expect(entry.aliases.some((alias) => /^[A-Za-z0-9 -]+$/.test(alias))).toBe(true)
      expect(entry.symbols.length).toBeGreaterThan(0)
      expect(new Set(entry.symbols.map((symbol) => symbol.symbol)).size).toBe(entry.symbols.length)
      for (const symbol of entry.symbols) {
        expect(symbol.symbol.trim()).not.toBe('')
        expect(symbol.meaning.trim()).not.toBe('')
        if (symbol.unit !== undefined) expect(symbol.unit.trim()).not.toBe('')
      }
      expect(entry.sources.length).toBeGreaterThan(0)
      for (const source of entry.sources) {
        expect(source.title.trim()).not.toBe('')
        const url = new URL(source.url)
        expect(url.protocol).toBe('https:')
        expect(['openstax.org', 'www.usgs.gov', 'gml.noaa.gov']).toContain(url.hostname)
        expect(url.username + url.password + url.hash).toBe('')
      }
    },
  )

  it('does not reuse source objects across entries, so tool results remain JSON trees', () => {
    const records = FORMULA_ENTRIES.flatMap((entry) => entry.sources)
    expect(new Set(records).size).toBe(records.length)
    expect(JSON.parse(JSON.stringify(FORMULA_ENTRIES))).toEqual(FORMULA_ENTRIES)
  })

  it('independently checks every catalog example, including the question inputs', () => {
    expect(new Set(examples.map((example) => example.id))).toEqual(new Set(byId.keys()))
  })

  it.each(examples)(
    '$id example arithmetic agrees with the shown answer',
    ({ id, question, answer }) => {
      expect(formula(id).example.question).toBe(question)
      expect(formula(id).example.answer).toBe(answer)
    },
  )
})

describe('formula applicability and important boundaries', () => {
  it('excludes zero denominators in vector angle and projection formulas', () => {
    expect(guidance('math.vector.angle')).toContain('零向量的夹角未定义')
    expect(guidance('math.vector.projection')).toContain('b 不能是零向量')
    expect(guidance('math.vector.parallel')).toContain('不使用分量相除')
    expect(dot([0, 0, 0], [1, 2, 3])).toBe(0)
    expect(norm([0, 0, 0])).toBe(0)
    expect([1, -2, 3].map((component) => -2 * component)).toEqual([-2, 4, -6])
  })

  it('distinguishes directed vector angles from line angles and line-plane angles', () => {
    const u = [1, 1, 0]
    const v = [-1, 0, 1]
    const cosine = dot(u, v) / (norm(u) * norm(v))
    expect(roundAngle(Math.acos(cosine))).toBe(120)
    expect(roundAngle(Math.acos(Math.abs(cosine)))).toBe(60)
    expect(formula('math.vector.angle').expression).toContain('180°')
    expect(guidance('math.space.line-plane-angle')).toContain('[0°, 90°]')
    expect(guidance('math.space.line-plane-angle')).toContain('α = 0°')
    expect(guidance('math.space.line-plane-angle')).toContain('α = 90°')
    expect(roundAngle(Math.asin(0))).toBe(0)
    expect(roundAngle(Math.asin(1))).toBe(90)
  })

  it('handles vertical lines separately and requires valid line and plane normals', () => {
    expect(guidance('math.line.slope')).toContain('竖直直线的斜率不存在')
    expect(guidance('math.line.point-slope')).toContain('x = x₀')
    expect(guidance('math.line.general')).toContain('不能使用 −A/B')
    expect(guidance('math.line.point-distance')).toContain('A、B 不全为 0')
    expect(guidance('math.space.point-plane-distance')).toContain('A、B、C 不全为 0')
    expect(guidance('math.line.parallel-distance')).toContain('化为完全相同')
    // Distance to the vertical line x = 2: no slope division is needed.
    expect(Math.abs(1 * 5 + 0 * 9 - 2) / Math.hypot(1, 0)).toBe(3)
  })

  it('distinguishes real circles, points and empty real loci before taking square roots', () => {
    const radiusSquared = (D: number, E: number, F: number) => (D * D + E * E - 4 * F) / 4
    expect(radiusSquared(0, 0, -9)).toBe(9)
    expect(radiusSquared(0, 0, 0)).toBe(0)
    expect(radiusSquared(0, 0, 1)).toBe(-1)
    expect(guidance('math.circle.general')).toContain('等于 0 时是一个点')
    expect(guidance('math.circle.general')).toContain('小于 0 时无实点')
    expect(guidance('math.circle.chord')).toContain('d > r 时没有实弦')
    expect(2 * Math.sqrt(5 ** 2 - 0 ** 2)).toBe(10)
    expect(2 * Math.sqrt(5 ** 2 - 5 ** 2)).toBe(0)
  })

  it('keeps map distances horizontal and squares length scale for area', () => {
    expect(guidance('geo.scale.ratio')).toContain('同一长度单位')
    expect(guidance('geo.scale.distance')).toContain('水平距离')
    expect(guidance('geo.scale.area')).toContain('面积放大 n² 倍')
    expect(1 / 10_000).toBeGreaterThan(1 / 100_000)
    expect(100_000 ** 2).toBe(10_000_000_000)
  })

  it('does not confuse longitude-based solar time with civil time, DST or calendar dates', () => {
    expect(guidance('geo.time.longitude')).toContain('国际日期变更线')
    expect(guidance('geo.time.longitude')).toContain('超过 24 时进一天')
    expect(guidance('geo.time.standard-meridian')).toContain('不能单凭经度推断法定时区')
    expect(guidance('geo.time.standard-meridian')).toContain('先扣除夏令时增量')
    expect(guidance('geo.time.standard-meridian')).toContain('均时差')
    const totalMinutes = 23 * 60 + (120 - 90) * 4
    expect(Math.floor(totalMinutes / 1440)).toBe(1)
    expect(totalMinutes % 1440).toBe(60)
  })

  it('limits the noon shortcut to solar noon and preserves below-horizon results', () => {
    expect(guidance('geo.solar.noon-altitude')).toContain('真太阳时 12:00')
    expect(guidance('geo.solar.noon-altitude')).toContain('H ≤ 0°')
    expect(guidance('geo.solar.altitude')).toContain('必须是真太阳时')
    expect(guidance('geo.solar.altitude')).toContain('h < 0°')
    expect(90 - Math.abs(80 - -23.5)).toBe(-13.5)
    const altitude = (phi: number, delta: number, hour: number) =>
      degrees(
        Math.asin(
          Math.sin(radians(phi)) * Math.sin(radians(delta)) +
            Math.cos(radians(phi)) * Math.cos(radians(delta)) * Math.cos(radians(15 * (hour - 12))),
        ),
      )
    expect(altitude(30, 0, 12)).toBeCloseTo(60)
    expect(altitude(0, 0, 18)).toBeCloseTo(0)
    expect(altitude(0, 0, 20)).toBeCloseTo(-30)
  })

  it('marks contour interpolation as approximate and relative-height endpoints as strict', () => {
    expect(guidance('geo.contour.interval')).toContain('数的是间隔')
    expect(guidance('geo.contour.interpolation')).toContain('坡度近似均匀')
    expect(guidance('geo.contour.interpolation')).toContain('不能声称得到精确海拔')
    expect(guidance('geo.contour.relative-height')).toContain('两点都不在等高线上')
    expect(guidance('geo.contour.relative-height')).toContain('端点不能取到')
    expect(formula('geo.contour.relative-height').expression).not.toContain('≤')
    for (const low of [100.001, 110, 119.999]) {
      for (const high of [160.001, 170, 179.999]) {
        expect(high - low).toBeGreaterThan(40)
        expect(high - low).toBeLessThan(80)
      }
    }
    // Points ON boundary contours can reach these values, which is why exclusion matters.
    expect(160 - 120).toBe(40)
    expect(180 - 100).toBe(80)
    expect(guidance('geo.contour.slope')).toContain('不能用沿坡面测得的斜距')
    expect(degrees(Math.atan(1))).toBe(45)
  })
})
