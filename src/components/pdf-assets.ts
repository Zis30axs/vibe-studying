import { AnnotationMode, GlobalWorkerOptions, PDFWorker, getDocument } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

// All auxiliary data is packaged with the application. A PDF cannot select URLs.
const cmaps = import.meta.glob('/node_modules/pdfjs-dist/cmaps/*.bcmap', {
  eager: true,
  import: 'default',
  query: '?url&no-inline',
}) as Record<string, string>
const fonts = import.meta.glob('/node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}', {
  eager: true,
  import: 'default',
  query: '?url&no-inline',
}) as Record<string, string>
async function localAsset(map: Record<string, string>, path: string): Promise<Uint8Array> {
  const asset = map[path]
  if (!asset) throw new Error('PDF 内置字体资源不可用。')
  const response = await fetch(asset, { credentials: 'omit', redirect: 'error' })
  if (!response.ok) throw new Error('无法读取本地 PDF 字体资源。')
  return new Uint8Array(await response.arrayBuffer())
}
class LocalPdfBinaryData {
  async fetch({ kind, filename }: { kind: string; filename: string }) {
    if (!/^[\w.-]+$/.test(filename)) throw new Error('无效的 PDF 资源名称。')
    if (kind === 'cMapUrl') return localAsset(cmaps, `/node_modules/pdfjs-dist/cmaps/${filename}`)
    if (kind === 'standardFontDataUrl')
      return localAsset(fonts, `/node_modules/pdfjs-dist/standard_fonts/${filename}`)
    throw new Error('此 PDF 图像编码需要未启用的资源。')
  }
}
export { AnnotationMode }
export function loadLocalPdf(bytes: Uint8Array) {
  GlobalWorkerOptions.workerSrc = workerUrl
  // Explicit port avoids PDF.js's blob URL wrapper on custom Electron origins.
  const nativeWorker = new Worker(workerUrl, { type: 'module', name: 'examcraft-pdf-reader' })
  const worker = PDFWorker.create({ port: nativeWorker })
  const task = getDocument({
    data: new Uint8Array(bytes),
    worker,
    // PDF.js 6 removed its eval-based font compiler; no eval/scripting viewer is loaded.
    enableXfa: false,
    useWasm: false,
    useWorkerFetch: false,
    BinaryDataFactory: LocalPdfBinaryData,
    cMapPacked: true,
    maxImageSize: 16_000_000,
    canvasMaxAreaInBytes: 24_000_000,
    disableAutoFetch: true,
    disableStream: true,
    verbosity: 0,
  })
  let disposed = false
  return {
    task,
    destroy() {
      if (disposed) return
      disposed = true
      // A malformed PDF must not keep a CPU worker alive while async teardown stalls.
      try {
        void task.destroy().catch(() => {})
      } finally {
        try {
          worker.destroy()
        } finally {
          nativeWorker.terminate()
        }
      }
    },
  }
}
