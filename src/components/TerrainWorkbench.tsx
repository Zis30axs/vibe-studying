import { useMemo, useState } from 'react'
import {
  createTerrain,
  DEFAULT_TERRAIN,
  elevationAt,
  terrainPointSchema,
  terrainProfile,
  TERRAIN_PRESETS,
} from '../domain/terrain'
import { terrainNumber } from '../domain/terrain-exercise'
import type { TerrainPoint, TerrainPreset } from '../shared/terrain'
import { TerrainMap, TerrainProfileFigure } from './TerrainFigure'
import './terrain.css'

export function TerrainWorkbench({ disabled = false }: { disabled?: boolean }) {
  const [preset, setPreset] = useState<TerrainPreset>('peak')
  const [interval, setInterval] = useState(50)
  const [from, setFrom] = useState<TerrainPoint>({ xM: 250, yM: 1000 })
  const [to, setTo] = useState<TerrainPoint>({ xM: 1750, yM: 1000 })
  const [fields, setFields] = useState(['250', '1000', '1750', '1000'])
  const [probeFields, setProbeFields] = useState(['1000', '1000'])
  const [probe, setProbe] = useState<TerrainPoint | null>(null)
  const [error, setError] = useState('')
  const grid = useMemo(
    () => createTerrain({ ...DEFAULT_TERRAIN, preset, contourIntervalM: interval }),
    [preset, interval],
  )
  const profile = useMemo(() => terrainProfile(grid, from, to), [grid, from, to])
  const f = terrainNumber
  function point(x: string, y: string): TerrainPoint {
    if (!x.trim() || !y.trim()) throw new Error('请填写有效的米制坐标。')
    const p = terrainPointSchema.parse({ xM: Number(x), yM: Number(y) })
    elevationAt(grid, p)
    return p
  }
  return (
    <details className="terrain-workbench" data-advisor-exclude>
      <summary>
        教学地形实验 <span>模拟等高线 / 查高程 / 剖面</span>
      </summary>
      <section aria-label="教学地形实验">
        <p>
          本地模拟，非实测 DEM。工具同时供教学 Agent
          调用；这里的试算不修改作答，不发送云端，关闭应用后不保留实验参数。
        </p>
        <div className="terrain-controls">
          <label>
            地形
            <select
              aria-label="教学地形预设"
              value={preset}
              disabled={disabled}
              onChange={(e) => setPreset(e.target.value as TerrainPreset)}
            >
              {Object.entries(TERRAIN_PRESETS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            等高距
            <select
              aria-label="教学等高距"
              value={interval}
              disabled={disabled}
              onChange={(e) => setInterval(Number(e.target.value))}
            >
              {[20, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n} m
                </option>
              ))}
            </select>
          </label>
          <span>图幅 2000 × 2000 m · 网格 62.5 m</span>
        </div>
        <TerrainMap
          grid={grid}
          markers={[
            { ...from, label: 'A' },
            { ...to, label: 'B' },
          ]}
        />
        <form
          className="terrain-controls"
          onSubmit={(event) => {
            event.preventDefault()
            try {
              const a = point(fields[0], fields[1]),
                b = point(fields[2], fields[3])
              terrainProfile(grid, a, b)
              setFrom(a)
              setTo(b)
              setError('')
            } catch {
              setError('请输入 0～2000 m 范围内的有效坐标，剖面两端至少相距 0.01 m。')
            }
          }}
        >
          {['A x (m)', 'A y (m)', 'B x (m)', 'B y (m)'].map((label, i) => (
            <label key={label}>
              {label}
              <input
                aria-label={`地形剖面 ${label}`}
                type="number"
                min="0"
                max="2000"
                step="any"
                value={fields[i]}
                disabled={disabled}
                onChange={(e) =>
                  setFields(fields.map((value, j) => (i === j ? e.target.value : value)))
                }
              />
            </label>
          ))}
          <button type="submit" disabled={disabled}>
            计算地形剖面
          </button>
        </form>
        <p className="terrain-readout">
          A {f(profile.points[0].elevationM)} m → B {f(profile.points.at(-1)!.elevationM)}{' '}
          m；水平距离 {f(profile.horizontalDistanceM)} m；高差 {f(profile.elevationChangeM)}{' '}
          m；端点平均坡度 {f(profile.meanSignedGradePercent)}%。
        </p>
        <TerrainProfileFigure profile={profile} />
        <form
          className="terrain-controls"
          onSubmit={(event) => {
            event.preventDefault()
            try {
              setProbe(point(probeFields[0], probeFields[1]))
              setError('')
            } catch {
              setError('高程查询坐标必须在 0～2000 m 之间。')
            }
          }}
        >
          {['x (m)', 'y (m)'].map((label, i) => (
            <label key={label}>
              探测 {label}
              <input
                aria-label={`地形探测 ${label}`}
                type="number"
                min="0"
                max="2000"
                step="any"
                value={probeFields[i]}
                disabled={disabled}
                onChange={(e) =>
                  setProbeFields(probeFields.map((value, j) => (i === j ? e.target.value : value)))
                }
              />
            </label>
          ))}
          <button type="submit" disabled={disabled}>
            查询地形高程
          </button>
          {probe && (
            <output aria-label="地形探测结果">
              ({f(probe.xM)}, {f(probe.yM)}) → {f(elevationAt(grid, probe))} m
            </output>
          )}
        </form>
        <p className="terrain-note">
          等高线与查询使用同一三角网插值。平均坡度仅由端点决定，不代表沿途各点坡度。图上没有标出的测量数据不能当作真实地理事实。
        </p>
        {error && <p role="alert">{error}</p>}
      </section>
    </details>
  )
}
