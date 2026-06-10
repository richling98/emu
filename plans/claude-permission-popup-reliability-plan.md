# Claude Permission Popup Reliability Plan

## Goal

Make the native macOS approval popup fire reliably for Claude Code permission prompts, including the observed `Use skill "run"?` prompt, while preserving the currently working Codex behavior.

The popup must:

- Appear as the native always-on-top overlay, not inside the Emu window.
- Summarize the active Claude permission briefly, for example `Use skill: run`.
- Approve by sending the terminal action that selects `Yes`.
- Deny by sending the terminal action that selects `No` or the normal cancel/deny action.
- Queue multiple pending permissions and expose them through the existing arrow navigation.

## Observed Failing Prompt

From the screenshot captured on June 10, 2026 at 1:21 AM:

```text
Claude Code v2.1.170

> please run npm run dev

● Skill(run)

Use skill "run"?
Claude may use instructions, code, or files from this Skill.

Launch and drive this project's app to see a change working. Use when asked to run, start, or screenshot the app,
or to confirm a change works in the real app (not just tests). First looks for a project skill that already
covers launching the app; otherwise falls back to built-in patterns per project type (CLI, server, TUI, Electron,
browser-driven, library).

Do you want to proceed?
› 1. Yes
  2. Yes, and don't ask again for run in /Users/rling/Documents/Vibing/Emu-dev
  3. No

Esc to cancel · Tab to amend
```

Codex approval prompts currently trigger the popup. This exact Claude prompt does not.

## Working Theory

The parser already has fixture coverage for a simplified `Use skill "run"?` prompt, so the likely issue is not just a missing regex.

More likely failure points:

1. **The detector is not seeing the rendered Claude approval text.**
   Claude runs in an alternate-screen TUI. Emu currently checks raw PTY data and then a rendered xterm tail. The rendered tail may be captured before Claude has fully repainted, from the wrong buffer, or from too few lines.

2. **The active prompt text may be wrapped differently in the real xterm buffer.**
   The screenshot shows long wrapped text. `getTerminalTailText()` reads logical xterm buffer lines, but Claude may use cursor movement and repainting that makes the raw stream noisy while the rendered buffer is correct only after a short delay.

3. **Claude detection is too implicit.**
   The detector depends on session/provider inference plus prompt parsing. Claude should have its own stronger prompt scanner that can detect approval menus by shape:
   `Use skill ...?` + `Do you want to proceed?` + `1. Yes` + `3. No`.

4. **There is not enough runtime visibility.**
   Tests prove the parser handles fixture text, but we do not currently log or persist what text the detector actually receives when a live Claude prompt is visible.

## Implementation Plan

### 1. Add Temporary Detector Debug Capture

Add a development-only debug mechanism around `detectPermissionPrompt()` in [TerminalPane.tsx](../src/renderer/src/components/TerminalPane.tsx).

When `process.env.NODE_ENV !== 'production'` or a local debug flag is enabled, capture:

- Session id.
- Current provider hint.
- `agentSession` boolean.
- Whether the terminal is in alternate screen.
- Whether detection was run on raw PTY data or rendered tail.
- The normalized text snapshot passed into `AgentPermissionPromptDetector`.
- The detector result or reason for no match.

Write this to `console.debug` first. If console output is not easy to inspect in the Electron preview, add an IPC endpoint that writes a bounded debug log to `/tmp/emu-agent-permission-debug.log`.

Why this matters: the screenshot is parseable. We need to confirm whether the detector receives that text live.

### 2. Make Rendered Tail Detection More Robust For Claude TUI

Today Emu schedules one rendered-tail scan immediately after `terminal.write(data)`.

For Claude Code sessions, add a short burst of rendered-tail scans after each PTY data event:

- Immediately after write.
- After ~50 ms.
- After ~150 ms.
- After ~300 ms.

Each scan should read from `terminal.buffer.active`, so alternate-screen content is included while Claude is active.

Keep duplicate suppression in `AgentPermissionPromptDetector` so the burst cannot create multiple popups for the same permission.

Why this matters: Claude repaints TUI screens with cursor movement. A single scan can happen before the final approval menu is fully rendered.

### 3. Increase Claude Snapshot Depth

For rendered-tail scans during Claude sessions, capture more lines than the current 28-line tail.

Use 60 lines for Claude approval detection. Keep Codex behavior unchanged unless the same helper is shared safely.

Why this matters: Claude approval screens include the header, user prompt, tool/skill preview, explanatory text, choices, and footer. The actionable `Use skill "run"?` line can sit far above the cursor depending on terminal height and wrapping.

### 4. Add A Dedicated Claude Approval Screen Parser

Extend [agentPermissionPrompts.ts](../src/renderer/src/agentPermissionPrompts.ts) with a Claude-specific parser that works from the shape of the screen, not only generic command/tool keywords.

It should support:

- Skill approvals:
  - `● Skill(run)`
  - `Use skill "run"?`
  - `Do you want to proceed?`
  - `1. Yes`, `2. Yes, and don't ask again...`, `3. No`
- Bash/tool approvals:
  - `Bash command`
  - `Bash(command: "...")`
  - `Do you want to proceed?`
- Future Claude permission prompts with:
  - `Do you want to proceed?`
  - at least one approve choice
  - at least one deny choice
  - a nearby permission subject line

For the observed prompt, produce:

```ts
{
  provider: 'claude',
  summary: 'Use skill: run',
  fingerprint: 'claude:skill:run',
  approveAction: [{ data: '\r' }],
  denyAction: [{ data: '\x1b[B\x1b[B' }, { data: '\r' }]
}
```

The deny action assumes choice 1 is selected and choice 3 is normal deny. If Claude exposes `Esc to cancel`, we should keep using the menu `No` path for Deny because the user asked for the normal denial keystroke, not task interruption.

### 5. Preserve Provider Fallbacks

Keep the recent fix where explicit prompt text wins over stale provider hints.

Detection order should be:

1. If the text clearly looks like Codex, parse as Codex first.
2. If the text clearly looks like Claude, parse as Claude first.
3. If no provider is explicit, prefer the current session provider hint.
4. Fall back to the other parser before giving up.

This prevents future Claude fixes from breaking Codex again.

### 6. Strengthen Queue Behavior For Multiple Claude Permissions

No major main-process redesign should be needed because the queue already lives in `src/main/index.ts`.

Still verify:

- Two different Claude prompts produce two different fingerprints.
- Duplicate scans for the same Claude prompt update the existing queue item instead of adding copies.
- Resolving prompt 1 removes it and automatically displays prompt 2.
- Arrow navigation works while both prompts are pending.

If needed, expose a small test-only helper around the main-process queue state, or add a narrow integration fixture that sends two fake `agent-permission:show` IPC payloads.

### 7. Add Regression Fixtures

Update [scripts/verify-agent-permission-detector.mjs](../scripts/verify-agent-permission-detector.mjs) with the exact screenshot text, not a shortened approximation.

Add tests for:

- Exact Claude `Use skill "run"?` prompt from the screenshot.
- Same prompt with long wrapped description text.
- Same prompt with the `›` selection marker stripped or replaced.
- Same prompt with stale `codex` provider hint.
- Codex `npm run dev` prompt with stale `claude` provider hint.
- Two different Claude prompts emitted sequentially by one detector instance.

### 8. Manual Verification

After implementation:

1. Run `node scripts/verify-agent-permission-detector.mjs`.
2. Run `npm exec tsc -- --noEmit`.
3. Run `npm run build`.
4. Relaunch `npm run preview`.
5. In Codex inside Emu, trigger `npm run dev`; confirm popup still appears.
6. In Claude inside Emu, trigger:

   ```text
   please run npm run dev
   ```

   Confirm `Use skill: run` popup appears.

7. Click Approve on the Claude popup and confirm Claude proceeds.
8. Trigger the same Claude permission again, click Deny, and confirm Claude receives the normal denial.
9. Trigger two pending approvals in separate tabs and confirm the popup shows `1 of 2`, arrow navigation works, and approving one advances to the next.

## Acceptance Criteria

- Codex approval popup still works.
- Claude `Use skill "run"?` approval popup appears reliably.
- Claude popup summary is short and correct: `Use skill: run`.
- Claude Approve selects the visible `Yes` option.
- Claude Deny selects the visible `No` option.
- Duplicate Claude screen repaints do not create duplicate popups.
- Multiple pending permissions remain queued and navigable.
- Detector tests cover the exact screenshot prompt text.

## Open Questions

None blocking. The screenshot provides enough detail to proceed.

One implementation choice to confirm after testing: whether Claude Deny should select `3. No` with arrow navigation or send `Esc`. The plan uses `3. No` because that best matches the requested normal denial behavior.
