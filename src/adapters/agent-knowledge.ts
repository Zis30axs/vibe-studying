import { z } from 'zod'
import { createHash } from 'node:crypto'
import {
  knowledgeDocumentIdSchema,
  knowledgeEvidenceSchema,
  knowledgeSubjectSchema,
  type KnowledgeEvidence,
} from '../shared/knowledge'
import { reviewKnowledgeNodeIdSchema } from '../shared/review-knowledge'
import type { ReviewKnowledgeIndex } from './review-knowledge-index'
const scopeSchema = z
  .strictObject({
    nodeId: reviewKnowledgeNodeIdSchema,
    documentId: knowledgeDocumentIdSchema,
    subject: knowledgeSubjectSchema,
    startPage: z.number().int().min(1).max(1500),
    endPage: z.number().int().min(1).max(1500),
  })
  .refine((v) => v.startPage <= v.endPage && v.endPage - v.startPage < 100)
export type AgentKnowledgeIndexScope = z.infer<typeof scopeSchema>
/** An old index is a pointer, never a new grant. Return no review text or index labels. */
export async function resolveAgentKnowledgeIndex(
  index: Pick<ReviewKnowledgeIndex, 'get' | 'resolveEvidence'>,
  raw: unknown,
): Promise<KnowledgeEvidence[]> {
  const input = scopeSchema.parse(raw)
  const reject = () => new Error('知识点未关联、来源已过期或不在本次授权教材范围。')
  const node = await index.get(input.nodeId)
  if (
    !node ||
    node.status !== 'linked' ||
    node.subject !== input.subject ||
    !node.references.length ||
    node.references.some(
      (ref) =>
        ref.documentId !== input.documentId ||
        ref.subject !== input.subject ||
        ref.pageNumber < input.startPage ||
        ref.pageNumber > input.endPage,
    )
  )
    throw reject()
  const evidence = z
    .array(knowledgeEvidenceSchema)
    .min(1)
    .max(3)
    .parse(await index.resolveEvidence(input.nodeId))
  if (
    evidence.length !== node.references.length ||
    evidence.some((item, i) => {
      const ref = node.references[i]
      return (
        item.chunkId !== ref.chunkId ||
        item.documentId !== input.documentId ||
        item.subject !== input.subject ||
        item.pageNumber !== ref.pageNumber ||
        item.pageNumber < input.startPage ||
        item.pageNumber > input.endPage ||
        createHash('sha256').update(item.text).digest('hex') !== ref.textSha256
      )
    })
  )
    throw reject()
  return structuredClone(evidence)
}
