import { build } from 'esbuild'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ReviewKnowledgeIndex,
  ReviewKnowledgeError,
  type ReviewKnowledgeSources,
} from '../src/adapters/review-knowledge-index'
import { sampleQuestions } from '../src/domain/sample-bank'
import { studentQuestionProjection } from '../src/domain/student-question'
import { LocalKnowledgeLibrary } from '../src/adapters/knowledge-library'
import { createKnowledgePdf } from './fixtures/knowledge-pdf'
import { emptyDraft, type Attempt } from '../src/shared/types'
import type { KnowledgeEvidence } from '../src/shared/knowledge'
import {
  MAX_REVIEW_KNOWLEDGE_NODES,
  reviewKnowledgeStateSchema,
} from '../src/shared/review-knowledge'

const homes: string[] = []
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
function attempt(id = 'submission-1'): Attempt {
  const question = sampleQuestions.find((question) => question.id === 'pol-assembly-1')!
  return {
    id,
    questionId: question.id,
    questionSnapshot: studentQuestionProjection(question),
    submittedAt: '2026-10-11T00:00:00.000Z',
    draft: emptyDraft(),
    score: 4,
    maxScore: question.maxScore,
    feedback: '区分原理与材料。',
    explanation: '自编说明。',
    reviewer: '合成评阅器',
    rubric: [
      {
        id: 'practice',
        label: '实践与认识',
        earned: 2,
        possible: 4,
        feedback: '需要解释实践如何检验认识。',
      },
      {
        id: 'material',
        label: '联系材料',
        earned: 2,
        possible: 4,
        feedback: '说明调查与试点的作用。',
      },
    ],
  }
}
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'examcraft-review-knowledge-'))
  homes.push(home)
  const attempts = new Map([['submission-1', attempt()]])
  const documentId = sha('%PDF-synthetic-document-for-local-test')
  const evidence: KnowledgeEvidence = {
    documentId,
    documentTitle: '自编合成 PDF',
    subject: 'politics',
    chunkId: `${documentId}:p2:c1`,
    pageNumber: 2,
    text: '实践是检验认识的标准。这是合成测试片段。',
  }
  const chunks = new Map([[evidence.chunkId, evidence]])
  const sources: ReviewKnowledgeSources = {
    resolveAttempt: vi.fn(async (id: string) => {
      const value = attempts.get(id)
      return value && structuredClone(value)
    }),
    verifyDocument: vi.fn(async (id: string) => {
      if (id !== documentId) throw Object.assign(new Error('missing'), { code: 'PDF_NOT_FOUND' })
    }),
    resolveChunks: vi.fn(async (ids: string[]) =>
      ids.map((id) => {
        const chunk = chunks.get(id)
        if (!chunk) throw new Error('Missing canonical chunk')
        return structuredClone(chunk)
      }),
    ),
  }
  const service = new ReviewKnowledgeIndex(home, sources)
  const nodes = await service.refresh({ attemptIds: ['submission-1'] })
  return {
    home,
    path: join(home, 'review-knowledge-index.json'),
    attempts,
    documentId,
    evidence,
    chunks,
    sources,
    service,
    nodes,
  }
}

describe('persistent review-to-knowledge index', () => {
  it('materializes canonical feedback only, is idempotent across restart, and does not retrieve PDFs for pending nodes', async () => {
    const f = await fixture()
    expect(f.nodes).toHaveLength(2)
    expect(f.nodes[0]).toMatchObject({
      attemptId: 'submission-1',
      questionId: 'pol-assembly-1',
      subject: 'politics',
      label: '实践与认识',
      reviewExcerpt: '需要解释实践如何检验认识。',
      status: 'pending',
      references: [],
      revision: 1,
    })
    expect(f.nodes[0].reviewId).toMatch(/^[a-f0-9]{64}$/)
    const restarted = new ReviewKnowledgeIndex(f.home, f.sources)
    expect(await restarted.refresh({ attemptIds: ['submission-1'] })).toEqual(f.nodes)
    expect(f.sources.verifyDocument).not.toHaveBeenCalled()
    expect(f.sources.resolveChunks).not.toHaveBeenCalled()
    expect(() => restarted.refresh({ attemptIds: ['submission-1'], feedback: 'forged' })).toThrow()
    await expect(restarted.refresh({ attemptIds: ['missing'] })).rejects.toThrow('找不到')
  })

  it('saves bounded canonical references, hashes exact chunk text, and resolves current evidence', async () => {
    const f = await fixture()
    const linked = await f.service.associate({
      nodeId: f.nodes[0].id,
      expectedRevision: 1,
      chunkIds: [f.evidence.chunkId],
    })
    expect(linked.status).toBe('linked')
    expect(linked.references).toEqual([
      {
        documentId: f.documentId,
        documentSha256: f.documentId,
        documentTitle: f.evidence.documentTitle,
        subject: 'politics',
        pageNumber: 2,
        chunkId: f.evidence.chunkId,
        textSha256: sha(f.evidence.text),
      },
    ])
    expect(linked.revision).toBe(2)
    expect(await f.service.resolveEvidence(linked.id)).toEqual([f.evidence])
    const disk = await readFile(f.path, 'utf8')
    expect(disk).not.toContain(f.evidence.text)
    expect(disk).not.toContain('draft')
    expect(() =>
      f.service.associate({
        nodeId: linked.id,
        expectedRevision: 2,
        chunkIds: [f.evidence.chunkId],
        documentTitle: '伪造标题',
        pageNumber: 99,
      }),
    ).toThrow()
    expect(() =>
      f.service.associate({
        nodeId: linked.id,
        expectedRevision: 2,
        chunkIds: [f.evidence.chunkId, f.evidence.chunkId],
      }),
    ).toThrow()
    expect((await new ReviewKnowledgeIndex(f.home, f.sources).get(linked.id))?.status).toBe(
      'linked',
    )
  })

  it('keeps label edits, unlinks without touching PDFs, and persists deletion tombstones across refresh', async () => {
    const f = await fixture()
    const linked = await f.service.associate({
      nodeId: f.nodes[0].id,
      expectedRevision: 1,
      chunkIds: [f.evidence.chunkId],
    })
    const edited = await f.service.updateLabel({
      nodeId: linked.id,
      expectedRevision: linked.revision,
      label: ' 我的复习标签 ',
    })
    expect(edited.label).toBe('我的复习标签')
    expect((await f.service.refresh({ attemptIds: ['submission-1'] }))[0]).toEqual(edited)
    const unlinked = await f.service.removeAssociation({
      nodeId: edited.id,
      expectedRevision: edited.revision,
    })
    expect(unlinked).toMatchObject({ status: 'pending', references: [], label: '我的复习标签' })
    expect(await f.service.resolveEvidence(unlinked.id)).toEqual([])
    await f.service.removeNode({ nodeId: unlinked.id, expectedRevision: unlinked.revision })
    expect(await f.service.get(unlinked.id)).toBeUndefined()
    const restarted = new ReviewKnowledgeIndex(f.home, f.sources)
    expect(
      (await restarted.refresh({ attemptIds: ['submission-1'] })).map((node) => node.id),
    ).toEqual([f.nodes[1].id])
    expect(f.chunks.get(f.evidence.chunkId)).toEqual(f.evidence)
    expect(JSON.parse(await readFile(f.path, 'utf8')).removedNodeIds).toEqual([unlinked.id])
  })

  it('rejects cross-subject evidence and leaves legacy submissions with unknown subject pending', async () => {
    const f = await fixture()
    f.chunks.set(f.evidence.chunkId, { ...f.evidence, subject: 'history' })
    await expect(
      f.service.associate({
        nodeId: f.nodes[0].id,
        expectedRevision: 1,
        chunkIds: [f.evidence.chunkId],
      }),
    ).rejects.toThrow('学科不一致')
    const old = attempt('legacy')
    delete old.questionSnapshot
    f.attempts.set(old.id, old)
    const [node] = await f.service.refresh({ attemptIds: [old.id] })
    expect(node).toMatchObject({ subject: null, status: 'pending' })
    await expect(
      f.service.associate({ nodeId: node.id, expectedRevision: 1, chunkIds: [f.evidence.chunkId] }),
    ).rejects.toThrow('旧提交')
    expect(
      (await f.service.list({ subject: 'politics' })).every((node) => node.subject === 'politics'),
    ).toBe(true)
  })

  it('marks changed/missing chunks stale without rebinding and allows explicit reselection', async () => {
    const f = await fixture()
    const linked = await f.service.associate({
      nodeId: f.nodes[0].id,
      expectedRevision: 1,
      chunkIds: [f.evidence.chunkId],
    })
    f.chunks.set(f.evidence.chunkId, { ...f.evidence, text: '同一位置现在是另一段提取内容。' })
    expect(await f.service.get(linked.id)).toMatchObject({
      status: 'stale',
      staleReason: 'evidence-changed',
    })
    expect(await f.service.resolveEvidence(linked.id)).toEqual([])
    expect(
      (await f.service.refresh({ attemptIds: ['submission-1'] }))[0].references[0].textSha256,
    ).toBe(sha(f.evidence.text))
    const reselected = await f.service.associate({
      nodeId: linked.id,
      expectedRevision: linked.revision,
      chunkIds: [f.evidence.chunkId],
    })
    expect(reselected.status).toBe('linked')
    f.chunks.delete(f.evidence.chunkId)
    expect((await f.service.list())[0].status).toBe('stale')
    expect(await f.service.resolveEvidence(linked.id)).toEqual([])
  })

  it('revalidates physical source bytes each operation, caches repeated documents/chunks per list, and updates canonical titles', async () => {
    const f = await fixture()
    for (const node of f.nodes)
      await f.service.associate({
        nodeId: node.id,
        expectedRevision: 1,
        chunkIds: [f.evidence.chunkId],
      })
    vi.mocked(f.sources.verifyDocument).mockClear()
    vi.mocked(f.sources.resolveChunks).mockClear()
    f.chunks.set(f.evidence.chunkId, { ...f.evidence, documentTitle: '已经核对的新标题' })
    const listed = await f.service.list()
    expect(
      listed.every(
        (node) =>
          node.status === 'linked' && node.references[0].documentTitle === '已经核对的新标题',
      ),
    ).toBe(true)
    expect(f.sources.verifyDocument).toHaveBeenCalledTimes(1)
    expect(f.sources.resolveChunks).toHaveBeenCalledTimes(1)
    await f.service.list()
    expect(f.sources.verifyDocument).toHaveBeenCalledTimes(2)
    vi.mocked(f.sources.verifyDocument).mockRejectedValue(
      Object.assign(new Error('corrupt'), { code: 'PDF_STORAGE_INVALID' }),
    )
    expect((await f.service.list()).every((node) => node.status === 'stale')).toBe(true)
    expect(await f.service.resolveEvidence(f.nodes[0].id)).toEqual([])
  })

  it('marks changed PDF subjects and missing sources stale rather than reading a different book', async () => {
    const f = await fixture()
    const linked = await f.service.associate({
      nodeId: f.nodes[0].id,
      expectedRevision: 1,
      chunkIds: [f.evidence.chunkId],
    })
    f.chunks.set(f.evidence.chunkId, { ...f.evidence, subject: 'math' })
    expect(await f.service.get(linked.id)).toMatchObject({
      status: 'stale',
      staleReason: 'subject-changed',
    })
    vi.mocked(f.sources.verifyDocument).mockRejectedValue(
      Object.assign(new Error('missing'), { code: 'PDF_NOT_FOUND' }),
    )
    expect(await f.service.get(linked.id)).toMatchObject({
      status: 'stale',
      staleReason: 'evidence-missing',
    })
    await expect(
      f.service.associate({
        nodeId: linked.id,
        expectedRevision: 2,
        chunkIds: [f.evidence.chunkId],
      }),
    ).rejects.toThrow('校验失败')
  })

  it('retains changed review history as stale, creates new identities, and refuses linking a replaced review', async () => {
    const f = await fixture()
    f.attempts.get('submission-1')!.rubric[0].feedback = '更正后的评阅内容。'
    expect(await f.service.get(f.nodes[0].id)).toMatchObject({
      status: 'stale',
      staleReason: 'review-changed',
    })
    await expect(
      f.service.associate({
        nodeId: f.nodes[0].id,
        expectedRevision: 1,
        chunkIds: [f.evidence.chunkId],
      }),
    ).rejects.toThrow('评阅记录')
    const refreshed = await f.service.refresh({ attemptIds: ['submission-1'] })
    expect(refreshed).toHaveLength(4)
    expect(refreshed.filter((node) => node.status === 'stale')).toHaveLength(2)
    f.attempts.delete('submission-1')
    expect((await f.service.list()).every((node) => node.staleReason === 'review-missing')).toBe(
      true,
    )
  })

  it('uses CAS for competing edits and does not allow a late link to resurrect a removed node', async () => {
    const f = await fixture()
    const edit = f.service.updateLabel({
      nodeId: f.nodes[0].id,
      expectedRevision: 1,
      label: '先保存的编辑',
    })
    const stale = f.service.removeAssociation({ nodeId: f.nodes[0].id, expectedRevision: 1 })
    expect((await edit).revision).toBe(2)
    await expect(stale).rejects.toThrow('已更新')
    const remove = f.service.removeNode({ nodeId: f.nodes[0].id, expectedRevision: 2 })
    const link = f.service.associate({
      nodeId: f.nodes[0].id,
      expectedRevision: 2,
      chunkIds: [f.evidence.chunkId],
    })
    await remove
    await expect(link).rejects.toThrow('已移除')
    expect(
      (await f.service.refresh({ attemptIds: ['submission-1'] })).some(
        (node) => node.id === f.nodes[0].id,
      ),
    ).toBe(false)
  })

  it('exposes only fixed actionable public errors and never propagates source paths or secrets', async () => {
    const f = await fixture()
    vi.mocked(f.sources.resolveAttempt).mockRejectedValue(
      new Error('/private/profile/study-state.json secret-token'),
    )
    try {
      await f.service.refresh({ attemptIds: ['submission-1'] })
      throw new Error('Expected source failure')
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewKnowledgeError)
      expect((error as ReviewKnowledgeError).code).toBe('OPERATION_FAILED')
      expect((error as Error).message).not.toContain('/private/')
      expect((error as Error).message).not.toContain('secret-token')
    }
    await expect(
      f.service.updateLabel({ nodeId: f.nodes[0].id, expectedRevision: 999, label: '我的标签' }),
    ).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
      message: expect.stringContaining('保留标签草稿'),
    })
    await writeFile(f.path, '{broken')
    await expect(f.service.list()).rejects.toMatchObject({
      code: 'CORRUPT',
      message: expect.stringContaining('保留备份'),
    })
  })

  it('fails closed on corrupt state without overwriting it, including inconsistent tombstones', async () => {
    const f = await fixture()
    await writeFile(f.path, '{broken')
    await expect(f.service.refresh({ attemptIds: ['submission-1'] })).rejects.toThrow(
      '原文件未覆盖',
    )
    expect(await readFile(f.path, 'utf8')).toBe('{broken')
    await expect(f.service.list()).rejects.toThrow('原文件未覆盖')
    expect(
      reviewKnowledgeStateSchema.safeParse({
        version: 1,
        nodes: [],
        removedNodeIds: [f.nodes[0].id, f.nodes[0].id],
      }).success,
    ).toBe(false)
  })

  it('does not silently prune older nodes when its explicit storage cap is reached', async () => {
    const f = await fixture()
    // Preserve strict, unique identities; source revalidation is not needed to exercise the write cap.
    const base = JSON.parse(await readFile(f.path, 'utf8'))
    base.nodes = Array.from({ length: MAX_REVIEW_KNOWLEDGE_NODES }, (_, i) => ({
      ...base.nodes[0],
      id: `rkn-${sha(`node-${i}`)}`,
    }))
    await writeFile(f.path, JSON.stringify(base))
    const before = await readFile(f.path, 'utf8')
    await expect(f.service.refresh({ attemptIds: ['submission-1'] })).rejects.toThrow('1000 条上限')
    expect(await readFile(f.path, 'utf8')).toBe(before)
  })

  it('bounds feedback excerpts without cutting a surrogate pair, and preserves honest no-rubric feedback', async () => {
    const f = await fixture()
    const review = attempt('long-feedback')
    review.rubric = []
    review.feedback = '字'.repeat(599) + '📖' + '尾部'.repeat(1000)
    f.attempts.set(review.id, review)
    const [node] = await f.service.refresh({ attemptIds: [review.id] })
    expect(node.source).toEqual({ kind: 'feedback' })
    expect(node.reviewExcerpt).toBe('字'.repeat(599))
    expect(node.excerptTruncated).toBe(true)
    expect(node.status).toBe('pending')
  })

  it('does not write if canceled while resolving evidence, and later operations remain usable', async () => {
    const f = await fixture()
    const controller = new AbortController()
    vi.mocked(f.sources.resolveChunks).mockImplementation(async () => {
      controller.abort()
      return [f.evidence]
    })
    const before = await readFile(f.path, 'utf8')
    await expect(
      f.service.associate(
        { nodeId: f.nodes[0].id, expectedRevision: 1, chunkIds: [f.evidence.chunkId] },
        { signal: controller.signal },
      ),
    ).rejects.toThrow('已取消')
    expect(await readFile(f.path, 'utf8')).toBe(before)
    expect(
      (
        await f.service.updateLabel({
          nodeId: f.nodes[0].id,
          expectedRevision: 1,
          label: '仍可编辑',
        })
      ).label,
    ).toBe('仍可编辑')
  })

  it('rejects review changes discovered after asynchronous evidence resolution before committing a link', async () => {
    const f = await fixture()
    vi.mocked(f.sources.resolveChunks).mockImplementation(async () => {
      f.attempts.get('submission-1')!.feedback = '读取时发生的更改'
      return [f.evidence]
    })
    const before = await readFile(f.path, 'utf8')
    await expect(
      f.service.associate({
        nodeId: f.nodes[0].id,
        expectedRevision: 1,
        chunkIds: [f.evidence.chunkId],
      }),
    ).rejects.toThrow('本次关联未保存')
    expect(await readFile(f.path, 'utf8')).toBe(before)
  })

  it('rejects a mismatched canonical resolver identity and malformed references rather than trusting caller titles/pages', async () => {
    const f = await fixture()
    vi.mocked(f.sources.resolveChunks).mockResolvedValue([{ ...f.evidence, pageNumber: 3 }])
    await expect(
      f.service.associate({
        nodeId: f.nodes[0].id,
        expectedRevision: 1,
        chunkIds: [f.evidence.chunkId],
      }),
    ).rejects.toThrow('校验失败')
    vi.mocked(f.sources.resolveAttempt).mockResolvedValue(attempt('someone-else'))
    expect(await f.service.get(f.nodes[0].id)).toMatchObject({
      status: 'stale',
      staleReason: 'source-unavailable',
    })
  })
})

describe('review index with real content-addressed local PDF storage', () => {
  // This real-worker integrity check includes bundling, PDF extraction and durable disk IO.
  // Keep its functional assertions while allowing bounded cold-start time on Windows CI.
  it('verifies real PDF SHA, catches changed index text and source bytes, and never deletes PDF on unlink', async () => {
    const f = await fixture()
    const workerPath = resolve(`dist-electron/review-knowledge-test-${randomUUID()}.cjs`)
    try {
      await build({
        entryPoints: ['src/adapters/knowledge-pdf-worker.ts'],
        outfile: workerPath,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node22',
        external: ['pdfjs-dist/*'],
      })
      const library = new LocalKnowledgeLibrary(f.home, { workerPath })
      const bytes = createKnowledgePdf([
        '这是一份自编合成 PDF。',
        '实践如何检验认识。这段文字专用于索引测试。',
      ])
      const result = await library.importBytes('合成教材', bytes, { subject: 'politics' })
      if (result.canceled) throw new Error('Unexpected synthetic import cancellation')
      const [hit] = await library.search({
        documentId: result.document.id,
        subject: 'politics',
        query: '实践',
      })
      const index = new ReviewKnowledgeIndex(f.home, {
        resolveAttempt: f.sources.resolveAttempt,
        resolveChunks: (ids) => library.resolveChunks(ids),
        verifyDocument: async (id) => {
          await library.getBytes(id)
        },
      })
      const linked = await index.associate({
        nodeId: f.nodes[0].id,
        expectedRevision: 1,
        chunkIds: [hit.chunkId],
      })
      expect(linked.references[0].documentSha256).toBe(
        createHash('sha256').update(bytes).digest('hex'),
      )
      expect(await index.resolveEvidence(linked.id)).toEqual(
        [{ ...hit, score: undefined }].map(({ score: _score, ...evidence }) => evidence),
      )
      const root = join(f.home, 'knowledge-library', result.document.id)
      const textPath = join(root, 'text.json')
      const text = await readFile(textPath, 'utf8')
      const replaced = JSON.parse(text)
      replaced.pages[1] = '不同的提取文字；位置相同也不能自动替代原引用。'
      await writeFile(textPath, JSON.stringify(replaced))
      expect(await index.get(linked.id)).toMatchObject({
        status: 'stale',
        staleReason: 'evidence-changed',
      })
      expect(await index.resolveEvidence(linked.id)).toEqual([])
      await writeFile(textPath, text)
      expect((await index.get(linked.id))?.status).toBe('linked')
      const pdfPath = join(root, 'source.pdf')
      const corrupt = new Uint8Array(bytes)
      corrupt[corrupt.length - 3] ^= 1
      await writeFile(pdfPath, corrupt)
      expect(await index.get(linked.id)).toMatchObject({
        status: 'stale',
        staleReason: 'evidence-changed',
      })
      const removed = await index.removeAssociation({
        nodeId: linked.id,
        expectedRevision: linked.revision,
      })
      expect(removed.status).toBe('pending')
      expect(await readFile(pdfPath)).toEqual(Buffer.from(corrupt))
      await writeFile(pdfPath, bytes)
      expect(await library.getBytes(result.document.id)).toEqual(bytes)
    } finally {
      await rm(workerPath, { force: true })
    }
  }, 60000)
})
