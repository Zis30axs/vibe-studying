import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFile } from 'node:fs/promises'
import { GeographyWorkbench } from '../src/components/GeographyWorkbench'
import { CANVAS, coordinateToSvg } from '../src/domain/coordinates'
import {
  DEFAULT_GEO_MAP,
  normalizeGeoMap,
  geographicToSvg,
  clientToGeographic,
  mapImageRect,
  mapWorldTransform,
  geoViewport,
  moveGeoMap,
  mapTicks,
  LAND_OUTLINE_PATH,
  layoutMapPointLabels,
} from '../src/domain/geography-map'
import {
  loadAdminData,
  splitAntimeridian,
  visibleAdminLabels,
  visibleAdminPaths,
} from '../src/domain/geography-admin1'
import { drawingSchema, draftSchema } from '../src/domain/schemas'
import { emptyDraft, type GeoDrawing } from '../src/shared/types'
import land from '../src/assets/geography/natural-earth-land-rings.json'

describe('offline map projection', () => {
  it('aligns world raster and coastlines with all four world corners and origin', () => {
    const rect = mapImageRect()
    expect(rect).toEqual({
      x: CANVAS.left,
      y: CANVAS.top,
      width: CANVAS.right - CANVAS.left,
      height: CANVAS.bottom - CANVAS.top,
    })
    expect(geographicToSvg({ x: -180, y: 90 })).toEqual({ x: rect.x, y: rect.y })
    expect(geographicToSvg({ x: 180, y: -90 })).toEqual({
      x: rect.x + rect.width,
      y: rect.y + rect.height,
    })
    expect(geographicToSvg({ x: 0, y: 0 })).toEqual(coordinateToSvg({ x: 0, y: 0 }, 'geographic'))
    expect(mapWorldTransform()).toBe('translate(0 0) scale(1)')
    expect(LAND_OUTLINE_PATH.match(/M/g)).toHaveLength(128)
    expect(LAND_OUTLINE_PATH.match(/Z/g)).toHaveLength(128)
    expect(LAND_OUTLINE_PATH).not.toMatch(/NaN|Infinity/)
  })

  it.each([1, 2, 4, 8])(
    'keeps image corners, click inverse and coastline transform aligned at %ix',
    (zoom) => {
      const view = normalizeGeoMap({ zoom, longitude: 110, latitude: 30 })
      const rect = mapImageRect(view)
      expect(geographicToSvg({ x: -180, y: 90 }, view)).toEqual({ x: rect.x, y: rect.y })
      const southeast = geographicToSvg({ x: 180, y: -90 }, view)
      expect(southeast.x).toBeCloseTo(rect.x + rect.width, 8)
      expect(southeast.y).toBeCloseTo(rect.y + rect.height, 8)
      for (const point of [
        { x: view.longitude, y: view.latitude },
        { x: view.longitude + 12.3456 / zoom, y: view.latitude - 20.3456 / zoom },
      ]) {
        const svg = geographicToSvg(point, view)
        for (const screen of [
          { left: 31, top: 90, width: 400, height: 240 },
          { left: 11, top: 20, width: 1200, height: 480 },
          { left: 80, top: 30, width: 800, height: 960 },
        ]) {
          const scale = Math.min(screen.width / CANVAS.width, screen.height / CANVAS.height)
          const client = {
            x: screen.left + (screen.width - CANVAS.width * scale) / 2 + svg.x * scale,
            y: screen.top + (screen.height - CANVAS.height * scale) / 2 + svg.y * scale,
          }
          const actual = clientToGeographic(client, screen, view)!
          expect(actual.x).toBeCloseTo(point.x, 4)
          expect(actual.y).toBeCloseTo(point.y, 4)
        }
      }
    },
  )

  it('rejects gutters/nonfinite coordinates and clamps pan/zoom without wrapping boundaries', () => {
    const screen = { left: 0, top: 0, width: 800, height: 480 }
    for (const point of [
      { x: 0, y: 200 },
      { x: 400, y: 10 },
      { x: NaN, y: 0 },
    ])
      expect(clientToGeographic(point, screen)).toBeNull()
    expect(clientToGeographic({ x: 100, y: 100 }, { ...screen, width: 0 })).toBeNull()
    expect(normalizeGeoMap({ longitude: Infinity, latitude: NaN, zoom: 0 })).toMatchObject(
      DEFAULT_GEO_MAP,
    )
    const edge = normalizeGeoMap({ longitude: 180, latitude: 90, zoom: 8 })
    expect(geoViewport(edge)).toEqual({ minX: 135, maxX: 180, minY: 67.5, maxY: 90 })
    expect(moveGeoMap(edge, 45, 30)).toEqual(edge)
    expect(normalizeGeoMap({ ...edge, zoom: 1 })).toMatchObject({ longitude: 0, latitude: 0 })
    for (const axis of ['x', 'y'] as const)
      expect(mapTicks(edge, axis).length).toBeLessThanOrEqual(9)
  })

  it('preserves coastline rings, finite WGS84 vertices and seams without false world chords', () => {
    expect(land.crs).toBe('EPSG:4326')
    expect(land.source).toContain('4.1.0')
    expect(land.rings.reduce((n, ring) => n + ring.length, 0)).toBe(5143)
    for (const ring of land.rings) {
      expect(ring[0]).toEqual(ring.at(-1))
      for (let i = 0; i < ring.length; i++) {
        const [x, y] = ring[i]
        expect(Number.isFinite(x) && Math.abs(x) <= 180.00001).toBe(true)
        expect(Number.isFinite(y) && Math.abs(y) <= 90).toBe(true)
        if (i && Math.abs(x - ring[i - 1][0]) > 180) {
          // Antarctica's closure along the south pole is the sole valid full-world edge.
          expect(y).toBe(-90)
          expect(ring[i - 1][1]).toBe(-90)
        }
      }
    }
  })
})

describe('province/state reference data', () => {
  it('splits longitude discontinuities and invalid input into independent open paths', () => {
    expect(
      splitAntimeridian([
        [178, 2],
        [179, 3],
        [-179, 3],
        [-178, 4],
      ]),
    ).toEqual([
      [
        [178, 2],
        [179, 3],
      ],
      [
        [-179, 3],
        [-178, 4],
      ],
    ])
    expect(
      splitAntimeridian([
        [0, 0],
        [1, 1],
        [NaN, 2],
        [2, 2],
        [3, 3],
      ]),
    ).toEqual([
      [
        [0, 0],
        [1, 1],
      ],
      [
        [2, 2],
        [3, 3],
      ],
    ])
  })
  it('loads one bounded local dataset and declutters labels by viewport and source rank', async () => {
    const data = await loadAdminData()
    expect(await loadAdminData()).toBe(data)
    expect(data.labels).toHaveLength(4589)
    expect(data.parts.reduce((n, part) => n + part.points, 0)).toBeLessThanOrEqual(120000)
    expect(visibleAdminLabels(data, normalizeGeoMap())).toEqual([])
    expect(visibleAdminPaths(data, normalizeGeoMap())).toEqual({
      boundary: '',
      statistical: '',
      unrecognized: '',
    })
    const view = normalizeGeoMap({ zoom: 8, longitude: 110, latitude: 35, layer: 'admin1' })
    const labels = visibleAdminLabels(data, view)
    expect(labels.length).toBeGreaterThan(5)
    expect(labels.length).toBeLessThanOrEqual(70)
    expect(labels.some((label) => /省|自治区/.test(label.name))).toBe(true)
    expect(visibleAdminLabels(data, view, false)).toEqual([])
    const boxes = labels.map((label) => {
      const width = Array.from(label.name).reduce(
        (sum, char) => sum + (/[^\x00-\x7F]/.test(char) ? 11 : 6),
        0,
      )
      return {
        left: label.x - width / 2,
        right: label.x + width / 2,
        top: label.y - 8,
        bottom: label.y + 7,
      }
    })
    for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i]
      expect(a.left).toBeGreaterThanOrEqual(CANVAS.left)
      expect(a.right).toBeLessThanOrEqual(CANVAS.right)
      expect(a.top).toBeGreaterThanOrEqual(CANVAS.top)
      expect(a.bottom).toBeLessThanOrEqual(CANVAS.bottom)
      for (const b of boxes.slice(i + 1))
        expect(a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top).toBe(
          false,
        )
    }
    expect(visibleAdminPaths(data, view).boundary.length).toBeGreaterThan(1000)
    // Preserve the publisher's grouping. Never silently market CHN/TWN/HKG/MAC as an approved combined dataset.
    for (const code of ['CHN', 'TWN', 'HKG', 'MAC'])
      expect(data.labels.some((label) => label.sourceCountryCode === code)).toBe(true)
  })
  it('keeps dense annotation labels bounded, prioritizes selection, and does not mutate points', () => {
    const points = Array.from({ length: 200 }, (_, i) => ({
      id: `p${i}`,
      label: `很长的自定义位置标签 ${i}`,
      x: 100 + i / 100,
      y: 30 + i / 100,
    }))
    const view = normalizeGeoMap({ zoom: 8, longitude: 100, latitude: 30 })
    const labels = layoutMapPointLabels(points, view, 'p199')
    expect(labels[0].id).toBe('p199')
    expect(labels.length).toBeLessThan(10)
    expect(points[0].id).toBe('p0')
  })
})

describe('map schema, rendering and compatibility', () => {
  it('defaults only new geography drafts to the world map; old drawings remain exact', () => {
    expect(emptyDraft('geography').drawing.mode).toBe('geographic')
    expect(emptyDraft('math').drawing.mode).toBe('cartesian')
    expect(emptyDraft().drawing.mode).toBe('cartesian')
    const old = { mode: 'cartesian', points: [{ id: 'a', x: 1, y: 2, label: 'A' }], lines: [] }
    expect(drawingSchema.parse(old)).toEqual(old)
    expect(draftSchema.parse(emptyDraft('geography'))).toEqual(emptyDraft('geography'))
  })
  it('validates bounded view preferences and preserves all coordinate/line data', () => {
    const drawing: GeoDrawing = {
      ...emptyDraft('geography').drawing,
      map: normalizeGeoMap({
        layer: 'admin1',
        zoom: 4,
        longitude: 100,
        latitude: 30,
        showLabels: false,
      }),
      points: [{ id: 'a', x: 116.4, y: 39.9, label: 'A' }],
    }
    expect(drawingSchema.parse(drawing)).toEqual(drawing)
    for (const patch of [
      { zoom: 9 },
      { zoom: 0 },
      { longitude: 181 },
      { latitude: -91 },
      { longitude: NaN },
      { layer: 'official' },
      { imageUrl: 'https://example.test' },
    ])
      expect(
        drawingSchema.safeParse({ ...drawing, map: { ...drawing.map, ...patch } }).success,
      ).toBe(false)
  })
  it('renders source/version disclosure, offline world outline, optional layers and readonly snapshots', () => {
    const markup = renderToStaticMarkup(
      createElement(GeographyWorkbench, {
        drawing: emptyDraft('geography').drawing,
        onChange: () => {},
      }),
    )
    expect(markup).toContain('data-testid="geography-land"')
    expect(markup).toContain('fill-rule="evenodd"')
    expect(markup).toContain('pointer-events="none"')
    expect(markup).toContain('省州参考')
    expect(markup).toContain('2026-10-11')
    expect(markup).toContain('Natural Earth Land v4.1.0')
    expect(markup).not.toContain('从一个位置开始你的推理')
    const admin = renderToStaticMarkup(
      createElement(GeographyWorkbench, {
        drawing: { ...emptyDraft('geography').drawing, map: normalizeGeoMap({ layer: 'admin1' }) },
        onChange: () => {},
        disabled: true,
      }),
    )
    expect(admin).toContain('不是中国审定标准或 Google 美国视图')
    expect(admin).toContain('中国标准红色疆界与南海标示尚未接入')
    expect(admin).toContain('放大到 2×')
    expect(admin).toMatch(/aria-label="放大地图"[^>]*disabled=""/)
    const cartesian = renderToStaticMarkup(
      createElement(GeographyWorkbench, { drawing: emptyDraft().drawing, onChange: () => {} }),
    )
    expect(cartesian).not.toContain('data-testid="geography-basemap"')
    expect(cartesian).toContain('从一个位置开始你的推理')
  })
  it('renders terrain with exactly aligned stretched geographic bounds, never an online tile URL', () => {
    const map = normalizeGeoMap({ layer: 'terrain', zoom: 4, longitude: 110, latitude: 35 })
    const markup = renderToStaticMarkup(
      createElement(GeographyWorkbench, {
        drawing: { ...emptyDraft('geography').drawing, map },
        onChange: () => {},
      }),
    )
    const image = markup.match(/<image[^>]*>/)![0]
    const rect = mapImageRect(map)
    expect(image).toContain('preserveAspectRatio="none"')
    expect(image).toContain(`x="${rect.x}"`)
    expect(image).toContain(`width="${rect.width}"`)
    expect(image).not.toMatch(/href="https?:/)
  })
  it('ships public-domain provenance beside packaged assets', async () => {
    const notice = await readFile('public/map-assets/MAP_SOURCES.md', 'utf8')
    expect(notice).toContain('v4.1.0')
    expect(notice).toContain('public domain')
    expect(notice).toContain('https://www.naturalearthdata.com/about/terms-of-use/')
    expect(notice).toContain('not Google or PRC standard')
  })
})
