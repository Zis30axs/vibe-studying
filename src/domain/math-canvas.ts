import type { ClientRect, Coordinate } from './coordinates'

export const MIN_SNAP_STEP = 0.01
export const MAX_SNAP_STEP = 10
export const DEFAULT_SNAP_STEP = 1
export const DEFAULT_PROJECTION_COLOR = '#b8c0c8'
const UNITS = 1_000_000

export function isValidSnapStep(step: number): boolean {
  return (
    Number.isFinite(step) &&
    step >= MIN_SNAP_STEP &&
    step <= MAX_SNAP_STEP &&
    Math.abs(step * UNITS - Math.round(step * UNITS)) < 1e-6
  )
}

/** Round symmetrically; stay on the selected grid even when its spacing does not divide the bounds. */
export function snapMathCoordinate(value: number, step: number): number {
  if (!Number.isFinite(value) || !isValidSnapStep(step))
    throw new RangeError('无效的坐标或吸附步长')
  const units = Math.round(step * UNITS)
  const index = Math.min(
    Math.floor((10 * UNITS) / units),
    Math.floor((Math.abs(value) * UNITS) / units + 0.5 + 1e-9),
  )
  const result = (Math.sign(value) * index * units) / UNITS
  return result === 0 ? 0 : result
}

export function nextSnapStep(step: number, direction: 'finer' | 'coarser'): number {
  if (!isValidSnapStep(step)) throw new RangeError('无效的吸附步长')
  if (direction === 'finer') {
    if (step > 1) return 1
    if (step > 0.5) return 0.5
    if (step > 0.25) return 0.25
    return Math.max(MIN_SNAP_STEP, (Math.round(step * UNITS) - 10_000) / UNITS)
  }
  if (step < 0.25) return Math.min(0.25, (Math.round(step * UNITS) + 10_000) / UNITS)
  if (step < 0.5) return 0.5
  if (step < 1) return 1
  return step
}

/** Pure equivalent of the SVG xMidYMid meet transform, including CSS sizing and letterboxing. */
export function clientToMathSvg(point: Coordinate, rect: ClientRect): Coordinate | null {
  if (
    ![point.x, point.y, rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) ||
    rect.width <= 0 ||
    rect.height <= 0
  )
    return null
  const scale = Math.min(rect.width, rect.height) / 560
  if (!Number.isFinite(scale) || scale <= 0) return null
  const result = {
    x: (point.x - rect.left - (rect.width - 560 * scale) / 2) / scale,
    y: (point.y - rect.top - (rect.height - 560 * scale) / 2) / scale,
  }
  return Number.isFinite(result.x) && Number.isFinite(result.y) ? result : null
}

export function mathCoordinateFromSvg(
  point: Coordinate,
  step: number,
): (Coordinate & { inside: boolean }) | null {
  if (![point.x, point.y].every(Number.isFinite) || !isValidSnapStep(step)) return null
  return {
    x: snapMathCoordinate((point.x - 280) / 24, step),
    y: snapMathCoordinate((280 - point.y) / 24, step),
    inside: point.x >= 40 && point.x <= 520 && point.y >= 40 && point.y <= 520,
  }
}

export function mathTooltipPosition(
  point: Coordinate,
  container: { width: number; height: number },
  size = { width: 180, height: 76 },
): { left: number; top: number } {
  const margin = 8,
    gap = 14
  const width = Math.min(size.width, Math.max(0, container.width - 2 * margin))
  const height = Math.min(size.height, Math.max(0, container.height - 2 * margin))
  const left =
    point.x + gap + width <= container.width - margin ? point.x + gap : point.x - gap - width
  const top =
    point.y + gap + height <= container.height - margin ? point.y + gap : point.y - gap - height
  return {
    left: Math.max(
      Math.min(margin, container.width / 2),
      Math.min(left, container.width - width - margin),
    ),
    top: Math.max(
      Math.min(margin, container.height / 2),
      Math.min(top, container.height - height - margin),
    ),
  }
}

export function axisDistances(point: Coordinate): { toXAxis: number; toYAxis: number } {
  return { toXAxis: Math.abs(point.y), toYAxis: Math.abs(point.x) }
}

/** Try several nearby positions; omit colliding labels rather than covering other distances. */
export function placeProjectionLabels(points: (Coordinate & { id: string })[]) {
  const occupied: { x: number; y: number; width: number; height: number }[] = []
  const labels: { id: string; x: number; y: number; text: string }[] = []
  const seen = new Set<string>()
  for (const point of points) {
    const px = 280 + point.x * 24,
      py = 280 - point.y * 24
    const distances = axisDistances(point)
    for (const [axis, distance, cx, cy] of [
      ['x', distances.toXAxis, px, (py + 280) / 2],
      ['y', distances.toYAxis, (px + 280) / 2, py],
    ] as const) {
      const text = `到 ${axis} 轴 ${Number(distance.toFixed(6))}`
      const key = `${axis}:${cx}:${cy}:${distance}`
      if (seen.has(key)) continue
      seen.add(key)
      const width = Math.min(
          160,
          Array.from(text).reduce(
            (width, char) => width + (/[^\x00-\x7F]/.test(char) ? 11 : 6.5),
            10,
          ),
        ),
        height = 18
      for (const [dx, dy] of [
        [7, -10],
        [-width - 7, -10],
        [7, 10],
        [-width - 7, 10],
        [-width / 2, -24],
        [-width / 2, 24],
      ]) {
        const x = Math.max(42, Math.min(518 - width, cx + dx))
        const y = Math.max(42, Math.min(518 - height, cy + dy))
        if (
          occupied.some(
            (r) =>
              x < r.x + r.width + 3 &&
              x + width + 3 > r.x &&
              y < r.y + r.height + 3 &&
              y + height + 3 > r.y,
          )
        )
          continue
        occupied.push({ x, y, width, height })
        labels.push({ id: `${point.id}-${axis}`, x: x + 5, y: y + 13, text })
        break
      }
    }
  }
  return labels
}
