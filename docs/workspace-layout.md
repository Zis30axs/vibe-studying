# Workspace layout

ExamCraft uses four unequal, independently managed zones:

1. A compact navigation rail, expandable on wider windows.
2. A searchable question catalog.
3. The primary question/answer/review area, which receives remaining width.
4. Optional tools, Advisor, local knowledge library, and geography generation.

The catalog, answer, and tools scroll independently. Tools mount once in their own
pane; resizing or closing the pane does not move the canonical draft out of App.
The subject-specific editors keep transient input and selection on reopen. Hidden
editors are inactive, and hidden Advisor/module/generation/import flows cancel or
invalidate outstanding work so late responses cannot silently reopen a panel.
The floating selection action is portaled outside scroll/size-containment roots.

## Controls

- Drag a vertical divider to resize. Divider limits preserve at least 420 pixels
  for the answer when the viewport has enough room.
- Focus a divider with Tab, then use left/right arrows (10 pixels), Shift plus an
  arrow (40 pixels), Home/End, or Enter to reset its width. Double-click resets it.
- The catalog and tools toggle independently. Focus mode collapses both and uses
  the compact navigation rail. Reset layout restores the defaults.
- Below 1120 pixels, tools open as a dismissible drawer. Below 760 pixels, the
  catalog also becomes a drawer. Only one drawer opens at a time. Escape, its
  close button, or the backdrop dismisses it; keyboard focus returns to the opener.
- Responsive fitting does not overwrite saved desktop widths or collapse choices.

Only validated versioned numeric widths and Boolean collapse preferences are
saved in the renderer's local layout preference key. No keys, answers, prompts,
model profiles, or learning records are part of this value. Invalid JSON,
unsupported versions, unavailable local storage, and out-of-range widths fall back
safely. Model credential storage remains separate and unchanged.

Learning statistics and the activity heatmap appear only in practice history and
are always expanded there. Subject submission timelines use successful saved
Attempt records; see [submission history](submission-history.md).

## Verification

- Domain tests cover clamping, allowlisted persistence, malformed/future versions,
  viewport fitting, immutability, collapse state, and resize boundaries.
- Static-render tests cover accessible splitter semantics and frozen review data.
- Browser specs cover divider mouse/keyboard/reset, draft and tool identity across
  collapse, responsive drawers, focus, viewport recovery, and Advisor cancellation.
- Electron specs cover widths, collapse state, and drafts across application restart.

Browser and native interaction specs require a supported browser/Electron runtime;
collecting these specs does not establish that interactions passed.
