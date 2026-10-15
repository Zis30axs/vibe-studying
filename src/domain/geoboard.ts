import { BOARD_LIMITS, boardStyle, emptyGeoboard } from '../shared/geoboard-types'
import type {
  BoardNode,
  BoardObject,
  BoardPoint,
  BoardVec,
  GeoboardState,
} from '../shared/geoboard-types'
export { emptyGeoboard, boardStyle }
export type { BoardNode, BoardObject, BoardPoint, BoardVec, GeoboardState }

const EPS = 1e-9
const TAU = 2 * Math.PI
export const add = (a: BoardVec, b: BoardVec): BoardVec => ({ x: a.x + b.x, y: a.y + b.y })
export const sub = (a: BoardVec, b: BoardVec): BoardVec => ({ x: a.x - b.x, y: a.y - b.y })
export const mul = (a: BoardVec, k: number): BoardVec => ({ x: a.x * k, y: a.y * k })
export const dot = (a: BoardVec, b: BoardVec): number => a.x * b.x + a.y * b.y
export const cross = (a: BoardVec, b: BoardVec): number => a.x * b.y - a.y * b.x
export const norm = (a: BoardVec): number => Math.hypot(a.x, a.y)
export const distance = (a: BoardVec, b: BoardVec): number => norm(sub(a, b))
const near = (a: number, b: number, scale = 1): boolean =>
  Math.abs(a - b) <= EPS * Math.max(1, scale)
const normal = (a: BoardVec): BoardVec => {
  const n = norm(a)
  if (n < EPS) throw new Error('重合点不能确定直线。')
  return mul(a, 1 / n)
}
const finite = (n: number): boolean => Number.isFinite(n)
const within = (p: BoardVec): boolean =>
  finite(p.x) &&
  finite(p.y) &&
  Math.abs(p.x) <= BOARD_LIMITS.coordinate &&
  Math.abs(p.y) <= BOARD_LIMITS.coordinate
export type ResolvedPoint = { type: 'point'; p: BoardVec }
export type ResolvedLine = { type: 'line'; p: BoardVec; d: BoardVec; min: number; max: number }
export type ResolvedCircle = { type: 'circle'; center: BoardVec; radius: number }
export type ResolvedPolygon = { type: 'polygon'; points: BoardVec[] }
export type ResolvedArc = {
  type: 'arc'
  center: BoardVec
  radius: number
  start: number
  sweep: number
}
export type Resolved = ResolvedPoint | ResolvedLine | ResolvedCircle | ResolvedPolygon | ResolvedArc
export type ConstructionResult = { values: Map<string, Resolved>; errors: Map<string, string> }
export function dependencies(node: BoardNode): string[] {
  switch (node.kind) {
    case 'free':
      return []
    case 'midpoint':
    case 'intersection':
      return [node.a, node.b]
    case 'projection':
    case 'reflection':
      return [node.point, node.line]
    case 'on-object':
      return [node.object]
    case 'segment':
    case 'line':
    case 'ray':
      return [node.from, node.to]
    case 'parallel':
    case 'perpendicular':
      return [node.through, node.line]
    case 'circle':
      return [node.center, node.through]
    case 'fixed-circle':
      return [node.center]
    case 'circumcircle':
      return [node.a, node.b, node.c]
    case 'polygon':
      return [...node.points]
    case 'arc':
      return [node.center, node.start, node.end]
    case 'tangent':
      return [node.point, node.circle]
  }
}
const pointKinds = new Set([
  'free',
  'midpoint',
  'projection',
  'intersection',
  'on-object',
  'reflection',
])
const lineKinds = new Set(['segment', 'line', 'ray', 'parallel', 'perpendicular', 'tangent'])
const circleKinds = new Set(['circle', 'fixed-circle', 'circumcircle'])
const baseKeys = ['id', 'kind', 'label', 'color', 'visible', 'fill']
const keysByKind: Record<string, string[]> = {
  free: ['x', 'y', 'locked'],
  midpoint: ['a', 'b'],
  projection: ['point', 'line'],
  reflection: ['point', 'line'],
  intersection: ['a', 'b', 'branch'],
  'on-object': ['object', 'parameter'],
  segment: ['from', 'to'],
  line: ['from', 'to'],
  ray: ['from', 'to'],
  parallel: ['through', 'line'],
  perpendicular: ['through', 'line'],
  circle: ['center', 'through'],
  'fixed-circle': ['center', 'radius'],
  circumcircle: ['a', 'b', 'c'],
  polygon: ['points'],
  arc: ['center', 'start', 'end'],
  tangent: ['point', 'circle', 'branch'],
}
/** Strict wire check also used by JSON import. No eval, prototype keys, or silent repair. */
export function assertGeoboard(input: unknown): asserts input is GeoboardState {
  const object = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v)
  const exact = (v: Record<string, unknown>, keys: string[]) =>
    Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k))
  if (
    !object(input) ||
    !exact(input, ['version', 'points', 'objects', 'view']) ||
    input.version !== 1
  )
    throw new Error('钉板文档版本或字段无效。')
  if (
    !Array.isArray(input.points) ||
    !Array.isArray(input.objects) ||
    input.points.length > 200 ||
    input.objects.length > 300
  )
    throw new Error('钉板最多 200 个点、300 个图形。')
  if (
    !object(input.view) ||
    !exact(input.view, ['x', 'y', 'scale', 'grid', 'step', 'snap', 'axes', 'labels'])
  )
    throw new Error('视图字段无效。')
  const v = input.view
  for (const key of ['x', 'y', 'scale', 'step'])
    if (typeof v[key] !== 'number' || !finite(v[key])) throw new Error('视图必须使用有限数值。')
  if (
    Math.abs(v.x as number) > 10000 ||
    Math.abs(v.y as number) > 10000 ||
    (v.scale as number) < 8 ||
    (v.scale as number) > 160 ||
    (v.step as number) < 0.01 ||
    (v.step as number) > 100
  )
    throw new Error('视图超出支持范围。')
  if (
    !['square', 'isometric', 'circular', 'none'].includes(v.grid as string) ||
    ['snap', 'axes', 'labels'].some((k) => typeof v[k] !== 'boolean')
  )
    throw new Error('网格设置无效。')
  const nodes = [...input.points, ...input.objects]
  const ids = new Set<string>()
  for (const [i, raw] of nodes.entries()) {
    if (
      !object(raw) ||
      typeof raw.kind !== 'string' ||
      !Object.hasOwn(keysByKind, raw.kind) ||
      !exact(raw, [...baseKeys, ...keysByKind[raw.kind]])
    )
      throw new Error('图形类型或字段无效。')
    if (i < input.points.length !== pointKinds.has(raw.kind))
      throw new Error('点与图形的集合不匹配。')
    if (
      typeof raw.id !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(raw.id) ||
      ['__proto__', 'prototype', 'constructor'].includes(raw.id) ||
      ids.has(raw.id)
    )
      throw new Error('元素 ID 无效或重复。')
    ids.add(raw.id)
    if (
      typeof raw.label !== 'string' ||
      raw.label.length > 80 ||
      typeof raw.color !== 'string' ||
      !/^#[0-9a-fA-F]{6}$/.test(raw.color) ||
      typeof raw.visible !== 'boolean' ||
      typeof raw.fill !== 'boolean'
    )
      throw new Error('图形样式无效。')
    if (
      raw.kind === 'free' &&
      (typeof raw.x !== 'number' ||
        typeof raw.y !== 'number' ||
        !within(raw as unknown as BoardVec) ||
        typeof raw.locked !== 'boolean')
    )
      throw new Error('自由点坐标或锁定状态无效。')
    if (
      raw.kind === 'fixed-circle' &&
      (typeof raw.radius !== 'number' ||
        !finite(raw.radius) ||
        raw.radius <= 0 ||
        raw.radius > 10000)
    )
      throw new Error('半径必须大于 0 且不超过 10000。')
    if (
      raw.kind === 'on-object' &&
      (typeof raw.parameter !== 'number' ||
        !finite(raw.parameter) ||
        Math.abs(raw.parameter) > 1000000)
    )
      throw new Error('约束参数无效。')
    if (
      (raw.kind === 'intersection' || raw.kind === 'tangent') &&
      raw.branch !== 0 &&
      raw.branch !== 1
    )
      throw new Error('交点分支无效。')
    if (
      raw.kind === 'polygon' &&
      (!Array.isArray(raw.points) ||
        raw.points.length < 3 ||
        raw.points.length > 80 ||
        new Set(raw.points).size !== raw.points.length)
    )
      throw new Error('多边形需要 3—80 个不同顶点。')
    for (const ref of dependencies(raw as unknown as BoardNode))
      if (typeof ref !== 'string') throw new Error('构造引用必须是 ID。')
  }
  const state = input as unknown as GeoboardState
  const map = new Map<string, BoardNode>([...state.points, ...state.objects].map((n) => [n.id, n]))
  function requireKind(id: string, kinds: Set<string>) {
    const node = map.get(id)
    if (!node || !kinds.has(node.kind)) throw new Error('引用不存在，或引用的图形类型不正确。')
  }
  const curves = new Set([...lineKinds, ...circleKinds])
  for (const n of map.values()) {
    const p = (id: string) => requireKind(id, pointKinds)
    const l = (id: string) => requireKind(id, lineKinds)
    switch (n.kind) {
      case 'free':
        break
      case 'midpoint':
        p(n.a)
        p(n.b)
        if (n.a === n.b) throw new Error('中点需要两个不同点。')
        break
      case 'projection':
      case 'reflection':
        p(n.point)
        l(n.line)
        break
      case 'intersection':
        requireKind(n.a, curves)
        requireKind(n.b, curves)
        if (n.a === n.b) throw new Error('不能求自身交点。')
        break
      case 'on-object':
        requireKind(n.object, curves)
        break
      case 'segment':
      case 'line':
      case 'ray':
        p(n.from)
        p(n.to)
        if (n.from === n.to) throw new Error('端点 ID 不能相同。')
        break
      case 'parallel':
      case 'perpendicular':
        p(n.through)
        l(n.line)
        break
      case 'circle':
        p(n.center)
        p(n.through)
        if (n.center === n.through) throw new Error('圆上点不能是圆心。')
        break
      case 'fixed-circle':
        p(n.center)
        break
      case 'circumcircle':
        p(n.a)
        p(n.b)
        p(n.c)
        if (new Set([n.a, n.b, n.c]).size !== 3) throw new Error('三点圆需要三个不同点。')
        break
      case 'polygon':
        n.points.forEach(p)
        break
      case 'arc':
        p(n.center)
        p(n.start)
        p(n.end)
        if (new Set([n.center, n.start, n.end]).size !== 3) throw new Error('圆弧需要三个不同点。')
        break
      case 'tangent':
        p(n.point)
        requireKind(n.circle, circleKinds)
        break
    }
  }
  const marks = new Map<string, number>()
  function visit(id: string) {
    if (marks.get(id) === 1) throw new Error('构造存在循环依赖。')
    if (marks.get(id) === 2) return
    marks.set(id, 1)
    for (const d of dependencies(map.get(id)!)) visit(d)
    marks.set(id, 2)
  }
  for (const id of map.keys()) visit(id)
}
export function parseGeoboard(text: string): GeoboardState {
  if (text.length > 1024 * 1024) throw new Error('钉板 JSON 不能超过 1 MiB。')
  const value: unknown = JSON.parse(text)
  assertGeoboard(value)
  return value
}
const inLine = (t: number, line: ResolvedLine): boolean =>
  t >= line.min - EPS && t <= line.max + EPS
export function intersections(
  a: ResolvedLine | ResolvedCircle,
  b: ResolvedLine | ResolvedCircle,
): BoardVec[] {
  if (a.type === 'circle' && b.type === 'line') return intersections(b, a)
  if (a.type === 'line' && b.type === 'line') {
    const det = cross(a.d, b.d)
    if (Math.abs(det) < EPS) return [] // Parallel or coincident: no unique intersection.
    const delta = sub(b.p, a.p)
    const ta = cross(delta, b.d) / det,
      tb = cross(delta, a.d) / det
    return inLine(ta, a) && inLine(tb, b) ? [add(a.p, mul(a.d, ta))] : []
  }
  if (a.type === 'line' && b.type === 'circle') {
    const t = dot(sub(b.center, a.p), a.d)
    const foot = add(a.p, mul(a.d, t))
    const h2 = b.radius ** 2 - distance(foot, b.center) ** 2
    const tolerance = EPS * Math.max(1, b.radius ** 2)
    if (h2 < -tolerance) return []
    const h = Math.sqrt(Math.max(0, h2))
    const ts = h <= EPS ? [t] : [t - h, t + h]
    return ts.filter((n) => inLine(n, a)).map((n) => add(a.p, mul(a.d, n)))
  }
  if (a.type === 'circle' && b.type === 'circle') {
    const delta = sub(b.center, a.center),
      d = norm(delta)
    if (d < EPS || d > a.radius + b.radius + EPS || d < Math.abs(a.radius - b.radius) - EPS)
      return []
    const along = (a.radius ** 2 - b.radius ** 2 + d ** 2) / (2 * d)
    const h2 = a.radius ** 2 - along ** 2
    if (h2 < -EPS * Math.max(1, a.radius ** 2)) return []
    const h = Math.sqrt(Math.max(0, h2)),
      u = mul(delta, 1 / d)
    const mid = add(a.center, mul(u, along)),
      side = { x: -u.y * h, y: u.x * h }
    return h < EPS ? [mid] : [sub(mid, side), add(mid, side)]
  }
  return []
}
export function solveGeoboard(state: GeoboardState): ConstructionResult {
  const nodes = new Map<string, BoardNode>(
    [...state.points, ...state.objects].map((n) => [n.id, n]),
  )
  const values = new Map<string, Resolved>(),
    errors = new Map<string, string>(),
    visiting = new Set<string>()
  function resolve(id: string): Resolved {
    if (values.has(id)) return values.get(id)!
    if (errors.has(id)) throw new Error(errors.get(id))
    if (visiting.has(id)) throw new Error('循环构造。')
    const node = nodes.get(id)
    if (!node) throw new Error('缺少引用元素。')
    visiting.add(id)
    try {
      const point = (ref: string): BoardVec => {
        const r = resolve(ref)
        if (r.type !== 'point') throw new Error('需要点。')
        return r.p
      }
      const line = (ref: string): ResolvedLine => {
        const r = resolve(ref)
        if (r.type !== 'line') throw new Error('需要直线。')
        return r
      }
      const circle = (ref: string): ResolvedCircle => {
        const r = resolve(ref)
        if (r.type !== 'circle') throw new Error('需要圆。')
        return r
      }
      const makeLine = (
        p: BoardVec,
        d: BoardVec,
        min = -Infinity,
        max = Infinity,
      ): ResolvedLine => ({ type: 'line', p, d: normal(d), min, max })
      let result: Resolved
      switch (node.kind) {
        case 'free':
          result = { type: 'point', p: { x: node.x, y: node.y } }
          break
        case 'midpoint':
          result = { type: 'point', p: mul(add(point(node.a), point(node.b)), 0.5) }
          break
        case 'projection':
        case 'reflection': {
          const p = point(node.point),
            l = line(node.line),
            foot = add(l.p, mul(l.d, dot(sub(p, l.p), l.d)))
          result = { type: 'point', p: node.kind === 'projection' ? foot : sub(mul(foot, 2), p) }
          break
        }
        case 'on-object': {
          const r = resolve(node.object)
          if (r.type === 'line') {
            // Parameter is a fraction along a segment, a distance on rays/lines.
            const t = finite(r.max)
              ? Math.max(0, Math.min(1, node.parameter)) * r.max
              : Math.max(r.min, node.parameter)
            result = { type: 'point', p: add(r.p, mul(r.d, t)) }
          } else if (r.type === 'circle')
            result = {
              type: 'point',
              p: add(
                r.center,
                mul({ x: Math.cos(node.parameter), y: Math.sin(node.parameter) }, r.radius),
              ),
            }
          else throw new Error('只能将点约束在直线、线段、射线或圆上。')
          break
        }
        case 'intersection': {
          const a = resolve(node.a),
            b = resolve(node.b)
          if (
            (a.type !== 'line' && a.type !== 'circle') ||
            (b.type !== 'line' && b.type !== 'circle')
          )
            throw new Error('不支持此交点类型。')
          const ps = intersections(a, b)
          const p = ps[node.branch]
          if (!p) throw new Error('此分支当前没有唯一交点（相离、平行、重合或已合并）。')
          result = { type: 'point', p }
          break
        }
        case 'segment':
        case 'line':
        case 'ray': {
          const p = point(node.from),
            q = point(node.to)
          result = makeLine(
            p,
            sub(q, p),
            node.kind === 'line' ? -Infinity : 0,
            node.kind === 'segment' ? distance(p, q) : Infinity,
          )
          break
        }
        case 'parallel':
        case 'perpendicular': {
          const l = line(node.line)
          result = makeLine(
            point(node.through),
            node.kind === 'parallel' ? l.d : { x: -l.d.y, y: l.d.x },
          )
          break
        }
        case 'circle':
        case 'fixed-circle': {
          const center = point(node.center),
            radius = node.kind === 'circle' ? distance(center, point(node.through)) : node.radius
          if (radius < EPS) throw new Error('半径为零，圆退化。')
          result = { type: 'circle', center, radius }
          break
        }
        case 'circumcircle': {
          const a = point(node.a),
            u = sub(point(node.b), a),
            v = sub(point(node.c), a),
            det = 2 * cross(u, v)
          if (Math.abs(det) <= EPS * Math.max(1, norm(u) * norm(v)))
            throw new Error('三点共线或重合，不能唯一确定圆。')
          const u2 = dot(u, u),
            v2 = dot(v, v)
          const center = add(a, { x: (v.y * u2 - u.y * v2) / det, y: (u.x * v2 - v.x * u2) / det })
          result = { type: 'circle', center, radius: distance(center, a) }
          break
        }
        case 'polygon':
          result = { type: 'polygon', points: node.points.map(point) }
          break
        case 'arc': {
          const center = point(node.center),
            start = sub(point(node.start), center),
            end = sub(point(node.end), center)
          if (norm(start) < EPS || norm(end) < EPS) throw new Error('圆心不能兼作圆弧方向点。')
          const angle = Math.atan2(start.y, start.x)
          result = {
            type: 'arc',
            center,
            radius: norm(start),
            start: angle,
            sweep: (Math.atan2(end.y, end.x) - angle + TAU) % TAU,
          }
          break
        }
        case 'tangent': {
          const p = point(node.point),
            c = circle(node.circle),
            u = sub(p, c.center),
            d2 = dot(u, u),
            r2 = c.radius ** 2
          if (d2 < r2 - EPS * Math.max(1, r2)) throw new Error('圆内点不能作实切线。')
          if (near(d2, r2, r2)) {
            if (node.branch === 1) throw new Error('圆上点仅有一条切线。')
            result = makeLine(p, { x: -u.y, y: u.x })
          } else {
            const factor =
              ((c.radius * Math.sqrt(Math.max(0, d2 - r2))) / d2) * (node.branch === 0 ? -1 : 1)
            const t = add(add(c.center, mul(u, r2 / d2)), { x: -u.y * factor, y: u.x * factor })
            result = makeLine(p, sub(t, p))
          }
          break
        }
      }
      const vectors =
        result.type === 'point'
          ? [result.p]
          : result.type === 'line'
            ? [result.p, result.d]
            : result.type === 'polygon'
              ? result.points
              : [result.center]
      if (
        vectors.some((p) => !finite(p.x) || !finite(p.y)) ||
        ('radius' in result && !finite(result.radius))
      )
        throw new Error('构造数值不可用。')
      values.set(id, result)
      return result
    } catch (e) {
      const message = e instanceof Error ? e.message : '构造暂不可用。'
      errors.set(id, message)
      throw new Error(message)
    } finally {
      visiting.delete(id)
    }
  }
  for (const id of nodes.keys()) {
    try {
      resolve(id)
    } catch {
      /* Hide invalid geometry, preserve the dependency graph. */
    }
  }
  return { values, errors }
}
export function appendNodes(state: GeoboardState, nodes: BoardNode[]): GeoboardState {
  const next = { ...state, points: [...state.points], objects: [...state.objects] }
  for (const n of nodes) (pointKinds.has(n.kind) ? next.points : next.objects).push(n as never)
  assertGeoboard(next)
  return next
}
export function removeNodes(state: GeoboardState, ids: Iterable<string>): GeoboardState {
  const removed = new Set(ids),
    nodes = [...state.points, ...state.objects]
  let changed = true
  while (changed) {
    changed = false
    for (const n of nodes)
      if (!removed.has(n.id) && dependencies(n).some((d) => removed.has(d))) {
        removed.add(n.id)
        changed = true
      }
  }
  return {
    ...state,
    points: state.points.filter((n) => !removed.has(n.id)),
    objects: state.objects.filter((n) => !removed.has(n.id)),
  }
}
export function movePoint(state: GeoboardState, id: string, target: BoardVec): GeoboardState {
  if (!within(target)) throw new Error('坐标范围为 −10000 到 10000。')
  const p = state.points.find((n) => n.id === id)
  if (!p) throw new Error('找不到点。')
  let next: BoardPoint
  if (p.kind === 'free') {
    if (p.locked) throw new Error('该点已锁定。')
    next = { ...p, x: target.x, y: target.y }
  } else if (p.kind === 'on-object') {
    const r = solveGeoboard(state).values.get(p.object)
    if (r?.type === 'line') {
      let parameter = dot(sub(target, r.p), r.d)
      if (finite(r.max)) parameter = Math.max(0, Math.min(1, parameter / r.max))
      else parameter = Math.max(r.min, parameter)
      next = { ...p, parameter }
    } else if (r?.type === 'circle')
      next = { ...p, parameter: Math.atan2(target.y - r.center.y, target.x - r.center.x) }
    else throw new Error('依赖图形当前不可用。')
  } else throw new Error('派生点由构造决定；请拖动它的自由点。')
  return { ...state, points: state.points.map((n) => (n.id === id ? next : n)) }
}
export function snapPosition(p: BoardVec, view: GeoboardState['view']): BoardVec {
  const clean = (n: number) => (Math.abs(n) < 1e-10 ? 0 : Number(n.toFixed(8)))
  if (!view.snap || view.grid === 'none') return { x: clean(p.x), y: clean(p.y) }
  const s = view.step
  if (view.grid === 'square')
    return { x: clean(Math.round(p.x / s) * s), y: clean(Math.round(p.y / s) * s) }
  if (view.grid === 'isometric') {
    const row = p.y / ((s * Math.sqrt(3)) / 2),
      r0 = Math.round(row)
    let best = p,
      d = Infinity
    for (let r = r0 - 1; r <= r0 + 1; r++) {
      const c = Math.round(p.x / s - r / 2),
        candidate = { x: (c + r / 2) * s, y: (r * s * Math.sqrt(3)) / 2 }
      if (distance(candidate, p) < d) {
        best = candidate
        d = distance(candidate, p)
      }
    }
    return { x: clean(best.x), y: clean(best.y) }
  }
  const radius = Math.round(norm(p) / s) * s,
    angle = (Math.round(Math.atan2(p.y, p.x) / (Math.PI / 6)) * Math.PI) / 6
  return { x: clean(radius * Math.cos(angle)), y: clean(radius * Math.sin(angle)) }
}
export function polygonMetrics(ps: BoardVec[]): {
  area: number | null
  perimeter: number
  simple: boolean
} {
  let twice = 0,
    perimeter = 0,
    simple = true
  for (let i = 0; i < ps.length; i++) {
    const a = ps[i],
      b = ps[(i + 1) % ps.length]
    twice += cross(a, b)
    perimeter += distance(a, b)
    if (distance(a, b) < EPS) simple = false
    for (let j = i + 1; j < ps.length; j++) {
      if (j === i + 1 || (i === 0 && j === ps.length - 1)) continue
      const c = ps[j],
        d = ps[(j + 1) % ps.length],
        u = sub(b, a),
        v = sub(d, c)
      const det = cross(u, v),
        delta = sub(c, a)
      if (Math.abs(det) > EPS) {
        const t = cross(delta, v) / det,
          k = cross(delta, u) / det
        if (t >= -EPS && t <= 1 + EPS && k >= -EPS && k <= 1 + EPS) simple = false
      } else if (Math.abs(cross(delta, u)) < EPS) {
        const length2 = dot(u, u)
        if (length2 > EPS) {
          const t = dot(delta, u) / length2,
            k = dot(sub(d, a), u) / length2
          if (Math.max(Math.min(t, k), 0) <= Math.min(Math.max(t, k), 1) + EPS) simple = false
        }
      }
    }
  }
  return { area: simple ? Math.abs(twice) / 2 : null, perimeter, simple }
}
export function angleDegrees(a: BoardVec, vertex: BoardVec, b: BoardVec): number | null {
  const u = sub(a, vertex),
    v = sub(b, vertex),
    scale = norm(u) * norm(v)
  return scale < EPS
    ? null
    : (Math.acos(Math.min(1, Math.max(-1, dot(u, v) / scale))) * 180) / Math.PI
}
export function clipLine(
  line: ResolvedLine,
  bounds: { left: number; right: number; bottom: number; top: number },
): [BoardVec, BoardVec] | null {
  let lo = line.min,
    hi = line.max
  for (const [p, d, min, max] of [
    [line.p.x, line.d.x, bounds.left, bounds.right],
    [line.p.y, line.d.y, bounds.bottom, bounds.top],
  ]) {
    if (Math.abs(d) < EPS) {
      if (p < min || p > max) return null
      continue
    }
    const t0 = (min - p) / d,
      t1 = (max - p) / d
    lo = Math.max(lo, Math.min(t0, t1))
    hi = Math.min(hi, Math.max(t0, t1))
    if (lo > hi) return null
  }
  return finite(lo) && finite(hi)
    ? [add(line.p, mul(line.d, lo)), add(line.p, mul(line.d, hi))]
    : null
}
/** Duplicating a transformed shape is deliberately a snapshot, not a hidden live constraint. */
export function transformedCopy(
  state: GeoboardState,
  id: string,
  transform: {
    pivot: BoardVec
    dx: number
    dy: number
    angle: number
    scale: number
    reflect: boolean
  },
  uid: () => string,
): GeoboardState {
  const source = [...state.points, ...state.objects].find((n) => n.id === id),
    r = solveGeoboard(state).values.get(id)
  if (!source || !r) throw new Error('请选择一个当前有效的图形。')
  if (
    ![
      transform.dx,
      transform.dy,
      transform.angle,
      transform.scale,
      transform.pivot.x,
      transform.pivot.y,
    ].every(finite) ||
    transform.scale <= 0 ||
    transform.scale > 100
  )
    throw new Error('变换参数无效；比例应在 (0,100] 内。')
  const theta = (transform.angle * Math.PI) / 180,
    co = Math.cos(theta),
    si = Math.sin(theta)
  const map = (p: BoardVec): BoardVec => {
    const q = sub(p, transform.pivot),
      x = q.x * (transform.reflect ? -1 : 1) * transform.scale,
      y = q.y * transform.scale
    return {
      x: co * x - si * y + transform.pivot.x + transform.dx,
      y: si * x + co * y + transform.pivot.y + transform.dy,
    }
  }
  const nodes: BoardNode[] = []
  const p = (point: BoardVec) => {
    const id = uid(),
      q = map(point)
    nodes.push({ id, ...boardStyle('', source.color), kind: 'free', ...q, locked: false })
    return id
  }
  const base = {
    id: uid(),
    ...boardStyle(`${source.label || source.kind} 副本`, source.color),
    fill: source.fill,
  }
  if (r.type === 'point') p(r.p)
  else if (r.type === 'polygon') nodes.push({ ...base, kind: 'polygon', points: r.points.map(p) })
  else if (r.type === 'circle')
    nodes.push({
      ...base,
      kind: 'fixed-circle',
      center: p(r.center),
      radius: r.radius * transform.scale,
    })
  else if (r.type === 'line') {
    const kind = finite(r.max) ? 'segment' : finite(r.min) ? 'ray' : 'line'
    nodes.push({
      ...base,
      kind,
      from: p(r.p),
      to: p(add(r.p, mul(r.d, finite(r.max) ? r.max : 1))),
    })
  } else {
    const start = add(r.center, mul({ x: Math.cos(r.start), y: Math.sin(r.start) }, r.radius))
    const end = add(
      r.center,
      mul({ x: Math.cos(r.start + r.sweep), y: Math.sin(r.start + r.sweep) }, r.radius),
    )
    const center = p(r.center),
      a = p(start),
      b = p(end)
    nodes.push({
      ...base,
      kind: 'arc',
      center,
      start: transform.reflect ? b : a,
      end: transform.reflect ? a : b,
    })
  }
  return appendNodes(state, nodes)
}
export class BoardHistory {
  private past: GeoboardState[] = []
  private future: GeoboardState[] = []
  constructor(public present: GeoboardState) {}
  get canUndo(): boolean {
    return this.past.length > 0
  }
  get canRedo(): boolean {
    return this.future.length > 0
  }
  commit(next: GeoboardState): boolean {
    assertGeoboard(next)
    if (JSON.stringify(next) === JSON.stringify(this.present)) return false
    this.past = [...this.past.slice(-(BOARD_LIMITS.history - 1)), this.present]
    this.present = next
    this.future = []
    return true
  }
  undo(): GeoboardState {
    const previous = this.past.pop()
    if (previous) {
      this.future.push(this.present)
      this.present = previous
    }
    return this.present
  }
  redo(): GeoboardState {
    const next = this.future.pop()
    if (next) {
      this.past.push(this.present)
      this.present = next
    }
    return this.present
  }
  reset(next: GeoboardState): void {
    assertGeoboard(next)
    this.present = next
    this.past = []
    this.future = []
  }
}
