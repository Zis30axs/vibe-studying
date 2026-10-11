/** Metres in a local, synthetic teaching plane. Never geographic coordinates or real DEM. */
export type TerrainPreset = 'peak' | 'depression' | 'ridge' | 'saddle' | 'plane'
export interface TerrainSpec {
  version: 1
  preset: TerrainPreset
  widthM: number
  heightM: number
  baseElevationM: number
  reliefM: number
  contourIntervalM: number
  gridCells: number
}
export interface TerrainPoint {
  xM: number
  yM: number
}
export interface TerrainExercise {
  version: 1
  kind: 'synthetic-terrain'
  terrain: TerrainSpec
  section: 'west-center' | 'south-center' | 'west-east'
}
export interface TerrainContour {
  id: string
  elevationM: number
  points: TerrainPoint[]
  closed: boolean
}
export interface TerrainGrid {
  spec: TerrainSpec
  id: string
  elevations: number[]
  minimumM: number
  maximumM: number
  cellWidthM: number
  cellHeightM: number
}
