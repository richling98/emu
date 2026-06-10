# Agent Permission Popup Fix Plan

## Problem

The current approval popup implementation is not reliable enough to ship.

Observed behavior during preview testing:

- One real Codex approval prompt produced many popup notifications.
- Popup summaries included stale text from earlier agent output instead of the active permission request.
- Clicking **Approve** did not approve the active permission. It effectively canceled/reset the prompt.
- The native popup no longer crashes/reloads the app in preview, but the detector/action logic is wrong.

The feature still needs to remain a native always-on-top macOS popup. Moving the approval UI into the main Emu window is not acceptable.

## Likely Root Causes

1. **Detector uses a rolling output tail**
   - `AgentPermissionPromptDetector` appends raw PTY chunks and rendered tail text into one long `tail`.
   - When a prompt appears, stale lines from previous agent output are still present.
   - The summary and fingerprint can be built from old context rather than the current prompt block.

2. **Detector is too generic**
   - It searches for broad words like `allow`, `tool`, `plan`, and `yes`.
   - Normal agent output can look like a permission prompt.
   - This explains multiple notifications for one real prompt.

3. **Prompt identity is unstable**
   - Fingerprint is currently built from a slice of the rolling tail.
   - Small screen changes or repeated rendered-tail scans can generate different fingerprints for the same active prompt.
   - Main process dedupe cannot work if the renderer emits different prompt IDs/fingerprints.

4. **Approve/deny action mapping is inferred too loosely**
   - Current code derives actions from generic selected/choice positions.
   - The observed Codex prompt explicitly shows hotkeys:
     - `Yes, proceed (y)`
     - `Yes, and don't ask again ... (p)`
     - `No ... (esc)`
   - For that prompt, **Approve** should send `y`, and **Deny** should send Escape. It should not depend on Enter or arrow position.

5. **No fixture-backed parser**
   - The implementation was not validated against actual prompt screen text before being tested manually.
   - We need parser fixtures for the exact prompt formats before trying to rely on the popup.

## Design Direction

Keep the native popup architecture, but replace the detector and action derivation.

The popup should only appear when Emu can parse a complete, active permission prompt. If parsing is uncertain, Emu should not show a popup.

## Proposed Fix

### 1. Replace Rolling-Tail Detection With Snapshot Parsing

Stop detecting from a cumulative output tail.

Instead, each detection pass should operate on a bounded snapshot:

- For visible/alt-screen terminals: parse the current rendered xterm tail only.
- For hidden terminals: parse only the latest raw PTY chunk window since the last prompt boundary, not all prior session history.

The detector should expose a method like:

```ts
detectAgentPermissionPrompt(input: {
  sessionId: string
  providerHint: 'codex' | 'claude' | null
  renderedText: string
  rawText?: string
}): AgentPermissionPrompt | null
```

It should not keep an ever-growing text tail for summary generation.

### 2. Add Provider-Specific Parsers

Create exact parser functions:

```ts
parseCodexPermissionPrompt(text): ParsedPermissionPrompt | null
parseClaudePermissionPrompt(text): ParsedPermissionPrompt | null
```

The generic detector should only choose which parser to run.

### 3. Codex Parser Requirements

Support the observed Codex prompt:

```text
Would you like to run the following command?

Reason: Allow the Electron/Vite dev server to bind to localhost so you can test the app.

$ npm run dev

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with `npm run dev` (p)
  3. No, and tell Codex what to do differently (esc)

Press enter to confirm or esc to cancel
```

Parser output should be:

```ts
{
  provider: 'codex',
  kind: 'command',
  summary: 'Run: npm run dev',
  detail: 'Allow the Electron/Vite dev server to bind to localhost so you can test the app.',
  fingerprint: 'codex:command:npm run dev',
  approveAction: [{ data: 'y' }],
  denyAction: [{ data: '\x1b' }]
}
```

Rules:

- Summary should come from the command line or permission target, not old surrounding output.
- `rawExcerpt` should include only the active prompt block.
- **Approve** should use the explicit prompt hotkey `y` when present.
- **Deny** should use the explicit prompt hotkey `esc` when present.
- Ignore the `don't ask again` option for now.

### 4. Claude Code Parser Requirements

Add fixture-based support for Claude Code prompts after capturing one real prompt in Emu.

Expected behavior:

- Parse only a complete prompt block.
- Summary should be one short sentence, such as:
  - `Run: <command>`
  - `Edit: <path>`
  - `Allow tool: <tool name>`
- Approve/deny actions should use the prompt's explicit hotkeys when visible.
- If explicit hotkeys are not visible, fall back only to a known, tested Claude Code sequence.

### 5. Main Process Queue Rules

Keep the native popup window, but tighten queue behavior:

- Use `fingerprint` as the stable prompt identity.
- For the same `sessionId`, `provider`, and `fingerprint`, keep exactly one pending prompt.
- If a newer prompt from the same session has a different fingerprint, replace the older pending prompt from that session unless the older one is still explicitly visible in the terminal.
- Do not play a chime for duplicate prompt refreshes.
- Do not create multiple queue entries from repeated render scans of the same prompt.

### 6. Popup Copy

Popup should show:

- Title: `Codex needs approval` or `Claude Code needs approval`.
- Summary: one short line, for example `Run: npm run dev`.
- Detail: optional one-line reason, if parsed.

It should not show a large excerpt by default. The current excerpt behavior made stale text more visible and less useful.

Recommended layout:

```text
Codex needs approval                    1 of 1  < >
Run: npm run dev
Allow the Electron/Vite dev server to bind to localhost.

[Deny] [Approve]
```

### 7. Tests Before Manual Retest

Add fixture tests for the detector before testing in the app.

If the repo does not already have a test runner, add a small Node script under `scripts/` that imports/executes parser fixtures through TypeScript-compatible build output or a plain JS helper.

Minimum fixtures:

- Codex command approval prompt from the screenshot.
- Same Codex prompt scanned repeatedly 10 times should emit one prompt.
- Codex prompt with old agent output before it should still summarize only the active prompt.
- Codex approve action should be `y`.
- Codex deny action should be Escape.
- Non-permission agent output with words like `allow`, `plan`, and `tool` should not emit.

### 8. Manual Validation

Run in production-style preview, not Vite dev HMR:

```bash
npm run preview
```

Manual test cases:

- Trigger the observed Codex command approval prompt.
- Confirm exactly one popup appears.
- Confirm popup summary says `Run: npm run dev` or equivalent.
- Click **Approve** and confirm Codex proceeds.
- Trigger the same prompt again.
- Click **Deny** and confirm Codex receives normal denial/cancel behavior.
- Trigger two different pending approvals and confirm queue navigation works.
- Confirm Emu sessions do not reset.

## Implementation Steps

1. Refactor `src/renderer/src/agentPermissionPrompts.ts` into exact provider parsers.
2. Change `TerminalPane.tsx` to pass current rendered snapshot text instead of appending rendered text to a rolling detector tail.
3. Update main-process dedupe to key by `sessionId + fingerprint`.
4. Simplify popup display fields to `summary` and optional `detail`.
5. Add fixture tests or a parser verification script.
6. Run `npm exec tsc -- --noEmit`.
7. Run `npm run build`.
8. Run `npm run preview` and manually validate with the observed Codex prompt.

## Non-Goals For This Fix

- Do not add an in-main-window approval UI.
- Do not add "always allow" support yet.
- Do not attempt broad natural-language detection of all possible prompts.
- Do not show a popup unless the active prompt block is parsed with high confidence.

## Open Questions

1. Should the popup detail include the reason line, the command line, or both when space is tight?
2. Should **Approve** for Codex always use `y` when visible, even if the first option is highlighted and Enter would also work?
3. For queue behavior, should a newer prompt from the same session replace the older one, or should both remain if fingerprints differ?
