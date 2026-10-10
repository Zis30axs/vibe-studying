import { useId, useState } from 'react'
import type { FormEvent, MouseEvent } from 'react'
import type { GeoDrawing, GeoPoint } from '../shared/types'
import {
  CANVAS,
  canConnectPoints,
  clientToCoordinate,
  coordinateBounds,
  coordinateToSvg,
  isValidCoordinate,
  removeDrawingPoint,
} from '../domain/coordinates'
import './geography.css'

interface Props {
  drawing: GeoDrawing
  onChange: (drawing: GeoDrawing) => void
  disabled?: boolean
}
type Tool = 'point' | 'line' | 'select'

export function GeographyWorkbench({ drawing, onChange, disabled = false }: Props) {
  const titleId = useId()
  const hintId = useId()
  const [tool, setTool] = useState<Tool>('point')
  const [history, setHistory] = useState<GeoDrawing[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [lineStart, setLineStart] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [x, setX] = useState('0')
  const [y, setY] = useState('0')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [message, setMessage] = useState('')
  const [confirm, setConfirm] = useState<'mode' | 'clear' | null>(null)
  const bounds = coordinateBounds(drawing.mode)
  const geographic = drawing.mode === 'geographic'
  const selected = drawing.points.find((point) => point.id === selectedId)
  const xTicks = geographic
    ? [-180, -120, -60, 0, 60, 120, 180]
    : [-10, -8, -6, -4, -2, 0, 2, 4, 6, 8, 10]
  const yTicks = geographic
    ? [-90, -60, -30, 0, 30, 60, 90]
    : [-10, -8, -6, -4, -2, 0, 2, 4, 6, 8, 10]

  function commit(next: GeoDrawing) {
    if (disabled) return
    setHistory((previous) => [...previous.slice(-39), drawing])
    onChange(next)
    setMessage('')
  }

  function resetSelection() {
    setSelectedId(null)
    setLineStart(null)
    setLabel('')
    setX('0')
    setY('0')
  }

  function choosePoint(point: GeoPoint) {
    if (disabled) return
    setSelectedId(point.id)
    setLabel(point.label)
    setX(String(point.x))
    setY(String(point.y))
    if (tool === 'line') {
      if (lineStart) {
        connect(lineStart, point.id)
        setLineStart(null)
      } else {
        setLineStart(point.id)
        setMessage(`已选起点 ${point.label}，请选择另一个点。`)
      }
    }
  }

  function addPoint(point: { x: number; y: number }, pointLabel = '') {
    if (drawing.points.length >= 200) {
      setMessage('最多可绘制 200 个点，请先删除不需要的点。')
      return
    }
    let number = drawing.points.length + 1
    while (drawing.points.some((item) => item.label === `P${number}`)) number += 1
    const newPoint = { ...point, id: crypto.randomUUID(), label: pointLabel.trim() || `P${number}` }
    commit({ ...drawing, points: [...drawing.points, newPoint] })
    setSelectedId(newPoint.id)
    setLabel(newPoint.label)
    setX(String(newPoint.x))
    setY(String(newPoint.y))
  }

  function plotClick(event: MouseEvent<SVGSVGElement>) {
    if (disabled || tool !== 'point') return
    const point = clientToCoordinate(
      { x: event.clientX, y: event.clientY },
      event.currentTarget.getBoundingClientRect(),
      drawing.mode,
    )
    if (point) addPoint(point)
  }

  function savePoint(event: FormEvent) {
    event.preventDefault()
    if (disabled) return
    const point = { x: Number(x), y: Number(y) }
    if (!x.trim() || !y.trim() || !isValidCoordinate(point, drawing.mode)) {
      setMessage(
        `请输入有效坐标：${geographic ? '经度' : 'X'} ${bounds.minX}～${bounds.maxX}，${geographic ? '纬度' : 'Y'} ${bounds.minY}～${bounds.maxY}。`,
      )
      return
    }
    if (selected) {
      commit({
        ...drawing,
        points: drawing.points.map((item) =>
          item.id === selected.id
            ? { ...item, ...point, label: label.trim() || selected.label }
            : item,
        ),
      })
      setMessage('点坐标已更新。')
    } else addPoint(point, label)
  }

  function connect(start: string, end: string) {
    if (disabled) return
    if (!canConnectPoints(drawing, start, end)) {
      setMessage('请选择两个不同的点；已有线段无需重复连接。')
      return
    }
    if (drawing.lines.length >= 400) {
      setMessage('最多可绘制 400 条线段。')
      return
    }
    commit({
      ...drawing,
      lines: [...drawing.lines, { id: crypto.randomUUID(), from: start, to: end }],
    })
    setMessage('线段已添加。')
  }

  function changeMode() {
    if (drawing.points.length || drawing.lines.length) setConfirm('mode')
    else {
      commit({ ...drawing, mode: geographic ? 'cartesian' : 'geographic' })
      resetSelection()
    }
  }

  function confirmReset() {
    commit({
      points: [],
      lines: [],
      mode: confirm === 'mode' ? (geographic ? 'cartesian' : 'geographic') : drawing.mode,
    })
    resetSelection()
    setFrom('')
    setTo('')
    setConfirm(null)
  }

  return (
    <section className="geo-workbench" aria-labelledby={titleId}>
      <div className="geo-heading">
        <div>
          <h3 id={titleId}>地理绘图工作台</h3>
          <p className="muted">标注位置，连接关系，用图形辅助地理推理。</p>
        </div>
        <span className="geo-count">
          {drawing.points.length} 个点 · {drawing.lines.length} 条线
        </span>
      </div>
      <div className="geo-toolbar" role="group" aria-label="绘图工具">
        {(
          [
            ['point', '＋ 描点'],
            ['line', '↗ 连线'],
            ['select', '◎ 选点'],
          ] as const
        ).map(([value, text]) => (
          <button
            type="button"
            key={value}
            aria-pressed={tool === value}
            disabled={disabled}
            onClick={() => {
              setTool(value)
              setLineStart(null)
              setMessage('')
            }}
          >
            {text}
          </button>
        ))}
        <span className="geo-toolbar-spacer" />
        <button type="button" disabled={disabled} onClick={changeMode}>
          {geographic ? '经纬度' : '直角坐标'} ⇄
        </button>
        <button
          type="button"
          disabled={disabled || !history.length}
          onClick={() => {
            const previous = history[history.length - 1]
            if (!previous) return
            setHistory(history.slice(0, -1))
            onChange(previous)
            resetSelection()
            setConfirm(null)
            setMessage('已撤销上一步。')
          }}
        >
          撤销
        </button>
        <button
          type="button"
          disabled={disabled || !drawing.points.length}
          onClick={() => setConfirm('clear')}
        >
          清空
        </button>
      </div>
      {confirm && (
        <div className="geo-confirm" role="alert">
          <span>
            {confirm === 'mode'
              ? '切换坐标系会清空当前图形，避免不同单位混用。'
              : '清空所有点和线段？清空后仍可撤销。'}
          </span>
          <button type="button" disabled={disabled} onClick={confirmReset}>
            {confirm === 'mode' ? '切换并清空' : '确认清空'}
          </button>
          <button type="button" onClick={() => setConfirm(null)}>
            取消
          </button>
        </div>
      )}
      <div className="geo-canvas-wrap">
        <svg
          className={`geo-canvas geo-tool-${tool}`}
          viewBox={`0 0 ${CANVAS.width} ${CANVAS.height}`}
          preserveAspectRatio="xMidYMid meet"
          aria-label={geographic ? '经纬度绘图区域' : '直角坐标绘图区域'}
          aria-describedby={hintId}
          onClick={plotClick}
        >
          <title>{geographic ? '经纬度示意图，非真实地图投影' : '直角坐标示意图'}</title>
          <rect width={CANVAS.width} height={CANVAS.height} fill="#fbfcfd" />
          {xTicks.map((value) => {
            const position = coordinateToSvg({ x: value, y: 0 }, drawing.mode)
            return (
              <g key={`x-${value}`}>
                <line
                  x1={position.x}
                  x2={position.x}
                  y1={CANVAS.top}
                  y2={CANVAS.bottom}
                  stroke={value === 0 ? '#81959d' : '#e3e9eb'}
                  strokeWidth={value === 0 ? 1.5 : 1}
                />
                <text
                  x={position.x}
                  y={CANVAS.bottom + 20}
                  textAnchor="middle"
                  fill="#667b84"
                  fontSize="11"
                >
                  {value}
                  {geographic ? '°' : ''}
                </text>
              </g>
            )
          })}
          {yTicks.map((value) => {
            const position = coordinateToSvg({ x: 0, y: value }, drawing.mode)
            return (
              <g key={`y-${value}`}>
                <line
                  x1={CANVAS.left}
                  x2={CANVAS.right}
                  y1={position.y}
                  y2={position.y}
                  stroke={value === 0 ? '#81959d' : '#e3e9eb'}
                  strokeWidth={value === 0 ? 1.5 : 1}
                />
                <text
                  x={CANVAS.left - 10}
                  y={position.y + 4}
                  textAnchor="end"
                  fill="#667b84"
                  fontSize="11"
                >
                  {value}
                  {geographic ? '°' : ''}
                </text>
              </g>
            )
          })}
          <text x={CANVAS.right} y="20" textAnchor="end" fill="#45616b" fontSize="12">
            {geographic ? '经度 λ / 纬度 φ' : 'X / Y'}
          </text>
          {drawing.lines.map((line) => {
            const start = drawing.points.find((point) => point.id === line.from)
            const end = drawing.points.find((point) => point.id === line.to)
            if (!start || !end) return null
            const a = coordinateToSvg(start, drawing.mode)
            const b = coordinateToSvg(end, drawing.mode)
            return (
              <line
                key={line.id}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke="#167d86"
                strokeWidth="2.5"
                pointerEvents="none"
              />
            )
          })}
          {drawing.points.map((point) => {
            const position = coordinateToSvg(point, drawing.mode)
            return (
              <g key={point.id}>
                <circle
                  cx={position.x}
                  cy={position.y}
                  r={selectedId === point.id || lineStart === point.id ? 8 : 6}
                  fill={lineStart === point.id ? '#db8b3e' : '#167d86'}
                  stroke="#fff"
                  strokeWidth="2"
                  role="button"
                  tabIndex={disabled ? -1 : 0}
                  aria-disabled={disabled}
                  aria-label={`选择点 ${point.label}，坐标 ${point.x}, ${point.y}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    choosePoint(point)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      choosePoint(point)
                    }
                  }}
                />
                <text
                  x={position.x + (point.x >= bounds.maxX * 0.8 ? -12 : 12)}
                  y={position.y + (point.y >= bounds.maxY * 0.8 ? 19 : -11)}
                  textAnchor={point.x >= bounds.maxX * 0.8 ? 'end' : 'start'}
                  fill="#174c56"
                  fontSize="13"
                  fontWeight="600"
                  pointerEvents="none"
                >
                  {point.label}
                </text>
              </g>
            )
          })}
          {!drawing.points.length && (
            <g pointerEvents="none">
              <rect
                x="205"
                y="190"
                width="390"
                height="68"
                rx="10"
                fill="#fbfcfd"
                fillOpacity="0.95"
              />
              <text x="400" y="218" textAnchor="middle" fill="#43616c" fontSize="15">
                从一个位置开始你的推理
              </text>
              <text x="400" y="241" textAnchor="middle" fill="#7b8d94" fontSize="12">
                点击网格描点，或在下方输入精确坐标
              </text>
            </g>
          )}
        </svg>
      </div>
      <p id={hintId} className="geo-hint">
        {tool === 'line'
          ? '依次选择两个点连线；也可用下方的起点、终点菜单操作。'
          : '点选标记可编辑坐标；所有操作均可通过下方表单完成。'}
        {geographic && ' 经度东正西负，纬度北正南负；此图仅为坐标示意。'}
        {!geographic && ' 横纵轴显示比例不同，请按坐标值判断距离与角度。'}
      </p>
      <div className="geo-editor">
        <form className="geo-point-form" onSubmit={savePoint}>
          <div className="geo-form-heading">
            <strong>{selected ? '编辑选中的点' : '输入坐标描点'}</strong>
            {selected && (
              <button type="button" disabled={disabled} onClick={resetSelection}>
                ＋ 新建点
              </button>
            )}
          </div>
          <div className="geo-point-fields">
            <label>
              标记
              <input
                aria-label="点标记"
                value={label}
                maxLength={80}
                disabled={disabled}
                placeholder="如：A / 城市"
                onChange={(event) => setLabel(event.target.value)}
              />
            </label>
            <label>
              {geographic ? '经度 λ' : 'X 坐标'}
              <input
                aria-label={geographic ? '经度' : 'X 坐标'}
                type="number"
                min={bounds.minX}
                max={bounds.maxX}
                step="any"
                required
                value={x}
                disabled={disabled}
                onChange={(event) => setX(event.target.value)}
              />
            </label>
            <label>
              {geographic ? '纬度 φ' : 'Y 坐标'}
              <input
                aria-label={geographic ? '纬度' : 'Y 坐标'}
                type="number"
                min={bounds.minY}
                max={bounds.maxY}
                step="any"
                required
                value={y}
                disabled={disabled}
                onChange={(event) => setY(event.target.value)}
              />
            </label>
          </div>
          <div className="geo-form-actions">
            <button className="geo-primary" type="submit" disabled={disabled}>
              {selected ? '更新点' : '添加点'}
            </button>
            {selected && (
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  commit(removeDrawingPoint(drawing, selected.id))
                  resetSelection()
                }}
              >
                删除点及关联线
              </button>
            )}
          </div>
        </form>
        <form
          className="geo-line-form"
          onSubmit={(event) => {
            event.preventDefault()
            connect(from, to)
          }}
        >
          <strong>连接两个点</strong>
          <div className="geo-line-fields">
            <label>
              起点
              <select
                aria-label="连线起点"
                value={from}
                disabled={disabled || drawing.points.length < 2}
                onChange={(event) => setFrom(event.target.value)}
              >
                <option value="">选择起点</option>
                {drawing.points.map((point) => (
                  <option key={point.id} value={point.id}>
                    {point.label} ({point.x}, {point.y})
                  </option>
                ))}
              </select>
            </label>
            <label>
              终点
              <select
                aria-label="连线终点"
                value={to}
                disabled={disabled || drawing.points.length < 2}
                onChange={(event) => setTo(event.target.value)}
              >
                <option value="">选择终点</option>
                {drawing.points.map((point) => (
                  <option key={point.id} value={point.id}>
                    {point.label} ({point.x}, {point.y})
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button type="submit" disabled={disabled || !from || !to || drawing.points.length < 2}>
            添加线段
          </button>
        </form>
      </div>
      {drawing.points.length > 0 && (
        <div className="geo-point-list" aria-label="已绘制的点">
          {drawing.points.map((point) => (
            <button
              key={point.id}
              type="button"
              disabled={disabled}
              aria-pressed={selectedId === point.id}
              onClick={() => choosePoint(point)}
            >
              {point.label}{' '}
              <span>
                ({point.x}, {point.y})
              </span>
            </button>
          ))}
        </div>
      )}
      <p className="geo-status" role="status" aria-live="polite">
        {message}
      </p>
    </section>
  )
}
