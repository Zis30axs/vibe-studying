import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  generatedQuestion,
  geographyGenerationPrompt,
  generationRequestSchema,
} from '../src/adapters/question-generator'
import { buildAdvisorContext, buildGradingContext } from '../src/adapters/review-contexts'
import { DEFAULT_TERRAIN } from '../src/domain/terrain'
import { compileTerrainExercise, terrainExerciseEvidence } from '../src/domain/terrain-exercise'
import { questionBankSchema } from '../src/domain/schemas'
import { studentQuestionProjection, studentQuestionSchema } from '../src/domain/student-question'
import { TerrainFigure, TerrainReviewProfile } from '../src/components/TerrainFigure'
import { TerrainWorkbench } from '../src/components/TerrainWorkbench'
import { emptyDraft, type GenerateGeographyRequest, type ModelConfig } from '../src/shared/types'
const request: GenerateGeographyRequest = {
  mode: 'terrain',
  requestId: 'terrain-1',
  syllabus: '高中地理',
  chapter: '等高线',
  difficulty: '基础',
  cloudConsent: true,
  configRevision: 1,
}
const config: ModelConfig = {
  protocol: 'openai-chat',
  baseUrl: 'https://api.vendor.com',
  model: 'mock-model',
  revision: 1,
  configured: true,
}
const raw = { terrain: DEFAULT_TERRAIN, section: 'west-center' as const }
const create = () => generatedQuestion(raw, request, config)
describe('computed terrain exercises and reference separation', () => {
  it('constructs numeric questions and reference answers locally from validated model specs', () => {
    const q = create()
    expect(q.prompt).toContain('A(250, 1000) 的高程为 275 m')
    expect(q.prompt).toContain('B(1000, 1000) 的高程为 500 m')
    expect(q.explanation).toContain('225 m')
    expect(q.explanation).toContain('750 m')
    expect(q.explanation).toContain('30%')
    expect(q.explanation).toContain('16.7°')
    expect(q.prompt).not.toContain('30%')
    expect(q.source).toContain('本地数值计算')
    expect(q.rubric?.reduce((sum, item) => sum + item.points, 0)).toBe(q.maxScore)
    expect(questionBankSchema.parse({ version: 1, questions: [q] }).questions[0]).toEqual(q)
    expect(geographyGenerationPrompt(request)).toContain('实际运行本地地形计算器')
    expect(generationRequestSchema.parse(request)).toEqual(request)
  })
  it('rejects model-supplied facts, question text, raw SVG, invalid units or noisy calculation parameters', () => {
    for (const invalid of [
      { ...raw, explanation: 'forged 25%' },
      { ...raw, prompt: '虚假题干' },
      { ...raw, reference: 'pretend' },
      { ...raw, svg: '<svg/>' },
      { ...raw, terrain: { ...DEFAULT_TERRAIN, units: 'degrees' } },
      { ...raw, terrain: { ...DEFAULT_TERRAIN, widthM: 2000.5 } },
      { ...raw, terrain: { ...DEFAULT_TERRAIN, reliefM: 399 } },
      { ...raw, section: 'arbitrary-code' },
    ])
      expect(() => generatedQuestion(invalid, request, config)).toThrow(/格式/)
  })
  it('preserves public view and independent snapshots without computed expected answers', () => {
    const q = create(),
      student = studentQuestionProjection(q)
    expect(studentQuestionSchema.parse(student)).toEqual(student)
    for (const field of ['explanation', 'rubric', 'terrainEvidence', 'profile', 'expectedAnswers'])
      expect(student).not.toHaveProperty(field)
    expect(student.terrain).not.toBe(q.terrain)
    expect(student.terrain!.terrain).not.toBe(q.terrain!.terrain)
    expect(JSON.stringify(student)).not.toContain('meanSignedGradePercent')
    expect(JSON.stringify(student)).not.toContain('30%')
    expect(studentQuestionSchema.safeParse({ ...student, terrainEvidence: {} }).success).toBe(false)
  })
  it('gives Advisor computed evidence only with explicit reference access and freezes grading snapshots', () => {
    const q = create(),
      ask = {
        requestId: 'ask',
        questionId: q.id,
        selectedText: '坡度怎么算',
        source: 'question' as const,
        includeReference: false,
        cloudConsent: true,
        configRevision: 1,
      }
    const hints = buildAdvisorContext(q, ask)
    expect(hints.question.terrain).toEqual(q.terrain)
    expect(hints.question).not.toHaveProperty('terrainEvidence')
    expect(hints.question).not.toHaveProperty('rubric')
    expect(hints.question).not.toHaveProperty('reference')
    const trusted = buildAdvisorContext(q, { ...ask, includeReference: true })
    expect(trusted.question.terrainEvidence?.profile?.meanSignedGradePercent).toBe(30)
    const grading = buildGradingContext(q, { ...emptyDraft(), text: '我的答案' })
    expect(grading.question.terrainEvidence?.profile?.meanSignedGradePercent).toBe(30)
    expect(Object.isFrozen(grading.question.terrainEvidence?.profile)).toBe(true)
    q.terrain!.terrain.reliefM = 800
    expect(grading.question.terrain!.terrain.reliefM).toBe(400)
  })
  it('renders safe contours and givens before submission, then a numeric profile only in review', () => {
    const q = create()
    const view = renderToStaticMarkup(createElement(TerrainFigure, { exercise: q.terrain! }))
    expect(view).toContain('模拟教学等高线')
    const titleId = view.match(/aria-labelledby="([^"]+)"/)![1]
    const descriptionId = view.match(/aria-describedby="([^"]+)"/)![1]
    expect(titleId).not.toContain(' ')
    expect(view).toContain(`<title id="${titleId}">模拟教学等高线图</title>`)
    expect(view).toContain(`<desc id="${descriptionId}">非实测地图。`)
    expect(view).toContain('<polyline')
    expect(view).toContain('米制局部坐标')
    expect(view).not.toContain('terrain-profile-line')
    expect(view).not.toContain('30%')
    const review = renderToStaticMarkup(
      createElement(TerrainReviewProfile, { exercise: q.terrain! }),
    )
    expect(review).toContain('terrain-profile-line')
    expect(review).toContain('30%')
    const interactive = renderToStaticMarkup(createElement(TerrainWorkbench))
    expect(interactive).toContain('计算地形剖面')
    expect(interactive).toContain('查询地形高程')
    expect(interactive).not.toContain('NaN')
    expect(interactive).not.toContain('Infinity')
  })
  it.each(['peak', 'depression', 'ridge', 'saddle', 'plane'] as const)(
    'keeps %s reference facts coherent',
    (preset) => {
      const exercise = compileTerrainExercise({
        terrain: { ...DEFAULT_TERRAIN, preset },
        section: 'west-center',
      })
      const evidence = terrainExerciseEvidence(exercise.terrain)
      expect(evidence.profile!.elevationChangeM).toBe(
        evidence.probes[1].elevationM - evidence.probes[0].elevationM,
      )
      expect(evidence.profile!.horizontalDistanceM).toBe(750)
      expect(exercise.explanation).not.toMatch(/NaN|Infinity/)
    },
  )
})
