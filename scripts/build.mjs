import { build } from 'esbuild'
import { rm } from 'node:fs/promises'
import { copyPdfRuntime } from './copy-pdf-runtime.mjs'
export async function buildDesktop() {
  await Promise.all([
    build({
      entryPoints: ['src/adapters/knowledge-pdf-worker.ts'],
      outfile: 'dist-electron/knowledge-pdf-worker.cjs',
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      // PDF.js is ESM and dynamically imports its worker relative to itself.
      external: ['pdfjs-dist/*'],
    }),
    build({
      entryPoints: ['electron/main.ts'],
      outfile: 'dist-electron/main.cjs',
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      external: ['electron'],
    }),
    build({
      entryPoints: ['electron/preload.ts'],
      outfile: 'dist-electron/preload.cjs',
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      external: ['electron'],
    }),
    build({
      entryPoints: ['mcp/server.ts'],
      outfile: 'dist-mcp/server.cjs',
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
    }),
  ])
  // Keep a self-contained ESM runtime in the desktop output. Packaged apps do
  // not depend on the checkout's node_modules, an online CDN, or the cwd.
  // Generated runtime only: discard stale versions and foreign-platform files.
  await rm('dist-electron/node_modules', { recursive: true, force: true })
  await copyPdfRuntime('dist-electron/node_modules')
}
await buildDesktop()
