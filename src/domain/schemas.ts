import { z } from 'zod'
import { parseExpression } from './math'
import { subjects } from '../shared/subjects'
import type {
  AnswerDraft,
  ArgumentDocument,
  ArgumentNode,
  Question,
  StudyState,
} from '../shared/types'
import {
  argumentKinds,
  assertArgumentRoots,
  finalAnswerText,
  MAX_ARGUMENT_DEPTH,
  MAX_ARGUMENT_NODES,
  MAX_ARGUMENT_TEXT_LENGTH,
} from './argument'

export const idSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
  .refine(
    (value) => !['__proto__', 'prototype', 'constructor'].includes(value),
    '保留标识符不可使用',
  )
const shortText = z.string().trim().min(1).max(200)
export const subjectSchema = z.enum(subjects)
export const blockSchema = z.strictObject({
  id: idSchema,
  category: z.enum(['principle', 'material', 'analysis', 'conclusion']),
  label: z.string().trim().min(1).max(120),
  text: z.string().max(4000),
})
const rubricSchema = z.strictObject({
  id: idSchema,
  label: shortText,
  keywords: z.array(z.string().trim().min(1).max(100)).min(1).max(20),
  points: z.number().int().min(1).max(100),
})
function uniqueIds(items: { id: string }[] | undefined): boolean {
  return !items || new Set(items.map((item) => item.id)).size === items.length
}
export const questionSchema = z
  .strictObject({
    id: idSchema,
    subject: subjectSchema,
    kind: z.enum(['choice', ...subjects]),
    title: shortText,
    prompt: z.string().trim().min(1).max(20000),
    source: shortText,
    tags: z.array(shortText).max(20),
    maxScore: z.number().int().min(1).max(100),
    explanation: z.string().trim().min(1).max(20000),
    choices: z
      .array(z.strictObject({ id: idSchema, text: z.string().trim().min(1).max(5000) }))
      .min(2)
      .max(10)
      .optional(),
    correctAnswer: idSchema.optional(),
    blocks: z.array(blockSchema).max(30).optional(),
    rubric: z.array(rubricSchema).min(1).max(20).optional(),
  })
  .superRefine((question, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message })
    if (!uniqueIds(question.choices) || !uniqueIds(question.blocks) || !uniqueIds(question.rubric))
      fail('选项、模块和评分项的标识符必须各自唯一')
    if (question.kind === 'choice') {
      if (!question.choices?.some((choice) => choice.id === question.correctAnswer))
        fail('选择题需要有效选项和正确答案')
    } else {
      if (question.kind !== question.subject) fail('主观题类型必须与学科一致')
      if (question.choices || question.correctAnswer) fail('主观题不能包含选择题答案')
      if (
        !question.rubric ||
        question.rubric.reduce((total, item) => total + item.points, 0) !== question.maxScore
      )
        fail('主观题评分项分数之和必须等于满分')
    }
  }) satisfies z.ZodType<Question>

export const questionBankSchema = z
  .strictObject({
    version: z.literal(1),
    questions: z.array(questionSchema).max(1000),
  })
  .refine((bank) => uniqueIds(bank.questions), '题库中的题目 ID 重复')

export const drawingSchema = z
  .strictObject({
    mode: z.enum(['cartesian', 'geographic']),
    points: z
      .array(
        z.strictObject({
          id: idSchema,
          x: z.number().finite(),
          y: z.number().finite(),
          label: z.string().max(80),
        }),
      )
      .max(200),
    lines: z.array(z.strictObject({ id: idSchema, from: idSchema, to: idSchema })).max(400),
  })
  .superRefine((drawing, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message })
    if (!uniqueIds(drawing.points) || !uniqueIds(drawing.lines)) fail('绘图元素 ID 必须唯一')
    const pointIds = new Set(drawing.points.map((point) => point.id))
    if (
      drawing.lines.some(
        (line) => line.from === line.to || !pointIds.has(line.from) || !pointIds.has(line.to),
      )
    )
      fail('线段必须连接两个已存在的不同点')
    const maxX = drawing.mode === 'geographic' ? 180 : 10
    const maxY = drawing.mode === 'geographic' ? 90 : 10
    if (drawing.points.some((point) => Math.abs(point.x) > maxX || Math.abs(point.y) > maxY))
      fail('坐标超出当前坐标系范围')
  })

export const mathWorkbenchSchema = z
  .strictObject({
    drawing: drawingSchema.refine(
      (drawing) => drawing.mode === 'cartesian',
      '数学工具需要直角坐标系',
    ),
    expression: z
      .string()
      .max(160)
      .refine((expression) => {
        try {
          if (!expression.trim()) return true
          parseExpression(expression)
          return true
        } catch {
          return false
        }
      }, '函数表达式无效，请使用支持的符号和显式乘号 *'),
    parameters: z.strictObject({
      a: z.number().finite().min(-10).max(10),
      b: z.number().finite().min(-10).max(10),
      c: z.number().finite().min(-10).max(10),
    }),
    measurement: z.array(idSchema).max(3),
  })
  .superRefine((math, ctx) => {
    const ids = new Set(math.drawing.points.map((point) => point.id))
    if (
      new Set(math.measurement).size !== math.measurement.length ||
      math.measurement.some((id) => !ids.has(id))
    )
      ctx.addIssue({ code: 'custom', path: ['measurement'], message: '测量必须选择不同的已有点' })
  })

// Bounded shape remains representable as an MCP JSON Schema. The in-process schema
// separately guards object identity BEFORE Zod recursively traverses the children.
function boundedArgumentNodeSchema(depth: number): z.ZodType<ArgumentNode> {
  return z.strictObject({
    id: idSchema,
    kind: z.enum(argumentKinds),
    text: z.string().max(MAX_ARGUMENT_TEXT_LENGTH),
    children:
      depth === MAX_ARGUMENT_DEPTH
        ? z.array(z.never()).max(0)
        : z.array(boundedArgumentNodeSchema(depth + 1)).max(MAX_ARGUMENT_NODES),
  })
}
const argumentWireSchema = z.strictObject({
  version: z.literal(1),
  roots: z.array(boundedArgumentNodeSchema(1)).max(MAX_ARGUMENT_NODES),
})
export const argumentSchema = z.preprocess((input, ctx) => {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error('论证结构格式无效')
    assertArgumentRoots((input as Record<string, unknown>).roots)
  } catch (error) {
    ctx.addIssue({
      code: 'custom',
      message: error instanceof Error ? error.message : '论证结构无效',
    })
    return z.NEVER
  }
  return input
}, argumentWireSchema) satisfies z.ZodType<ArgumentDocument>

const draftObjectSchema = z.strictObject({
  choiceId: idSchema.optional(),
  math: mathWorkbenchSchema.optional(),
  text: z.string().max(20000),
  blocks: z.array(blockSchema.extend({ label: z.string().max(120) })).max(30),
  drawing: drawingSchema,
})
export const draftSchema = draftObjectSchema
  .extend({ argument: argumentSchema.optional() })
  .refine((draft) => uniqueIds(draft.blocks), '已选模块 ID 重复') satisfies z.ZodType<AnswerDraft>

/** JSON transport has no object aliases. Always follow this wire schema with validateAnswer. */
export const draftWireSchema = draftObjectSchema
  .extend({ argument: argumentWireSchema.optional() })
  .refine((draft) => uniqueIds(draft.blocks), '已选模块 ID 重复')

export const reviewSchema = z
  .strictObject({
    score: z.number().int().min(0).max(100),
    maxScore: z.number().int().min(1).max(100),
    feedback: z.string().max(20000),
    explanation: z.string().max(20000),
    reviewer: shortText,
    rubric: z
      .array(
        z.strictObject({
          id: idSchema,
          label: shortText,
          earned: z.number().int().min(0),
          possible: z.number().int().min(1),
          feedback: z.string().max(5000),
        }),
      )
      .max(20),
  })
  .superRefine((review, ctx) => {
    if (review.score > review.maxScore || review.rubric.some((item) => item.earned > item.possible))
      ctx.addIssue({ code: 'custom', message: '评分超出满分' })
  })
export const attemptSchema = z
  .strictObject({
    ...reviewSchema.shape,
    id: idSchema,
    questionId: idSchema,
    submittedAt: z.iso.datetime(),
    draft: draftSchema,
  })
  .superRefine((attempt, ctx) => {
    if (
      attempt.score > attempt.maxScore ||
      attempt.rubric.some((item) => item.earned > item.possible)
    )
      ctx.addIssue({ code: 'custom', message: '分数超出满分' })
  })
export const studyStateSchema = z.strictObject({
  version: z.literal(1),
  drafts: z.record(idSchema, draftSchema),
  attempts: z.array(attemptSchema).max(100000),
}) satisfies z.ZodType<StudyState>

export const scopeSchema = z.strictObject({
  subject: subjectSchema.optional(),
  tags: z.array(shortText).max(20).optional(),
  questionIds: z.array(idSchema).max(1000).optional(),
})
export type QuestionScope = z.infer<typeof scopeSchema>

export function validateAnswer(
  question: Question,
  input: unknown,
  submitting = false,
): AnswerDraft {
  const draft = draftSchema.parse(input)
  if (draft.choiceId && !question.choices?.some((choice) => choice.id === draft.choiceId))
    throw new Error('无效的选项')
  if (submitting && question.kind === 'choice' && !draft.choiceId)
    throw new Error('请先选择一个答案')
  if (
    submitting &&
    question.kind !== 'choice' &&
    !finalAnswerText(draft).trim() &&
    !draft.drawing.points.length
  )
    throw new Error('请先填写答案或绘图')
  if (
    submitting &&
    (['chinese', 'math', 'english', 'history'].includes(question.kind) ||
      (draft.argument && question.kind !== 'choice' && question.kind !== 'geography')) &&
    !draft.text.trim()
  )
    throw new Error('请先填写文字答案')
  return draft
}

export const submissionOptionsSchema = z.strictObject({
  provider: z.enum(['local', 'deepseek']),
  cloudConsent: z.boolean().optional(),
  syllabus: z.string().trim().max(4000).optional(),
})
