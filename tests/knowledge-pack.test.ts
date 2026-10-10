import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import {
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { KnowledgeLibraryError, LocalKnowledgeLibrary } from '../src/adapters/knowledge-library'
import { importKnowledgePackFromSelectedManifest } from '../src/adapters/knowledge-pack'
import {
  knowledgePackManifestSchema,
  MAX_KNOWLEDGE_PACK_MANIFEST_BYTES,
  MAX_KNOWLEDGE_PACK_PART_BYTES,
  type KnowledgePackManifest,
} from '../src/shared/knowledge-pack'
import { MAX_KNOWLEDGE_PDF_BYTES } from '../src/shared/knowledge'
import { subjects } from '../src/shared/subjects'
import { createKnowledgePdf } from './fixtures/knowledge-pdf'

let temporary: string
let workerPath: string
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const testBytes = (label: string) => createKnowledgePdf([`Synthetic original fixture: ${label}`])

beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'examcraft-pack-tests-'))
  workerPath = resolve('dist-electron/knowledge-pdf-worker-pack-test.cjs')
  await build({
    entryPoints: ['src/adapters/knowledge-pdf-worker.ts'],
    outfile: workerPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['pdfjs-dist/*'],
  })
})
afterAll(async () => {
  await rm(temporary, { recursive: true, force: true })
  await rm(workerPath, { force: true })
})

function manifestFor(bytes: Uint8Array[]): KnowledgePackManifest {
  return {
    version: 1,
    title: 'Private synthetic six-subject pack',
    documents: bytes.map((source, index) => ({
      file: `synthetic-${index}.pdf`,
      sha256: sha256(source),
      subject: subjects[index % subjects.length],
      title: `自编合成资料 ${index}`,
      edition: '测试版本，非真实教材',
      editionConfirmed: false,
    })),
  }
}

async function pack(bytes = [testBytes('A'), testBytes('B')]) {
  const directory = await mkdtemp(join(temporary, 'pack-'))
  const manifest = manifestFor(bytes)
  const path = join(directory, 'pack.json')
  await Promise.all([
    writeFile(path, JSON.stringify(manifest)),
    ...manifest.documents.map((entry, index) =>
      writeFile(join(directory, entry.file), bytes[index]),
    ),
  ])
  const home = await mkdtemp(join(temporary, 'profile-'))
  const library = new LocalKnowledgeLibrary(home, { workerPath })
  const save = () => writeFile(path, JSON.stringify(manifest))
  return { directory, home, path, manifest, bytes, library, save }
}

async function splitFirst(fixture: Awaited<ReturnType<typeof pack>>) {
  const entry = fixture.manifest.documents[0]
  const source = fixture.bytes[0]
  const half = Math.floor(source.length / 2)
  const slices = [source.subarray(0, half), source.subarray(half)]
  entry.parts = slices.map((bytes, index) => ({
    file: `${entry.file}.part0${index + 1}`,
    sha256: sha256(bytes),
    byteLength: bytes.length,
  }))
  await Promise.all(
    entry.parts.map((part, index) => writeFile(join(fixture.directory, part.file), slices[index])),
  )
  await rm(join(fixture.directory, entry.file))
  await fixture.save()
  return { entry, slices }
}

describe('strict private pack contract', () => {
  it('defaults edition to unconfirmed and accepts all six subjects only', () => {
    const manifest = manifestFor(subjects.map(testBytes))
    const parsed = knowledgePackManifestSchema.parse({
      ...manifest,
      documents: manifest.documents.map(({ edition, editionConfirmed, ...entry }) => entry),
    })
    expect(parsed.documents.map((entry) => entry.subject)).toEqual(subjects)
    expect(parsed.documents.every((entry) => entry.edition === '' && !entry.editionConfirmed)).toBe(
      true,
    )
    expect(() => knowledgePackManifestSchema.parse({ ...manifest, answers: [] })).toThrow()
    expect(() => knowledgePackManifestSchema.parse({ ...manifest, version: 2 })).toThrow()
    expect(() => knowledgePackManifestSchema.parse({ ...manifest, documents: [] })).toThrow()
    expect(() =>
      knowledgePackManifestSchema.parse({
        ...manifest,
        documents: [{ ...manifest.documents[0], subject: 'physics' }],
      }),
    ).toThrow()
    expect(() =>
      knowledgePackManifestSchema.parse({
        ...manifest,
        documents: [{ ...manifest.documents[0], edition: '', editionConfirmed: true }],
      }),
    ).toThrow()
  })

  it.each([
    '../secret.pdf',
    '/secret.pdf',
    'C:\\secret.pdf',
    '\\\\server\\secret.pdf',
    'sub/file.pdf',
    'sub\\file.pdf',
    'https://example.com/book.pdf',
    'book.pdf:stream',
    '.hidden.pdf',
    'book\0.pdf',
    'CON.pdf',
    'CON .pdf',
    'CONIN$.pdf',
    'LPT1.pdf',
    'COM¹.pdf',
    'book.pdf ',
    'book.zip',
  ])('rejects non-portable path or non-PDF filename %s', (file) => {
    const manifest = manifestFor([testBytes('A')])
    expect(() =>
      knowledgePackManifestSchema.parse({
        ...manifest,
        documents: [{ ...manifest.documents[0], file }],
      }),
    ).toThrow()
  })

  it('rejects duplicate normalized names, duplicate content, remote extras and excessive entries', () => {
    const manifest = manifestFor([testBytes('A'), testBytes('B')])
    for (const files of [
      ['book.pdf', 'BOOK.PDF'],
      ['é.pdf', 'e\u0301.pdf'],
    ]) {
      expect(() =>
        knowledgePackManifestSchema.parse({
          ...manifest,
          documents: manifest.documents.map((entry, index) => ({ ...entry, file: files[index] })),
        }),
      ).toThrow()
    }
    expect(() =>
      knowledgePackManifestSchema.parse({
        ...manifest,
        documents: [
          manifest.documents[0],
          { ...manifest.documents[1], sha256: manifest.documents[0].sha256 },
        ],
      }),
    ).toThrow()
    expect(() =>
      knowledgePackManifestSchema.parse({
        ...manifest,
        documents: [{ ...manifest.documents[0], remoteUrl: 'https://example.com/book.pdf' }],
      }),
    ).toThrow()
    expect(() =>
      knowledgePackManifestSchema.parse(
        manifestFor(Array.from({ length: 13 }, (_, index) => testBytes(String(index)))),
      ),
    ).toThrow()
  })

  it('rejects unordered, oversized and unbounded fragment declarations', () => {
    const manifest = manifestFor([testBytes('A')])
    const entry = manifest.documents[0]
    const part = { file: `${entry.file}.part01`, sha256: 'a'.repeat(64), byteLength: 10 }
    const second = { ...part, file: `${entry.file}.part02` }
    for (const parts of [
      [part],
      [second, part],
      [part, { ...second, file: '../secret.pdf.part02' }],
      [part, { ...second, byteLength: MAX_KNOWLEDGE_PACK_PART_BYTES + 1 }],
      Array.from({ length: 5 }, (_, index) => ({
        ...part,
        file: `${entry.file}.part0${index + 1}`,
      })),
      [part, second, { ...part, file: `${entry.file}.part03` }].map((value) => ({
        ...value,
        byteLength: MAX_KNOWLEDGE_PACK_PART_BYTES,
      })),
    ])
      expect(() =>
        knowledgePackManifestSchema.parse({ ...manifest, documents: [{ ...entry, parts }] }),
      ).toThrow()
  })
})

describe('local private pack import', () => {
  it('imports six original PDFs and metadata, then deduplicates without overwriting metadata', async () => {
    const fixture = await pack(subjects.map(testBytes))
    const originalManifest = await readFile(fixture.path)
    const result = await importKnowledgePackFromSelectedManifest(fixture.path, fixture.library)
    expect(result).toMatchObject({
      canceled: false,
      validationPassed: true,
      importedCount: 6,
      duplicateCount: 0,
      failedCount: 0,
    })
    expect(result.items.every((item) => item.status === 'imported')).toBe(true)
    for (const [index, document] of result.documents.entries()) {
      expect(document).toMatchObject({
        subject: subjects[index],
        edition: '测试版本，非真实教材',
        editionConfirmed: false,
        pageCount: 1,
      })
      expect(await fixture.library.getBytes(document.id)).toEqual(fixture.bytes[index])
      expect(
        await readFile(join(fixture.directory, fixture.manifest.documents[index].file)),
      ).toEqual(Buffer.from(fixture.bytes[index]))
    }
    expect(await readFile(fixture.path)).toEqual(originalManifest)
    fixture.manifest.documents[0] = {
      ...fixture.manifest.documents[0],
      title: '不可覆盖',
      subject: 'history',
      edition: '另一版本',
      editionConfirmed: true,
    }
    await fixture.save()
    const again = await importKnowledgePackFromSelectedManifest(fixture.path, fixture.library)
    expect(again).toMatchObject({ importedCount: 0, duplicateCount: 6, failedCount: 0 })
    expect(again.documents).toEqual(result.documents)
  })

  it('reconstructs split bytes exactly, preserving the original PDF and physical pages', async () => {
    const fixture = await pack([
      createKnowledgePdf(['Original synthetic A', '', 'Original synthetic C']),
    ])
    const { entry, slices } = await splitFirst(fixture)
    const result = await importKnowledgePackFromSelectedManifest(fixture.path, fixture.library)
    expect(result).toMatchObject({ validationPassed: true, importedCount: 1, failedCount: 0 })
    expect(result.documents[0].pageCount).toBe(3)
    expect(await fixture.library.getBytes(result.documents[0].id)).toEqual(fixture.bytes[0])
    for (const [index, part] of entry.parts!.entries())
      expect(await readFile(join(fixture.directory, part.file))).toEqual(Buffer.from(slices[index]))
    expect(await readdir(fixture.directory)).not.toContain(entry.file)
  })

  it('validates every source before any import when a later whole-PDF hash is wrong', async () => {
    const fixture = await pack()
    fixture.manifest.documents[1].sha256 = 'a'.repeat(64)
    await fixture.save()
    const call = vi.spyOn(fixture.library, 'importBytes')
    const result = await importKnowledgePackFromSelectedManifest(fixture.path, fixture.library)
    expect(result).toMatchObject({ validationPassed: false, importedCount: 0, failedCount: 1 })
    expect(result.items.map((item) => item.status)).toEqual(['pending', 'failed'])
    expect(result.items[1].error).toContain('SHA-256')
    expect(call).not.toHaveBeenCalled()
    expect(await fixture.library.list()).toEqual([])
  })

  it.each(['missing', 'length', 'partHash', 'wholeHash', 'swapped'] as const)(
    'rejects %s split inputs before import',
    async (failure) => {
      const fixture = await pack()
      const { entry, slices } = await splitFirst(fixture)
      if (failure === 'missing') await rm(join(fixture.directory, entry.parts![1].file))
      if (failure === 'length') entry.parts![1].byteLength++
      if (failure === 'partHash') entry.parts![1].sha256 = 'a'.repeat(64)
      if (failure === 'wholeHash') entry.sha256 = 'b'.repeat(64)
      if (failure === 'swapped') {
        await writeFile(join(fixture.directory, entry.parts![0].file), slices[1])
        await writeFile(join(fixture.directory, entry.parts![1].file), slices[0])
      }
      await fixture.save()
      const result = await importKnowledgePackFromSelectedManifest(fixture.path, fixture.library)
      expect(result).toMatchObject({ validationPassed: false, importedCount: 0, failedCount: 1 })
      expect(result.items[0].error).not.toContain(fixture.directory)
      expect(await fixture.library.list()).toEqual([])
    },
  )

  it('retains per-file parsing failures while continuing valid files, and safely retries', async () => {
    const fixture = await pack([
      new TextEncoder().encode('%PDF-broken synthetic'),
      testBytes('valid'),
    ])
    const result = await importKnowledgePackFromSelectedManifest(fixture.path, fixture.library)
    expect(result).toMatchObject({
      validationPassed: true,
      importedCount: 1,
      failedCount: 1,
      canceled: false,
    })
    expect(result.items.map((item) => item.status)).toEqual(['failed', 'imported'])
    expect(result.items[0].error).toContain('无法读取')
    const again = await importKnowledgePackFromSelectedManifest(fixture.path, fixture.library)
    expect(again).toMatchObject({ importedCount: 0, duplicateCount: 1, failedCount: 1 })
    expect(await fixture.library.list()).toHaveLength(1)
  })

  it('imports the validated snapshot even if original files change after preflight', async () => {
    const fixture = await pack()
    const importBytes = fixture.library.importBytes.bind(fixture.library)
    let first = true
    const result = await importKnowledgePackFromSelectedManifest(fixture.path, {
      async importBytes(title, bytes, options) {
        if (first) {
          first = false
          await writeFile(
            join(fixture.directory, fixture.manifest.documents[1].file),
            testBytes('changed'),
          )
        }
        return importBytes(title, bytes, options)
      },
    })
    expect(result.importedCount).toBe(2)
    expect(await fixture.library.getBytes(result.documents[1].id)).toEqual(fixture.bytes[1])
  })

  it('reports committed work on cancellation and retries remaining items without overwriting', async () => {
    const fixture = await pack()
    await splitFirst(fixture)
    const controller = new AbortController()
    const result = await importKnowledgePackFromSelectedManifest(
      fixture.path,
      {
        async importBytes(title, bytes, options) {
          const imported = await fixture.library.importBytes(title, bytes, options)
          controller.abort()
          return imported
        },
      },
      { signal: controller.signal },
    )
    expect(result).toMatchObject({
      canceled: true,
      validationPassed: true,
      importedCount: 1,
      failedCount: 0,
    })
    expect(result.items.map((item) => item.status)).toEqual(['imported', 'pending'])
    expect(await fixture.library.list()).toHaveLength(1)
    const again = await importKnowledgePackFromSelectedManifest(fixture.path, fixture.library)
    expect(again).toMatchObject({
      canceled: false,
      importedCount: 1,
      duplicateCount: 1,
      failedCount: 0,
    })
  })

  it('handles early and in-parser cancellation without recording failures or hiding saved work', async () => {
    const fixture = await pack()
    const early = new AbortController()
    early.abort()
    expect(
      await importKnowledgePackFromSelectedManifest(fixture.path, fixture.library, {
        signal: early.signal,
      }),
    ).toMatchObject({ canceled: true, importedCount: 0, failedCount: 0, items: [] })
    const result = await importKnowledgePackFromSelectedManifest(fixture.path, {
      importBytes: () => Promise.reject(new KnowledgeLibraryError('PDF_CANCELED')),
    })
    expect(result).toMatchObject({ canceled: true, importedCount: 0, failedCount: 0 })
    expect(result.items.every((item) => item.status === 'pending')).toBe(true)
  })

  it('cleans private staged PDF copies on hash failure, parser failure and successful import', async () => {
    const before = (await readdir(tmpdir()))
      .filter((name) => name.startsWith('examcraft-private-pack-'))
      .sort()
    const fixture = await pack([new TextEncoder().encode('%PDF-malformed synthetic')])
    await importKnowledgePackFromSelectedManifest(fixture.path, fixture.library)
    fixture.manifest.documents[0].sha256 = 'b'.repeat(64)
    await fixture.save()
    await importKnowledgePackFromSelectedManifest(fixture.path, fixture.library)
    const valid = await pack([testBytes('valid')])
    await importKnowledgePackFromSelectedManifest(valid.path, valid.library)
    const after = (await readdir(tmpdir()))
      .filter((name) => name.startsWith('examcraft-private-pack-'))
      .sort()
    expect(after).toEqual(before)
  })
})

describe('private pack filesystem boundaries', () => {
  it('rejects manifest misnaming, remote paths, malformed JSON, extras and oversize without native paths', async () => {
    const fixture = await pack()
    for (const path of [
      'pack.json',
      'https://example.com/pack.json',
      join(fixture.directory, 'other.json'),
    ])
      await expect(
        importKnowledgePackFromSelectedManifest(path, fixture.library),
      ).rejects.toMatchObject({ code: 'PACK_MANIFEST_INVALID' })
    for (const content of [
      '{ broken',
      JSON.stringify({ ...fixture.manifest, answers: [] }),
      ' '.repeat(MAX_KNOWLEDGE_PACK_MANIFEST_BYTES + 1),
    ]) {
      await writeFile(fixture.path, content)
      await expect(
        importKnowledgePackFromSelectedManifest(fixture.path, fixture.library),
      ).rejects.not.toThrow(fixture.directory)
    }
    expect(await fixture.library.list()).toEqual([])
  })

  it('rejects missing, directory, hard-linked and symlinked sources', async () => {
    const fixture = await pack([testBytes('A')])
    const path = join(fixture.directory, fixture.manifest.documents[0].file)
    await rm(path)
    expect(
      (await importKnowledgePackFromSelectedManifest(fixture.path, fixture.library)).failedCount,
    ).toBe(1)
    await mkdir(path)
    expect(
      (await importKnowledgePackFromSelectedManifest(fixture.path, fixture.library)).failedCount,
    ).toBe(1)
    await rm(path, { recursive: true })
    const other = join(fixture.directory, 'other.pdf')
    await writeFile(other, fixture.bytes[0])
    await link(other, path)
    expect(
      (await importKnowledgePackFromSelectedManifest(fixture.path, fixture.library)).failedCount,
    ).toBe(1)
    await rm(path)
    if (process.platform !== 'win32') {
      await symlink(other, path)
      expect(
        (await importKnowledgePackFromSelectedManifest(fixture.path, fixture.library)).failedCount,
      ).toBe(1)
      await rm(fixture.path)
      const actualManifest = join(fixture.directory, 'actual.json')
      await writeFile(actualManifest, JSON.stringify(fixture.manifest))
      await symlink(actualManifest, fixture.path)
      await expect(
        importKnowledgePackFromSelectedManifest(fixture.path, fixture.library),
      ).rejects.toMatchObject({ code: 'PACK_FILE_INVALID' })
    }
    expect(await fixture.library.list()).toEqual([])
  })

  it('bounds individual and aggregate bytes before reading file content', async () => {
    const fixture = await pack(Array.from({ length: 7 }, (_, index) => testBytes(String(index))))
    for (const entry of fixture.manifest.documents) {
      const handle = await open(join(fixture.directory, entry.file), 'w')
      await handle.truncate(45 * 1024 * 1024)
      await handle.close()
    }
    const total = await importKnowledgePackFromSelectedManifest(fixture.path, fixture.library)
    expect(total).toMatchObject({ validationPassed: false, importedCount: 0, failedCount: 1 })
    expect(total.items[6].error).toContain('300 MiB')
    const path = join(fixture.directory, fixture.manifest.documents[0].file)
    const handle = await open(path, 'w')
    await handle.truncate(MAX_KNOWLEDGE_PDF_BYTES + 1)
    await handle.close()
    const oversize = await importKnowledgePackFromSelectedManifest(fixture.path, fixture.library)
    expect(oversize.items[0].error).toContain('50 MiB')
    expect(await fixture.library.list()).toEqual([])
  })
})
