import { describe, expect, it } from 'vitest'
import {
  ANSWER_MIN_WIDTH,
  DIVIDER_WIDTH,
  LAYOUT_STORAGE_KEY,
  NAV_RAIL_WIDTH,
  PANEL_LIMITS,
  clampPanelWidth,
  defaultWorkspaceLayout,
  fitWorkspaceLayout,
  parseWorkspaceLayout,
  resizeWorkspacePanel,
  serializeWorkspaceLayout,
  type LayoutPanel,
  type WorkspaceLayoutPreferences,
} from '../src/domain/workspace-layout'

const panels = Object.keys(PANEL_LIMITS) as LayoutPanel[]

function expandedLayout(): WorkspaceLayoutPreferences {
  return {
    ...defaultWorkspaceLayout(),
    collapsed: { navigation: false, questions: false, tools: false },
  }
}

function largestLayout(): WorkspaceLayoutPreferences {
  return {
    ...expandedLayout(),
    widths: {
      navigation: PANEL_LIMITS.navigation.max,
      questions: PANEL_LIMITS.questions.max,
      tools: PANEL_LIMITS.tools.max,
    },
  }
}

describe('workspace layout persistence', () => {
  it('uses a versioned key and fresh, independent defaults', () => {
    expect(LAYOUT_STORAGE_KEY).toBe('examcraft.workspace-layout.v1')
    const first = defaultWorkspaceLayout()
    const second = defaultWorkspaceLayout()
    expect(first).toEqual({
      version: 1,
      widths: { navigation: 196, questions: 224, tools: 440 },
      collapsed: { navigation: true, questions: false, tools: false },
    })
    first.widths.questions = 300
    first.collapsed.navigation = false
    expect(second).toEqual(defaultWorkspaceLayout())
    expect(second.widths).not.toBe(first.widths)
    expect(second.collapsed).not.toBe(first.collapsed)
  })

  it.each(panels)('clamps and rounds %s widths within that panel’s limits', (panel) => {
    const { min, max, default: fallback } = PANEL_LIMITS[panel]
    expect(clampPanelWidth(panel, min - 1)).toBe(min)
    expect(clampPanelWidth(panel, -1000)).toBe(min)
    expect(clampPanelWidth(panel, max + 1)).toBe(max)
    expect(clampPanelWidth(panel, 1_000_000)).toBe(max)
    expect(clampPanelWidth(panel, min)).toBe(min)
    expect(clampPanelWidth(panel, max)).toBe(max)
    expect(clampPanelWidth(panel, min + 0.49)).toBe(min)
    expect(clampPanelWidth(panel, min + 0.5)).toBe(min + 1)
    for (const nonfinite of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])
      expect(clampPanelWidth(panel, nonfinite)).toBe(fallback)
  })

  it.each([null, '', ' ', '{', '{"version":1,', 'null', 'true', '42', '"layout"', '[]'])(
    'resets missing, malformed, or non-object data: %s',
    (serialized) => {
      expect(parseWorkspaceLayout(serialized)).toEqual(defaultWorkspaceLayout())
    },
  )

  it.each([undefined, null, 0, 2, -1, '1', true])(
    'rejects an unsupported or mistyped version: %s',
    (version) => {
      expect(
        parseWorkspaceLayout(
          JSON.stringify({
            version,
            widths: { navigation: 280, questions: 380, tools: 960 },
            collapsed: { navigation: false, questions: true, tools: true },
          }),
        ),
      ).toEqual(defaultWorkspaceLayout())
    },
  )

  it('restores valid fields independently and defaults missing or incorrectly typed fields', () => {
    expect(
      parseWorkspaceLayout(
        JSON.stringify({
          version: 1,
          widths: { navigation: '240', questions: 300.6, tools: null },
          collapsed: { navigation: false, questions: 'true', tools: 1 },
        }),
      ),
    ).toEqual({
      version: 1,
      widths: { navigation: 196, questions: 301, tools: 440 },
      collapsed: { navigation: false, questions: false, tools: false },
    })
    expect(parseWorkspaceLayout('{"version":1,"widths":{"tools":560}}')).toEqual({
      ...defaultWorkspaceLayout(),
      widths: { navigation: 196, questions: 224, tools: 560 },
    })
  })

  it.each([undefined, null, [], [200, 300, 400], true, 1200, 'saved'])(
    'ignores malformed widths/collapsed containers: %s',
    (value) => {
      expect(
        parseWorkspaceLayout(JSON.stringify({ version: 1, widths: value, collapsed: value })),
      ).toEqual(defaultWorkspaceLayout())
    },
  )

  it('clamps persisted widths and handles overflowed JSON numbers', () => {
    expect(
      parseWorkspaceLayout(
        '{"version":1,"widths":{"navigation":-1,"questions":9999,"tools":411.6}}',
      ).widths,
    ).toEqual({ navigation: 168, questions: 380, tools: 412 })
    expect(
      parseWorkspaceLayout(
        '{"version":1,"widths":{"navigation":1e999,"questions":-1e999,"tools":1e999}}',
      ).widths,
    ).toEqual(defaultWorkspaceLayout().widths)
  })

  it('serializes only allowlisted non-secret display preferences at every level', () => {
    const extra = {
      ...expandedLayout(),
      apiKey: 'fixture-secret-do-not-store',
      models: [{ token: 'fixture-token-do-not-store' }],
      questionText: 'fixture-private-question-do-not-store',
      widths: { navigation: 240, questions: 300, tools: 560, token: 'fixture-nested-secret' },
      collapsed: { navigation: false, questions: true, tools: false, password: 'fixture-password' },
    }
    const serialized = serializeWorkspaceLayout(extra)
    expect(JSON.parse(serialized)).toEqual({
      version: 1,
      widths: { navigation: 240, questions: 300, tools: 560 },
      collapsed: { navigation: false, questions: true, tools: false },
    })
    expect(serialized).not.toMatch(/fixture|apiKey|models|questionText|token|password/)
    expect(extra.apiKey).toBe('fixture-secret-do-not-store')
    expect(extra.widths.token).toBe('fixture-nested-secret')
  })

  it('ignores prototype-shaped and unknown keys without copying them to storage', () => {
    const serialized =
      '{"version":1,"__proto__":{"polluted":true},"constructor":{"secret":"fixture"},' +
      '"widths":{"navigation":240,"__proto__":{"secret":"fixture"},"unknown":99},' +
      '"collapsed":{"tools":true,"constructor":true}}'
    const restored = parseWorkspaceLayout(serialized)
    expect(restored).toEqual({
      version: 1,
      widths: { navigation: 240, questions: 224, tools: 440 },
      collapsed: { navigation: true, questions: false, tools: true },
    })
    expect(serializeWorkspaceLayout(restored)).not.toMatch(
      /__proto__|constructor|polluted|fixture|unknown/,
    )
    expect(Object.prototype).not.toHaveProperty('polluted')
  })

  it('round-trips every collapse combination and normalizes before serializing', () => {
    for (let flags = 0; flags < 8; flags++) {
      const preferences: WorkspaceLayoutPreferences = {
        version: 1,
        widths: { navigation: 233, questions: 301, tools: 700 },
        collapsed: {
          navigation: Boolean(flags & 1),
          questions: Boolean(flags & 2),
          tools: Boolean(flags & 4),
        },
      }
      expect(parseWorkspaceLayout(serializeWorkspaceLayout(preferences))).toEqual(preferences)
    }
    const invalidWidths = {
      ...expandedLayout(),
      widths: { navigation: -20, questions: Number.NaN, tools: 12_000 },
    }
    expect(JSON.parse(serializeWorkspaceLayout(invalidWidths)).widths).toEqual({
      navigation: 168,
      questions: 224,
      tools: 960,
    })
  })
})

describe('responsive workspace geometry', () => {
  it('retains saved widths in a wide workspace and accounts for every visible divider', () => {
    expect(fitWorkspaceLayout(defaultWorkspaceLayout(), 1440)).toEqual({
      navigationWidth: NAV_RAIL_WIDTH,
      navigationCollapsed: true,
      questionsWidth: 224,
      toolsWidth: 440,
      questionsOverlay: false,
      toolsOverlay: false,
      answerWidth: 668,
    })
    expect(fitWorkspaceLayout(largestLayout(), 2400)).toEqual({
      navigationWidth: 280,
      navigationCollapsed: false,
      questionsWidth: 380,
      toolsWidth: 960,
      questionsOverlay: false,
      toolsOverlay: false,
      answerWidth: 732,
    })
  })

  it.each([
    [759, true, true, true],
    [760, true, false, true],
    [1119, true, false, true],
    [1120, true, false, false],
    [1249, true, false, false],
    [1250, false, false, false],
  ] as const)(
    'applies navigation and drawer breakpoints at viewport %i',
    (viewport, navigationCollapsed, questionsOverlay, toolsOverlay) => {
      const geometry = fitWorkspaceLayout(expandedLayout(), viewport)
      expect(geometry.navigationCollapsed).toBe(navigationCollapsed)
      expect(geometry.questionsOverlay).toBe(questionsOverlay)
      expect(geometry.toolsOverlay).toBe(toolsOverlay)
      expect(geometry.navigationWidth).toBe(navigationCollapsed ? NAV_RAIL_WIDTH : 196)
      if (questionsOverlay) expect(geometry.questionsWidth).toBe(0)
      if (toolsOverlay) expect(geometry.toolsWidth).toBe(0)
    },
  )

  it('uses no column or separator space for collapsed side panels', () => {
    for (let flags = 0; flags < 8; flags++) {
      const preferences = expandedLayout()
      preferences.collapsed = {
        navigation: Boolean(flags & 1),
        questions: Boolean(flags & 2),
        tools: Boolean(flags & 4),
      }
      const geometry = fitWorkspaceLayout(preferences, 1600)
      const navigation = preferences.collapsed.navigation ? NAV_RAIL_WIDTH : 196
      const questions = preferences.collapsed.questions ? 0 : 224
      const tools = preferences.collapsed.tools ? 0 : 440
      const dividers = DIVIDER_WIDTH * (1 + Number(questions > 0) + Number(tools > 0))
      expect(geometry.navigationCollapsed).toBe(preferences.collapsed.navigation)
      expect(geometry.navigationWidth).toBe(navigation)
      expect(geometry.questionsWidth).toBe(questions)
      expect(geometry.toolsWidth).toBe(tools)
      expect(geometry.answerWidth).toBe(1600 - navigation - questions - tools - dividers - 24)
    }
  })

  it('shrinks the tools panel before the question list to preserve the answer minimum', () => {
    const preferences = largestLayout()
    preferences.widths.navigation = 196
    expect(fitWorkspaceLayout(preferences, 1400)).toMatchObject({
      questionsWidth: 380,
      toolsWidth: 356,
      answerWidth: ANSWER_MIN_WIDTH,
    })
    expect(fitWorkspaceLayout(preferences, 1300)).toMatchObject({
      questionsWidth: 296,
      toolsWidth: PANEL_LIMITS.tools.min,
      answerWidth: ANSWER_MIN_WIDTH,
    })
  })

  it('temporarily constrains expanded navigation when side minima need the remaining space', () => {
    const preferences = largestLayout()
    expect(fitWorkspaceLayout(preferences, 1250)).toMatchObject({
      navigationCollapsed: false,
      navigationWidth: 252,
      questionsWidth: PANEL_LIMITS.questions.min,
      toolsWidth: PANEL_LIMITS.tools.min,
      answerWidth: ANSWER_MIN_WIDTH,
    })
    expect(preferences.widths.navigation).toBe(280)
    expect(fitWorkspaceLayout(preferences, 1278)).toMatchObject({
      navigationWidth: 280,
      answerWidth: ANSWER_MIN_WIDTH,
    })
    preferences.collapsed.tools = true
    expect(fitWorkspaceLayout(preferences, 1250).navigationWidth).toBe(280)
  })

  it('protects the answer minimum across viewport changes, including expanded-navigation boundaries', () => {
    const preferences = largestLayout()
    // 512 pixels accommodates the answer, navigation rail, divider, and outer spacing.
    // Below that width the drawer layout must use the remaining available space instead.
    for (let viewport = 512; viewport <= 2400; viewport++) {
      const geometry = fitWorkspaceLayout(preferences, viewport)
      expect(geometry.answerWidth, `answer width at viewport ${viewport}`).toBeGreaterThanOrEqual(
        ANSWER_MIN_WIDTH,
      )
      if (geometry.questionsWidth)
        expect(geometry.questionsWidth).toBeGreaterThanOrEqual(PANEL_LIMITS.questions.min)
      if (geometry.toolsWidth)
        expect(geometry.toolsWidth).toBeGreaterThanOrEqual(PANEL_LIMITS.tools.min)
      const total =
        geometry.navigationWidth +
        geometry.questionsWidth +
        geometry.toolsWidth +
        geometry.answerWidth +
        DIVIDER_WIDTH *
          (1 + Number(geometry.questionsWidth > 0) + Number(geometry.toolsWidth > 0)) +
        24
      expect(total).toBe(viewport)
    }
  })

  it('fits narrow and invalid viewports without negative widths', () => {
    for (const viewport of [-1000, 0, 200, 280, 320, 375, 511]) {
      expect(fitWorkspaceLayout(largestLayout(), viewport)).toEqual({
        navigationWidth: NAV_RAIL_WIDTH,
        navigationCollapsed: true,
        questionsWidth: 0,
        toolsWidth: 0,
        questionsOverlay: true,
        toolsOverlay: true,
        answerWidth: Math.max(280, viewport) - NAV_RAIL_WIDTH - DIVIDER_WIDTH - 24,
      })
    }
    for (const viewport of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])
      expect(fitWorkspaceLayout(largestLayout(), viewport)).toEqual(
        fitWorkspaceLayout(largestLayout(), 1440),
      )
  })

  it('does not mutate saved widths or collapse flags while fitting or restoring a wider viewport', () => {
    const preferences = largestLayout()
    const before = serializeWorkspaceLayout(preferences)
    Object.freeze(preferences.widths)
    Object.freeze(preferences.collapsed)
    Object.freeze(preferences)
    for (const viewport of [2400, 1400, 1250, 1120, 760, 375, 2400])
      fitWorkspaceLayout(preferences, viewport)
    expect(serializeWorkspaceLayout(preferences)).toBe(before)
    expect(fitWorkspaceLayout(preferences, 2400)).toMatchObject({
      navigationWidth: 280,
      questionsWidth: 380,
      toolsWidth: 960,
      navigationCollapsed: false,
    })
  })
})

describe('workspace panel resizing', () => {
  it.each(panels)('constrains %s requests to panel boundaries at a wide viewport', (panel) => {
    const preferences = expandedLayout()
    const { min, max, default: fallback } = PANEL_LIMITS[panel]
    for (const [request, expected] of [
      [-1000, min],
      [min, min],
      [min + 0.5, min + 1],
      [max, max],
      [10_000, max],
      [Number.NaN, fallback],
      [Number.POSITIVE_INFINITY, fallback],
    ]) {
      const next = resizeWorkspacePanel(preferences, panel, request, 2400)
      expect(next.widths[panel]).toBe(expected)
      expect(next.collapsed).toEqual(preferences.collapsed)
      for (const other of panels.filter((candidate) => candidate !== panel))
        expect(next.widths[other]).toBe(preferences.widths[other])
    }
  })

  it('stores the visible question boundary while preserving the other saved desktop widths', () => {
    const preferences = largestLayout()
    preferences.widths.navigation = 196
    const next = resizeWorkspacePanel(preferences, 'questions', 500, 1300)
    expect(next.widths).toEqual({ navigation: 196, questions: 296, tools: 960 })
    expect(fitWorkspaceLayout(next, 1300)).toMatchObject({
      questionsWidth: 296,
      toolsWidth: 340,
      answerWidth: ANSWER_MIN_WIDTH,
    })
    expect(preferences.widths.questions).toBe(380)
  })

  it('stores the visible tools boundary instead of a larger constrained request', () => {
    const preferences = largestLayout()
    preferences.widths.navigation = 196
    const next = resizeWorkspacePanel(preferences, 'tools', 900, 1400)
    expect(next.widths).toEqual({ navigation: 196, questions: 380, tools: 356 })
    expect(fitWorkspaceLayout(next, 1400)).toMatchObject({
      toolsWidth: 356,
      answerWidth: ANSWER_MIN_WIDTH,
    })
    expect(preferences.widths.tools).toBe(960)
  })

  it('stores the visible navigation boundary without narrowing the saved side-panel widths', () => {
    const preferences = largestLayout()
    const next = resizeWorkspacePanel(preferences, 'navigation', 280, 1250)
    expect(next.widths).toEqual({ navigation: 252, questions: 380, tools: 960 })
    expect(fitWorkspaceLayout(next, 1250)).toMatchObject({
      navigationWidth: 252,
      answerWidth: ANSWER_MIN_WIDTH,
    })
    expect(preferences.widths.navigation).toBe(280)
    expect(next.collapsed).toEqual(preferences.collapsed)
  })

  it('retains a navigation width request while responsive fitting shows only the rail', () => {
    const preferences = expandedLayout()
    const next = resizeWorkspacePanel(preferences, 'navigation', 280, 1249)
    expect(next.widths.navigation).toBe(280)
    expect(next.collapsed.navigation).toBe(false)
    expect(fitWorkspaceLayout(next, 1249)).toMatchObject({
      navigationWidth: NAV_RAIL_WIDTH,
      navigationCollapsed: true,
    })
    expect(fitWorkspaceLayout(next, 2400)).toMatchObject({
      navigationWidth: 280,
      navigationCollapsed: false,
    })
  })

  it.each([
    ['questions', 700, 330],
    ['tools', 1000, 600],
  ] as const)(
    'retains a requested %s drawer width instead of persisting zero',
    (panel, viewport, width) => {
      const preferences = expandedLayout()
      const next = resizeWorkspacePanel(preferences, panel, width, viewport)
      expect(next.widths[panel]).toBe(width)
      expect(fitWorkspaceLayout(next, viewport)[`${panel}Width`]).toBe(0)
      expect(next.collapsed).toEqual(preferences.collapsed)
      expect(fitWorkspaceLayout(next, 2400)[`${panel}Width`]).toBe(width)
    },
  )

  it.each(panels)('preserves collapsed state when changing the saved %s width', (panel) => {
    const preferences = expandedLayout()
    preferences.collapsed[panel] = true
    const next = resizeWorkspacePanel(preferences, panel, PANEL_LIMITS[panel].max, 1440)
    expect(next.widths[panel]).toBe(PANEL_LIMITS[panel].max)
    expect(next.collapsed).toEqual(preferences.collapsed)
  })

  it('returns independent normalized preferences without mutating the input', () => {
    const preferences = largestLayout()
    const before = serializeWorkspaceLayout(preferences)
    Object.freeze(preferences.widths)
    Object.freeze(preferences.collapsed)
    Object.freeze(preferences)
    const next = resizeWorkspacePanel(preferences, 'navigation', 220, 2400)
    expect(next).not.toBe(preferences)
    expect(next.widths).not.toBe(preferences.widths)
    expect(next.collapsed).not.toBe(preferences.collapsed)
    expect(next.widths.navigation).toBe(220)
    expect(serializeWorkspaceLayout(preferences)).toBe(before)
    next.collapsed.tools = true
    expect(preferences.collapsed.tools).toBe(false)
  })
})
