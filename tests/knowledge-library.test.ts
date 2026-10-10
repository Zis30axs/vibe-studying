import { build } from 'esbuild'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { extractKnowledgePdf, LocalKnowledgeLibrary } from '../src/adapters/knowledge-library'
import {
  KNOWLEDGE_SUBJECTS,
  MAX_KNOWLEDGE_CHUNK_TEXT,
  MAX_KNOWLEDGE_PDF_BYTES,
} from '../src/shared/knowledge'
import { createKnowledgePdf } from './fixtures/knowledge-pdf'

let temporary: string
let workerPath: string
beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'examcraft-knowledge-tests-'))
  // Keep the test bundle under the checkout so its external PDF.js resolves
  // installed dependencies. A separate smoke below tests isolated packaging.
  workerPath = resolve('dist-electron/knowledge-pdf-worker-test.cjs')
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
async function library() {
  const home = await mkdtemp(join(temporary, 'profile-'))
  return { home, store: new LocalKnowledgeLibrary(home, { workerPath }) }
}
async function imported(store: LocalKnowledgeLibrary, pages?: string[]) {
  const result = await store.importBytes('自编练习 PDF', createKnowledgePdf(pages))
  if (result.canceled) throw new Error('Unexpected canceled test import')
  return result
}

describe('local PDF import and physical-page search', () => {
  it('isolates all six subjects by explicit selected book and subject without changing physical chunk IDs', async () => {
    const { store, home } = await library()
    for (const subject of KNOWLEDGE_SUBJECTS) {
      const result = await store.importBytes(
        `合成 ${subject} 教材`,
        createKnowledgePdf([`${subject} 知识测试。`]),
        {
          subject,
          edition: '合成假定版本',
        },
      )
      if (result.canceled) throw new Error('Unexpected cancellation')
      expect(result.document).toMatchObject({
        subject,
        edition: '合成假定版本',
        editionConfirmed: false,
      })
      const hits = await store.search({
        documentId: result.document.id,
        subject,
        query: '知识测试',
      })
      expect(hits).toHaveLength(1)
      expect(hits[0]).toMatchObject({
        subject,
        chunkId: `${result.document.id}:p1:c1`,
        pageNumber: 1,
      })
      expect(await store.resolveChunks([hits[0].chunkId])).toEqual(
        [{ ...hits[0], score: undefined }].map(({ score: _score, ...hit }) => hit),
      )
      await expect(
        store.search({
          documentId: result.document.id,
          subject: subject === 'math' ? 'history' : 'math',
          query: '知识测试',
        }),
      ).rejects.toThrow('学科不一致')
    }
    const restarted = new LocalKnowledgeLibrary(home, { workerPath })
    expect(new Set((await restarted.list()).map((document) => document.subject))).toEqual(
      new Set(KNOWLEDGE_SUBJECTS),
    )
    expect(() => restarted.search({ subject: 'math', query: '知识测试' })).toThrow()
  })

  it('edits metadata without rewriting source or index, preserves chapters, and never reassigns duplicates', async () => {
    const { store, home } = await library()
    const bytes = createKnowledgePdf(['函数关系由定义和条件限定。', '这是另一个合成页面。'])
    const first = await store.importBytes('初始书名', bytes, {
      subject: 'math',
      edition: '假定版本',
    })
    if (first.canceled) throw new Error('Unexpected cancellation')
    const documentId = first.document.id
    const scopes = [{ id: 'functions', label: '合成函数章节', startPage: 1, endPage: 1 }]
    await store.saveScopes({ documentId, scopes })
    const stored = join(home, 'knowledge-library', documentId)
    const indexBefore = await readFile(join(stored, 'text.json'))
    const hitsBefore = await store.search({ documentId, subject: 'math', query: '函数' })
    const updated = await store.updateDocumentMetadata({
      documentId,
      title: '核对后的书名',
      edition: '核对后的版本',
      editionConfirmed: true,
    })
    expect(updated).toMatchObject({
      id: documentId,
      subject: 'math',
      title: '核对后的书名',
      edition: '核对后的版本',
      editionConfirmed: true,
      scopes,
    })
    expect(await readFile(join(stored, 'source.pdf'))).toEqual(Buffer.from(bytes))
    expect(await readFile(join(stored, 'text.json'))).toEqual(indexBefore)
    const hits = await store.search({ documentId, subject: 'math', query: '函数' })
    expect(hits.map(({ chunkId, pageNumber, text }) => ({ chunkId, pageNumber, text }))).toEqual(
      hitsBefore.map(({ chunkId, pageNumber, text }) => ({ chunkId, pageNumber, text })),
    )
    expect(hits[0].documentTitle).toBe('核对后的书名')
    expect(
      await store.importBytes('错误新书名', bytes, { subject: 'history', edition: '错误版本' }),
    ).toEqual({
      canceled: false,
      document: updated,
      duplicate: true,
    })
    // Optional undefined values must not reset a book's subject through legacy defaults.
    expect(
      await store.updateDocumentMetadata({
        documentId,
        title: '另一个书名',
        subject: undefined,
        edition: undefined,
      }),
    ).toMatchObject({
      subject: 'math',
      edition: '核对后的版本',
      editionConfirmed: true,
    })
    const unconfirmed = await store.updateDocumentMetadata({ documentId, edition: '新版待核对' })
    expect(unconfirmed).toMatchObject({ editionConfirmed: false, scopes })
    await expect(
      store.updateDocumentMetadata({ documentId, edition: '', editionConfirmed: true }),
    ).rejects.toThrow('版本')
    expect((await store.list())[0]).toEqual(unconfirmed)
    const changedSubject = await store.updateDocumentMetadata({ documentId, subject: 'history' })
    expect(changedSubject.subject).toBe('history')
    expect((await store.resolveChunks([hits[0].chunkId]))[0].subject).toBe('history')
    await expect(store.search({ documentId, subject: 'math', query: '函数' })).rejects.toThrow(
      '学科不一致',
    )
    expect(await readFile(join(stored, 'text.json'))).toEqual(indexBefore)
    expect(await store.getBytes(documentId)).toEqual(bytes)
  })

  it('loads old politics-only document metadata without rewriting the original PDF and upgrades on explicit edit', async () => {
    const { store, home } = await library()
    const { document } = await imported(store)
    const {
      subject: _subject,
      edition: _edition,
      editionConfirmed: _confirmed,
      ...legacy
    } = document
    const path = join(home, 'knowledge-library', document.id, 'document.json')
    await writeFile(path, JSON.stringify(legacy))
    const restarted = new LocalKnowledgeLibrary(home, { workerPath })
    expect(await restarted.list()).toEqual([document])
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(legacy)
    const updated = await restarted.updateDocumentMetadata({
      documentId: document.id,
      edition: '待核对',
    })
    expect(updated).toMatchObject({
      subject: 'politics',
      edition: '待核对',
      editionConfirmed: false,
    })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(updated)
    expect(await restarted.getBytes(document.id)).toEqual(createKnowledgePdf())
  })

  it('persists exact original bytes, Chinese pages, scoped search and stable chosen references across restart', async () => {
    const { home, store } = await library()
    const bytes = createKnowledgePdf()
    const first = await store.importBytes('原文测试', bytes)
    expect(first.canceled).toBe(false)
    if (first.canceled) return
    expect(first.document).toMatchObject({
      title: '原文测试',
      pageCount: 3,
      textPageCount: 3,
      scopes: [],
    })
    expect(await store.getBytes(first.document.id)).toEqual(bytes)
    const hits = await store.search({ documentId: first.document.id, query: '依法监督' })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].pageNumber).toBe(2)
    expect(hits[0].text).toContain('依法监督')
    const withScope = await store.saveScopes({
      documentId: first.document.id,
      scopes: [{ id: 'discussion', label: '我标注的讨论章节', startPage: 3, endPage: 3 }],
    })
    expect(withScope.scopes[0].startPage).toBe(3)
    expect(
      await store.search({
        documentId: first.document.id,
        scopeId: 'discussion',
        query: '依法监督',
      }),
    ).toEqual([])
    expect(
      await store.search({
        documentId: first.document.id,
        startPage: 2,
        endPage: 2,
        query: '依法监督',
      }),
    ).toHaveLength(hits.length)
    const restarted = new LocalKnowledgeLibrary(home, { workerPath })
    expect(await restarted.list()).toEqual([withScope])
    const selected = await restarted.resolveChunks([hits[0].chunkId])
    expect(selected).toEqual([
      {
        chunkId: hits[0].chunkId,
        documentId: first.document.id,
        documentTitle: '原文测试',
        subject: 'politics',
        pageNumber: 2,
        text: hits[0].text,
      },
    ])
    const again = await restarted.importBytes('不能覆盖已有标题', bytes)
    expect(again).toMatchObject({ canceled: false, duplicate: true, document: withScope })
    expect(await restarted.list()).toHaveLength(1)
    expect(await readdir(join(home, 'knowledge-library'))).toEqual([first.document.id])
  })
  it('keeps image/empty pages as physical pages and explicitly records lack of searchable text', async () => {
    const { store } = await library()
    const result = await imported(store, ['', '', ''])
    expect(result.document).toMatchObject({ pageCount: 3, textPageCount: 0 })
    expect(await store.search({ documentId: result.document.id, query: '民主' })).toEqual([])
    expect(await store.getBytes(result.document.id)).toEqual(createKnowledgePdf(['', '', '']))
  })
  it('serializes repeated imports and does not cross book boundaries', async () => {
    const { store } = await library()
    const bytes = createKnowledgePdf(['这份书讲公民参与。'])
    const results = await Promise.all([
      store.importBytes('A', bytes),
      store.importBytes('B', bytes),
    ])
    expect(results.map((result) => result.duplicate)).toEqual([false, true])
    const other = await imported(store, ['另一份书仅有环境问题。'])
    expect(await store.search({ documentId: other.document.id, query: '公民参与' })).toEqual([])
    expect(await store.list()).toHaveLength(2)
  })
  it('retains a real image-only scanned page for the reader without inventing OCR text', async () => {
    const { store } = await library()
    const bytes = new Uint8Array(
      await readFile(new URL('./fixtures/knowledge-scan.pdf', import.meta.url)),
    )
    const result = await store.importBytes('自编扫描测试', bytes)
    if (result.canceled) throw new Error('Unexpected cancellation')
    expect(result.document).toMatchObject({ pageCount: 1, textPageCount: 0 })
    expect(await store.search({ documentId: result.document.id, query: '公民参与' })).toEqual([])
    expect(await store.getBytes(result.document.id)).toEqual(bytes)
  })
  it('bounds excerpts and re-resolves exact text instead of accepting client-authored evidence', async () => {
    const { store } = await library()
    const result = await store.importBytes(
      '长页测试',
      createKnowledgePdf(
        [
          '依法监督，公民有序参与。'
            .repeat(170)
            .match(/.{1,32}/g)!
            .join('\n'),
        ],
        { lineHeight: 8 },
      ),
    )
    if (result.canceled) throw new Error('Unexpected cancellation')
    const hits = await store.search({
      documentId: result.document.id,
      query: '依法监督',
      limit: 30,
    })
    expect(hits.length).toBeGreaterThan(1)
    expect(
      hits.every((hit) => hit.text.length <= MAX_KNOWLEDGE_CHUNK_TEXT && hit.pageNumber === 1),
    ).toBe(true)
    expect(await store.resolveChunks(hits.slice(0, 3).map((hit) => hit.chunkId))).toHaveLength(
      Math.min(hits.length, 3),
    )
    expect(() => store.resolveChunks([hits[0].chunkId, hits[0].chunkId])).toThrow()
    expect(() => store.resolveChunks(Array(4).fill(hits[0].chunkId))).toThrow()
    await expect(store.resolveChunks([`${result.document.id}:p1500:c1`])).rejects.toThrow('不存在')
  })
})

describe('PDF failure, cancellation and storage boundaries', () => {
  it('rejects malformed/oversize inputs without committing state, then permits a valid import', async () => {
    const { store, home } = await library()
    await expect(
      store.importBytes('broken', new TextEncoder().encode('%PDF-invalid broken file')),
    ).rejects.toMatchObject({ code: 'PDF_INVALID' })
    await expect(
      store.importBytes('large', new Uint8Array(MAX_KNOWLEDGE_PDF_BYTES + 1)),
    ).rejects.toMatchObject({ code: 'PDF_SIZE_LIMIT' })
    expect(await store.list()).toEqual([])
    expect(await readdir(join(home, 'knowledge-library'))).toEqual([])
    expect((await imported(store)).document.pageCount).toBe(3)
  })
  it('rejects password protected PDFs explicitly without requesting/storing passwords', async () => {
    const { store } = await library()
    const encrypted = new Uint8Array(
      await readFile(new URL('./fixtures/knowledge-encrypted.pdf', import.meta.url)),
    )
    await expect(store.importBytes('encrypted', encrypted)).rejects.toMatchObject({
      code: 'PDF_ENCRYPTED',
    })
    expect(await store.list()).toEqual([])
  })
  it('cancels before parsing and in-flight, cleans uncommitted state, and permits reimport', async () => {
    const { store, home } = await library()
    const already = new AbortController()
    already.abort()
    await expect(
      store.importBytes('cancel', createKnowledgePdf(), { signal: already.signal }),
    ).rejects.toMatchObject({ code: 'PDF_CANCELED' })
    const inflight = new AbortController()
    const pending = store.importBytes('cancel', createKnowledgePdf(Array(80).fill('知识测试。')), {
      signal: inflight.signal,
    })
    setTimeout(() => inflight.abort(), 10)
    await expect(pending).rejects.toMatchObject({ code: 'PDF_CANCELED' })
    expect(await store.list()).toEqual([])
    expect(await readdir(join(home, 'knowledge-library'))).toEqual([])
    expect((await imported(store)).duplicate).toBe(false)
  })
  it('times out a stalled worker and remains responsive', async () => {
    const worker = join(temporary, 'stalled.cjs')
    await writeFile(worker, 'setInterval(() => {}, 1000)')
    await expect(
      extractKnowledgePdf(createKnowledgePdf(), { workerPath: worker, timeoutMs: 20 }),
    ).rejects.toMatchObject({ code: 'PDF_TIMEOUT' })
  })
  it('rejects excessive pages and text instead of silently truncating an indexed book', async () => {
    const { store } = await library()
    await expect(
      store.importBytes('many pages', createKnowledgePdf(Array(1501).fill(''))),
    ).rejects.toMatchObject({ code: 'PDF_PAGE_LIMIT' })
    // All text must remain inside the physical page; PDF.js correctly excludes
    // off-page glyphs, so this stress fixture intentionally overlays rows.
    await expect(
      store.importBytes(
        'too much text',
        createKnowledgePdf(
          [
            '中'
              .repeat(100_001)
              .match(/.{1,32}/g)!
              .join('\n'),
          ],
          { lineHeight: 0 },
        ),
      ),
    ).rejects.toMatchObject({ code: 'PDF_TEXT_LIMIT' })
    expect(await store.list()).toEqual([])
  })
  it('rejects path traversal, forged metadata, unknown scope and out-of-range pages', async () => {
    const { store } = await library()
    expect(() => store.getBytes('../secret')).toThrow()
    expect(() => store.search({ documentId: '../../secret', query: '秘密' })).toThrow()
    expect(() => store.search({ query: '默认全库' })).toThrow()
    const { document } = await imported(store)
    expect(() =>
      store.search({ documentId: document.id, query: 'test', arbitraryPath: '/etc/passwd' }),
    ).toThrow()
    await expect(
      store.search({ documentId: document.id, query: 'text', scopeId: 'unknown' }),
    ).rejects.toThrow('章节')
    await expect(
      store.search({ documentId: document.id, query: 'text', startPage: 1, endPage: 4 }),
    ).rejects.toThrow('页码')
    await expect(
      store.saveScopes({
        documentId: document.id,
        scopes: [{ id: 'wrong', label: '超出', startPage: 1, endPage: 4 }],
      }),
    ).rejects.toThrow()
    expect((await store.list())[0].scopes).toEqual([])
  })
  it('rejects changed bytes or symlinked stored files and hides filesystem paths', async () => {
    const { store, home } = await library()
    const { document } = await imported(store)
    const original = join(home, 'knowledge-library', document.id, 'source.pdf')
    await writeFile(original, createKnowledgePdf(['Changed content']))
    await expect(store.getBytes(document.id)).rejects.toMatchObject({ code: 'PDF_STORAGE_INVALID' })
    await rm(original)
    const target = join(temporary, 'other.pdf')
    await writeFile(target, createKnowledgePdf())
    if (process.platform !== 'win32') {
      await symlink(target, original)
      await expect(store.getBytes(document.id)).rejects.toMatchObject({
        code: 'PDF_STORAGE_INVALID',
      })
      await rm(original)
    }
    await expect(store.getBytes(document.id)).rejects.toThrow('本地 PDF 数据')
    await expect(store.getBytes(document.id)).rejects.not.toThrow(home)
  })
})
