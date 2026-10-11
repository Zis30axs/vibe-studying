import type { StudentQuestion, Subject } from '../shared/types'

export type StudyView = 'practice' | 'math' | 'politics' | 'geography'

export interface StudyQuestionContext {
  view: StudyView
  subject: Subject | 'all'
  query: string
  selectedId: string
}

/** Commit only an actually visible selection; auxiliary routes never invent one. */
export function navigateStudyQuestionContext(
  context: StudyQuestionContext,
  next: string,
  visibleSelection?: { id: string },
): StudyQuestionContext {
  const selection = visibleSelection ? { selectedId: visibleSelection.id } : {}
  return isStudyView(next) && next !== context.view
    ? { view: next, subject: 'all', query: '', selectedId: context.selectedId, ...selection }
    : { ...context, ...selection }
}

export function isStudyView(view: string): view is StudyView {
  return ['practice', 'math', 'politics', 'geography'].includes(view)
}

/** Auxiliary pages retain the last visible study scope, including an empty result. */
export function filterStudyQuestions(
  questions: StudentQuestion[],
  view: StudyView,
  subject: Subject | 'all',
  query: string,
): StudentQuestion[] {
  return questions.filter((question) => {
    if (view === 'math' && question.subject !== 'math') return false
    if (
      view === 'politics' &&
      !['politics', 'history', 'chinese', 'geography'].includes(question.kind)
    )
      return false
    if (view === 'geography' && question.kind !== 'geography') return false
    if (subject !== 'all' && question.subject !== subject) return false
    return `${question.title} ${question.tags.join(' ')} ${question.source}`
      .toLowerCase()
      .includes(query.toLowerCase())
  })
}
