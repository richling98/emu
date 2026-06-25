# Permission Popup False Positives — Deep Debug Findings

## Summary

The latest screenshots show a **different false-positive class** than the first pair of screenshots.

The previous hardening correctly targeted stale permission UI followed by normal output. These new screenshots show the inverse shape: **normal tool-trace output appears above stale/active-looking approve controls**, so the parser still thinks there is an answerable permission block.

Screenshots reviewed:

- `/Users/richardling/Desktop/Screenshot 2026-06-25 at 12.58.39 AM.png`
- `/Users/richardling/Desktop/Screenshot 2026-06-25 at 12.58.55 AM.png`
- `/Users/richardling/Desktop/Screenshot 2026-06-25 at 12.58.59 AM.png`

Observed popup details:

- `Approval needed` with detail like `+ Thought: 508ms % WebFetch https://duckduckgo.com/?...`
- `Approval needed` with detail like `Build • GLM 5.2 % WebFetch https://duckduckgo.com/...`
- `Approval needed` with detail like `... + Thought: 319ms % WebFetch https://www.airaw...`

These are **not permission requests**. They are ordinary agent/tool execution transcript lines from a browsing task. A real approval request should ask the user to approve/deny a concrete action and should present currently answerable controls in the terminal UI.

---

## What The Previous Fix Was Supposed To Fix

Previous implementation changes:

- Added provider-agnostic `hasSubstantialOutputAfterControls(...)` in `src/shared/agentPermissionPrompts.ts`.
- Applied it to opencode, Codex, Claude, and generic parsing.
- Added regression fixtures where old approval controls were followed by normal output.
- Suppressed visible-tab `raw-buffer` emissions in `TerminalPane.tsx`, so visible tabs rely on rendered `write-parsed` and watchdog scans.

That fix catches this shape:

```txt
Permission required
Allow once   Allow always   Reject
enter confirm
normal output after the controls
```

It rejects the candidate because normal output appears **after** the last approval control.

---

## Why It Did Not Fix The New Screenshots

The new screenshots appear to have this shape instead:

```txt
normal agent/tool trace line
normal WebFetch URL line
maybe old Permission required heading or old approval context
Allow / Deny controls still visible or still present in the scan block
```

The current guard only asks: **is there substantial output after the controls?**

In this new case, the suspicious `WebFetch` / `Thought` lines are likely **before** the stale controls, not after them. Therefore `hasSubstantialOutputAfterControls(...)` returns false and the parser still accepts the block.

The parser then chooses those normal tool-trace lines as the prompt detail and emits generic `Approval needed`.

---

## Likely Code Path

Two likely parser paths can produce this exact UI:

### Path A — opencode heading/button fallback

`parseOpencodePermissionPrompt(...)` can return `summary: 'Approval needed'` through `opencodeSummaryFromBlock(...)` when it sees approval controls but cannot find a stronger subject.

Relevant code:

- `src/shared/agentPermissionPrompts.ts:644-684` (`parseOpencodePermissionPrompt` after current line shifts)
- `opencodeSummaryFromBlock(...)` fallback returns `Approval needed`
- `detail` includes non-control lines from the block, which can become the `WebFetch ...` traces visible in the popup

Why this can happen:

- `hasExplicitPermissionModal` allows a prompt even when there is no strong subject.
- Heading-only repaint support was kept intentionally for real opencode repaints.
- But if stale heading/buttons remain near the bottom of the scan block and ordinary tool traces sit above them, the block still looks like a minimal permission modal.

### Path B — generic fallback parser

`parseGenericAgentPermissionPrompt(...)` always emits `summary: 'Approval needed'`.

Relevant code:

- `src/shared/agentPermissionPrompts.ts:544-583`
- `detectSnapshot(...)` calls generic fallback for provider hints `codex` and `claude`, and as a final default fallback

Why this can happen:

- Generic fallback is broad by design.
- It was useful as a catch-all for unknown agent prompt variants.
- But it is unsafe when terminal output contains a mix of old approval controls and normal tool traces.

### Why main-process dedupe did not save us

Main-process dedupe already rejects same `sessionId + fingerprint` pending prompts.

Relevant code:

- `src/main/index.ts:1363-1383`

The three screenshots show `1 of 3`, `2 of 3`, `3 of 3`, which means each false positive had a **different fingerprint**. The fingerprints likely differ because each popup's detail line contains a different `WebFetch` URL or trace line. Same-fingerprint dedupe cannot collapse those.

---

## Correct Heuristic

A permission popup must require **positive evidence of a currently answerable approval request**, not just any approval-shaped controls in the terminal tail.

For all providers, an active permission should have:

1. A clear permission request anchor.
2. A concrete requested action subject.
3. Approve and deny controls local to that request.
4. Wait evidence local to that request.
5. No normal transcript/tool-output lines mixed into the candidate block.

Normal tool traces are **not** permission requests:

- `Thought: ...`
- `WebFetch https://...`
- `WebSearch ...`
- `Read ...`
- `Edit ...` after the edit has already run
- Browser UI text like `Open`, `Collapse`, `Close`
- fetched web page text
- command output such as `READY_USER`

These lines can mention tools or URLs, but they do not ask the user to approve anything.

---

## Recommended Fix

### 1. Introduce prompt confidence levels

Add a confidence classification before returning a parsed prompt:

```ts
type PermissionPromptConfidence = 'high' | 'low'
```

High-confidence examples:

- opencode: `Permission required` + concrete subject (`$ ...`, `# ...`, `Can I use...?`) + approve/deny controls + wait hint.
- Codex: `Would you like to run the following command?` + `$ command` + `Reason:` + approve/deny choices + wait hint.
- Claude: `Claude needs permission...` or `Do you want to allow/proceed...?` + `Bash(command:...)` / `Use skill ...` + approve/deny choices.

Low-confidence examples:

- `Approval needed` with no concrete subject.
- heading-only opencode repaint with extra transcript/tool lines.
- generic fallback result.
- any parsed detail line containing tool-trace markers like `Thought:` or `% WebFetch`.

Only high-confidence prompts should open overlays by default.

### 2. Kill or quarantine `parseGenericAgentPermissionPrompt` for production overlays

Recommended minimal safe change:

- Remove `parseGenericAgentPermissionPrompt(...)` from `detectSnapshot(...)` production returns.
- Keep it only for debug diagnostics, if desired.

Why:

- Provider-specific parsers already cover known Codex, Claude, and opencode permission UIs.
- Generic fallback creates exactly the kind of `Approval needed` false positive shown in the screenshots.
- Missing an unknown future prompt is safer than interrupting users with fake approve/deny overlays.

Concrete change:

```ts
if (providerHint === 'codex') return parseCodexPermissionPrompt(text) ?? parseClaudePermissionPrompt(text, false)
if (providerHint === 'claude') return parseClaudePermissionPrompt(text, true) ?? parseCodexPermissionPrompt(text)
return parseCodexPermissionPrompt(text) ?? parseClaudePermissionPrompt(text, false)
```

No generic fallback in the emitted path.

### 3. Make opencode heading-only repaint stricter

Keep heading-only repaint support only when the block is tiny and clean.

Allow:

```txt
△ Permission required
Allow once   Allow always   Reject
ctrl+f fullscreen  ↵ select  enter confirm
```

Reject:

```txt
△ Permission required
% WebFetch https://...
+ Thought: ...
Allow once   Allow always   Reject
ctrl+f fullscreen  ↵ select  enter confirm
```

Rules:

- If there is no strong subject, heading-only prompt block may contain only:
  - permission heading,
  - approve/deny controls,
  - wait/footer controls,
  - border/chrome lines.
- If block contains `Thought:`, `WebFetch`, `WebSearch`, URL traces, browser card text, or command output, reject it.

### 4. Add tool-trace rejection for candidate subject/detail lines

Add helper:

```ts
function isAgentActivityTraceLine(line: string): boolean {
  const normalized = normalizeLine(line)
  return /\bThought:\s*\d+ms\b/i.test(normalized) ||
    /\b(WebFetch|WebSearch)\s+https?:\/\//i.test(normalized) ||
    /%\s*(WebFetch|WebSearch)\s+https?:\/\//i.test(normalized) ||
    /\b(Open|Collapse|Close)\b/.test(normalized)
}
```

Use it to reject any candidate prompt whose selected summary/detail subject is an activity trace line.

Important: do **not** reject real permission requests that ask to run a web fetch tool. A real permission request must contain explicit request wording like `allow`, `approve`, `permission required`, `would you like`, or `do you want`, not just `WebFetch https://...`.

### 5. Add post-resolution cooldown for low-confidence prompts

The user noticed this occurs right after a real permission was approved. Proximity matters because old controls remain in the scan window.

Add a short session-level cooldown after approve/deny:

- Duration: 1.5–2.0 seconds.
- During cooldown, suppress only low-confidence prompts.
- High-confidence prompts still show, so chained real permissions are not blocked.

This requires either:

- adding `confidence` to `AgentPermissionPrompt`, or
- keeping cooldown entirely renderer-side using the last approved fingerprint/time if main emits a resolution event.

Given current architecture, the cleaner version is to add `confidence` internally in renderer/main but not render it in UI.

### 6. Add regression fixtures matching this exact class

Add to `scripts/verify-agent-permission-detector.mjs`:

#### opencode/WebFetch trace before stale controls

```txt
△ Permission required
+ Thought: 508ms % WebFetch https://duckduckgo.com/?q=...
Allow once   Allow always   Reject
ctrl+f fullscreen  ↵ select  enter confirm
```

Expected: null.

#### generic WebFetch detail should never emit

```txt
+ Thought: 319ms % WebFetch https://www.airaw...
Deny
Approve
```

Expected: null.

#### Codex/Claude browsing transcript variants

```txt
Would you like to run the following command?
$ browse https://example.com
1. Yes, proceed (y)
2. No (esc)
Press enter to confirm or esc to cancel
+ Thought: 300ms % WebFetch https://example.com
```

Expected: null because output follows the old prompt.

---

## Why Online Research Is Not Necessary Here

The relevant source of truth is not general web permission terminology. It is the **terminal UI contract** of coding agents:

- real prompt: explicit user decision requested now,
- false positive: transcript/tool/log output describing an action that already happened or is being displayed.

The screenshots already show the key distinction. The detector should not decide based on the word `tool`, `WebFetch`, `permission`, or `approve` alone. It should decide based on active UI shape and confidence.

---

## Concrete Implementation Plan

1. Add fixtures for the three new screenshots.
2. Remove `parseGenericAgentPermissionPrompt(...)` from production `detectSnapshot(...)` returns.
3. Add `isAgentActivityTraceLine(...)`.
4. Reject opencode heading-only/generic candidates when the candidate block contains activity trace lines.
5. Reject any candidate whose summary/detail subject is an activity trace line.
6. Optionally add prompt `confidence` and a low-confidence post-resolution cooldown.
7. Run `node scripts/verify-agent-permission-detector.mjs`.
8. Retest the same opencode browse flow with `emu.debugAgentPermission=1`.

---

## Recommended Next Code Change

The safest immediate code change is:

1. Remove generic fallback from `detectSnapshot(...)`.
2. Add opencode heading-only block cleanliness checks.
3. Add WebFetch/Thought activity-trace negative fixtures.

Do **not** start with a large state-machine rewrite. The current failure is narrow enough to fix with stricter parser confidence first.

---

## Acceptance Criteria

- The three new screenshot-derived WebFetch popups no longer emit.
- The first legitimate permission in the browse flow still emits.
- Existing opencode/Codex/Claude positive fixtures still pass.
- Existing stale-after-controls negative fixtures still pass.
- No `Approval needed` popup may be emitted from a detail line that is merely `Thought:` or `WebFetch https://...`.
