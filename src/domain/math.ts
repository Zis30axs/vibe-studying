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

export interface ParsedExpression {
  normalizedExpression: string
  evaluate: ExpressionEvaluator
}
type Token = {
  value: string
  kind: 'number' | 'symbol' | 'function' | 'operator'
  implicit?: boolean
}
const symbols = new Set(['x', 'a', 'b', 'c', 'pi', 'e'])

/** Tokenize before inserting multiplication: never split arbitrary names or join separated digits. */
function expressionTokens(source: string): Token[] {
  if (!source.trim()) throw new Error('请输入函数表达式')
  if (source.length > 160) throw new Error('表达式最多 160 个字符')
  const input = source
    .replace(/^\s*y\s*=\s*/, '')
    .replace(/[×·⋅]/g, '*')
    .replace(/÷/g, '/')
    .replace(/−/g, '-')
  if (!input.trim()) throw new Error('y = 后请输入函数表达式')
  const tokens: Token[] = []
  function append(token: Token) {
    const previous = tokens.at(-1)
    const endsFactor =
      previous &&
      (previous.kind === 'number' || previous.kind === 'symbol' || previous.value === ')')
    const startsFactor = token.kind !== 'operator' || token.value === '('
    if (endsFactor && startsFactor) {
      // A numeric suffix may be a typo or subscript; two numeric literals must not be glued together.
      if (token.kind === 'number' && previous.value !== ')')
        throw new Error(`「${previous.value} ${token.value}」含义不明确；相乘请写 *`)
      tokens.push({ value: '*', kind: 'operator', implicit: true })
    }
    tokens.push(token)
    if (tokens.length > 120) throw new Error('表达式过于复杂（最多 120 个符号，含补全的乘号）')
  }
  let offset = 0
  while (offset < input.length) {
    const match = /^(?:\s+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z]+|[+\-*/^()])/.exec(
      input.slice(offset),
    )
    if (!match) {
      if (input[offset] === '=') throw new Error('只支持开头的 y =，不能输入其他等式或赋值')
      throw new Error(`不支持的字符：${input[offset]}`)
    }
    const value = match[0]
    offset += value.length
    if (!value.trim()) continue
    if (/^(?:\d|\.)/.test(value)) append({ value, kind: 'number' })
    else if (/^[A-Za-z]/.test(value)) {
      if (Object.hasOwn(functions, value)) append({ value, kind: 'function' })
      else if (symbols.has(value)) append({ value, kind: 'symbol' })
      // These are the only single-letter variables. Preserve full function/constant names above.
      else if (/^[abcx]+$/.test(value)) {
        for (const letter of value) append({ value: letter, kind: 'symbol' })
      } else {
        const name = Object.keys(functions).find((name) => value.startsWith(name))
        if (name) throw new Error(`${name} 需要括号，例如 ${name}(x)；相乘请写 *`)
        throw new Error(`不支持的符号：${value}；变量仅支持 x、a、b、c，常量为 pi、e`)
      }
    } else append({ value, kind: 'operator' })
  }
  // Canonical output is also persisted and must remain valid under the same bounds on reloading.
  if (tokens.map((token) => token.value).join('').length > 160)
    throw new Error('补全乘号后的表达式最多 160 个字符，请缩短输入')
  return tokens
}

/** A bounded arithmetic grammar; no JavaScript evaluation, properties or guessed function names. */
export function parseFunctionExpression(source: string): ParsedExpression {
  const tokens = expressionTokens(source)
  let position = 0
  let depth = 0
  const peek = () => tokens[position]?.value
  const take = (token: string) => peek() === token && ++position > 0
  function nested(build: () => Node): Node {
    if (++depth > 32) throw new Error('表达式嵌套过深（最多 32 层）')
    const node = build()
    depth--
    return node
  }
  function primary(): Node {
    const token = tokens[position++]?.value
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
      const operator = tokens[position++].value
      const previous = left
      const right = unary()
      if (operator === '/' && tokens[position]?.implicit)
        throw new Error('除号后的省略乘法含义不明确：请用 1/(2*x) 或 (1/2)*x 这样的括号明确范围')
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
      const operator = tokens[position++].value
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
  const evaluate: ExpressionEvaluator = (x, parameters = DEFAULT_PARAMETERS) => {
    if (!Number.isFinite(x)) return NaN
    if (Object.values(parameters).some((value) => !Number.isFinite(value) || Math.abs(value) > 10))
      throw new Error('参数必须在 -10 到 10 之间')
    return root(x, parameters)
  }
  return { normalizedExpression: tokens.map((token) => token.value).join(''), evaluate }
}

/** Compatibility entry point for sampling and persisted-state validation. */
export function parseExpression(source: string): ExpressionEvaluator {
  return parseFunctionExpression(source).evaluate
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
