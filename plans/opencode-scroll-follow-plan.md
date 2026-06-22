# Opencode Scroll + Jump-To-Bottom Fix Plan

## Goal

Make Emu behave predictably when `opencode` runs in its full-screen terminal interface:

- Trackpad scrolling should not fly through the opencode view.
- When the user scrolls up during an active opencode session, the jump-to-bottom chevron should appear.
- Clicking the chevron should return the user to the live bottom of the opencode session.
- Normal shell scrolling, `less`, `vim`, Claude, and Codex should keep their current behavior unless this plan explicitly says otherwise.

## Plain-English Problem

Opencode uses a full-screen terminal mode called the alternate screen.

In normal terminal output, Emu can inspect the real xterm scrollback. If the user scrolls upward, the actual viewport moves, Emu sees that it is no longer at the bottom, and the jump-to-bottom chevron appears.

In opencode, Emu must treat the wheel as literal terminal scrollback movement. The broken path translated trackpad wheel events into keyboard arrows sent into opencode, so opencode treated scrolling like pressing Up/Down and moved through prompt history instead of moving the viewport.

The fast-scroll bug has the same root: every tiny trackpad event can turn into terminal navigation commands. macOS sends many wheel events during one gesture, so opencode receives too many movement commands.

## Current State

Relevant code is in `src/renderer/src/components/TerminalPane.tsx`.

- `isAltScreenRef` tracks whether xterm is in alternate-screen mode.
- `agentProviderRef` can now be `opencode`.
- `handleWheel()` intercepts wheel events.
- In normal mode, `handleWheel()` changes `.xterm-viewport.scrollTop`.
- In alternate-screen mode, `handleWheel()` writes arrow key escape sequences into the PTY.
- `updateScrollState()` only watches the real `.xterm-viewport` scroll position.
- `isAtBottom` controls the jump-to-bottom chevron.

This means opencode has two scroll states:

1. The real xterm viewport state, which Emu already understands.
2. Opencode's stdin, which must not receive wheel-generated arrow keys.

## Root Cause

The current code treats all alternate-screen apps roughly the same.

That is too blunt for opencode because:

- Opencode is an agent chat UI, not a traditional pager/editor.
- User wheel gestures were forwarded to opencode as keyboard arrows.
- Emu clears `shouldAutoFollowOutputRef` on upward wheel input, but `isAtBottom` may remain `true` because the DOM viewport did not move.
- The chevron is tied to `isAtBottom`, so it stays hidden.
- The wheel-to-arrow conversion is wrong for opencode because arrows are prompt navigation, not scroll.

## Desired Model

Add a tiny explicit scroll-follow state for alternate-screen agent UIs.

Emu should distinguish:

- **Live-following**: user wants to stay at the newest output.
- **User reviewing history**: user scrolled upward inside opencode, so show the chevron.

For normal scrollback, keep using `.xterm-viewport`.

For opencode alternate-screen mode, derive this state from literal viewport scrolling and wheel intent:

- Wheel up while opencode is active means "user is reviewing history."
- Reaching viewport bottom, or clicking the chevron, means "return to live-following."
- New output should not hide the chevron while the user is reviewing history.

Do not send `\x1b[A`, `\x1b[B`, PageUp, PageDown, or similar PTY input for opencode wheel scrolling.

## Implementation Plan

## Progress

Overall: 100%

- ✅ Step 1: Add a dedicated alt-agent scroll state.
- ✅ Step 2: Make the chevron visible for opencode review mode.
- ✅ Step 3: Track user intent in `handleWheel()`.
- ✅ Step 4: Remove opencode wheel-to-PTY translation.
- ✅ Step 5: Make the chevron button return opencode to live bottom.
- ✅ Step 6: Reset state on mode changes.
- ✅ Step 7: Keep auto-follow from fighting the user.
- ✅ Step 8: Remove temporary debug plumbing before shipping.
- ✅ Validation: Run detector fixtures and build.

### 1. Add a Dedicated Alt-Agent Scroll State

In `TerminalPane.tsx`, add small refs/state:

```ts
const [isAltAgentReviewingHistory, setIsAltAgentReviewingHistory] = useState(false)
const isAltAgentReviewingHistoryRef = useRef(false)
const altAgentScrollLinesFromBottomRef = useRef(0)
```

Use a helper:

```ts
const isOpencodeAltScreen = () =>
  terminalRef.current?.buffer.active.type === 'alternate' &&
  agentProviderRef.current === 'opencode'
```

Keep this narrow. Do not create a generic scroll manager.

### 2. Make the Chevron Visible for Opencode Review Mode

Change the chevron visibility from only:

```ts
!isAtBottom
```

to:

```ts
!isAtBottom || isAltAgentReviewingHistory
```

Use the existing button and existing `handleScrollToBottom()`.

The only new behavior is that opencode can show the same button even when the DOM viewport did not move.

### 3. Track User Intent in `handleWheel()`

Inside the alternate-screen branch:

- If provider is not `opencode`, keep current behavior for now.
- If provider is `opencode` and wheel direction is up:
  - Set `shouldAutoFollowOutputRef.current = false`.
  - Set `isAtBottomRef.current = false`.
  - Set `isAltAgentReviewingHistoryRef.current = true`.
  - Call `setIsAltAgentReviewingHistory(true)`.
  - Call `setIsAtBottom(false)` so existing chevron logic wakes up.
- Move `.xterm-viewport.scrollTop` by the wheel delta.

On wheel down:

- Move `.xterm-viewport.scrollTop` by the wheel delta.
- If the viewport reaches bottom, set alt-agent reviewing mode back to false and allow follow again.

This does not need to be perfect. It only needs to reflect user intent well enough to show or hide the chevron.

### 4. Remove Opencode Wheel-To-PTY Translation

For opencode alternate-screen mode:

- Do not call `window.api.ptyWrite()` from wheel handling.
- Do not send arrow keys, PageUp, PageDown, Ctrl+B, or Ctrl+F.
- Apply the native wheel delta to `.xterm-viewport.scrollTop`, same as normal shell scrollback.

Reason:

- Opencode treats arrow keys as prompt/input navigation.
- Wheel input should only move Emu's visual viewport.

### 5. Make the Chevron Button Return Opencode to Live Bottom

Update `handleScrollToBottom()`:

- If `isOpencodeAltScreen()`:
  - Cancel any scroll animation.
  - Set `.xterm-viewport.scrollTop` to the bottom.
  - Set `isAltAgentReviewingHistory` false.
  - Set `isAtBottom` true.
  - Set `shouldAutoFollowOutputRef.current = true`.
  - Return early.

### 6. Reset State on Mode Changes

When entering alternate screen:

- Reset `altAgentScrollLinesFromBottomRef` to `0`.
- Set `isAltAgentReviewingHistory` false.

When exiting alternate screen:

- Reset the same state.
- Let normal scrollback behavior take over again.

When the foreground process changes away from opencode:

- Reset the same state.

### 7. Keep Auto-Follow From Fighting the User

When `isAltAgentReviewingHistoryRef.current` is true:

- Do not call `snapTerminalToBottom()` because it is irrelevant in alternate screen.
- Do not hide the chevron on new output.
- Do not set `shouldAutoFollowOutputRef.current = true` from output callbacks.

For opencode, output callbacks should respect:

```ts
if (isAltAgentReviewingHistoryRef.current) return
```

before re-arming follow state.

### 8. Remove Temporary Debug Plumbing Before Shipping

Current local changes include debug helpers:

- `debugLog` preload API.
- `ipcMain.on('debug:log')`.
- DevTools auto-open in dev mode.
- scroll wheel/follow localStorage logging.

For the final fix:

- Keep local `console.debug` only if it is already acceptable project style.
- Remove the renderer-to-main debug pipe unless still needed.
- Remove dev-mode auto-open DevTools.

The fix should not ship noisy debugging by default.

## Files To Change

Primary:

- `src/renderer/src/components/TerminalPane.tsx`

Likely cleanup:

- `src/main/index.ts`
- `src/preload/index.ts`
- `src/renderer/src/env.d.ts`

Optional docs:

- `plans/opencode-scrollbar-permission-diagnosis.md` can be left as historical diagnosis.
- This file should become the implementation source of truth for the scroll/chevron bug.

## Test Plan

### Manual Tests

1. Start Emu.
2. Run `opencode`.
3. Ask it to produce a long answer.
4. While output is still active, scroll upward with a trackpad.
5. Confirm:
   - scrolling is slower and controllable
   - the jump-to-bottom chevron appears
   - new output does not immediately hide the chevron
6. Click the chevron.
7. Confirm:
   - opencode returns to the newest visible content
   - the chevron disappears
   - new output follows normally again
8. Repeat with a mouse wheel if available.
9. Run `less package.json`.
10. Confirm existing pager scrolling still works.
11. Run a normal shell command with long output, such as:

```bash
seq 1 500
```

12. Confirm normal scrollback and chevron behavior still work.

### Automated Checks

Run:

```bash
node scripts/verify-agent-permission-detector.mjs
npm run build
```

There is no good unit test for trackpad feel here. The important check is manual behavior in the real Electron app.

## Acceptance Criteria

- Opencode trackpad scroll no longer jumps many pages per flick.
- Scrolling upward inside opencode shows the jump-to-bottom chevron.
- The chevron remains visible while the user is reviewing older opencode content.
- Clicking the chevron returns to live opencode output.
- Normal shell scrollback still works.
- `less` and editor/pager alternate-screen behavior is not made worse.
- Temporary debug IPC and auto-open DevTools are removed before final commit.

## Deliberate Non-Goals

- Do not redesign the jump-to-bottom button.
- Do not add a generic scroll state machine.
- Do not try to parse opencode's screen to find its exact internal scroll offset.
- Do not add new dependencies.
- Do not make this a cross-agent rewrite unless Claude/Codex show the same bug.
