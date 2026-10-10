export const MAX_ADVISOR_SELECTION = 8000
export const MAX_ADVISOR_CONTEXT = 2000
export type AdvisorSource = 'question' | 'material' | 'answer' | 'argument'
export interface AdvisorSnapshot {
  text: string
  source: AdvisorSource
  x: number
  y: number
}

/** Never silently truncate the text that the user is consenting to share. */
export function selectedExcerpt(value: string, start: number | null, end: number | null): string {
  if (start === null || end === null || start === end) return ''
  return value.slice(Math.max(0, Math.min(start, end)), Math.max(start, end)).trim()
}
export function selectionProblem(text: string): string | null {
  if (!text.trim()) return '请先选择一段题目、材料或答案。'
  if (text.length > MAX_ADVISOR_SELECTION)
    return `选中文字过长，请缩小到 ${MAX_ADVISOR_SELECTION} 字以内。`
  return null
}
export function sourceFromElement(element: Element): AdvisorSource {
  const value = element.closest('[data-advisor-source]')?.getAttribute('data-advisor-source')
  return value === 'question' || value === 'material' || value === 'argument' ? value : 'answer'
}
export function captureAdvisorSelection(
  root: HTMLElement,
  target?: EventTarget | null,
): AdvisorSnapshot | null {
  const element = target instanceof Element ? target : document.activeElement
  if (element instanceof Element && element.closest('[data-advisor-exclude]')) return null
  if (element instanceof HTMLTextAreaElement && root.contains(element)) {
    const text = selectedExcerpt(element.value, element.selectionStart, element.selectionEnd)
    if (!text) return null
    const rect = element.getBoundingClientRect()
    return {
      text,
      source: sourceFromElement(element),
      x: rect.left + 16,
      y: rect.top + Math.min(rect.height, 70),
    }
  }
  const selection = window.getSelection()
  if (
    !selection ||
    selection.isCollapsed ||
    !selection.rangeCount ||
    !selection.anchorNode ||
    !selection.focusNode
  )
    return null
  if (!root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return null
  const range = selection.getRangeAt(0)
  const parent =
    range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement
  // Exclude controls, editable fields and any region explicitly opted out of sharing.
  if (!parent || parent.closest('[data-advisor-exclude],input,button,select')) return null
  const text = selection.toString().trim()
  if (!text) return null
  const rect = range.getBoundingClientRect()
  return { text, source: sourceFromElement(parent), x: rect.left, y: rect.bottom + 8 }
}
