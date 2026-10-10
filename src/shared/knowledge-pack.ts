import { z } from 'zod'
import {
  knowledgeDocumentIdSchema,
  MAX_KNOWLEDGE_PDF_BYTES,
  type KnowledgeDocument,
} from './knowledge'
import { subjects } from './subjects'
import type { Subject } from './types'

export const KNOWLEDGE_PACK_MANIFEST_NAME = 'pack.json'
export const MAX_KNOWLEDGE_PACK_MANIFEST_BYTES = 32 * 1024
export const MAX_KNOWLEDGE_PACK_DOCUMENTS = 12
export const MAX_KNOWLEDGE_PACK_BYTES = 300 * 1024 * 1024
export const MAX_KNOWLEDGE_PACK_PART_BYTES = 18 * 1024 * 1024

/** A single portable filename, never a path, URL, device, or Windows alternate stream. */
const portableFilenameSchema = z
  .string()
  .min(1)
  .max(180)
  .refine(
    (file) =>
      file === file.trim() &&
      !file.startsWith('.') &&
      !/[\u0000-\u001f\u007f<>:"/\\|?*]/u.test(file) &&
      !/^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\.|$)/i.test(file),
    'PDF 文件名必须是普通文件名，不能包含路径、链接或保留设备名称',
  )
export const knowledgePackFilenameSchema = portableFilenameSchema.refine(
  (file) => /\.pdf$/i.test(file),
  '知识包文档文件名必须以 .pdf 结尾',
)
export const knowledgePackPartSchema = z.strictObject({
  file: portableFilenameSchema.refine((file) => /\.pdf\.part\d{2}$/i.test(file)),
  sha256: knowledgeDocumentIdSchema,
  byteLength: z.number().int().min(1).max(MAX_KNOWLEDGE_PACK_PART_BYTES),
})

export const knowledgePackDocumentSchema = z
  .strictObject({
    file: knowledgePackFilenameSchema,
    sha256: knowledgeDocumentIdSchema,
    subject: z.enum(subjects),
    title: z.string().trim().min(1).max(200),
    edition: z.string().trim().max(200).default(''),
    // A pack's version label is an assumption until someone checks the original.
    editionConfirmed: z.boolean().default(false),
    // Optional byte slices of one PDF, not separate PDFs or page ranges.
    parts: z.array(knowledgePackPartSchema).min(2).max(4).optional(),
  })
  .refine((entry) => !entry.editionConfirmed || entry.edition.length > 0, {
    message: '确认版本前必须填写版本信息',
    path: ['editionConfirmed'],
  })
  .superRefine((entry, context) => {
    if (!entry.parts) return
    if (entry.parts.reduce((total, part) => total + part.byteLength, 0) > MAX_KNOWLEDGE_PDF_BYTES)
      context.addIssue({ code: 'custom', message: 'PDF 分片合计不能超过 50 MiB' })
    if (
      entry.parts.some(
        (part, index) => part.file !== `${entry.file}.part${String(index + 1).padStart(2, '0')}`,
      )
    )
      context.addIssue({ code: 'custom', message: 'PDF 分片必须按 .part01、.part02 的顺序排列' })
  })

export const knowledgePackManifestSchema = z
  .strictObject({
    version: z.literal(1),
    title: z.string().trim().min(1).max(200),
    documents: z.array(knowledgePackDocumentSchema).min(1).max(MAX_KNOWLEDGE_PACK_DOCUMENTS),
  })
  .superRefine((manifest, context) => {
    // Case/normalization collisions must not silently select different files on Windows/macOS.
    const filenames = manifest.documents.flatMap((entry) =>
      [entry.file, ...(entry.parts?.map((part) => part.file) ?? [])].map((file) =>
        file.normalize('NFKC').toLowerCase(),
      ),
    )
    if (new Set(filenames).size !== filenames.length)
      context.addIssue({ code: 'custom', message: '知识包中的 PDF 文件名重复' })
    if (new Set(manifest.documents.map((entry) => entry.sha256)).size !== manifest.documents.length)
      context.addIssue({ code: 'custom', message: '知识包中的 PDF 内容重复' })
  })

export type KnowledgePackManifest = z.infer<typeof knowledgePackManifestSchema>
export type KnowledgePackDocument = z.infer<typeof knowledgePackDocumentSchema>
export type KnowledgePackItemStatus = 'imported' | 'duplicate' | 'failed' | 'pending'
export interface KnowledgePackImportItem {
  file: string
  title: string
  subject: Subject
  status: KnowledgePackItemStatus
  documentId?: string
  error?: string
}
export interface KnowledgePackImportResult {
  canceled: boolean
  validationPassed: boolean
  packTitle?: string
  documents: KnowledgeDocument[]
  importedCount: number
  duplicateCount: number
  failedCount: number
  items: KnowledgePackImportItem[]
  warning?: string
}

export function canceledKnowledgePackImport(): KnowledgePackImportResult {
  return {
    canceled: true,
    validationPassed: false,
    documents: [],
    importedCount: 0,
    duplicateCount: 0,
    failedCount: 0,
    items: [],
  }
}
