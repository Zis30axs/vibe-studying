import { useEffect, useId, useRef, useState } from 'react'
import { geometrySceneSchema, type GeometryScene } from '../shared/geometry'
import { GeometryFigure } from './GeometryFigure'
import './geometry.css'

const emptyScene = (): GeometryScene => ({
  version: 1,
  kind: 'geometry-3d',
  title: '空间几何草图',
  points: [],
  segments: [],
})
const initialScene = emptyScene()
const emptyFields = { label: '', x: '0', y: '0', z: '0' }
function cubeScene(): GeometryScene {
  const points = [
    ['A', 0, 0, 0],
    ['B', 4, 0, 0],
    ['C', 4, 4, 0],
    ['D', 0, 4, 0],
    ['E', 0, 0, 4],
    ['F', 4, 0, 4],
    ['G', 4, 4, 4],
    ['H', 0, 4, 4],
  ].map(([label, x, y, z]) => ({
    id: String(label),
    label: String(label),
    x: Number(x),
    y: Number(y),
    z: Number(z),
  }))
  return {
    version: 1,
    kind: 'geometry-3d',
    title: '立方体空间坐标示例',
    points,
    segments: [
      ['A', 'B'],
      ['B', 'C'],
      ['C', 'D'],
      ['D', 'A'],
      ['E', 'F'],
      ['F', 'G'],
      ['G', 'H'],
      ['H', 'E'],
      ['A', 'E'],
      ['B', 'F'],
      ['C', 'G'],
      ['D', 'H'],
    ].map(([from, to], i) => ({
      id: `edge-${i}`,
      from,
      to,
      ...(i === 0 || i === 3 || i === 8 ? { dashed: true } : {}),
    })),
    faces: [{ id: 'top', points: ['E', 'F', 'G', 'H'] }],
    rightAngles: [{ id: 'corner-a', vertex: 'A', from: 'B', to: 'E' }],
  }
}
function cleanRelations(scene: GeometryScene): GeometryScene {
  const byId = new Map(scene.points.map((p) => [p.id, p]))
  return {
    ...scene,
    rightAngles: (scene.rightAngles ?? []).filter((r) => {
      const o = byId.get(r.vertex),
        a = byId.get(r.from),
        b = byId.get(r.to)
      if (!o || !a || !b) return false
      const u = [a.x - o.x, a.y - o.y, a.z - o.z],
        v = [b.x - o.x, b.y - o.y, b.z - o.z]
      const scale = Math.hypot(...u) * Math.hypot(...v)
      return scale > 1e-12 && Math.abs(u.reduce((s, n, i) => s + n * v[i], 0)) <= scale * 1e-8
    }),
  }
}
export function GeometryWorkbench({
  value,
  onChange,
  disabled = false,
}: {
  value?: GeometryScene
  onChange: (scene: GeometryScene) => void
  disabled?: boolean
}) {
  const id = useId()
  const scene = value ?? initialScene
  const [history, setHistory] = useState<GeometryScene[]>([])
  const [selected, setSelected] = useState('')
  const [fields, setFields] = useState(emptyFields)
  const [ends, setEnds] = useState({ from: '', to: '', third: '' })
  const [dashed, setDashed] = useState(false)
  const [message, setMessage] = useState('')
  const [pending, setPending] = useState<'clear' | 'cube' | null>(null)
  const lastEmitted = useRef<GeometryScene | undefined>(value)
  const readonly = useRef(disabled)
  readonly.current = disabled
  function resetEditor() {
    setSelected('')
    setFields(emptyFields)
    setEnds({ from: '', to: '', third: '' })
    setDashed(false)
    setPending(null)
    setMessage('')
  }
  useEffect(() => {
    if (value !== lastEmitted.current) {
      setHistory([])
      resetEditor()
      lastEmitted.current = value
    }
  }, [value])
  useEffect(() => {
    if (disabled) resetEditor()
  }, [disabled])
  function commit(next: GeometryScene) {
    if (readonly.current) return false
    const cleaned = cleanRelations(next)
    const parsed = geometrySceneSchema.safeParse(cleaned)
    if (!parsed.success) {
      setMessage('无法保存：请检查坐标范围、重合点、线段端点和面的共面性。')
      return false
    }
    setHistory((old) => [...old.slice(-39), scene])
    lastEmitted.current = parsed.data
    onChange(parsed.data)
    setMessage('')
    return true
  }
  function selectPoint(pid: string) {
    if (readonly.current) return
    const point = scene.points.find((p) => p.id === pid)
    if (!point) return
    setSelected(pid)
    setFields({ label: point.label, x: String(point.x), y: String(point.y), z: String(point.z) })
  }
  function replace(next: GeometryScene) {
    if (commit(next)) resetEditor()
  }
  return (
    <section className="geometry-workbench" aria-labelledby={`${id}-title`}>
      <div className="geometry-heading">
        <div>
          <span className="eyebrow">EXPLORE · 3D</span>
          <h4 id={`${id}-title`}>三维坐标工作台</h4>
        </div>
        <span>
          {scene.points.length} 个点 · {scene.segments.length} 条线段
        </span>
      </div>
      <p className="geometry-help">
        每个点保存独立的 x、y、z 坐标；可连接线段、构造三角面并旋转观察。坐标范围 −100 到 100。
      </p>
      <div className="geometry-actions">
        <button
          type="button"
          disabled={disabled || !history.length}
          onClick={() => {
            if (readonly.current || !history.length) return
            const previous = history.at(-1)!
            setHistory(history.slice(0, -1))
            lastEmitted.current = previous
            onChange(previous)
            resetEditor()
          }}
        >
          撤销三维操作
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => (scene.points.length ? setPending('cube') : replace(cubeScene()))}
        >
          载入立方体示例
        </button>
        <button
          type="button"
          disabled={disabled || !scene.points.length}
          onClick={() => setPending('clear')}
        >
          清空三维图形
        </button>
      </div>
      {pending && (
        <div className="geometry-confirm" role="alert">
          {pending === 'clear' ? '清空当前三维图形？' : '用立方体替换当前三维图形？'}可以撤销。
          <button
            type="button"
            disabled={disabled}
            onClick={() => replace(pending === 'clear' ? emptyScene() : cubeScene())}
          >
            确认{pending === 'clear' ? '清空' : '替换'}
          </button>
          <button type="button" onClick={() => setPending(null)}>
            取消三维操作
          </button>
        </div>
      )}
      <GeometryFigure scene={scene} disabled={disabled} />
      <fieldset disabled={disabled} className="geometry-editors">
        <legend>精确编辑空间坐标</legend>
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            if (readonly.current) return
            const [x, y, z] = [fields.x, fields.y, fields.z].map(Number)
            if (
              [fields.x, fields.y, fields.z].some((v) => !v.trim()) ||
              [x, y, z].some((n) => !Number.isFinite(n) || Math.abs(n) > 100)
            ) {
              setMessage('三维坐标须为 −100 到 100 的有限数值。')
              return
            }
            if (!selected && scene.points.length >= 80) {
              setMessage('最多 80 个三维点。')
              return
            }
            if (
              scene.points.some((p) => p.id !== selected && p.x === x && p.y === y && p.z === z)
            ) {
              setMessage('该三维位置已有点，请编辑已有点。')
              return
            }
            let n = 1
            while (scene.points.some((p) => p.label === `P${n}`)) n++
            const point = {
              id: selected || `p-${crypto.randomUUID()}`,
              label:
                fields.label.trim() ||
                (selected ? scene.points.find((p) => p.id === selected)?.label : '') ||
                `P${n}`,
              x,
              y,
              z,
            }
            const candidate = cleanRelations({
              ...scene,
              points: selected
                ? scene.points.map((p) => (p.id === selected ? point : p))
                : [...scene.points, point],
            })
            const faces = (candidate.faces ?? []).filter(
              (face) => geometrySceneSchema.safeParse({ ...candidate, faces: [face] }).success,
            )
            const removedFaces = faces.length < (candidate.faces?.length ?? 0)
            if (commit({ ...candidate, faces })) {
              setSelected(point.id)
              setFields({ label: point.label, x: String(x), y: String(y), z: String(z) })
              if (removedFaces)
                setMessage('坐标已更新；不再共面或已退化的面已移除，可按新坐标重新构面。')
            }
          }}
        >
          <label>
            点标记
            <input
              aria-label="三维点标记"
              maxLength={40}
              value={fields.label}
              onChange={(event) => setFields({ ...fields, label: event.target.value })}
            />
          </label>
          {(['x', 'y', 'z'] as const).map((axis) => (
            <label key={axis}>
              {axis.toUpperCase()}
              <input
                aria-label={`三维 ${axis.toUpperCase()} 坐标`}
                type="number"
                min="-100"
                max="100"
                step="any"
                required
                value={fields[axis]}
                onChange={(event) => setFields({ ...fields, [axis]: event.target.value })}
              />
            </label>
          ))}
          <button type="submit">{selected ? '更新三维点' : '添加三维点'}</button>
          {selected && (
            <>
              <button
                type="button"
                onClick={() => {
                  setSelected('')
                  setFields(emptyFields)
                }}
              >
                新建三维点
              </button>
              <button
                type="button"
                onClick={() => {
                  commit({
                    ...scene,
                    points: scene.points.filter((p) => p.id !== selected),
                    segments: scene.segments.filter(
                      (s) => s.from !== selected && s.to !== selected,
                    ),
                    faces: (scene.faces ?? []).filter((f) => !f.points.includes(selected)),
                  })
                  resetEditor()
                }}
              >
                删除三维点及关联图形
              </button>
            </>
          )}
        </form>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (readonly.current) return
            if (!ends.from || !ends.to || ends.from === ends.to) {
              setMessage('请选择两个不同的三维点。')
              return
            }
            if (
              scene.segments.some(
                (s) =>
                  (s.from === ends.from && s.to === ends.to) ||
                  (s.from === ends.to && s.to === ends.from),
              )
            ) {
              setMessage('这两个点已有线段。')
              return
            }
            if (scene.segments.length >= 120) {
              setMessage('最多 120 条三维线段。')
              return
            }
            commit({
              ...scene,
              segments: [
                ...scene.segments,
                { id: `s-${crypto.randomUUID()}`, from: ends.from, to: ends.to, dashed },
              ],
            })
          }}
        >
          {(
            [
              ['from', '起点'],
              ['to', '终点'],
              ['third', '第三点（构面）'],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              {label}
              <select
                aria-label={`三维${label}`}
                value={ends[key]}
                onChange={(event) => setEnds({ ...ends, [key]: event.target.value })}
              >
                <option value="">请选择</option>
                {scene.points.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <label className="geometry-check">
            <input
              type="checkbox"
              checked={dashed}
              onChange={(event) => setDashed(event.target.checked)}
            />
            虚线线段
          </label>
          <button type="submit">添加三维线段</button>
          <button
            type="button"
            onClick={() => {
              if (readonly.current) return
              if ((scene.faces?.length ?? 0) >= 30) {
                setMessage('最多 30 个三维面。')
                return
              }
              const ids = [ends.from, ends.to, ends.third]
              if (ids.some((pid) => !pid) || new Set(ids).size !== 3) {
                setMessage('请选择三个不同且不共线的点来构面。')
                return
              }
              if (
                (scene.faces ?? []).some(
                  (face) =>
                    face.points.length === 3 && ids.every((pid) => face.points.includes(pid)),
                )
              ) {
                setMessage('这三个点已有三角面。')
                return
              }
              commit({
                ...scene,
                faces: [...(scene.faces ?? []), { id: `s-${crypto.randomUUID()}`, points: ids }],
              })
            }}
          >
            添加三角面
          </button>
        </form>
      </fieldset>
      <div className="geometry-point-list" aria-label="三维点列表">
        {scene.points.map((p) => (
          <button
            type="button"
            key={p.id}
            disabled={disabled}
            aria-pressed={selected === p.id}
            onClick={() => selectPoint(p.id)}
          >
            {p.label} ({p.x}, {p.y}, {p.z})
          </button>
        ))}
      </div>
      {!!scene.segments.length && (
        <div className="geometry-point-list" aria-label="三维线段列表">
          {scene.segments.map((s) => (
            <button
              type="button"
              key={s.id}
              disabled={disabled}
              onClick={() =>
                commit({ ...scene, segments: scene.segments.filter((other) => other.id !== s.id) })
              }
            >
              删除空间线段 {scene.points.find((p) => p.id === s.from)?.label}—
              {scene.points.find((p) => p.id === s.to)?.label}
            </button>
          ))}
        </div>
      )}
      {!!scene.faces?.length && (
        <div className="geometry-point-list" aria-label="三维面列表">
          {scene.faces.map((face) => (
            <button
              type="button"
              key={face.id}
              disabled={disabled}
              onClick={() =>
                commit({ ...scene, faces: scene.faces?.filter((f) => f.id !== face.id) })
              }
            >
              删除面{' '}
              {face.points.map((pid) => scene.points.find((p) => p.id === pid)?.label).join('—')}
            </button>
          ))}
        </div>
      )}
      {message && (
        <p className="geometry-message" role="alert">
          {message}
        </p>
      )}
      {!scene.points.length && (
        <p className="geometry-help">从输入一个空间点开始，或载入立方体示例。</p>
      )}
    </section>
  )
}
