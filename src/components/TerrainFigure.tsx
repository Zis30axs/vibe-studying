import { useId, useMemo } from 'react'
import type { TerrainExercise, TerrainGrid, TerrainPoint } from '../shared/terrain'
import { terrainContours, terrainProfile } from '../domain/terrain'
import {
  terrainExercisePoints,
  terrainExerciseSchema,
  terrainNumber,
} from '../domain/terrain-exercise'
import { createTerrain } from '../domain/terrain'
import './terrain.css'

export function TerrainMap({
  grid,
  markers = [],
}: {
  grid: TerrainGrid
  markers?: (TerrainPoint & { label: string })[]
}) {
  const id = useId().replace(/[^A-Za-z0-9_-]/g, '')
  const contours = useMemo(() => terrainContours(grid), [grid])
  const scale = Math.min(480 / grid.spec.widthM, 300 / grid.spec.heightM)
  const w = grid.spec.widthM * scale,
    h = grid.spec.heightM * scale
  const x0 = (600 - w) / 2,
    y0 = (380 - h) / 2
  const xy = (p: TerrainPoint) => ({ x: x0 + p.xM * scale, y: y0 + h - p.yM * scale })
  const f = terrainNumber
  const labelEvery = Math.max(1, Math.ceil(contours.length / 16))
  return (
    <svg
      className="terrain-map"
      viewBox="0 0 600 430"
      role="img"
      aria-labelledby={`terrain-title-${id}`}
      aria-describedby={`terrain-desc-${id}`}
    >
      <title id={`terrain-title-${id}`}>模拟教学等高线图</title>
      <desc id={`terrain-desc-${id}`}>
        非实测地图。宽{f(grid.spec.widthM)}米，高{f(grid.spec.heightM)}米；等高距
        {f(grid.spec.contourIntervalM)}米，向右东，向上北。网格间距{f(grid.cellWidthM)}乘
        {f(grid.cellHeightM)}米，分片线性近似。
      </desc>
      <rect className="terrain-frame" x={x0} y={y0} width={w} height={h} />
      <g className="terrain-contours">
        {contours.map((line) => (
          <polyline
            key={line.id}
            points={line.points
              .map((p) => {
                const { x, y } = xy(p)
                return `${x},${y}`
              })
              .join(' ')}
          >
            <title>高程 {f(line.elevationM)} m</title>
          </polyline>
        ))}
      </g>
      <g className="terrain-contour-labels">
        {contours
          .filter((line, i) => i % labelEvery === 0 && line.points.length > 4)
          .map((line) => {
            const p = xy(line.points[Math.floor(line.points.length * 0.37)])
            return (
              <text key={line.id} x={p.x} y={p.y}>
                {f(line.elevationM)}
              </text>
            )
          })}
      </g>
      {markers.length === 2 && (
        <line
          className="terrain-section-line"
          x1={xy(markers[0]).x}
          y1={xy(markers[0]).y}
          x2={xy(markers[1]).x}
          y2={xy(markers[1]).y}
        />
      )}
      <g className="terrain-markers">
        {markers.map((point) => {
          const p = xy(point)
          return (
            <g key={point.label}>
              <circle cx={p.x} cy={p.y} r={4} />
              <text x={p.x + 7} y={p.y - 7}>
                {point.label}
              </text>
            </g>
          )
        })}
      </g>
      <g className="terrain-scale">
        <line x1={x0} y1={398} x2={x0 + w / 4} y2={398} />
        <line x1={x0} y1={393} x2={x0} y2={403} />
        <line x1={x0 + w / 4} y1={393} x2={x0 + w / 4} y2={403} />
        <text x={x0} y={420}>
          0
        </text>
        <text x={x0 + w / 4} y={420} textAnchor="middle">
          {f(grid.spec.widthM / 4)} m
        </text>
        <text x={540} y={25}>
          北 N ↑
        </text>
        <text x={540} y={43}>
          东 E →
        </text>
      </g>
    </svg>
  )
}
export function TerrainProfileFigure({ profile }: { profile: ReturnType<typeof terrainProfile> }) {
  const f = terrainNumber,
    min = profile.sampledMinimumM,
    max = profile.sampledMaximumM
  const span = Math.max(1, max - min)
  const pointList = profile.points
    .map(
      (p) =>
        `${55 + (p.distanceM / profile.horizontalDistanceM) * 470},${170 - ((p.elevationM - min) / span) * 135}`,
    )
    .join(' ')
  return (
    <figure className="terrain-profile">
      <svg viewBox="0 0 600 225" role="img" aria-label="A 到 B 的模拟地形剖面">
        <path className="terrain-profile-axis" d="M 55 22 L 55 170 L 540 170" />
        <polyline points={pointList} className="terrain-profile-line" />
        <text x="48" y="174" textAnchor="end">
          {f(min)}
        </text>
        <text x="48" y="39" textAnchor="end">
          {f(min + span)}
        </text>
        <text x="16" y="16">
          高程 m
        </text>
        <text x="55" y="192">
          A · 0
        </text>
        <text x="525" y="192" textAnchor="end">
          B · {f(profile.horizontalDistanceM)} m
        </text>
        <text x="300" y="216" textAnchor="middle">
          水平距离（m）
        </text>
      </svg>
      <figcaption>
        纵横轴比例独立；{profile.points.length} 点等距采样，可能遗漏采样点之间的极值。均坡{' '}
        {f(profile.meanSignedGradePercent)}% ≠ 角度 {f(profile.meanSignedAngleDegrees)}°。
      </figcaption>
    </figure>
  )
}
/** Student rendering excludes computed profile/expected answers. All geometry is local. */
export function TerrainFigure({ exercise }: { exercise: TerrainExercise }) {
  const parsed = useMemo(() => terrainExerciseSchema.safeParse(exercise), [exercise])
  const grid = useMemo(() => (parsed.success ? createTerrain(parsed.data.terrain) : null), [parsed])
  if (!parsed.success || !grid) return <p role="alert">教学地形格式无效，已停止显示。</p>
  const { A, B } = terrainExercisePoints(parsed.data)
  return (
    <figure className="terrain-figure" data-advisor-exclude>
      <div className="terrain-heading">
        <strong>模拟教学等高线</strong>
        <span>非实测 DEM · 米制局部坐标</span>
      </div>
      <TerrainMap
        grid={grid}
        markers={[
          { ...A, label: 'A' },
          { ...B, label: 'B' },
        ]}
      />
      <figcaption>
        等高距 {terrainNumber(grid.spec.contourIntervalM)} m；网格约{' '}
        {terrainNumber(grid.cellWidthM)} × {terrainNumber(grid.cellHeightM)}{' '}
        m。无现场测量数据；剖面与参考计算在提交后解析中查看。
      </figcaption>
    </figure>
  )
}

/** Call only from submitted-attempt review, never the unsubmitted question preview. */
export function TerrainReviewProfile({ exercise }: { exercise: TerrainExercise }) {
  const parsed = useMemo(() => terrainExerciseSchema.safeParse(exercise), [exercise])
  const profile = useMemo(() => {
    if (!parsed.success) return null
    const grid = createTerrain(parsed.data.terrain),
      { A, B } = terrainExercisePoints(parsed.data)
    return terrainProfile(grid, A, B)
  }, [parsed])
  return profile ? <TerrainProfileFigure profile={profile} /> : null
}
