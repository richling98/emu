# Fast Scroll Bug: Root Cause & Fix Plan

## Summary

When the terminal is receiving output and the user tries to scroll up, xterm.js is fighting every scroll gesture frame-by-frame. The user's scroll is applied, then immediately undone on the next animation frame. The scrollbar oscillates rapidly between "user scrolled" and "snapped back to bottom," which looks and feels like extremely fast uncontrolled scrolling. Even the slowest possible touch doesn't help because the snap cancels it before the next frame.

---

## Root Cause: `terminal.scrollToBottom()` inside `snapTerminalToBottom()` schedules a deferred snap that fires after the user starts scrolling

**File:** `src/renderer/src/components/TerminalPane.tsx`, line 645

```typescript
const snapTerminalToBottom = () => {
  const terminal = terminalRef.current
  const viewport = getViewportElement()
  if (!terminal || !viewport || terminal.buffer.active.type === 'alternate') return

  viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight
  terminal.scrollToBottom()   // ← THIS IS THE BUG
  shouldAutoFollowOutputRef.current = true
  setIsAtBottom(true)
}
```

Here is the exact call chain that causes the bug:

1. New output arrives → `ybase` increments by 1 (new line added to buffer). At this moment `ydisp = ybase - 1` — the user is 1 line behind the new bottom.

2. `terminal.write(data, callback)` fires. The callback checks `shouldAutoFollowOutput && shouldAutoFollowOutputRef.current` (both true) and calls `snapTerminalToBottom()`.

3. `snapTerminalToBottom()` runs:
   - **Line A:** `viewport.scrollTop = scrollHeight - clientHeight` — correct, snaps viewport to bottom visually. The DOM `scroll` event fires synchronously. xterm's `_handleScroll` picks it up, computes `diff = 1` (one new line), calls `terminal.scrollLines(1, true, ScrollSource.VIEWPORT)` with `suppressScrollEvent: true`. `ydisp` is updated to `ybase`. No feedback loop. ✓
   - **Line B:** `terminal.scrollToBottom()` — at this point `ydisp` is already `ybase` (just updated in line A's `_handleScroll`). You'd expect `scrollToBottom()` to be a no-op, but it isn't, because the call path goes through **`Viewport.scrollLines()`** before checking `ydisp`.

4. `terminal.scrollToBottom()` → `CoreTerminal.scrollToBottom()` → `this.scrollLines(ybase - ydisp)`. Since `ydisp` was just set to `ybase` in step 3-line-A, `ybase - ydisp = 0`. But:

   > `Terminal.scrollLines(0, undefined, TERMINAL)` → source is TERMINAL → `this.viewport?.scrollLines(0)`

   `Viewport.scrollLines(0)` **returns early** (`if (disp === 0) return`) — **so the bug doesn't happen when we're already fully at the bottom.**

5. **However**, the timing is not always clean. `_handleScroll` is a DOM event listener. Whether it fires synchronously before `terminal.scrollToBottom()` runs depends on the browser. In practice, across frames and when multiple writes fire rapidly, `ydisp` may NOT have been updated yet when line B runs. In that case `ybase - ydisp = 1`, and `Viewport.scrollLines(1)` fires:

   ```
   _onRequestScrollLines.fire({ amount: 1, suppressScrollEvent: false })
   ↓
   terminal.scrollLines(1, false, ScrollSource.VIEWPORT)
   ↓
   super.scrollLines(1, false) → BufferService.scrollLines(1, false)
   ↓
   _onScroll.fire(ydisp)          ← suppressScrollEvent is FALSE
   ↓
   Terminal._onScroll listener: viewport.syncScrollArea()
   ↓
   _refresh() → requestAnimationFrame(_innerRefresh)
   ↓
   _innerRefresh(): viewport.scrollTop = ybase * rowHeight   ← DEFERRED SNAP
   ```

6. This deferred `_innerRefresh` fires **on the next animation frame** (~16ms later). If the user started scrolling up in that window:
   - User's `handleWheel`: `viewport.scrollTop -= 15`, `shouldAutoFollowOutputRef = false`
   - rAF fires: `_innerRefresh` runs regardless of `shouldAutoFollowOutputRef` (it's xterm-internal). It sees `viewport.scrollTop (7485) !== ybase * rowHeight (7500)`, sets `_ignoreNextScrollEvent = true`, sets `viewport.scrollTop = 7500`.
   - The user's scroll is undone.
   - Next user scroll: same thing. Snap. Undone. Snap. Undone.

The user experiences this as: the scrollbar flies back and forth extremely fast. Even the gentlest touch is cancelled within one frame. It's intermittent because it only happens when output is arriving (making `ybase > ydisp`).

---

## Why `terminal.scrollToBottom()` is redundant and can be removed

`viewport.scrollTop = scrollHeight - clientHeight` (line A) already does everything needed:

1. It visually moves the viewport to the bottom.
2. The synchronous DOM `scroll` event fires `_handleScroll`.
3. `_handleScroll` calls `terminal.scrollLines(diff, true, ScrollSource.VIEWPORT)` which updates `ydisp = ybase`.
4. Because `suppressScrollEvent: true`, no `_onScroll` fires, no `syncScrollArea`, no deferred snap.

`terminal.scrollToBottom()` (line B) adds nothing correct and introduces a deferred snap that fights the user.

---

## The Fix

Remove `terminal.scrollToBottom()` from `snapTerminalToBottom()`:

```typescript
const snapTerminalToBottom = () => {
  const terminal = terminalRef.current
  const viewport = getViewportElement()
  if (!terminal || !viewport || terminal.buffer.active.type === 'alternate') return

  viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight
  // Do NOT call terminal.scrollToBottom() here — it fires _onScroll with
  // suppressScrollEvent:false, which schedules a deferred _innerRefresh via
  // requestAnimationFrame that snaps scrollTop back to the bottom AFTER the
  // user has started scrolling up, fighting every scroll gesture frame-by-frame.
  // viewport.scrollTop = max already correctly updates ydisp via _handleScroll.
  shouldAutoFollowOutputRef.current = true
  setIsAtBottom(true)
}
```

That's the entire fix. One line removed.

---

## Secondary fix: Cancel the `handleScrollToBottom` animation on user input

While investigating, a second real bug was also found: the scroll-to-bottom animated button (300ms ease-out animation) has no cancellation. If the user clicks it and then immediately tries to scroll manually, the animation continues competing with user input for 300ms, re-arming `shouldAutoFollowOutputRef = true` and `autoFollowOutputRenderUntilRef` on every frame, which blocks the scroll-state listener from registering that the user is no longer at the bottom.

Add a ref and cancel the animation when the user starts scrolling:

```typescript
// Add near other scroll refs (~line 503):
const scrollToBottomAnimRef = useRef<number | null>(null)

// At the start of handleWheel, before anything else (~line 1335):
if (scrollToBottomAnimRef.current !== null) {
  cancelAnimationFrame(scrollToBottomAnimRef.current)
  scrollToBottomAnimRef.current = null
}

// Rewrite handleScrollToBottom to track its rAF (~line 673):
const handleScrollToBottom = () => {
  const viewport = getViewportElement()
  if (!viewport) return

  if (scrollToBottomAnimRef.current !== null) {
    cancelAnimationFrame(scrollToBottomAnimRef.current)
  }
  shouldAutoFollowOutputRef.current = true
  const DURATION = 300
  const startTime = performance.now()
  const startPos = viewport.scrollTop

  const step = (now: number) => {
    scrollToBottomAnimRef.current = null
    const elapsed = now - startTime
    const progress = Math.min(elapsed / DURATION, 1)
    const eased = 1 - Math.pow(1 - progress, 3)
    const target = viewport.scrollHeight - viewport.clientHeight
    shouldAutoFollowOutputRef.current = true
    autoFollowOutputRenderUntilRef.current = Date.now() + 80
    viewport.scrollTop = startPos + (target - startPos) * eased

    if (progress < 1) {
      scrollToBottomAnimRef.current = requestAnimationFrame(step)
    } else {
      snapTerminalToBottom()
    }
  }
  scrollToBottomAnimRef.current = requestAnimationFrame(step)
}

// In useEffect cleanup return () => { ... } (~line 2067):
if (scrollToBottomAnimRef.current !== null) {
  cancelAnimationFrame(scrollToBottomAnimRef.current)
}
```

---

## Files to change

`src/renderer/src/components/TerminalPane.tsx`:

| Change | Location |
|---|---|
| Remove `terminal.scrollToBottom()` from `snapTerminalToBottom` | Line 645 — **primary fix** |
| Add `scrollToBottomAnimRef` | ~line 503 |
| Cancel animation at start of `handleWheel` | ~line 1335 |
| Rewrite `handleScrollToBottom` to track its rAF | ~line 673 |
| Cancel animation in useEffect cleanup | ~line 2067 |
