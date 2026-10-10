import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { geographyFigureSchema } from '../src/domain/geography-figure'
import { GeographyFigure } from '../src/components/GeographyFigure'
import { questionBankSchema, questionSchema } from '../src/domain/schemas'
import { studentQuestionProjection, studentQuestionSchema } from '../src/domain/student-question'
import { exampleFigure, exampleGeneratedQuestion } from './fixtures/geography-generation'

describe('declarative geography figures', () => {
  it('validates the bounded schema and canonical renderer', () => {
    expect(geographyFigureSchema.parse(exampleFigure)).toEqual(exampleFigure)
    const markup = renderToStaticMarkup(createElement(GeographyFigure, { figure: exampleFigure }))
    expect(markup).toContain('<svg')
    expect(markup).toContain('非实测地图')
    expect(markup).toContain('未经人工核实')
  })
  it('bounds displayed long labels and retains their full text accessibly', () => {
    const long = '这是一段需要完整保留但不能溢出图框的很长地理标签'
    const figure = { ...exampleFigure, labels: [{ id: 'long', x: 0, y: 0, text: long }] }
    const markup = renderToStaticMarkup(createElement(GeographyFigure, { figure }))
    expect(markup).toContain(`${Array.from(long).slice(0, 14).join('')}…`)
    expect(markup).toContain(`<title>${long}</title>`)
    expect(markup).toContain(`<li>${long}</li>`)
    expect(markup).toContain('图中长标签全文')
    const shortMarkup = renderToStaticMarkup(
      createElement(GeographyFigure, { figure: exampleFigure }),
    )
    expect(shortMarkup).not.toContain('长标签全文')
  })
  it.each([NaN, Infinity, -Infinity, 101, -101])('rejects unsafe coordinate %s', (x) => {
    expect(
      geographyFigureSchema.safeParse({ ...exampleFigure, points: [{ id: 'a', x, y: 0 }] }).success,
    ).toBe(false)
  })
  it('rejects duplicate IDs, dangling references and non-point reference cycles', () => {
    for (const invalid of [
      { ...exampleFigure, labels: [{ id: 'up', x: 0, y: 0, text: '重复' }] },
      { ...exampleFigure, arrows: [{ id: 'flow', from: 'up', to: 'missing' }] },
      { ...exampleFigure, arrows: [{ id: 'flow', from: 'up', to: 'up' }] },
      {
        ...exampleFigure,
        arrows: [
          { id: 'flow', from: 'other', to: 'down' },
          { id: 'other', from: 'flow', to: 'up' },
        ],
      },
      { ...exampleFigure, polylines: [{ id: 'loop', points: ['up', 'down', 'up'] }] },
      { ...exampleFigure, points: [{ id: 'constructor', x: 0, y: 0 }] },
    ])
      expect(geographyFigureSchema.safeParse(invalid).success).toBe(false)
  })
  it('permits physical circulation arrows and implicit polygon closure without recursion', () => {
    const figure = {
      ...exampleFigure,
      points: [...exampleFigure.points, { id: 'third', x: 0, y: 50 }],
      polygons: [{ id: 'region', points: ['up', 'down', 'third'] }],
      arrows: [...exampleFigure.arrows, { id: 'return', from: 'down', to: 'up' }],
    }
    expect(geographyFigureSchema.safeParse(figure).success).toBe(true)
    expect(
      geographyFigureSchema.safeParse({
        ...figure,
        polygons: [{ id: 'region', points: ['up', 'down', 'third', 'up'] }],
      }).success,
    ).toBe(false)
  })
  it('rejects raw markup, executable fields, excessive graphs, and grid density', () => {
    for (const invalid of [
      { ...exampleFigure, rawSVG: '<svg onload="alert(1)" />' },
      { ...exampleFigure, title: '<script>alert(1)</script>' },
      { ...exampleFigure, title: 'javascript:alert(1)' },
      { ...exampleFigure, grid: { step: 0.01 } },
      {
        ...exampleFigure,
        points: Array.from({ length: 80 }, (_, i) => ({ id: `p${i}`, x: 0, y: 0 })),
        labels: [{ id: 'extra', x: 0, y: 0, text: 'extra' }],
      },
      { ...exampleFigure, points: [{ id: 'unsafe', x: 0, y: 0, style: { fill: 'red' } }] },
    ])
      expect(geographyFigureSchema.safeParse(invalid).success).toBe(false)
  })
  it('retains safe public figures and provenance without grading data or mutable aliases', () => {
    const question = questionSchema.parse(exampleGeneratedQuestion)
    const student = studentQuestionProjection(question)
    expect(studentQuestionSchema.parse(student)).toEqual(student)
    expect(student).not.toHaveProperty('explanation')
    expect(student).not.toHaveProperty('rubric')
    expect(student.figure).not.toBe(question.figure)
    expect(student.provenance?.verified).toBe(false)
    expect(studentQuestionSchema.safeParse({ ...student, explanation: 'leak' }).success).toBe(false)
  })
  it('keeps legacy version-1 question imports compatible', () => {
    const { figure: _figure, provenance: _provenance, ...legacy } = exampleGeneratedQuestion
    expect(questionBankSchema.safeParse({ version: 1, questions: [legacy] }).success).toBe(true)
  })
})
