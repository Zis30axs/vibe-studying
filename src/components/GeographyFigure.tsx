import { useId } from 'react'
import { geographyFigureSchema } from '../domain/geography-figure'
import type { GeographyFigure as Figure } from '../shared/types'
import './GeographyFigure.css'

const MAX_DISPLAY_LABEL_CHARACTERS = 14
const displayedLabel = (text: string) => {
  const characters = Array.from(text)
  return characters.length > MAX_DISPLAY_LABEL_CHARACTERS
    ? `${characters.slice(0, MAX_DISPLAY_LABEL_CHARACTERS).join('')}…`
    : text
}

/** Canonical SVG only. Model content cannot choose tags, attributes, CSS, URLs,
 * event handlers, view boxes, marker identifiers, or executable markup. */
export function GeographyFigure({ figure }: { figure: Figure }) {
  const instanceId = useId().replace(/[^A-Za-z0-9_-]/g, '')
  const parsed = geographyFigureSchema.safeParse(figure)
  if (!parsed.success)
    return (
      <p className="geography-figure-error" role="alert">
        示意图结构无效，已停止显示。
      </p>
    )
  const safe = parsed.data
  const truncatedLabels = [
    ...safe.points
      .filter((point) => point.label)
      .map((point) => ({ id: point.id, text: point.label! })),
    ...safe.labels,
  ].filter((label) => Array.from(label.text).length > MAX_DISPLAY_LABEL_CHARACTERS)
  const byId = new Map(safe.points.map((point) => [point.id, point]))
  const pointList = (ids: string[]) =>
    ids
      .map((id) => {
        const point = byId.get(id)!
        return `${point.x},${-point.y}`
      })
      .join(' ')
  const gridLines = safe.grid
    ? Array.from(
        { length: Math.floor(200 / safe.grid.step) + 1 },
        (_, index) => -100 + index * safe.grid!.step,
      )
    : []
  const marker = `geo-arrow-${instanceId}`
  return (
    <figure className="geography-figure">
      <div className="geography-figure-heading">
        <strong>{safe.title}</strong>
        <span>示意图 · 非实测地图</span>
      </div>
      <svg
        viewBox="-125 -125 250 250"
        role="img"
        aria-labelledby={`geo-title-${instanceId} geo-description-${instanceId}`}
      >
        <title id={`geo-title-${instanceId}`}>{safe.title}</title>
        <desc id={`geo-description-${instanceId}`}>
          {safe.description}。仅通过结构校验，地理事实与比例尚未核实。
        </desc>
        <defs>
          <marker
            id={marker}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
          </marker>
        </defs>
        <rect x="-100" y="-100" width="200" height="200" className="geography-figure-frame" />
        <g className="geography-figure-grid">
          {gridLines.map((position, index) => (
            <g key={index}>
              <line x1={position} y1={-100} x2={position} y2={100} />
              <line x1={-100} y1={position} x2={100} y2={position} />
            </g>
          ))}
        </g>
        <g className="geography-figure-regions">
          {safe.polygons.map((polygon) => (
            <polygon key={polygon.id} points={pointList(polygon.points)} />
          ))}
        </g>
        <g className="geography-figure-lines">
          {safe.segments.map((line) => (
            <polyline key={line.id} points={pointList([line.from, line.to])} />
          ))}
          {safe.polylines.map((line) => (
            <polyline key={line.id} points={pointList(line.points)} />
          ))}
        </g>
        <g className="geography-figure-arrows">
          {safe.arrows.map((line) => (
            <polyline
              key={line.id}
              points={pointList([line.from, line.to])}
              markerEnd={`url(#${marker})`}
            />
          ))}
        </g>
        <g className="geography-figure-points">
          {safe.points.map((point) => (
            <circle key={point.id} cx={point.x} cy={-point.y} r={1.7} />
          ))}
        </g>
        <g className="geography-figure-labels">
          {safe.points
            .filter((point) => point.label)
            .map((point) => (
              <text
                key={point.id}
                x={point.x + (point.x > 0 ? -3 : 3)}
                y={-point.y - 3}
                textAnchor={point.x > 0 ? 'end' : 'start'}
              >
                <title>{point.label}</title>
                {displayedLabel(point.label!)}
              </text>
            ))}
          {safe.labels.map((label) => (
            <text
              key={label.id}
              x={label.x}
              y={-label.y}
              textAnchor={label.x > 0 ? 'end' : 'start'}
            >
              <title>{label.text}</title>
              {displayedLabel(label.text)}
            </text>
          ))}
        </g>
      </svg>
      {truncatedLabels.length > 0 && (
        <div className="geography-figure-legend" aria-label="图中长标签全文">
          <strong>长标签全文</strong>
          <ul>
            {truncatedLabels.map((label) => (
              <li key={label.id}>{label.text}</li>
            ))}
          </ul>
        </div>
      )}
      <figcaption>
        {safe.description}
        <small>仅校验结构与绘图范围；地理事实、比例和参考答案未经人工核实。</small>
      </figcaption>
    </figure>
  )
}
