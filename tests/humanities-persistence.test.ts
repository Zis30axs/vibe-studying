import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalQuestionBank } from '../src/adapters/local-question-bank'
import { LocalRuleAgent } from '../src/adapters/local-rule-agent'
import { StudyService } from '../src/domain/study-service'
import { argumentFromDraft, generateArgumentText } from '../src/domain/argument'
import { emptyDraft, type AnswerDraft, type ArgumentNode } from '../src/shared/types'

const leaf = (id: string, text: string): ArgumentNode => ({
  id,
  kind: 'analysis',
  text,
  children: [],
})
describe('humanities storage compatibility', () => {
  let directory: string
  const service = () =>
    new StudyService(directory, new LocalQuestionBank(directory), new LocalRuleAgent())
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'examcraft-humanities-'))
  })
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('keeps old version-1 drafts, imported blocks and history, then saves nested edits separately', async () => {
    const bank = new LocalQuestionBank(directory)
    const question = await bank.get('pol-assembly-1')
    const imported = { ...question, id: 'legacy-imported-blocks' }
    await bank.importBank({ version: 1, questions: [imported] })
    const legacy = { ...emptyDraft(), blocks: question.blocks!.slice(0, 2), text: '旧版手写补充' }
    const oldAttempt = await service().submitAnswer(imported.id, legacy)
    const raw = JSON.parse(await readFile(join(directory, 'study-state.json'), 'utf8'))
    expect(raw.version).toBe(1)
    expect(raw.drafts[imported.id]).not.toHaveProperty('argument')
    await writeFile(join(directory, 'study-state.json'), JSON.stringify(raw))
    const restored = service()
    expect((await restored.loadState()).attempts).toEqual([oldAttempt])
    expect(await restored.bank.get(imported.id)).toEqual(imported)
    const next: AnswerDraft = { ...legacy, argument: argumentFromDraft(legacy) }
    expect(generateArgumentText(next.argument!.roots)).toContain(legacy.blocks[0].text)
    expect(next.text).toBe('旧版手写补充')
    await restored.saveDraft(imported.id, next)
    const restarted = await service().loadState()
    expect(restarted.drafts[imported.id]).toEqual(next)
    expect(restarted.attempts[0].draft).toEqual(legacy)
    expect(restarted.attempts[0].draft).not.toHaveProperty('argument')
  })

  it('persists exact nested snapshot and independent manual text across later edits and restarts', async () => {
    const roots: ArgumentNode[] = [
      {
        id: 'p1',
        kind: 'point',
        text: '第一点',
        children: [
          {
            id: 'c1',
            kind: 'cause',
            text: '需要证据支持的因果关系',
            children: [leaf('a1', '原始材料分析')],
          },
        ],
      },
    ]
    const draft: AnswerDraft = {
      ...emptyDraft(),
      argument: { version: 1, roots },
      text: '手写最终正文，与模块预览不同。',
    }
    const first = service()
    await first.saveDraft('pol-assembly-1', draft)
    const submitted = await first.submitAnswer('pol-assembly-1', draft)
    const changed = structuredClone(draft)
    changed.argument!.roots[0].children[0].children[0].text = '提交之后的新分析'
    changed.text = '下一次练习的正文'
    await first.saveDraft('pol-assembly-1', changed)
    const restarted = await service().loadState()
    expect(restarted.drafts['pol-assembly-1']).toEqual(changed)
    expect(restarted.attempts).toEqual([submitted])
    expect(restarted.attempts[0].draft.argument).toEqual(draft.argument)
    expect(restarted.attempts[0].draft.text).toBe(draft.text)
  })

  it('retains geography drawing alongside nested argument and supports drawing-only submission', async () => {
    const draft: AnswerDraft = {
      ...emptyDraft(),
      argument: { version: 1, roots: [leaf('a1', '')] },
      drawing: {
        mode: 'geographic',
        points: [
          { id: 'A', x: 20, y: 30, label: 'A' },
          { id: 'B', x: 40, y: 50, label: 'B' },
        ],
        lines: [{ id: 'AB', from: 'A', to: 'B' }],
      },
    }
    const attempt = await service().submitAnswer('geo-drawing-1', draft)
    const restarted = await service().loadState()
    expect(restarted.attempts[0]).toEqual(attempt)
    expect(restarted.drafts['geo-drawing-1'].drawing).toEqual(draft.drawing)
    expect(restarted.attempts[0].feedback).toContain('未参与自动评分')
  })
})
