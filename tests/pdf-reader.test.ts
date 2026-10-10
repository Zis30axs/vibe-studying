import { describe, expect, it } from 'vitest'
import {
  boundedPdfPage,
  boundedPdfZoom,
  boundedPdfScale,
  validPdfRange,
  MAX_PDF_CANVAS_PIXELS,
  MAX_PDF_CANVAS_SIDE,
} from '../src/domain/pdf-reader'

describe('local PDF reader physical page and rendering boundaries', () => {
  it('bounds all jumps to the physical page count', () => {
    expect(boundedPdfPage(0, 10)).toBe(1)
    expect(boundedPdfPage(-10, 10)).toBe(1)
    expect(boundedPdfPage(50, 10)).toBe(10)
    expect(boundedPdfPage(2.8, 10)).toBe(2)
    expect(boundedPdfPage(NaN, 10)).toBe(1)
    expect(boundedPdfPage(Infinity, 10)).toBe(1)
    expect(boundedPdfPage(20, NaN)).toBe(1)
  })
  it('does not let zoom or a hostile device ratio create unbounded canvases', () => {
    expect(boundedPdfZoom(-1)).toBe(0.5)
    expect(boundedPdfZoom(200)).toBe(2)
    expect(boundedPdfZoom(NaN)).toBe(1)
    for (const [width, height] of [
      [595, 842],
      [1e8, 1e8],
      [1, 1e8],
      [1e8, 1],
      [10, 10],
    ]) {
      const scale = boundedPdfScale(width, height, 1e7, 99, 99)
      expect(width * scale).toBeLessThanOrEqual(MAX_PDF_CANVAS_SIDE)
      expect(height * scale).toBeLessThanOrEqual(MAX_PDF_CANVAS_SIDE)
      expect(width * scale * (height * scale)).toBeLessThanOrEqual(MAX_PDF_CANVAS_PIXELS + 0.01)
    }
  })
  it('rejects invalid page dimensions rather than allocating a canvas', () => {
    for (const invalid of [0, -1, NaN, Infinity]) {
      expect(() => boundedPdfScale(invalid, 842, 400, 1, 1)).toThrow('页面尺寸无效')
      expect(() => boundedPdfScale(595, invalid, 400, 1, 1)).toThrow('页面尺寸无效')
    }
  })
  it('requires explicit integer page ranges within the chosen document', () => {
    expect(validPdfRange(1, 5, 10)).toBe(true)
    expect(validPdfRange(1, 10, 10)).toBe(true)
    for (const range of [
      [0, 5],
      [5, 2],
      [1, 11],
      [1.5, 5],
      [1, NaN],
    ])
      expect(validPdfRange(range[0], range[1], 10)).toBe(false)
  })
})
