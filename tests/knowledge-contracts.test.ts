import { describe, expect, it } from 'vitest'
import {
  chosenKnowledgeChunkIdsSchema,
  knowledgeDocumentIdSchema,
  knowledgeDocumentSchema,
  knowledgeEvidenceSchema,
  knowledgeImportOptionsSchema,
  knowledgeUpdateMetadataInputSchema,
  KNOWLEDGE_SUBJECTS,
  knowledgeRequestIdSchema,
  knowledgeSaveScopesInputSchema,
  knowledgeSearchInputSchema,
  MAX_KNOWLEDGE_CHUNK_TEXT,
  MAX_KNOWLEDGE_DOCUMENTS,
  MAX_KNOWLEDGE_EVIDENCE,
  MAX_KNOWLEDGE_PAGES,
  MAX_KNOWLEDGE_PDF_BYTES,
} from '../src/shared/knowledge'

const documentId = 'a'.repeat(64)
const chunkId = `${documentId}:p2:c1`
const document = {
  id: documentId,
  title: 'Synthetic civic notes',
  byteLength: 1024,
  pageCount: 3,
  textPageCount: 2,
  importedAt: '2026-01-01T00:00:00.000Z',
  scopes: [{ id: 'section-1', label: 'Physical pages 2–3', startPage: 2, endPage: 3 }],
}
const evidence = {
  chunkId,
  documentId,
  documentTitle: document.title,
  pageNumber: 2,
  text: 'A self-authored synthetic source excerpt.',
}

describe('local PDF renderer / main-process contracts', () => {
  it('defaults legacy books and evidence to politics while accepting all six explicit subjects', () => {
    expect(knowledgeDocumentSchema.parse(document)).toMatchObject({
      subject: 'politics',
      edition: '',
      editionConfirmed: false,
    })
    expect(knowledgeEvidenceSchema.parse(evidence).subject).toBe('politics')
    expect(KNOWLEDGE_SUBJECTS).toEqual([
      'chinese',
      'math',
      'english',
      'politics',
      'history',
      'geography',
    ])
    for (const subject of KNOWLEDGE_SUBJECTS) {
      expect(knowledgeDocumentSchema.parse({ ...document, subject }).subject).toBe(subject)
      expect(knowledgeEvidenceSchema.parse({ ...evidence, subject }).subject).toBe(subject)
      expect(knowledgeSearchInputSchema.parse({ documentId, subject, query: 'test' }).subject).toBe(
        subject,
      )
      expect(knowledgeImportOptionsSchema.parse({ subject, edition: '  合成测试版  ' })).toEqual({
        subject,
        edition: '合成测试版',
      })
    }
    for (const subject of ['science', '', '../politics', null]) {
      expect(knowledgeDocumentSchema.safeParse({ ...document, subject }).success).toBe(false)
      expect(knowledgeImportOptionsSchema.safeParse({ subject }).success).toBe(false)
      expect(
        knowledgeSearchInputSchema.safeParse({ documentId, subject, query: 'test' }).success,
      ).toBe(false)
      expect(knowledgeEvidenceSchema.safeParse({ ...evidence, subject }).success).toBe(false)
    }
  })

  it('bounds editable metadata and rejects source, index, scope and version-verification forgery', () => {
    expect(knowledgeUpdateMetadataInputSchema.parse({ documentId, title: '  合成书  ' })).toEqual({
      documentId,
      title: '合成书',
    })
    for (const metadata of [
      {},
      { title: '' },
      { title: 'x'.repeat(201) },
      { edition: 'x'.repeat(201) },
      { subject: 'science' },
      { editionConfirmed: 'true' },
      { title: 'test', source: '/tmp/replace.pdf' },
      { title: 'test', scopes: [] },
      { title: 'test', pageCount: 500 },
      { title: 'test', id: 'b'.repeat(64) },
    ])
      expect(
        knowledgeUpdateMetadataInputSchema.safeParse({ documentId, ...metadata }).success,
      ).toBe(false)
    expect(knowledgeImportOptionsSchema.safeParse({ editionConfirmed: true }).success).toBe(false)
    expect(
      knowledgeImportOptionsSchema.safeParse({ edition: ' ', editionConfirmed: true }).success,
    ).toBe(false)
    expect(
      knowledgeImportOptionsSchema.safeParse({ edition: '核对后的版本', editionConfirmed: true })
        .success,
    ).toBe(true)
    expect(knowledgeDocumentSchema.safeParse({ ...document, editionConfirmed: true }).success).toBe(
      false,
    )
  })

  it('uses bounded hash IDs, never paths or remote URLs, for library documents', () => {
    expect(knowledgeDocumentIdSchema.parse(documentId)).toBe(documentId)
    for (const value of [
      '../source.pdf',
      '/tmp/source.pdf',
      'C:\\source.pdf',
      'file:///tmp/source.pdf',
      'https://example.test/source.pdf',
      'a'.repeat(63),
      'a'.repeat(65),
      'G'.repeat(64),
    ])
      expect(knowledgeDocumentIdSchema.safeParse(value).success).toBe(false)
  })

  it('bounds operation IDs and rejects path notation', () => {
    for (const value of ['', '../pending', '/pending', 'request.id', 'request '.repeat(20)])
      expect(knowledgeRequestIdSchema.safeParse(value).success).toBe(false)
    expect(knowledgeRequestIdSchema.parse('cancel-request_123')).toBe('cancel-request_123')
  })

  it('projects only safe document metadata and rejects hidden filenames or text', () => {
    expect(knowledgeDocumentSchema.parse(document)).toEqual({
      ...document,
      subject: 'politics',
      edition: '',
      editionConfirmed: false,
    })
    for (const extra of [
      { path: '/tmp/private.pdf' },
      { url: 'https://example.test/book.pdf' },
      { text: 'Hidden document text' },
      { rubric: 'Private teacher rubric' },
    ])
      expect(knowledgeDocumentSchema.safeParse({ ...document, ...extra }).success).toBe(false)
  })

  it('requires finite physical page counts and consistent extracted-page metadata', () => {
    for (const pageCount of [0, -1, 1.5, Number.POSITIVE_INFINITY, MAX_KNOWLEDGE_PAGES + 1])
      expect(knowledgeDocumentSchema.safeParse({ ...document, pageCount }).success).toBe(false)
    expect(knowledgeDocumentSchema.safeParse({ ...document, textPageCount: 4 }).success).toBe(false)
    expect(knowledgeDocumentSchema.safeParse({ ...document, textPageCount: 0 }).success).toBe(true)
    expect(
      knowledgeDocumentSchema.safeParse({ ...document, byteLength: MAX_KNOWLEDGE_PDF_BYTES + 1 })
        .success,
    ).toBe(false)
  })

  it('rejects duplicate scope identifiers and out-of-document ranges', () => {
    const scopes = document.scopes
    expect(
      knowledgeDocumentSchema.safeParse({ ...document, scopes: [...scopes, ...scopes] }).success,
    ).toBe(false)
    expect(
      knowledgeSaveScopesInputSchema.safeParse({ documentId, scopes: [...scopes, ...scopes] })
        .success,
    ).toBe(false)
    expect(
      knowledgeDocumentSchema.safeParse({ ...document, scopes: [{ ...scopes[0], endPage: 4 }] })
        .success,
    ).toBe(false)
    expect(
      knowledgeDocumentSchema.safeParse({
        ...document,
        scopes: [{ ...scopes[0], startPage: 3, endPage: 2 }],
      }).success,
    ).toBe(false)
  })

  it('accepts one explicit search scope and rejects ambiguous or partial scope requests', () => {
    expect(
      knowledgeSearchInputSchema.parse({
        documentId,
        query: '  civic  ',
        startPage: 2,
        endPage: 3,
      }),
    ).toEqual({ documentId, query: 'civic', startPage: 2, endPage: 3 })
    for (const scope of [
      { startPage: 2 },
      { endPage: 3 },
      { startPage: 3, endPage: 2 },
      { scopeId: 'section-1', startPage: 2, endPage: 3 },
      { startPage: 0, endPage: 3 },
      { startPage: 1, endPage: MAX_KNOWLEDGE_PAGES + 1 },
    ])
      expect(
        knowledgeSearchInputSchema.safeParse({ documentId, query: 'civic', ...scope }).success,
      ).toBe(false)
  })

  it('bounds local search and rejects caller-supplied file paths and unbounded options', () => {
    for (const extra of [
      { query: '' },
      { query: ' '.repeat(4) },
      { query: 'q'.repeat(301) },
      { limit: 0 },
      { limit: 31 },
      { limit: Number.POSITIVE_INFINITY },
      { path: '/tmp/private.pdf' },
      { url: 'https://example.test/private.pdf' },
      { includeReference: true },
      { rubric: 'never source evidence' },
    ])
      expect(
        knowledgeSearchInputSchema.safeParse({ documentId, query: 'civic', ...extra }).success,
      ).toBe(false)
  })

  it('keeps citation data bounded and rejects hidden/reference or executable metadata', () => {
    expect(knowledgeEvidenceSchema.parse(evidence)).toEqual({ ...evidence, subject: 'politics' })
    for (const extra of [
      { text: '' },
      { text: 'x'.repeat(MAX_KNOWLEDGE_CHUNK_TEXT + 1) },
      { pageNumber: 0 },
      { pageNumber: 1.5 },
      { pageNumber: MAX_KNOWLEDGE_PAGES + 1 },
      { href: 'javascript:alert(1)' },
      { path: '/tmp/private.pdf' },
      { explanation: 'teacher-only' },
      { rubric: [] },
    ])
      expect(knowledgeEvidenceSchema.safeParse({ ...evidence, ...extra }).success).toBe(false)
  })

  it('limits selected citations and rejects duplicate, malformed and path-based IDs', () => {
    expect(chosenKnowledgeChunkIdsSchema.parse([])).toEqual([])
    expect(chosenKnowledgeChunkIdsSchema.parse([chunkId])).toEqual([chunkId])
    expect(chosenKnowledgeChunkIdsSchema.safeParse([chunkId, chunkId]).success).toBe(false)
    expect(
      chosenKnowledgeChunkIdsSchema.safeParse(
        Array.from(
          { length: MAX_KNOWLEDGE_EVIDENCE + 1 },
          (_, index) => `${documentId}:p2:c${index + 1}`,
        ),
      ).success,
    ).toBe(false)
    for (const value of [
      '../private.pdf:p1:c1',
      `${documentId}:p0:c1`,
      `${documentId}:p1:c0`,
      `${documentId}:p1.5:c1`,
    ])
      expect(chosenKnowledgeChunkIdsSchema.safeParse([value]).success).toBe(false)
  })

  it('retains explicit bounded resource budgets', () => {
    expect(MAX_KNOWLEDGE_DOCUMENTS).toBeLessThanOrEqual(100)
    expect(MAX_KNOWLEDGE_PDF_BYTES).toBeLessThanOrEqual(50 * 1024 * 1024)
    expect(MAX_KNOWLEDGE_PAGES).toBeLessThanOrEqual(1500)
    expect(MAX_KNOWLEDGE_EVIDENCE).toBeLessThanOrEqual(3)
  })
})
