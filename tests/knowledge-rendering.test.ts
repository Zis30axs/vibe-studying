import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import { describe, expect, it } from 'vitest'
import { AnnotationMode, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createKnowledgePdf } from './fixtures/knowledge-pdf'

const require = createRequire(import.meta.url)
const assets = dirname(require.resolve('pdfjs-dist/package.json'))

describe('real synthetic PDF raster rendering (no GUI or provider)', () => {
  it('rasterizes physical pages into nonempty PNGs and keeps a blank page blank', async () => {
    // This is the actual PDF.js renderer and native Node canvas, not a component mock.
    // All input content is authored here; there is no textbook or external PDF.
    // This unembedded fixture checks ASCII raster/navigation only; the second test
    // separately proves Chinese glyphs using an embedded, licensed CJK font.
    const loading = getDocument({
      data: createKnowledgePdf([
        'SYNTHETIC CIVICS PAGE ONE\nPractice and evidence.\n实践检验认识。',
        '',
        'SYNTHETIC CIVICS PAGE THREE\nA separate physical page.',
      ]),
      useSystemFonts: false,
      disableFontFace: true,
      useWasm: false,
      standardFontDataUrl: `${join(assets, 'standard_fonts')}/`,
      cMapUrl: `${join(assets, 'cmaps')}/`,
      cMapPacked: true,
    })
    try {
      const pdf = await loading.promise
      expect(pdf.numPages).toBe(3)
      const darkPixels: number[] = []
      const images: Buffer[] = []
      for (let physicalPage = 1; physicalPage <= pdf.numPages; physicalPage++) {
        const page = await pdf.getPage(physicalPage)
        const viewport = page.getViewport({ scale: 1 })
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
        const context = canvas.getContext('2d')
        const render = page.render({
          canvas: canvas as unknown as HTMLCanvasElement,
          canvasContext: context as unknown as CanvasRenderingContext2D,
          viewport,
          annotationMode: AnnotationMode.DISABLE,
        })
        await render.promise
        const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
        let marked = 0
        for (let index = 0; index < data.length; index += 4) {
          if (data[index + 3] > 0 && Math.min(data[index], data[index + 1], data[index + 2]) < 200)
            marked++
        }
        darkPixels.push(marked)
        const png = canvas.toBuffer('image/png')
        expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        expect(png.length).toBeGreaterThan(100)
        images.push(png)
        page.cleanup()
      }
      expect(darkPixels[0]).toBeGreaterThan(40)
      expect(darkPixels[1]).toBe(0)
      expect(darkPixels[2]).toBeGreaterThan(40)
      expect(images[0].equals(images[2])).toBe(false)
      // Optional inspection output remains ignored test data, never product/library content.
      if (process.env.EXAMCRAFT_PDF_RENDER_ARTIFACTS === '1') {
        const directory = join(process.cwd(), 'test-results', 'synthetic-pdf-raster')
        await mkdir(directory, { recursive: true })
        await Promise.all(
          images.map((image, index) =>
            writeFile(join(directory, `physical-page-${index + 1}.png`), image),
          ),
        )
      }
    } finally {
      await loading.destroy()
    }
  })

  it('renders actual Chinese glyphs from a licensed embedded-font original PDF', async () => {
    const bytes = await readFile(join(process.cwd(), 'tests/fixtures/knowledge-cjk.pdf'))
    const loading = getDocument({
      data: new Uint8Array(bytes),
      useSystemFonts: false,
      disableFontFace: true,
      useWasm: false,
      enableXfa: false,
      standardFontDataUrl: `${join(assets, 'standard_fonts')}/`,
      cMapUrl: `${join(assets, 'cmaps')}/`,
      cMapPacked: true,
    })
    try {
      const pdf = await loading.promise
      expect(pdf.numPages).toBe(1)
      const page = await pdf.getPage(1)
      const text = (await page.getTextContent()).items
        .map((item) => ('str' in item ? item.str : ''))
        .join('')
      expect(text).toContain('自编政治检索示例')
      expect(text).toContain('依法监督需要核对事实')
      const viewport = page.getViewport({ scale: 1 })
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
      const context = canvas.getContext('2d')
      await page.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        canvasContext: context as unknown as CanvasRenderingContext2D,
        viewport,
        annotationMode: AnnotationMode.DISABLE,
      }).promise
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
      let darkPixels = 0
      for (let index = 0; index < data.length; index += 4)
        if (data[index + 3] > 0 && Math.min(data[index], data[index + 1], data[index + 2]) < 200)
          darkPixels++
      // Every visible line in this fixture is Chinese: no ASCII marks can satisfy
      // the raster assertion while Chinese font rendering is silently absent.
      expect(darkPixels).toBeGreaterThan(1000)
      if (process.env.EXAMCRAFT_PDF_RENDER_ARTIFACTS === '1') {
        const directory = join(process.cwd(), 'test-results', 'synthetic-pdf-raster')
        await mkdir(directory, { recursive: true })
        await writeFile(
          join(directory, 'embedded-chinese-page-1.png'),
          canvas.toBuffer('image/png'),
        )
      }
    } finally {
      await loading.destroy()
    }
  })

  it('shows an image-only original scan while correctly finding no text layer', async () => {
    const bytes = await readFile(join(process.cwd(), 'tests/fixtures/knowledge-scan.pdf'))
    const loading = getDocument({ data: new Uint8Array(bytes), useWasm: false, enableXfa: false })
    try {
      const pdf = await loading.promise
      expect(pdf.numPages).toBe(1)
      const page = await pdf.getPage(1)
      const text = (await page.getTextContent()).items
        .map((item) => ('str' in item ? item.str : ''))
        .join('')
        .trim()
      expect(text).toBe('')
      const viewport = page.getViewport({ scale: 1 })
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
      const context = canvas.getContext('2d')
      await page.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        canvasContext: context as unknown as CanvasRenderingContext2D,
        viewport,
        annotationMode: AnnotationMode.DISABLE,
      }).promise
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
      let darkPixels = 0
      for (let index = 0; index < data.length; index += 4)
        if (data[index + 3] > 0 && Math.min(data[index], data[index + 1], data[index + 2]) < 200)
          darkPixels++
      expect(darkPixels).toBeGreaterThan(1000)
      if (process.env.EXAMCRAFT_PDF_RENDER_ARTIFACTS === '1') {
        const directory = join(process.cwd(), 'test-results', 'synthetic-pdf-raster')
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, 'image-only-scan-page-1.png'), canvas.toBuffer('image/png'))
      }
    } finally {
      await loading.destroy()
    }
  })
})
