import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { PointerEvent } from 'react'
import type { MathWorkbenchState, GeoPoint } from '../shared/types'
import { emptyMathState } from '../shared/types'
import { angle, distance, parseFunctionExpression, sampleFunction } from '../domain/math'
import { canConnectPoints, removeDrawingPoint } from '../domain/coordinates'
import {
  DEFAULT_SNAP_STEP,
  DEFAULT_PROJECTION_COLOR,
  isValidSnapStep,
  nextSnapStep,
  clientToMathSvg,
  mathCoordinateFromSvg,
  mathTooltipPosition,
  axisDistances,
  placeProjectionLabels,
} from '../domain/math-canvas'
import './math.css'

type Tool = 'move' | 'point' | 'line' | 'measure'
const pixel = (p: { x: number; y: number }) => ({ x: 280 + p.x * 24, y: 280 - p.y * 24 })
const ticks = [-10, -8, -6, -4, -2, 0, 2, 4, 6, 8, 10]
function ParameterNumber({
  name,
  value,
  onChange,
}: {
  name: string
  value: number
  onChange: (value: number) => void
}) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  return (
    <input
      type="number"
      aria-label={`参数 ${name} 数值`}
      min="-10"
      max="10"
      step="0.1"
      value={text}
      onChange={(event) => {
        setText(event.target.value)
        const number = event.target.valueAsNumber
        if (Number.isFinite(number) && number >= -10 && number <= 10) onChange(number)
      }}
      onBlur={() => setText(String(value))}
    />
  )
}
export function MathWorkbench({
  value,
  onChange,
  disabled = false,
}: {
  value: MathWorkbenchState
  onChange: (v: MathWorkbenchState) => void
  disabled?: boolean
}) {
  const id = useId()
  const snapStep = value.snapStep ?? DEFAULT_SNAP_STEP
  const showProjections = value.showProjections ?? true
  const projectionColor = value.projectionColor ?? DEFAULT_PROJECTION_COLOR
  const [snapText, setSnapText] = useState(String(snapStep))
  useEffect(() => setSnapText(String(snapStep)), [snapStep])
  const [hover, setHover] = useState<{
    x: number
    y: number
    left: number
    top: number
    pointId?: string
    step: number
  } | null>(null)
  const canvasHovered = useRef(false)
  const [tool, setTool] = useState<Tool>('move')
  const [history, setHistory] = useState<MathWorkbenchState[]>([])
  const [selected, setSelected] = useState('')
  const [lineStart, setLineStart] = useState('')
  const [expression, setExpression] = useState(value.expression)
  const [message, setMessage] = useState('')
  const parsedExpression = useMemo(() => {
    if (!expression.trim()) return { normalizedExpression: '', error: '' }
    try {
      return {
        normalizedExpression: parseFunctionExpression(expression).normalizedExpression,
        error: '',
      }
    } catch (error) {
      return {
        normalizedExpression: '',
        error: error instanceof Error ? error.message : '函数无效',
      }
    }
  }, [expression])
  const [confirm, setConfirm] = useState(false)
  const [fields, setFields] = useState({ label: '', x: '0', y: '0' })
  const [from, setFrom] = useState(''),
    [to, setTo] = useState('')
  const [preview, setPreview] = useState<GeoPoint | null>(null)
  const drag = useRef<{
    id: string
    pointerId: number
    before: MathWorkbenchState
    moved: boolean
  } | null>(null)
  const suppressClick = useRef(false)
  const svg = useRef<SVGSVGElement>(null)
  const drawing = preview
    ? {
        ...value.drawing,
        points: value.drawing.points.map((p) => (p.id === preview.id ? preview : p)),
      }
    : value.drawing
  const curves = useMemo(
    () => sampleFunction(value.expression, value.parameters),
    [value.expression, value.parameters],
  )
  const measured = value.measurement
    .map((pid) => drawing.points.find((p) => p.id === pid))
    .filter((p): p is GeoPoint => Boolean(p))
  const degrees = measured.length === 3 ? angle(measured[0], measured[1], measured[2]) : null
  function commit(next: MathWorkbenchState) {
    if (disabled) return
    setHistory((h) => [...h.slice(-39), value])
    onChange(next)
    setMessage('')
  }
  function select(p: GeoPoint) {
    setSelected(p.id)
    setFields({ label: p.label, x: String(p.x), y: String(p.y) })
  }
  function clearSelection() {
    setSelected('')
    setLineStart('')
    setFrom('')
    setTo('')
    setFields({ label: '', x: '0', y: '0' })
  }
  function connect(a: string, b: string) {
    if (!canConnectPoints(value.drawing, a, b)) {
      setMessage('请选择两个不同的点，已有线段不重复添加。')
      return
    }
    if (value.drawing.lines.length >= 400) {
      setMessage('最多 400 条线段。')
      return
    }
    commit({
      ...value,
      drawing: {
        ...value.drawing,
        lines: [...value.drawing.lines, { id: crypto.randomUUID(), from: a, to: b }],
      },
    })
  }
  function choose(p: GeoPoint) {
    if (disabled) return
    select(p)
    if (tool === 'line') {
      if (lineStart) {
        connect(lineStart, p.id)
        setLineStart('')
      } else setLineStart(p.id)
    }
    if (tool === 'measure') {
      const ids = value.measurement.includes(p.id)
        ? value.measurement.filter((x) => x !== p.id)
        : [...value.measurement, p.id].slice(-3)
      commit({ ...value, measurement: ids })
    }
  }
  function nextPointLabel() {
    let n = 1
    while (value.drawing.points.some((point) => point.label === `P${n}`)) n++
    return `P${n}`
  }
  function add(x: number, y: number, label = '') {
    if (value.drawing.points.length >= 200) {
      setMessage('最多 200 个点。')
      return
    }
    const p = {
      id: crypto.randomUUID(),
      label: label.trim() || nextPointLabel(),
      x,
      y,
    }
    commit({ ...value, drawing: { ...value.drawing, points: [...value.drawing.points, p] } })
    select(p)
  }
  function coordinate(event: { clientX: number; clientY: number }, step = snapStep) {
    const canvas = svg.current
    if (!canvas) return null
    // Screen CTM handles CSS zoom/transforms and viewBox letterboxing exactly.
    const matrix = canvas.getScreenCTM()
    let point: { x: number; y: number } | null
    if (matrix) {
      const screen = canvas.createSVGPoint()
      screen.x = event.clientX
      screen.y = event.clientY
      try {
        point = screen.matrixTransform(matrix.inverse())
      } catch {
        return null
      }
    } else
      point = clientToMathSvg(
        { x: event.clientX, y: event.clientY },
        canvas.getBoundingClientRect(),
      )
    return point ? mathCoordinateFromSvg(point, step) : null
  }
  function updateHover(
    event: { clientX: number; clientY: number; target: EventTarget | null },
    step = snapStep,
  ) {
    const p = coordinate(event, step)
    if (!p?.inside || !svg.current) {
      setHover(null)
      return
    }
    const pointId =
      event.target instanceof Element
        ? (event.target.closest('[data-math-point-id]')?.getAttribute('data-math-point-id') ??
          undefined)
        : undefined
    const existing = drawing.points.find((point) => point.id === pointId)
    const rect = svg.current.getBoundingClientRect()
    const position = mathTooltipPosition(
      { x: event.clientX - rect.left, y: event.clientY - rect.top },
      rect,
      { width: 196, height: 132 },
    )
    setHover({ x: existing?.x ?? p.x, y: existing?.y ?? p.y, ...position, pointId, step })
  }
  function addFromCanvas(point: { x: number; y: number }) {
    const existing = value.drawing.points.find(
      (p) => Math.abs(p.x - point.x) < 1e-7 && Math.abs(p.y - point.y) < 1e-7,
    )
    if (existing) {
      select(existing)
      setMessage('当前吸附位置已有点，未重复添加。')
      return
    }
    add(point.x, point.y)
  }
  useEffect(() => {
    const canvas = svg.current
    if (!canvas || disabled) return
    function wheel(event: WheelEvent) {
      if (
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey ||
        !event.deltaY ||
        drag.current
      )
        return
      if (!coordinate(event)?.inside) return
      const next = nextSnapStep(snapStep, event.deltaY > 0 ? 'finer' : 'coarser')
      if (next === snapStep) return
      event.preventDefault()
      commit({ ...value, snapStep: next })
      updateHover(event, next)
    }
    // Non-passive only on this canvas: other page areas and browser zoom keep normal scrolling.
    canvas.addEventListener('wheel', wheel, { passive: false })
    return () => canvas.removeEventListener('wheel', wheel)
  }, [value, disabled, snapStep])
  useEffect(() => {
    if (disabled) return
    function keydown(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.key.toLowerCase() !== 'i' ||
        event.repeat ||
        event.isComposing ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey
      )
        return
      if (
        event.target instanceof Element &&
        event.target.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
        )
      )
        return
      if (!canvasHovered.current && !svg.current?.contains(document.activeElement)) return
      event.preventDefault()
      commit({ ...value, showProjections: !showProjections })
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [value, disabled, showProjections])
  const projectionPoints = [
    ...(hover ? [{ id: 'hover', x: hover.x, y: hover.y }] : []),
    ...drawing.points
      .filter((point) => point.id === selected)
      .map((point) => ({ ...point, id: `point-${point.id}` })),
    ...drawing.points
      .filter((point) => point.id !== selected)
      .map((point) => ({ ...point, id: `point-${point.id}` })),
  ].filter(
    (point, index, all) => all.findIndex((p) => p.x === point.x && p.y === point.y) === index,
  )
  const projectionLabels = showProjections ? placeProjectionLabels(projectionPoints) : []
  function cancelDrag() {
    const d = drag.current
    drag.current = null
    setPreview(null)
    setHover(null)
    suppressClick.current = false
    if (d && svg.current?.hasPointerCapture(d.pointerId))
      svg.current.releasePointerCapture(d.pointerId)
  }
  useEffect(() => {
    const d = drag.current
    if (d && (disabled || !value.drawing.points.some((point) => point.id === d.id))) cancelDrag()
  }, [value.drawing, disabled])
  useEffect(() => {
    if (!hover) return
    const point = hover.pointId
      ? value.drawing.points.find((p) => p.id === hover.pointId)
      : undefined
    if (
      hover.step !== snapStep ||
      (hover.pointId && (!point || point.x !== hover.x || point.y !== hover.y))
    )
      setHover(null)
  }, [hover, snapStep, value.drawing])
  function endDrag(event: PointerEvent<SVGSVGElement>, cancel = false) {
    const d = drag.current
    if (!d || d.pointerId !== event.pointerId) return
    drag.current = null
    if (!cancel && d.moved) {
      const p = coordinate(event)
      const current = value.drawing.points.find((point) => point.id === d.id)
      if (p && current) {
        const point = { ...current, x: p.x, y: p.y }
        commit({
          ...value,
          drawing: {
            ...value.drawing,
            points: value.drawing.points.map((q) => (q.id === d.id ? point : q)),
          },
        })
        select(point)
      }
    }
    setPreview(null)
    suppressClick.current = !cancel && d.moved
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
  }
  return (
    <section className="math-workbench" aria-labelledby={`${id}-title`}>
      <div className="math-heading">
        <div>
          <span className="eyebrow">EXPLORE · 2D</span>
          <h3 id={`${id}-title`}>数学交互工作台</h3>
          <p>拖动、观察、验证，再写下你的推导。</p>
        </div>
        <span>
          {drawing.points.length} 个点 · {drawing.lines.length} 条线
        </span>
      </div>
      <div className="math-toolbar" role="group" aria-label="数学工具">
        {(
          [
            ['move', '移动点'],
            ['point', '描点'],
            ['line', '连线'],
            ['measure', '测量'],
          ] as const
        ).map(([key, label]) => (
          <button
            type="button"
            key={key}
            disabled={disabled}
            aria-pressed={tool === key}
            onClick={() => {
              setTool(key)
              setLineStart('')
            }}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          disabled={disabled || !history.length}
          onClick={() => {
            cancelDrag()
            const previous = history.at(-1)!
            setHistory(history.slice(0, -1))
            onChange(previous)
            setExpression(previous.expression)
            clearSelection()
            setConfirm(false)
            setMessage('已撤销。')
          }}
        >
          撤销
        </button>
        <button type="button" disabled={disabled} onClick={() => setConfirm(true)}>
          重置工具
        </button>
      </div>
      {confirm && (
        <div role="alert" className="math-confirm">
          清除点、线、测量和函数设置？可以撤销。
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              cancelDrag()
              const next = emptyMathState()
              commit(next)
              setExpression(next.expression)
              clearSelection()
              setConfirm(false)
            }}
          >
            确认重置
          </button>
          <button type="button" onClick={() => setConfirm(false)}>
            取消
          </button>
        </div>
      )}
      <div className="math-layout">
        <div>
          <div className="math-canvas-frame">
            <svg
              ref={svg}
              className={`math-canvas tool-${tool}`}
              viewBox="0 0 560 560"
              aria-label="数学等比例坐标图"
              aria-describedby={`${id}-canvas-help`}
              tabIndex={disabled ? -1 : 0}
              onPointerEnter={() => {
                canvasHovered.current = true
              }}
              onPointerLeave={() => {
                canvasHovered.current = false
                setHover(null)
              }}
              onContextMenu={(event) => {
                const p = coordinate(event)
                if (disabled || !p?.inside) return
                event.preventDefault()
                if (
                  drag.current ||
                  (event.target instanceof Element && event.target.closest('[data-math-point-id]'))
                )
                  return
                addFromCanvas(p)
              }}
              onClick={(event) => {
                if (suppressClick.current) {
                  suppressClick.current = false
                  return
                }
                if (!disabled && tool === 'point' && event.button === 0) {
                  const p = coordinate(event)
                  if (p?.inside) addFromCanvas(p)
                }
              }}
              onPointerMove={(event) => {
                if (event.pointerType !== 'touch') updateHover(event)
                const d = drag.current
                if (!d || d.pointerId !== event.pointerId || disabled) return
                const p = coordinate(event)
                if (!p) return
                d.moved = true
                const original = d.before.drawing.points.find((q) => q.id === d.id)!
                setPreview({ ...original, x: p.x, y: p.y })
              }}
              onPointerUp={(event) => {
                if (event.button === 0) endDrag(event)
              }}
              onPointerCancel={(event) => endDrag(event, true)}
              onLostPointerCapture={() => {
                drag.current = null
                setPreview(null)
              }}
            >
              <title>横纵轴等比例，范围 −10 到 10；函数图是数值采样示意</title>
              <defs>
                <clipPath id={`${id}-clip`}>
                  <rect x="40" y="40" width="480" height="480" />
                </clipPath>
              </defs>
              <rect width="560" height="560" fill="#fbfdfd" />
              {ticks.map((n) => (
                <g key={n}>
                  <line
                    x1={40}
                    x2={520}
                    y1={280 - n * 24}
                    y2={280 - n * 24}
                    stroke={n === 0 ? '#77949a' : '#e1ebeb'}
                  />
                  <line
                    y1={40}
                    y2={520}
                    x1={280 + n * 24}
                    x2={280 + n * 24}
                    stroke={n === 0 ? '#77949a' : '#e1ebeb'}
                  />
                  <text x={280 + n * 24} y="540" textAnchor="middle">
                    {n}
                  </text>
                  <text x="24" y={284 - n * 24} textAnchor="middle">
                    {n}
                  </text>
                </g>
              ))}
              <g clipPath={`url(#${id}-clip)`} pointerEvents="none">
                {curves.map((segment, i) => (
                  <polyline
                    data-testid="function-curve"
                    key={i}
                    fill="none"
                    stroke="#7957bc"
                    strokeWidth="2.5"
                    points={segment
                      .map((p) => {
                        const q = pixel(p)
                        return `${q.x},${q.y}`
                      })
                      .join(' ')}
                  />
                ))}
                {drawing.lines.map((l) => {
                  const a = drawing.points.find((p) => p.id === l.from)!,
                    b = drawing.points.find((p) => p.id === l.to)!
                  const p = pixel(a),
                    q = pixel(b)
                  return (
                    <line
                      key={l.id}
                      x1={p.x}
                      y1={p.y}
                      x2={q.x}
                      y2={q.y}
                      stroke="#167d86"
                      strokeWidth="2.5"
                    />
                  )
                })}
                {measured.length >= 2 && (
                  <polyline
                    points={measured
                      .map((p) => {
                        const q = pixel(p)
                        return `${q.x},${q.y}`
                      })
                      .join(' ')}
                    fill="none"
                    stroke="#d78a31"
                    strokeDasharray="5 4"
                    strokeWidth="2"
                  />
                )}
              </g>
              {showProjections && (
                <g
                  className="math-projections"
                  pointerEvents="none"
                  clipPath={`url(#${id}-clip)`}
                  aria-hidden="true"
                >
                  {projectionPoints.map((point) => {
                    const p = pixel(point)
                    return (
                      <g key={point.id}>
                        <line
                          data-testid="math-projection-x"
                          x1={p.x}
                          y1={p.y}
                          x2={p.x}
                          y2={280}
                          stroke={projectionColor}
                          strokeWidth="1.25"
                          strokeDasharray="4 4"
                        />
                        <line
                          data-testid="math-projection-y"
                          x1={p.x}
                          y1={p.y}
                          x2={280}
                          y2={p.y}
                          stroke={projectionColor}
                          strokeWidth="1.25"
                          strokeDasharray="4 4"
                        />
                      </g>
                    )
                  })}
                  {projectionLabels.map((label) => (
                    <text key={label.id} x={label.x} y={label.y} className="math-projection-label">
                      {label.text}
                    </text>
                  ))}
                </g>
              )}
              {drawing.points.map((p) => {
                const q = pixel(p)
                return (
                  <g key={p.id} data-math-point-id={p.id}>
                    <circle
                      cx={q.x}
                      cy={q.y}
                      r="8"
                      fill={
                        value.measurement.includes(p.id)
                          ? '#d78a31'
                          : selected === p.id
                            ? '#7957bc'
                            : '#167d86'
                      }
                      stroke="white"
                      strokeWidth="2"
                      role="button"
                      aria-label={`数学点 ${p.label} (${p.x}, ${p.y})`}
                      aria-disabled={disabled}
                      tabIndex={disabled ? -1 : 0}
                      onClick={(event) => {
                        event.stopPropagation()
                        if (suppressClick.current) {
                          suppressClick.current = false
                          return
                        }
                        choose(p)
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          choose(p)
                        }
                      }}
                      onPointerDown={(event) => {
                        if (
                          disabled ||
                          tool !== 'move' ||
                          drag.current ||
                          !event.isPrimary ||
                          event.button !== 0
                        )
                          return
                        event.preventDefault()
                        select(p)
                        drag.current = {
                          id: p.id,
                          pointerId: event.pointerId,
                          before: value,
                          moved: false,
                        }
                        svg.current!.setPointerCapture(event.pointerId)
                      }}
                    />
                    <text
                      x={q.x + (p.x > 8 ? -12 : 12)}
                      y={q.y + (p.y > 8 ? 20 : -12)}
                      textAnchor={p.x > 8 ? 'end' : 'start'}
                      pointerEvents="none"
                    >
                      {p.label}
                    </text>
                  </g>
                )
              })}
            </svg>
            {hover && (
              <div
                className="math-coordinate-tooltip"
                data-testid="math-coordinate-tooltip"
                aria-hidden="true"
                style={{ left: hover.left, top: hover.top }}
              >
                <strong>
                  {hover.pointId ? '已标记点' : '吸附坐标'} · 步长 {snapStep}
                </strong>
                <span>
                  x = {Number(hover.x.toFixed(6))}，y = {Number(hover.y.toFixed(6))}
                </span>
                {showProjections && (
                  <span>
                    到 x 轴 {Number(axisDistances(hover).toXAxis.toFixed(6))} · 到 y 轴{' '}
                    {Number(axisDistances(hover).toYAxis.toFixed(6))}
                  </span>
                )}
                <span>{hover.pointId ? '拖动或精确输入可修改' : '右键建点 · 滚轮调整步长'}</span>
              </div>
            )}
          </div>
          <p className="math-help" id={`${id}-canvas-help`}>
            {tool === 'move'
              ? '拖动点调整位置，也可用坐标输入精确编辑。'
              : tool === 'point'
                ? '点击网格添加点。'
                : tool === 'line'
                  ? `依次选两个点连线。${lineStart ? '已选起点。' : ''}`
                  : '按顺序选择 2 点测距、3 点测角；第 2 点为顶点，再选一次取消。'}{' '}
            横纵轴等比例，角度单位为度。右键网格可添加吸附点；滚轮向下变精细、向上变粗。
            画布悬停或聚焦时按 I 切换轴距投影；重叠标签自动避让，悬停或选中的点优先显示。
          </p>
        </div>
        <div className="math-controls">
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (parsedExpression.error) {
                setMessage(parsedExpression.error)
                return
              }
              const normalized = parsedExpression.normalizedExpression
              commit({ ...value, expression: normalized })
              setExpression(normalized)
              setMessage(normalized ? '函数已应用并保存。' : '函数已清除并保存。')
            }}
          >
            <label htmlFor={`${id}-expression`}>函数 y =</label>
            <input
              id={`${id}-expression`}
              aria-label="函数表达式"
              value={expression}
              maxLength={160}
              disabled={disabled}
              placeholder="y = 2x 或 a(x+1)^2"
              aria-invalid={Boolean(parsedExpression.error)}
              aria-describedby={`${id}-expression-preview ${id}-expression-help`}
              onChange={(e) => {
                setExpression(e.target.value)
                setMessage('')
              }}
            />
            <p
              id={`${id}-expression-preview`}
              className={`math-expression-preview${parsedExpression.error ? ' is-invalid' : ''}`}
              aria-live="polite"
            >
              {parsedExpression.error
                ? `暂无法解析：${parsedExpression.error}`
                : parsedExpression.normalizedExpression
                  ? `识别为：y = ${parsedExpression.normalizedExpression}`
                  : '留空后应用可清除函数，保留几何图形。'}
            </p>
            <button type="submit" disabled={disabled}>
              应用函数
            </button>
            <button
              type="button"
              disabled={disabled || !value.expression}
              onClick={() => {
                setExpression('')
                commit({ ...value, expression: '' })
              }}
            >
              清除函数
            </button>
            <p className="math-help" aria-live="polite">
              当前已保存：{value.expression || '无函数'}
              {expression.trim() !== value.expression
                ? ' · 输入尚未应用，提交仍使用已保存函数。'
                : ''}
            </p>
            <p className="math-help" id={`${id}-expression-help`}>
              可带 y=，支持 2x、ax、2(x+1)、(x+1)(x-1)，也可用 *、×、·、⋅ 表示乘法。
              先核对识别结果，点击应用才会保存。幂写 ^；函数必须加括号，sin / cos / tan 用弧度。
              可用 sqrt、abs、exp、log（自然对数）、pi、e。除法请写清范围，例如 1/(2x) 或
              (1/2)x。支持一个函数，显示范围 ±10。
            </p>
            <div className="math-examples">
              {['a*x^2+b*x+c', 'a*sin(b*x)+c', 'a/(x-b)+c'].map((e) => (
                <button
                  type="button"
                  key={e}
                  disabled={disabled}
                  onClick={() => {
                    setExpression(e)
                    commit({ ...value, expression: e })
                  }}
                >
                  {e}
                </button>
              ))}
            </div>
          </form>
          <fieldset disabled={disabled} className="math-canvas-settings">
            <legend>画布设置</legend>
            <label htmlFor={`${id}-snap`}>坐标吸附步长</label>
            <div className="math-snap-input">
              <input
                id={`${id}-snap`}
                aria-label="坐标吸附步长"
                type="number"
                min="0.01"
                max="10"
                step="any"
                value={snapText}
                onChange={(event) => setSnapText(event.target.value)}
              />
              <button
                type="button"
                onClick={() => {
                  const step = Number(snapText)
                  if (!snapText.trim() || !isValidSnapStep(step)) {
                    setMessage('吸附步长须为 0.01 到 10 的有限数，最多 6 位小数。')
                    return
                  }
                  commit({ ...value, snapStep: Math.round(step * 1_000_000) / 1_000_000 })
                  setHover(null)
                  setMessage('吸附步长已保存；现有点保持原坐标。')
                }}
              >
                应用步长
              </button>
            </div>
            <p className="math-help">
              当前 {snapStep}；自定义范围 0.01–10，最多 6 位小数。滚轮档位 1 → 0.5 → 0.25，再每次
              0.01，最低 0.01。新建和拖动会吸附；精确输入不受影响，修改步长不移动已有点。
            </p>
            <label className="math-projection-toggle">
              <input
                type="checkbox"
                checked={showProjections}
                onChange={(event) => commit({ ...value, showProjections: event.target.checked })}
              />
              显示轴距投影（I）
            </label>
            <label className="math-projection-color">
              投影线颜色
              <input
                type="color"
                aria-label="投影线颜色"
                value={projectionColor}
                onChange={(event) => commit({ ...value, projectionColor: event.target.value })}
              />
            </label>
          </fieldset>
          <fieldset disabled={disabled}>
            <legend>函数参数</legend>
            {(['a', 'b', 'c'] as const).map((key) => (
              <label className="math-parameter" key={key}>
                {key}
                <input
                  type="range"
                  aria-label={`参数 ${key} 滑块`}
                  min="-10"
                  max="10"
                  step="0.1"
                  value={value.parameters[key]}
                  onChange={(e) =>
                    commit({
                      ...value,
                      parameters: { ...value.parameters, [key]: Number(e.target.value) },
                    })
                  }
                />
                <ParameterNumber
                  name={key}
                  value={value.parameters[key]}
                  onChange={(number) =>
                    commit({ ...value, parameters: { ...value.parameters, [key]: number } })
                  }
                />
              </label>
            ))}
          </fieldset>
          <div className="math-measure" aria-live="polite">
            <strong>测量结果</strong>
            <p>
              {measured.length === 2
                ? `距离 ${measured.map((p) => p.label).join(' → ')} = ${distance(measured[0], measured[1]).toFixed(3)}`
                : measured.length === 3
                  ? `∠${measured.map((p) => p.label).join('')} = ${degrees === null ? '无法测量（重合点）' : `${degrees.toFixed(2)}°`}`
                  : '选择 2 个点测距，或 3 个点测角。'}
            </p>
            <p className="math-help">
              顺序：{measured.map((p) => p.label).join(' → ') || '尚未选择'}
              ；测量来自坐标，不是图上像素。
            </p>
            <button
              type="button"
              disabled={disabled || !value.measurement.length}
              onClick={() => commit({ ...value, measurement: [] })}
            >
              清除测量
            </button>
          </div>
        </div>
      </div>
      <fieldset className="math-editors" disabled={disabled}>
        <legend>精确操作（支持键盘）</legend>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            const x = Number(fields.x),
              y = Number(fields.y)
            if (
              !fields.x.trim() ||
              !fields.y.trim() ||
              !Number.isFinite(x) ||
              !Number.isFinite(y) ||
              Math.abs(x) > 10 ||
              Math.abs(y) > 10
            ) {
              setMessage('坐标须为 −10 到 10 的有限数值。')
              return
            }
            if (selected) {
              commit({
                ...value,
                drawing: {
                  ...value.drawing,
                  points: value.drawing.points.map((p) =>
                    p.id === selected ? { ...p, x, y, label: fields.label.trim() || p.label } : p,
                  ),
                },
              })
            } else add(x, y, fields.label)
          }}
        >
          <label>
            点标记
            <input
              aria-label="数学点标记"
              maxLength={80}
              value={fields.label}
              onChange={(e) => setFields({ ...fields, label: e.target.value })}
            />
          </label>
          {(['x', 'y'] as const).map((key) => (
            <label key={key}>
              {key.toUpperCase()}
              <input
                type="number"
                aria-label={`数学 ${key.toUpperCase()} 坐标`}
                min="-10"
                max="10"
                step="any"
                required
                value={fields[key]}
                onChange={(e) => setFields({ ...fields, [key]: e.target.value })}
              />
            </label>
          ))}
          <button type="submit">{selected ? '更新数学点' : '添加数学点'}</button>
          {selected && (
            <>
              <button type="button" onClick={clearSelection}>
                新建数学点
              </button>
              <button
                type="button"
                onClick={() => {
                  commit({
                    ...value,
                    drawing: removeDrawingPoint(value.drawing, selected),
                    measurement: value.measurement.filter((x) => x !== selected),
                  })
                  clearSelection()
                }}
              >
                删除数学点及关联线
              </button>
            </>
          )}
        </form>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            connect(from, to)
          }}
        >
          {(
            [
              ['起点', from, setFrom],
              ['终点', to, setTo],
            ] as const
          ).map(([label, v, set]) => (
            <label key={label}>
              {label}
              <select
                aria-label={`数学连线${label}`}
                value={v}
                onChange={(e) => set(e.target.value)}
              >
                <option value="">请选择</option>
                {drawing.points.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label} ({p.x}, {p.y})
                  </option>
                ))}
              </select>
            </label>
          ))}
          <button type="submit" disabled={disabled || !from || !to}>
            添加数学线段
          </button>
        </form>
      </fieldset>
      <div className="math-point-list" aria-label="数学点列表">
        {drawing.points.map((p) => (
          <button
            type="button"
            key={p.id}
            disabled={disabled}
            aria-pressed={tool === 'measure' ? value.measurement.includes(p.id) : selected === p.id}
            onClick={() => choose(p)}
          >
            {p.label} ({p.x}, {p.y})
          </button>
        ))}
      </div>
      {drawing.lines.length > 0 && (
        <div className="math-point-list" aria-label="数学线段列表">
          {drawing.lines.map((l) => (
            <button
              type="button"
              disabled={disabled}
              key={l.id}
              onClick={() =>
                commit({
                  ...value,
                  drawing: {
                    ...value.drawing,
                    lines: value.drawing.lines.filter((x) => x.id !== l.id),
                  },
                })
              }
            >
              删除线段 {drawing.points.find((p) => p.id === l.from)?.label}—
              {drawing.points.find((p) => p.id === l.to)?.label}
            </button>
          ))}
        </div>
      )}
      <p role="status" className="math-status">
        {message}
      </p>
      <p className="math-help">
        原创交互演示：试着改变 a，观察抛物线开口；放置 A(0,0)、B(3,0)、C(3,4)，测量
        AB、∠ABC。图像仅为有限采样，不证明连续性、定义域或结论；请保留文字推导。
      </p>
    </section>
  )
}
