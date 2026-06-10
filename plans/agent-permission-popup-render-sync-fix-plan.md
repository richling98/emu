# Agent Permission Popup Render-Sync Fix Plan

## Goal

Make native permission popups fire reliably for both Codex and Claude Code when either agent displays an approval prompt in Emu, including when Emu is not the frontmost macOS app.

This plan is based on the current root-cause investigation, not a new regex pass.

## Current Finding

The popup is not gated on Emu focus. The current code path is:

1. PTY output arrives in `TerminalPane`.
2. Emu runs detection on raw PTY data.
3. Emu writes the data into xterm with `terminal.write(data)`.
4. Emu schedules rendered-buffer scans with `setTimeout(...)`.
5. If detection returns a prompt, renderer sends `agent-permission:show` to main.
6. Main creates the native always-on-top overlay.

The observed failure happened before step 6. During the failed test, no overlay renderer process was created under the active preview process, which means the prompt was never queued in main.

The likely root cause is that xterm parsing/rendering is asynchronous. Emu currently scans the rendered buffer on timers that can run before xterm has fully parsed the TUI repaint. When Codex or Claude displays a permission prompt via a TUI repaint, the user can see the prompt while Emu’s scan has already missed the final rendered state.

There is also a separate testing hazard: multiple Emu/Electron instances can be open at the same time. That can make results look inconsistent if the user is interacting with a stale packaged app or orphan preview window.

## Non-Goals

- Do not move the popup into the main Emu window.
- Do not make popup behavior depend on app focus.
- Do not replace Codex/Claude parsers with broad keyword matching that creates false positives.
- Do not change approval semantics unless detection evidence shows the action mapping is wrong.

## Fix Strategy

Fix this at the source of truth: run permission detection after xterm confirms it has parsed terminal output, then add a narrow watchdog that rescans the rendered terminal while an agent session is active.

The detector should rely on rendered terminal state for TUI prompts. Raw PTY data remains a fast path for simple prompts, but not the only path.

## Phase 1: Add Runtime Evidence Before Behavior Changes

Add temporary, dev-only instrumentation that tells us where the pipeline stops.

### Renderer Probe

In `src/renderer/src/components/TerminalPane.tsx`, log these events when `localStorage.emu.debugAgentPermission === "1"` or `localStorage.thinking.debugAgentPermission === "1"`:

- `pty-data`: received PTY bytes.
- `raw-scan`: result of scanning raw PTY data.
- `write-parsed-scan`: result of scanning after xterm write completion.
- `watchdog-scan`: result of the periodic scan.
- `prompt-detected`: summary, provider, fingerprint.
- `prompt-show-ipc-sent`: prompt id and provider.

Each log entry should include:

- `sessionId`
- `provider`
- `agentSession`
- `isAltScreen`
- `rawTuiMode`
- `source`
- `matched`
- last 2,000 chars of scanned text

### Main Probe

In `src/main/index.ts`, log these events behind the same debug mode if possible, or behind an environment flag such as `EMU_DEBUG_AGENT_PERMISSION=1`:

- `ipc-show-received`
- `ipc-show-invalid-payload`
- `prompt-queued`
- `overlay-created`
- `overlay-shown`
- `overlay-action`

This phase should let us answer precisely:

- Did the rendered scan see the visible permission prompt?
- Did the detector parse it?
- Did renderer invoke IPC?
- Did main queue and show the overlay?

## Phase 2: Scan After xterm Write Completion

Replace the current timer-first rendered scan with xterm’s write completion signal.

Current pattern:

```ts
terminal.write(data)
window.setTimeout(() => {
  detectPermissionPrompt(getTerminalTailText(terminal, tailLines), 'tail')
}, delay)
```

Target pattern:

```ts
terminal.write(data, () => {
  detectPermissionPrompt(getTerminalTailText(terminal, tailLines), 'write-parsed')
  scheduleFollowupScans()
})
```

Why this matters:

- xterm explicitly supports `write(data, callback)`.
- The callback fires after the write chunk has been parsed.
- This removes the most obvious race between `terminal.write(data)` and `getTerminalTailText()`.

Keep delayed follow-up scans, but schedule them after the write callback, not immediately after `terminal.write()`.

## Phase 3: Add A Narrow Agent Permission Watchdog

Add a watchdog that scans the rendered terminal buffer while an agent session is active and likely waiting for input.

Start or refresh the watchdog when:

- A PTY output event arrives for an agent session.
- The session is in alternate screen.
- The foreground process or launch command identifies `codex` or `claude`.

Watchdog behavior:

- Scan rendered tail every `500ms`.
- Use 80 lines for agent TUI sessions.
- Stop after `30s` of no prompt match unless new PTY output refreshes it.
- Stop immediately when the detector sees the prompt disappear.
- Do not create duplicates; rely on existing detector fingerprint suppression and main-process dedupe.

This handles cases where:

- xterm write callback fires before a multi-chunk repaint finishes.
- Browser/background scheduling delays rendering.
- Claude or Codex repaints the final menu without enough new PTY output to trigger another useful scan.

## Phase 4: Improve Terminal Tail Capture

Make `getTerminalTailText()` less cursor-dependent for alternate-screen prompts.

Problem:

- It currently reads around `baseY + cursorY`.
- TUI prompts can leave the cursor near the bottom while important approval text begins much higher.

Change:

- Add `getTerminalVisibleText(terminal)` for alternate-screen scans.
- For alternate screen, read the full visible viewport rows from `terminal.buffer.active`.
- For normal buffer, keep the tail scan behavior.

Use this for permission detection:

```ts
const text = isAltScreenRef.current
  ? getTerminalVisibleText(terminal)
  : getTerminalTailText(terminal, tailLines)
```

This should better capture Claude screens with headers, skill previews, explanatory text, and choices.

## Phase 5: Keep Parser Changes Minimal

The detector already parses:

- Codex `Would you like to run the following command?`
- Claude `Use skill "run"?`
- Claude `Bash command`
- Claude hotkey prompts

Only adjust parser code if runtime logs show the real rendered text differs from fixtures.

Potential parser refinements if needed:

- Accept `Use Skill "run"?` capitalization variants.
- Accept selection markers stripped by xterm.
- Accept wrapped choice text.
- Extract skill name from `● Skill(run)` if the `Use skill ...?` line is missing from the scanned viewport.

Do not broaden to generic `Do you want to proceed?` alone. That would risk false positives.

## Phase 6: Handle Multiple Running App Instances During Testing

Before manual verification, clean up stale app instances.

Recommended test setup:

1. Quit packaged `/Applications/Emu.app`.
2. Kill orphan dev Electron processes not owned by the active `electron-vite preview` process.
3. Start exactly one preview app from the repo.
4. Confirm the visible app is named `Electron` or otherwise clearly the preview app.

This is test hygiene, not the root fix.

## Phase 7: Tests

### Existing Detector Fixture Tests

Keep and extend:

```bash
node scripts/verify-agent-permission-detector.mjs
```

Ensure it covers:

- Codex `npm run dev`.
- Exact Claude `Use skill "run"?` screenshot text.
- Stale provider hint cases.
- Duplicate suppression.
- Second distinct prompt emission.

### New Render-Sync Test

Add a focused test or probe for the key timing behavior:

- Simulate `terminal.write(data, callback)` scanning only after callback.
- Assert detection runs from write completion, not from immediate timer.

If xterm is hard to run in a headless unit test, use a small local manual probe script that:

- Emits partial TUI repaint chunks.
- Completes with a Codex-like or Claude-like approval screen.
- Verifies the debug logs show `write-parsed-scan` or `watchdog-scan` matched.

## Phase 8: Manual Verification

After implementation:

1. Run:

   ```bash
   node scripts/verify-agent-permission-detector.mjs
   npm exec tsc -- --noEmit
   npm run build
   git diff --check
   ```

2. Relaunch a single preview app.

3. In Codex inside Emu, ask it to run:

   ```text
   npm run dev
   ```

   Expected:

   - Native popup appears while Emu is frontmost.
   - Native popup appears if Chrome is frontmost.
   - Summary is `Run: npm run dev`.
   - Approve runs the command.
   - Deny declines the permission.

4. In Claude Code inside Emu, ask:

   ```text
   please run npm run dev
   ```

   Expected:

   - Native popup appears for `Use skill: run` or the command approval that follows.
   - Approve selects `Yes`.
   - Deny selects `No`, not Ctrl-C.

5. Trigger two approvals in separate tabs.

   Expected:

   - Popup shows `1 of 2`.
   - Arrow navigation switches between prompts.
   - Approving or denying one removes it and shows the next.

## Acceptance Criteria

- Popup detection no longer depends on a fragile timer after `terminal.write()`.
- The rendered scan runs after xterm confirms parsing is complete.
- A short watchdog catches missed final TUI states.
- Codex and Claude both fire native popups while Emu is backgrounded.
- No duplicate popup burst for one permission.
- Multiple pending permissions remain queued and navigable.
- Debug logs can identify the exact failed stage if another prompt shape fails.

## Proposed File Scope

Expected files:

- `src/renderer/src/components/TerminalPane.tsx`
- `src/renderer/src/agentPermissionPrompts.ts`
- `scripts/verify-agent-permission-detector.mjs`

Possible file if main-process logging is added:

- `src/main/index.ts`

Avoid touching unrelated UI, sidebar, terminal styling, or packaged-app deployment files during this fix.
