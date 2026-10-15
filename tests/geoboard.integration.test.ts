/** Native draft/schema regression tests for optional dynamic geometry. */
import { describe, expect, it } from 'vitest'
import { geoboardSchema } from '../src/shared/geoboard'
import { draftSchema, mathWorkbenchSchema, studyStateSchema } from '../src/domain/schemas'
import { emptyDraft, emptyMathState } from '../src/shared/types'
import { boardStyle, emptyGeoboard } from '../src/shared/geoboard-types'
import type { GeoboardState } from '../src/shared/geoboard-types'
import { movePoint, removeNodes, solveGeoboard, BoardHistory } from '../src/domain/geoboard'

function fixture(): GeoboardState {
  return {
    ...emptyGeoboard(),
    points: [
      { id: 'A', ...boardStyle('A'), kind: 'free', x: 0, y: 0, locked: false },
      { id: 'B', ...boardStyle('B'), kind: 'free', x: 3, y: 0, locked: false },
      { id: 'P', ...boardStyle('P'), kind: 'free', x: 5, y: 0, locked: false },
      { id: 'Q', ...boardStyle('Q'), kind: 'on-object', object: 'circle', parameter: Math.PI / 2 },
    ],
    objects: [
      { id: 'circle', ...boardStyle('C'), kind: 'circle', center: 'A', through: 'B' },
      { id: 't1', ...boardStyle(), kind: 'tangent', point: 'P', circle: 'circle', branch: 0 },
      { id: 't2', ...boardStyle(), kind: 'tangent', point: 'P', circle: 'circle', branch: 1 },
    ],
  }
}
describe('optional geoboard draft integration', () => {
  it('accepts old math drafts without adding fields or mutating the original input', () => {
    const old = emptyMathState(),
      bytes = JSON.stringify(old)
    expect(Object.hasOwn(old, 'geoboard')).toBe(false)
    const parsed = mathWorkbenchSchema.parse(old)
    expect(parsed).toEqual(old)
    expect(Object.hasOwn(parsed, 'geoboard')).toBe(false)
    expect(JSON.stringify(old)).toBe(bytes)
  })
  it('accepts old state snapshots with no geoboard migration', () => {
    const old = { version: 1, drafts: { legacy: emptyDraft('math') }, attempts: [] }
    const bytes = JSON.stringify(old)
    const parsed = studyStateSchema.parse(old)
    expect(parsed).toEqual(old)
    expect(Object.hasOwn(parsed.drafts.legacy.math!, 'geoboard')).toBe(false)
    expect(JSON.stringify(old)).toBe(bytes)
  })
  it('persists new constructions through the native math and full draft schemas', () => {
    const math = { ...emptyMathState(), geoboard: fixture() }
    expect(mathWorkbenchSchema.parse(math)).toEqual(math)
    const draft = { ...emptyDraft('math'), math }
    expect(draftSchema.parse(draft)).toEqual(draft)
  })
  it('round-trips the native geoboard Zod schema without normalization', () => {
    const board = fixture()
    expect(geoboardSchema.parse(JSON.parse(JSON.stringify(board)))).toEqual(board)
  })
  it('rejects unknown fields, missing references, and circular dependencies', () => {
    expect(() => geoboardSchema.parse({ ...fixture(), hiddenAnswer: 'no' })).toThrow()
    const missing = fixture()
    missing.points = missing.points.filter((p) => p.id !== 'A')
    expect(() => geoboardSchema.parse(missing)).toThrow()
    const cycle = fixture()
    cycle.points[0] = {
      id: 'A',
      ...boardStyle(),
      kind: 'on-object',
      object: 'circle',
      parameter: 0,
    }
    expect(() => geoboardSchema.parse(cycle)).toThrow()
  })
  it('keeps a temporarily degenerate scene valid as data and lets it recover', () => {
    const board = movePoint(fixture(), 'B', { x: 0, y: 0 })
    expect(() => geoboardSchema.parse(board)).not.toThrow()
    expect(solveGeoboard(board).errors.has('circle')).toBe(true)
    const recovered = movePoint(board, 'B', { x: 3, y: 0 })
    expect(solveGeoboard(recovered).errors.size).toBe(0)
  })
  it('does not mutate old draft objects when moving or deleting new constructions', () => {
    const draft = { ...emptyDraft('math'), math: { ...emptyMathState(), geoboard: fixture() } }
    const bytes = JSON.stringify(draft)
    movePoint(draft.math.geoboard, 'P', { x: 8, y: 2 })
    removeNodes(draft.math.geoboard, ['A'])
    expect(JSON.stringify(draft)).toBe(bytes)
  })
  it('does not let undo history cross a document reset', () => {
    const history = new BoardHistory(fixture())
    history.commit(movePoint(history.present, 'P', { x: 8, y: 2 }))
    history.reset(emptyGeoboard())
    expect(history.canUndo).toBe(false)
    expect(history.canRedo).toBe(false)
  })
})

// A real service/store round trip, isolated from every user's data directory.
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalQuestionBank } from '../src/adapters/local-question-bank'
import { LocalRuleAgent } from '../src/adapters/local-rule-agent'
import { StudyService } from '../src/domain/study-service'
import { z } from 'zod'
import { draftWireSchema } from '../src/domain/schemas'
it('keeps new geometry representable in the MCP JSON Schema', () => {
  expect(z.toJSONSchema(draftWireSchema, { io: 'input' })).toHaveProperty('properties.math')
})
it('persists and reloads dynamic geometry without rewriting submitted snapshots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'examcraft-geoboard-store-'))
  try {
    const bank = new LocalQuestionBank(directory)
    const question = (await bank.list({ subject: 'math' })).find((q) => q.kind === 'math')!
    const agent = new LocalRuleAgent(),
      service = new StudyService(directory, bank, agent)
    const draft = {
      ...emptyDraft('math'),
      text: '先确定圆心，再计算半径并验证相切。',
      math: { ...emptyMathState(), geoboard: fixture() },
    }
    await service.saveDraft(question.id, draft)
    const restart = new StudyService(directory, new LocalQuestionBank(directory), agent)
    expect((await restart.loadState()).drafts[question.id]).toEqual(draft)
    await restart.submitAnswer(question.id, draft)
    const snapshot = JSON.stringify((await restart.loadState()).attempts[0])
    const next = {
      ...draft,
      math: { ...draft.math, geoboard: movePoint(draft.math.geoboard, 'P', { x: 9, y: 1 }) },
    }
    await restart.saveDraft(question.id, next)
    const persisted = await new StudyService(directory, bank, agent).loadState()
    expect(persisted.drafts[question.id]).toEqual(next)
    expect(JSON.stringify(persisted.attempts[0])).toBe(snapshot)
    expect(persisted.attempts[0].draft.math?.geoboard).toEqual(draft.math.geoboard)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('opening legacy records preserves their actual on-disk bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'examcraft-geoboard-legacy-'))
  try {
    const original = { version: 1, drafts: { legacy: emptyDraft('math') }, attempts: [] }
    const bytes = JSON.stringify(original, null, 4) + '\n'
    const file = join(directory, 'study-state.json')
    await writeFile(file, bytes, 'utf8')
    const service = new StudyService(
      directory,
      new LocalQuestionBank(directory),
      new LocalRuleAgent(),
    )
    const loaded = await service.loadState()
    expect(loaded).toEqual(original)
    expect(Object.hasOwn(loaded.drafts.legacy.math!, 'geoboard')).toBe(false)
    expect(await readFile(file, 'utf8')).toBe(bytes)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
