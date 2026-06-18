# Agent Permission Popup Intermittent Diagnosis And Fix Plan

## Expected Result

If this plan is implemented, Emu should show the native permission popup whenever any tab has a Codex or Claude approval prompt waiting in the terminal.

This should be true regardless of:

- Which Emu tab is active.
- Whether the tab with the prompt is visible, hidden, split-pane inactive, or in the background.
- Whether the Emu app window is focused.
- Whether the user is currently looking at another app, such as a browser.
- Whether the agent prompt is rendered as normal terminal output or repainted by a TUI.

The user-visible behavior should be:

- The popup appears reliably instead of requiring the user to click back into Emu and press Enter manually.
- Approve still sends the correct approval keystroke to the waiting terminal prompt.
- Deny still sends the correct denial or cancel keystroke.
- Duplicate terminal repaints do not create duplicate popups.
- Multiple pending approvals continue to queue in one popup with navigation.
- Debug logs can explain future misses by showing whether detection, parsing, queueing, or overlay display failed.

## Goal

Make the native agent permission popup appear for every permission approval prompt in every Emu tab, independent of app focus, tab visibility, or terminal render timing.

The product rule is simple: if any Emu terminal session is waiting for a permission approval, the native popup should appear.

This document is diagnosis and implementation planning only. No runtime code has been changed yet.

## Relevant History

The native popup was introduced by:

- `a55091bc Add native agent permission popup`
- `b9237edd Add native agent permission popup`

The main implementation lives in:

- `src/renderer/src/agentPermissionPrompts.ts`
- `src/renderer/src/components/TerminalPane.tsx`
- `src/main/index.ts`
- `src/preload/index.ts`
- `scripts/verify-agent-permission-detector.mjs`

## Product Requirement

Permission detection must be session-wide, not view-wide.

The detector cannot depend on the user currently looking at the tab, the tab being active, or the Emu window having focus. A background tab should have the same ability to raise the native popup as the foreground tab.

That means PTY output must be scanned for permission prompts as it arrives for every live session. Rendered xterm scans are useful as a second signal, especially for TUI repainting, but they cannot be the only reliable path because hidden tabs may buffer output instead of rendering it immediately.

## Current Popup Flow

The popup only appears if all of these stages succeed.

### 1. Renderer Detects A Permission Prompt

`TerminalPane.tsx` receives PTY output through `window.api.onPtyData(...)`.

On every data event it tries:

1. Raw PTY scan:
   - `detectPermissionPrompt(data, 'raw')`
2. If the output is written into xterm immediately, rendered-buffer scan after `terminal.write(...)`:
   - `detectPermissionPrompt(getPermissionScanText(...), 'write-parsed')`
3. Follow-up rendered scans for agent sessions:
   - `0ms`, `50ms`, `150ms`, `300ms`
4. Watchdog scans every `500ms` for up to `30s` while permission scanning is armed.

The scanner is enabled when Emu thinks any of these are true:

- Provider is `claude`.
- Provider is `codex`.
- `agentSessionRef.current` is true.
- The terminal is in alternate screen.
- Raw TUI mode is active.

### 2. Parser Produces A Prompt Payload

`AgentPermissionPromptDetector.append(...)` only emits a prompt if:

- The session is an agent session, or the current text explicitly names/invokes a known provider.
- The current text snapshot can be parsed as a Codex or Claude permission prompt.
- The parsed prompt fingerprint is different from the detector's last emitted fingerprint.

The parser is strict by design. For Claude it needs a recognizable prompt subject plus approve and deny choices. For Codex it needs the command question, approve choice, deny choice, and confirmation hint.

### 3. Main Process Queues And Shows The Overlay

`src/main/index.ts` handles `agent-permission:show`.

It rejects or suppresses the prompt when:

- The PTY session no longer exists.
- The same session/fingerprint was resolved in the last `2s`.
- The same session/fingerprint is already pending, in which case it updates the existing queue item instead of creating a duplicate.

If accepted, it calls `showAgentPermissionOverlay(true)`, which creates or reuses the always-on-top overlay window, sends state to it, calls `showInactive()`, and moves it to the top. This should work even when Emu is not the focused app.

## When It Appears Today

The popup is most likely to appear today when:

- The agent process has already been identified as `claude` or `codex`.
- The tab is visible, in alternate screen, or otherwise writing output immediately to xterm.
- The rendered xterm snapshot contains the full permission prompt subject and both approve/deny choices at the same time.
- The prompt fingerprint is not already pending and was not resolved in the last `2s`.
- The overlay window is created and receives state normally.

This matches the user's observation that when it appears, it appears correctly.

This is too conditional for the intended product behavior. The popup should not depend on the tab being visible or on the rendered terminal snapshot being available at the right moment.

## When It Can Fail Today

These are the likely failure paths from the current code.

### 1. Hidden Or Not-Yet-Classified Agent Output Can Bypass Detection

If a tab is hidden and Emu has not yet marked the process/session as an agent session, then:

1. Raw PTY detection runs on the incoming chunk.
2. If that chunk alone is not parseable, detection returns no prompt.
3. Because the tab is hidden and `shouldUseAgentPermissionScan()` may be false, output goes into `appendHiddenOutput(data)`.
4. `replayHiddenOutput()` later writes buffered data back to xterm, but it does not call `detectPermissionPrompt(...)`.

Result: the permission prompt can become visible in the terminal without ever producing a native popup. The user can still press Enter manually because the terminal prompt is real and waiting.

This is a high-confidence miss path.

It also violates the core requirement: a permission prompt in a background tab should raise the popup immediately, not only after the user returns to that tab.

### 2. Raw PTY Chunks Are Not A Stable Detection Unit

The raw scan receives each PTY data event independently. Permission prompts can be split across chunks or repainted with cursor movement.

If one chunk contains the question and a later chunk contains the choices, neither raw chunk is parseable alone. Rendered scans usually compensate, but only when the output is written immediately and scanned after rendering.

This is especially relevant for TUI-style Claude screens.

### 3. Alternate-Screen Detection Uses Visible Rows Only

`getPermissionScanText(...)` returns:

- `getTerminalVisibleText(terminal)` in alternate screen.
- `getTerminalTailText(terminal, tailLines)` otherwise.

For alternate-screen apps, the detector gets the visible viewport, not the configured `AGENT_PERMISSION_TAIL_LINES`.

If the prompt subject, long description, `Do you want to proceed?`, and choices are not all present in the visible rows at the same scan moment, the parser can fail even though the terminal is waiting for Enter.

### 4. The Parser Requires A Complete Prompt Shape

For Claude prompts, `parseClaudePermissionPrompt(...)` requires:

- A recognizable prompt start.
- At least one approve choice.
- At least one deny choice.

That avoids false positives, but it means a partial rendered snapshot with only the selected `Yes` row and footer will not emit a popup.

### 5. Main-Process Suppression Can Hide Fast Repeated Prompts

After approving or denying a prompt, main stores `sessionId + fingerprint` for `2s`.

If the same prompt is still visible, re-rendered, or re-requested within that window, `addAgentPermissionPrompt(...)` suppresses it.

This is probably correct for duplicate repaints, but it can become user-visible if:

- The popup action did not actually reach the PTY.
- The agent immediately asks the same permission again.
- The prompt remains waiting longer than expected after the popup is closed.

This is a lower-confidence cause for the reported issue, but it should be instrumented.

### 6. Overlay Display Itself Is Less Suspect

The overlay uses:

- `alwaysOnTop: true`
- `setAlwaysOnTop(true, 'screen-saver')`
- `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`
- `showInactive()`
- `moveTop()`

Because the popup sometimes appears perfectly, the window-display layer is probably not the primary bug. Still, debug logging should prove whether prompts are queued but not visible.

## Diagnosis Plan

### 1. Add A Bounded Debug Trace For Each Gate

Add temporary or flag-gated diagnostics under the existing debug controls:

- Renderer flag: `localStorage.emu.debugAgentPermission = '1'`
- Main flag: `EMU_DEBUG_AGENT_PERMISSION=1`

Capture these events:

- `renderer-raw-scan`
- `renderer-write-parsed-scan`
- `renderer-followup-scan`
- `renderer-watchdog-scan`
- `renderer-hidden-buffered`
- `renderer-hidden-replay-scan`
- `renderer-detected-prompt`
- `main-ipc-show-received`
- `main-prompt-queued`
- `main-prompt-deduped`
- `main-prompt-suppressed-recently-resolved`
- `main-overlay-shown`

For renderer scans, include:

- `sessionId`
- provider hint
- `agentSession`
- `isVisible`
- `isAltScreen`
- `rawTuiMode`
- source
- normalized text tail, capped to about 2,000 characters
- parsed provider/summary/fingerprint when matched

This should answer whether misses are:

- Not scanned.
- Scanned with incomplete text.
- Parsed but rejected/suppressed in main.
- Queued but not displayed.

### 2. Reproduce With Four Scenarios

Use the debug trace while testing:

1. Visible Claude/Codex prompt.
2. Hidden tab where the agent asks for permission while inactive.
3. Emu unfocused while the user is in another app/browser and an agent asks for permission.
4. Same permission repeated quickly after approving/denying.

Expected findings:

- Scenario 1 should show `renderer-detected-prompt` followed by `main-prompt-queued` and `main-overlay-shown`.
- Scenario 2 may show `renderer-hidden-buffered` without a later `renderer-hidden-replay-scan`.
- Scenario 3 should still show `main-overlay-shown`; if it does not, the bug is likely in overlay display/focus behavior rather than detection.
- Scenario 4 may show `main-prompt-suppressed-recently-resolved`.

## Fix Plan

### 1. Make Permission Detection Independent Of Tab Visibility

Scan PTY output for permission prompts as it arrives for every live terminal session, whether or not that tab is visible.

Recommended behavior:

- Always feed incoming PTY data into a permission-detection path before deciding whether to render immediately or buffer hidden output.
- Do not require `isVisibleRef.current` to be true.
- Do not require the active Emu tab to be the tab that owns the PTY output.
- Do not require the Emu app window to have focus.
- Keep false-positive protection in the parser and agent-session/provider heuristics, not in tab visibility gates.

This is the central fix. The native popup should be driven by PTY session state, not by what the user is currently looking at.

### 2. Keep A Small Rolling Raw Permission Buffer

Add a short rolling buffer inside `AgentPermissionPromptDetector` or `TerminalPane.tsx` for recent raw PTY text.

Use it only for detection, with a cap such as `8_000` to `16_000` characters.

On each raw scan:

- Append normalized raw text.
- Parse the rolling tail, not just the current chunk.
- Clear or decay the buffer when a shell prompt/agent idle prompt is detected.

This makes raw detection resilient when question, details, and choices arrive in separate PTY chunks. It also gives hidden/background tabs a reliable popup path without waiting for xterm rendering.

### 3. Run Permission Detection During Hidden Output Replay

Update `replayHiddenOutput()` in `TerminalPane.tsx` so hidden replayed output is scanned after xterm renders it.

Recommended behavior:

- For each replay frame, call `terminal.write(chunk, callback)` instead of `terminal.write(chunk)` when permission scanning may be relevant.
- In the callback, run:
  - `detectPermissionPrompt(getPermissionScanText(AGENT_PERMISSION_TAIL_LINES), 'hidden-replay')`
- Schedule one or two short follow-up scans after replay finishes, because replay can batch large chunks.

This covers the fallback path where a prompt was missed when it first arrived but later becomes available through xterm replay.

Hidden replay detection should be treated as a backup safety net. The primary path should still be raw PTY detection when the prompt first arrives, even if the tab is hidden.

### 4. Add A Low-Confidence Approval-Menu Fallback

Extend `agentPermissionPrompts.ts` with a conservative fallback for rendered waiting menus:

- Requires:
  - `Do you want to proceed?` or equivalent.
  - At least one approve choice.
  - At least one deny choice.
- Allows the subject line to be missing or partially above the viewport.
- Emits a generic summary such as `Approval needed` or `Claude approval needed`.

Keep this fallback behind agent context/provider confidence so ordinary terminal output does not create false popups.

This favors showing a useful approval popup over silently missing a real waiting approval.

### 5. Improve Alternate-Screen Snapshot Coverage

For alternate-screen scans:

- Keep `getTerminalVisibleText(...)`.
- Also scan a cursor-centered active-buffer window when possible.
- Consider unioning visible rows with recent rolling raw text.

The parser should receive the largest safe snapshot of the current approval screen, not only one viewport-shaped slice at one exact repaint moment.

### 6. Revisit Recently-Resolved Suppression

Keep dedupe for pending prompts, but make resolved suppression harder to trigger incorrectly.

Options:

- Reduce `AGENT_PERMISSION_RESOLVED_SUPPRESSION_MS` from `2_000` to a shorter value such as `500`.
- Suppress only if the terminal has also produced evidence that the prompt disappeared.
- Log every suppression with enough context to verify whether it suppressed a real prompt.

I would start with logging first, then decide whether to change the suppression window.

### 7. Add Regression Coverage

Keep the existing parser fixture script, but add tests for the newly diagnosed cases:

- Prompt split across multiple raw chunks.
- Prompt arriving in a hidden/background tab.
- Prompt arriving while the Emu app is unfocused and another app/browser is active.
- Hidden replay path scanning a complete prompt after buffering.
- Claude approval menu with missing subject but clear approve/deny choices.
- Same fingerprint emitted again after disappearing and reappearing.
- Main-process suppression event does not happen for a still-waiting prompt after the suppression window.

The hidden replay behavior may need a small extracted helper or lightweight test harness, because it currently lives inside `TerminalPane.tsx`.

## Suggested Implementation Order

1. Add debug trace first.
2. Reproduce one miss and identify which gate fails.
3. Make permission detection independent of tab visibility.
4. Add rolling raw buffer.
5. Add hidden replay detection as a backup safety net.
6. Add low-confidence approval-menu fallback only if traces show incomplete rendered snapshots.
7. Tune resolved suppression only if traces show suppression of real waiting prompts.
8. Add regression tests around whatever failed in the trace.

## Verification Plan

Automated:

- `node scripts/verify-agent-permission-detector.mjs`
- `npm exec tsc -- --noEmit`
- `npm run build`
- `git diff --check`

Manual:

1. Launch Emu and start a Codex session.
2. Trigger a command approval while the tab is visible.
3. Trigger a command approval while the tab is hidden or inactive.
4. Trigger a command approval in one Emu tab while working in another Emu tab.
5. Trigger a command approval while Emu is not focused and the user is in another app/browser.
6. Confirm the popup appears without returning to the tab or pressing Enter in the terminal.
7. Repeat the same approval quickly and confirm it is not incorrectly suppressed.
8. Run the equivalent Claude approval flow, especially `Use skill "run"?`.
9. Confirm Approve still sends the selected approve action and Deny still selects the normal deny/cancel path.

## Acceptance Criteria

- If any Emu tab has a terminal approval prompt waiting for Enter, the native popup appears.
- The popup appears even when the relevant tab is hidden, inactive, or in the background.
- The popup appears even when the Emu app is not focused and the user is in another app/browser.
- Partial PTY chunks do not cause misses.
- Existing successful Codex and Claude prompt parsing continues to work.
- Duplicate scans do not create duplicate popup queue entries.
- Recent-resolution suppression does not hide a prompt that is still waiting for user input.
- Debug traces can explain any future miss without requiring guesswork.
