import type {
  MathChallengePaperDefinition,
  MathChallengeReferenceQuestion,
} from '../shared/math-challenge'

// These are original stage-review papers, not copies of a particular Gaokao paper.
// This module contains answers: import it only in the host-side challenge service.
const source = 'ExamCraft 原创阶段综合卷 · 借鉴高考分区形式，非历年真题'
const scope =
  '人教版高二选择性必修第一册：空间向量、直线与圆；综合必修中的集合、二次函数、三角与不等式。不含导数及后续圆锥曲线。'

const objectiveQuestions: MathChallengeReferenceQuestion[] = [
  {
    id: 'mc-q01',
    kind: 'single',
    title: '集合与二次不等式',
    points: 5,
    prompt: '设 A＝{x｜x²−4x≤0}，B＝{x｜1<x<5}，则 A∩B＝（　）。',
    tags: ['集合', '二次不等式'],
    choices: [
      { id: 'A', text: '[0，5)' },
      { id: 'B', text: '(1，4]' },
      { id: 'C', text: '[1，4]' },
      { id: 'D', text: '(1，4)' },
    ],
    correctChoiceIds: ['B'],
    answer: 'B：(1，4]。',
    explanation:
      '由 x(x−4)≤0 得 A＝[0，4]。再与 B＝(1，5) 取交集，左端 1 不取，右端 4 可以取，因此为 (1，4]。',
    rubric: [{ label: '选 B 得 5 分，其余不得分。', points: 5 }],
  },
  {
    id: 'mc-q02',
    kind: 'single',
    title: '三角函数的范围',
    points: 5,
    prompt: '函数 f(x)＝2sin²x＋2sin x cos x（x∈R）的最大值为（　）。',
    tags: ['三角函数', '最值'],
    choices: [
      { id: 'A', text: '1' },
      { id: 'B', text: '2' },
      { id: 'C', text: '1＋√2' },
      { id: 'D', text: '3' },
    ],
    correctChoiceIds: ['C'],
    answer: 'C：1＋√2。',
    explanation:
      'f(x)＝1−cos 2x＋sin 2x＝1＋√2 sin(2x−π/4)。正弦值可以取到 1，因此最大值为 1＋√2。',
    rubric: [{ label: '选 C 得 5 分，其余不得分。', points: 5 }],
  },
  {
    id: 'mc-q03',
    kind: 'single',
    title: '过定点作垂线',
    points: 5,
    prompt: '过点 P(2，−1) 且与直线 x−2y＋1＝0 垂直的直线方程为（　）。',
    tags: ['直线方程', '垂直'],
    choices: [
      { id: 'A', text: 'x−2y−4＝0' },
      { id: 'B', text: '2x−y−5＝0' },
      { id: 'C', text: 'x＋2y＝0' },
      { id: 'D', text: '2x＋y−3＝0' },
    ],
    correctChoiceIds: ['D'],
    answer: 'D：2x＋y−3＝0。',
    explanation: '已知直线斜率为 1/2，所求直线斜率为 −2。由点斜式 y＋1＝−2(x−2)，化为 2x＋y−3＝0。',
    rubric: [{ label: '选 D 得 5 分，其余不得分。', points: 5 }],
  },
  {
    id: 'mc-q04',
    kind: 'single',
    title: '空间向量数量积',
    points: 5,
    prompt: '在空间直角坐标系中，a＝(1，2，−1)，b＝(2，−1，2)，则 a·b＝（　）。',
    tags: ['空间向量', '数量积'],
    choices: [
      { id: 'A', text: '−2' },
      { id: 'B', text: '0' },
      { id: 'C', text: '2' },
      { id: 'D', text: '6' },
    ],
    correctChoiceIds: ['A'],
    answer: 'A：−2。',
    explanation:
      '对应坐标相乘后相加：a·b＝1×2＋2×(−1)＋(−1)×2＝−2。数量积是一个数，不是逐坐标相乘得到的向量。',
    rubric: [{ label: '选 A 得 5 分，其余不得分。', points: 5 }],
  },
  {
    id: 'mc-q05',
    kind: 'single',
    title: '含参圆的面积',
    points: 5,
    prompt: '当实数 m 变化时，圆 x²＋y²−4x−2my＋2m＝0 的面积的最小值为（　）。',
    tags: ['圆的一般方程', '配方', '二次函数'],
    choices: [
      { id: 'A', text: 'π' },
      { id: 'B', text: '3π' },
      { id: 'C', text: '4π' },
      { id: 'D', text: '不存在最小值' },
    ],
    correctChoiceIds: ['B'],
    answer: 'B：3π，m＝1 时取到。',
    explanation:
      '配方得 (x−2)²＋(y−m)²＝m²−2m＋4＝(m−1)²＋3。右边对所有 m 都为正，确为圆；r² 最小为 3，所以面积最小为 3π。',
    rubric: [{ label: '选 B 得 5 分，其余不得分。', points: 5 }],
  },
  {
    id: 'mc-q06',
    kind: 'single',
    title: '定底动点三角形面积',
    points: 5,
    prompt:
      '直线 x＋y＋4＝0 分别交 x、y 轴于 A、B。点 P 在圆 (x−2)²＋y²＝2 上，则三角形 ABP 的面积 S 的取值范围为（　）。',
    tags: ['点到直线距离', '圆上动点', '三角形面积'],
    choices: [
      { id: 'A', text: '[4，8]' },
      { id: 'B', text: '[6，12]' },
      { id: 'C', text: '[8，16]' },
      { id: 'D', text: '[0，16]' },
    ],
    correctChoiceIds: ['C'],
    answer: 'C：8≤S≤16。',
    explanation:
      'A(−4，0)、B(0，−4)，所以 |AB|＝4√2。圆心 C(2，0) 到 AB 的距离为 6/√2＝3√2，半径为 √2。动点 P 到 AB 的距离范围是 [2√2，4√2]，乘以固定的 |AB|/2 得 S∈[8，16]。圆心到固定直线的距离并不随 P 变化。',
    rubric: [{ label: '选 C 得 5 分，其余不得分。', points: 5 }],
  },
  {
    id: 'mc-q07',
    kind: 'single',
    title: '直线与平面的夹角',
    points: 5,
    prompt: '在正方体 ABCD－A₁B₁C₁D₁ 中，直线 AC₁ 与平面 ABCD 所成角为 θ，则 sin θ＝（　）。',
    tags: ['空间向量', '线面角'],
    choices: [
      { id: 'A', text: '1/3' },
      { id: 'B', text: '√2/2' },
      { id: 'C', text: '√6/3' },
      { id: 'D', text: '√3/3' },
    ],
    correctChoiceIds: ['D'],
    answer: 'D：√3/3。',
    explanation:
      '设棱长为 a，AC₁ 的长度为 a√3，其在底面法向方向上的分量为 a。因此 sin θ＝a/(a√3)＝√3/3。若先求方向向量与法向量的夹角，要注意它与线面角互余。',
    rubric: [{ label: '选 D 得 5 分，其余不得分。', points: 5 }],
  },
  {
    id: 'mc-q08',
    kind: 'single',
    title: '斜率范围与切线',
    points: 5,
    prompt: '点 P(x，y) 在圆 x²＋y²＝1 上运动，则 y/(x−2) 的取值范围为（　）。',
    tags: ['圆的切线', '斜率', '取值范围'],
    choices: [
      { id: 'A', text: '[−√3/3，√3/3]' },
      { id: 'B', text: '[−1，1]' },
      { id: 'C', text: '(−√3/3，√3/3)' },
      { id: 'D', text: '[−1/2，1/2]' },
    ],
    correctChoiceIds: ['A'],
    answer: 'A：[−√3/3，√3/3]。',
    explanation:
      '设 k＝y/(x−2)，则直线 y＝k(x−2) 必须与圆有公共点。圆心到直线 kx−y−2k＝0 的距离不大于 1，即 4k²≤k²＋1，因此 |k|≤1/√3。相切时仍有一个圆上点，两个端点都能取到；分母 x−2 恒不为零。',
    rubric: [{ label: '选 A 得 5 分，其余不得分。', points: 5 }],
  },
  {
    id: 'mc-q09',
    kind: 'multiple',
    title: '圆与直线的性质判断',
    points: 6,
    prompt: '已知圆 C：(x−2)²＋(y−1)²＝4。下列结论正确的有（　）。',
    tags: ['圆与直线', '弦长', '切线长'],
    choices: [
      { id: 'A', text: '圆 C 与 y 轴相切于 (0，1)' },
      { id: 'B', text: '圆 C 被 x 轴截得的弦长为 2√3' },
      { id: 'C', text: '从点 (5，1) 向圆 C 作切线，切线长为 √5' },
      { id: 'D', text: '原点 O 在圆 C 内部' },
    ],
    correctChoiceIds: ['A', 'B', 'C'],
    answer: 'A、B、C。',
    explanation:
      '圆心 (2，1)，半径 2。到 y 轴的距离恰为 2，A 对；到 x 轴的距离为 1，弦长 2√(4−1)＝2√3，B 对；点 (5，1) 到圆心的距离为 3，切线长 √(9−4)＝√5，C 对；原点到圆心的距离为 √5>2，D 错。',
    rubric: [
      {
        label:
          '全部选对得 6 分；只选了正确选项且未选全得 3 分；有错选或未选得 0 分（本模式评分规则）。',
        points: 6,
      },
    ],
  },
  {
    id: 'mc-q10',
    kind: 'multiple',
    title: '空间向量关系',
    points: 6,
    prompt: '已知空间向量 a＝(1，0，1)，b＝(0，1，1)，c＝(1，1，0)。下列结论正确的有（　）。',
    tags: ['空间向量', '垂直', '共面'],
    choices: [
      { id: 'A', text: 'a·b＝1' },
      { id: 'B', text: 'a 与 b−c 垂直' },
      { id: 'C', text: 'c 与 a＋b 平行' },
      { id: 'D', text: '存在实数 λ、μ，使 c＝λa＋μb' },
    ],
    correctChoiceIds: ['A', 'B'],
    answer: 'A、B。',
    explanation:
      'a·b＝1，A 对。b−c＝(−1，0，1)，与 a 的数量积为 0，B 对。a＋b＝(1，1，2)，不与 c 平行，C 错。若 c＝λa＋μb，前两坐标要求 λ＝μ＝1，但第三坐标应为 2 而不是 0，D 错。',
    rubric: [
      {
        label:
          '全部选对得 6 分；只选了正确选项且未选全得 3 分；有错选或未选得 0 分（本模式评分规则）。',
        points: 6,
      },
    ],
  },
  {
    id: 'mc-q11',
    kind: 'multiple',
    title: '二次函数区间最值',
    points: 6,
    prompt: '设 f(x)＝x²−2tx＋3，定义域为 [0，2]，其中 t∈R。下列结论正确的有（　）。',
    tags: ['二次函数', '闭区间', '分类讨论'],
    choices: [
      { id: 'A', text: '当 t≤0 时，f(x) 的最小值为 3' },
      { id: 'B', text: '当 t＝1 时，f(x) 的最大值为 3' },
      { id: 'C', text: '对任意实数 t，f(x) 的最小值均为 3−t²' },
      { id: 'D', text: '当 0≤t≤2 时，f(x) 的最小值为 3−t²' },
    ],
    correctChoiceIds: ['A', 'B', 'D'],
    answer: 'A、B、D。',
    explanation:
      '配方为 f(x)＝(x−t)²＋3−t²，对称轴 x＝t。t≤0 时离对称轴最近的端点为 0，最小值为 3，A 对。t＝1 时两端点值均为 3，最大值为 3，B 对。只有顶点落在定义域内时才可直接取顶点值，故 D 对、C 错；例如 t＝3 时区间最小值为 f(2)＝−5，而不是 −6。',
    rubric: [
      {
        label:
          '全部选对得 6 分；只选了正确选项且未选全得 3 分；有错选或未选得 0 分（本模式评分规则）。',
        points: 6,
      },
    ],
  },
  {
    id: 'mc-q12',
    kind: 'fill',
    title: '圆上线性式的最值',
    points: 5,
    prompt: '点 P(x，y) 在圆 x²＋y²−2x＋4y＝4 上，则 x＋2y 的最大值为 ______。',
    tags: ['配方', '点到直线距离', '线性式最值'],
    answer: '−3＋3√5。',
    explanation:
      '配方得 (x−1)²＋(y＋2)²＝9，圆心 (1，−2)，半径 3。设 x＋2y＝s，则圆心到直线 x＋2y−s＝0 的距离为 |−3−s|/√5。存在圆上点等价于该距离不大于 3，因此 s∈[−3−3√5，−3＋3√5]。',
    rubric: [{ label: '填写 −3＋3√5 或等价的准确表达式得 5 分。', points: 5 }],
  },
  {
    id: 'mc-q13',
    kind: 'fill',
    title: '异面直线所成角',
    points: 5,
    prompt:
      '在正方体 ABCD－A₁B₁C₁D₁ 中，异面直线 AB₁ 与 BC₁ 所成角的大小为 ______（用角度或弧度表示均可）。',
    tags: ['空间向量', '异面直线夹角'],
    answer: '60°，或 π/3。',
    explanation:
      '取 A(0，0，0)、B(1，0，0)、D(0，1，0)、A₁(0，0，1)。向量 AB₁＝(1，0，1)，BC₁＝(0，1，1)。夹角余弦为 1/(√2·√2)＝1/2，故异面直线所成角为 60°。',
    rubric: [{ label: '填写 60° 或 π/3 得 5 分。', points: 5 }],
  },
  {
    id: 'mc-q14',
    kind: 'fill',
    title: '弦长与三角形面积',
    points: 5,
    prompt:
      '直线 y＝kx＋2 与圆 O：x²＋y²＝2 交于不同的两点 A、B，则三角形 OAB 面积的最大值为 ______。',
    tags: ['弦长', '三角形面积', '二次函数最值'],
    answer: '1。',
    explanation:
      '设圆心到直线的距离为 d＝2/√(1＋k²)，相交要求 0<d<√2。由垂径定理 |AB|＝2√(2−d²)，面积 S＝d√(2−d²)。令 u＝d²∈(0，2)，则 S²＝u(2−u)＝1−(u−1)²≤1。当 d²＝1、k＝±√3 时取到最大值 1。',
    rubric: [{ label: '填写 1 得 5 分。', points: 5 }],
  },
]

function circleConstruction(points: [number, number]): MathChallengeReferenceQuestion {
  return {
    id: 'mc-q15',
    kind: 'solution',
    title: '定圆与最长弦',
    points: points[0] + points[1],
    prompt:
      '圆 C 经过 A(0，0)、B(4，0)，圆心在直线 y＝x−1 上。\n（1）求圆 C 的标准方程。\n（2）直线 l：y＝x＋b 与圆 C 相交，求所截弦长的最大值及此时 b 的值。',
    tags: ['圆的标准方程', '垂直平分线', '弦长最值'],
    answer: '（1）(x−2)²＋(y−1)²＝5。\n（2）最长弦为 2√5，b＝−1。',
    explanation:
      '（1）圆心在 AB 的垂直平分线 x＝2 上，与 y＝x−1 联立得 C(2，1)。r²＝|CA|²＝5。\n（2）设圆心到 l 的距离为 d，则弦长 L＝2√(5−d²)。L 在 d＝0 时最大，此时直线经过圆心，所以 1＝2＋b，b＝−1，最大弦长为直径 2√5。',
    rubric: [
      { label: '（1）由垂直平分线求得圆心 (2，1)，求得 r²＝5，写出标准方程。', points: points[0] },
      {
        label: '（2）说明弦长随圆心距减小而增大，最长弦过圆心，求得 b＝−1 和 2√5。',
        points: points[1],
      },
    ],
  }
}

function distanceProducts(points: [number, number, number]): MathChallengeReferenceQuestion {
  return {
    id: 'mc-q16',
    kind: 'solution',
    title: '圆上距离与二次函数',
    points: points.reduce((a, b) => a + b, 0),
    prompt:
      '已知 O(0，0)、A(4，0)，点 P(x，y) 在圆 (x−2)²＋y²＝1 上运动。\n（1）用 x 表示 |OP|²，并求 |OP|² 的取值范围。\n（2）求 |OP|·|AP| 的取值范围。\n（3）求 |OP|＋|AP| 的取值范围，并分别指出取得最大值、最小值的点 P。',
    tags: ['圆上动点', '距离乘积', '配方', '平方转化'],
    answer:
      '（1）|OP|²＝4x−3，范围 [1，9]。\n（2）[3，5]。\n（3）[4，2√5]；P(2，±1) 时最大，P(1，0) 或 P(3，0) 时最小。',
    explanation:
      '（1）由圆方程得 x²＋y²＝4x−3，且 x∈[1，3]，因此 |OP|²∈[1，9]。\n（2）|AP|²＝(x−4)²＋y²＝13−4x。故 (|OP|·|AP|)²＝(4x−3)(13−4x)＝25−16(x−2)²。由 x∈[1，3] 得平方的范围为 [9，25]，两距离均为正，开方后得 [3，5]。\n（3）|OP|²＋|AP|²＝10，所以 (|OP|＋|AP|)²＝10＋2|OP|·|AP|∈[16，20]。因此距离和范围为 [4，2√5]，取等位置由第（2）问对应的 x 再代回圆方程得到。此处只讨论两段距离和，允许 O、P、A 共线。',
    rubric: [
      { label: '（1）利用圆方程得到 |OP|²＝4x−3，结合 x∈[1，3] 求出 [1，9]。', points: points[0] },
      {
        label: '（2）得到 |AP|²＝13−4x，将距离乘积平方配成 25−16(x−2)²，求得 [3，5]。',
        points: points[1],
      },
      { label: '（3）由距离和的平方求出 [4，2√5]，并写出两类取等点。', points: points[2] },
    ],
  }
}

function cubeVectors(points: [number, number, number]): MathChallengeReferenceQuestion {
  return {
    id: 'mc-q17',
    kind: 'solution',
    title: '空间向量综合',
    points: points.reduce((a, b) => a + b, 0),
    prompt:
      '正方体 ABCD－A₁B₁C₁D₁ 的棱长为 2，E、F 分别为 BB₁、DD₁ 的中点。\n（1）证明 EF∥平面 A₁BD。\n（2）求直线 AE 与平面 A₁BD 所成角的正弦值。\n（3）求点 C₁ 到平面 A₁BD 的距离。',
    tags: ['空间向量', '线面平行', '线面角', '点面距离'],
    answer: '（1）证明见解析。\n（2）√15/5。\n（3）4√3/3。',
    explanation:
      '以 A 为原点，AB、AD、AA₁ 所在直线分别为三条坐标轴，则 B(2，0，0)、D(0，2，0)、A₁(0，0，2)、C₁(2，2，2)、E(2，0，1)、F(0，2，1)。平面 A₁BD 的方程为 x＋y＋z＝2，可取法向量 n＝(1，1，1)。\n（1）EF＝(−2，2，0)，与 BD 平行；E、F 所在直线满足 x＋y＋z＝3，不在平面 A₁BD 内。因此 EF∥平面 A₁BD。\n（2）AE＝(2，0，1)，sin θ＝|AE·n|/(|AE||n|)＝3/√15＝√15/5。\n（3）点 C₁ 到该平面的距离为 |2＋2＋2−2|/√3＝4√3/3。也可用 C₁ 与平面上一点的向量在单位法向量上的投影求解。',
    rubric: [
      {
        label: '（1）正确建系或用中位线，证 EF∥BD，并说明 EF 不在平面 A₁BD 内，完成线面平行证明。',
        points: points[0],
      },
      {
        label: '（2）求得法向量 (1，1，1) 及 AE＝(2，0，1)，用投影求出线面角正弦 √15/5。',
        points: points[1],
      },
      { label: '（3）利用法向投影或点面距离公式求得 4√3/3。', points: points[2] },
    ],
  }
}

function chordAreaLocus(points: [number, number, number]): MathChallengeReferenceQuestion {
  return {
    id: 'mc-q18',
    kind: 'solution',
    title: '动弦、面积与中点轨迹',
    points: points.reduce((a, b) => a + b, 0),
    prompt:
      '直线 l：y＝kx＋3 与圆 O：x²＋y²＝4 交于不同的两点 A、B，M 为 AB 的中点。\n（1）求 k 的取值范围。\n（2）求三角形 OAB 面积的最大值，并求此时 k。\n（3）求点 M 的轨迹，须写出轨迹方程及限制条件。',
    tags: ['直线与圆', '二次函数最值', '垂径定理', '轨迹限制'],
    answer:
      '（1）k<−√5/2 或 k>√5/2。\n（2）最大面积为 2，k＝±√14/2。\n（3）M(x，y) 满足 x²＋y²＝3y，且 0<x²＋y²<4。',
    explanation:
      '（1）圆心到 l 的距离 d＝3/√(1＋k²)，交于两不同点要求 d<2，化为 k²>5/4。\n（2）|AB|＝2√(4−d²)，面积 S＝d√(4−d²)。令 u＝d²，0<u<4，则 S²＝4u−u²＝4−(u−2)²≤4。当 u＝2 时 S＝2，由 9/(1＋k²)＝2 得 k＝±√14/2，均在允许范围内。\n（3）由垂径定理 OM⊥AB，且 T(0，3) 在 AB 所在直线上。设 M(x，y)，则 OM·MT＝x(−x)＋y(3−y)＝0，所以 x²＋y²＝3y。两不同交点要求 OM<2；有限斜率的直线 y＝kx＋3 不经过 O，故 OM>0。反过来，满足上述方程及限制的点均有 y>0，取 k＝−x/y 即得该垂足，故没有多余点。也可写为 x²＋(y−3/2)²＝9/4 且 0<y<4/3。',
    rubric: [
      {
        label: '（1）用圆心距小于半径或判别式大于零，求得 |k|>√5/2，保留严格不等号。',
        points: points[0],
      },
      {
        label: '（2）以 d 表示弦长与面积，令 u＝d² 配方，得最大面积 2 及 k＝±√14/2，并验证可取。',
        points: points[1],
      },
      {
        label: '（3）由 OM⊥MT 得轨迹圆方程，限制 0<OM<2，排除原点及相切位置，并说明充分性。',
        points: points[2],
      },
    ],
  }
}

function circleMixed(points: [number, number, number?]): MathChallengeReferenceQuestion {
  const includeParameter = points[2] !== undefined
  return {
    id: 'mc-q19',
    kind: 'solution',
    title: '圆与范围、恒成立问题',
    points: points.reduce<number>((a, b) => a + (b ?? 0), 0),
    prompt:
      '点 P(x，y) 在圆 (x−2)²＋y²＝1 上运动，O 为坐标原点。\n（1）求 x＋y 的取值范围。\n（2）求 (y＋1)/x 的取值范围。' +
      (includeParameter ? '\n（3）若对圆上任意点 P 都有 |OP|²≥my，求实数 m 的取值范围。' : ''),
    tags: ['圆上动点', '线性式范围', '切线', ...(includeParameter ? ['恒成立', '参数范围'] : [])],
    answer: '（1）[2−√2，2＋√2]。\n（2）[0，4/3]。' + (includeParameter ? '\n（3）−3≤m≤3。' : ''),
    explanation:
      '（1）圆心 (2，0)、半径 1。直线 x＋y＝s 与圆有公共点等价于 |2−s|/√2≤1，得到范围 [2−√2，2＋√2]。\n（2）由圆方程有 x∈[1，3]，分母不为零。设 k＝(y＋1)/x，则直线 kx−y−1＝0 与圆有公共点，等价于 |2k−1|/√(1＋k²)≤1。平方化简为 3k²−4k≤0，所以 k∈[0，4/3]。两端点均对应切线，可以取到。' +
      (includeParameter
        ? '\n（3）利用圆方程 |OP|²＝x²＋y²＝4x−3，原不等式等价于 4x−my−3≥0。线性式在圆心的值为 5，振幅为 √(16＋m²)，故其最小值为 5−√(16＋m²)。要求对所有 P 成立，等价于这个最小值非负，得到 m²≤9，即 m∈[−3，3]。'
        : ''),
    rubric: [
      {
        label: '（1）由线性式对应的平行直线与圆有公共点，或向量数量积范围，求出两端点。',
        points: points[0],
      },
      {
        label:
          '（2）先说明 x≠0，把比值视作过 (0，−1) 的直线斜率，列圆心距条件并解得闭区间 [0，4/3]。',
        points: points[1],
      },
      ...(includeParameter
        ? [
            {
              label: '（3）由圆方程消去 x²＋y²，将恒成立转为线性式最小值非负，解得 [−3，3]。',
              points: points[2]!,
            },
          ]
        : []),
    ],
  }
}

const parameterChallenge: MathChallengeReferenceQuestion = {
  id: 'mc-q20',
  kind: 'solution',
  title: '参数最值与恒成立',
  points: 15,
  prompt:
    '点 P(x，y) 在圆 (x−3)²＋y²＝4 上运动，O 为坐标原点，t 为实数。\n（1）求 |OP|²−ty 的最小值（用 t 表示）。\n（2）若对圆上任意点 P 都有 |OP|²≥ty，求 t 的取值范围。\n（3）当 t 分别取第（2）问所得区间的两个端点时，求使等号成立的点 P。',
  tags: ['圆上动点', '参数最值', '恒成立', '等号条件'],
  answer:
    '（1）13−2√(36＋t²)。\n（2）−5/2≤t≤5/2。\n（3）t＝5/2 时 P(15/13，10/13)；t＝−5/2 时 P(15/13，−10/13)。',
  explanation:
    '（1）由圆方程得 |OP|²＝x²＋y²＝6x−5。令 u＝x−3、v＝y，则 u²＋v²＝4，故 |OP|²−ty＝13＋6u−tv。由数量积范围或平行线与圆相切，6u−tv 的最小值为 −2√(36＋t²)，所求为 13−2√(36＋t²)。\n（2）恒成立等价于最小值非负，即 13≥2√(36＋t²)。两边非负，可平方，得 t²≤25/4，即 t∈[−5/2，5/2]。\n（3）最小时 (u，v) 与 (6，−t) 反向，故 (u，v)＝−2(6，−t)/√(36＋t²)。在 t＝±5/2 时，根号为 13/2，于是 x＝3−24/13＝15/13，y＝4t/13＝±10/13。两点代入圆方程及 |OP|²＝ty 均成立。',
  rubric: [
    {
      label: '（1）利用圆方程改写为 13＋6u−tv，结合 u²＋v²＝4，得到最小值 13−2√(36＋t²)。',
      points: 6,
    },
    { label: '（2）将对所有圆上点成立转化为最小值非负，正确平方并求得 [−5/2，5/2]。', points: 5 },
    { label: '（3）使用线性式取最小值时的反向条件，求得并正确配对两个取等点。', points: 4 },
  ],
}

export const mathChallengePapers: MathChallengePaperDefinition[] = [
  {
    id: 'math-stage-comprehensive-19',
    title: '数学挑战 · 高二阶段综合卷 A',
    description:
      '8 道单选＋3 道多选＋3 道填空＋5 道解答。150 分，120 分钟；按已学范围穿插综合，重点训练距离、面积与二次函数的衔接。',
    scope,
    source,
    durationMinutes: 120,
    solutionCount: 5,
    questions: [
      ...structuredClone(objectiveQuestions),
      circleConstruction([6, 7]),
      distanceProducts([5, 5, 5]),
      cubeVectors([5, 5, 5]),
      chordAreaLocus([5, 6, 6]),
      circleMixed([5, 6, 6]),
    ],
  },
  {
    id: 'math-stage-comprehensive-20',
    title: '数学挑战 · 高二阶段综合卷 B',
    description:
      '8 道单选＋3 道多选＋3 道填空＋6 道解答。150 分，120 分钟；与 A 卷共享前 14 题及部分大题，增加参数最值与恒成立压轴，适合比较练习。',
    scope,
    source,
    durationMinutes: 120,
    solutionCount: 6,
    questions: [
      ...structuredClone(objectiveQuestions),
      circleConstruction([6, 6]),
      distanceProducts([4, 4, 4]),
      cubeVectors([4, 4, 4]),
      chordAreaLocus([4, 5, 4]),
      circleMixed([5, 8]),
      parameterChallenge,
    ],
  },
]
