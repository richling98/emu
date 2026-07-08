# Task-Complete False Positive Root Cause Plan

**Status:** Plan only

## Goal

Stop the task-complete popup from claiming a tab is done while the coding agent
is still working in the background.

Example bad behavior:

- User asks an agent to handle a coding task.
- The agent stops printing terminal output for long enough.
- Emu decides the tab is idle.
- The task-complete popup appears: `rling is done!`
- The agent later prints more output, uses tools, runs searches, or continues
  the task.

The fix should make the popup mean one thing:

> Emu has positive evidence that the agent returned to an idle prompt or fully
> stopped working.

Silence alone is not completion.

## Current Implementation

The popup is triggered in
`src/renderer/src/components/TerminalPane.tsx`.

Relevant path:

1. `setAgentState()` tracks `previousState`.
2. If the state changes from `running` to `idle`, it calls
   `window.api.showTaskComplete(...)`.
3. `src/main/index.ts` receives `task-complete:show`.
4. The main process queues and displays the overlay text:
   `workspaceName + ' is done!'`.

The risky line of behavior is:

```ts
if (previousState === 'running' && state === 'idle') {
  window.api.showTaskComplete(...)
}
```

Today, `running -> idle` is treated as proof that the task completed. That is
too strong.

## Current Idle Detection

The renderer uses three main signals to keep a task in `running`:

1. **User submitted work to an agent**
   - `recordCommittedCommand()` calls `markAgentRunning()` when the command
     launches an agent, the tab is already an agent session, or the foreground
     process looks like an agent.

2. **PTY output while running**
   - In the PTY data listener, any new PTY output while `agentState ===
     'running'` refreshes:
     - `agentLastOutputAtRef`
     - `agentLastBusyEvidenceAtRef`

3. **Visible busy wording**
   - `runAgentBusyCheck()` scans the terminal tail with
     `looksLikeAgentBusy()`.
   - Busy text includes words like `thinking`, `working`, `running`,
     `executing`, `calling`, `searching`, `reading`, `writing`, `editing`,
     and interrupt hints.

The timeout is currently:

```ts
const AGENT_BUSY_ACTIVITY_GRACE_MS = 15_000
```

If no fresh evidence appears for 15 seconds, `runAgentBusyCheck()` calls
`markAgentIdle()`, which calls `setAgentState('idle')`, which fires the popup.

## Likely Root Cause

The popup is using a negative signal as a positive claim.

Current meaning of idle:

> Emu has not seen fresh busy evidence recently.

Popup meaning presented to the user:

> The task is done.

Those are not equivalent.

The false positive happens when the agent is doing work that does not produce
observable terminal output within the 15 second grace window. Examples:

- a web search or fetch that takes time before results are printed
- a tool call whose progress is hidden by the agent UI
- a skill or MCP call that does not continuously redraw the terminal
- internal planning or summarization before the next visible update
- network delay while the foreground process remains the agent

From Emu's perspective, these look like quiet periods. From the user's
perspective, they are real work.

## Important Constraint

Emu cannot perfectly detect invisible background activity from the terminal
alone.

If the agent process does not emit output, does not update its visible UI, and
does not expose an API event for tool activity, Emu has no direct signal that a
background search or tool call is still running.

That means the correct product rule is:

- Use quiet-timeout logic only for low-confidence UI state, such as preventing
  the sidebar from flashing yellow forever.
- Use positive completion evidence for high-confidence notifications, such as
  `rling is done!`.

## Target Behavior

The sidebar indicator and the task-complete popup should not share the same
completion threshold.

| Case | Sidebar | Popup |
|---|---|---|
| Agent is clearly working | Yellow | No |
| Agent is quiet for a while, but no idle prompt was seen | Green or neutral | No |
| Agent returns to a known idle prompt after work | Green | Yes |
| Agent process exits back to shell after work | Green or none | Yes |
| Emu loses confidence because evidence is stale | Green or neutral | No |

The popup should only appear when Emu sees positive completion evidence.

## Proposed Fix

### 1. Add a state transition reason

Change the internal idle path so `setAgentState('idle')` knows why the state is
changing.

Add a small reason type in `TerminalPane.tsx`:

```ts
type AgentIdleReason =
  | 'idle-prompt'
  | 'agent-process-exited'
  | 'shell-prompt'
  | 'quiet-timeout'
  | 'session-cleared'
```

Then change the notification rule:

```ts
const shouldNotifyTaskComplete =
  previousState === 'running' &&
  state === 'idle' &&
  (reason === 'idle-prompt' || reason === 'agent-process-exited' || reason === 'shell-prompt')
```

Do not show the popup for `quiet-timeout`.

This is the smallest safe change because it preserves the existing indicator
behavior while stopping the bad notification.

### 2. Split "quiet" from "complete"

Rename the mental model:

- `quiet-timeout`: no recent evidence of work
- `complete`: explicit evidence that the agent is waiting for user input again

The current `markAgentIdle()` is doing both jobs. Split it into clearer helpers:

```ts
markAgentQuiet(reason: 'quiet-timeout')
markAgentComplete(reason: 'idle-prompt' | 'agent-process-exited' | 'shell-prompt')
clearAgentSession(reason: 'session-cleared')
```

The public `AgentState` can stay as `none | running | idle` for now. The split
can remain internal to `TerminalPane.tsx`.

### 3. Detect explicit idle prompts as completion evidence

`looksLikeAgentIdlePrompt()` already exists. It should become the preferred
completion detector for agent CLIs that remain open.

Run it in these places:

- inside `runAgentBusyCheck()` before applying quiet timeout
- after terminal writes complete, because xterm buffer state is most accurate
  after `terminal.write(data, callback)`
- during hidden-output replay callbacks, so hidden tabs can still detect a real
  prompt when buffered output is rendered

If `looksLikeAgentIdlePrompt(getTerminalTailText(terminal, 16))` is true and the
tab was previously running, call:

```ts
markAgentComplete('idle-prompt')
```

### 4. Treat process exit or shell return as completion only when safe

The existing process poll already calls `ptyGetProcess()`.

Use it as completion evidence only if all of these are true:

- previous state was `running`
- the tab was known to be an agent session
- the foreground process moved from an agent process to a shell process, or the
  agent process exited
- there is no active permission prompt queued for that session
- there is no active composer submit transaction

Then call:

```ts
markAgentComplete('agent-process-exited')
```

or:

```ts
markAgentComplete('shell-prompt')
```

This should not replace idle-prompt detection. It is a fallback for agents that
terminate instead of staying open.

### 5. Keep quiet timeout, but make it notification-silent

Keep `AGENT_BUSY_ACTIVITY_GRACE_MS` so yellow does not get stuck forever.

But when it fires:

```ts
markAgentQuiet('quiet-timeout')
```

That can update the sidebar to green, but it must not call
`showTaskComplete()`.

This directly addresses the false positive without reintroducing the older
stuck-yellow problem.

### 6. Add per-task notification dedupe

Today the main process has debounce behavior for task-complete notifications,
but the renderer should also avoid duplicate completion events for the same
logical task.

Add:

```ts
const agentTaskIdRef = useRef<string | null>(null)
const notifiedAgentTaskIdRef = useRef<string | null>(null)
```

When `markAgentRunning()` starts a new user task:

- create a new `agentTaskIdRef`
- clear `notifiedAgentTaskIdRef`

When completion evidence arrives:

- notify only if `agentTaskIdRef.current !== notifiedAgentTaskIdRef.current`
- set `notifiedAgentTaskIdRef.current = agentTaskIdRef.current`

This prevents repeated popups when the same completed idle screen is scanned
multiple times.

## Investigation Plan

### Phase 1: Instrument the current behavior

Add debug logging behind a localStorage flag such as
`emu.debugTaskComplete`.

Log a structured object whenever these happen:

- `markAgentRunning`
- `runAgentBusyCheck`
- `markAgentIdle`
- `setAgentState`
- `showTaskComplete`
- `refreshAgentProcess`
- PTY output refreshes busy evidence

Each event should include:

- `sessionId`
- previous state
- next state
- proposed transition reason
- foreground process
- `noEvidenceForMs`
- `agentLastOutputAt`
- `agentLastBusyEvidenceAt`
- whether `looksLikeAgentBusy()` matched
- whether `looksLikeAgentIdlePrompt()` matched
- terminal tail snapshot, capped to the last 12 to 16 lines

Keep this debug-only. Do not persist user terminal content outside the console.

### Phase 2: Reproduce the false positive

Run manual scenarios where the agent is likely to pause without terminal
output:

1. Ask Codex to do a task that includes web research.
2. Ask Codex to use a skill that may perform setup or background work.
3. Ask Claude or OpenCode to run a slow tool call.
4. Ask an agent to run a long command that emits output only at the end.

Expected debug finding:

- `runAgentBusyCheck` reaches `noEvidenceForMs >= 15000`
- transition reason would be `quiet-timeout`
- popup currently fires because all `running -> idle` transitions notify

### Phase 3: Validate positive completion signals

Capture terminal tails for real completion across each supported agent:

- Codex idle prompt
- Claude idle prompt
- OpenCode idle prompt
- process returns to `zsh` after a one-shot agent command

Use those captures to harden `looksLikeAgentIdlePrompt()` only where needed.
Do not overfit to old transcript text or examples in docs.

### Phase 4: Implement transition reasons

Modify only `TerminalPane.tsx` first.

Implementation checklist:

- add `AgentIdleReason`
- thread reason through `markAgentIdle` or split into `markAgentQuiet` and
  `markAgentComplete`
- change `setAgentState()` so popup notifications require completion evidence
- route quiet timeout to `quiet-timeout`
- route idle prompt to `idle-prompt`
- route agent exit or shell return to `agent-process-exited` or `shell-prompt`
- add per-task dedupe

Avoid changing the main overlay queue in `src/main/index.ts` unless the
renderer still emits duplicate events after dedupe.

### Phase 5: Add focused tests or a lightweight verifier

This repo does not currently expose a test script in `package.json`, so use the
smallest local pattern that fits.

Preferred follow-up:

- extract the pure state decision into a small helper that can be tested without
  xterm or Electron
- add a script under `scripts/` with fixture cases if no test runner is added

Minimum fixture cases:

| Case | Expected notification |
|---|---|
| running, then 20s silence, no idle prompt | No |
| running, then busy text remains visible | No |
| running, then known idle prompt appears | Yes |
| running, then agent process returns to shell | Yes |
| idle prompt scanned repeatedly for same task | One popup |
| new user task after prior completion | One new popup |

### Phase 6: Manual verification

Run:

```bash
npm run build
```

Then run `npm run dev` and verify:

1. Start a normal agent task that completes quickly.
   - Expected: popup appears after the agent returns to its idle prompt.

2. Start a task with a quiet background web/tool phase.
   - Expected: no popup during the quiet phase.
   - Expected: popup appears only after the final idle prompt.

3. Start a long silent shell command inside an agent task.
   - Expected: no popup while the command is still running.

4. Leave an agent tab idle after a completed task.
   - Expected: no repeated popups.

5. Start a second task in the same tab.
   - Expected: one popup for the second task after real completion.

6. Switch away to a hidden tab while work continues.
   - Expected: hidden PTY output still refreshes busy evidence.
   - Expected: completion is detected when the hidden output replay exposes the
     idle prompt.

## Recommended Implementation Order

1. Add debug instrumentation.
2. Reproduce and confirm `quiet-timeout` is the false-positive path.
3. Add transition reasons and suppress popup on quiet timeout.
4. Add explicit idle-prompt completion.
5. Add process-exit completion fallback.
6. Add per-task notification dedupe.
7. Build and run the manual matrix.

## Non-Goals

- Do not remove the task-complete overlay queue.
- Do not increase the quiet timeout as the primary fix. A longer timer only
  reduces frequency; it does not change the wrong inference.
- Do not make process polling alone decide completion while an agent process is
  still foregrounded.
- Do not persist terminal contents for diagnostics.
- Do not add broad agent-specific parsing unless traces show the generic idle
  prompt detector misses real completions.

## Open Questions

1. Should the sidebar turn green during `quiet-timeout`, or should it show a
   distinct neutral state like "quiet but unconfirmed"?
2. Should the popup wait for an idle prompt forever, or should there be a very
   long fallback such as 5 to 10 minutes with no agent process and a shell
   prompt?
3. Should the completion notification be disabled for agents whose idle prompt
   is unknown until traces are collected?

## Success Criteria

- The popup never fires from `quiet-timeout`.
- The popup fires from explicit completion evidence.
- The sidebar does not get stuck yellow forever.
- A single logical task produces at most one completion popup.
- `npm run build` passes.
- Manual testing covers Codex, Claude, and OpenCode idle behavior where
  available.
