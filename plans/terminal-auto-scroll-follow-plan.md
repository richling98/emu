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
- Emu already tracks whether the viewport is near the bottom:
  - `updateScrollState()`
  - `setIsAtBottom(distFromBottom < 10)`
- Emu already has a manual scroll-to-bottom button:
  - `handleScrollToBottom()`
  - `terminal.scrollToBottom()`
- PTY output is written through:
  - visible/active path: `terminal.write(data, callback)`
  - hidden/inactive path: hidden output buffering and replay
- Emu overrides wheel scrolling and mutates `viewportEl.scrollTop` directly for pixel-precise trackpad behavior.

Likely issue:

- xterm.js is not always keeping the DOM viewport pinned after `terminal.write(...)`, especially with Emu's custom viewport scroll handling and hidden-output replay path.
- The code tracks `isAtBottom`, but it does not consistently use that state to force a bottom snap after output is rendered.
- Because `terminal.write(...)` is async, scrolling before xterm finishes processing the chunk can be too early; the bottom must be enforced in the write callback or the next animation frame.

## Desired Semantics

Use normal terminal auto-follow semantics:

1. When the user is at bottom and new output arrives, stay at bottom.
2. When the user has scrolled up, preserve their scroll position.
3. When the user clicks the existing scroll-to-bottom button, re-enable auto-follow because they are back at bottom.
4. When hidden output is replayed after returning to a tab, show the newest output at bottom.
5. Do not auto-scroll alternate-screen TUIs in a way that fights their own screen handling.

## Implementation Plan

### 1. Add Bottom Detection Helpers

In `TerminalPane.tsx`, add small local helpers near the existing scroll functions:

- `getViewportElement()`
- `distanceFromBottom(viewport)`
- `isViewportAtBottom(viewport)`
- `snapTerminalToBottom()`

`snapTerminalToBottom()` should:

- Set `viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight`.
- Call `terminal.scrollToBottom()`.
- Update `isAtBottom` to `true`.

Keep the bottom tolerance around `10px` to preserve current sub-pixel rounding behavior.

### 2. Track Auto-Follow Intent In A Ref

React state (`isAtBottom`) can be stale inside high-frequency output callbacks, so add:

- `const shouldAutoFollowOutputRef = useRef(true)`

Update it inside the scroll listener:

- If the user is near bottom: `true`
- If the user scrolls away from bottom: `false`

Important nuance:

- Programmatic bottom snaps should set the ref to `true`.
- Manual wheel scrolls upward should quickly set it to `false` through the existing scroll listener.

### 3. Snap After Visible PTY Writes

In the visible output path around `terminal.write(data, callback)`:

1. Capture whether auto-follow was enabled before the write:
   - `const shouldAutoFollow = shouldAutoFollowOutputRef.current`
2. In the write callback, after detection work:
   - If `shouldAutoFollow` is true and the terminal is not in alternate screen, call `snapTerminalToBottom()`.
3. Also schedule one `requestAnimationFrame` snap:
   - xterm can update viewport dimensions after the write callback, so a frame-later snap makes the scrollbar land exactly at the new bottom.

This should be a direct, low-risk fix for the user's main issue.

### 4. Snap During Hidden Output Replay

In `replayHiddenOutput()`:

- If output is replayed while the tab becomes visible and auto-follow is enabled, snap after each replay frame.
- When replay finishes, snap one final time.

This avoids the case where the tab receives lots of hidden output, becomes visible, and the scrollbar remains above the actual bottom.

### 5. Make The Existing Button Re-Enable Follow Mode

Update `handleScrollToBottom()`:

- Set `shouldAutoFollowOutputRef.current = true` before the animation starts.
- At the end, call the shared `snapTerminalToBottom()` helper.
- Ensure `setIsAtBottom(true)` happens at the end.

This makes the button mean "follow latest output again", which matches user expectations.

### 6. Preserve Manual Scrollback

Do not blindly call `scrollToBottom()` on every output chunk.

The behavior should only auto-follow when one of these is true:

- The user was already at bottom before the output arrived.
- The user clicked the scroll-to-bottom button.
- Emu is replaying hidden output after showing the tab and the tab was already in follow mode.

If the user scrolls up while output is streaming, the next scroll event should disable follow mode and keep their view stable.

### 7. Avoid Fighting Alternate-Screen Apps

Guard auto-follow with:

- `terminal.buffer.active.type !== 'alternate'`

Alternate-screen apps such as editors, pagers, and agent TUIs manage their own screen. Emu should not force scrollback positioning there.

## Verification Plan

Automated checks:

- `npm exec tsc -- --noEmit`
- `npm run build`
- `git diff --check`

Manual tests:

1. Run a continuous output command:
   - `for i in {1..200}; do echo "line $i"; sleep 0.03; done`
   - Expected: scrollbar tracks to the bottom continuously.
2. While that command is still running, scroll upward.
   - Expected: Emu stops auto-following and preserves the user's scrollback position.
3. Click the existing bottom-arrow button.
   - Expected: Emu jumps/smooth-scrolls to the bottom and resumes following new output.
4. Run a fast output command:
   - `yes "emu scroll test" | head -n 5000`
   - Expected: terminal ends at the latest output without needing manual scroll.
5. Switch away from a tab while output is running, then return.
   - Expected: hidden replay lands at bottom if the tab was in follow mode.
6. Open an alternate-screen app such as `less` or an editor.
   - Expected: normal TUI navigation is not broken by auto-follow.

## Risks And Mitigations

- Risk: Calling `scrollToBottom()` too often could add work during heavy output.
  - Mitigation: snap only when follow mode is enabled, and schedule at most one frame-later snap per write callback.

- Risk: Manual scroll could be overridden while the user is trying to inspect old output.
  - Mitigation: use the ref-based follow mode and disable it whenever the viewport is no longer near bottom.

- Risk: Hidden output replay may scroll unexpectedly.
  - Mitigation: only auto-scroll replay when follow mode is enabled.

## Files Expected To Change

- `src/renderer/src/components/TerminalPane.tsx`

No CSS changes should be necessary unless verification reveals the xterm viewport dimensions are wrong.
