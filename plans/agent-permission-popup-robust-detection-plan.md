# Agent Permission Popup Robust Detection Plan

## Goal

Make Emu show the native permission popup whenever an agent session is waiting for user approval, even when the terminal prompt is wrapped, repainted, in a hidden tab, in an alternate-screen TUI, or missing footer text.

The product rule:

> If Codex or Claude is waiting for approval anywhere in Emu, the native popup should be visible and actionable.

## Hard Truth

The most robust mechanism is a structured permission event from the agent runtime.

Example ideal API:

```ts
{
  type: 'permission-requested',
  provider: 'codex',
  requestId: '...',
  summary: 'Run: node website/server.js',
  detail: 'Do you want to allow starting the local dashboard server...',
  approve: { kind: 'pty-write', data: 'y' },
  deny: { kind: 'pty-write', data: '\u001b' }
}
```

Emu does not currently receive that from Codex or Claude. Until that exists, the best practical design is layered detection:

1. Main-process PTY stream detection.
2. Renderer rendered-screen detection.
3. Terminal-menu normalization before parsing.
4. Conservative provider-specific parsers.
5. Miss logging for prompt-shaped text that failed to parse.

## Current Failure Mode

The screenshot from June 20, 2026 showed this Codex prompt:

```txt
Would you like to run the following command?

Reason: Do you want to allow starting the local
dashboard server on port 3000 for smoke testing?

$ node website/server.js

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that
     start with `node website/server.js` (p)
  3. No, and tell Codex what to do differently
     (esc)
```

The old detector expected `(esc)` on the same rendered line as the deny choice. The terminal wrapped `(esc)` to the next line, so the detector rejected a real prompt.

This means exact-line parsing is the wrong center of gravity. The detector should parse logical menu items, not raw terminal rows.

## Current Implementation Audit

Checked on June 20, 2026 against:

- `src/main/index.ts`
- `src/renderer/src/components/TerminalPane.tsx`
- `src/shared/agentPermissionPrompts.ts`
- `scripts/verify-agent-permission-detector.mjs`

| Capability | Status | Evidence | Keep Or Change |
| --- | --- | --- | --- |
| Main-process PTY stream detection | Already implemented | `scanAgentPermissionPtyOutput()` scans every PTY chunk before renderer batching and uses a 32 KB per-session raw tail. | Keep. Do not rebuild. |
| Provider/session inference in main | Already implemented | Main tracks provider from foreground process, launch command, and prompt text via `getAgentProviderFromProcess()`, `markAgentPermissionSessionFromCommand()`, and `inferProviderFromText()`. | Keep. |
| Renderer raw scan | Already implemented | `TerminalPane` calls `detectPermissionPrompt(data, 'raw')`. | Keep. |
| Renderer accumulated raw-buffer scan | Already implemented | `agentPermissionRawBufferRef` stores up to 32 KB and scans as `raw-buffer`. | Keep. |
| Rendered xterm scan after writes | Already implemented | `terminal.write(..., () => detectPermissionPrompt(getPermissionScanText(...), 'write-parsed'))`. | Keep. |
| Alternate-screen visible viewport scan | Already implemented | `getPermissionScanText()` uses `getTerminalVisibleText()` when `isAltScreenRef.current` is true. | Keep. |
| Delayed TUI repaint scans | Already implemented | `CLAUDE_PERMISSION_SCAN_DELAYS_MS = [0, 50, 150, 300]`; follow-up scans run after writes. | Keep. |
| Watchdog scan | Already implemented | `AGENT_PERMISSION_WATCHDOG_INTERVAL_MS = 500`, duration 30 seconds. | Keep. |
| Hidden-output replay scan | Already implemented | Hidden replay calls `detectPermissionPrompt(..., 'hidden-replay')`. | Keep. |
| Queue/dedupe/recently-resolved suppression | Already implemented | Main dedupes by `sessionId + fingerprint` and suppresses recently resolved prompts for 2 seconds. | Keep. |
| Codex command parser | Mostly implemented | Detects `Would you like to run the following command?`, no-footer cases, selected choices, and multiline commands. | Keep, but feed it logical lines. |
| Codex tool parser | Already implemented | Detects `Allow <app> to run/call/use tool "<tool>"?` and tool args. | Keep, but feed it logical lines. |
| Claude command parser | Already implemented | Detects Bash/shell command prompts and `Bash(command: "...")`. | Keep, but feed it logical lines. |
| Claude skill parser | Already implemented | Detects `Use skill "<name>"?` and `Skill(<name>)`; exact Claude screenshot fixture exists. | Keep, but feed it logical lines. |
| Generic fallback parser | Already implemented | `parseGenericAgentPermissionPrompt()` exists for provider-hinted approval menus. | Keep. |
| Full command fingerprinting | Already implemented for Codex commands | `fullCommandFromCodexBlock()` feeds `codex:command:` fingerprints, and tests assert different heredoc/body commands differ. | Keep. |
| Conservative PTY actions | Already implemented | Hotkeys, Enter, Escape, and arrow navigation are handled by `menuActionForChoice()`. | Keep. |
| Existing regression fixtures | Strong coverage already | Fixtures cover no-footer Codex, wrapped screenshot deny hotkey, multiline Codex, Codex tool, Claude command, Claude skill, stale provider hints, split chunks, simultaneous sessions, and false positives. | Add only missing fixture classes. |
| Logical wrapped-line normalization | Not implemented generally | Current code has a one-off next-line `(esc)` check in `extractCodexPromptBlock()`. There is no shared `logicalPromptLines()`. | Implement. This is the main remaining robustness work. |
| Debug miss log | Not implemented | Debug logs only print attempted scans when debug flags are enabled. There is no persisted `/tmp` miss log for permission-shaped nonmatches. | Implement, debug-only. |
| Structured runtime permission event | Not available | No Codex/Claude structured event integration exists. | Track as future ideal, not current scope. |

Bottom line: the scan architecture is already robust. The remaining work should not add another scan path. It should make the shared parser less row-fragile and make future misses observable.

## Design

### 1. Keep Main As The First Detector

Main owns the real PTY stream, so it should remain the first detection point.

File:

- `src/main/index.ts`

Behavior:

- Scan every PTY output chunk before batching it to the renderer.
- Maintain a bounded raw tail per session.
- Track provider from foreground process, launch command, and prompt text.
- Queue prompts directly from main when raw text is enough.
- Current status: already implemented.

Why:

- Works for hidden tabs.
- Works when renderer is not caught up.
- Works when Emu is backgrounded.
- Avoids depending on xterm render timing for normal prompts.

### 2. Keep Renderer As A Second Detector

Renderer still matters because TUIs repaint with cursor movement. Raw PTY text can be noisy, while xterm's active buffer is the clean "what the user sees" state.

File:

- `src/renderer/src/components/TerminalPane.tsx`

Behavior:

- After `terminal.write`, scan the rendered tail.
- In alternate screen, scan the visible viewport.
- Run delayed follow-up scans after TUI repaint bursts.
- Run the watchdog while an agent session is active.
- Current status: already implemented.

Why:

- Covers Claude/Codex TUI screens that are only clean after xterm processes cursor movement.
- Covers prompts where raw chunks arrive split or interleaved.

### 3. Normalize Terminal Screens Into Logical Lines

Add a small normalization stage before provider-specific parsing.

File:

- `src/shared/agentPermissionPrompts.ts`

New helper:

```ts
function logicalPromptLines(lines: string[]): string[]
```

Rules:

- Keep heading lines as-is.
- Join indented continuations onto the previous menu item.
- Join standalone hotkey lines like `(esc)` or `(y)` onto the previous menu item.
- Join wrapped reason/detail lines only while inside a known prompt block.
- Preserve command continuation lines after `$ ...` so multiline commands keep full fingerprints.

Example:

```txt
3. No, and tell Codex what to do differently
   (esc)
```

becomes:

```txt
3. No, and tell Codex what to do differently (esc)
```

This is the highest-value robustness improvement. It fixes this bug class once instead of adding one-off checks for every wrapped token.

Current status: not generally implemented. The code only has a narrow special case for `(esc)` on the next line in Codex command prompts.

### 4. Parse Approval Menus By Shape

After normalization, parse by structure.

Common shape:

- A prompt subject.
- Optional reason/detail text.
- Optional command/tool/skill block.
- At least one approve choice.
- At least one deny/cancel choice.
- Either a selected choice, a hotkey, or a submit/cancel footer.

Avoid requiring exact footer text. Footers often disappear below the viewport.

Avoid accepting generic prose. A random paragraph with "approval" should not trigger the popup.

Current status: mostly implemented. The missing piece is feeding parsers logical menu lines instead of raw rendered rows.

### 5. Provider-Specific Parsers

Keep separate parsers for Codex and Claude because their menus differ.

Codex command approvals:

- Subject: `Would you like to run the following command?`
- Command starts at `$ ...`
- Command continuation lines continue until menu choices.
- Approve choices include `Yes, proceed`.
- Deny choices include `No, and tell Codex...`

Codex tool approvals:

- Subject like `Allow <app> to run/call/use tool "<tool>"?`
- Detail lines contain tool args.
- Approve choices include `Allow`, `Allow for this session`, `Always allow`.
- Deny choice includes `Cancel`.

Claude command approvals:

- Subject includes `Bash command`, `Shell command`, or `Claude needs permission to use Bash`.
- Command may appear as `$ ...`, `Bash(command: "...")`, or `Command: ...`.
- Approve/deny choices may use arrows rather than hotkeys.

Claude skill/tool approvals:

- Subject includes `Use skill "<name>"?`, `Skill(<name>)`, or tool-use language.
- Detail text can be long and wrapped.
- Approve/deny action should navigate from the selected menu item when no hotkey exists.

Current status: already implemented for the known prompt classes. Do not rewrite this wholesale.

### 6. Fingerprint Full Requests

Fingerprints should include enough request detail to avoid collapsing distinct prompts.

Rules:

- For commands, fingerprint the full command block, not only the first line.
- For tools, fingerprint provider, app/tool name, and normalized argument preview.
- For skills, fingerprint provider and skill name.
- Include session ID outside the fingerprint key, as main already does.

Why:

- Two prompts with the same first command but different arguments must both show.
- Repaints of the same prompt must not duplicate.

Current status: already implemented for Codex multiline commands and queue dedupe. Keep it.

### 7. Keep Actions Conservative

The popup should send the smallest reliable PTY input.

Rules:

- Prefer explicit hotkey when visible: `(y)` sends `y`, `(esc)` sends escape.
- If a selected approve row is visible and no hotkey exists, send Enter.
- If denying and footer says `esc to cancel`, send escape.
- Otherwise navigate from selected row to the target row, then Enter.

Do not add "always allow" to the popup yet. It is useful, but it is not required for reliable permission notification.

Current status: already implemented. Keep it.

### 8. Add Miss Logging

Add a debug-only miss log for text that looks permission-shaped but fails parsing.

Trigger when all are true:

- Session is known or suspected Codex/Claude.
- Text contains approval/menu markers.
- Text contains at least two numbered choices or a submit/cancel footer.
- No parser emits a prompt.

Destination:

- `/tmp/emu-agent-permission-misses.log`

Content:

- Timestamp.
- Session ID.
- Provider hint.
- Source: `main-pty`, `renderer-raw`, `renderer-rendered`, `watchdog`.
- Sanitized last 80 logical lines.

Sanitization:

- Strip ANSI.
- Limit length.
- Redact obvious tokens/secrets with conservative regexes.

Why:

- The next missed popup becomes a fixture, not a guessing exercise.

Current status: not implemented. This is the second useful remaining improvement.

### 9. Tests

Extend:

- `scripts/verify-agent-permission-detector.mjs`

Required fixtures:

- Codex command, normal footer. Already present.
- Codex command, no footer. Already present.
- Codex command with `(esc)` wrapped to next line. Already present.
- Codex command with approve hotkey wrapped.
- Codex multiline command with heredoc. Already present.
- Codex tool connector prompt. Already present.
- Claude Bash prompt. Already present.
- Claude skill prompt. Already present.
- Claude prompt with long wrapped detail text.
- Hidden-tab raw prompt chunks split across writes. Split raw chunks are already present; hidden-tab behavior is covered by architecture, not a pure parser unit test.
- Stale provider hint: Codex prompt while provider hint says Claude, and vice versa. Already present.
- False positive: documentation snippet of a prompt without active selected/menu evidence. Already present.
- False positive: generic `Do you want to proceed?` prose. Already present.

Keep this as one script. No test framework needed.

## Implementation Steps

1. Add `logicalPromptLines()` in `src/shared/agentPermissionPrompts.ts`.
2. Make Codex and Claude parsers consume logical lines.
3. Replace one-off wrapped `(esc)` handling with normalized menu-line parsing.
4. Add only missing fixtures:
   - approve hotkey wrapped to the next line
   - Claude long wrapped detail
   - any parser edge case found while converting to logical lines
5. Add debug-only miss logging.
6. Run:

```sh
node scripts/verify-agent-permission-detector.mjs
npm run build
```

## Acceptance Criteria

- The June 20 `node website/server.js` screenshot prompt triggers the popup.
- Hidden-tab prompts still trigger from existing main PTY scanning.
- Rendered alternate-screen prompts still trigger from existing renderer scanning.
- Wrapped menu hotkeys do not break detection.
- Missing footers do not break detection when selected choices are visible.
- Multiline commands produce distinct fingerprints.
- Ordinary terminal output does not create approval popups.
- Miss logging can capture future unknown prompt shapes when debug mode is enabled.

## What Not To Build Yet

- A full terminal emulator parser inside the detector.
- A new dependency.
- A popup UI for persistent approval choices.
- A background OCR/screenshot reader.

Those are heavier than the problem requires. The next real upgrade after this plan should be a structured permission event from Codex/Claude, if that becomes available.
