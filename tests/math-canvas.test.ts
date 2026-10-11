import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SNAP_STEP,
  MAX_SNAP_STEP,
  MIN_SNAP_STEP,
  axisDistances,
  clientToMathSvg,
  isValidSnapStep,
  mathCoordinateFromSvg,
  mathTooltipPosition,
  nextSnapStep,
  placeProjectionLabels,
  snapMathCoordinate,
} from '../src/domain/math-canvas'

describe('math snap-step validation', () => {
  it('exposes the bounded default precision', () => {
    expect(MIN_SNAP_STEP).toBe(0.01)
    expect(MAX_SNAP_STEP).toBe(10)
    expect(DEFAULT_SNAP_STEP).toBe(1)
  })

  it.each([0.01, 0.010001, 0.123456, 0.25, 0.1 + 0.2, 1, 6, 10])(
    'accepts finite, bounded, six-decimal step %s',
    (step) => expect(isValidSnapStep(step)).toBe(true),
  )

  it.each([
    0,
    -0,
    -1,
    0.009999,
    10.000001,
    0.1234567,
    0.0100001,
    Number.MIN_VALUE,
    NaN,
    Infinity,
    -Infinity,
  ])('rejects invalid or unnecessarily precise step %s', (step) =>
    expect(isValidSnapStep(step)).toBe(false),
  )
})

describe('math coordinate snapping', () => {
  it.each([
    [2.49, 1, 2],
    [2.5, 1, 3],
    [-2.49, 1, -2],
    [-2.5, 1, -3],
    [0.25, 0.5, 0.5],
    [-0.25, 0.5, -0.5],
    [1.125, 0.25, 1.25],
    [-1.125, 0.25, -1.25],
    [0.15, 0.1, 0.2],
    [-0.15, 0.1, -0.2],
    [0.1 + 0.2, 0.1, 0.3],
    [-0.1 - 0.2, 0.1, -0.3],
    [1.2345, 0.01, 1.23],
    [1.235, 0.01, 1.24],
    [-1.235, 0.01, -1.24],
    [0.246912, 0.123456, 0.246912],
  ])('snaps %s at step %s to %s, with half steps away from zero', (value, step, expected) => {
    expect(snapMathCoordinate(value, step)).toBeCloseTo(expected, 12)
  })

  it.each([0, -0, 0.004, -0.004])('normalizes snapped zero for input %s', (value) => {
    expect(Object.is(snapMathCoordinate(value, 0.01), 0)).toBe(true)
  })

  it.each([
    [10, 6, 6],
    [-10, 6, -6],
    [100, 6, 6],
    [-100, 6, -6],
    [10, 3, 9],
    [-10, 3, -9],
    [10, 0.3, 9.9],
    [-10, 0.3, -9.9],
    [Number.MAX_VALUE, 0.01, 10],
    [-Number.MAX_VALUE, 0.01, -10],
  ])('keeps %s on the step-%s grid inside the range', (value, step, expected) => {
    const snapped = snapMathCoordinate(value, step)
    expect(snapped).toBeCloseTo(expected, 12)
    expect(snapped).toBeGreaterThanOrEqual(-10)
    expect(snapped).toBeLessThanOrEqual(10)
    expect(snapped / step).toBeCloseTo(Math.round(snapped / step), 10)
  })

  it('is bounded, symmetric, on-grid and idempotent across supported precisions', () => {
    for (const step of [0.01, 0.03, 0.123456, 0.25, 0.3, 0.5, 1, 3, 6, 10]) {
      for (const value of [0, 0.005, 0.15, 0.375, 1.235, 3.75, 8.99, 10, 1000]) {
        const positive = snapMathCoordinate(value, step)
        const negative = snapMathCoordinate(-value, step)
        expect(Math.abs(positive)).toBeLessThanOrEqual(10)
        expect(negative).toBeCloseTo(-positive, 12)
        expect(positive / step).toBeCloseTo(Math.round(positive / step), 10)
        expect(snapMathCoordinate(positive, step)).toBe(positive)
        expect(snapMathCoordinate(negative, step)).toBe(negative)
      }
    }
  })

  it.each([NaN, Infinity, -Infinity])('throws for nonfinite coordinate %s', (value) => {
    expect(() => snapMathCoordinate(value, 1)).toThrow(RangeError)
  })

  it.each([0, -1, 0.001, 10.001, 0.1234567, NaN, Infinity])(
    'throws for invalid step %s',
    (step) => {
      expect(() => snapMathCoordinate(1, step)).toThrow(RangeError)
    },
  )
})

describe('math precision ladder', () => {
  const ladder = [1, 0.5, 0.25, ...Array.from({ length: 24 }, (_, index) => (24 - index) / 100)]

  it('walks every finer precision and stays at the minimum', () => {
    let step = DEFAULT_SNAP_STEP
    for (const expected of ladder.slice(1)) {
      const next = nextSnapStep(step, 'finer')
      expect(next).toBe(expected)
      expect(next).toBeLessThan(step)
      expect(isValidSnapStep(next)).toBe(true)
      step = next
    }
    expect(nextSnapStep(step, 'finer')).toBe(MIN_SNAP_STEP)
  })

  it('walks the reverse ladder and stays at the default coarsest precision', () => {
    let step = MIN_SNAP_STEP
    for (const expected of [...ladder].reverse().slice(1)) {
      const next = nextSnapStep(step, 'coarser')
      expect(next).toBe(expected)
      expect(next).toBeGreaterThan(step)
      expect(isValidSnapStep(next)).toBe(true)
      step = next
    }
    expect(nextSnapStep(step, 'coarser')).toBe(DEFAULT_SNAP_STEP)
  })

  it.each([
    [10, 1, 10],
    [6, 1, 6],
    [1.2, 1, 1.2],
    [0.75, 0.5, 1],
    [0.3, 0.25, 0.5],
    [0.1 + 0.2, 0.25, 0.5],
    [0.245, 0.235, 0.25],
    [0.123456, 0.113456, 0.133456],
    [0.015, 0.01, 0.025],
    [0.010001, 0.01, 0.020001],
  ])('handles custom step %s without skipping its next thresholds', (step, finer, coarser) => {
    expect(nextSnapStep(step, 'finer')).toBeCloseTo(finer, 12)
    expect(nextSnapStep(step, 'coarser')).toBeCloseTo(coarser, 12)
  })

  it('keeps repeated custom-step changes finite, monotonic and bounded', () => {
    for (const initial of [0.010001, 0.015, 0.123456, 0.245, 0.3, 0.75, 1.2, 6, 10]) {
      for (const direction of ['finer', 'coarser'] as const) {
        let step = initial
        for (let count = 0; count < 40; count += 1) {
          const next = nextSnapStep(step, direction)
          expect(isValidSnapStep(next)).toBe(true)
          expect(next).toBeGreaterThanOrEqual(MIN_SNAP_STEP)
          expect(next).toBeLessThanOrEqual(MAX_SNAP_STEP)
          if (direction === 'finer') expect(next).toBeLessThanOrEqual(step)
          else expect(next).toBeGreaterThanOrEqual(step)
          step = next
        }
        expect(step).toBe(direction === 'finer' ? MIN_SNAP_STEP : Math.max(1, initial))
      }
    }
  })
})

describe('math SVG coordinate mapping', () => {
  it.each([
    [{ x: 280, y: 280 }, 1, { x: 0, y: 0, inside: true }],
    [{ x: 40, y: 40 }, 1, { x: -10, y: 10, inside: true }],
    [{ x: 520, y: 520 }, 1, { x: 10, y: -10, inside: true }],
    [{ x: 520, y: 40 }, 1, { x: 10, y: 10, inside: true }],
    [{ x: 40, y: 520 }, 1, { x: -10, y: -10, inside: true }],
    [{ x: 358, y: 166 }, 0.25, { x: 3.25, y: 4.75, inside: true }],
    [{ x: 274, y: 286 }, 0.5, { x: -0.5, y: -0.5, inside: true }],
    [{ x: 286, y: 274 }, 0.5, { x: 0.5, y: 0.5, inside: true }],
    [{ x: 520, y: 40 }, 6, { x: 6, y: 6, inside: true }],
  ])('converts SVG point %o at precision %s', (point, step, expected) => {
    expect(mathCoordinateFromSvg(point, step)).toEqual(expected)
  })

  it.each([
    [
      { x: 39.999, y: 280 },
      { x: -10, y: 0, inside: false },
    ],
    [
      { x: 520.001, y: 280 },
      { x: 10, y: 0, inside: false },
    ],
    [
      { x: 280, y: 39.999 },
      { x: 0, y: 10, inside: false },
    ],
    [
      { x: 280, y: 520.001 },
      { x: 0, y: -10, inside: false },
    ],
    [
      { x: -1000, y: 1000 },
      { x: -10, y: -10, inside: false },
    ],
  ])('reports raw out-of-grid position %o even when snapping onto its edge', (point, expected) => {
    expect(mathCoordinateFromSvg(point, 1)).toEqual(expected)
  })

  it('distinguishes small in-grid margins from outside before snapping', () => {
    expect(mathCoordinateFromSvg({ x: 40.001, y: 519.999 }, 1)).toEqual({
      x: -10,
      y: -10,
      inside: true,
    })
    expect(mathCoordinateFromSvg({ x: 1000, y: -1000 }, 6)).toEqual({ x: 6, y: 6, inside: false })
  })

  it.each([NaN, Infinity, -Infinity])('rejects nonfinite SVG coordinate %s', (value) => {
    expect(mathCoordinateFromSvg({ x: value, y: 280 }, 1)).toBeNull()
    expect(mathCoordinateFromSvg({ x: 280, y: value }, 1)).toBeNull()
  })

  it.each([0, -1, 0.001, 11, 0.1234567, NaN, Infinity])(
    'rejects invalid mapping precision %s',
    (step) => {
      expect(mathCoordinateFromSvg({ x: 280, y: 280 }, step)).toBeNull()
    },
  )
})

describe('math client-to-SVG transforms', () => {
  it.each([
    { left: 0, top: 0, width: 560, height: 560 },
    { left: 100, top: 200, width: 280, height: 280 },
    { left: -135, top: 37.5, width: 840, height: 840 },
    { left: 80, top: 120, width: 840, height: 280 },
    { left: 25, top: -60, width: 280, height: 840 },
    { left: 13.5, top: 26.25, width: 333, height: 517 },
  ])('round-trips points at size and offset %o, including letterboxing', (rect) => {
    const scale = Math.min(rect.width, rect.height) / 560
    const offsetX = (rect.width - 560 * scale) / 2
    const offsetY = (rect.height - 560 * scale) / 2
    for (const point of [
      { x: 0, y: 0 },
      { x: 40, y: 520 },
      { x: 280, y: 280 },
      { x: 358, y: 166 },
      { x: 560, y: 560 },
    ]) {
      const converted = clientToMathSvg(
        {
          x: rect.left + offsetX + point.x * scale,
          y: rect.top + offsetY + point.y * scale,
        },
        rect,
      )
      expect(converted).not.toBeNull()
      expect(converted?.x).toBeCloseTo(point.x, 10)
      expect(converted?.y).toBeCloseTo(point.y, 10)
    }
  })

  it('preserves positions in letterboxes instead of treating the CSS box as a stretched SVG', () => {
    expect(clientToMathSvg({ x: 0, y: 140 }, { left: 0, top: 0, width: 840, height: 280 })).toEqual(
      { x: -560, y: 280 },
    )
    expect(clientToMathSvg({ x: 140, y: 0 }, { left: 0, top: 0, width: 280, height: 840 })).toEqual(
      { x: 280, y: -560 },
    )
  })

  it('composes CSS scaling with the inverted math Y axis and fractional snap step', () => {
    const point = clientToMathSvg(
      { x: 559, y: 203 },
      { left: 100, top: 120, width: 840, height: 280 },
    )
    expect(point).toEqual({ x: 358, y: 166 })
    expect(mathCoordinateFromSvg(point!, 0.25)).toEqual({ x: 3.25, y: 4.75, inside: true })
  })

  it.each([0, -1, NaN, Infinity, -Infinity])('rejects invalid rendered dimension %s', (value) => {
    const rect = { left: 10, top: 20, width: 560, height: 560 }
    expect(clientToMathSvg({ x: 280, y: 280 }, { ...rect, width: value })).toBeNull()
    expect(clientToMathSvg({ x: 280, y: 280 }, { ...rect, height: value })).toBeNull()
  })

  it.each([NaN, Infinity, -Infinity])(
    'rejects nonfinite client coordinates and offsets %s',
    (value) => {
      const point = { x: 280, y: 280 }
      const rect = { left: 10, top: 20, width: 560, height: 560 }
      expect(clientToMathSvg({ ...point, x: value }, rect)).toBeNull()
      expect(clientToMathSvg({ ...point, y: value }, rect)).toBeNull()
      expect(clientToMathSvg(point, { ...rect, left: value })).toBeNull()
      expect(clientToMathSvg(point, { ...rect, top: value })).toBeNull()
    },
  )

  it('never leaks nonfinite coordinates when otherwise finite inputs overflow or underflow', () => {
    for (const [point, rect] of [
      [
        { x: 1, y: 1 },
        { left: 0, top: 0, width: Number.MIN_VALUE, height: Number.MIN_VALUE },
      ],
      [
        { x: Number.MAX_VALUE, y: 0 },
        { left: -Number.MAX_VALUE, top: 0, width: 560, height: 560 },
      ],
    ] as const) {
      const result = clientToMathSvg(point, rect)
      expect(result === null || (Number.isFinite(result.x) && Number.isFinite(result.y))).toBe(true)
    }
  })
})

describe('math pointer tooltip placement', () => {
  const tooltip = { width: 180, height: 76 }
  const container = { width: 560, height: 560 }

  it.each([
    [
      { x: 100, y: 100 },
      { left: 114, top: 114 },
    ],
    [
      { x: 530, y: 100 },
      { left: 336, top: 114 },
    ],
    [
      { x: 100, y: 530 },
      { left: 114, top: 440 },
    ],
    [
      { x: 530, y: 530 },
      { left: 336, top: 440 },
    ],
    [
      { x: 358, y: 462 },
      { left: 372, top: 476 },
    ],
  ])('places tooltip near %o using a 14px gap and flips only as needed', (point, expected) => {
    expect(mathTooltipPosition(point, container, tooltip)).toEqual(expected)
  })

  it('honors actual tooltip dimensions when deciding whether to flip', () => {
    expect(mathTooltipPosition({ x: 380, y: 430 }, container, { width: 220, height: 100 })).toEqual(
      { left: 146, top: 444 },
    )
  })

  it('clamps pointer positions to the 8px safe margin on every edge', () => {
    for (const point of [
      { x: -1000, y: -1000 },
      { x: 0, y: 0 },
      { x: 560, y: 560 },
      { x: 1000, y: 1000 },
    ]) {
      const position = mathTooltipPosition(point, container, tooltip)
      expect(position.left).toBeGreaterThanOrEqual(8)
      expect(position.top).toBeGreaterThanOrEqual(8)
      expect(position.left + tooltip.width).toBeLessThanOrEqual(container.width - 8)
      expect(position.top + tooltip.height).toBeLessThanOrEqual(container.height - 8)
    }
  })

  it('uses the safe origin when a container is too small to fit the tooltip', () => {
    expect(mathTooltipPosition({ x: 50, y: 20 }, { width: 100, height: 40 }, tooltip)).toEqual({
      left: 8,
      top: 8,
    })
    expect(mathTooltipPosition({ x: 0, y: 0 }, { width: 0, height: 0 }, tooltip)).toEqual({
      left: 0,
      top: 0,
    })
    expect(mathTooltipPosition({ x: 90, y: 45 }, { width: 196, height: 92 }, tooltip)).toEqual({
      left: 8,
      top: 8,
    })
  })
})

describe('math axis projection distances and labels', () => {
  it.each([
    [
      { x: 3, y: 4 },
      { toXAxis: 4, toYAxis: 3 },
    ],
    [
      { x: -3.25, y: -4.5 },
      { toXAxis: 4.5, toYAxis: 3.25 },
    ],
    [
      { x: -2, y: 0 },
      { toXAxis: 0, toYAxis: 2 },
    ],
    [
      { x: 0, y: -2 },
      { toXAxis: 2, toYAxis: 0 },
    ],
  ])('measures perpendicular distances for %o', (point, expected) => {
    expect(axisDistances(point)).toEqual(expected)
  })

  it('normalizes negative zero in both axis distances', () => {
    const distances = axisDistances({ x: -0, y: -0 })
    expect(Object.is(distances.toXAxis, 0)).toBe(true)
    expect(Object.is(distances.toYAxis, 0)).toBe(true)
  })

  it('puts each point’s X-axis distance before its Y-axis distance with readable precision', () => {
    const labels = placeProjectionLabels([{ id: 'point-a', x: -3.25, y: -4.5 }])
    expect(labels.map(({ id, text }) => ({ id, text }))).toEqual([
      { id: 'point-a-x', text: '到 x 轴 4.5' },
      { id: 'point-a-y', text: '到 y 轴 3.25' },
    ])
    expect(placeProjectionLabels([{ id: 'origin', x: -0, y: -0 }]).map(({ text }) => text)).toEqual(
      ['到 x 轴 0', '到 y 轴 0'],
    )
    expect(
      placeProjectionLabels([{ id: 'decimal', x: 0.1 + 0.2, y: 0.123456 }]).map(({ text }) => text),
    ).toEqual(['到 x 轴 0.123456', '到 y 轴 0.3'])
  })

  it('deduplicates identical projections and gives the first input point label priority', () => {
    const first = { id: 'selected', x: 3, y: 4 }
    const second = { id: 'hovered', x: 3, y: 4 }
    expect(placeProjectionLabels([first, second])).toEqual(placeProjectionLabels([first]))
    expect(placeProjectionLabels([second, first])).toEqual(placeProjectionLabels([second]))
    expect(placeProjectionLabels([])).toEqual([])
  })

  it('keeps crowded labels deterministic, inside the grid and clear of other label boxes', () => {
    const points = [
      { id: 'selected', x: 0, y: 0 },
      ...Array.from({ length: 100 }, (_, index) => ({
        id: `crowded-${index}`,
        x: ((index % 10) - 5) * 0.01,
        y: (Math.floor(index / 10) - 5) * 0.01,
      })),
      { id: 'top-left', x: -10, y: 10 },
      { id: 'top-right', x: 10, y: 10 },
      { id: 'bottom-left', x: -10, y: -10 },
      { id: 'bottom-right', x: 10, y: -10 },
    ]
    const original = structuredClone(points)
    const labels = placeProjectionLabels(points)
    expect(placeProjectionLabels(points)).toEqual(labels)
    expect(points).toEqual(original)
    expect(labels.slice(0, 2).map(({ id }) => id)).toEqual(['selected-x', 'selected-y'])
    expect(labels.length).toBeLessThan(points.length * 2)
    expect(new Set(labels.map(({ id }) => id)).size).toBe(labels.length)

    // The helper places 18px label boxes with a 5px/13px text inset and a 3px gap.
    const boxes = labels.map((label) => ({
      left: label.x - 5,
      top: label.y - 13,
      width: Math.min(150, label.text.length * 6.5 + 10),
      height: 18,
    }))
    for (const [index, box] of boxes.entries()) {
      expect(box.left).toBeGreaterThanOrEqual(40)
      expect(box.top).toBeGreaterThanOrEqual(40)
      expect(box.left + box.width).toBeLessThanOrEqual(520)
      expect(box.top + box.height).toBeLessThanOrEqual(520)
      for (const other of boxes.slice(index + 1)) {
        const separated =
          box.left + box.width + 3 <= other.left ||
          other.left + other.width + 3 <= box.left ||
          box.top + box.height + 3 <= other.top ||
          other.top + other.height + 3 <= box.top
        expect(separated).toBe(true)
      }
    }
  })
})
