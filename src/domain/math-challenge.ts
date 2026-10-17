import { z } from 'zod'
import type {
  MathChallengeAnswer,
  MathChallengeCatalogEntry,
  MathChallengePaper,
  MathChallengePaperDefinition,
  MathChallengeQuestion,
  MathChallengeReferenceQuestion,
  MathChallengeReview,
  MathChallengeSaveInput,
  MathChallengeSection,
  MathChallengeSession,
} from '../shared/math-challenge'

const id = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/)
  .refine((value) => !['constructor', 'prototype', '__proto__'].includes(value))
const shortText = z.string().trim().min(1).max(300)
const timestamp = z.number().int().min(0).max(8_640_000_000_000_000)
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const questionSchema = z
  .strictObject({
    id,
    kind: z.enum(['single', 'multiple', 'fill', 'solution']),
    title: shortText,
    prompt: z.string().trim().min(1).max(20000),
    points: z.number().int().min(1).max(50),
    tags: z.array(shortText).max(20),
    choices: z
      .array(z.strictObject({ id, text: shortText }))
      .length(4)
      .optional(),
    answer: z.string().trim().min(1).max(20000),
    explanation: z.string().trim().min(1).max(20000),
    correctChoiceIds: z.array(id).min(1).max(4).optional(),
    rubric: z
      .array(z.strictObject({ label: shortText, points: z.number().int().positive().max(50) }))
      .min(1)
      .max(20),
  })
  .superRefine((question, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message })
    if (question.rubric.reduce((n, r) => n + r.points, 0) !== question.points)
      fail('试题步骤分之和必须等于该题分值')
    if (question.kind === 'single' || question.kind === 'multiple') {
      const options = question.choices ?? []
      const correct = question.correctChoiceIds ?? []
      if (options.length !== 4 || new Set(options.map((c) => c.id)).size !== 4)
        fail('选择题必须有四个不同的选项')
      if (
        new Set(correct).size !== correct.length ||
        correct.some((v) => !options.some((c) => c.id === v))
      )
        fail('选择题答案必须引用已有的不同选项')
      if (question.kind === 'single' ? correct.length !== 1 : correct.length < 2)
        fail('单选必须有一个正确选项，多选必须至少有两个正确选项')
    } else if (question.choices || question.correctChoiceIds) {
      fail('填空、解答题不能含选择题字段')
    }
  })

export const mathChallengePaperSchema = z
  .strictObject({
    id,
    title: shortText,
    description: z.string().trim().min(1).max(2000),
    scope: shortText,
    source: shortText,
    durationMinutes: z.literal(120),
    solutionCount: z.union([z.literal(5), z.literal(6)]),
    questions: z.array(questionSchema).min(19).max(20),
  })
  .superRefine((paper, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message })
    const layout = [
      ...Array<string>(8).fill('single'),
      ...Array<string>(3).fill('multiple'),
      ...Array<string>(3).fill('fill'),
      ...Array<string>(paper.solutionCount).fill('solution'),
    ]
    if (
      paper.questions.length !== layout.length ||
      paper.questions.some((q, i) => q.kind !== layout[i])
    )
      fail('综合卷须按 8 单选、3 多选、3 填空、5/6 解答题顺序排列')
    if (new Set(paper.questions.map((q) => q.id)).size !== paper.questions.length)
      fail('试卷题目 ID 必须唯一')
    if (paper.questions.reduce((n, q) => n + q.points, 0) !== 150) fail('综合卷总分必须为 150')
    if (
      paper.questions.some(
        (q) => q.kind !== 'solution' && q.points !== (q.kind === 'multiple' ? 6 : 5),
      )
    )
      fail('单选、填空每题 5 分，多选每题 6 分')
  }) satisfies z.ZodType<MathChallengePaperDefinition>

export const mathChallengeAnswerSchema = z.strictObject({
  choiceIds: z
    .array(id)
    .max(4)
    .refine((v) => new Set(v).size === v.length, '选项不能重复'),
  text: z.string().max(20000),
  flagged: z.boolean(),
}) satisfies z.ZodType<MathChallengeAnswer>

export const mathChallengeSaveSchema = z
  .strictObject({
    sessionId: id,
    expectedRevision: revision,
    answers: z.record(id, mathChallengeAnswerSchema),
    activeQuestionId: id,
    scratchpad: z.string().max(40000),
  })
  .superRefine((value, ctx) => {
    if (Object.keys(value.answers).length > 20)
      ctx.addIssue({ code: 'custom', message: '单份试卷最多保存 20 题答案' })
  }) satisfies z.ZodType<MathChallengeSaveInput>

export const mathChallengeStartSchema = z.strictObject({ paperId: id })
export const mathChallengeSessionIdSchema = id
export const mathChallengeSubmitSchema = z.strictObject({
  sessionId: id,
  expectedRevision: revision,
})
export const mathChallengeGradeSchema = z.strictObject({
  sessionId: id,
  expectedRevision: revision,
  questionId: id,
  score: z.number().int().min(0).max(50),
})

/** Durable paper snapshot preserves the exact questions and key used for this sitting. */
const recordSchema = z
  .strictObject({
    id,
    paper: mathChallengePaperSchema,
    startedAt: timestamp,
    deadlineAt: timestamp,
    submittedAt: timestamp.nullable(),
    submitReason: z.enum(['manual', 'timeout']).nullable(),
    revision,
    answers: z.record(id, mathChallengeAnswerSchema),
    activeQuestionId: id,
    scratchpad: z.string().max(40000),
    manualScores: z.record(id, z.number().int().min(0).max(50)),
  })
  .superRefine((session, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message })
    const questions = new Map(session.paper.questions.map((q) => [q.id, q]))
    if (!questions.has(session.activeQuestionId)) fail('当前题目不在本次试卷中')
    if (session.deadlineAt !== session.startedAt + session.paper.durationMinutes * 60_000)
      fail('截止时间与考试时长不一致')
    if ((session.submittedAt === null) !== (session.submitReason === null)) fail('交卷状态不一致')
    if (
      session.submittedAt !== null &&
      (session.submittedAt < session.startedAt || session.submittedAt > session.deadlineAt)
    )
      fail('交卷时间不在本次考试范围内')
    for (const [qid, answer] of Object.entries(session.answers)) {
      const q = questions.get(qid)
      if (!q || !isMathChallengeAnswerValid(q, answer)) fail('作答与本次试卷题目不一致')
    }
    for (const [qid, score] of Object.entries(session.manualScores)) {
      const q = questions.get(qid)
      if (
        !q ||
        (q.kind !== 'fill' && q.kind !== 'solution') ||
        score > q.points ||
        session.submittedAt === null
      )
        fail('自评分数与本次已提交的主观题不一致')
    }
  })
export type MathChallengeRecord = z.infer<typeof recordSchema>

export const mathChallengeStoreSchema = z
  .strictObject({
    version: z.literal(1),
    sessions: z.array(recordSchema).max(200),
  })
  .superRefine((state, ctx) => {
    if (new Set(state.sessions.map((s) => s.id)).size !== state.sessions.length)
      ctx.addIssue({ code: 'custom', message: '挑战记录 ID 重复' })
    if (state.sessions.filter((s) => s.submittedAt === null).length > 1)
      ctx.addIssue({ code: 'custom', message: '同一时间只能有一份进行中的试卷' })
  })
export type MathChallengeStore = z.infer<typeof mathChallengeStoreSchema>

export const emptyMathChallengeAnswer = (): MathChallengeAnswer => ({
  choiceIds: [],
  text: '',
  flagged: false,
})
export function isMathChallengeAnswered(
  q: MathChallengeQuestion,
  answer?: MathChallengeAnswer,
): boolean {
  return Boolean(
    answer &&
    (q.kind === 'single' || q.kind === 'multiple' ? answer.choiceIds.length : answer.text.trim()),
  )
}
export function isMathChallengeAnswerValid(
  q: MathChallengeQuestion,
  answer: MathChallengeAnswer,
): boolean {
  if (q.kind === 'single' || q.kind === 'multiple') {
    return (
      !answer.text &&
      (q.kind !== 'single' || answer.choiceIds.length <= 1) &&
      answer.choiceIds.every((id) => q.choices?.some((c) => c.id === id))
    )
  }
  return answer.choiceIds.length === 0
}

/** Explicit allowlist: neither answer, explanation nor rubric can cross before submission. */
export function mathChallengeQuestionProjection(
  q: MathChallengeReferenceQuestion,
): MathChallengeQuestion {
  return {
    id: q.id,
    kind: q.kind,
    title: q.title,
    prompt: q.prompt,
    points: q.points,
    tags: [...q.tags],
    ...(q.choices ? { choices: q.choices.map((c) => ({ id: c.id, text: c.text })) } : {}),
  }
}
export function mathChallengePaperProjection(p: MathChallengePaperDefinition): MathChallengePaper {
  return {
    id: p.id,
    title: p.title,
    description: p.description,
    scope: p.scope,
    source: p.source,
    durationMinutes: p.durationMinutes,
    solutionCount: p.solutionCount,
    questions: p.questions.map(mathChallengeQuestionProjection),
  }
}

const sectionInfo: Record<MathChallengeQuestion['kind'], { label: string; instructions: string }> =
  {
    single: { label: '一、单项选择题', instructions: '每题 5 分，每题只有一个正确选项。' },
    multiple: {
      label: '二、多项选择题',
      instructions: '每题 6 分。本挑战全选对得 6 分，漏选且无错选得 3 分，错选或不选得 0 分。',
    },
    fill: {
      label: '三、填空题',
      instructions: '每题 5 分。请填写结果；交卷后对照参考答案自行核分。',
    },
    solution: {
      label: '四、解答题',
      instructions: '共 77 分。请写出必要文字说明、演算步骤或证明过程；交卷后按步骤自行核分。',
    },
  }
export function mathChallengeSections(p: MathChallengePaper): MathChallengeSection[] {
  return (['single', 'multiple', 'fill', 'solution'] as const).map((kind) => ({
    kind,
    ...sectionInfo[kind],
    count: p.questions.filter((q) => q.kind === kind).length,
    points: p.questions.filter((q) => q.kind === kind).reduce((n, q) => n + q.points, 0),
  }))
}
export function mathChallengeCatalog(p: MathChallengePaperDefinition): MathChallengeCatalogEntry {
  const { questions, ...paper } = mathChallengePaperProjection(p)
  return {
    ...paper,
    totalQuestions: questions.length,
    totalPoints: questions.reduce((n, q) => n + q.points, 0),
    sections: mathChallengeSections(p),
  }
}

/** Fixed local practice rule; no official or AI grading is implied. */
export function scoreMathChallengeChoice(
  q: MathChallengeReferenceQuestion,
  selected: string[],
): number {
  const key = q.correctChoiceIds ?? []
  if (
    !selected.length ||
    new Set(selected).size !== selected.length ||
    selected.some((id) => !key.includes(id))
  )
    return 0
  if (q.kind === 'single') return selected.length === 1 && key.length === 1 ? q.points : 0
  if (q.kind !== 'multiple') return 0
  return selected.length === key.length ? q.points : 3
}

export function mathChallengeReview(record: MathChallengeRecord): MathChallengeReview {
  if (record.submittedAt === null) throw new Error('交卷后才可查看参考答案')
  const items = record.paper.questions.map((q) => {
    const objective = q.kind === 'single' || q.kind === 'multiple'
    const blank = !isMathChallengeAnswered(q, record.answers[q.id])
    const selfScore = record.manualScores[q.id]
    const earned = objective
      ? scoreMathChallengeChoice(q, record.answers[q.id]?.choiceIds ?? [])
      : selfScore !== undefined
        ? selfScore
        : blank
          ? 0
          : null
    return {
      questionId: q.id,
      answer: q.answer,
      explanation: q.explanation,
      rubric: q.rubric.map((r) => ({ ...r })),
      earned,
      points: q.points,
      grading:
        objective || (blank && selfScore === undefined)
          ? ('automatic' as const)
          : earned === null
            ? ('pending' as const)
            : ('self' as const),
    }
  })
  const objectiveItems = items.filter((_, i) =>
    ['single', 'multiple'].includes(record.paper.questions[i].kind),
  )
  const manualItems = items.filter((i) => !objectiveItems.includes(i))
  const objectiveScore = objectiveItems.reduce((n, i) => n + (i.earned ?? 0), 0)
  const manualScore = manualItems.reduce((n, i) => n + (i.earned ?? 0), 0)
  const pendingManualCount = manualItems.filter((i) => i.earned === null).length
  return {
    objectiveScore,
    objectiveMaxScore: 58,
    manualScore,
    manualMaxScore: 92,
    pendingManualCount,
    totalScore: pendingManualCount ? null : objectiveScore + manualScore,
    items,
  }
}

export function mathChallengeSessionProjection(record: MathChallengeRecord): MathChallengeSession {
  return {
    id: record.id,
    paper: mathChallengePaperProjection(record.paper),
    startedAt: record.startedAt,
    deadlineAt: record.deadlineAt,
    submittedAt: record.submittedAt,
    submitReason: record.submitReason,
    revision: record.revision,
    answers: structuredClone(record.answers),
    activeQuestionId: record.activeQuestionId,
    scratchpad: record.scratchpad,
    ...(record.submittedAt !== null ? { review: mathChallengeReview(record) } : {}),
  }
}
