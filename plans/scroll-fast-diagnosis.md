# Scroll Fast Diagnosis — How to Use

## What Changed

I fixed a bug in the accumulator logic — `deltaPx` already has the correct sign from `e.deltaY` (negative for up, positive for down). The old code `scrollingUp ? -deltaPx : deltaPx` was inverting it, so the accumulator always grew in one direction. Now it preserves the sign.

This means the accumulator now reflects genuine trackpad momentum: a down-flick accumulates positive, an up-flick accumulates negative.

## How to Enable Diagnostics

1. Open Emu's DevTools: **Cmd + Option + I**
2. Paste this in the console, then **reload Emu** (Cmd+R):

```js
// Wheel event debug — logs every wheel event + accumulator state
localStorage.setItem('emu.debugScrollWheel', '1')

// Scroll follow debug — logs auto-follow snaps, alt-screen transitions
localStorage.setItem('emu.debugScrollFollow', '1')
```

## What You'll See in Console

### With `emu.debugScrollWheel`:

Every wheel event prints:

```
[scroll-wheel] { sessionId, deltaY, deltaMode, isAltScreen, rawTuiMode, proc, accumulator }
```

This lets you verify:
- `accumulator` is building up correctly (signed, so negative = scrolling up)
- Commands are emitted only when `|accumulator| >= pxPerLine` (typically ~15px)
- The correct direction is being sent (`\x1b[A` up, `\x1b[B` down)

### With `emu.debugScrollFollow`:

Alt-screen transitions print:

```
[scroll-follow:alt-screen-enter] { sessionId, proc, provider, isAgent, entryLine }
[scroll-follow:alt-screen-exit]  { sessionId, proc, provider, agentSession }
```

Plus existing scroll snap events (snap-bottom, button-scroll, etc).

## What to Do

1. Enable the flags above
2. Reload Emu
3. Open opencode (`opencode`)
4. Ask it something so it outputs text
5. Try scrolling with trackpad
6. Open DevTools console — you should see `[scroll-wheel]` events logging delta, accumulator, and commands sent
7. The key thing to watch: does the accumulator stay small (good, meaning accumulation is working) or spike to huge values (bad, meaning accumulation is broken)?

If the scrolling still feels too fast, the issue might be that the `pxPerLine` threshold is too low (it's typically ~15px, which is only 1-2 trackpad events). Or opencode might be responding to each `\x1b[A`/`\x1b[B` by doing its own page-level scroll, in which case we'd need to reduce the max lines per command.
