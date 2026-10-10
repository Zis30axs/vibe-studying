import type { GeoDrawing } from '../shared/types'

export type CoordinateMode = GeoDrawing['mode']
export interface Coordinate {
  x: number
  y: number
}
export interface ClientRect {
  left: number
  top: number
  width: number
  height: number
}
export const CANVAS = { width: 800, height: 480, left: 56, right: 752, top: 36, bottom: 436 }

export function coordinateBounds(mode: CoordinateMode) {
  return mode === 'geographic'
    ? { minX: -180, maxX: 180, minY: -90, maxY: 90 }
    : { minX: -10, maxX: 10, minY: -10, maxY: 10 }
}

export function isValidCoordinate(point: Coordinate, mode: CoordinateMode): boolean {
  const bounds = coordinateBounds(mode)
  return (
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    point.x >= bounds.minX &&
    point.x <= bounds.maxX &&
    point.y >= bounds.minY &&
    point.y <= bounds.maxY
  )
}

export function coordinateToSvg(point: Coordinate, mode: CoordinateMode): Coordinate {
  const bounds = coordinateBounds(mode)
  return {
    x:
      CANVAS.left +
      ((point.x - bounds.minX) / (bounds.maxX - bounds.minX)) * (CANVAS.right - CANVAS.left),
    y:
      CANVAS.bottom -
      ((point.y - bounds.minY) / (bounds.maxY - bounds.minY)) * (CANVAS.bottom - CANVAS.top),
  }
}

/** Match SVG's xMidYMid meet transform, including any letterboxing. */
export function clientToCoordinate(
  client: Coordinate,
  rect: ClientRect,
  mode: CoordinateMode,
): Coordinate | null {
  if (
    ![client.x, client.y, rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) ||
    rect.width <= 0 ||
    rect.height <= 0
  )
    return null
  const scale = Math.min(rect.width / CANVAS.width, rect.height / CANVAS.height)
  const x = (client.x - rect.left - (rect.width - CANVAS.width * scale) / 2) / scale
  const y = (client.y - rect.top - (rect.height - CANVAS.height * scale) / 2) / scale
  if (x < CANVAS.left || x > CANVAS.right || y < CANVAS.top || y > CANVAS.bottom) return null
  const bounds = coordinateBounds(mode)
  return {
    x: Number(
      (
        bounds.minX +
        ((x - CANVAS.left) / (CANVAS.right - CANVAS.left)) * (bounds.maxX - bounds.minX)
      ).toFixed(2),
    ),
    y: Number(
      (
        bounds.maxY -
        ((y - CANVAS.top) / (CANVAS.bottom - CANVAS.top)) * (bounds.maxY - bounds.minY)
      ).toFixed(2),
    ),
  }
}

export function removeDrawingPoint(drawing: GeoDrawing, pointId: string): GeoDrawing {
  return {
    ...drawing,
    points: drawing.points.filter((point) => point.id !== pointId),
    lines: drawing.lines.filter((line) => line.from !== pointId && line.to !== pointId),
  }
}

export function canConnectPoints(drawing: GeoDrawing, from: string, to: string): boolean {
  return (
    from !== to &&
    drawing.points.some((point) => point.id === from) &&
    drawing.points.some((point) => point.id === to) &&
    !drawing.lines.some(
      (line) => (line.from === from && line.to === to) || (line.from === to && line.to === from),
    )
  )
}
