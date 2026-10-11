import { terrainExerciseSchema, terrainExerciseEvidence } from '../domain/terrain-exercise'
import type { TerrainExercise } from '../shared/terrain'
import { geographyFigureSchema } from '../domain/geography-figure'
import type { KnowledgeEvidence } from '../shared/knowledge'
import type {
  AdvisorRequest,
  AnswerDraft,
  ArgumentNode,
  ModuleReviewRequest,
  Question,
  RubricItem,
  Subject,
  GeographyFigure,
} from '../shared/types'

/** These payloads are built only in the trusted process. No conversation/state object is accepted. */
export interface AdvisorQuestionContext {
  figure?: GeographyFigure
  terrain?: TerrainExercise
  terrainEvidence?: ReturnType<typeof terrainExerciseEvidence>
  subject: Subject
  prompt: string
  choices?: { id: string; text: string }[]
  reference?: string
  correctAnswer?: string
  rubric?: RubricItem[]
}
export interface AdvisorContext {
  selectedText: string
  source: AdvisorRequest['source']
  question: AdvisorQuestionContext
  knowledgeExcerpts?: Pick<
    KnowledgeEvidence,
    'chunkId' | 'documentTitle' | 'subject' | 'pageNumber' | 'text'
  >[]
}
export interface ModuleAdvisorContext {
  scope: ModuleReviewRequest['scope']
  question: AdvisorQuestionContext
  roots: ArgumentNode[]
  groups?: ModuleReviewRequest['groups']
  selectedSpans?: ModuleReviewRequest['selectedSpans']
}
export type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T
function freeze<T>(value: T): Immutable<T> {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value as Immutable<T>
}
function snapshot<T>(value: T): Immutable<T> {
  return freeze(structuredClone(value))
}
function advisorQuestion(question: Question, includeReference: boolean): AdvisorQuestionContext {
  return {
    subject: question.subject,
    prompt: question.prompt,
    ...(question.figure ? { figure: geographyFigureSchema.parse(question.figure) } : {}),
    ...(question.terrain ? { terrain: terrainExerciseSchema.parse(question.terrain) } : {}),
    ...(question.choices
      ? { choices: question.choices.map(({ id, text }) => ({ id, text })) }
      : {}),
    ...(includeReference
      ? {
          reference: question.explanation,
          ...(question.terrain
            ? { terrainEvidence: terrainExerciseEvidence(question.terrain) }
            : {}),
          ...(question.correctAnswer ? { correctAnswer: question.correctAnswer } : {}),
          ...(question.rubric
            ? {
                rubric: question.rubric.map(({ id, label, keywords, points }) => ({
                  id,
                  label,
                  keywords: [...keywords],
                  points,
                })),
              }
            : {}),
        }
      : {}),
  }
}
function nodes(roots: ArgumentNode[]): ArgumentNode[] {
  return roots.map(({ id, kind, text, children }) => ({
    id,
    kind,
    text,
    children: nodes(children),
  }))
}
export function buildAdvisorContext(
  question: Question,
  request: AdvisorRequest,
  evidence: KnowledgeEvidence[] = [],
): Immutable<AdvisorContext> {
  return snapshot({
    selectedText: request.selectedText,
    source: request.source,
    question: advisorQuestion(question, request.includeReference),
    ...(evidence.length
      ? {
          knowledgeExcerpts: evidence.map(
            ({ chunkId, documentTitle, subject, pageNumber, text }) => ({
              chunkId,
              documentTitle,
              subject,
              pageNumber,
              text,
            }),
          ),
        }
      : {}),
  })
}
export function buildModuleAdvisorContext(
  question: Question,
  request: ModuleReviewRequest,
): Immutable<ModuleAdvisorContext> {
  return snapshot({
    scope: request.scope,
    question: advisorQuestion(question, request.includeReference),
    roots: nodes(request.roots),
    ...(request.groups
      ? {
          groups: request.groups.map(({ id, label, memberIds, partial }) => ({
            id,
            label,
            memberIds: [...memberIds],
            partial,
          })),
        }
      : {}),
    ...(request.selectedSpans
      ? {
          selectedSpans: request.selectedSpans.map(({ moduleId, start, end, expectedText }) => ({
            moduleId,
            start,
            end,
            expectedText,
          })),
        }
      : {}),
  })
}
/** Immutable submission only: no Advisor messages, hints, revisions, canvas, or prior grades. */
export function buildGradingContext(question: Question, draft: AnswerDraft, syllabus?: string) {
  return snapshot({
    question: {
      kind: question.kind,
      subject: question.subject,
      title: question.title,
      prompt: question.prompt,
      ...(question.figure ? { figure: geographyFigureSchema.parse(question.figure) } : {}),
      ...(question.terrain
        ? {
            terrain: terrainExerciseSchema.parse(question.terrain),
            terrainEvidence: terrainExerciseEvidence(question.terrain),
          }
        : {}),
      source: question.source,
      tags: [...question.tags],
      reference: question.explanation,
      choices: question.choices?.map(({ id, text }) => ({ id, text })),
      correctAnswer: question.correctAnswer,
      rubric:
        question.kind === 'choice'
          ? []
          : question.rubric?.map(({ id, label, keywords, points }) => ({
              id,
              label,
              keywords: [...keywords],
              points,
            })),
    },
    answer: {
      choiceId: draft.choiceId,
      text: draft.text,
      ...(draft.argument
        ? {
            argument: {
              version: draft.argument.version,
              roots: nodes(draft.argument.roots),
              ...(draft.argument.groups
                ? {
                    groups: draft.argument.groups.map(({ id, label, memberIds }) => ({
                      id,
                      label,
                      memberIds: [...memberIds],
                    })),
                  }
                : {}),
            },
          }
        : { blocks: draft.blocks.map(({ category, label, text }) => ({ category, label, text })) }),
      drawing: {
        mode: draft.drawing.mode,
        points: draft.drawing.points.map(({ id, x, y, label }) => ({ id, x, y, label })),
        lines: draft.drawing.lines.map(({ id, from, to }) => ({ id, from, to })),
      },
      ...(question.subject === 'math' && draft.math
        ? {
            math: {
              expression: draft.math.expression,
              parameters: {
                a: draft.math.parameters.a,
                b: draft.math.parameters.b,
                c: draft.math.parameters.c,
              },
              measurement: [...draft.math.measurement],
              drawing: {
                mode: draft.math.drawing.mode,
                points: draft.math.drawing.points.map(({ id, x, y, label }) => ({
                  id,
                  x,
                  y,
                  label,
                })),
                lines: draft.math.drawing.lines.map(({ id, from, to }) => ({ id, from, to })),
              },
            },
          }
        : {}),
    },
    ...(syllabus ? { syllabus } : {}),
  })
}
export type GradingContext = ReturnType<typeof buildGradingContext>
