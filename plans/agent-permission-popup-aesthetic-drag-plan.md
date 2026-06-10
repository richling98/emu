# Agent Permission Popup Aesthetic And Drag Plan

## Goal

Make the native macOS approval popup feel closer to a compact Apple-style notification while preserving the current behavior:

- Always-on-top native popup.
- Brief, correct permission preview.
- Approve and Deny buttons.
- Multiple pending permissions with arrow navigation.
- No duplicate Claude popups.
- No text clipping.
- User can drag the popup away from the top-right corner.

## Current State

The popup is implemented in `src/main/index.ts` as a frameless Electron `BrowserWindow` with inline HTML/CSS from `buildAgentPermissionOverlayHtml()`.

Important current details:

- Size is fixed at `500 x 230`.
- Position is recalculated by `positionAgentPermissionOverlay()` and snapped to the top-right of the display matching the Emu window.
- `movable: false` prevents native dragging.
- The layout uses relatively large padding, gaps, and two block text areas.
- Text areas use line clamps, which can visually cut off content.
- Arrow navigation and Approve/Deny actions are already implemented and should not be changed behaviorally.

## Design Direction

Use a compact notification shape:

- Target size: about `390 x 164` for the normal case.
- Border radius: `12px`, closer to macOS notification styling.
- Softer translucent material: dark, slightly less heavy, with subtle border and shadow.
- Tighter typography:
  - Title: 13px semibold.
  - Preview: 12.5px to 13px.
  - Secondary/meta text: 11.5px to 12px.
- Smaller controls:
  - Navigation buttons: around `22 x 22`.
  - Approve/Deny buttons: around `28px` high.
- Keep the visual hierarchy quiet: provider/title, short preview, small detail/meta line, actions.

## Text Visibility Strategy

The popup should be smaller without cutting off the useful text.

Implementation approach:

1. Keep the renderer-provided `summary` as the main visible permission text.
2. Show `detail` only when it adds useful context and can fit cleanly.
3. Replace hard `-webkit-line-clamp` clipping with a layout that reserves enough room for the complete short preview.
4. Shorten the sanitized visible strings in main if needed:
   - `summary`: keep concise, likely `120` chars instead of `180`.
   - `detail`: keep concise, likely `140` chars instead of `220`.
5. Prefer compact complete text over longer clipped text. For example:
   - Good: `Run: npm run dev`
   - Good: `Use skill: run`
   - Avoid: several lines of stale or raw terminal context.

If a rare permission summary is too long even after sanitization, use a single middle-truncation helper for command-like strings instead of letting the browser cut the bottom off. That keeps the beginning and end of paths/commands visible.

## Drag Behavior

Make the popup draggable while keeping buttons clickable.

Implementation approach:

1. Change the `BrowserWindow` option from:
   - `movable: false`
   to:
   - `movable: true`

2. Add CSS drag regions:
   - `.overlay` or `.drag-surface`: `-webkit-app-region: drag`
   - Buttons and interactive controls: `-webkit-app-region: no-drag`

3. Keep the native window frameless and always-on-top.

4. Ensure these remain clickable:
   - Approve
   - Deny
   - Previous permission
   - Next permission

## Position Persistence

Dragging should not be immediately undone by existing reposition calls.

Current issue to avoid:

- `positionAgentPermissionOverlay()` runs when the popup is shown and when active prompt changes.
- If left unchanged, it can snap the popup back to the top-right after the user drags it.

Implementation approach:

1. Track whether the user has manually moved the overlay during the current app run:
   - `agentPermissionOverlayUserMoved = false`

2. Register a window `moved` event after creating the overlay:
   - When the user moves it, set `agentPermissionOverlayUserMoved = true`.

3. Only call the default top-right positioning when:
   - The overlay is first created, or
   - The user has not moved it yet.

4. When navigating between multiple permissions, do not reposition if the user already dragged the popup.

5. When the popup closes because there are no pending permissions, keep the remembered manual position for the same app run. The next popup should appear where the user left it. This is more respectful than snapping back immediately.

6. Clamp the remembered bounds to the visible display work area before showing, so the popup cannot reopen off-screen after display changes.

## Multi-Permission Queue

The compact design must preserve queue behavior:

- If there is one permission, hide the arrow controls and queue count.
- If there are multiple permissions, show compact arrow controls and `1 of N`.
- Approving or denying the active permission removes it and displays the next pending permission in the same popup.
- Dragged position must remain stable when moving between queued permissions.

## Implementation Steps

1. Update overlay constants in `src/main/index.ts`:
   - Reduce width from `500` to roughly `390`.
   - Reduce height from `230` to roughly `164` or the smallest height that passes visual testing.

2. Update `BrowserWindow` creation:
   - Set `movable: true`.
   - Keep `frame: false`, `alwaysOnTop: true`, `skipTaskbar: true`, `transparent: true`, `focusable: true`.

3. Add moved-position tracking:
   - Add a boolean for whether the user moved the overlay.
   - Add optional remembered bounds.
   - Update `positionAgentPermissionOverlay()` to respect remembered/manual position.
   - Clamp remembered position to the current display work area before showing.

4. Restyle the inline overlay HTML/CSS:
   - Smaller padding and gaps.
   - More notification-like radius, shadow, material, and typography.
   - CSS drag/no-drag regions.
   - Compact queue controls.
   - Compact approve/deny buttons.

5. Adjust visible text limits:
   - Reduce sanitized `summary` and `detail` lengths if needed.
   - Avoid bottom clipping.
   - Preserve full visibility of the short permission preview.

6. Keep existing IPC behavior unchanged:
   - `agent-permission:show`
   - `agent-permission:overlayAction`
   - `agent-permission:state`

## Verification Plan

Automated checks:

- `node scripts/verify-agent-permission-detector.mjs`
- `npm exec tsc -- --noEmit`
- `npm run build`
- `git diff --check`

Manual checks:

1. Trigger a Codex permission and confirm the popup is compact and readable.
2. Trigger a Claude permission and confirm the popup is compact and readable.
3. Drag the popup to another location and confirm it stays there.
4. Click Approve after dragging and confirm the terminal receives the approval.
5. Click Deny after dragging and confirm the terminal receives the denial.
6. Trigger two permissions close together and confirm:
   - The compact queue controls appear.
   - Arrow navigation works.
   - Approving/denying one permission advances to the next.
   - The dragged position does not reset.
7. Move or disconnect displays if practical and confirm the popup clamps back on-screen.

## Open Questions

1. Should the manually dragged position persist only for the current app run, or should Emu remember it across restarts?
2. Should double-clicking the popup reset it to the default top-right position?
3. Do you prefer the popup to stay dark like the current design, or should it follow macOS light/dark appearance?

Recommendation for first pass:

- Persist position only for the current app run.
- Do not add double-click reset yet.
- Keep the current dark translucent style, but make it lighter, smaller, and more polished.
