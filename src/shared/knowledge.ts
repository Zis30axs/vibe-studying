import { z } from 'zod'
import { subjectLabel, subjects } from './subjects'
import type { KnowledgePackImportResult } from './knowledge-pack'

export const KNOWLEDGE_SUBJECTS = subjects
export const KNOWLEDGE_SUBJECT_LABELS = subjectLabel
export const knowledgeSubjectSchema = z.enum(KNOWLEDGE_SUBJECTS)
export const KNOWLEDGE_MATH_EXTRACTION_WARNING =
  '数学 PDF 的公式、上下标和符号可能提取不完整；文本检索不验证公式或推导，请对照 PDF 原页核对。'
const documentTitle = z.string().trim().min(1).max(200)
const documentEdition = z.string().trim().max(200)

export const knowledgeImportOptionsSchema = z
  .strictObject({
    subject: knowledgeSubjectSchema.optional(),
    edition: documentEdition.optional(),
    editionConfirmed: z.boolean().optional(),
  })
  .refine((value) => !value.editionConfirmed || !!value.edition, '请先填写版本，再确认版本信息')

// All page numbers are physical, 1-based PDF pages, never inferred printed numbers.
export const MAX_KNOWLEDGE_PDF_BYTES = 50 * 1024 * 1024
export const MAX_KNOWLEDGE_PAGES = 1500
export const MAX_KNOWLEDGE_PAGE_TEXT = 100_000
export const MAX_KNOWLEDGE_TEXT = 5_000_000
export const MAX_KNOWLEDGE_CHUNK_TEXT = 1200
export const MAX_KNOWLEDGE_DOCUMENTS = 100
export const MAX_KNOWLEDGE_EVIDENCE = 3
export const knowledgeDocumentIdSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const knowledgeRequestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/)
export const knowledgeChunkIdSchema = z.string().regex(/^[a-f0-9]{64}:p[1-9]\d{0,3}:c[1-9]\d{0,3}$/)
const physicalPage = z.number().int().min(1).max(MAX_KNOWLEDGE_PAGES)
export const knowledgeScopeSchema = z
  .strictObject({
    id: knowledgeRequestIdSchema,
    label: z.string().trim().min(1).max(120),
    startPage: physicalPage,
    endPage: physicalPage,
  })
  .refine((value) => value.startPage <= value.endPage, '起始页不能晚于结束页')
export const knowledgeDocumentSchema = z
  .strictObject({
    id: knowledgeDocumentIdSchema,
    title: documentTitle,
    // Older libraries contained politics only. Never infer a new subject from filenames.
    subject: knowledgeSubjectSchema.default('politics'),
    edition: documentEdition.default(''),
    editionConfirmed: z.boolean().default(false),
    byteLength: z.number().int().min(1).max(MAX_KNOWLEDGE_PDF_BYTES),
    pageCount: physicalPage,
    textPageCount: z.number().int().min(0).max(MAX_KNOWLEDGE_PAGES),
    importedAt: z.iso.datetime(),
    scopes: z.array(knowledgeScopeSchema).max(100),
  })
  .superRefine((value, ctx) => {
    if (value.editionConfirmed && !value.edition)
      ctx.addIssue({ code: 'custom', message: '请先填写版本，再确认版本信息' })
    if (
      value.textPageCount > value.pageCount ||
      value.scopes.some((scope) => scope.endPage > value.pageCount)
    )
      ctx.addIssue({ code: 'custom', message: '页码超出文档范围' })
    if (new Set(value.scopes.map((scope) => scope.id)).size !== value.scopes.length)
      ctx.addIssue({ code: 'custom', message: '章节标识符重复' })
  })
export const knowledgeSearchInputSchema = z
  .strictObject({
    documentId: knowledgeDocumentIdSchema,
    subject: knowledgeSubjectSchema.optional(),
    query: z.string().trim().min(1).max(300),
    scopeId: knowledgeRequestIdSchema.optional(),
    startPage: physicalPage.optional(),
    endPage: physicalPage.optional(),
    limit: z.number().int().min(1).max(30).optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.startPage === undefined) !== (value.endPage === undefined))
      ctx.addIssue({ code: 'custom', message: '请同时提供起始页和结束页' })
    if (value.scopeId && value.startPage !== undefined)
      ctx.addIssue({ code: 'custom', message: '章节与临时页码范围不能同时指定' })
    if (
      value.startPage !== undefined &&
      value.endPage !== undefined &&
      value.startPage > value.endPage
    )
      ctx.addIssue({ code: 'custom', message: '起始页不能晚于结束页' })
  })
export const knowledgeSaveScopesInputSchema = z
  .strictObject({
    documentId: knowledgeDocumentIdSchema,
    scopes: z.array(knowledgeScopeSchema).max(100),
  })
  .refine(
    (value) => new Set(value.scopes.map((scope) => scope.id)).size === value.scopes.length,
    '章节标识符重复',
  )
export const knowledgeUpdateMetadataInputSchema = z
  .strictObject({
    documentId: knowledgeDocumentIdSchema,
    title: documentTitle.optional(),
    subject: knowledgeSubjectSchema.optional(),
    edition: documentEdition.optional(),
    editionConfirmed: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.title !== undefined ||
      value.subject !== undefined ||
      value.edition !== undefined ||
      value.editionConfirmed !== undefined,
    '请提供要更新的教材信息',
  )
export const knowledgeEvidenceSchema = z.strictObject({
  chunkId: knowledgeChunkIdSchema,
  documentId: knowledgeDocumentIdSchema,
  documentTitle: z.string().trim().min(1).max(200),
  // Legacy canonical evidence may omit this field; it can only belong to politics.
  subject: knowledgeSubjectSchema.default('politics'),
  pageNumber: physicalPage,
  // Untrusted source data: never interpret this field as model/system instructions.
  text: z.string().min(1).max(MAX_KNOWLEDGE_CHUNK_TEXT),
})
export const chosenKnowledgeChunkIdsSchema = z
  .array(knowledgeChunkIdSchema)
  .max(MAX_KNOWLEDGE_EVIDENCE)
  .refine((ids) => new Set(ids).size === ids.length, '引用片段重复')
export const knowledgeHitSchema = knowledgeEvidenceSchema.extend({
  score: z.number().finite().nonnegative(),
})
export type KnowledgeScope = z.infer<typeof knowledgeScopeSchema>
export type KnowledgeDocument = z.infer<typeof knowledgeDocumentSchema>
export type KnowledgeImportOptions = z.infer<typeof knowledgeImportOptionsSchema>
export type KnowledgeSearchInput = z.infer<typeof knowledgeSearchInputSchema>
export type KnowledgeSaveScopesInput = z.infer<typeof knowledgeSaveScopesInputSchema>
export type KnowledgeUpdateMetadataInput = z.infer<typeof knowledgeUpdateMetadataInputSchema>
export type KnowledgeEvidence = z.infer<typeof knowledgeEvidenceSchema>
export type KnowledgeHit = z.infer<typeof knowledgeHitSchema>
export type KnowledgeImportResult =
  | { canceled: true; document?: never; duplicate?: never }
  | { canceled: false; document: KnowledgeDocument; duplicate: boolean }
export interface KnowledgeApi {
  listKnowledgeDocuments(): Promise<KnowledgeDocument[]>
  importKnowledgePdf(
    requestId: string,
    options?: KnowledgeImportOptions,
  ): Promise<KnowledgeImportResult>
  importKnowledgePack(requestId: string): Promise<KnowledgePackImportResult>
  cancelKnowledgeImport(requestId: string): Promise<void>
  getKnowledgePdf(documentId: string): Promise<Uint8Array>
  searchKnowledge(input: KnowledgeSearchInput): Promise<KnowledgeHit[]>
  saveKnowledgeScopes(input: KnowledgeSaveScopesInput): Promise<KnowledgeDocument>
  updateKnowledgeDocumentMetadata(input: KnowledgeUpdateMetadataInput): Promise<KnowledgeDocument>
}
