# Rich Input Agent Submit Fix Plan

## Problem

Sometimes submitting from Thinking's rich input composer writes the prompt into the active Claude Code or Codex command line but does not actually submit it. The visible result is that the text is sitting in the agent input area, and the user must click or mouse over the terminal and press Enter manually.

This appears most common inside agent TUIs such as Claude Code and Codex. It has not yet been proven to affect a plain shell prompt at the same rate.

## Assumptions

- The rich input field is supposed to own typing while Claude/Codex is at an idle message prompt.
- Pressing Enter in the rich input should behave like typing the prompt into the terminal and pressing Enter exactly once.
- Shift+Enter should remain a composer newline.
- Raw terminal apps such as vim, less, and shells that the user explicitly clicked into should continue to receive direct xterm input.
- The fix should be narrow. It should not redesign the composer, the terminal pane, or agent-state tracking unless needed for reliable submit behavior.

## What We Tried Before

### Rich Composer Introduction

Commit `3e151d7a` added the rich terminal input composer.

Relevant behavior introduced there:

- `RichInputComposer.tsx` intercepts Enter, clears the contenteditable editor, and calls `onCommit(text)`.
- `TerminalPane.tsx` receives the text in `commitComposerRef.current`.
- Single-line input is written directly to the PTY.
- Multi-line input is wrapped in bracketed paste markers: `\x1b[200~...\x1b[201~`.
- Enter is then sent as a second PTY write after a short fixed timeout.

That implementation was already trying to avoid one known failure mode: Claude/Codex-style TUIs can treat `text + Enter` in a single PTY write as pasted input rather than as a submitted message.

### Blank-Line Submit Fix

Commit `6a5f1951` changed the composer commit path.

Relevant changes:

- Added `normalizeComposerCommitText`.
- Trimmed leading/trailing blank lines and stripped non-breaking/zero-width characters.
- Replaced the old `buildComposerCommitBody` with `buildComposerCommitWrites`.
- Increased the submit delay from about 16 ms to 120 ms.
- Added `pendingComposerSubmitRef`.
- Sent the pending Enter early when PTY output arrived, via `submitPendingComposerInput()` inside the `onPtyData` handler.

This likely fixed some cases where blank lines or a combined paste-plus-submit sequence confused agent input parsing.

### Related Prompt Optimizer Fixes

Commits `82f9541a` and `a68a53d2` changed prompt insertion and replacement behavior for the optimizer path.

Those are related but not the same bug. They focused on replacing existing terminal input reliably using cursor movement, Ctrl+U, backspaces, and bracketed paste. They did not solve rich composer submit acknowledgement.

## Why The Previous Fix Was Incomplete

The current submit path is still heuristic, not deterministic.

Specific weaknesses:

1. The renderer uses fire-and-forget IPC for `ptyWrite`.
   - `src/preload/index.ts` exposes `ptyWrite` as `ipcRenderer.send`.
   - `src/main/index.ts` handles `pty:write` by calling `ptyProcesses.get(sessionId)?.write(data)`.
   - The renderer has no acknowledgement that the text write reached the PTY before it decides when to send Enter.

2. The current Enter timing is based on output or a fixed timer.
   - If unrelated PTY output arrives after the text write, Enter can be sent too early.
   - If Claude/Codex accepts the paste but is still internally processing paste/end-paste state, the timed Enter can be ignored.
   - If there is no prompt echo, the fallback is still just a fixed 120 ms timer.

3. The fix does not verify the important state: "the text has landed but submit did not happen."
   - The user-visible failure is exactly that state.
   - Current code sends one Enter and then assumes success.

4. Agent TUIs and shells are treated almost the same.
   - Claude/Codex have custom text areas, bracketed paste handling, redraws, and idle/running UI states.
   - A plain shell prompt has different semantics and a lower duplicate-submit risk.
   - A reliable fix should make the agent path explicit and keep the shell path conservative.

5. There is no regression harness.
   - The repo currently has build scripts but no focused automated test for composer commit sequencing.
   - Without a fake PTY/TUI repro, future timing changes can accidentally reintroduce this.

## Fix Strategy

Make rich composer submit a small state machine with an explicit delivery sequence and a guarded recovery path.

The goal is not to send more Enter keys blindly. The goal is to detect the exact stuck state and recover once, with safeguards against duplicate submission.

## Implementation Plan

### Phase 1: Add Submit Instrumentation

Add temporary dev-only logging around composer commits.

Capture:

- submit id
- foreground process name
- whether the active process is Claude/Codex
- text length and line count, not full prompt content
- whether bracketed paste was used
- timestamps for body write, Enter write, PTY output, idle/running state changes, and retry Enter if any

Keep this behind a local constant or environment-style guard so it is easy to remove or leave disabled.

Files:

- `src/renderer/src/components/TerminalPane.tsx`
- optionally `src/main/index.ts` if main-process PTY write tracing is needed

Verification:

- Run Thinking in dev mode.
- Submit simple and multi-line prompts in Claude Code and Codex.
- Confirm the trace shows whether Enter is sent before or after the prompt visibly lands.

### Phase 2: Add an Ordered PTY Write API

Replace the rich composer commit path's fire-and-forget multi-write behavior with an acknowledged sequence.

Add a new preload/main API such as:

```ts
ptyWriteSequence(sessionId, writes)
```

Where each write can include:

```ts
{
  data: string
  delayAfterMs?: number
}
```

Main process behavior:

- Look up the PTY once.
- Write each chunk in order.
- Await the configured delay between chunks.
- Return `{ ok: true }` or `{ ok: false, reason }`.

This does not prove the child process fully consumed the bytes, but it removes renderer IPC races and gives the renderer a real completion point for delivery to `node-pty`.

Files:

- `src/preload/index.ts`
- `src/main/index.ts`
- `src/renderer/src/env.d.ts`
- `src/renderer/src/components/TerminalPane.tsx`

Verification:

- `npm run build`
- Manual shell test: submit `echo thinking-submit-test`.
- Confirm command runs once and command history records one entry.

### Phase 3: Extract Commit Sequencing Into a Pure Helper

Move text normalization and sequence construction into a small pure helper.

Suggested helper responsibilities:

- normalize composer text
- append image paths
- choose plain write vs bracketed paste write
- choose whether the target is agent-like or shell-like
- produce a write sequence plus metadata

Keep the helper near `TerminalPane.tsx` unless it becomes large enough to justify `src/renderer/src/utils`.

Why:

- The current logic is embedded in a large component.
- Isolating the pure part makes it easier to test without launching Electron.
- This is the piece most likely to regress around blank lines, multiline paste, and image path appending.

Verification:

- Add focused tests if the repo gets a test runner.
- If not adding a runner yet, add a small script or documented manual table in the plan implementation PR.
- Test inputs: single line, leading blank lines, trailing blank lines, multiline body, NBSP, zero-width chars, image-only commit, text plus image.

### Phase 4: Replace Pending Timer With Submit State

Replace `pendingComposerSubmitRef` with a submit transaction object.

Suggested state:

```ts
type ComposerSubmitTransaction = {
  id: string
  commandText: string
  normalizedLastLine: string
  agentTarget: boolean
  wroteBodyAt: number
  sentEnterAt: number | null
  retriedEnterAt: number | null
  preSubmitTail: string
}
```

Behavior:

- Create a transaction before writing.
- Send the body through the ordered PTY sequence API.
- For shell targets, send exactly one Enter after the body write completes.
- For agent targets, send Enter only after one of these is true:
  - the terminal tail visibly contains the last non-empty line of the submitted prompt
  - a conservative max wait expires

Do not use "any PTY output arrived" as the submit trigger. Use either visible echo/fingerprint evidence or a bounded fallback.

Files:

- `src/renderer/src/components/TerminalPane.tsx`

Verification:

- Claude Code: submit single-line prompt from rich input.
- Codex: submit single-line prompt from rich input.
- Claude Code and Codex: submit multi-line prompt with leading/trailing blank lines.
- Confirm no manual click or second Enter is needed.

### Phase 5: Add One Guarded Agent Retry

Add one retry Enter only for agent targets and only if the UI still appears stuck.

Retry conditions:

- foreground process is Claude/Codex, or `agentSessionRef.current` is true
- one Enter has already been sent
- no retry has been sent for this transaction
- no running/thinking/tool marker appeared after the Enter
- terminal tail still contains the submitted last line near an idle agent prompt
- enough time has elapsed for the agent to clear or transition, for example 500-800 ms

Do not retry for plain shell commands. Do not retry if output changed in a way that suggests the command was accepted.

This directly addresses the reported stuck state while limiting duplicate-submit risk.

Verification:

- Reproduce the bug before the fix if possible.
- After the fix, submit repeatedly in Claude Code and Codex.
- Confirm the retry either does not fire or fires once and unsticks the prompt.
- Confirm duplicate messages are not created.

### Phase 6: Preserve Focus Semantics

After commit:

- Keep rich input focus if the agent remains idle.
- Do not require focus to move to xterm for submit to work.
- If the user clicks the terminal, keep the existing `xterm` owner behavior.
- Do not make terminal focus the mechanism that makes submit reliable; PTY sequencing should be sufficient.

Why:

- The user's workaround involves moving focus and pressing Enter.
- The product behavior should not depend on that focus move.

Verification:

- Submit without moving the mouse.
- Submit while the mouse is over the composer.
- Submit after selecting text in the terminal and returning to composer.

### Phase 7: Add a Regression Harness

Add a small fake TUI test target that simulates the Claude/Codex failure mode.

The fake target should:

- enable bracketed paste awareness
- echo pasted text into an input area
- intentionally ignore Enter if it arrives too soon after bracketed paste end
- accept Enter after the input is settled
- print an observable `SUBMITTED:<id>` marker

This can be a simple Node script under `scripts/` if we do not want to add a test framework yet.

Then document a manual or automated flow:

1. Run Thinking dev.
2. Launch the fake TUI in a tab.
3. Submit a rich composer prompt.
4. Verify `SUBMITTED:<id>` appears exactly once.

Files:

- `scripts/submit-probe-tui.mjs`
- optional docs under `plans/` or `docs/`

Verification:

- Run the probe 20+ times with simple prompt.
- Run the probe 20+ times with multiline prompt.
- Confirm zero stuck submissions and zero duplicate submissions.

## Acceptance Criteria

- In Claude Code, rich input Enter submits without clicking the terminal.
- In Codex, rich input Enter submits without clicking the terminal.
- Simple prompts, multiline prompts, leading/trailing blank-line prompts, and prompts with attached image paths all submit once.
- Plain shell commands still execute once.
- Shift+Enter still inserts a composer newline.
- Ctrl+C and Escape composer behaviors are unchanged.
- No raw TUI regression for vim, less, or editor/pager modes.
- A reproducible submit probe exists so future timing changes can be checked.

## Manual Test Matrix

| Context | Input | Expected |
| --- | --- | --- |
| zsh shell | `echo thinking-submit-test` | command executes once |
| zsh shell | multiline shell input | behavior matches current intended shell behavior |
| Claude Code idle prompt | single-line message | message submits once |
| Claude Code idle prompt | multi-line message | message submits once with line breaks preserved |
| Claude Code idle prompt | leading/trailing blank lines | blank edges are trimmed, body submits once |
| Codex idle prompt | single-line message | message submits once |
| Codex idle prompt | multi-line message | message submits once with line breaks preserved |
| Codex idle prompt | text plus image path | prompt and path submit once |
| vim/less | keyboard input | xterm owns input, composer does not intercept |
| composer | Shift+Enter | inserts newline, does not submit |

## Risks And Mitigations

Risk: Retry Enter creates duplicate submissions.

Mitigation: Retry only for agent targets, only once, and only while the terminal still visibly appears stuck with the submitted prompt near an idle prompt.

Risk: Waiting for visible echo fails in no-echo contexts.

Mitigation: Use a bounded fallback timer, but only after ordered PTY write acknowledgement.

Risk: Adding an IPC sequence API changes other input behavior.

Mitigation: Use it only for composer commits first. Keep existing `ptyWrite` for normal xterm data, Ctrl+C, Escape, drag/drop, and other hot paths.

Risk: Agent UI markers change over time.

Mitigation: Use marker detection only as a retry guard, not as the primary submit mechanism. Prefer conservative "do no duplicate" behavior when uncertain.

## Recommended Order Of Work

1. Add instrumentation and reproduce with Claude Code/Codex.
2. Add ordered PTY write sequence API.
3. Extract and test composer commit sequence construction.
4. Replace pending timer with submit transaction state.
5. Add one guarded agent retry.
6. Add the fake TUI regression harness.
7. Run build and manual matrix.

## Definition Of Done

- The bug is reproduced or the closest fake TUI reproduction is documented.
- The code no longer relies on arbitrary PTY output as the signal to send Enter.
- The rich composer has ordered write delivery for body and submit.
- The exact stuck state gets one guarded recovery Enter.
- Build passes.
- Manual Claude Code and Codex submit tests pass repeatedly.
- The final implementation notes include any cases that could not be tested.
