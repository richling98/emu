# Command Navigation DMG Regression Diagnosis

**Status:** Diagnosis only

## Release Scope

The affected shipped release is `v0.4.3`.

Confirmed GitHub release metadata:

- Release: `0.4.3`
- Tag: `v0.4.3`
- Published: `2026-07-06T16:29:23Z`
- DMG asset: `Emu-0.4.3-arm64.dmg`
- Release URL: `https://github.com/richling98/emu/releases/tag/v0.4.3`

Local tag:

- `v0.4.3` points at `f50a6e43 chore: bump version to 0.4.3`
- The command navigation changes in that release are immediately before the tag:
  - `e4d50bfd fix: command history navigation hardening for normal and agent alt-screen modes`
  - `d4a6b254 Fix command history navigation with relative position finding`

## User-Visible Bug

In the development app, command navigation appeared to work:

- `Command+Shift+L` opens the command log.
- `Command+Up` / `Command+Down` jump between previous prompts.
- Clicking a command-log entry jumps back to that prompt.

In the shipped DMG, this stopped working for Claude Code and Codex.

Those two agents matter because they usually run in xterm's alternate screen,
not the normal shell scrollback. Normal shell commands use stable buffer line
numbers; Claude/Codex prompts require a separate search strategy.

## Current Released Implementation

### Keyboard Entry Point

In `src/renderer/src/components/TerminalPane.tsx`, the released code installs a
window-level keydown handler:

```ts
window.addEventListener('keydown', handler)
```

It handles:

- `Command/Ctrl+Shift+L`: toggle command log drawer
- `Command+ArrowUp`: jump to previous prompt
- `Command+ArrowDown`: jump to next prompt or bottom

This handler is registered in the bubbling phase, not capture phase.

### History Entry Model

Command history entries include:

```ts
navigationMode: 'normal-buffer' | 'agent-alt-screen'
commandFingerprint: string
commandLastLineFingerprint: string
agentProvider?: string | null
altScreenSessionId?: string | null
```

Normal shell commands navigate by line number:

```ts
scrollToPromptLine(entry.line)
```

Agent alternate-screen commands navigate by text search:

1. Verify xterm is currently in alternate-screen mode.
2. Verify the stored `altScreenSessionId` matches the current alternate-screen session.
3. Check whether the visible terminal text contains the command fingerprint.
4. If not, send PageDown into the PTY repeatedly until the text appears.

The released implementation:

```ts
for (let attempt = 0; attempt < 100; attempt++) {
  if (visibleTextContainsHistoryEntry(terminal, entry)) return
  window.api.ptyWrite(session.id, '\x1b[6~')
  await wait(AGENT_HISTORY_SEARCH_SETTLE_MS)
}
```

## High-Confidence Root Causes

### 1. The released code references an undefined constant

`TerminalPane.tsx` still calls:

```ts
await wait(AGENT_HISTORY_SEARCH_SETTLE_MS)
```

But `d4a6b254` removed the constant definition:

```ts
const AGENT_HISTORY_SEARCH_SETTLE_MS = 90
```

Current local line:

- `src/renderer/src/components/TerminalPane.tsx:804`

Evidence:

```bash
npm exec tsc -- -p tsconfig.web.json --noEmit
```

reports:

```text
src/renderer/src/components/TerminalPane.tsx(804,18): error TS2304: Cannot find name 'AGENT_HISTORY_SEARCH_SETTLE_MS'.
```

The production build still succeeds because `electron-vite build` is not type
checking this renderer code path. The generated renderer bundle still contains:

```js
await wait(AGENT_HISTORY_SEARCH_SETTLE_MS);
```

That means any agent alternate-screen navigation path that reaches this line
will throw a runtime `ReferenceError`.

Why it could appear to work in development:

- The bug only throws after the target prompt is not already visible.
- If dev testing clicked a visible/latest prompt, the function returned before
  reaching the undefined constant.
- A hot dev session may also have tested an earlier module state before
  `d4a6b254` removed the constant.
- Packaged DMG starts from the bundled cold state every time, so the missing
  symbol is consistently present.

### 2. The final release searches only PageDown, even for older prompts

The first hardening commit, `e4d50bfd`, introduced directional search:

- PageUp for older prompt search
- PageDown for newer prompt search
- both directions for ambiguous command-log clicks

The final pre-release commit, `d4a6b254`, replaced that with a simpler loop that
always sends:

```ts
window.api.ptyWrite(session.id, '\x1b[6~') // PageDown
```

This is wrong for `Command+Up`.

Typical failure case:

1. User is at the bottom of Claude/Codex.
2. User presses `Command+Up` to jump to the previous prompt.
3. `findCurrentPromptIndex()` selects the older history entry.
4. `jumpToAgentAltScreenEntry()` tries to find it by sending PageDown.
5. PageDown at or near the bottom does not reveal older content.
6. Search never finds the prompt.
7. In the current release, it then hits the undefined constant and throws.

Even after restoring the missing constant, this one-way PageDown behavior would
still make `Command+Up` unreliable for Claude/Codex.

### 3. `Command+Shift+L` is handled too late in the event path

The command-log shortcut is implemented with:

```ts
window.addEventListener('keydown', handler)
```

No capture flag is used.

Other app shortcuts use capture phase. For example, the top-tab shortcut in
`App.tsx` uses:

```ts
window.addEventListener('keydown', handleTopTabShortcut, true)
```

The main process also has `before-input-event` handling for font zoom because
the code already recognized that menu accelerators and terminal focus can steal
special keys.

Risk:

- In packaged Electron, native menu/default browser behavior can differ from
  dev mode.
- xterm, contenteditable, or focused TUI surfaces can consume key events before
  a bubbling window listener sees them.
- `Command+Up` is especially likely to have browser/native scroll semantics.

This does not explain the runtime `ReferenceError`, but it can explain why
`Command+Shift+L` itself feels dead in the DMG.

## Secondary Fragility

### Exact text fingerprint matching is brittle in agent TUIs

Agent alternate-screen navigation depends on:

```ts
visibleTextContainsHistoryEntry(terminal, entry)
```

That checks whether the currently visible xterm text contains:

- the full normalized command fingerprint, or
- the normalized last-line fingerprint

This can miss real prompts when Claude/Codex:

- wraps a prompt differently after resize
- collapses or summarizes earlier messages
- hides older text behind virtualized history
- rewrites the prompt with different spacing or UI chrome
- stores multi-line input in a different visual form from what Emu captured

This is probably not the first failure to fix, but it explains why the feature
needs better debug traces and fallback behavior.

### Alternate-screen session IDs may be too strict

Each alternate-screen entry gets an `altScreenSessionId`. Navigation rejects an
entry if the current alternate-screen session id differs.

That protects against jumping into a previous closed TUI, but it can be too
strict if Claude/Codex briefly exits and re-enters the alternate screen, or if
packaged rendering/focus behavior causes extra buffer-change events.

Symptom:

```text
That prompt belongs to a previous agent screen.
```

This needs runtime traces before changing behavior.

## Why The DMG Shipped With This

`npm run build` passed before release because the script runs:

```bash
electron-vite build
```

That does not fail on the undefined renderer symbol.

Direct renderer type-checking does catch it:

```bash
npm exec tsc -- -p tsconfig.web.json --noEmit
```

But the repo currently has other TypeScript errors too, so there is no clean
typecheck gate protecting releases.

The most important release-process issue:

> We are shipping DMGs from a build command that can bundle runtime
> `ReferenceError`s in renderer code.

## Recommended Fix

### Phase 1: Immediate functional fix

In `src/renderer/src/components/TerminalPane.tsx`:

1. Restore explicit search constants:

```ts
const AGENT_HISTORY_SEARCH_MAX_ATTEMPTS = 13
const AGENT_HISTORY_SEARCH_SETTLE_MS = 90
```

2. Restore directional search:

```ts
type AgentHistorySearchDirection = 'up' | 'down' | 'both'
```

3. Make `jumpToAgentAltScreenEntry()` send PageUp for older prompts and
PageDown for newer prompts:

```ts
const pageSequence = searchDirection === 'up' ? '\x1b[5~' : '\x1b[6~'
```

4. For `Command+Up`, pass `up`.

5. For `Command+Down`, pass `down`.

6. For command-log clicks:

- if the current visible prompt index is known, compare target index to current
  index and choose `up` or `down`
- if current index is unknown, search `both`

7. Restore the failure status when search exhausts attempts:

```ts
showNavigationStatus('Could not find that prompt in the agent history.')
```

### Phase 2: Make shortcuts production-safe

Change the command-history key listener to capture phase:

```ts
window.addEventListener('keydown', handler, true)
return () => window.removeEventListener('keydown', handler, true)
```

If packaged testing still shows missed shortcuts, move these shortcuts to the
main process `before-input-event`, matching the font zoom pattern:

```ts
mainWindow.webContents.on('before-input-event', (event, input) => {
  // detect Command+Shift+L, Command+ArrowUp, Command+ArrowDown
  // preventDefault()
  // send renderer IPC event
})
```

Then expose a preload listener such as:

```ts
onCommandNavigationShortcut(callback)
```

This makes shortcut delivery independent of xterm focus, contenteditable focus,
and native browser defaults.

### Phase 3: Add command-navigation debug traces

Add a localStorage flag:

```ts
emu.debugCommandNavigation = '1'
```

Log:

- shortcut event received
- active pane/session id
- history length
- current visible prompt index
- target entry id and command fingerprint length
- entry navigation mode
- current xterm buffer type
- alt-screen session id comparison
- page sequence sent
- attempt count
- matched visible text or failure reason

Do not persist terminal text; console-only debug is enough.

### Phase 4: Add release gates

Add package scripts:

```json
{
  "typecheck:web": "tsc -p tsconfig.web.json --noEmit",
  "typecheck:node": "tsc -p tsconfig.node.json --noEmit",
  "typecheck": "tsc -b --noEmit",
  "verify": "npm run typecheck:web && npm run typecheck:node && npm run build"
}
```

Before this can be a hard gate, fix the existing TypeScript errors reported by:

```bash
npm exec tsc -- -p tsconfig.web.json --noEmit
npm exec tsc -- -p tsconfig.node.json --noEmit
```

At minimum, ensure renderer typecheck is clean before another DMG release.

### Phase 5: Packaged smoke test

Manual smoke test must run against packaged output, not only `npm run dev`.

Test matrix:

1. Launch packaged app.
2. Start Claude Code.
3. Submit at least three prompts.
4. Press `Command+Shift+L`.
   - Expected: command log opens.
5. Click the oldest Claude prompt in the command log.
   - Expected: visible Claude history scrolls to that prompt.
6. Press `Command+Up` from the latest prompt.
   - Expected: previous prompt appears.
7. Press `Command+Down`.
   - Expected: next prompt appears, or bottom if already latest.
8. Repeat with Codex.
9. Repeat with a normal shell command to confirm normal-buffer navigation still works.

## Proposed Acceptance Criteria

- No `AGENT_HISTORY_*` undefined symbols remain in source or built renderer assets.
- `npm run typecheck:web` passes.
- `npm run build` passes.
- In packaged app, `Command+Shift+L` opens command log with Claude/Codex focused.
- In packaged app, `Command+Up` navigates to older Claude/Codex prompts.
- In packaged app, command-log click navigates to selected Claude/Codex prompt.
- Failed agent-history search shows an explicit status message instead of silently doing nothing.

## Bottom Line

The strongest root cause is not a DMG-specific packaging mystery. The shipped
release contains a real runtime bug:

- `AGENT_HISTORY_SEARCH_SETTLE_MS` is referenced but not defined.

The second root cause is behavioral:

- the final release searches only PageDown inside Claude/Codex, so older prompt
  navigation cannot work reliably.

The third likely contributor is event delivery:

- command-history shortcuts are registered as bubbling renderer keydown events,
  which is weaker than the capture/main-process shortcut handling used elsewhere
  in the app.

Fix those in that order.
