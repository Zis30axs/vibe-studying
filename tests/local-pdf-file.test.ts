import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readSelectedPdf } from '../src/adapters/local-pdf-file'
const dirs: string[] = []
async function fixture(content: string) {
  const dir = await mkdtemp(join(tmpdir(), 'examcraft-pdf-file-'))
  dirs.push(dir)
  const file = join(dir, 'selected.pdf')
  await writeFile(file, content)
  return file
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
describe('native selected PDF bounded read', () => {
  it('reads only bounded bytes', async () => {
    const path = await fixture('%PDF-fixture')
    expect(new TextDecoder().decode(await readSelectedPdf(path, 20))).toBe('%PDF-fixture')
  })
  it('rejects oversized and empty files before reading', async () => {
    await expect(readSelectedPdf(await fixture(''), 20)).rejects.toThrow('普通 PDF')
    await expect(readSelectedPdf(await fixture('%PDF-fixture'), 5)).rejects.toThrow('普通 PDF')
  })
  it('honors cancellation without reading', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      readSelectedPdf(await fixture('%PDF-fixture'), 20, controller.signal),
    ).rejects.toThrow()
  })
})
