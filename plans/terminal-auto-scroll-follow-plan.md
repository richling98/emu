# Terminal Auto-Scroll Follow Plan

## Goal

Make Emu behave like a normal terminal while output is actively arriving:

- If the user is already at the bottom, new output keeps the terminal pinned to the bottom.
- The scrollbar follows the newest output automatically.
- The latest output is visible without manually scrolling.
- If the user intentionally scrolls up to inspect previous output, Emu should not yank them back down until they click the existing scroll-to-bottom button or otherwise return to the bottom.

## Current Behavior

The relevant implementation is in `src/renderer/src/components/TerminalPane.tsx`.

Important existing pieces:

- The terminal is xterm.js.
- The viewport DOM element is `.xterm-viewport`.
- Emu already tracks whether the viewport is near the bottom with `setIsAtBottom(...)`.
- Emu already has a manual scroll-to-bottom button.
- PTY output is written through `terminal.write(data, callback)`.
- Hidden/inactive output is buffered and replayed when the tab becomes visible.

Likely issue:

- xterm.js is not always keeping the DOM viewport pinned after `terminal.write(...)`, especially with Emu's custom viewport scroll handling and hidden-output replay path.
- The code tracks `isAtBottom`, but it does not consistently use that state to force a bottom snap after output is rendered.
- Because `terminal.write(...)` is async, scrolling before xterm finishes processing the chunk can be too early.

## Desired Semantics

Use normal terminal auto-follow semantics:

1. When the user is at bottom and new output arrives, stay at bottom.
2. When the user has scrolled up, preserve their scroll position.
3. When the user clicks the existing scroll-to-bottom button, re-enable auto-follow because they are back at bottom.
4. When hidden output is replayed after returning to a tab, show the newest output at bottom if the tab was in follow mode.
5. Do not auto-scroll alternate-screen TUIs in a way that fights their own screen handling.

## Implementation Plan

1. Add viewport helpers in `TerminalPane.tsx`:
   - `getViewportElement()`
   - `distanceFromBottom(viewport)`
   - `isViewportAtBottom(viewport)`
   - `snapTerminalToBottom()`

2. Track auto-follow intent in refs:
   - `shouldAutoFollowOutputRef`
   - `autoFollowFrameRef`
   - `autoFollowOutputRenderUntilRef`

3. Snap after visible PTY writes:
   - Capture whether auto-follow was enabled before the write.
   - In the write callback, call `snapTerminalToBottom()` when follow mode is still enabled.
   - Schedule one frame-later snap so the scrollbar lands exactly at the new bottom.

4. Snap during hidden-output replay:
   - If replay emits output while follow mode is enabled, schedule a bottom snap.
   - When replay finishes, schedule one final snap.

5. Make the existing bottom-arrow button re-enable follow mode:
   - Set `shouldAutoFollowOutputRef.current = true` before the animation starts.
   - Finish with the shared `snapTerminalToBottom()` helper.

6. Preserve manual scrollback:
   - Update follow mode from the native `.xterm-viewport` scroll listener.
   - Disable follow mode when the user scrolls upward.
   - Ignore transient non-bottom scroll events while xterm is rendering output.

7. Avoid fighting alternate-screen apps:
   - `snapTerminalToBottom()` should no-op when `terminal.buffer.active.type === 'alternate'`.

## Verification Plan

Automated checks:

- `npm exec tsc -- --noEmit`
- `npm run build`
- `git diff --check`

Manual tests:

1. Run:
   - `for i in {1..200}; do echo "line $i"; sleep 0.03; done`
   - Expected: scrollbar tracks to the bottom continuously.
2. While that command is still running, scroll upward.
   - Expected: Emu stops auto-following and preserves the user's scrollback position.
3. Click the existing bottom-arrow button.
   - Expected: Emu jumps or smooth-scrolls to the bottom and resumes following new output.
4. Run:
   - `yes "emu scroll test" | head -n 5000`
   - Expected: terminal ends at the latest output without needing manual scroll.
5. Switch away from a tab while output is running, then return.
   - Expected: hidden replay lands at bottom if the tab was in follow mode.
6. Open an alternate-screen app such as `less` or an editor.
   - Expected: normal TUI navigation is not broken by auto-follow.

## Files Expected To Change

- `src/renderer/src/components/TerminalPane.tsx`
- `plans/terminal-auto-scroll-follow-plan.md`
