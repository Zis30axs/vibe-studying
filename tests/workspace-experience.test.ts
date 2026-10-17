import { describe, it, expect } from 'vitest'
import {
  findWorkspaceCommands,
  hasWorkspaceDraft,
  parseWorkspaceUi,
  workspaceNavigation,
} from '../src/domain/workspace-experience'
import { emptyDraft, type StudentQuestion } from '../src/shared/types'
const question: StudentQuestion = {
  id: 'circle-01',
  title: '圆心约束',
  subject: 'math',
  kind: 'math',
  prompt: '求圆方程',
  source: 'Test',
  maxScore: 10,
  tags: ['切线', '距离'],
}
describe('workspace experience (display-only)', () => {
  it.each([null, '', '{}', 'null', '{', '[]', '{"version":2}'])(
    'recovers from invalid preferences: %s',
    (raw) => {
      expect(parseWorkspaceUi(raw)).toEqual({ version: 1, lastQuestionId: '', motion: 'system' })
    },
  )
  it('allowlists only the last question ID and motion choice', () => {
    expect(
      parseWorkspaceUi(
        JSON.stringify({
          version: 1,
          lastQuestionId: 'circle-01',
          motion: 'reduce',
          apiKey: 'NEVER_COPY',
          answer: 'NEVER_COPY',
        }),
      ),
    ).toEqual({ version: 1, lastQuestionId: 'circle-01', motion: 'reduce' })
  })
  it.each(['../file', 'constructor', '__proto__', 'x'.repeat(81), ''])(
    'rejects unsafe remembered IDs: %s',
    (lastQuestionId) => {
      expect(parseWorkspaceUi(JSON.stringify({ version: 1, lastQuestionId }))).toEqual({
        version: 1,
        lastQuestionId: '',
        motion: 'system',
      })
    },
  )
  it('does not mark initialized empty math state as a draft', () => {
    expect(hasWorkspaceDraft(emptyDraft('math'))).toBe(false)
    expect(hasWorkspaceDraft(undefined)).toBe(false)
  })
  it('detects prose, choice and point work without mutation', () => {
    for (const edit of ['prose', 'choice', 'point']) {
      const d = emptyDraft('math')
      if (edit === 'prose') d.text = '独立思路'
      if (edit === 'choice') d.choiceId = 'A'
      if (edit === 'point') d.drawing.points = [{ id: 'p', label: 'P', x: 1, y: 2 }]
      const bytes = JSON.stringify(d)
      expect(hasWorkspaceDraft(d)).toBe(true)
      expect(JSON.stringify(d)).toBe(bytes)
    }
  })
  it('offers the comprehensive challenge route alongside existing routes and motion toggle', () => {
    expect(workspaceNavigation).toHaveLength(9)
    expect(new Set(workspaceNavigation.map((v) => v.id)).size).toBe(9)
    expect(findWorkspaceCommands([], '', 'system')).toHaveLength(10)
    expect(findWorkspaceCommands([], '数学挑战', 'system')[0].target).toBe('challenge')
    expect(findWorkspaceCommands([], '设置', 'system')[0].target).toBe('adapters')
  })
  it('matches combined subject + tag, case and fullwidth identifiers', () => {
    expect(findWorkspaceCommands([question], '数学 切线', 'system')[0].target).toBe(question.id)
    expect(findWorkspaceCommands([question], 'ＣＩＲＣＬＥ－０１', 'system')[0].target).toBe(
      question.id,
    )
  })
  it('never indexes hidden grading fields, including malicious adapter extra fields', () => {
    const q = {
      ...question,
      explanation: 'SECRET_ANSWER',
      correctAnswer: 'SECRET_ANSWER',
      rubric: [{ label: 'SECRET_ANSWER' }],
    }
    expect(findWorkspaceCommands([q], 'SECRET_ANSWER', 'system')).toEqual([])
    expect(JSON.stringify(findWorkspaceCommands([q], '', 'system'))).not.toContain('SECRET_ANSWER')
  })
  it('bounds result count and preserves input order', () => {
    const bank = Array.from({ length: 1000 }, (_, i) => ({ ...question, id: `id-${i}` }))
    const before = JSON.stringify(bank)
    const commands = findWorkspaceCommands(bank, '', 'reduce')
    expect(commands).toHaveLength(30)
    expect(new Set(commands.map((c) => c.id)).size).toBe(30)
    expect(JSON.stringify(bank)).toBe(before)
  })
})
