import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { copyPdfRuntime } from '../scripts/copy-pdf-runtime.mjs'
import { createKnowledgePdf } from './fixtures/knowledge-pdf'

it('runs the copied CJS extraction worker with only its packaged ESM runtime from another cwd', async () => {
  // Run on both Windows and POSIX: resource directories must be real file URLs,
  // with a trailing slash and encoded spaces, Unicode, fragments and percent signs.
  const directory = await mkdtemp(join(tmpdir(), 'examcraft 中文 # % isolated-pdf-'))
  try {
    const workerPath = join(directory, 'knowledge-pdf-worker.cjs')
    await build({
      entryPoints: [resolve('src/adapters/knowledge-pdf-worker.ts')],
      outfile: workerPath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      external: ['pdfjs-dist/*'],
    })
    // Exercise the same runtime-copy function as the production build.
    await copyPdfRuntime(join(directory, 'node_modules'))
    await writeFile(join(directory, 'original-synthetic.pdf'), createKnowledgePdf())
    const runner = `
      const { Worker } = require('node:worker_threads');
      const { readFileSync } = require('node:fs');
      const path = require('node:path');
      const worker = new Worker(path.resolve('knowledge-pdf-worker.cjs'), {
        workerData: new Uint8Array(readFileSync('original-synthetic.pdf'))
      });
      worker.once('message', (result) => { process.stdout.write(JSON.stringify(result)); worker.terminate(); });
      worker.once('error', (error) => { process.stderr.write(error.message); process.exitCode = 1; });
    `
    const { stdout } = await promisify(execFile)(process.execPath, ['-e', runner], {
      cwd: directory,
      env: { ...process.env, NODE_PATH: '' },
      timeout: 20_000,
    })
    const result = JSON.parse(stdout) as { ok: boolean; pages: string[] }
    expect(result.ok).toBe(true)
    expect(result.pages).toHaveLength(3)
    expect(result.pages[1]).toContain('依法监督')
    expect(result.pages[2]).toContain('公共讨论')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
