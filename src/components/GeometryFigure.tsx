import { useEffect, useId, useMemo, useState } from 'react'
import { geometrySceneSchema, type GeometryScene } from '../shared/geometry'
import './geometry.css'

type Vector = { x: number; y: number; z: number }
type View = { azimuth: number; elevation: number }
const initialView: View = { azimuth: 45, elevation: 25 }

/** Orthographic projection uses all three model coordinates, never screen-space measurements. */
export function projectGeometryPoint(point: Vector, view: View) {
  const az = (view.azimuth * Math.PI) / 180
  const el = (view.elevation * Math.PI) / 180
  const horizontal = point.x * Math.sin(az) + point.y * Math.cos(az)
  return {
    x: point.x * Math.cos(az) - point.y * Math.sin(az),
    y: horizontal * Math.sin(el) - point.z * Math.cos(el),
    depth: horizontal * Math.cos(el) + point.z * Math.sin(el),
  }
}

/** An editable camera around an immutable scene. No answer-bearing metrics or coordinates. */
export function GeometryFigure({
  scene,
  controls = true,
  disabled = false,
}: {
  scene: GeometryScene
  controls?: boolean
  disabled?: boolean
}) {
  const id = useId()
  const [view, setView] = useState(initialView)
  const parsed = useMemo(() => geometrySceneSchema.safeParse(scene), [scene])
  useEffect(() => {
    if (parsed.success && !parsed.data.points.length) setView(initialView)
  }, [parsed])
  if (!parsed.success) return <p role="alert">三维几何格式无效，已停止显示。</p>
  const data = parsed.data
  const extent =
    Math.max(2, ...data.points.flatMap((p) => [Math.abs(p.x), Math.abs(p.y), Math.abs(p.z)])) * 1.18
  const axes = [
    { label: 'x', end: { x: extent, y: 0, z: 0 }, color: '#ac584c' },
    { label: 'y', end: { x: 0, y: extent, z: 0 }, color: '#397b64' },
    { label: 'z', end: { x: 0, y: 0, z: extent }, color: '#556dc3' },
  ]
  const bounds = [
    ...data.points,
    ...axes.flatMap(({ end }) => [end, { x: -end.x, y: -end.y, z: -end.z }]),
  ].map((p) => projectGeometryPoint(p, view))
  const scale = Math.min(
    260 / Math.max(1e-8, ...bounds.map((p) => Math.abs(p.x))),
    165 / Math.max(1e-8, ...bounds.map((p) => Math.abs(p.y))),
  )
  const xy = (point: Vector) => {
    const p = projectGeometryPoint(point, view)
    return { x: 320 + p.x * scale, y: 205 + p.y * scale, depth: p.depth }
  }
  const pointMap = new Map(data.points.map((p) => [p.id, p]))
  const faces = (data.faces ?? [])
    .map((face) => {
      const points = face.points.map((pid) => xy(pointMap.get(pid)!))
      return { ...face, points, depth: points.reduce((sum, p) => sum + p.depth, 0) / points.length }
    })
    .sort((a, b) => a.depth - b.depth)
  return (
    <figure className="geometry-figure" data-advisor-exclude>
      <svg
        className="geometry-canvas"
        viewBox="0 0 640 410"
        role="img"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
      >
        <title id={`${id}-title`}>{data.title || '三维几何坐标图'}</title>
        <desc id={`${id}-description`}>
          由真实 x、y、z 坐标生成的正交投影。点：
          {data.points.map((p) => p.label).join('、') || '暂无'}
          。图上长度和角度受视角影响，不能直接作为空间度量。
        </desc>
        <rect width="640" height="410" rx="10" fill="#f9fbff" />
        <g className="geometry-axes">
          {axes.map((axis) => {
            const from = xy({ x: -axis.end.x, y: -axis.end.y, z: -axis.end.z })
            const origin = xy({ x: 0, y: 0, z: 0 })
            const end = xy(axis.end)
            const dx = end.x - origin.x,
              dy = end.y - origin.y
            const length = Math.hypot(dx, dy)
            const label =
              length > 1e-6
                ? { x: end.x + (dx / length) * 15, y: end.y + (dy / length) * 15 + 4 }
                : { x: end.x + 12, y: end.y + 18 }
            return (
              <g key={axis.label} style={{ color: axis.color }}>
                <line
                  x1={from.x}
                  y1={from.y}
                  x2={origin.x}
                  y2={origin.y}
                  stroke="currentColor"
                  strokeDasharray="3 5"
                  opacity="0.45"
                />
                <line x1={origin.x} y1={origin.y} x2={end.x} y2={end.y} stroke="currentColor" />
                <text
                  x={label.x}
                  y={label.y}
                  textAnchor={dx < -1 ? 'end' : dx > 1 ? 'start' : 'middle'}
                  fill="currentColor"
                >
                  {axis.label}
                </text>
              </g>
            )
          })}
        </g>
        <g className="geometry-faces">
          {faces.map((face) => (
            <polygon
              key={face.id}
              data-testid="geometry-face"
              points={face.points.map((p) => `${p.x},${p.y}`).join(' ')}
            />
          ))}
        </g>
        <g className="geometry-segments">
          {data.segments.map((segment) => {
            const a = xy(pointMap.get(segment.from)!)
            const b = xy(pointMap.get(segment.to)!)
            return (
              <line
                key={segment.id}
                data-testid="geometry-segment"
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                strokeDasharray={segment.dashed ? '6 5' : undefined}
              />
            )
          })}
        </g>
        <g className="geometry-right-angles">
          {(data.rightAngles ?? []).map((relation) => {
            const vertex = pointMap.get(relation.vertex)!
            const a = pointMap.get(relation.from)!
            const b = pointMap.get(relation.to)!
            const u = { x: a.x - vertex.x, y: a.y - vertex.y, z: a.z - vertex.z }
            const v = { x: b.x - vertex.x, y: b.y - vertex.y, z: b.z - vertex.z }
            const lu = Math.hypot(u.x, u.y, u.z),
              lv = Math.hypot(v.x, v.y, v.z)
            if (!lu || !lv || Math.abs(u.x * v.x + u.y * v.y + u.z * v.z) > lu * lv * 1e-7)
              return null
            const size = Math.min(lu * 0.18, lv * 0.18, extent * 0.1)
            const corner = (x: number, y: number) =>
              xy({
                x: vertex.x + size * ((x * u.x) / lu + (y * v.x) / lv),
                y: vertex.y + size * ((x * u.y) / lu + (y * v.y) / lv),
                z: vertex.z + size * ((x * u.z) / lu + (y * v.z) / lv),
              })
            return (
              <polyline
                key={relation.id}
                data-testid="geometry-right-angle"
                points={[corner(1, 0), corner(1, 1), corner(0, 1)]
                  .map((p) => `${p.x},${p.y}`)
                  .join(' ')}
              />
            )
          })}
        </g>
        <g className="geometry-points">
          {data.points.map((point) => {
            const p = xy(point)
            return (
              <g key={point.id} data-geometry-point={point.id}>
                <circle data-testid="geometry-point" cx={p.x} cy={p.y} r="4.5" />
                <text x={p.x + 8} y={p.y - 9}>
                  {point.label}
                </text>
              </g>
            )
          })}
        </g>
      </svg>
      {controls && (
        <fieldset className="geometry-view-controls" disabled={disabled}>
          <legend>观察视角</legend>
          <div className="geometry-view-presets">
            {[
              ['立体', initialView],
              ['俯视 xy', { azimuth: 0, elevation: 90 }],
              ['正视 xz', { azimuth: 0, elevation: 0 }],
              ['侧视 yz', { azimuth: 90, elevation: 0 }],
            ].map(([label, camera]) => (
              <button key={String(label)} type="button" onClick={() => setView(camera as View)}>
                {String(label)}
              </button>
            ))}
          </div>
          <label>
            方位角{' '}
            <input
              aria-label="三维方位角"
              type="range"
              min="-180"
              max="180"
              value={view.azimuth}
              onChange={(event) => setView({ ...view, azimuth: Number(event.target.value) })}
            />
          </label>
          <label>
            仰角{' '}
            <input
              aria-label="三维仰角"
              type="range"
              min="-90"
              max="90"
              value={view.elevation}
              onChange={(event) => setView({ ...view, elevation: Number(event.target.value) })}
            />
          </label>
        </fieldset>
      )}
      <figcaption>
        空间坐标的正交投影；旋转只改变视角。投影后的长度、角度不能直接用于空间计算。虚线由图形数据指定，不自动判断遮挡。
      </figcaption>
    </figure>
  )
}
