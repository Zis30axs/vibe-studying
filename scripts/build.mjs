import { build } from 'esbuild'
export async function buildDesktop() {
  await Promise.all([
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
}
await buildDesktop()
