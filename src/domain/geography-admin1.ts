import { CANVAS, coordinateToSvg } from './coordinates'
import { geographicToSvg, geoViewport } from './geography-map'
import type { GeoMapPreferences } from '../shared/types'

export interface AdminLabel {
  id: string
  name: string
  localName: string
  sourceAdmin: string
  sourceCountryCode: string
  longitude: number
  latitude: number
  rank: number
  scaleRank: number
  fclassCn: string
  fclassUs: string
}
export interface AdminLine {
  classification: string
  sourceCountryCode: string
  rank: number
  fclassCn: string
  fclassUs: string
  parts: number[][][]
}
export interface AdminData {
  labels: AdminLabel[]
  lines: AdminLine[]
}
export interface PreparedAdminData {
  labels: AdminLabel[]
  parts: {
    bounds: { minX: number; maxX: number; minY: number; maxY: number }
    path: string
    category: 'boundary' | 'statistical' | 'unrecognized'
    points: number
  }[]
}

/** Never join two source parts or draw a line across the antimeridian. */
export function splitAntimeridian(part: number[][]): number[][][] {
  const parts: number[][][] = []
  let current: number[][] = []
  for (const point of part) {
    if (
      !Number.isFinite(point[0]) ||
      !Number.isFinite(point[1]) ||
      Math.abs(point[0]) > 180 ||
      Math.abs(point[1]) > 90
    ) {
      if (current.length > 1) parts.push(current)
      current = []
      continue
    }
    if (current.length && Math.abs(point[0] - current[current.length - 1][0]) > 180) {
      if (current.length > 1) parts.push(current)
      current = []
    }
    current.push(point)
  }
  if (current.length > 1) parts.push(current)
  return parts
}

export function prepareAdminData(data: AdminData): PreparedAdminData {
  const parts: PreparedAdminData['parts'] = []
  let count = 0
  for (const line of [...data.lines].slice(0, 11000).sort((a, b) => a.rank - b.rank)) {
    for (const part of line.parts.flatMap(splitAntimeridian)) {
      if (count + part.length > 120000) continue
      count += part.length
      const xs = part.map((p) => p[0]),
        ys = part.map((p) => p[1])
      parts.push({
        bounds: {
          minX: Math.min(...xs),
          maxX: Math.max(...xs),
          minY: Math.min(...ys),
          maxY: Math.max(...ys),
        },
        category: line.classification.startsWith('Unrecognized')
          ? 'unrecognized'
          : line.classification.includes('statistical')
            ? 'statistical'
            : 'boundary',
        points: part.length,
        path: part
          .map(([x, y], index) => {
            const p = coordinateToSvg({ x, y }, 'geographic')
            return `${index ? 'L' : 'M'}${p.x.toFixed(3)} ${p.y.toFixed(3)}`
          })
          .join(' '),
      })
    }
  }
  return {
    parts,
    labels: [...data.labels]
      .slice(0, 5000)
      .sort((a, b) => a.rank - b.rank || a.scaleRank - b.scaleRank || a.id.localeCompare(b.id)),
  }
}

let pending: Promise<PreparedAdminData> | undefined
export function loadAdminData(): Promise<PreparedAdminData> {
  // Vite creates a separate local chunk. No online map service or request is used.
  return (pending ??= import('../assets/geography/natural-earth-admin1.json')
    .then((module) => prepareAdminData(module.default))
    .catch((error: unknown) => {
      pending = undefined
      throw error
    }))
}

export function visibleAdminPaths(data: PreparedAdminData, view: GeoMapPreferences) {
  const result = { boundary: '', statistical: '', unrecognized: '' }
  if (view.zoom < 2) return result
  const bounds = geoViewport(view)
  let points = 0,
    parts = 0
  for (const part of data.parts) {
    const b = part.bounds
    if (
      b.maxX < bounds.minX ||
      b.minX > bounds.maxX ||
      b.maxY < bounds.minY ||
      b.minY > bounds.maxY
    )
      continue
    if (points + part.points > 70000 || parts >= 8000) break
    points += part.points
    parts += 1
    result[part.category] += part.path + ' '
  }
  return result
}

export function visibleAdminLabels(data: PreparedAdminData, view: GeoMapPreferences, show = true) {
  if (view.zoom < 2 || !show) return []
  const labels: (AdminLabel & { x: number; y: number })[] = []
  const boxes: { x: number; y: number; width: number; height: number }[] = []
  for (const label of data.labels) {
    if (labels.length >= 70) break
    if (!label.name || label.name.length > 30) continue
    const p = geographicToSvg({ x: label.longitude, y: label.latitude }, view)
    const width = Array.from(label.name).reduce(
      (sum, char) => sum + (/[^\x00-\x7F]/.test(char) ? 11 : 6),
      0,
    )
    const box = { x: p.x - width / 2, y: p.y - 8, width, height: 15 }
    if (
      box.x < CANVAS.left + 2 ||
      box.x + width > CANVAS.right - 2 ||
      box.y < CANVAS.top + 2 ||
      box.y + 15 > CANVAS.bottom - 2
    )
      continue
    if (
      boxes.some(
        (b) =>
          box.x < b.x + b.width + 8 &&
          box.x + width + 8 > b.x &&
          box.y < b.y + b.height + 5 &&
          box.y + 20 > b.y,
      )
    )
      continue
    boxes.push(box)
    labels.push({ ...label, x: p.x, y: p.y })
  }
  return labels
}
