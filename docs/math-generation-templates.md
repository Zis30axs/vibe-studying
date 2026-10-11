# 原创几何出题模板

这四类模板把知识技能转成**新的、参数可变的教学练习**。它们不是截图题库，不收录上传的题目、图片、手写答案或原题转录，也不推测原试卷分值。题干、场景和参考结论均由本地程序从受限参数构造。模板中的 8 分或 12 分是明确标注的自设练习分值，不是原题或官方评分。

## 使用与工具边界

- `GEOMETRY_TEMPLATE_CATALOG` 提供 `id`、中文标题、可复制的自然语言请求、默认参数、参数描述和专门的生成要求。
- 数学 Agent 的“创作题目”模式默认启用本地几何出题能力。用户只写普通要求；主进程自动在可信系统上下文中提供四类题型、教学目标、合法工具签名、参数约束与默认参数，模型选择后调用生成工具。无需用户复制任何提示词。关闭该工具、切到普通学习/审阅或其他学科后均不会注入目录。开始请求与保存草案仍分别需要用户确认。
- `geometryTemplatePrompt(id)` 仅用于开发或外部工具集成时导出完整纯文本请求，不是应用正常出题的人工操作步骤。
- `generate_geometry_question({templateId, parameters})` 调用本地确定性编译器，产生待确认的题目草案。模型不能提交或覆盖题干、答案、评分、图形、SVG、代码、网址或来源。
- `compileGeometryTemplate(input, id?)` 返回完整 `Question`。ID 未指定时从规范参数确定性生成；传入 ID 仍须通过格式检查。
- `geometryTemplateInputSchema` 是严格的带标签联合输入校验；`geometryTemplateToolSchema` 是 MCP 可发布的顶层严格对象形状，并执行同样的模板与参数匹配校验。
- 单次 Agent 任务**最多 6 次工具调用**，通常 1 次生成调用即可；不是要求每题必须调用满 6 次。

可选核验使用真实工具：

```text
search_formulas({query, limit: 1})
geometry_calculate({request: {operation: "vector_metrics", a, b}})
geometry_calculate({request: {operation: "point_line_foot", point, a, b}})
geometry_calculate({request: {operation: "point_plane_foot", point, a, b, c}})
geometry_calculate({request: {operation: "plane_normal", a, b, c}})
geometry_calculate({request: {operation: "line_plane_angle", from, to, a, b, c}})
geometry_calculate({request: {operation: "tetrahedron_volume", a, b, c, d}})
```

上述点、向量均是有限的 `{x,y,z}`，不是表达式字符串。`math_measure` 支持平面距离 `distance` 和三点角度 `angle`，点为 `{x,y}`。`math_plot({expression, probes})` 仅进行安全算术函数采样，曲线视窗为 x、y 各 −10～10，不是隐式直线作图、空间几何编辑或符号代数系统。有限采样不能证明全域最值、连续性或开闭端点。

图形使用版本 1 的声明式三轴几何场景。投影用于观察，距离和夹角必须在数学坐标中计算。平面题联合限制所有给定点坐标位于 ±10 内，适配原有平面画板、垂足构造与直线工具；空间场景使用有界三维点，并保留真实的倾斜侧棱。数值核验为有限精度浮点计算，近似结果标注约等于并最多保留 6 位小数；这里不宣称一般符号代数能力。

## 1. 空间向量的夹角与组合垂直

模板 ID：`vector-angle-orthogonality`

```json
{
  "templateId": "vector-angle-orthogonality",
  "parameters": { "aX": 2, "bX": -3, "bZ": 2, "mix": 3 }
}
```

可复制请求：生成新的空间向量练习，由三点坐标求两个向量的夹角余弦，再求两个线性组合垂直时的全部实参数。保留有向夹角余弦的符号，检查组合向量非零，参考答案由本地程序计算。

参数：`aX`、`bZ` 为 1～6 的整数；`bX` 为 −6～6 的非零整数；`mix` 为 1～4 的整数。固定起点 A=(1,−2,1)，构造 a=(aX,1,0)、b=(bX,0,bZ)，再由 A+a、A+b 构造两个终点。

不共线性由 a 的非零 y 分量及 b 的非零 z 分量保证，所以两向量非零。设 q=|a|²、r=|b|²、d=a·b、m=mix，则垂直条件为：

```text
(ka+b)·(ka−mb) = qk² + (1−m)dk − mr = 0
Δ = (1−m)²d² + 4mqr > 0
```

宿主计算两个实根并逐一调用向量工具核验；线性无关性保证任何根都不会产生零向量。有向向量夹角为 0°～180°，不对数量积取绝对值。学生场景只含给定三点与两条连接线。

## 2. 高线、垂足与过垂足的平行线

模板 ID：`triangle-altitude-parallel`

```json
{
  "templateId": "triangle-altitude-parallel",
  "parameters": {
    "run": 4,
    "rise": 2,
    "footFraction": 0.25,
    "height": 1,
    "offsetX": -2,
    "offsetY": -1
  }
}
```

可复制请求：生成新的非退化三角形练习，求高线的一般式方程、垂足坐标，以及过垂足且平行于指定边的直线。图中不要提前提供垂足或答案辅助线，允许水平底边与竖直高线。

参数：`run` 是 1～8 的整数，`rise` 是 −6～6 的整数，`footFraction` 是 0.25、0.5 或 0.75，`height` 是 1～4 的整数，两个偏移各为 −5～5 的整数。**这些单项范围并不足够**：构造出的 A、B、C 的全部 x、y 坐标还必须在 [−10,10] 内，否则拒绝生成。

构造 u=(run,rise)，B=(offsetX,offsetY)，C=B+u，D=B+footFraction·u，A=D+height·(−rise,run)。u 非零且 height>0，故三角形面积严格大于零；垂足在 BC 内部。`height` 是法向量倍数，不是假称实际高长。

高线用 u 作法向量，并代入 A；过 D 平行于 AC 的直线用 AC 的垂直向量作法向量，并代入 D。全程采用一般式而不是斜率，避免除零。参数都是整数或四分之一倍数，宿主用精确的二进制有理系数约成整系数一般式；垂足也由 `point_line_foot` 独立复核。给定场景只画 A、B、C，不泄漏 D。

## 3. 斜平行六面体的长度与棱间角

模板 ID：`oblique-parallelepiped`

```json
{
  "templateId": "oblique-parallelepiped",
  "parameters": {
    "baseA": 4,
    "baseB": 6,
    "side": 5,
    "leanX": 0.5,
    "leanY": 0.25,
    "edgeFraction": 0.25
  }
}
```

可复制请求：生成新的斜平行六面体练习，底面相邻棱互相垂直，但侧棱与两条底棱都不垂直。根据对侧棱上内分点的位置，求连接线长度及其与一条底棱所成角的余弦。保留数量积交叉项，不能改成长方体。

三种长度为 2～10 的整数；两个方向余弦 `leanX`、`leanY` 各为 0.25 或 0.5；`edgeFraction` 为 0.25、0.5 或 0.75。宿主统一构造：

```text
a = (baseA, 0, 0)
b = (0, baseB, 0)
c = side · (leanX, leanY, √(1−leanX²−leanY²))
AE = a+b+edgeFraction·c
```

Gram 行列式为 `(baseA·baseB·side)²(1−leanX²−leanY²)>0`，保证三棱线性无关。两个倾斜余弦均不为零，防止意外长方体化。图形和参考答案使用同一组向量。长度平方保留 a·c 与 b·c 的全部交叉项；线线较小夹角的余弦用数量积绝对值。E 的比例是明确给定条件，可以画 E 及 AE；场景不包含计算出来的长度或夹角数值。

## 4. 正方形底面棱锥的垂直、体积与整平面动点范围

模板 ID：`square-pyramid-locus`

```json
{ "templateId": "square-pyramid-locus", "parameters": { "side": 5 } }
```

可复制请求：生成一道新的正方形底面四棱锥综合练习。先证明公共侧棱垂直底面，再由面面夹角确定棱上内点并计算三棱锥体积，最后让 H 在整个指定平面上运动，证明线面角正弦的完整区间及其端点。不要将整平面缩为三角形，不提前画出待求点。

这里只开放已经证明安全的缩放参数：整数边长 s=side，范围 2～12。底面是正方形，两个相邻侧面垂直底面，公共侧棱 PA 的垂直性须先证明；第二问 PA=s。这不是将顶点强制放在正方形中心上方的“正四棱锥”。给定 PE/PD=1/3，F 在开线段 PC，平面 AEF 与底面 ABCD 的**较小面面夹角**余弦为 1/3。

证明垂直后建立正交坐标 A=(0,0,0)，B=(s,0,0)，D=(0,s,0)，P=(0,0,s)。E=(0,s/3,2s/3)，令 F=(st,st,s(1−t))，t∈(0,1)。平面 AEF 的法向量可取 `(1−3t,2t,−t)`。角度条件导出：

```text
t/√((1−3t)²+5t²) = 1/3
(1−3t)² = 4t²
5t²−6t+1 = 0
```

两个根是 1/5 与 1，后者为不允许的端点，因此唯一内点 t=1/5。平面 AEF 为 2x+2y−z=0，G 为其与 PB 的交点 `(s/3,0,2s/3)`。体积为 s³/90，GF 可取方向向量 d=(−2,3,2)。这些结论仅存于参考解析、评分与编译器局部变量。

整个平面 PBC 是 x+z=s，所以 H=(h,k,s−h)，h、k 均为任意实数。平面 HAD 的法向量可取 m=(s−h,0,−h)。因为 s>0，m 不可能为零，平面始终有定义。于是：

```text
sinα = 2s / [√17·√((s−h)²+h²)]
     = 2s / [√17·√(2(h−s/2)²+s²/2)]
```

h=s/2、k 任意时取得最大值 √(8/17)。任何有限 h 都使该式严格为正，而 |h|→∞ 时趋于 0；连续性及半轴上的单调性保证每个中间值可达。因此完整范围是 **(0,√(8/17)]**，下端点开放。若错误地限制 H 在闭三角形 PBC 内，会得到不同的 **[2/√17,√(8/17)]**；这项对比只用于参考侧解释题意，不能替换题目条件。

学生场景仅含 P、A、B、C、D、E 与已知底面直角。不包含求解后的 F、G、最值位置 H，也不预置表示待证明 PA⊥底面的直角标记。

## 验证与公开边界

`tests/geometry-templates.test.ts` 检查：

- 四类默认题确定性、题库校验、学生快照和参考字段隔离
- 严格字段、有限数、参数上下界、混用模板参数和不安全 ID 的拒绝
- 输入中的访问器、循环对象与继承载荷不被执行
- MCP 顶层输入模式发布时仍具有真实字段形状
- 正负向量夹角、两个实根的代回与非零性
- 平面画板联合边界、竖直高线、非退化三角形
- 倾斜侧棱、Gram 正定条件、保留交叉项后的长度与夹角
- 全部 11 个棱锥尺度的体积、整平面线面角、最大值及学生图中待求点隔离

运行 `npx vitest run tests/geometry-templates.test.ts` 和 `npm run typecheck`。完整集成还应执行相关 Agent、MCP、题库持久化及场景渲染测试。
