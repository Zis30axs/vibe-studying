/** Reader limits are independent of document-supplied page sizes and device pixel ratio. */
export const MIN_PDF_ZOOM = 0.5
export const MAX_PDF_ZOOM = 2
export const MAX_PDF_CANVAS_SIDE = 3200
export const MAX_PDF_CANVAS_PIXELS = 6_000_000

export function boundedPdfPage(value: number, pageCount: number): number {
  const last = Number.isFinite(pageCount) ? Math.max(1, Math.floor(pageCount)) : 1
  return Math.min(last, Math.max(1, Number.isFinite(value) ? Math.floor(value) : 1))
}
export function boundedPdfZoom(value: number): number {
  return Math.min(MAX_PDF_ZOOM, Math.max(MIN_PDF_ZOOM, Number.isFinite(value) ? value : 1))
}
export function boundedPdfScale(
  width: number,
  height: number,
  availableWidth: number,
  zoom: number,
  dpr: number,
): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
    throw new Error('PDF 页面尺寸无效。')
  const available = Number.isFinite(availableWidth)
    ? Math.max(120, Math.min(1600, availableWidth))
    : 480
  const ratio = Number.isFinite(dpr) ? Math.min(2, Math.max(1, dpr)) : 1
  return Math.min(
    (available / width) * boundedPdfZoom(zoom) * ratio,
    MAX_PDF_CANVAS_SIDE / width,
    MAX_PDF_CANVAS_SIDE / height,
    Math.sqrt(MAX_PDF_CANVAS_PIXELS / (width * height)),
  )
}
export function validPdfRange(start: number, end: number, pageCount: number): boolean {
  return (
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 1 &&
    end >= start &&
    end <= pageCount
  )
}
