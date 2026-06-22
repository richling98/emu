# Feature Implementation Plan: Agent Indicator Rewrite (First Principles)

**Overall Progress:** `0%`

**Supersedes:** `plans/yellow-indicator-fix.html` (described an older version of this bug that was never actually implemented as written — the codebase since moved to a different, independently-broken detection scheme; see `Why the last two attempts failed` below).

## TLDR

The sidebar dot has two confirmed, currently-live bugs: it can flip to **green while a task is still running** (a polling false-positive), and it can get **stuck yellow forever after a task finishes** (a text-matching false-negative with no recovery path). Root cause: the indicator is driven by two fragile heuristics — regex-matching the rendered terminal screen to *guess* when the CLI looks idle, and polling the OS foreground process name to *guess* when the user has left the agent. Both guesses can be wrong, and both wire into a one-way latch flag that, once tripped incorrectly, has no way to self-correct for the rest of that task.

This plan throws out both heuristics and replaces them with one symmetric, self-healing rule: **the dot is yellow exactly while output is actively streaming from an agent task, and green the rest of the time.** No screen-text parsing. No foreground-process snapshots deciding busy/idle. Any single byte of PTY output, at any time, immediately and unconditionally proves "still busy" — so a wrong guess can never persist past the next byte.

## First Principles

> If there is no active task in a tab → green (or red if untouched for 10 minutes). If there is an active task → yellow. That's it.

Restating that as an implementable rule requires one honest admission: **Emu cannot ask Claude Code or Codex "are you busy?"** — there's no such IPC. The only signals available are (a) the raw byte stream the PTY emits, and (b) a periodic snapshot of which OS process is in the foreground. Of those two, only (a) is continuous and synchronous with reality; (b) is a 4-second-interval snapshot that can land mid-tool-call and see a transient process name (`bash`) that has nothing to do with whether Claude itself is still working.

So the design principle is: **trust the continuous signal (output) for the busy/idle decision, and only use the discrete signal (process name) for the one thing it's actually suited for** — confirming the agent CLI has fully exited, and even then, only acting on it once the byte-stream signal has already independently agreed the agent looks idle. This means a bad process-name snapshot mid-task can never again override a real "still working" state — it's structurally incapable of firing while the dot is yellow.

## Why the last two attempts failed

| Attempt | Mechanism | Failure mode |
|---|---|---|
| v1 (described in the old `yellow-indicator-fix.html` plan, never shipped as written) | Fixed-delay idle timer gated by a `agentTaskInFlightRef` flag that only `markAgentRunning`/`markAgentIdle` could flip | Once the timer fired early, the PTY-data re-arm check itself was gated on the same flag it had just zeroed out — a one-way latch |
| v2 (what's actually live today) | Regex-matches the rendered terminal tail against hand-written "looks like an idle prompt" patterns (`looksLikeAgentIdlePrompt`, `TerminalPane.tsx:182-223`), **plus** a 4s OS-process-name poll that force-clears the session if it sees a shell name (`TerminalPane.tsx:1282-1289`) | Text patterns silently stop matching if the CLI's UI format ever differs from what was guessed (→ stuck yellow); the process poll can catch Claude's own Bash-tool subprocess (`bash -c '...'`) mid-task and wrongly clear to green (→ false green). Both are gated by the same `agentTaskInFlightRef` latch as v1, so a single bad reading freezes detection for the rest of the task |

Both versions independently re-derived the same class of bug because both let an *unreliable, momentary* signal unilaterally override the *known-good* state. This plan removes that possibility by construction rather than tuning the heuristics again.

## Critical Decisions

* **Yellow→green is a pure silence debounce. No text parsing.** `looksLikeAgentIdlePrompt` is removed from the busy/idle decision entirely (it has one other, unrelated caller — `commitComposerRef`'s submit-routing logic at `TerminalPane.tsx:1178` — which stays untouched; only its use inside the idle-check at `TerminalPane.tsx:1247` goes away). If no PTY byte has arrived for `AGENT_SILENCE_TIMEOUT_MS` while an agent session is active in this tab, the agent is presumed idle. Justification: every agent CLI tested (Claude Code, Codex) redraws a live status/elapsed-timer footer at least once per second for as long as a task — including tool calls and thinking — is in flight. True silence for several seconds reliably means it has returned to its own prompt.

* **Green→yellow re-arm is unconditional.** The instant any new PTY byte arrives while this tab's agent session is considered active, the dot goes yellow and the silence timer resets — no flag check, no gating condition. This is what makes the system self-healing: even if something else briefly mis-fires the idle transition, the very next byte of real output immediately corrects it.

* **The 4-second process-name poll is removed from the busy/idle decision.** It keeps its other job — detecting that the agent CLI process itself is gone, for unrelated bookkeeping (the `'idle'` vs `'none'` distinction, the `foregroundProcess` label shown elsewhere) — but it may only act on a "looks like a shell" reading **if the silence debounce has already independently put this tab in the idle/green state.** While the dot is yellow, the poll's "looks like a shell" reading is structurally ignored — closing exactly the hole that let Claude's own `bash -c` tool calls falsely clear a running task.

* **Exit detection requires two consecutive shell readings, not one.** Even when allowed to act (tab already idle), the poll needs the foreground process to look like a plain shell on two consecutive 4-second polls before declaring the agent gone, to absorb noise from quick subprocess flickers.

* **Silence threshold: 10 seconds (`AGENT_SILENCE_TIMEOUT_MS`).** Generous enough that no normal status-footer redraw cadence ever falsely trips it, short enough that the dot feels responsive once a task genuinely finishes. Tunable in one place if real-world testing says otherwise.

* **Staleness threshold changes from 5 to 10 minutes, per your spec.** `Sidebar.tsx:33`'s `STALE_AFTER_MS` constant changes from `5 * 60 * 1000` to `10 * 60 * 1000`. No other change to the red-dot logic — it's already driven by `lastActiveAt`, which already updates on any terminal activity (`touchSessionActivity()`, called from PTY output and user input alike), which is a reasonable proxy for "visited."

* **Scope: per-session (sidebar) dot only, not a new per-tab UI.** There is currently no per-top-tab dot anywhere in the UI (`TopTabBar.tsx` has none) — only the one sidebar dot per workspace, which already aggregates correctly across that workspace's tabs (`summarizeSession` in `App.tsx:180-191`: yellow if *any* tab is running, else the active tab's state). That aggregation logic is correct today and needs no change — only the per-tab `agentState` value feeding into it (computed in `TerminalPane.tsx`) is being rewritten. If you actually want a separate dot per top-tab in the tab strip, that's a distinct, larger feature — flag it and I'll scope it separately.

* **Known pre-existing edge case, explicitly out of scope:** if a user types a plain shell command in the few seconds between Claude actually exiting and the next process-poll noticing, that command can be misrouted as "targeting the agent." This ambiguity exists today in the Enter-key routing logic (`recordCommittedCommand`, `TerminalPane.tsx:1137`) independent of this rewrite, and isn't part of the busy/idle bug you reported — not touching it here.

## Tasks

- [ ] 🟥 **Step 1: Remove the text-pattern idle check from the busy/idle path**
  - [ ] 🟥 In `TerminalPane.tsx`, delete the `scheduleAgentIdleCheck` function (`~1240-1251`) and its call site inside `onPtyData` (`~1759`).
  - [ ] 🟥 Leave `looksLikeAgentIdlePrompt` (`182-223`) and `looksLikeAgentActiveTail` (`225-242`) and their other call sites (`973`, `1178`) untouched — those are unrelated composer-submit-routing logic.

- [ ] 🟥 **Step 2: Replace with a symmetric silence-debounce timer**
  - [ ] 🟥 Add `const AGENT_SILENCE_TIMEOUT_MS = 10_000` near the other timing constants (`~line 21`).
  - [ ] 🟥 Reuse the existing `agentIdleTimerRef` (`460`) and `clearAgentIdleTimer` (`947-952`) — no new ref needed.
  - [ ] 🟥 In the `onPtyData` handler (`~1707`), unconditionally (no flag check) do: if `agentSessionRef.current` is true, call `markAgentRunning(agentProcessRef.current)` and restart the idle timer via `clearAgentIdleTimer(); agentIdleTimerRef.current = setTimeout(() => markAgentIdle(agentProcessRef.current), AGENT_SILENCE_TIMEOUT_MS)`. This runs on every single PTY data event, busy or not — that's the "any byte = busy, resets the clock" rule.
  - [ ] 🟥 Confirm `markAgentRunning` (`1105-1111`) being called repeatedly (once per output burst) is harmless — it already just sets state + timestamps idempotently.

- [ ] 🟥 **Step 3: Remove the `agentTaskInFlightRef` latch entirely**
  - [ ] 🟥 Delete the ref declaration (`461`) and all reads/writes (`1099`, `1107`, `1116`, and the two guard checks that used to live in `scheduleAgentIdleCheck`, already removed in Step 1). It served only to gate the now-deleted text-check; nothing else should depend on it after Step 1–2.

- [ ] 🟥 **Step 4: Stop the process-name poll from clearing a running task**
  - [ ] 🟥 In `refreshAgentProcess` (`1253-1293`), change the shell-detection branch so `clearAgentSession(proc)` can only fire when `agentStateRef.current !== 'running'` (i.e. the dot is already green) — remove the `isAgentProcessName(previousProcess)` and elapsed-time conditions that currently let it override a running task on a single snapshot.
  - [ ] 🟥 Add a small consecutive-reading counter (e.g. `shellPollStreakRef = useRef(0)`): increment when the polled process looks like a shell, reset to `0` whenever it looks like an agent. Only call `clearAgentSession(proc)` once `shellPollStreakRef.current >= 2`.

- [ ] 🟥 **Step 5: Update the staleness threshold**
  - [ ] 🟥 In `Sidebar.tsx:33`, change `STALE_AFTER_MS` from `5 * 60 * 1000` to `10 * 60 * 1000`.

- [ ] 🟥 **Step 6: Manual verification pass**
  - [ ] 🟥 Launch Claude Code in a tab, give it a multi-tool-call task ("read all TS files and summarize the architecture"); confirm the dot stays yellow continuously through every tool call, including any that spawn a literal `bash` subprocess (e.g. a `Bash(...)` tool call).
  - [ ] 🟥 Let a task finish and sit at the idle prompt; confirm the dot turns green within ~10 seconds and stays green.
  - [ ] 🟥 Exit Claude Code back to the plain shell (`/quit` or `exit`) while idle; confirm the dot stays green and `foregroundProcess` eventually reflects the shell (no behavior change expected here, just confirming Step 4 didn't break legitimate exit detection).
  - [ ] 🟥 Leave a tab completely untouched for 10+ minutes; confirm it turns red, not 5 minutes.
  - [ ] 🟥 Confirm a plain, non-agent shell tab never goes yellow under any of the above.

## Edge Cases Covered

| Scenario | Before this plan | After this plan |
|---|---|---|
| Claude calls the Bash tool, OS foreground process is briefly `bash` | 4s poll can catch this and force the dot green mid-task | Poll's shell reading is ignored while state is `'running'` — structurally cannot fire |
| Claude's CLI UI text format changes or differs from the guessed regex | Dot can get stuck yellow forever, no recovery | No text parsing involved at all — immune by construction |
| Long tool call with no output for many seconds (e.g. slow `npm install`) | Could wrongly idle if the regex check fired and matched stale screen text | Claude's own status footer keeps redrawing during any in-flight task (sub-second cadence), so PTY isn't actually silent; if it *were* genuinely silent for 10s+, that's a reasonable signal something stalled and idle is the safer default than stuck-yellow forever |
| A wrong idle/running guess happens anyway (e.g. a transient hiccup) | No recovery — latched until next Enter press | Self-healing: the very next PTY byte immediately re-arms to running, unconditionally |
| User exits Claude Code back to plain shell while idle | Already worked (poll detects shell, state already not running) | Same outcome, now gated by a 2-consecutive-poll debounce instead of one snapshot |
| Tab is hidden (not the active/visible tab) while a task runs | `onPtyData` still fires regardless of visibility — already correct | Unchanged; the new logic runs unconditionally inside the same handler |

## Files Touched

- `src/renderer/src/components/TerminalPane.tsx` — remove `scheduleAgentIdleCheck` and `agentTaskInFlightRef`; add the silence-debounce timer logic in `onPtyData`; tighten `refreshAgentProcess`'s shell-detection branch with a running-state guard and a consecutive-reading counter; add `AGENT_SILENCE_TIMEOUT_MS` constant.
- `src/renderer/src/components/Sidebar.tsx` — bump `STALE_AFTER_MS` to 10 minutes.

## How to Verify

Covered by Step 6 above — this is behavioral, real-CLI-output-dependent logic that can't be meaningfully confirmed by a type-check or unit test; it needs a live run with an actual Claude Code/Codex session doing real multi-step work.
