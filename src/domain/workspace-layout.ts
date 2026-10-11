/** Non-secret display preferences only. Responsive fitting never overwrites saved widths. */
export const LAYOUT_STORAGE_KEY = 'examcraft.workspace-layout.v1'
export const PANEL_LIMITS = {
  navigation: { min: 168, max: 280, default: 196 },
  questions: { min: 190, max: 380, default: 224 },
  tools: { min: 340, max: 960, default: 440 },
} as const
export type LayoutPanel = keyof typeof PANEL_LIMITS
export type DrawerPanel = Exclude<LayoutPanel, 'navigation'>
export interface WorkspaceLayoutPreferences {
  version: 1
  widths: Record<LayoutPanel, number>
  collapsed: Record<LayoutPanel, boolean>
}
export const NAV_RAIL_WIDTH = 60
export const DIVIDER_WIDTH = 8
export const ANSWER_MIN_WIDTH = 420
export const defaultWorkspaceLayout = (): WorkspaceLayoutPreferences => ({
  version: 1,
  widths: { navigation: 196, questions: 224, tools: 440 },
  collapsed: { navigation: true, questions: false, tools: false },
})
export function clampPanelWidth(panel: LayoutPanel, value: number): number {
  const limits = PANEL_LIMITS[panel]
  return Number.isFinite(value)
    ? Math.round(Math.min(limits.max, Math.max(limits.min, value)))
    : limits.default
}
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
export function parseWorkspaceLayout(serialized: string | null): WorkspaceLayoutPreferences {
  const defaults = defaultWorkspaceLayout()
  if (!serialized) return defaults
  try {
    const raw = record(JSON.parse(serialized))
    // Unknown future/legacy shapes safely reset rather than trusting arbitrary fields.
    if (!raw || raw.version !== 1) return defaults
    const widths = record(raw.widths)
    const collapsed = record(raw.collapsed)
    for (const panel of Object.keys(PANEL_LIMITS) as LayoutPanel[]) {
      if (typeof widths?.[panel] === 'number')
        defaults.widths[panel] = clampPanelWidth(panel, widths[panel])
      if (typeof collapsed?.[panel] === 'boolean') defaults.collapsed[panel] = collapsed[panel]
    }
    return defaults
  } catch {
    return defaults
  }
}
export function serializeWorkspaceLayout(preferences: WorkspaceLayoutPreferences): string {
  // Use the parser as an allowlist: never copy extra properties into localStorage.
  return JSON.stringify(parseWorkspaceLayout(JSON.stringify(preferences)))
}
export interface WorkspaceLayoutGeometry {
  navigationWidth: number
  navigationCollapsed: boolean
  questionsWidth: number
  toolsWidth: number
  questionsOverlay: boolean
  toolsOverlay: boolean
  answerWidth: number
}
export function fitWorkspaceLayout(
  preferences: WorkspaceLayoutPreferences,
  viewportWidth: number,
): WorkspaceLayoutGeometry {
  const viewport = Number.isFinite(viewportWidth) ? Math.max(280, viewportWidth) : 1440
  const navigationCollapsed = preferences.collapsed.navigation || viewport < 1250
  const sideMinimums =
    (!preferences.collapsed.questions ? PANEL_LIMITS.questions.min + DIVIDER_WIDTH : 0) +
    (!preferences.collapsed.tools ? PANEL_LIMITS.tools.min + DIVIDER_WIDTH : 0)
  const navigationWidth = navigationCollapsed
    ? NAV_RAIL_WIDTH
    : Math.min(
        preferences.widths.navigation,
        viewport - DIVIDER_WIDTH - 24 - ANSWER_MIN_WIDTH - sideMinimums,
      )
  // Keep controls reachable on small windows; tools become an explicit drawer first.
  const toolsOverlay = viewport < 1120
  const questionsOverlay = viewport < 760
  const available = Math.max(0, viewport - navigationWidth - DIVIDER_WIDTH - 24)
  let questionsWidth =
    preferences.collapsed.questions || questionsOverlay ? 0 : preferences.widths.questions
  let toolsWidth = preferences.collapsed.tools || toolsOverlay ? 0 : preferences.widths.tools
  const dividerSpace = (questionsWidth ? DIVIDER_WIDTH : 0) + (toolsWidth ? DIVIDER_WIDTH : 0)
  let overflow = Math.max(
    0,
    ANSWER_MIN_WIDTH + questionsWidth + toolsWidth + dividerSpace - available,
  )
  // Preserve the primary answer width; shrink saved side widths only for this viewport.
  if (toolsWidth) {
    const shrink = Math.min(overflow, toolsWidth - PANEL_LIMITS.tools.min)
    toolsWidth -= shrink
    overflow -= shrink
  }
  if (questionsWidth) {
    const shrink = Math.min(overflow, questionsWidth - PANEL_LIMITS.questions.min)
    questionsWidth -= shrink
  }
  return {
    navigationWidth,
    navigationCollapsed,
    questionsWidth,
    toolsWidth,
    questionsOverlay,
    toolsOverlay,
    answerWidth: Math.max(0, available - questionsWidth - toolsWidth - dividerSpace),
  }
}
/** Width changes use the visible boundary, not a temporarily larger saved desktop width. */
export function resizeWorkspacePanel(
  preferences: WorkspaceLayoutPreferences,
  panel: LayoutPanel,
  requestedWidth: number,
  viewportWidth: number,
): WorkspaceLayoutPreferences {
  const next = parseWorkspaceLayout(JSON.stringify(preferences))
  next.widths[panel] = clampPanelWidth(panel, requestedWidth)
  const geometry = fitWorkspaceLayout(next, viewportWidth)
  if (panel === 'navigation' && !geometry.navigationCollapsed)
    next.widths.navigation = geometry.navigationWidth
  if (panel === 'questions' && !geometry.questionsOverlay && !next.collapsed.questions)
    next.widths.questions = geometry.questionsWidth
  if (panel === 'tools' && !geometry.toolsOverlay && !next.collapsed.tools)
    next.widths.tools = geometry.toolsWidth
  return next
}
