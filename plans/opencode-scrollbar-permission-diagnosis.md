# Opencode Scrollbar + Permission Popup Diagnosis

## Issue 1: Scrollbar goes way too fast in opencode CLI layout

### Symptoms

- When using opencode's full-screen TUI inside Emu, the scrollbar scrolls ~10+ pages per trackpad flick
- This happens because opencode uses the **alternate screen buffer** for its TUI
- The issue is specific to Emu, not to opencode itself — Emu's wheel handler was over-aggressive

### Root Cause

In `TerminalPane.tsx`, the `handleWheel` function intercepts all wheel events and forwards them as PTY key sequences for alt-screen apps. The **old code** sent one PageUp (`\x1b[5~`) or PageDown (`\x1b[6~`) per wheel event:

```typescript
// OLD: one page command per event — trackpad flicks generate 10-15 events
window.api.ptyWrite(session.id, scrollingUp ? '\x1b[5~' : '\x1b[6~')
```

A macOS trackpad flick generates **10-15 discrete wheel events**, each with a tiny deltaY (2-15px). Every event independently sent a full-page command to opencode, resulting in 10-15 page scrolls per flick.

### Fix: Proportional Accumulation

Added a `wheelAccumulatorRef` that accumulates pixel deltas. Only emits scroll commands when accumulated pixels exceed `pxPerLine`, and sends proportional **line-level** cursor commands (`\x1b[A`/`\x1b[B`) instead of page commands:

```typescript
// NEW: accumulate pixels, emit line-level commands for natural momentum
wheelAccumulatorRef.current += scrollingUp ? -deltaPx : deltaPx
const absAccum = Math.abs(wheelAccumulatorRef.current)
if (absAccum >= pxPerLine) {
  const lines = Math.floor(absAccum / pxPerLine)
  wheelAccumulatorRef.current = (absAccum % pxPerLine) * (wheelAccumulatorRef.current > 0 ? 1 : -1)
  const clamped = Math.min(lines, 60)
  window.api.ptyWrite(session.id, scrollingUp ? '\x1b[A'.repeat(clamped) : '\x1b[B'.repeat(clamped))
}
```

Pager/editor apps (`less`, `vim`) in normal buffer (unusual but possible) get the same accumulation but use Ctrl+B/Ctrl+F page commands when accumulated lines exceed 60% of the terminal height.

The accumulator is reset to 0 on every alt-screen entry/exit.

### Files Changed

- **`src/renderer/src/components/TerminalPane.tsx`**: New `wheelAccumulatorRef`, rewritten `handleWheel` alt-screen/pager/editor branches, accumulator reset in `onBufferChange` handler

---

## Issue 2: Permission popup doesn't work with opencode

### Symptoms

- Emu's native agent permission overlay never appears when opencode asks for approval
- No prompts are detected even though opencode outputs permission prompts

### Root Cause

The entire agent detection pipeline was hardcoded for `claude` and `codex` only:

| Function | What it checked | What it missed |
|----------|-----------------|----------------|
| `AgentPermissionProvider` type | `'claude' \| 'codex'` | `'opencode'` |
| `isAgentProcessName()` | `/\b(claude\|codex)\b/` | `opencode` process name |
| `getAgentProviderFromProcess()` | `.includes('claude')` / `.includes('codex')` | `opencode` basename |
| `isAgentLaunchCommand()` | `claude`/`codex` in command | `opencode` command |
| `getAgentProviderFromCommand()` | Same | Same |
| `inferProviderFromText()` | Claude Code / Codex prompt patterns | Opencode prompt patterns |

Without `opencode` being recognized:
- `agentSessionRef.current` stayed `false`
- `agentProviderRef.current` stayed `null`
- `context.agentSession` was `false` in `AgentPermissionPromptDetector.append()` → early return with null
- No prompts were ever scanned, even though `shouldUseAgentPermissionScan()` returned `true` (due to alt-screen mode)

### Fix: Add opencode to the detection pipeline

1. **`AgentPermissionProvider`**: Added `'opencode'` to the union type
2. **`isAgentProcessName()`**: Added `opencode` to the regex
3. **`getAgentProviderFromProcess()`**: Added `opencode` basename check
4. **`isAgentLaunchCommand()`**: Added `opencode` to both direct command and `npx`/`bunx`/etc. patterns
5. **`getAgentProviderFromCommand()`**: Added `opencode` detection
6. **`inferProviderFromText()`**: Added opencode prompt pattern detection
7. **`detectSnapshot()`**: Added `'opencode'` provider hint handling — tries generic parser first, then claude/codex as fallback
8. **`shouldUseAgentPermissionScan()`**: Added `context.provider === 'opencode'`
9. **Overlay popup label**: Added `'opencode'` label in the overlay HTML

The **generic permission prompt parser** (`parseGenericAgentPermissionPrompt`) handles opencode's prompts since they share the same approve/deny choice UI pattern.

### Files Changed

- **`src/shared/agentPermissionPrompts.ts`**: Type + 6 detection functions + `detectSnapshot` fallback chain
- **`src/renderer/src/components/TerminalPane.tsx`**: Added `'opencode'` to `shouldUseAgentPermissionScan()`
- **`src/main/index.ts`**: Added `'opencode'` label in overlay `providerLabel()` function

---

## Diagnostic Hooks Added

To help debug similar issues in the future:

| Hook | How to enable | What it logs |
|------|---------------|--------------|
| Wheel event debug | `localStorage.setItem('emu.debugScrollWheel', '1')` | Every wheel event: deltaY, deltaMode, alt-screen state, accumulator value, action taken |
| Scroll follow debug (enhanced) | `localStorage.setItem('emu.debugScrollFollow', '1')` | Now also logs alt-screen **enter** (process, provider) and **exit** (provider, agent state) events |
| Alt-screen snap on exit | (Always active) | When auto-follow was enabled before entering alt-screen, snaps to bottom on exit to reveal any output that arrived during alt-screen mode |

Legacy flags also work: `thinking.debugScrollWheel`, `thinking.debugScrollFollow`.
