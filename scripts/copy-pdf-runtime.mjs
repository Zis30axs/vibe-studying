import { cp, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** The CJS extraction worker loads PDF.js ESM and its worker from these files. */
export async function copyPdfRuntime(runtime) {
  const require = createRequire(import.meta.url)
  await mkdir(runtime, { recursive: true })
  const packageRoot = dirname(require.resolve('pdfjs-dist/package.json'))
  const output = join(runtime, 'pdfjs-dist')
  await mkdir(output, { recursive: true })
  for (const name of ['package.json', 'LICENSE', 'legacy', 'cmaps', 'standard_fonts'])
    await cp(join(packageRoot, name), join(output, name), { recursive: true })
  // Canvas is optional for text extraction in PDF.js 6; copy installed native
  // bindings to avoid missing-polyfill warnings and preserve a complete runtime.
  try {
    const canvasRoot = dirname(require.resolve('@napi-rs/canvas/package.json'))
    await cp(canvasRoot, join(runtime, '@napi-rs/canvas'), { recursive: true })
    const canvasPackage = require('@napi-rs/canvas/package.json')
    for (const dependency of Object.keys(canvasPackage.optionalDependencies ?? {})) {
      try {
        const installed = dirname(require.resolve(`${dependency}/package.json`))
        await cp(installed, join(runtime, dependency), { recursive: true })
      } catch (error) {
        if (error.code !== 'MODULE_NOT_FOUND') throw error
      }
    }
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error
  }
}
