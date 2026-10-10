import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  workerDestroy: vi.fn(),
  taskDestroy: vi.fn(),
  create: vi.fn(),
  getDocument: vi.fn(),
  workerOptions: { workerSrc: '' },
}))
vi.mock('pdfjs-dist', () => ({
  AnnotationMode: { DISABLE: 0 },
  GlobalWorkerOptions: mock.workerOptions,
  PDFWorker: { create: mock.create },
  getDocument: mock.getDocument,
}))
import { loadLocalPdf } from '../src/components/pdf-assets'

const terminate = vi.fn()
const construct = vi.fn()
class FakeNativeWorker {
  constructor(url: string, options: unknown) {
    construct(url, options)
  }
  terminate = terminate
}
let options: Record<string, unknown>
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('Worker', FakeNativeWorker)
  mock.create.mockReturnValue({ destroy: mock.workerDestroy })
  mock.taskDestroy.mockImplementation(() => Promise.resolve())
  mock.getDocument.mockImplementation((input) => {
    options = input
    return { destroy: mock.taskDestroy, promise: new Promise(() => {}) }
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('sandboxed local PDF asset and worker setup', () => {
  it('loads copied bytes without a document URL, XFA, remote fetching or sandbox scripts', () => {
    const original = new Uint8Array([37, 80, 68, 70])
    const loading = loadLocalPdf(original)
    expect(options.data).toEqual(original)
    expect(options.data).not.toBe(original)
    expect(options).not.toHaveProperty('url')
    expect(options).toMatchObject({
      enableXfa: false,
      useWorkerFetch: false,
      useWasm: false,
      maxImageSize: 16_000_000,
      canvasMaxAreaInBytes: 24_000_000,
    })
    expect(construct).toHaveBeenCalledWith(expect.stringContaining('pdf.worker.min.mjs'), {
      type: 'module',
      name: 'examcraft-pdf-reader',
    })
    expect(mock.create).toHaveBeenCalledWith({ port: expect.any(FakeNativeWorker) })
    loading.destroy()
  })
  it('terminates immediately and exactly once even when async task destruction stalls', () => {
    mock.taskDestroy.mockImplementation(() => new Promise(() => {}))
    const loading = loadLocalPdf(new Uint8Array([37]))
    loading.destroy()
    loading.destroy()
    expect(mock.taskDestroy).toHaveBeenCalledTimes(1)
    expect(mock.workerDestroy).toHaveBeenCalledTimes(1)
    expect(terminate).toHaveBeenCalledTimes(1)
  })
  it('allows only bundled known CMaps and fonts, never document-supplied URLs or paths', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer })
    vi.stubGlobal('fetch', fetch)
    const loading = loadLocalPdf(new Uint8Array([37]))
    const Factory = options.BinaryDataFactory as new () => {
      fetch(input: { kind: string; filename: string }): Promise<Uint8Array>
    }
    const factory = new Factory()
    await expect(
      factory.fetch({ kind: 'cMapUrl', filename: 'UniGB-UCS2-H.bcmap' }),
    ).resolves.toEqual(new Uint8Array([1, 2, 3]))
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('UniGB-UCS2-H.bcmap'), {
      credentials: 'omit',
      redirect: 'error',
    })
    fetch.mockClear()
    for (const filename of [
      '../../secret.txt',
      'https://evil.invalid/font.bcmap',
      'unbundled.bcmap',
      'constructor',
      '__proto__',
    ]) {
      await expect(factory.fetch({ kind: 'cMapUrl', filename })).rejects.toThrow()
    }
    await expect(factory.fetch({ kind: 'url', filename: 'UniGB-UCS2-H.bcmap' })).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
    loading.destroy()
  })
})
