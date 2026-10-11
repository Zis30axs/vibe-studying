import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LocalQuestionBank } from '../src/adapters/local-question-bank'
import { LocalRuleAgent } from '../src/adapters/local-rule-agent'
import { StudyService } from '../src/domain/study-service'
import { compileGeometryTemplate } from '../src/domain/geometry-templates'
import { studentQuestionProjection } from '../src/domain/student-question'
import { buildAdvisorContext } from '../src/adapters/review-contexts'
import { emptyDraft, emptyMathState } from '../src/shared/types'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})
describe('geometry question and draft persistence', () => {
  it('imports, reloads and submits geometry with immutable student-safe snapshots', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'examcraft-geometry-'))
    directories.push(directory)
    const q = compileGeometryTemplate(
      { templateId: 'square-pyramid-locus', parameters: { side: 5 } },
      'geometry-persist',
    )
    const bank = new LocalQuestionBank(directory)
    await bank.importBank({ version: 1, questions: [q] })
    const restoredBank = new LocalQuestionBank(directory)
    expect(await restoredBank.get(q.id)).toEqual(q)
    const draft = {
      ...emptyDraft(),
      text: '先证明两条相交直线与侧棱垂直，再建立坐标。',
      math: {
        ...emptyMathState(),
        geometry: structuredClone(q.geometry),
        drawing: {
          mode: 'cartesian' as const,
          points: [
            { id: '1-a', label: 'A', x: 0, y: 0 },
            { id: '2-b', label: 'B', x: 2, y: 0 },
            { id: '3-c', label: 'C', x: 0, y: 3 },
          ],
          lines: [{ id: '1-line', from: '1-a', to: '2-b' }],
        },
        rightAngles: [{ id: '1-marker', vertex: '1-a', from: '2-b', to: '3-c' }],
      },
    }
    const service = new StudyService(directory, restoredBank, new LocalRuleAgent())
    await service.saveDraft(q.id, draft)
    expect(
      (await new StudyService(directory, restoredBank, new LocalRuleAgent()).loadState()).drafts[
        q.id
      ],
    ).toEqual(draft)
    const attempt = await service.submitAnswer(q.id, draft)
    expect(attempt.questionSnapshot).toEqual(studentQuestionProjection(q))
    expect(attempt.questionSnapshot).not.toHaveProperty('explanation')
    expect(attempt.questionSnapshot).not.toHaveProperty('rubric')
    expect(attempt.questionSnapshot!.geometry!.points.map((p) => p.id)).not.toContain('F')
    draft.math.geometry!.title = 'Later user edit'
    await service.saveDraft(q.id, draft)
    const state = await new StudyService(
      directory,
      new LocalQuestionBank(directory),
      new LocalRuleAgent(),
    ).loadState()
    expect(state.attempts[0].draft.math!.geometry!.title).toBe(q.geometry!.title)
    expect(state.drafts[q.id].math!.geometry!.title).toBe('Later user edit')
    expect(state.attempts[0].draft.math!.rightAngles).toEqual(draft.math.rightAngles)
    await expect(restoredBank.importBank({ version: 1, questions: [q] })).rejects.toThrow(
      'ID 已存在',
    )
  })
  it('includes the public 3D givens in Advisor contexts without revealing teacher fields', () => {
    const q = compileGeometryTemplate({
      templateId: 'square-pyramid-locus',
      parameters: { side: 3 },
    })
    const context = buildAdvisorContext(q, {
      requestId: 'geometry-advisor',
      questionId: q.id,
      selectedText: '平面PBC',
      source: 'question',
      includeReference: false,
      cloudConsent: true,
      configRevision: 1,
    })
    expect(context.question.geometry).toEqual(q.geometry)
    expect(Object.isFrozen(context.question.geometry)).toBe(true)
    expect(context.question).not.toHaveProperty('reference')
    expect(context.question).not.toHaveProperty('rubric')
    expect(JSON.stringify(context)).not.toContain('√(8/17)')
  })
})
