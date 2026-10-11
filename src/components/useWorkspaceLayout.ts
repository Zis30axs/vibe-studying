import { useEffect, useRef, useState } from 'react'
import {
  defaultWorkspaceLayout,
  fitWorkspaceLayout,
  LAYOUT_STORAGE_KEY,
  parseWorkspaceLayout,
  PANEL_LIMITS,
  resizeWorkspacePanel,
  serializeWorkspaceLayout,
  type DrawerPanel,
  type LayoutPanel,
} from '../domain/workspace-layout'

export function useWorkspaceLayout() {
  const [preferences, setPreferences] = useState(() => {
    try {
      return parseWorkspaceLayout(window.localStorage.getItem(LAYOUT_STORAGE_KEY))
    } catch {
      return defaultWorkspaceLayout()
    }
  })
  const [viewport, setViewport] = useState(() => window.innerWidth)
  const [drawer, setDrawer] = useState<DrawerPanel | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  const geometry = fitWorkspaceLayout(preferences, viewport)
  useEffect(() => {
    const resize = () => {
      setViewport(window.innerWidth)
      setDrawer(null)
    }
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  useEffect(() => {
    try {
      window.localStorage.setItem(LAYOUT_STORAGE_KEY, serializeWorkspaceLayout(preferences))
    } catch {
      /* Local layout storage is optional; unavailable storage never blocks practice. */
    }
  }, [preferences])
  function closeDrawer() {
    setDrawer(null)
    if (opener.current?.isConnected) opener.current.focus()
  }
  useEffect(() => {
    if (!drawer) return
    const panel = document.getElementById(drawer === 'tools' ? 'tools-panel' : 'question-panel')
    const focusable = () =>
      [
        ...(panel?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, a[href], [tabindex="0"]',
        ) ?? []),
      ].filter((node) => node.getClientRects().length > 0)
    focusable()[0]?.focus()
    const keyboard = (event: KeyboardEvent) => {
      // Nested Advisor/import dialogs own their keyboard actions first.
      if (
        event.defaultPrevented ||
        document.querySelector('[role="dialog"]:not(.workspace-drawer)')
      )
        return
      if (event.key === 'Escape') {
        event.preventDefault()
        closeDrawer()
      }
      if (event.key === 'Tab') {
        const controls = focusable()
        const first = controls[0]
        const last = controls.at(-1)
        if (
          event.shiftKey &&
          (document.activeElement === first || !panel?.contains(document.activeElement))
        ) {
          event.preventDefault()
          last?.focus()
        } else if (
          !event.shiftKey &&
          (document.activeElement === last || !panel?.contains(document.activeElement))
        ) {
          event.preventDefault()
          first?.focus()
        }
      }
    }
    document.addEventListener('keydown', keyboard)
    return () => document.removeEventListener('keydown', keyboard)
  }, [drawer])
  function toggle(panel: LayoutPanel) {
    const overlay =
      panel === 'questions'
        ? geometry.questionsOverlay
        : panel === 'tools'
          ? geometry.toolsOverlay
          : false
    if (overlay && panel !== 'navigation') {
      if (drawer === panel) closeDrawer()
      else {
        opener.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null
        setDrawer(panel)
      }
    } else
      setPreferences((previous) => ({
        ...previous,
        collapsed: { ...previous.collapsed, [panel]: !previous.collapsed[panel] },
      }))
  }
  const questionsVisible = geometry.questionsOverlay
    ? drawer === 'questions'
    : !preferences.collapsed.questions
  const toolsVisible = geometry.toolsOverlay ? drawer === 'tools' : !preferences.collapsed.tools
  useEffect(() => {
    for (const [id, visible] of [
      ['question-panel', questionsVisible],
      ['tools-panel', toolsVisible],
    ] as const) {
      if (!visible && document.getElementById(id)?.contains(document.activeElement))
        document
          .querySelector<HTMLButtonElement>(`.workspace-panel-toggles [aria-controls="${id}"]`)
          ?.focus()
    }
  }, [questionsVisible, toolsVisible])
  return {
    preferences,
    geometry,
    drawer,
    questionsVisible,
    toolsVisible,
    viewport,
    toggle,
    closeDrawer,
    closeDrawers: () => setDrawer(null),
    resize: (panel: LayoutPanel, width: number) =>
      setPreferences((previous) => resizeWorkspacePanel(previous, panel, width, viewport)),
    resetPanel: (panel: LayoutPanel) =>
      setPreferences((previous) => ({
        ...previous,
        widths: { ...previous.widths, [panel]: PANEL_LIMITS[panel].default },
      })),
    reset: () => {
      setPreferences(defaultWorkspaceLayout())
      setDrawer(null)
    },
    focusAnswer: () => {
      setPreferences((previous) => ({
        ...previous,
        collapsed: { navigation: true, questions: true, tools: true },
      }))
      setDrawer(null)
    },
  }
}
