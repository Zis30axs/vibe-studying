import type { AnswerDraft, StudentQuestion } from '../shared/types'
import { subjectLabel } from '../shared/subjects'

export type WorkspaceView =
  | 'practice'
  | 'math'
  | 'challenge'
  | 'politics'
  | 'geography'
  | 'formulas'
  | 'agent'
  | 'history'
  | 'adapters'
export const workspaceNavigation: {
  id: WorkspaceView
  icon: string
  label: string
  caption: string
}[] = [
  { id: 'practice', icon: '▤', label: '题目练习', caption: 'Practice' },
  { id: 'math', icon: 'ƒ', label: '数学工作台', caption: 'Math lab' },
  { id: 'challenge', icon: '◈', label: '数学挑战', caption: 'Comprehensive paper' },
  { id: 'politics', icon: '▦', label: '文科组装', caption: 'Argument builder' },
  { id: 'geography', icon: '◎', label: '地理工作台', caption: 'Geo canvas' },
  { id: 'formulas', icon: '∑', label: '公式速查', caption: 'Formula reference' },
  { id: 'agent', icon: '✧', label: 'Agent 工作台', caption: 'Bounded tools' },
  { id: 'history', icon: '◷', label: '练习记录', caption: 'Review & reflect' },
  { id: 'adapters', icon: '⌘', label: '题库与 Agent', caption: 'Connections' },
]
export const WORKSPACE_UI_KEY = 'examcraft.workspace-ui.v1'
export interface WorkspaceUiPreferences {
  version: 1
  lastQuestionId: string
  motion: 'system' | 'reduce'
}
/** Non-sensitive display preferences only. Never persist answers, provider settings or knowledge. */
export function parseWorkspaceUi(raw: string | null): WorkspaceUiPreferences {
  const fallback: WorkspaceUiPreferences = { version: 1, lastQuestionId: '', motion: 'system' }
  try {
    const value: unknown = JSON.parse(raw || 'null')
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1)
      return fallback
    const data = value as Record<string, unknown>
    return {
      version: 1,
      lastQuestionId:
        typeof data.lastQuestionId === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(data.lastQuestionId) &&
        !['constructor', 'prototype', '__proto__'].includes(data.lastQuestionId)
          ? data.lastQuestionId
          : '',
      motion: data.motion === 'reduce' ? 'reduce' : 'system',
    }
  } catch {
    return fallback
  }
}
/** Only user-authored work counts; an initialized empty math state must not mark the question as attempted. */
export function hasWorkspaceDraft(draft: AnswerDraft | undefined): boolean {
  return Boolean(
    draft &&
    (draft.text.trim() ||
      draft.choiceId ||
      draft.blocks.some((b) => b.text.trim()) ||
      draft.argument?.roots.length ||
      draft.drawing.points.length ||
      draft.math?.drawing.points.length ||
      draft.math?.geoboard?.points.length ||
      draft.math?.geoboard?.objects.length ||
      draft.math?.geometry?.points.length ||
      (draft.math?.expression.trim() && draft.math.expression !== 'a*x^2+b*x+c')),
  )
}
export interface WorkspaceCommand {
  id: string
  kind: 'view' | 'question' | 'motion'
  target: string
  title: string
  detail: string
  icon: string
}
/** Student-facing fields only. A result must not expose private reference answers or rubric data. */
export function findWorkspaceCommands(
  questions: readonly StudentQuestion[],
  query: string,
  motion: WorkspaceUiPreferences['motion'],
): WorkspaceCommand[] {
  const terms = query.normalize('NFKC').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const matches = (content: string) =>
    terms.every((t) => content.normalize('NFKC').toLocaleLowerCase().includes(t))
  const pageCommands: WorkspaceCommand[] = workspaceNavigation.map((page) => ({
    id: `view-${page.id}`,
    kind: 'view',
    target: page.id,
    title: page.label,
    detail:
      page.id === 'adapters'
        ? '模型 API · 外观 · 设置 · 连接'
        : page.id === 'math'
          ? 'Math lab · 几何 · 钉板 · 函数'
          : page.caption,
    icon: page.icon,
  }))
  const motionCommand: WorkspaceCommand = {
    id: 'motion',
    kind: 'motion',
    target: '',
    title: motion === 'reduce' ? '恢复界面动画' : '减少界面动画',
    detail: '遵循系统减少动态效果',
    icon: '◌',
  }
  const found = [...pageCommands, motionCommand].filter((entry) =>
    matches(`${entry.title} ${entry.detail}`),
  )
  for (const question of questions) {
    if (found.length >= 30) break
    if (
      matches(
        `${question.title} ${subjectLabel[question.subject]} ${question.tags.join(' ')} ${question.id}`,
      )
    ) {
      found.push({
        id: `question-${question.id}`,
        kind: 'question',
        target: question.id,
        title: question.title,
        detail: `${subjectLabel[question.subject]} · ${question.tags.slice(0, 3).join(' / ')} · ${question.id}`,
        icon: '▤',
      })
    }
  }
  return found.slice(0, 30)
}
