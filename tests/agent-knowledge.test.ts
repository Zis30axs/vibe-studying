import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { resolveAgentKnowledgeIndex } from '../src/adapters/agent-knowledge'
import type { ReviewKnowledgeNode } from '../src/shared/review-knowledge'
import type { KnowledgeEvidence } from '../src/shared/knowledge'
const documentId = 'a'.repeat(64)
const id = `rkn-${'b'.repeat(64)}`
const evidence: KnowledgeEvidence = {
  chunkId: `${documentId}:p4:c1`,
  documentId,
  documentTitle: 'Synthetic PDF',
  subject: 'math',
  pageNumber: 4,
  text: 'A synthetic public teaching excerpt.',
}
const node: ReviewKnowledgeNode = {
  id,
  attemptId: 'attempt-1',
  questionId: 'question-1',
  subject: 'math',
  reviewId: 'c'.repeat(64),
  source: { kind: 'feedback' },
  label: 'PRIVATE_REVIEW_LABEL',
  reviewExcerpt: 'PRIVATE_REVIEW_TEXT',
  excerptTruncated: false,
  references: [
    {
      documentId,
      documentSha256: documentId,
      documentTitle: evidence.documentTitle,
      subject: 'math',
      pageNumber: 4,
      chunkId: evidence.chunkId,
      textSha256: createHash('sha256').update(evidence.text).digest('hex'),
    },
  ],
  revision: 1,
  createdAt: '2026-10-11T00:00:00.000Z',
  updatedAt: '2026-10-11T00:00:00.000Z',
  status: 'linked',
}
const scope = { nodeId: id, documentId, subject: 'math' as const, startPage: 4, endPage: 4 }
function fixture() {
  return {
    get: vi.fn(async () => structuredClone(node)),
    resolveEvidence: vi.fn(async () => [structuredClone(evidence)]),
  }
}
describe('Agent persistent-index retrieval boundary', () => {
  it('returns verified canonical excerpts, not review labels/history or persisted metadata as text', async () => {
    const index = fixture()
    const result = await resolveAgentKnowledgeIndex(index, scope)
    expect(result).toEqual([evidence])
    expect(JSON.stringify(result)).not.toContain('PRIVATE_REVIEW')
  })
  it.each(['pending', 'stale'] as const)(
    'rejects %s index before retrieving text',
    async (status) => {
      const index = fixture()
      index.get.mockResolvedValue({ ...node, status })
      await expect(resolveAgentKnowledgeIndex(index, scope)).rejects.toThrow('未关联')
      expect(index.resolveEvidence).not.toHaveBeenCalled()
    },
  )
  it.each([{ subject: 'history' }, { documentId: 'd'.repeat(64) }, { startPage: 5, endPage: 6 }])(
    'does not expand current grant using a persisted pointer %j',
    async (changed) => {
      const index = fixture()
      await expect(resolveAgentKnowledgeIndex(index, { ...scope, ...changed })).rejects.toThrow(
        '范围',
      )
      expect(index.resolveEvidence).not.toHaveBeenCalled()
    },
  )
  it.each([
    { text: 'Changed source bytes' },
    { chunkId: `${documentId}:p4:c2` },
    { pageNumber: 5 },
    { subject: 'history' as const },
  ])(
    'rejects changed or switched evidence between index lookup and resolution %j',
    async (changed) => {
      const index = fixture()
      index.resolveEvidence.mockResolvedValue([{ ...evidence, ...changed }])
      await expect(resolveAgentKnowledgeIndex(index, scope)).rejects.toThrow('过期')
    },
  )
  it('rejects malformed identity and a range over 100 pages without a lookup', async () => {
    const index = fixture()
    await expect(
      resolveAgentKnowledgeIndex(index, { ...scope, nodeId: '../credentials' }),
    ).rejects.toThrow()
    await expect(
      resolveAgentKnowledgeIndex(index, { ...scope, startPage: 1, endPage: 101 }),
    ).rejects.toThrow()
    expect(index.get).not.toHaveBeenCalled()
  })
})
