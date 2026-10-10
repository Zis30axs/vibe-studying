import { z } from 'zod'
import { subjects } from '../shared/subjects'
import { geographyFigureSchema, questionProvenanceSchema } from './geography-figure'
import type { QuestionBankAdapter } from '../adapters/contracts'
import type { Question, StudentQuestion } from '../shared/types'

/** Public snapshot schema deliberately excludes all grading/reference fields. */
const publicId = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
  .refine((value) => !['__proto__', 'prototype', 'constructor'].includes(value))
const publicShortText = z.string().trim().min(1).max(200)
export const studentQuestionSchema = z
  .strictObject({
    id: publicId,
    subject: z.enum(subjects),
    kind: z.enum(['choice', ...subjects]),
    title: publicShortText,
    prompt: z.string().trim().min(1).max(20000),
    source: publicShortText,
    tags: z.array(publicShortText).max(20),
    maxScore: z.number().int().min(1).max(100),
    choices: z
      .array(z.strictObject({ id: publicId, text: z.string().trim().min(1).max(5000) }))
      .min(2)
      .max(10)
      .optional(),
    figure: geographyFigureSchema.optional(),
    provenance: questionProvenanceSchema.optional(),
  })
  .superRefine((question, ctx) => {
    if (question.figure && question.subject !== 'geography')
      ctx.addIssue({ code: 'custom', message: '示意图只适用于地理题' })
    if (question.kind !== 'choice' && question.kind !== question.subject)
      ctx.addIssue({ code: 'custom', message: '题型和学科不一致' })
    if (question.kind === 'choice' && !question.choices)
      ctx.addIssue({ code: 'custom', message: '选择题需要选项' })
    if (question.kind !== 'choice' && question.choices)
      ctx.addIssue({ code: 'custom', message: '主观题不包含选项' })
    if (
      question.choices &&
      new Set(question.choices.map((choice) => choice.id)).size !== question.choices.length
    )
      ctx.addIssue({ code: 'custom', message: '选项 ID 必须唯一' })
  }) satisfies z.ZodType<StudentQuestion>

/** Runtime allowlist, not a cast or object spread. Never expose answers or sample blocks. */
export function studentQuestionProjection(question: Question): StudentQuestion {
  return {
    id: question.id,
    subject: question.subject,
    kind: question.kind,
    title: question.title,
    prompt: question.prompt,
    source: question.source,
    tags: question.tags.map((tag) => tag),
    maxScore: question.maxScore,
    ...(question.figure ? { figure: geographyFigureSchema.parse(question.figure) } : {}),
    ...(question.provenance
      ? { provenance: questionProvenanceSchema.parse(question.provenance) }
      : {}),
    ...(question.choices
      ? { choices: question.choices.map((choice) => ({ id: choice.id, text: choice.text })) }
      : {}),
  }
}

/** The list IPC endpoint must use this boundary instead of returning bank.list(). */
export async function listStudentQuestions(
  bank: Pick<QuestionBankAdapter, 'list'>,
): Promise<StudentQuestion[]> {
  return (await bank.list()).map(studentQuestionProjection)
}
