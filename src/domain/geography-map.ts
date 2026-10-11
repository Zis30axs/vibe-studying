import type { GeoMapPreferences, GeoPoint } from '../shared/types'
import { CANVAS, coordinateToSvg, type ClientRect, type Coordinate } from './coordinates'
import land from '../assets/geography/natural-earth-land-rings.json'

export const MAP_SOURCE = {
  publisher: 'Natural Earth',
  checked: '2026-10-11',
  landVersion: '4.1.0',
  terrainVersion: '3.2.0',
  license: 'Public domain',
} as const

export const DEFAULT_GEO_MAP: Readonly<GeoMapPreferences> = Object.freeze({
  layer: 'outline',
  longitude: 0,
  latitude: 0,
  zoom: 1,
  showGrid: true,
})

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const finite = (value: number | undefined, fallback: number) =>
  Number.isFinite(value) ? value! : fallback

/** Clamp the viewport inside the world; do not alter saved annotation coordinates. */
export function normalizeGeoMap(value?: Partial<GeoMapPreferences>): GeoMapPreferences {
  const zoom = clamp(finite(value?.zoom, 1), 1, 8)
  return {
    layer: value?.layer === 'terrain' || value?.layer === 'admin1' ? value.layer : 'outline',
    longitude: clamp(finite(value?.longitude, 0), -180 + 180 / zoom, 180 - 180 / zoom),
    latitude: clamp(finite(value?.latitude, 0), -90 + 90 / zoom, 90 - 90 / zoom),
    zoom,
    showGrid: value?.showGrid !== false,
    showLabels: value?.showLabels !== false,
  }
}

export function geoViewport(value?: Partial<GeoMapPreferences>) {
  const view = normalizeGeoMap(value)
  return {
    minX: view.longitude - 180 / view.zoom,
    maxX: view.longitude + 180 / view.zoom,
    minY: view.latitude - 90 / view.zoom,
    maxY: view.latitude + 90 / view.zoom,
  }
}

export function geographicToSvg(point: Coordinate, value?: Partial<GeoMapPreferences>): Coordinate {
  const view = normalizeGeoMap(value)
  return coordinateToSvg(
    { x: (point.x - view.longitude) * view.zoom, y: (point.y - view.latitude) * view.zoom },
    'geographic',
  )
}

/** Match xMidYMid meet, retaining four-decimal geographic precision at every zoom. */
export function clientToGeographic(
  client: Coordinate,
  rect: ClientRect,
  value?: Partial<GeoMapPreferences>,
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
  const world = {
    x: -180 + ((x - CANVAS.left) / (CANVAS.right - CANVAS.left)) * 360,
    y: 90 - ((y - CANVAS.top) / (CANVAS.bottom - CANVAS.top)) * 180,
  }
  const view = normalizeGeoMap(value)
  return {
    x: Number((world.x / view.zoom + view.longitude).toFixed(4)),
    y: Number((world.y / view.zoom + view.latitude).toFixed(4)),
  }
}

export function moveGeoMap(
  value: GeoMapPreferences,
  longitude: number,
  latitude: number,
): GeoMapPreferences {
  return normalizeGeoMap({
    ...value,
    longitude: value.longitude + longitude,
    latitude: value.latitude + latitude,
  })
}

export function mapImageRect(value?: Partial<GeoMapPreferences>) {
  const view = normalizeGeoMap(value)
  return {
    ...geographicToSvg({ x: -180, y: 90 }, view),
    width: (CANVAS.right - CANVAS.left) * view.zoom,
    height: (CANVAS.bottom - CANVAS.top) * view.zoom,
  }
}

/** Source rasters and coastlines get exactly the same affine transform as annotations. */
export function mapWorldTransform(value?: Partial<GeoMapPreferences>): string {
  const view = normalizeGeoMap(value)
  const origin = geographicToSvg({ x: -180, y: 90 }, view)
  return `translate(${origin.x - CANVAS.left * view.zoom} ${origin.y - CANVAS.top * view.zoom}) scale(${view.zoom})`
}

// 128 rings / 5,143 vertices, bundled from the public-domain source. Even-odd
// fill preserves holes. Source coastlines already split at the antimeridian.
export const LAND_OUTLINE_PATH = land.rings
  .map(
    (ring) =>
      ring
        .map(([x, y], index) => {
          const point = coordinateToSvg({ x, y }, 'geographic')
          return `${index === 0 ? 'M' : 'L'}${point.x.toFixed(3)} ${point.y.toFixed(3)}`
        })
        .join(' ') + ' Z',
  )
  .join(' ')

export function mapTicks(value: GeoMapPreferences, axis: 'x' | 'y'): number[] {
  const bounds = geoViewport(value)
  const min = axis === 'x' ? bounds.minX : bounds.minY
  const max = axis === 'x' ? bounds.maxX : bounds.maxY
  const step = [1, 2, 5, 10, 15, 30, 60].find((candidate) => (max - min) / candidate <= 8) ?? 60
  const ticks: number[] = []
  for (let tick = Math.ceil(min / step) * step; tick <= max; tick += step)
    ticks.push(tick === 0 ? 0 : tick)
  return ticks
}

export interface MapPointLabel {
  id: string
  text: string
  x: number
  y: number
  anchor: 'start' | 'end'
}

/** Bounded, deterministic decluttering. Full labels remain in the point list. */
export function layoutMapPointLabels(
  points: GeoPoint[],
  view: GeoMapPreferences,
  selectedId?: string | null,
): MapPointLabel[] {
  const boxes: { x: number; y: number; width: number; height: number }[] = []
  const labels: MapPointLabel[] = []
  const ordered = [...points].sort(
    (a, b) => Number(b.id === selectedId) - Number(a.id === selectedId),
  )
  for (const point of ordered.slice(0, 200)) {
    if (labels.length >= 80) break
    const p = geographicToSvg(point, view)
    if (p.x < CANVAS.left || p.x > CANVAS.right || p.y < CANVAS.top || p.y > CANVAS.bottom) continue
    const chars = Array.from(point.label)
    const text = chars.length > 18 ? chars.slice(0, 17).join('') + '…' : point.label
    const width = Array.from(text).reduce(
      (sum, char) => sum + (/[^\x00-\x7F]/.test(char) ? 13 : 7),
      0,
    )
    for (const [dx, dy] of [
      [12, -10],
      [12, 20],
      [-12, -10],
      [-12, 20],
    ]) {
      const anchor = dx > 0 ? 'start' : 'end'
      const box = {
        x: p.x + dx - (anchor === 'end' ? width : 0),
        y: p.y + dy - 13,
        width,
        height: 17,
      }
      if (
        box.x < CANVAS.left ||
        box.x + width > CANVAS.right ||
        box.y < CANVAS.top ||
        box.y + box.height > CANVAS.bottom
      )
        continue
      if (
        boxes.some(
          (b) =>
            box.x < b.x + b.width + 5 &&
            box.x + box.width + 5 > b.x &&
            box.y < b.y + b.height + 3 &&
            box.y + box.height + 3 > b.y,
        )
      )
        continue
      boxes.push(box)
      labels.push({ id: point.id, text, x: p.x + dx, y: p.y + dy, anchor })
      break
    }
  }
  return labels
}
