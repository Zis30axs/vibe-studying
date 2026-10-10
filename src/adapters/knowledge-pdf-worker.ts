import { parentPort, workerData } from 'node:worker_threads'
import { dirname, join, sep } from 'node:path'
import { readFile, readdir } from 'node:fs/promises'
import {
  MAX_KNOWLEDGE_PAGE_TEXT,
  MAX_KNOWLEDGE_PAGES,
  MAX_KNOWLEDGE_PDF_BYTES,
  MAX_KNOWLEDGE_TEXT,
} from '../shared/knowledge'

/** Runs in its own bounded Node worker. Never receives paths from PDF content. */
async function extract() {
  const bytes: unknown = workerData
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_KNOWLEDGE_PDF_BYTES
  )
    throw new Error('PDF_SIZE_LIMIT')
  // Keep this ESM module external to the CJS desktop bundle. See scripts/build.mjs.
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const assets = dirname(require.resolve('pdfjs-dist/package.json'))
  const assetPaths = new Map<string, string>()
  for (const [kind, directory] of [
    ['cMapUrl', 'cmaps'],
    ['standardFontDataUrl', 'standard_fonts'],
  ] as const) {
    for (const entry of await readdir(join(assets, directory), { withFileTypes: true })) {
      if (entry.isFile() && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(entry.name))
        assetPaths.set(`${kind}/${entry.name}`, join(assets, directory, entry.name))
    }
  }
  class LocalPdfAssets {
    async fetch({ kind, filename }: { kind: string; filename: string }) {
      // These values originate in the PDF parser. Never concatenate them into
      // filesystem paths or let PDF-defined URLs trigger network requests.
      if (
        !['cMapUrl', 'standardFontDataUrl'].includes(kind) ||
        !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(filename)
      )
        throw new Error('Unsupported PDF resource')
      const path = assetPaths.get(`${kind}/${filename}`)
      if (!path) throw new Error('Unsupported PDF resource')
      return new Uint8Array(await readFile(path))
    }
  }
  const loading = getDocument({
    data: bytes,
    cMapUrl: join(assets, 'cmaps') + sep,
    cMapPacked: true,
    standardFontDataUrl: join(assets, 'standard_fonts') + sep,
    BinaryDataFactory: LocalPdfAssets,
    useWorkerFetch: false,
    useWasm: false,
    stopAtErrors: true,
    disableFontFace: true,
    useSystemFonts: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    enableXfa: false,
    maxImageSize: 0,
    verbosity: 0,
  })
  try {
    const pdf = await loading.promise
    if (pdf.numPages < 1 || pdf.numPages > MAX_KNOWLEDGE_PAGES) throw new Error('PDF_PAGE_LIMIT')
    const pages: string[] = []
    let total = 0
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number)
      try {
        // Streaming avoids accumulating an unbounded text-content item array first.
        const reader = page.streamTextContent({ includeMarkedContent: false }).getReader()
        const parts: string[] = []
        let count = 0
        try {
          while (true) {
            const batch = await reader.read()
            if (batch.done) break
            for (const item of batch.value.items) {
              if (!('str' in item)) continue
              const text = item.str + (item.hasEOL ? '\n' : ' ')
              count += text.length
              if (count > MAX_KNOWLEDGE_PAGE_TEXT || total + count > MAX_KNOWLEDGE_TEXT)
                throw new Error('PDF_TEXT_LIMIT')
              parts.push(text)
            }
          }
        } finally {
          // Do not let PDF.js cleanup delay an explicit size-limit failure.
          // The parent terminates this dedicated worker after the result.
          void reader.cancel().catch(() => undefined)
          reader.releaseLock()
        }
        const text = parts
          .join('')
          .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
          .replace(/([\p{Script=Han}])[ \t]+(?=[\p{Script=Han}])/gu, '$1')
          .replace(/[ \t]+/g, ' ')
          .replace(/ *\n */g, '\n')
          .trim()
        total += text.length
        pages.push(text)
      } finally {
        page.cleanup()
      }
    }
    return { pages }
  } finally {
    void loading.destroy().catch(() => undefined)
  }
}

if (!parentPort) throw new Error('PDF extraction must run in a worker')
extract().then(
  (result) => parentPort!.postMessage({ ok: true, ...result }),
  (error: unknown) => {
    const name = error instanceof Error ? error.name : ''
    const message = error instanceof Error ? error.message : ''
    const code =
      name === 'PasswordException'
        ? 'PDF_ENCRYPTED'
        : ['PDF_SIZE_LIMIT', 'PDF_PAGE_LIMIT', 'PDF_TEXT_LIMIT'].includes(message)
          ? message
          : 'PDF_INVALID'
    parentPort!.postMessage({ ok: false, code })
  },
)
