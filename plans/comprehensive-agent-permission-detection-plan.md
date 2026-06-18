# Comprehensive Agent Permission Detection Plan

## Goal

Make Emu show the native permission popup whenever Codex or Claude is waiting on an approval menu, not only when the prompt says:

```txt
Would you like to run the following command?
```

The desired behavior is:

- Codex command approvals trigger the popup.
- Codex app connector and tool approvals trigger the popup.
- Claude command, tool, and skill approvals trigger the popup.
- Hidden tabs, background windows, and TUI redraw timing do not prevent detection.
- Approve and deny actions send the correct keystrokes for the specific menu shape.
- False positives remain low enough that ordinary terminal output does not create approval popups.

## Working Assumption

Emu does not currently receive a structured "permission requested" event from Codex or Claude. Codex and Claude run inside a PTY, so Emu primarily sees terminal bytes, rendered xterm state, and foreground process/session state.

The "dialogue pop-up thing" from Codex or Claude is terminal-rendered TUI UI. The reliable product-level approach is therefore to detect the terminal approval menu structure, not a single exact prompt phrase.

If a future Codex or Claude integration exposes a structured permission event, Emu should prefer that event. Until then, permission detection should be implemented as a conservative terminal approval-menu parser.

## Current Gap

The current Codex parser in `src/shared/agentPermissionPrompts.ts` only detects the old command approval shape:

```txt
Would you like to run the following command?
```

It then requires:

- A `$ ...` command line.
- A `Yes, proceed (y)` choice.
- A `No ... (esc)` choice.
- A confirmation hint such as `Press enter to confirm`.

The Outlook screenshot is a different Codex approval class:

```txt
Field 1/1
Allow Microsoft Outlook Email to run tool "microsoft outlook email_draft_email"?

subject: Joint CSP Startup Summary
text_content: <div style="font-family: Arial, Helvetica, sans-serif; co...
to: [{"email": "rling@nvidia.com", "name": "Richard Ling"}]

> 1. Allow                  Run the tool and continue.
  2. Allow for this session  Run the tool and remember this choice for this session.
  3. Always allow            Run the tool and remember this choice for future tool calls.
  4. Cancel                  Cancel this tool call
enter to submit | esc to cancel
```

That prompt does not contain the old Codex command phrase, does not contain a `$ ...` command, and uses Enter for the selected approval row rather than `y`.

There is a second gap for old-style command approvals: multiline commands are parsed and fingerprinted too narrowly.

For this prompt shape:

```txt
Would you like to run the following command?

Reason: Do you want to allow Outlook read access so I can verify the company hyperlinks saved in the draft?

$ outlook-cli message read
'AAMk...' --no-markdown --json > /tmp/joint_csp_draft_readback.json && python3 -
<<'PY'
import json
body=json.load(open('/tmp/joint_csp_draft_readback.json'))['data']['body']
...
PY

> 1. Yes, proceed (y)
  2. No, and tell Codex what to do differently (esc)

Press enter to confirm or esc to cancel
```

The current parser extracts only:

```txt
outlook-cli message read
```

That produces this fingerprint:

```txt
codex:command:outlook-cli message read
```

This means two distinct Outlook read approvals in the same session can look identical to Emu if they share the same first command line. If the first one is still pending, the second can be deduped into the existing entry. If the first one was just approved or denied, the second can be suppressed by the recently-resolved suppression window.

## Design Direction

Move from phrase-specific parsing to a small approval-menu grammar:

1. Detect that the terminal screen contains a waiting approval menu.
2. Extract the subject, details, choices, selected row, and footer.
3. Classify the menu as Codex, Claude, or known-agent fallback.
4. Compute approve and deny keystrokes from the actual choices.
5. Produce a stable fingerprint that dedupes redraws without suppressing distinct approvals.

This should cover new Codex and Claude wording without broad keyword matching.

## Parser Model

Introduce a provider-neutral parser layer in `src/shared/agentPermissionPrompts.ts`:

```ts
interface ApprovalMenu {
  providerHint: 'codex' | 'claude' | null
  subject: string
  details: string[]
  choices: ApprovalChoice[]
  footer: string | null
  confidence: 'high' | 'medium'
}

interface ApprovalChoice {
  index: number | null
  label: string
  description: string
  kind: 'approve' | 'approve-session' | 'approve-always' | 'deny'
  selected: boolean
  hotkey: string | null
}
```

The parser should normalize ANSI escape codes and box drawing characters using the existing terminal text normalization, then identify approval-menu blocks from recent raw PTY text or rendered xterm text.

## Approval Menu Requirements

A high-confidence approval menu should require all of:

- A permission/action subject line.
- At least one approve-like choice.
- At least one deny/cancel-like choice.
- Evidence that the UI is waiting for a choice, such as:
  - `enter to submit`
  - `press enter to confirm`
  - `esc to cancel`
  - visible selected menu marker such as `>`, `›`, or `❯`

Subject line examples:

```txt
Would you like to run the following command?
Allow Microsoft Outlook Email to run tool "microsoft outlook email_draft_email"?
Claude needs permission to use Bash
Use skill "run"?
Do you want to allow this command?
Bash command
Tool use
```

Do not accept generic text like this by itself:

```txt
Do you want to proceed?
```

That phrase is too broad unless it appears with a clear agent/tool/permission subject and approve/deny choices.

## Choice Classification

Classify approve choices from labels such as:

- `Yes`
- `Approve`
- `Allow`
- `Proceed`
- `Continue`

Classify session or persistent approval variants separately:

- `Allow for this session`
- `Yes, and don't ask again for this session`
- `Always allow`
- `Yes, and don't ask again`

Classify deny choices from labels such as:

- `No`
- `Deny`
- `Reject`
- `Cancel`

The default popup action should usually choose the first normal approve row, not the persistent approval row. Persistent choices can remain terminal-only unless Emu later adds explicit popup buttons for "allow session" and "always allow."

## Keystroke Mapping

Do not hardcode Codex approval to `y`.

For approve:

1. If the selected approve row is the desired row, send `\r`.
2. Else if the desired approve row has a hotkey, send that hotkey.
3. Else send arrow movements from the selected row to the desired row, then `\r`.
4. If no selection is visible, prefer a known hotkey; otherwise fall back to `\r` only for high-confidence menus where the first approve row is conventionally selected.

For deny:

1. Prefer `esc` if the footer or choice says `esc to cancel`.
2. Else if the deny row has a hotkey, send that hotkey.
3. Else navigate to the deny row and press `\r`.

For the Outlook screenshot:

- Approve action should be `[{ data: '\r' }]`.
- Deny action should be `[{ data: '\x1b' }]`.

## Provider-Specific Extractors

Keep provider-specific summaries and fingerprints, but build them on top of the generic approval menu.

### Codex Command Approval

Detect:

```txt
Would you like to run the following command?
$ npm run dev
```

Summary:

```txt
Run: npm run dev
```

Fingerprint source:

```txt
codex:command:<normalized full command block>
```

For multiline commands, capture the full command block from the `$ ...` line through the line before the first approval choice. Include continuation lines, heredoc markers, and arguments. The visible popup summary can stay short, but the fingerprint must use the full normalized command block.

Summary:

- First line only, compacted for display.

Detail:

- Reason line if present.
- Optionally include a short note such as `Multiline command` when the command block has more than one line.

### Codex App Connector Or Tool Approval

Detect:

```txt
Allow <app name> to run tool "<tool name>"?
```

Also allow close variants such as:

```txt
Allow <app name> to call tool "<tool name>"?
Allow <app name> to use tool "<tool name>"?
```

Summary:

```txt
Run tool: Microsoft Outlook Email / microsoft outlook email_draft_email
```

Detail:

Use visible field lines, trimmed to the existing detail limit:

```txt
subject: Joint CSP Startup Summary
to: [{"email": "rling@nvidia.com", "name": "Richard Ling"}]
```

Fingerprint source should include:

- provider
- app name
- tool name
- normalized detail field names and values

This prevents two different `draft_email` approvals from deduping incorrectly.

### Claude Command Approval

Detect:

```txt
Bash command
$ npm run dev
```

Or:

```txt
Claude needs permission to use Bash
Bash(command: "npm test")
```

Summary:

```txt
Run: npm run dev
```

Fingerprint source:

```txt
claude:command:<normalized command>
```

### Claude Skill Approval

Detect:

```txt
Use skill "run"?
```

Or:

```txt
Skill(run)
```

Summary:

```txt
Use skill: run
```

Fingerprint source:

```txt
claude:skill:<normalized skill name>
```

### Known-Agent Fallback

If the session is already known to be Codex or Claude, and the screen has a high-confidence approval menu but no extractor can identify a command, tool, or skill, emit a generic prompt:

```txt
Approval needed
```

The fingerprint should use a normalized subject plus choice labels and a small amount of detail text.

This fallback should be gated behind known agent session/provider state to avoid false positives.

## Provider Inference

Update `inferProviderFromText` so known approval shapes can trigger detection even if the output does not literally contain `Codex` or `Claude`.

Codex-like signals:

- `Would you like to run the following command?`
- `Allow ... to run tool "..."`
- `Field 1/1` plus `Allow ...` plus `enter to submit | esc to cancel`

Claude-like signals:

- `Claude needs permission`
- `Use skill "..."`
- `Skill(...)`
- `Bash(command: "...")` with approve/deny menu context

This matters because `AgentPermissionPromptDetector.append(...)` currently short-circuits when Emu has not yet marked the terminal as an agent session and cannot infer a provider from the text.

## Detection Sources

Keep both detection paths.

### Main-Process Raw PTY Scan

This is the primary path. It works for hidden tabs and background windows because it scans output before renderer visibility decisions.

Requirements:

- Keep a bounded rolling raw tail per session.
- Parse the accumulated tail, not only the latest PTY chunk.
- Continue deduping by `sessionId + fingerprint`.

### Renderer Parsed-Screen Scan

This is the fallback path. It catches cases where a TUI redraw is hard to read from raw ANSI output but appears clearly in xterm's rendered buffer.

Requirements:

- Scan after `terminal.write(data, callback)` confirms xterm has parsed the data.
- Keep watchdog scans while an agent session is active.
- Include hidden-output replay scans where applicable.

## False Positive Strategy

The parser should be permissive about wording but strict about structure.

Good signals:

- agent session or provider is known
- subject mentions approval, permission, allow, command, bash, tool, skill, MCP, file, edit, write, or network
- choices include both approve and deny/cancel semantics
- UI footer indicates Enter/Esc behavior
- selected row marker is visible

Bad signals:

- ordinary prose mentioning approval
- markdown plans that include examples of approval prompts
- generic `Do you want to proceed?` without a specific permission subject
- shell output containing `Allow` but no choices

When in doubt, require agent-session confidence before emitting a generic fallback.

## Debug Capture For Unknown Future Menus

Add an opt-in debug mode under the existing `EMU_DEBUG_AGENT_PERMISSION=1` behavior.

When an agent session is active and the screen looks menu-like but does not parse, log a sanitized candidate snapshot:

- session id
- provider hint
- source: raw, raw-buffer, write-parsed, watchdog, hidden-replay
- normalized tail excerpt
- reason parsing failed, if available

This gives future fixture material when Codex or Claude changes prompt wording again.

## Test Fixtures

Extend `scripts/verify-agent-permission-detector.mjs` with fixtures for:

- Existing Codex command approval.
- Multiline Codex command approval where the first line alone is not unique.
- Two multiline Codex approvals with the same first line but different continuation lines, asserting their fingerprints differ.
- Codex Outlook connector approval from the screenshot.
- Codex connector approval with `Allow for this session` and `Always allow`.
- Claude Bash command approval.
- Claude hotkey approval.
- Claude skill approval.
- Prompt split across PTY chunks.
- Stale provider hint cases.
- No agent session, but prompt shape infers provider.
- Known agent session fallback approval menu.
- False-positive prose containing approval words.
- False-positive docs or plans containing example approval text.
- False-positive generic `Do you want to proceed?` without a permission subject.

Expected Outlook fixture assertions:

```ts
assert(parsed, 'Codex Outlook tool prompt should parse')
assert.equal(parsed.provider, 'codex')
assert.equal(parsed.summary, 'Run tool: Microsoft Outlook Email / microsoft outlook email_draft_email')
assert.deepEqual(parsed.approveAction, [{ data: '\r' }])
assert.deepEqual(parsed.denyAction, [{ data: '\x1b' }])
```

Expected multiline command fixture assertions:

```ts
assert(parsed, 'multiline Codex command prompt should parse')
assert.equal(parsed.summary, 'Run: outlook-cli message read')
assert(parsed.fingerprint.includes('outlook-cli message read'))
assert.notEqual(firstReadPrompt.fingerprint, secondReadPrompt.fingerprint)
```

## Implementation Order

1. Add generic approval-menu parsing helpers in `src/shared/agentPermissionPrompts.ts`.
2. Add choice classification and generic menu-action computation.
3. Reimplement existing Codex command parser on top of the menu parser, including full multiline command-block extraction for fingerprints.
4. Reimplement existing Claude command and skill parser on top of the menu parser.
5. Add Codex app connector/tool approval extractor.
6. Update provider inference for approval-menu shapes.
7. Add screenshot-based Outlook fixture and make it pass.
8. Add false-positive fixtures and make them pass.
9. Add debug logging for menu-like misses behind `EMU_DEBUG_AGENT_PERMISSION=1`.
10. Run automated validation.
11. Manually verify with real Codex and Claude sessions.

## Verification

Run:

```bash
node scripts/verify-agent-permission-detector.mjs
npm exec tsc -- --noEmit
npm run build
```

Manual verification:

1. Start Emu from this repo.
2. Start a Codex session.
3. Trigger an ordinary command approval.
4. Confirm the native popup appears and approve runs the command.
5. Trigger a Codex app connector/tool approval like the Outlook draft-email prompt.
6. Confirm the native popup appears and approve sends Enter to run the selected `Allow` row.
7. Confirm deny sends Esc and cancels the tool call.
8. Start a Claude session.
9. Trigger a Bash approval.
10. Confirm popup approve/deny works.
11. Trigger a skill approval.
12. Confirm popup approve/deny works.
13. Repeat at least one Codex and one Claude approval while the tab is hidden.
14. Repeat while Emu is not focused.
15. Trigger two approvals in separate sessions and confirm both appear in the global popup queue.

## Acceptance Criteria

- Any active Codex or Claude approval menu in any Emu terminal session opens the native permission popup.
- The Outlook connector prompt from the screenshot opens the popup.
- The popup approve action sends the correct keystroke for each menu shape.
- The popup deny action cancels each menu shape.
- Existing command and skill approval behavior does not regress.
- Hidden tab and background app cases still work.
- Duplicate TUI redraws do not create duplicate queued prompts.
- Distinct approvals with the same tool name but different fields do not incorrectly dedupe.
- Detector fixtures cover both successful parse cases and false-positive cases.
