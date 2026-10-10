import type { MathParameters } from '../shared/types'

export interface MathPoint {
  x: number
  y: number
}
export type ExpressionEvaluator = (x: number, parameters?: MathParameters) => number
export const DEFAULT_PARAMETERS: MathParameters = { a: 1, b: 0, c: 0 }
const functions: Record<string, (value: number) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  sqrt: Math.sqrt,
  abs: Math.abs,
  exp: Math.exp,
  log: Math.log,
}
type Node = (x: number, parameters: MathParameters) => number

/** A small arithmetic grammar: no JavaScript evaluation, properties or implicit multiplication. */
export function parseExpression(source: string): ExpressionEvaluator {
  if (!source.trim()) throw new Error('请输入函数表达式')
  if (source.length > 160) throw new Error('表达式最多 160 个字符')
  const tokens: string[] = []
  let offset = 0
  while (offset < source.length) {
    const rest = source.slice(offset)
    const match = /^(?:\s+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z]+|[+\-*/^()])/.exec(
      rest,
    )
    if (!match) throw new Error(`不支持的字符：${source[offset]}`)
    offset += match[0].length
    if (!match[0].trim()) continue
    tokens.push(match[0])
    if (tokens.length > 120) throw new Error('表达式过于复杂（最多 120 个符号）')
  }
  let position = 0
  let depth = 0
  const peek = () => tokens[position]
  const take = (token: string) => peek() === token && ++position > 0
  function nested(build: () => Node): Node {
    if (++depth > 32) throw new Error('表达式嵌套过深（最多 32 层）')
    const node = build()
    depth--
    return node
  }
  function primary(): Node {
    const token = tokens[position++]
    if (token === undefined) throw new Error('表达式不完整')
    if (token === '(') {
      const value = nested(sum)
      if (!take(')')) throw new Error('缺少右括号 )')
      return value
    }
    if (/^(?:\d|\.)/.test(token)) {
      const value = Number(token)
      if (!Number.isFinite(value)) throw new Error('数字必须是有限值')
      return () => value
    }
    if (token === 'x') return (x) => x
    if (token === 'a' || token === 'b' || token === 'c') return (_, parameters) => parameters[token]
    if (token === 'pi') return () => Math.PI
    if (token === 'e') return () => Math.E
    if (Object.hasOwn(functions, token)) {
      if (!take('(')) throw new Error(`${token} 需要括号，例如 ${token}(x)`)
      const argument = nested(sum)
      if (!take(')')) throw new Error('缺少右括号 )')
      return (x, parameters) => functions[token](argument(x, parameters))
    }
    throw new Error(`不支持的符号：${token}`)
  }
  function power(): Node {
    const left = primary()
    if (!take('^')) return left
    const right = nested(unary)
    return (x, parameters) => left(x, parameters) ** right(x, parameters)
  }
  function unary(): Node {
    if (take('+')) return nested(unary)
    if (take('-')) {
      const value = nested(unary)
      return (x, parameters) => -value(x, parameters)
    }
    return power()
  }
  function product(): Node {
    let left = unary()
    while (peek() === '*' || peek() === '/') {
      const operator = tokens[position++]
      const previous = left
      const right = unary()
      left =
        operator === '*'
          ? (x, parameters) => previous(x, parameters) * right(x, parameters)
          : (x, parameters) => previous(x, parameters) / right(x, parameters)
    }
    return left
  }
  function sum(): Node {
    let left = product()
    while (peek() === '+' || peek() === '-') {
      const operator = tokens[position++]
      const previous = left
      const right = product()
      left =
        operator === '+'
          ? (x, parameters) => previous(x, parameters) + right(x, parameters)
          : (x, parameters) => previous(x, parameters) - right(x, parameters)
    }
    return left
  }
  const root = sum()
  if (position !== tokens.length) throw new Error(`意外的符号：${peek()}（乘法请使用 *）`)
  return (x, parameters = DEFAULT_PARAMETERS) => {
    if (!Number.isFinite(x)) return NaN
    if (Object.values(parameters).some((value) => !Number.isFinite(value) || Math.abs(value) > 10))
      throw new Error('参数必须在 -10 到 10 之间')
    return root(x, parameters)
  }
}

/** Viewport-space segments; never connect across invalid samples or suspected poles. */
export function sampleFunction(
  expression: string | ExpressionEvaluator,
  parameters: MathParameters = DEFAULT_PARAMETERS,
): MathPoint[][] {
  if (typeof expression === 'string' && !expression.trim()) return []
  const evaluate = typeof expression === 'string' ? parseExpression(expression) : expression
  const segments: MathPoint[][] = []
  let segment: MathPoint[] = []
  const visible = (y: number) => Number.isFinite(y) && Math.abs(y) <= 10
  const flush = () => {
    if (segment.length > 1) segments.push(segment)
    segment = []
  }
  const steps = 800
  for (let index = 0; index <= steps; index++) {
    const point = { x: -10 + (20 * index) / steps, y: 0 }
    point.y = evaluate(point.x, parameters)
    if (!visible(point.y)) {
      flush()
      continue
    }
    const previous = segment.at(-1)
    if (previous) {
      let continuous = Math.abs(point.y - previous.y) <= 2
      // Interior probes also catch holes/poles missed by the endpoints.
      for (const fraction of [0.25, 0.5, 0.75]) {
        const y = evaluate(previous.x + (point.x - previous.x) * fraction, parameters)
        const linear = previous.y + (point.y - previous.y) * fraction
        if (!visible(y) || Math.abs(y - linear) > 0.2) continuous = false
      }
      if (!continuous) flush()
    }
    segment.push(point)
  }
  flush()
  return segments
}

export function distance(a: MathPoint, b: MathPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** The second point is the vertex; coincident points have no defined angle. */
export function angle(a: MathPoint, vertex: MathPoint, b: MathPoint): number | null {
  const ax = a.x - vertex.x,
    ay = a.y - vertex.y
  const bx = b.x - vertex.x,
    by = b.y - vertex.y
  const denominator = Math.hypot(ax, ay) * Math.hypot(bx, by)
  if (!Number.isFinite(denominator) || denominator === 0) return null
  const cosine = (ax * bx + ay * by) / denominator
  return (Math.acos(Math.max(-1, Math.min(1, cosine))) * 180) / Math.PI
}
