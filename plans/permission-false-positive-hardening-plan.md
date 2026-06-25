# Agent Permission Popup False-Positive Hardening Plan

## Context

During dev-app testing after the CPU/GPU optimizations, opencode produced permission popups during a simple browse task that were not active permission prompts.

Screenshots reviewed:

- `/Users/richardling/Desktop/Screenshot 2026-06-25 at 12.34.39 AM.png`
- `/Users/richardling/Desktop/Screenshot 2026-06-25 at 12.34.46 AM.png`

Observed false popups:

- Popup 1 of 2: `Run: if test -x ~/.claude/skills/gstack/browse...; then echo "READY_USER"; else echo "NEEDS_SETUP"; fi`
- Popup 2 of 2: generic `Approval needed`

User report: the first real opencode permission prompt was valid, but these later queued popups were not real permissions. They appear to be stale/transcript-derived detections after opencode continued with browse output.

Although the reproduced bug is opencode-specific, the fix must apply to **all coding agents** supported by Emu: opencode, Codex, and Claude. The common failure class is not "opencode is wrong"; it is "historical permission-shaped text in terminal output is being interpreted as a currently answerable prompt." The plan below treats opencode as the first fixture set and extends the same active-prompt requirements to Codex and Claude.

---

## Current Detector Shape

Relevant files:

- `src/shared/agentPermissionPrompts.ts`
- `src/renderer/src/components/TerminalPane.tsx`
- `scripts/verify-agent-permission-detector.mjs`

Current opencode detector behavior:

- `parseOpencodePermissionPrompt(text)` scans up to `MAX_SNAPSHOT_LINES = 80` normalized terminal lines.
- It finds the last `Allow`/`Deny`-style controls anywhere in those lines.
- It takes `block = lines.slice(anchor - 8)` through the end of the snapshot.
- It accepts if the block contains an opencode subject or explicit `Permission required` heading, plus approve/deny controls, plus wait evidence.

Current renderer scan behavior after §1.3:

- Every PTY data event still runs `raw-buffer` scan against a 32 KB rolling raw PTY buffer.
- Visible writes also run `write-parsed` scan against rendered xterm tail text.
- The watchdog scans rendered tail text every 500 ms for 30 s after output.
- Hidden replay scans rendered output during visibility transitions.

---

## Suspected Root Cause

The permission parsers are too tolerant of historical approval UI in the terminal tail or raw PTY buffer. The screenshots demonstrate this through the opencode parser, but Codex and Claude can hit the same class of bug when an agent explains, quotes, documents, or reprints permission UI after a real prompt has already been resolved.

Likely sequence:

1. A legitimate opencode permission appears for the browse skill bootstrap command.
2. The user approves it.
3. The terminal continues printing browse-skill transcript output such as `+ Thought`, `-> Skill "browse"`, shell command echoes, or other normal agent narration.
4. The rolling `raw-buffer` or rendered tail still contains stale approval controls like `Allow once`, `Allow always`, `Reject`, `Deny`, `Approve`, `enter confirm`, or `Permission required`.
5. `parseOpencodePermissionPrompt` anchors to those stale controls but includes later unrelated transcript lines in its block.
6. The parser emits a new prompt with a stale command summary or generic `Approval needed`.

This is not caused by the 1.2 keyword gate or 1.3 scan collapse directly. Those changes reduce scan frequency and do not create new parser acceptance paths. The false positive is an existing parser looseness exposed during testing.

---

## Design Principle

Only show an overlay for an **active, currently answerable permission UI**, not for text that merely mentions or displays a past permission.

For every agent provider, an active permission prompt should satisfy all of these:

- The approval controls are in a tight trailing block near the end of the scanned text.
- There is no substantial normal output after the controls.
- The prompt has both approve and deny affordances in the same local block.
- The prompt has wait evidence in the same local block (`enter confirm`, `esc dismiss`, selected menu marker, etc.).
- The subject is part of that same local block, not borrowed from older scrollback.

Provider-specific examples:

| Provider | Active prompt evidence | False-positive pattern to reject |
|---|---|---|
| opencode | `Permission required`, `Allow once` / `Allow always` / `Reject`, `enter confirm`, selected menu marker, or `Can I use...?` + `Proceed` | stale approval buttons followed by `Thought`, `Skill`, browser output, prose, or command output |
| Codex | `Would you like to run the following command?`, `Reason:`, `$ command`, `Yes, proceed`, `No...`, `Press enter to confirm` | documentation or transcript quoting a Codex approval prompt without an active choice/footer at the end |
| Claude | `Claude needs permission`, `Bash(command: ...)`, `Use skill "..."?`, `Do you want to proceed/allow`, active choices | assistant narration explaining permissions, old `Bash command` blocks, or completed prompt text followed by normal output |

---

## Fix Strategy

### 0. Add a provider-agnostic active-prompt block validator

**What:** Introduce a shared validation layer used after provider-specific parsing but before emitting a prompt.

Proposed shape:

```ts
interface ActivePromptBlock {
  provider: AgentPermissionProvider
  block: string[]
  controlStart: number
  controlEnd: number
}

function hasSubstantialOutputAfterControls(block: string[], controlEnd: number): boolean
function hasLocalApproveDenyEvidence(block: string[], provider: AgentPermissionProvider): boolean
function hasLocalWaitEvidence(block: string[], provider: AgentPermissionProvider): boolean
function isActivePermissionBlock(candidate: ActivePromptBlock): boolean
```

Provider parsers can still understand their own UI format, but all emitted prompts must satisfy the same core rule: the answerable controls are local and trailing, with no normal terminal output after them.

**Where:** `src/shared/agentPermissionPrompts.ts`, near the existing line/classification helpers (`isWaitHintLine`, `isSelectedChoiceLine`, `isMenuChoiceLine`).

**Why:** This prevents each provider parser from independently growing broad, permissive heuristics that reintroduce the same stale-scrollback bug.

---

### 1. Make opencode parsing trailing-block based

**What:** Replace the current broad `lines.slice(anchor - 8)` opencode block extraction with a stricter `extractTrailingOpencodePromptBlock(lines)` helper.

Proposed behavior:

```ts
function extractTrailingOpencodePromptBlock(lines: string[]): string[] | null {
  const trailing = trimIgnorablePromptChrome(lines).slice(-16)
  const controls = findTrailingOpencodeControlCluster(trailing)
  if (!controls) return null

  const block = trailing.slice(Math.max(0, controls.start - 8), controls.end + 1)
  if (hasSubstantialOutputAfterControls(trailing, controls.end)) return null
  if (!hasApproveAndDenyInBlock(block)) return null
  if (!hasOpencodeWaitEvidence(block)) return null
  if (!hasSubjectOrExplicitHeadingInBlock(block)) return null

  return block
}
```

Key rule: approve/deny controls must be at the **bottom** of the scanned text, except for ignorable prompt chrome like blank lines, border glyphs, cursor artifacts, or wait/footer lines.

This prevents stale controls in scrollback from combining with later browse transcript lines.

**Where:** `src/shared/agentPermissionPrompts.ts`, around `parseOpencodePermissionPrompt`.

---

### 2. Apply trailing-block validation to Codex and Claude too

**What:** Update Codex and Claude parsing so their prompt block extractors only accept active prompt blocks near the end of the scan window.

Codex-specific changes:

- `extractCodexPromptBlock(lines)` currently starts from `Would you like to run the following command?` and accepts if it finds `Yes, proceed`, `No`, and wait evidence.
- Add a guard that rejects the block if any substantial output follows the final choice/wait-hint line.
- Ensure `$ command`, `Reason:`, approve choice, deny choice, and wait evidence all exist in the same local block.

Claude-specific changes:

- Claude parsers should require `Do you want to proceed?` / `Do you want to allow...?` plus active choices to be local and trailing.
- `Bash(command: ...)`, `Use skill "..."?`, or `Skill(...)` alone should not be enough if normal output follows.
- Existing false-positive fixtures about assistant explanations should remain green.

**Where:** `src/shared/agentPermissionPrompts.ts`, around `extractCodexPromptBlock`, `parseCodexCommandPermissionPrompt`, `parseCodexToolPermissionPrompt`, and Claude parsing helpers above `parseGenericAgentPermissionPrompt`.

**Estimated impact:** Prevents stale Codex/Claude approval examples, docs, and completed prompt transcripts from opening popups.

---

### 3. Reject opencode blocks with post-prompt transcript output

**What:** Add a guard that rejects a candidate opencode prompt if there is normal agent output after the approval controls.

Examples that should invalidate the candidate when they appear after controls:

- `+ Thought:`
- `-> Skill "browse"`
- `Open`, `Collapse`, `Close` navigation text from rendered tool cards
- shell command echoes not part of the active prompt
- `READY_USER`, `NEEDS_SETUP`, or other command output
- ordinary prose from the agent after the approval interaction

This does **not** mean those exact strings are hardcoded as the only invalidators. The general rule is better: after a detected control cluster, only allow blank/chrome/footer lines. Any substantive non-control line means the prompt is historical, not active.

**Where:** new helper in `agentPermissionPrompts.ts`, used by `extractTrailingOpencodePromptBlock`.

---

### 4. Keep heading-only repaint support, but only if it is trailing

Existing test coverage includes opencode repaint cases such as:

- `△ Permission required`
- `Allow once   Allow always   Reject`
- `ctrl+f fullscreen  ↵ select  enter confirm`

These are intentionally supported because opencode can repaint a permission modal with minimal subject text.

However, heading-only support is currently too permissive if those lines remain in scrollback and later output follows.

New rule:

- Keep heading-only repaint positive cases **only when the heading + buttons + wait hint are the final active rendered block**.
- Reject the same text if any substantial output follows it.

This should preserve legitimate repaint detection while eliminating stale `Approval needed` popups like screenshot 2.

---

### 5. Make `raw-buffer` source stricter for visible tabs

**What:** Avoid showing a popup from raw PTY buffer text when a visible tab will produce a rendered `write-parsed` scan immediately.

Preferred minimal change:

- For **visible tabs**, do not call `detectPermissionPrompt(appendPermissionRawBuffer(data), 'raw-buffer')`.
- For **hidden tabs**, keep `raw-buffer` because there is no rendered write callback; it remains the hidden-tab safety net.

Current code:

```ts
detectPermissionPrompt(appendPermissionRawBuffer(data), 'raw-buffer')
```

Proposed:

```ts
const permissionRawBuffer = appendPermissionRawBuffer(data)
if (!isVisibleRef.current) {
  detectPermissionPrompt(permissionRawBuffer, 'raw-buffer')
}
```

Why this helps:

- Raw PTY buffers can preserve stale control text, escape-sequence artifacts, and output not matching the actual rendered terminal state.
- Visible tabs already get the more reliable `write-parsed` + watchdog scans against xterm-rendered text.
- Hidden tabs still need raw-buffer scanning because no immediate render callback is available.

Risk:

- A visible prompt may show a few milliseconds later, after xterm's `terminal.write` callback instead of immediately from raw PTY bytes. This is acceptable and safer than false positives.

**Where:** `src/renderer/src/components/TerminalPane.tsx`, current `raw-buffer` scan near the PTY data handler.

---

### 6. Add source-aware detector diagnostics

**What:** When a prompt is emitted, include enough debug information to identify whether it came from `raw-buffer`, `write-parsed`, `watchdog`, or `hidden-replay`.

Current debug logs include `source`, `matched`, `summary`, and `textTail`, but the emitted prompt sent to main does not retain the source.

Plan:

- Keep prompt shape unchanged for production UI.
- In debug mode (`emu.debugAgentPermission=1`), log `rawExcerpt`, `fingerprint`, `source`, `summary`, `detail`, and a compact normalized block.
- This lets us confirm whether false positives are coming from raw-buffer vs rendered scans without changing IPC types.

**Where:** `TerminalPane.tsx:1919-1956` debug branch.

---

### 7. Main-process queue dedupe audit

**What:** Confirm main process does not queue multiple pending prompts with the same or near-identical fingerprint before one is resolved.

Current code has recently-resolved fingerprint logic, but this false-positive case produced `1 of 2`, which means two pending prompts entered the queue at once.

Plan:

- Audit `agentPermissionPromptShow` handler in `src/main/index.ts`.
- Ensure it rejects a new pending prompt if another pending prompt for the same `sessionId` has the same `fingerprint`.
- Keep different fingerprints allowed because chained real permissions are valid.

This is secondary; the parser must still reject false positives. Dedupe only prevents duplicate queue growth.

---

## Regression Tests

Add fixtures to `scripts/verify-agent-permission-detector.mjs`.

### Positive cases that must keep passing

- Existing opencode command permission prompt.
- Existing opencode button prompt.
- Existing opencode explicit `Permission required` prompt.
- Existing opencode heading-only repaint prompt, but only when it is the trailing block.
- Existing opencode question prompt (`Can I use ...?` + `Proceed`).

### New negative cases

#### 1. Historical permission followed by browse transcript

```txt
△ Permission required
# Check if browse binary exists
$ if test -x ~/.claude/skills/gstack/browse/dist/browse; then echo "READY_USER"; else echo "NEEDS_SETUP"; fi
Allow once   Allow always   Reject
ctrl+f fullscreen  ↵ select  enter confirm
+ Thought: 255ms -> Skill "browse"
+ Thought: 182ms $ if test -x ~/.claude/skills/gstack/browse/dist/browse...
READY_USER
```

Expected: `new AgentPermissionPromptDetector().append(text, { provider: 'opencode', agentSession: true }) === null`

#### 2. Heading-only repaint followed by normal output

```txt
△ Permission required
Allow once   Allow always   Reject
ctrl+f fullscreen  ↵ select  enter confirm
+ Thought: continuing with browse task
Open   Collapse   Close
```

Expected: null.

#### 3. Documentation/prose mentioning approvals

```txt
opencode can show Allow once, Allow always, and Reject buttons.
This is explanatory output, not an active prompt.
```

Expected: null.

#### 4. Stale command near old controls but no active wait footer at bottom

```txt
$ if test -x ~/.claude/skills/gstack/browse/dist/browse; then echo READY_USER; else echo NEEDS_SETUP; fi
Deny
Allow Always
Allow Once
READY_USER
```

Expected: null.

#### 5. Codex approval prompt quoted in transcript, followed by normal output

```txt
Documentation example:
Would you like to run the following command?
$ npm run dev
› 1. Yes, proceed (y)
  2. No, and tell Codex what to do differently (esc)
Press enter to confirm or esc to cancel

The build then continued and printed normal output.
Compiled successfully.
```

Expected: null.

#### 6. Claude Bash permission block followed by assistant narration

```txt
Claude needs permission to use Bash
Bash(command: "npm test")
Do you want to allow this command?
› 1. Yes (y)
  2. No (esc)

I will continue after approval. Here is the next step...
```

Expected: null.

#### 7. Claude skill prompt quoted as prose

```txt
For example, Claude may show:
Use skill "browse"?
Do you want to proceed?
1. Yes
2. No

This paragraph is documentation, not an active terminal UI.
```

Expected: null.

---

## Implementation Order

1. Add failing regression fixtures from screenshots to `scripts/verify-agent-permission-detector.mjs`.
2. Add Codex and Claude stale/transcript negative fixtures to the same script.
3. Implement the provider-agnostic active-block validation helpers.
4. Implement `extractTrailingOpencodePromptBlock(lines)` and route `parseOpencodePermissionPrompt` through it.
5. Add trailing-output guards to Codex and Claude block extractors.
6. Keep existing positive opencode, Codex, and Claude fixtures green.
7. Add the visible-tab `raw-buffer` suppression in `TerminalPane.tsx`.
8. Add debug logging for emitted prompt source/block when `emu.debugAgentPermission=1`.
9. Audit main-process pending-prompt dedupe.
10. Run `node scripts/verify-agent-permission-detector.mjs`.
11. Smoke test in dev app with `localStorage.setItem('emu.debugAgentPermission', '1')`.

---

## Dev-App Smoke Test

1. Start the dev app.
2. Enable debug logs:

```js
localStorage.setItem('emu.debugAgentPermission', '1')
```

3. Ask opencode to run the same simple browsing task.
4. Approve the first legitimate browse-skill permission.
5. Confirm no queued false popups appear after opencode continues with `Thought`, `Skill "browse"`, or browser output.
6. Trigger a new real opencode permission after that and confirm the popup still appears.
7. Repeat once with the tab hidden during output to ensure hidden-tab raw-buffer still catches real prompts.

---

## Acceptance Criteria

- The two screenshot-derived false positives no longer emit prompts.
- New Codex stale/transcript fixtures do not emit prompts.
- New Claude stale/transcript fixtures do not emit prompts.
- Existing opencode positive fixtures still pass.
- Existing Claude and Codex positive fixtures still pass.
- Visible tabs no longer emit from raw-buffer scans; visible real prompts still appear from `write-parsed` or watchdog.
- Hidden tabs still detect real prompts via raw-buffer.
- Debug logs clearly show which source emitted each prompt.
- No changes to approve/deny IPC behavior.

---

## Risk Assessment

| Risk | Severity | Mitigation |
|---|---:|---|
| Real opencode prompt missed because parser now requires trailing controls | Medium | Keep positive fixtures for command, buttons, heading-only repaint, and question prompts; smoke test real opencode. |
| Real Codex prompt missed because stale-transcript checks are too strict | Medium | Keep existing Codex command/tool fixtures green and add at least one real hidden-tab Codex smoke test. |
| Real Claude prompt missed because stale-transcript checks are too strict | Medium | Keep existing Claude bash/skill fixtures green and smoke test a live Claude permission. |
| Visible prompt appears slightly later because raw-buffer no longer emits on visible tabs | Low | `write-parsed` fires after xterm render; watchdog catches delayed repaint within 500 ms. |
| Hidden tab prompt missed because raw-buffer remains raw/stale | Medium | Do not remove hidden raw-buffer; apply stricter parser trailing-block validation instead. |
| Chained real permissions deduped incorrectly | Medium | Only dedupe same `sessionId + fingerprint`; chained permissions should have distinct fingerprints. |
| opencode UI format changes again | Medium | Debug normalized block logging makes future fixture capture quick. |

---

## Why This Is Better Than Adding More Keyword Filters

The false positives contain real approval vocabulary (`permission`, `allow`, `deny`, `approve`) because they are stale approval UI or agent narration about approval. Keyword gating cannot distinguish stale text from active UI.

The fix must validate **layout and recency**:

- controls must be local,
- controls must be trailing,
- no normal output may follow,
- the subject must belong to the same prompt block.

That is why the core fix belongs in `parseOpencodePermissionPrompt`, not in the fast keyword gate.
