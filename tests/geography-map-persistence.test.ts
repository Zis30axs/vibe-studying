import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalQuestionBank } from '../src/adapters/local-question-bank'
import { LocalRuleAgent } from '../src/adapters/local-rule-agent'
import { StudyService } from '../src/domain/study-service'
import { normalizeGeoMap } from '../src/domain/geography-map'
import { emptyDraft } from '../src/shared/types'

describe('offline map state persistence', () => {
  let directory: string
  const service = () =>
    new StudyService(directory, new LocalQuestionBank(directory), new LocalRuleAgent())
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'examcraft-map-'))
  })
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('persists layers, zoom, labels and annotation coordinates across restart and independent submissions', async () => {
    const first = service()
    const draft = emptyDraft('geography')
    draft.text = '根据位置比较两点方向。'
    draft.drawing.points = [
      { id: 'a', x: 116.4, y: 39.9, label: 'A' },
      { id: 'b', x: 120, y: 30, label: 'B' },
    ]
    draft.drawing.lines = [{ id: 'ab', from: 'a', to: 'b' }]
    draft.drawing.map = normalizeGeoMap({
      layer: 'admin1',
      longitude: 110,
      latitude: 35,
      zoom: 8,
      showGrid: false,
      showLabels: false,
    })
    await first.saveDraft('geo-drawing-1', draft)
    expect((await service().loadState()).drafts['geo-drawing-1']).toEqual(draft)
    const submitted = await first.submitAnswer('geo-drawing-1', draft)
    const previous = structuredClone(submitted.draft)
    draft.drawing.map = normalizeGeoMap({ layer: 'terrain', zoom: 2 })
    draft.drawing.points[0].x = 117
    await first.saveDraft('geo-drawing-1', draft)
    const restarted = await service().loadState()
    expect(restarted.attempts[0].draft).toEqual(previous)
    expect(restarted.drafts['geo-drawing-1']).toEqual(draft)
  })

  it('keeps historical Cartesian drawings in their original mode without migration', async () => {
    const old = emptyDraft()
    old.drawing.points = [{ id: 'old', x: 2, y: 3, label: '旧图' }]
    await service().saveDraft('geo-drawing-1', old)
    const restored = (await service().loadState()).drafts['geo-drawing-1']
    expect(restored.drawing).toEqual(old.drawing)
    expect(restored.drawing.map).toBeUndefined()
  })
})
