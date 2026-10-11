import { useEffect, useId, useMemo, useState } from 'react'
import type { FormEvent, MouseEvent } from 'react'
import type { GeoDrawing, GeoMapPreferences, GeoPoint } from '../shared/types'
import {
  CANVAS,
  canConnectPoints,
  clientToCoordinate,
  coordinateBounds,
  coordinateToSvg,
  isValidCoordinate,
  removeDrawingPoint,
} from '../domain/coordinates'
import {
  clientToGeographic,
  geographicToSvg,
  geoViewport,
  LAND_OUTLINE_PATH,
  layoutMapPointLabels,
  mapImageRect,
  MAP_SOURCE,
  mapTicks,
  mapWorldTransform,
  moveGeoMap,
  normalizeGeoMap,
} from '../domain/geography-map'
import {
  loadAdminData,
  visibleAdminLabels,
  visibleAdminPaths,
  type PreparedAdminData,
} from '../domain/geography-admin1'
import terrainUrl from '../assets/geography/natural-earth-physical-2160.jpg'
import './geography.css'
import { TerrainWorkbench } from './TerrainWorkbench'

interface Props {
  drawing: GeoDrawing
  onChange: (drawing: GeoDrawing) => void
  disabled?: boolean
}
type Tool = 'point' | 'line' | 'select'

export function GeographyWorkbench({ drawing, onChange, disabled = false }: Props) {
  const titleId = useId()
  const hintId = useId()
  const plotClipId = useId()
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
  const map = normalizeGeoMap(drawing.map)
  const [adminData, setAdminData] = useState<PreparedAdminData | null>(null)
  const [adminError, setAdminError] = useState(false)
  const [adminRetry, setAdminRetry] = useState(0)
  const [terrainError, setTerrainError] = useState(false)
  useEffect(() => {
    if (drawing.mode !== 'geographic' || map.layer !== 'admin1') return
    let active = true
    setAdminError(false)
    void loadAdminData()
      .then((data) => {
        if (active) setAdminData(data)
      })
      .catch(() => {
        if (active) setAdminError(true)
      })
    return () => {
      active = false
    }
  }, [drawing.mode, map.layer, adminRetry])
  const adminPaths = useMemo(
    () => (adminData ? visibleAdminPaths(adminData, map) : null),
    [adminData, map.longitude, map.latitude, map.zoom],
  )
  const adminLabels = useMemo(
    () => (adminData ? visibleAdminLabels(adminData, map, map.showLabels) : []),
    [adminData, map.longitude, map.latitude, map.zoom, map.showLabels],
  )
  const pointLabels = useMemo(
    () => layoutMapPointLabels(drawing.points, map, selectedId),
    [drawing.points, selectedId, map.longitude, map.latitude, map.zoom],
  )
  const viewport = geoViewport(map)
  const imageRect = mapImageRect(map)
  const bounds = coordinateBounds(drawing.mode)
  const geographic = drawing.mode === 'geographic'
  const selected = drawing.points.find((point) => point.id === selectedId)
  const xTicks = geographic ? mapTicks(map, 'x') : [-10, -8, -6, -4, -2, 0, 2, 4, 6, 8, 10]
  const yTicks = geographic ? mapTicks(map, 'y') : [-10, -8, -6, -4, -2, 0, 2, 4, 6, 8, 10]

  const project = (point: { x: number; y: number }) =>
    geographic ? geographicToSvg(point, map) : coordinateToSvg(point, drawing.mode)

  function updateMap(patch: Partial<GeoMapPreferences>) {
    commit({ ...drawing, map: normalizeGeoMap({ ...map, ...patch }) })
  }

  async function copySource(url: string) {
    try {
      await navigator.clipboard.writeText(url)
      setMessage('来源链接已复制。')
    } catch {
      setMessage('未能复制，可选中来源地址手动复制。')
    }
  }

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
    const client = { x: event.clientX, y: event.clientY }
    const rect = event.currentTarget.getBoundingClientRect()
    const point = geographic
      ? clientToGeographic(client, rect, map)
      : clientToCoordinate(client, rect, drawing.mode)
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
      ...drawing,
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
      {geographic && (
        <div className="geo-map-controls" aria-label="离线地图设置">
          <div className="geo-map-layer-options" role="group" aria-label="地图图层">
            {(
              [
                ['outline', '世界轮廓'],
                ['terrain', '自然地理'],
                ['admin1', '省州参考'],
              ] as const
            ).map(([layer, title]) => (
              <button
                key={layer}
                type="button"
                aria-pressed={map.layer === layer}
                disabled={disabled}
                onClick={() => updateMap({ layer })}
              >
                {title}
              </button>
            ))}
          </div>
          <div className="geo-map-navigation" role="group" aria-label="地图视野">
            <button
              type="button"
              aria-label="缩小地图"
              disabled={disabled || map.zoom <= 1}
              onClick={() => updateMap({ zoom: map.zoom / 2 })}
            >
              −
            </button>
            <span aria-live="polite">{map.zoom}×</span>
            <button
              type="button"
              aria-label="放大地图"
              disabled={disabled || map.zoom >= 8}
              onClick={() => updateMap({ zoom: map.zoom * 2 })}
            >
              ＋
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => updateMap({ longitude: 0, latitude: 0, zoom: 1 })}
            >
              全球
            </button>
            <button
              type="button"
              disabled={disabled || !selected}
              onClick={() =>
                selected &&
                updateMap({
                  longitude: selected.x,
                  latitude: selected.y,
                  zoom: Math.max(map.zoom, 4),
                })
              }
            >
              定位选点
            </button>
            {(
              [
                [-90, 0, '向西平移', '←'],
                [0, 45, '向北平移', '↑'],
                [0, -45, '向南平移', '↓'],
                [90, 0, '向东平移', '→'],
              ] as const
            ).map(([dx, dy, title, arrow]) => {
              const next = moveGeoMap(map, dx / map.zoom, dy / map.zoom)
              return (
                <button
                  key={title}
                  type="button"
                  aria-label={title}
                  disabled={
                    disabled || (next.longitude === map.longitude && next.latitude === map.latitude)
                  }
                  onClick={() => updateMap(next)}
                >
                  {arrow}
                </button>
              )
            })}
          </div>
          <div className="geo-map-toggles">
            <label>
              <input
                type="checkbox"
                checked={map.showGrid}
                disabled={disabled}
                onChange={(event) => updateMap({ showGrid: event.target.checked })}
              />
              经纬网
            </label>
            {map.layer === 'admin1' && (
              <label>
                <input
                  type="checkbox"
                  checked={map.showLabels !== false}
                  disabled={disabled}
                  onChange={(event) => updateMap({ showLabels: event.target.checked })}
                />
                省州名称
              </label>
            )}
          </div>
        </div>
      )}
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
          <title>
            {geographic ? 'Natural Earth 离线地图，线性经纬度参考图' : '直角坐标示意图'}
          </title>
          <defs>
            <clipPath id={plotClipId}>
              <rect
                x={CANVAS.left}
                y={CANVAS.top}
                width={CANVAS.right - CANVAS.left}
                height={CANVAS.bottom - CANVAS.top}
              />
            </clipPath>
          </defs>
          <rect width={CANVAS.width} height={CANVAS.height} className="geo-svg-background" />
          {geographic && (
            <g
              clipPath={`url(#${plotClipId})`}
              pointerEvents="none"
              data-testid="geography-basemap"
            >
              <rect
                x={CANVAS.left}
                y={CANVAS.top}
                width={CANVAS.right - CANVAS.left}
                height={CANVAS.bottom - CANVAS.top}
                className="geo-map-ocean"
              />
              {map.layer === 'terrain' && !terrainError ? (
                <image
                  href={terrainUrl}
                  {...imageRect}
                  preserveAspectRatio="none"
                  data-testid="geography-terrain"
                  onError={() => setTerrainError(true)}
                />
              ) : (
                <path
                  d={LAND_OUTLINE_PATH}
                  transform={mapWorldTransform(map)}
                  fillRule="evenodd"
                  className="geo-map-land"
                  vectorEffect="non-scaling-stroke"
                  data-testid="geography-land"
                />
              )}
              {map.layer === 'admin1' &&
                adminPaths &&
                Object.entries(adminPaths).map(
                  ([category, path]) =>
                    path && (
                      <path
                        key={category}
                        d={path}
                        transform={mapWorldTransform(map)}
                        className={`geo-admin-line geo-admin-${category}`}
                        vectorEffect="non-scaling-stroke"
                        data-testid={`admin1-${category}`}
                      />
                    ),
                )}
            </g>
          )}
          {xTicks.map((value) => {
            const position = project({ x: value, y: 0 })
            return (
              <g key={`x-${value}`}>
                {(!geographic || map.showGrid) && (
                  <line
                    x1={position.x}
                    x2={position.x}
                    y1={CANVAS.top}
                    y2={CANVAS.bottom}
                    className={value === 0 ? 'geo-grid-major' : 'geo-grid-line'}
                    strokeWidth={value === 0 ? 1.5 : 1}
                  />
                )}
                <text
                  x={position.x}
                  y={CANVAS.bottom + 20}
                  textAnchor="middle"
                  className="geo-axis-label"
                  fontSize="11"
                >
                  {value}
                  {geographic ? '°' : ''}
                </text>
              </g>
            )
          })}
          {yTicks.map((value) => {
            const position = project({ x: 0, y: value })
            return (
              <g key={`y-${value}`}>
                {(!geographic || map.showGrid) && (
                  <line
                    x1={CANVAS.left}
                    x2={CANVAS.right}
                    y1={position.y}
                    y2={position.y}
                    className={value === 0 ? 'geo-grid-major' : 'geo-grid-line'}
                    strokeWidth={value === 0 ? 1.5 : 1}
                  />
                )}
                <text
                  x={CANVAS.left - 10}
                  y={position.y + 4}
                  textAnchor="end"
                  className="geo-axis-label"
                  fontSize="11"
                >
                  {value}
                  {geographic ? '°' : ''}
                </text>
              </g>
            )
          })}
          <text x={CANVAS.right} y="20" textAnchor="end" className="geo-axis-title" fontSize="12">
            {geographic ? '经度 λ / 纬度 φ' : 'X / Y'}
          </text>
          <g clipPath={`url(#${plotClipId})`}>
            {geographic &&
              map.layer === 'admin1' &&
              adminLabels.map((label) => (
                <text
                  key={label.id}
                  x={label.x}
                  y={label.y}
                  textAnchor="middle"
                  className="geo-admin-label"
                  pointerEvents="none"
                  data-testid="admin1-label"
                >
                  <title>
                    {label.name} · {label.localName} · Natural Earth 原始归组：{label.sourceAdmin} (
                    {label.sourceCountryCode})
                  </title>
                  {label.name}
                </text>
              ))}
            {drawing.lines.map((line) => {
              const start = drawing.points.find((point) => point.id === line.from)
              const end = drawing.points.find((point) => point.id === line.to)
              if (!start || !end) return null
              const a = project(start)
              const b = project(end)
              return (
                <line
                  key={line.id}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  className="geo-annotation-line"
                  strokeWidth="2.5"
                  pointerEvents="none"
                />
              )
            })}
            {drawing.points.map((point) => {
              const position = project(point)
              if (
                geographic &&
                (position.x < CANVAS.left ||
                  position.x > CANVAS.right ||
                  position.y < CANVAS.top ||
                  position.y > CANVAS.bottom)
              )
                return null
              return (
                <g key={point.id}>
                  <title>
                    {point.label} ({point.x}, {point.y})
                  </title>
                  <circle
                    cx={position.x}
                    cy={position.y}
                    r={selectedId === point.id || lineStart === point.id ? 8 : 6}
                    className={lineStart === point.id ? 'geo-point geo-point-pending' : 'geo-point'}
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
                  {!geographic && (
                    <text
                      x={position.x + (point.x >= bounds.maxX * 0.8 ? -12 : 12)}
                      y={position.y + (point.y >= bounds.maxY * 0.8 ? 19 : -11)}
                      textAnchor={point.x >= bounds.maxX * 0.8 ? 'end' : 'start'}
                      className="geo-point-label"
                      fontSize="13"
                      fontWeight="600"
                      pointerEvents="none"
                    >
                      {point.label}
                    </text>
                  )}
                </g>
              )
            })}
            {geographic &&
              pointLabels.map((label) => (
                <text
                  key={label.id}
                  x={label.x}
                  y={label.y}
                  textAnchor={label.anchor}
                  className="geo-point-label"
                  pointerEvents="none"
                >
                  {label.text}
                </text>
              ))}
          </g>
          {!geographic && !drawing.points.length && (
            <g pointerEvents="none">
              <rect
                x="205"
                y="190"
                width="390"
                height="68"
                rx="10"
                className="geo-svg-background"
                fillOpacity="0.95"
              />
              <text x="400" y="218" textAnchor="middle" className="geo-axis-title" fontSize="15">
                从一个位置开始你的推理
              </text>
              <text x="400" y="241" textAnchor="middle" className="geo-axis-label" fontSize="12">
                点击网格描点，或在下方输入精确坐标
              </text>
            </g>
          )}
        </svg>
      </div>
      {geographic && (
        <div className="geo-map-information">
          <p className="geo-map-caption">
            {map.layer === 'terrain'
              ? '自然地理 · Natural Earth II v3.2.0'
              : map.layer === 'admin1'
                ? '省州参考 · Natural Earth Admin-1 v5.1.1 / 线划 v5.1.0'
                : '世界轮廓 · Natural Earth Land v4.1.0'}{' '}
            · 离线 · 资料核验 {MAP_SOURCE.checked}
          </p>
          {map.layer === 'admin1' && (
            <p className="geo-map-caution">
              采用 Natural Earth 默认事实管辖口径，包含统计分区；不是中国审定标准或 Google
              美国视图，不含完整国界。中国标准红色疆界与南海标示尚未接入。
            </p>
          )}
          {map.layer === 'admin1' && map.zoom < 2 && (
            <p className="geo-map-help">
              放大到 2×
              后显示省州界线和名称，继续放大可查看更密集地区。标签自动避让；未显示不代表没有该行政区。
            </p>
          )}
          {map.layer === 'admin1' && !adminData && !adminError && (
            <p role="status">正在读取本机省州参考数据…</p>
          )}
          {map.layer === 'admin1' && adminError && (
            <p role="alert">
              本机省州图层加载失败，标注仍可使用。
              <button type="button" onClick={() => setAdminRetry((value) => value + 1)}>
                重新读取图层
              </button>
            </p>
          )}
          {map.layer === 'terrain' && terrainError && (
            <p role="alert">本机地形图片加载失败，暂显示世界轮廓。</p>
          )}
          <details className="geo-map-sources">
            <summary>地图来源与使用范围</summary>
            <p>
              WGS84 经度/纬度。轮廓 1:110m，地形 1:50m；省州线划 1:10m，并作 0.025°
              简化。仅供地理关系学习，不作精确边界、距离或海域判定。省州名称保留来源中文名（缺少时回退原文），同名及原始归组不代表本应用确认主权；显示可能不完整或已过时。
            </p>
            <p>
              Natural Earth 数据为公有领域（Public
              domain）。自然地理图层不绘制政治国界；省州参考层保持来源默认分类，未把 US/CN
              分类字段转换为官方立场。细虚线为统计分区，点划线为来源标记的未获承认边界。省州数据按需从本机读取。
            </p>
            <p>
              当前视野：经度 {viewport.minX.toFixed(1)}°～{viewport.maxX.toFixed(1)}°，纬度{' '}
              {viewport.minY.toFixed(1)}°～{viewport.maxY.toFixed(1)}°。最多显示 70 个省州名称与 80
              个点标签；完整自定义标记见下方列表。
            </p>
            {[
              [
                '轮廓来源',
                'https://www.naturalearthdata.com/downloads/110m-physical-vectors/110m-land/',
              ],
              [
                '地形来源',
                'https://www.naturalearthdata.com/downloads/50m-raster-data/50m-natural-earth-2/',
              ],
              [
                '省州来源',
                'https://www.naturalearthdata.com/downloads/10m-cultural-vectors/10m-admin-1-states-provinces/',
              ],
              ['数据许可', 'https://www.naturalearthdata.com/about/terms-of-use/'],
              ['中国标准地图服务（未接入）', 'https://bzdt.tianditu.gov.cn/'],
            ].map(([title, url]) => (
              <label key={url} className="geo-source-url">
                {title}
                <input
                  readOnly
                  aria-label={title}
                  value={url}
                  onFocus={(event) => event.currentTarget.select()}
                />
                <button
                  type="button"
                  onClick={() => {
                    void copySource(url)
                  }}
                >
                  复制链接
                </button>
              </label>
            ))}
          </details>
        </div>
      )}
      <p id={hintId} className="geo-hint">
        {tool === 'line'
          ? '依次选择两个点连线；也可用下方的起点、终点菜单操作。'
          : '点选标记可编辑坐标；所有操作均可通过下方表单完成。'}
        {geographic &&
          ' 经度东正西负，纬度北正南负。线性经纬度参考图，不能直接测距或判断面积；缩放不改变标注坐标。'}
        {!geographic && ' 横纵轴显示比例不同，请按坐标值判断距离与角度。'}
      </p>
      <TerrainWorkbench disabled={disabled} />
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
