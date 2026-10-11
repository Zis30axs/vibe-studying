import { z } from 'zod'
import {
  chosenKnowledgeChunkIdsSchema,
  knowledgeChunkIdSchema,
  knowledgeDocumentIdSchema,
  knowledgeSubjectSchema,
  MAX_KNOWLEDGE_PAGES,
} from './knowledge'

/** The index stores references, never copies of a book or remote-retrieval permission. */
export const MAX_REVIEW_KNOWLEDGE_NODES = 1000
export const MAX_REVIEW_KNOWLEDGE_REMOVED_NODES = 10000
export const MAX_REVIEW_KNOWLEDGE_REFRESH_ATTEMPTS = 50
export const MAX_REVIEW_KNOWLEDGE_EXCERPT = 600
const canonicalId = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
  .refine(
    (value) => !['__proto__', 'prototype', 'constructor'].includes(value),
    '保留标识符不可使用',
  )
export const reviewKnowledgeNodeIdSchema = z.string().regex(/^rkn-[a-f0-9]{64}$/)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
export const reviewKnowledgeReferenceSchema = z
  .strictObject({
    documentId: knowledgeDocumentIdSchema,
    documentSha256: digest,
    documentTitle: z.string().trim().min(1).max(200),
    subject: knowledgeSubjectSchema,
    pageNumber: z.number().int().min(1).max(MAX_KNOWLEDGE_PAGES),
    chunkId: knowledgeChunkIdSchema,
    textSha256: digest,
  })
  .refine(
    (value) =>
      value.documentId === value.documentSha256 &&
      value.chunkId.startsWith(`${value.documentId}:p${value.pageNumber}:`),
    '引用身份不一致',
  )
export const reviewKnowledgeSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('feedback') }),
  z.strictObject({
    kind: z.literal('rubric'),
    rubricId: canonicalId,
    rubricIndex: z.number().int().min(0).max(19),
  }),
])
export const reviewKnowledgeRecordSchema = z
  .strictObject({
    id: reviewKnowledgeNodeIdSchema,
    attemptId: canonicalId,
    questionId: canonicalId,
    /** Old submissions without their question snapshot stay unknown, never guessed from a new question. */
    subject: knowledgeSubjectSchema.nullable(),
    reviewId: digest,
    source: reviewKnowledgeSourceSchema,
    label: z.string().trim().min(1).max(160),
    reviewExcerpt: z.string().max(MAX_REVIEW_KNOWLEDGE_EXCERPT),
    excerptTruncated: z.boolean(),
    references: z.array(reviewKnowledgeReferenceSchema).max(3),
    revision,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .refine(
    (value) =>
      new Set(value.references.map((reference) => reference.chunkId)).size ===
      value.references.length,
    '引用片段重复',
  )
  .refine(
    (value) => value.references.every((reference) => reference.subject === value.subject),
    '索引与引用学科不一致',
  )
export const reviewKnowledgeStateSchema = z
  .strictObject({
    version: z.literal(1),
    nodes: z.array(reviewKnowledgeRecordSchema).max(MAX_REVIEW_KNOWLEDGE_NODES),
    removedNodeIds: z.array(reviewKnowledgeNodeIdSchema).max(MAX_REVIEW_KNOWLEDGE_REMOVED_NODES),
  })
  .refine(
    (value) => new Set(value.nodes.map((node) => node.id)).size === value.nodes.length,
    '索引标识符重复',
  )
  .refine(
    (value) =>
      new Set(value.removedNodeIds).size === value.removedNodeIds.length &&
      value.nodes.every((node) => !value.removedNodeIds.includes(node.id)),
    '移除记录与索引不一致',
  )
export const reviewKnowledgeRefreshInputSchema = z
  .strictObject({
    attemptIds: z.array(canonicalId).min(1).max(MAX_REVIEW_KNOWLEDGE_REFRESH_ATTEMPTS),
  })
  .refine((value) => new Set(value.attemptIds).size === value.attemptIds.length, '提交标识符重复')
export const reviewKnowledgeListInputSchema = z.strictObject({
  attemptId: canonicalId.optional(),
  questionId: canonicalId.optional(),
  subject: knowledgeSubjectSchema.optional(),
})
export const reviewKnowledgeMutationInputSchema = z.strictObject({
  nodeId: reviewKnowledgeNodeIdSchema,
  expectedRevision: revision,
})
export const reviewKnowledgeLabelInputSchema = reviewKnowledgeMutationInputSchema.extend({
  label: z.string().trim().min(1).max(160),
})
export const reviewKnowledgeAssociateInputSchema = reviewKnowledgeMutationInputSchema.extend({
  chunkIds: chosenKnowledgeChunkIdsSchema.refine((ids) => ids.length > 0, '请先选择片段'),
})
export type ReviewKnowledgeReference = z.infer<typeof reviewKnowledgeReferenceSchema>
export type ReviewKnowledgeRecord = z.infer<typeof reviewKnowledgeRecordSchema>
export type ReviewKnowledgeState = z.infer<typeof reviewKnowledgeStateSchema>
export type ReviewKnowledgeRefreshInput = z.infer<typeof reviewKnowledgeRefreshInputSchema>
export type ReviewKnowledgeListInput = z.infer<typeof reviewKnowledgeListInputSchema>
export type ReviewKnowledgeMutationInput = z.infer<typeof reviewKnowledgeMutationInputSchema>
export type ReviewKnowledgeLabelInput = z.infer<typeof reviewKnowledgeLabelInputSchema>
export type ReviewKnowledgeAssociateInput = z.infer<typeof reviewKnowledgeAssociateInputSchema>
export type ReviewKnowledgeStaleReason =
  | 'review-missing'
  | 'review-changed'
  | 'source-unavailable'
  | 'evidence-missing'
  | 'evidence-changed'
  | 'subject-changed'
export type ReviewKnowledgeNode = ReviewKnowledgeRecord & {
  status: 'pending' | 'linked' | 'stale'
  staleReason?: ReviewKnowledgeStaleReason
}
export interface ReviewKnowledgeApi {
  refreshReviewKnowledge(input: ReviewKnowledgeRefreshInput): Promise<ReviewKnowledgeNode[]>
  listReviewKnowledge(input?: ReviewKnowledgeListInput): Promise<ReviewKnowledgeNode[]>
  updateReviewKnowledgeLabel(input: ReviewKnowledgeLabelInput): Promise<ReviewKnowledgeNode>
  associateReviewKnowledge(input: ReviewKnowledgeAssociateInput): Promise<ReviewKnowledgeNode>
  removeReviewKnowledgeAssociation(
    input: ReviewKnowledgeMutationInput,
  ): Promise<ReviewKnowledgeNode>
  removeReviewKnowledgeNode(input: ReviewKnowledgeMutationInput): Promise<void>
}
