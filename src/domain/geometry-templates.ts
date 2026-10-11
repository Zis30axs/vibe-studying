import { z } from 'zod'
import {
  geometrySceneSchema,
  isPlainGeometryData,
  type GeometryScene,
  type Vec3,
} from '../shared/geometry'
import {
  GEOMETRY_TEMPLATE_CATALOG,
  geometryTemplateInputSchema,
  type GeometryTemplateInput,
} from '../shared/geometry-templates'
import type { Question, RubricItem } from '../shared/types'
import {
  addVectors,
  dotVectors,
  executeGeometryTool,
  scaleVector,
  subtractVectors,
} from './geometry'

export { geometryTemplateInputSchema } from '../shared/geometry-templates'

const f = (value: number): string =>
  Number((Math.abs(value) < 5e-10 ? 0 : value).toFixed(6)).toString()
const tuple = (point: Vec3, planar = false) =>
  `(${f(point.x)}, ${f(point.y)}${planar ? '' : `, ${f(point.z)}`})`
const point = (id: string, coordinates: Vec3, label = id) => ({ id, label, ...coordinates })
const segment = (from: string, to: string, dashed = false) => ({
  id: `${from}-${to}`,
  from,
  to,
  ...(dashed ? { dashed } : {}),
})
const rubric = (id: string, label: string, keywords: string[], points = 2): RubricItem => ({
  id,
  label,
  keywords,
  points,
})
const referenceNotice =
  '\n以上为本地计算与数学推导的练习参考，近似量保留6位小数；不是符号代数证明服务或官方试卷答案。练习分值为本模板自行制定；关键词评阅不等同于证明正确性的判定。'

function metrics(a: Vec3, b: Vec3) {
  const result = executeGeometryTool({ request: { operation: 'vector_metrics', a, b } })
  if (result.operation !== 'vector_metrics') throw new Error('向量计算结果类型不一致')
  return result
}

/** All coefficients here are exact dyadic rationals from the bounded planar family. */
function lineEquation(a: number, b: number, c: number): string {
  const coefficients = [a, b, c].map((value) => Math.round(value * 16))
  const gcd = (x: number, y: number): number => (y === 0 ? Math.abs(x) : gcd(y, x % y))
  const divisor = coefficients.reduce(gcd)
  if (!divisor || (coefficients[0] === 0 && coefficients[1] === 0)) throw new Error('直线不能退化')
  const sign = coefficients.find((value) => value !== 0)! < 0 ? -1 : 1
  const terms = coefficients.map((value) => (value / divisor) * sign)
  let expression = ''
  terms.forEach((value, index) => {
    if (!value) return
    const symbol = index === 0 ? 'x' : index === 1 ? 'y' : ''
    const magnitude = Math.abs(value) === 1 && symbol ? '' : String(Math.abs(value))
    expression += `${expression ? (value < 0 ? ' − ' : ' + ') : value < 0 ? '−' : ''}${magnitude}${symbol}`
  })
  return `${expression} = 0`
}

type Contents = Pick<Question, 'prompt' | 'explanation' | 'rubric' | 'tags'> & {
  geometry: GeometryScene
}

function vectorQuestion(
  parameters: Extract<
    GeometryTemplateInput,
    { templateId: 'vector-angle-orthogonality' }
  >['parameters'],
): Contents {
  const { aX, bX, bZ, mix } = parameters
  const A = { x: 1, y: -2, z: 1 }
  const a = { x: aX, y: 1, z: 0 },
    b = { x: bX, y: 0, z: bZ }
  const B = addVectors(A, a),
    C = addVectors(A, b)
  const calculation = metrics(a, b)
  const aa = dotVectors(a, a),
    bb = dotVectors(b, b),
    ab = calculation.dot
  const linear = (1 - mix) * ab,
    constant = -mix * bb
  const discriminant = linear * linear - 4 * aa * constant
  if (!(aa > 0 && bb > 0 && aa * bb - ab * ab > 0 && discriminant > 0))
    throw new Error('向量条件退化或没有两个实根')
  const roots = [
    (-linear - Math.sqrt(discriminant)) / (2 * aa),
    (-linear + Math.sqrt(discriminant)) / (2 * aa),
  ]
  for (const root of roots) {
    const first = addVectors(scaleVector(a, root), b)
    const second = subtractVectors(scaleVector(a, root), scaleVector(b, mix))
    const check = metrics(first, second)
    if (!check.orthogonal) throw new Error('垂直参数核验失败')
  }
  return {
    prompt: `在空间直角坐标系中，A${tuple(A)}，B${tuple(B)}，C${tuple(C)}。记a=AB，b=AC（均为向量）。\n（1）求a与b的夹角θ的余弦，并判断θ为锐角还是钝角。\n（2）求所有实数k，使ka+b与ka−${mix}b垂直；需检验所得到的向量均非零。可保留根式，近似值保留6位小数。`,
    explanation: `a=${tuple(a)}，b=${tuple(b)}，|a|²=${aa}，|b|²=${bb}，a·b=${ab}。\n（1）cosθ=${ab}/√(${aa}×${bb})≈${f(calculation.cosine)}，θ≈${f(calculation.angleDegrees)}°，为${ab < 0 ? '钝角' : '锐角'}。这里是有向向量夹角，不能对数量积取绝对值。\n（2）(ka+b)·(ka−${mix}b)=|a|²k²+(1−${mix})(a·b)k−${mix}|b|²=0，即${aa}k²+(${linear})k+(${constant})=0。判别式Δ=${discriminant}>0，所以k=[−(${linear})±√${discriminant}]/${2 * aa}，两根约为${f(roots[0])}、${f(roots[1])}。逐根代入，本地向量计算均判定数量积为0（相对容差范围内）。由于a的y分量为1、b的y分量为0且b的z分量非零，a、b线性无关，因此任意k下这两个线性组合都不可能是零向量。${referenceNotice}`,
    tags: ['原创参数练习', '空间向量', '数量积', '垂直条件'],
    rubric: [
      rubric('vector-coordinates', '由点坐标差确定非零向量', [tuple(a), tuple(b)]),
      rubric('vector-cosine', `夹角余弦约${f(calculation.cosine)}；保留符号`, [
        f(calculation.cosine),
        ab < 0 ? '钝角' : '锐角',
      ]),
      rubric('vector-roots', `完整保留两个根：约${f(roots[0])}、${f(roots[1])}`, [
        f(roots[0]),
        f(roots[1]),
      ]),
      rubric('vector-check', '写出数量积二次方程并说明组合向量非零', [
        '数量积',
        '非零',
        '线性无关',
      ]),
    ],
    geometry: {
      version: 1,
      kind: 'geometry-3d',
      title: '已知三点与两个有向量的起终点',
      points: [point('A', A), point('B', B), point('C', C)],
      segments: [segment('A', 'B'), segment('A', 'C')],
    },
  }
}

function triangleQuestion(
  parameters: Extract<
    GeometryTemplateInput,
    { templateId: 'triangle-altitude-parallel' }
  >['parameters'],
): Contents {
  const { run, rise, footFraction, height, offsetX, offsetY } = parameters
  const B = { x: offsetX, y: offsetY, z: 0 }
  const u = { x: run, y: rise, z: 0 }
  const C = addVectors(B, u)
  const constructedFoot = addVectors(B, scaleVector(u, footFraction))
  const A = addVectors(constructedFoot, { x: -height * rise, y: height * run, z: 0 })
  const areaTwice = Math.abs((B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x))
  if (!(areaTwice > 0)) throw new Error('三角形不能退化')
  const result = executeGeometryTool({
    request: { operation: 'point_line_foot', point: A, a: B, b: C },
  })
  if (result.operation !== 'point_line_foot') throw new Error('垂足计算结果类型不一致')
  const D = result.foot
  const AC = subtractVectors(C, A)
  const altitude = lineEquation(run, rise, -run * A.x - rise * A.y)
  const parallel = lineEquation(-AC.y, AC.x, AC.y * constructedFoot.x - AC.x * constructedFoot.y)
  if (!metrics(subtractVectors(A, D), u).orthogonal) throw new Error('高线核验失败')
  return {
    prompt: `平面直角坐标系中，三角形ABC的顶点为A${tuple(A, true)}，B${tuple(B, true)}，C${tuple(C, true)}。从A向直线BC作垂线，垂足记为D。\n（1）求高线AD的一般式方程及D的坐标。\n（2）求过D且平行于AC的直线ℓ的一般式方程。写出过程；示意图只提供已知三角形，D与辅助线由你构造。`,
    explanation: `BC的方向向量为(${run}, ${rise})，所以高线AD的法向量可取同一个向量。\n（1）AD满足${run}(x−(${f(A.x)}))+(${rise})(y−(${f(A.y)}))=0，化简为${altitude}。投影系数((A−B)·BC)/|BC|²=${f(footFraction)}，因此D=B+${f(footFraction)}BC=${tuple(D, true)}；本地垂足工具验证AD⊥BC，高的长度约${f(result.distance)}。\n（2）AC的方向向量为${tuple(AC, true)}，法向量可取(${f(-AC.y)}, ${f(AC.x)})。代入的是D而不是A，得到ℓ：${parallel}。这条直线经过D，且法向量与AC垂直。一般式无需除以方向分量，即使BC水平、高线竖直也成立。三角形面积为${f(areaTwice / 2)}>0。${referenceNotice}`,
    tags: ['原创参数练习', '平面解析几何', '高线', '过点作平行线'],
    rubric: [
      rubric('triangle-altitude', `高线AD：${altitude}`, [altitude]),
      rubric('triangle-foot', `垂足D=${tuple(D, true)}`, [tuple(D, true)]),
      rubric('triangle-parallel', `过D的平行线：${parallel}`, [parallel]),
      rubric('triangle-reason', '明确垂直方向与平行方向，并使用D代入', ['法向量', '平行', 'D']),
    ],
    geometry: {
      version: 1,
      kind: 'geometry-3d',
      title: '平面三角形：尚未构造垂足',
      points: [point('A', A), point('B', B), point('C', C)],
      segments: [segment('A', 'B'), segment('B', 'C'), segment('C', 'A')],
      faces: [{ id: 'triangle-ABC', points: ['A', 'B', 'C'] }],
    },
  }
}

function parallelepipedQuestion(
  parameters: Extract<
    GeometryTemplateInput,
    { templateId: 'oblique-parallelepiped' }
  >['parameters'],
): Contents {
  const { baseA, baseB, side, leanX, leanY, edgeFraction } = parameters
  const heightSquaredFraction = 1 - leanX ** 2 - leanY ** 2
  const gramDeterminant = (baseA * baseB * side) ** 2 * heightSquaredFraction
  if (!(heightSquaredFraction > 0 && gramDeterminant > 0))
    throw new Error('棱长和夹角不能构成非退化平行六面体')
  const a = { x: baseA, y: 0, z: 0 },
    b = { x: 0, y: baseB, z: 0 }
  const c = { x: side * leanX, y: side * leanY, z: side * Math.sqrt(heightSquaredFraction) }
  const A = { x: 0, y: 0, z: 0 },
    B = a,
    D = b,
    C = addVectors(a, b)
  const A1 = c,
    B1 = addVectors(B, c),
    C1 = addVectors(C, c),
    D1 = addVectors(D, c)
  const E = addVectors(C, scaleVector(c, edgeFraction))
  const calculation = metrics(E, b)
  const squaredLength =
    baseA ** 2 +
    baseB ** 2 +
    (edgeFraction * side) ** 2 +
    2 * edgeFraction * side * (baseA * leanX + baseB * leanY)
  const cosine = Math.abs(calculation.cosine)
  return {
    prompt: `一个斜平行六面体ABCD−A₁B₁C₁D₁满足AB=${baseA}，AD=${baseB}，AA₁=${side}，∠DAB=90°，cos∠BAA₁=${leanX}，cos∠DAA₁=${leanY}。点E在棱CC₁上，CE/CC₁=${edgeFraction}。记a=AB，b=AD，c=AA₁（均为向量）。\n（1）用a、b、c表示AE，并求AE的长度。\n（2）求直线AE与BC所成的较小夹角的余弦。可保留根式，近似值保留6位小数。图为三轴投影示意，侧棱倾斜，不能当成长方体。`,
    explanation: `AE=a+b+${edgeFraction}c，BC=b。|a|²=${baseA ** 2}，|b|²=${baseB ** 2}，|c|²=${side ** 2}；a·b=0，a·c=${f(baseA * side * leanX)}，b·c=${f(baseB * side * leanY)}。\n（1）|AE|²=|a|²+|b|²+${f(edgeFraction ** 2)}|c|²+2a·b+${f(2 * edgeFraction)}a·c+${f(2 * edgeFraction)}b·c=${f(squaredLength)}。所以AE=√${f(squaredLength)}≈${f(calculation.normA)}。\n（2）AE·BC=|b|²+${edgeFraction}(b·c)=${f(calculation.dot)}；两直线较小夹角余弦为|AE·BC|/(|AE||BC|)=${f(calculation.dot)}/(${baseB}√${f(squaredLength)})≈${f(cosine)}。注意线线角应取数量积绝对值；本构造中数量积为正。\n图形和数值共用a=${tuple(a)}、b=${tuple(b)}、c≈${tuple(c)}。Gram行列式为${f(gramDeterminant)}>0，说明三个棱向量线性无关，图形非退化。a·c和b·c均非零，省略这些交叉项会错误地把斜平行六面体当成长方体。${referenceNotice}`,
    tags: ['原创参数练习', '斜平行六面体', '空间向量', '线线角'],
    rubric: [
      rubric('solid-vector', `AE=a+b+${edgeFraction}c`, ['a+b', String(edgeFraction)]),
      rubric('solid-dot', '保留两个非零侧棱数量积交叉项', [
        f(baseA * side * leanX),
        f(baseB * side * leanY),
      ]),
      rubric('solid-length', `AE=√${f(squaredLength)}≈${f(calculation.normA)}`, [
        f(squaredLength),
        f(calculation.normA),
      ]),
      rubric('solid-angle', `两直线夹角余弦约${f(cosine)}`, [f(cosine), '绝对值']),
    ],
    geometry: {
      version: 1,
      kind: 'geometry-3d',
      title: '侧棱倾斜的平行六面体与已知内分点E',
      points: [
        point('A', A),
        point('B', B),
        point('C', C),
        point('D', D),
        point('A1', A1, 'A₁'),
        point('B1', B1, 'B₁'),
        point('C1', C1, 'C₁'),
        point('D1', D1, 'D₁'),
        point('E', E),
      ],
      segments: [
        segment('A', 'B'),
        segment('B', 'C'),
        segment('C', 'D', true),
        segment('D', 'A', true),
        segment('A1', 'B1'),
        segment('B1', 'C1'),
        segment('C1', 'D1'),
        segment('D1', 'A1'),
        segment('A', 'A1'),
        segment('B', 'B1'),
        segment('C', 'C1'),
        segment('D', 'D1', true),
        segment('A', 'E'),
      ],
      faces: [
        { id: 'base', points: ['A', 'B', 'C', 'D'] },
        { id: 'top', points: ['A1', 'B1', 'C1', 'D1'] },
      ],
      rightAngles: [{ id: 'given-base-right-angle', vertex: 'A', from: 'B', to: 'D' }],
    },
  }
}

function pyramidQuestion({
  side: s,
}: Extract<GeometryTemplateInput, { templateId: 'square-pyramid-locus' }>['parameters']): Contents {
  const A = { x: 0, y: 0, z: 0 },
    B = { x: s, y: 0, z: 0 },
    C = { x: s, y: s, z: 0 },
    D = { x: 0, y: s, z: 0 },
    P = { x: 0, y: 0, z: s }
  const E = { x: 0, y: s / 3, z: (2 * s) / 3 }
  // F and G are reference-only derived points. Never put them into the public scene.
  const F = { x: s / 5, y: s / 5, z: (4 * s) / 5 },
    G = { x: s / 3, y: 0, z: (2 * s) / 3 }
  const volumeResult = executeGeometryTool({
    request: { operation: 'tetrahedron_volume', a: P, b: A, c: E, d: F },
  })
  const normalResult = executeGeometryTool({
    request: { operation: 'plane_normal', a: A, b: E, c: F },
  })
  const maxAngleResult = executeGeometryTool({
    request: {
      operation: 'line_plane_angle',
      from: G,
      to: F,
      a: { x: s / 2, y: 0, z: s / 2 },
      b: A,
      c: D,
    },
  })
  if (
    volumeResult.operation !== 'tetrahedron_volume' ||
    normalResult.operation !== 'plane_normal' ||
    maxAngleResult.operation !== 'line_plane_angle'
  )
    throw new Error('棱锥计算结果类型不一致')
  if (
    Math.abs(Math.abs(normalResult.normal.z) - 1 / 3) > 1e-9 ||
    Math.abs(volumeResult.volume - s ** 3 / 90) > 1e-8 ||
    Math.abs(maxAngleResult.sine - Math.sqrt(8 / 17)) > 1e-9
  )
    throw new Error('棱锥参考结论核验失败')
  return {
    prompt: `四棱锥P−ABCD的底面ABCD是边长为${s}的正方形，平面PAB和平面PAD都垂直于底面ABCD。点E在PD上，满足PE/PD=1/3。\n（1）证明PA⊥平面ABCD。\n（2）另知PA=${s}，F在开线段PC上。平面AEF与底面ABCD所成的较小夹角的余弦为1/3。求PF/PC及三棱锥P−AEF的体积。\n（3）沿用（2）的条件，记平面AEF与直线PB的交点为G。点H可在整个平面PBC内任意运动，设直线GF与平面HAD所成角为α。求sinα的完整取值范围，说明最大值的取得条件及下端点能否取到。这里的“平面PBC”不是三角形PBC；需先说明平面HAD始终有定义。\n给定图只画P、A、B、C、D、E，不提前提供待求F、G或动点H的位置；不以屏幕投影角度为依据。`,
    explanation: `（1）因为AB⊥AD，且平面PAD⊥底面、交线为AD，底面内的AB垂直于平面PAD，故AB⊥PA。同理由平面PAB⊥底面得AD⊥PA。AB、AD是底面内相交的两条直线，故PA⊥底面ABCD。\n（2）完成垂直证明后，以A为原点、AB、AD、AP为正交坐标轴。A=(0,0,0)，P=(0,0,${s})，E=(0,${s}/3,${2 * s}/3)。令t=PF/PC，0<t<1，则F=(${s}t,${s}t,${s}(1−t))。平面AEF的法向量可取n=(1−3t,2t,−t)，故与底面夹角的余弦为t/√((1−3t)²+5t²)。它等于1/3，等价于(1−3t)²=4t²，即5t²−6t+1=0，得到t=1/5或1。由开线段条件排除t=1，唯一有效解为t=1/5。于是F=${tuple(F)}，平面AEF：2x+2y−z=0。由体积行列式，V(P−AEF)=|det(A−P,E−P,F−P)|/6=${s}³/90≈${f(volumeResult.volume)}（立方单位）。本地法向量和体积工具分别核验夹角余弦1/3与上述体积。\n（3）PB上点写成(${s}r,0,${s}(1−r))，代入2x+2y−z=0得r=1/3，G=(${s}/3,0,${2 * s}/3)≈${tuple(G)}。GF可取方向向量d=(−2,3,2)，|d|=√17。整个平面PBC的方程为x+z=${s}，所以H=(h,k,${s}−h)，h、k∈R。平面HAD的法向量可取m=(${s}−h,0,−h)；若m=0则同时h=${s}和h=0，与${s}>0矛盾，因此平面始终有定义。\nsinα=|d·m|/(|d||m|)=${2 * s}/[√17·√((${s}−h)²+h²)]=${2 * s}/[√17·√(2(h−${s}/2)²+${s ** 2}/2)]。分母在h=${s}/2最小，k任意，因此最大值为√(8/17)≈${f(maxAngleResult.sine)}，并且确实取到。任意有限h下分子、分母均为正，故0取不到；当|h|→∞时正弦趋于0。该式连续，且在h≥${s}/2上从最大值连续递减至0，因此所有中间值都可取。完整范围为(0,√(8/17)]。\n范围核对：若误把H限制在闭三角形PBC内，就额外要求0≤h≤${s}及0≤k≤h，所得到的是[2/√17,√(8/17)]，约[${f(2 / Math.sqrt(17))},${f(maxAngleResult.sine)}]；这不是本题的运动范围。无穷平面的开下端点来自解析证明，而非有限采样。${referenceNotice}`,
    tags: ['原创参数练习', '线面垂直', '三棱锥体积', '线面角范围', '开闭端点'],
    rubric: [
      rubric(
        'pyramid-perpendicular',
        '用底面内两条相交直线证明PA垂直底面',
        ['AB', 'AD', '相交', '垂直'],
        3,
      ),
      rubric('pyramid-parameter', '解得PF/PC=1/5，排除端点根1', ['1/5', '端点', '排除'], 3),
      rubric(
        'pyramid-volume',
        `三棱锥体积${s}³/90≈${f(volumeResult.volume)}`,
        [f(volumeResult.volume), `${s}³/90`],
        2,
      ),
      rubric('pyramid-domain', 'H在整个平面；HAD法向量始终非零', ['整个平面', '非零'], 2),
      rubric(
        'pyramid-range',
        '范围(0,√(8/17)]；最大值可达、0不可达及连续性',
        ['(0,√(8/17)]', '连续', '取不到'],
        2,
      ),
    ],
    geometry: {
      version: 1,
      kind: 'geometry-3d',
      title: '正方形底面的四棱锥：只画已知点',
      points: [
        point('P', P),
        point('A', A),
        point('B', B),
        point('C', C),
        point('D', D),
        point('E', E),
      ],
      segments: [
        segment('A', 'B'),
        segment('B', 'C'),
        segment('C', 'D', true),
        segment('D', 'A', true),
        segment('P', 'A'),
        segment('P', 'B'),
        segment('P', 'C'),
        segment('P', 'D', true),
        segment('A', 'E'),
      ],
      faces: [{ id: 'base', points: ['A', 'B', 'C', 'D'] }],
      rightAngles: [{ id: 'given-square-angle', vertex: 'A', from: 'B', to: 'D' }],
    },
  }
}

const questionIdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
  .refine((id) => !['__proto__', 'prototype', 'constructor'].includes(id))
function deterministicId(input: GeometryTemplateInput): string {
  let hash = 2166136261
  for (const character of JSON.stringify(input))
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619)
  return `geometry-${input.templateId}-${(hash >>> 0).toString(16)}`
}

/** Host-owned compiler: caller chooses validated parameters, never output prose or answer fields. */
export function compileGeometryTemplate(input: unknown, id?: string): Question {
  if (!isPlainGeometryData(input)) throw new Error('几何模板只接受有限、无访问器的普通JSON数据')
  const parsed = geometryTemplateInputSchema.parse(input)
  let contents: Contents
  switch (parsed.templateId) {
    case 'vector-angle-orthogonality':
      contents = vectorQuestion(parsed.parameters)
      break
    case 'triangle-altitude-parallel':
      contents = triangleQuestion(parsed.parameters)
      break
    case 'oblique-parallelepiped':
      contents = parallelepipedQuestion(parsed.parameters)
      break
    case 'square-pyramid-locus':
      contents = pyramidQuestion(parsed.parameters)
      break
  }
  const template = GEOMETRY_TEMPLATE_CATALOG.find((item) => item.id === parsed.templateId)!
  return {
    id: questionIdSchema.parse(id ?? deterministicId(parsed)),
    subject: 'math',
    kind: 'math',
    title: template.title,
    source: '原创参数化教学练习 · 本地确定性几何计算；非真题，分值为自设练习分值',
    maxScore: contents.rubric!.reduce((sum, item) => sum + item.points, 0),
    ...contents,
    geometry: geometrySceneSchema.parse(contents.geometry),
  }
}
