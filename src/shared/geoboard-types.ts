/** Independent, bounded 2-D constructions. Missing on legacy drafts; never migrated in place. */
export interface BoardVec {
  x: number
  y: number
}
export interface BoardStyle {
  color: string
  visible: boolean
  label: string
  fill: boolean
}
interface Base extends BoardStyle {
  id: string
}
export type BoardPoint = Base &
  (
    | { kind: 'free'; x: number; y: number; locked: boolean }
    | { kind: 'midpoint'; a: string; b: string }
    | { kind: 'projection'; point: string; line: string }
    | { kind: 'intersection'; a: string; b: string; branch: 0 | 1 }
    | { kind: 'on-object'; object: string; parameter: number }
    | { kind: 'reflection'; point: string; line: string }
  )
export type BoardObject = Base &
  (
    | { kind: 'segment' | 'line' | 'ray'; from: string; to: string }
    | { kind: 'parallel' | 'perpendicular'; through: string; line: string }
    | { kind: 'circle'; center: string; through: string }
    | { kind: 'fixed-circle'; center: string; radius: number }
    | { kind: 'circumcircle'; a: string; b: string; c: string }
    | { kind: 'polygon'; points: string[] }
    | { kind: 'arc'; center: string; start: string; end: string }
    | { kind: 'tangent'; point: string; circle: string; branch: 0 | 1 }
  )
export type BoardNode = BoardPoint | BoardObject
export interface GeoboardState {
  version: 1
  points: BoardPoint[]
  objects: BoardObject[]
  view: {
    x: number
    y: number
    scale: number
    grid: 'square' | 'isometric' | 'circular' | 'none'
    step: number
    snap: boolean
    axes: boolean
    labels: boolean
  }
}
export const BOARD_LIMITS = Object.freeze({
  points: 200,
  objects: 300,
  coordinate: 10000,
  label: 80,
  polygon: 80,
  history: 80,
})
export const emptyGeoboard = (): GeoboardState => ({
  version: 1,
  points: [],
  objects: [],
  view: { x: 0, y: 0, scale: 32, grid: 'square', step: 1, snap: true, axes: true, labels: true },
})
export const boardStyle = (label = '', color = '#3d9ee8'): BoardStyle => ({
  label,
  color,
  visible: true,
  fill: false,
})
