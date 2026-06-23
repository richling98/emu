# Agent Indicator Reliability Plan

**Status:** Plan only

**Supersedes:** `plans/agent-indicator-first-principles-plan.md`

## Goal

Make the left sidebar indicator deterministic and self-healing for agent tabs:

| State | Color | Rule |
|---|---|---|
| Agent actively running a task or writing code | Yellow | The tab has an active agent task in flight. |
| Task done, agent not actively running | Green | The agent CLI may still be open, but it is idle or waiting for the next user message. |
| Tab idle for more than 5 minutes | Red | No terminal/user activity for 5 minutes, and no active task is running. |

The most important requirement is: **yellow must not be sticky.** Once Claude, OpenCode, or Codex finishes and is no longer actively running work, the indicator must become green. If no activity happens for 5 minutes after that, it must become red.

## Plain-English Light Rules

The light should work like this:

- **Yellow means the agent is busy.** It should turn yellow as soon as you ask Claude, OpenCode, or Codex to do something, and it should stay yellow while the agent is still working, printing updates, running commands, editing files, or otherwise making progress.
- **Green means the agent is available.** It should turn green shortly after the agent finishes its work and is waiting for your next message. If the agent is open but not actively doing anything, the light should be green.
- **Red means the tab has gone quiet for a while.** If nothing has happened in that tab for more than 5 minutes, and the agent is not currently working, the light should turn red.
- **Yellow always wins over red.** Even if a tab was red because it had been quiet, it should immediately turn yellow again when you ask the agent to do new work.
- **The light should never get stuck yellow.** If the agent has stopped working, the light must move back to green without needing you to click the tab, type anything, or restart the app.

## Current Implementation

### Sidebar rendering

The visible dot lives in `src/renderer/src/components/Sidebar.tsx`.

`getSessionDotStatus()` currently maps session state to colors:

```ts
if (session.agentState === 'running') return 'running'
if (now.getTime() - session.lastActiveAt.getTime() >= STALE_AFTER_MS) return 'stale'
return 'complete'
```

This means:

- Yellow is driven entirely by `session.agentState === 'running'`.
- Red is driven by `lastActiveAt` crossing `STALE_AFTER_MS`.
- Green is the fallback when the tab is not running and is not stale.
- `STALE_AFTER_MS` is already `5 * 60 * 1000`, matching the desired 5-minute red rule.
- The sidebar refreshes its local `now` every 30 seconds, so red can appear up to 30 seconds after the exact 5-minute threshold.

### Session aggregation

The sidebar receives summarized workspaces from `src/renderer/src/App.tsx`.

`summarizeSession()` currently chooses:

- `running` if any top tab inside the workspace is running.
- Otherwise, the selected tab's state.
- `lastActiveAt` from the most recently active top tab.

This aggregation is mostly correct for a workspace-level sidebar dot: one active agent task should make the workspace yellow even if another top tab is selected. The reliability problem is upstream: individual terminal tabs can remain stuck in `agentState: 'running'`.

### Agent state source

The actual `agentState` is owned inside `src/renderer/src/components/TerminalPane.tsx`.

Important current pieces:

- `AgentState` is `none | running | idle` in `App.tsx`.
- `agentSessionRef` remembers whether the terminal is believed to be an agent session.
- `agentTaskInFlightRef` is a separate latch for whether a submitted agent task is believed to still be active.
- `markAgentRunning()` sets `agentSessionRef = true`, `agentTaskInFlightRef = true`, `agentState = 'running'`.
- `markAgentIdle()` clears `agentTaskInFlightRef`, clears `agentTaskStartedAtRef`, and sets `agentState = 'idle'` only if Emu still believes this is an agent session.
- `clearAgentSession()` clears the agent session and sets `agentState = 'none'`.
- `recordCommittedCommand()` calls `markAgentRunning()` when the command launches an agent, when an agent session is already known, or when the foreground process looks like an agent.
- `onPtyData()` calls `scheduleAgentIdleCheck()` after every PTY data event.

### Current yellow to green path

`scheduleAgentIdleCheck()` is the only normal yellow-to-green mechanism after output arrives:

```ts
const scheduleAgentIdleCheck = () => {
  if (!agentTaskInFlightRef.current) return
  clearAgentIdleTimer()
  agentIdleTimerRef.current = setTimeout(() => {
    agentIdleTimerRef.current = null
    if (!agentTaskInFlightRef.current) return
    recordPerfEvent('agentIdleChecks')
    if (looksLikeAgentIdlePrompt(getTerminalTailText(terminal))) {
      markAgentIdle(agentProcessRef.current)
    }
  }, AGENT_IDLE_CHECK_DELAY_MS)
}
```

This depends on all of these being true:

- `agentTaskInFlightRef.current` is true.
- A timer fires 900ms after the last PTY event.
- `getTerminalTailText()` can read a meaningful rendered terminal tail.
- `looksLikeAgentIdlePrompt()` recognizes the current agent UI as idle.

If the idle-prompt regex misses once after the task is complete, nothing else necessarily changes the tab to green. That is the current stuck-yellow failure.

### Process polling path

`refreshAgentProcess()` polls `window.api.ptyGetProcess(session.id)` every 4 seconds for visible/running tabs and every 16 seconds for hidden non-running tabs.

It currently uses process snapshots for several jobs:

- Detecting whether the foreground process is an agent CLI.
- Updating `foregroundProcess` and provider hints.
- Switching input ownership between the rich composer and raw xterm.
- Detecting raw TUI exit.
- Clearing agent state when the foreground process looks like a shell.

The current shell branch can clear a running task when a single poll sees a shell process under broad conditions:

```ts
} else if (isShellProcessName(proc) && (
  agentStateRef.current !== 'running' ||
  isAgentProcessName(previousProcess) ||
  Date.now() - agentTaskStartedAtRef.current > AGENT_PROCESS_POLL_MS
)) {
  clearAgentSession(proc)
}
```

This creates a different failure mode: process polling can mark a task complete while an agent is actually using a shell subprocess. That is a false green risk.

## What Has Already Been Tried

### Current live attempt

The live implementation tries to infer task completion by reading rendered terminal text and matching known idle prompt shapes. This is the `looksLikeAgentIdlePrompt()` approach.

Why it fails:

- Claude, OpenCode, and Codex terminal UIs change over time.
- Different providers use different idle prompt formats.
- Alt-screen rendering, hidden output buffering, wrapped lines, and box-drawing UI can make rendered tail text differ from raw expectations.
- A single missed idle prompt leaves `agentTaskInFlightRef` true and keeps the sidebar yellow.
- The code has no independent recovery mechanism after regex failure.

### Earlier first-principles plan

`plans/agent-indicator-first-principles-plan.md` correctly identified the stuck-yellow root cause and proposed replacing prompt regex detection with a silence debounce.

That plan has two issues that need correction before implementation:

- It says red should happen after 10 minutes, but the current requirement is 5 minutes.
- It assumes continuous agent status redraws are always present during active tasks. That is often true, but the final design should explicitly define how to handle long-running silent subprocesses instead of relying on a hidden assumption.

### Related recent work

Recent commits and plans focus heavily on agent permission popups, OpenCode detection, scroll follow, rich input submission, and provider inference. Those changes improved recognizing agent sessions and permission prompts, but they did not create an authoritative busy/idle state for the sidebar indicator. The indicator still depends on `TerminalPane`'s fragile `agentState` transitions.

## Root Cause

The indicator is unreliable because it mixes three different concepts into one state:

- Is this terminal an agent session?
- Is the agent process currently present?
- Is the agent actively running a task right now?

The stuck-yellow bug happens because `agentTaskInFlightRef` is a latch, and its normal reset path depends on a brittle rendered-text regex. Once the reset path fails, the latch keeps `agentState` at `running` indefinitely.

The false-green risk happens because process polling is allowed to clear a running task based on a transient foreground process snapshot, even though agents often spawn shell subprocesses while still actively working.

The fix should not tune more regexes. The fix should make the state machine explicit, symmetric, and recoverable.

## Target Model

Separate the concepts in code:

```ts
type AgentPresence = 'none' | 'present'
type AgentTaskState = 'idle' | 'running'
```

For minimal code churn, this does not require changing public React types immediately. Internally, `TerminalPane` can keep:

- `agentSessionRef`: whether an agent session is known or strongly suspected.
- `agentStateRef`: the UI-facing state, still `none | idle | running`.
- A new task activity clock: last time a task was submitted or task output was observed.
- A single idle deadline timer that always has authority to move `running -> idle`.

The sidebar remains simple:

- Yellow if `agentState === 'running'`.
- Else red if `lastActiveAt >= 5 minutes`.
- Else green.

## Reliability Invariants

These invariants should be true after implementation:

- A tab cannot remain yellow forever unless PTY output or explicit task-running evidence keeps extending the running window.
- Any new user submission to a known agent session immediately turns yellow.
- Any PTY output from a known agent session while a task is considered running extends the yellow window.
- A running task can become green by exactly one primary mechanism: the task activity window expires.
- Rendered terminal text cannot be required for yellow-to-green.
- Process polling cannot clear `running` on a single shell-process snapshot.
- Process polling can still clear `idle/none` bookkeeping after the agent has exited.
- Red is never shown while `agentState === 'running'`.
- Red appears after 5 minutes of no `lastActiveAt` updates, with the existing sidebar timer granularity.

## Proposed Implementation

### Step 1: Rename and replace the idle timer semantics

Add one timing constant near the existing terminal constants:

```ts
const AGENT_TASK_SILENCE_TIMEOUT_MS = 12_000
```

Rationale:

- Long enough to avoid flicker between bursts of normal agent output.
- Short enough that completed tasks turn green quickly.
- More forgiving than the old 900ms regex check.

Keep `agentIdleTimerRef`, but make it a silence-debounce timer rather than a prompt-regex timer.

Add one helper inside the main terminal effect:

```ts
const armAgentTaskSilenceTimer = () => {
  clearAgentIdleTimer()
  agentIdleTimerRef.current = window.setTimeout(() => {
    agentIdleTimerRef.current = null
    recordPerfEvent('agentIdleChecks')
    markAgentIdle(agentProcessRef.current)
  }, AGENT_TASK_SILENCE_TIMEOUT_MS)
}
```

### Step 2: Remove rendered-text completion detection

Delete `scheduleAgentIdleCheck()` as a busy/idle mechanism.

Remove this call from `onPtyData()`:

```ts
scheduleAgentIdleCheck()
```

Do not delete `looksLikeAgentIdlePrompt()` yet. It is still used by rich submit routing:

```ts
looksLikeAgentIdlePrompt(getTerminalTailText(terminal, 16))
```

That usage is a separate input-routing heuristic, not the sidebar busy/idle state. Keeping it avoids a larger behavior change.

### Step 3: Make running state self-healing on task output

Change `markAgentRunning()` so it sets running and arms the silence timer:

```ts
const markAgentRunning = (foregroundProcess = agentProcessRef.current) => {
  agentSessionRef.current = true
  agentTaskStartedAtRef.current = Date.now()
  debugScrollFollow('agent-running', { foregroundProcess })
  setAgentState('running', foregroundProcess)
  armAgentTaskSilenceTimer()
}
```

Then in `onPtyData()`, before output buffering decisions, add:

```ts
if (agentSessionRef.current && agentStateRef.current === 'running') {
  markAgentRunning(agentProcessRef.current)
}
```

This means any byte from a known currently-running agent session extends the yellow window.

Important nuance: do **not** mark every idle agent byte as running forever. Some CLIs redraw prompts or status UI while idle. Only extend yellow when the tab is already in `running`, or immediately after a user submission has called `markAgentRunning()`.

### Step 4: Remove `agentTaskInFlightRef`

Delete `agentTaskInFlightRef` and all reads/writes.

After Step 1-3, it is no longer needed because `agentStateRef.current === 'running'` becomes the task-in-flight flag.

This removes the one-way latch that causes sticky yellow.

### Step 5: Gate process-poll clearing behind idle state

Add a ref:

```ts
const agentShellPollStreakRef = useRef(0)
```

In `refreshAgentProcess()`:

- If `isAgent` is true, set `agentSessionRef.current = true`, reset `agentShellPollStreakRef.current = 0`, and keep the current behavior of setting `idle` when state is `none`.
- If `isShellProcessName(proc)` is true while `agentStateRef.current === 'running'`, do not clear the agent session. Leave the running state to the silence timer.
- If `isShellProcessName(proc)` is true while `agentStateRef.current !== 'running'`, increment `agentShellPollStreakRef`.
- Only call `clearAgentSession(proc)` after at least 2 consecutive shell polls while not running.
- Reset the streak for non-shell, non-agent process names.

This prevents a transient `bash`, `zsh`, or shell subprocess snapshot from overriding the active-task state.

### Step 6: Keep the 5-minute red rule unchanged

Do not change `Sidebar.tsx`'s stale threshold. It already matches the requirement:

```ts
const STALE_AFTER_MS = 5 * 60 * 1000
```

Optional small polish:

- Update `getSessionDotTitle('complete')` from `Task complete or idle` to `Task complete or agent idle`.
- Update `getSessionDotTitle('running')` from `Claude/Codex task active` to `Agent task active` so OpenCode is included.

### Step 7: Add diagnostic logging for real-world validation

Add a focused debug flag, or reuse `emu.debugScrollFollow`, to log state transitions:

```ts
debugScrollFollow('agent-indicator-transition', {
  from,
  to,
  reason,
  foregroundProcess,
  agentSession: agentSessionRef.current,
  shellPollStreak: agentShellPollStreakRef.current
})
```

Reasons should include:

- `agent-command-submitted`
- `agent-output-extended-running`
- `agent-silence-timeout`
- `agent-process-detected`
- `agent-shell-exit-confirmed`
- `pty-exit`

This makes future bug reports inspectable without guessing from UI behavior.

## Edge Cases and Expected Behavior

| Scenario | Expected indicator behavior |
|---|---|
| User launches Claude/OpenCode/Codex | Yellow while launch/task output is active, then green after silence timeout if waiting for input. |
| User submits a task to an idle agent | Yellow immediately on submit. |
| Agent finishes normally and waits for next prompt | Green within `AGENT_TASK_SILENCE_TIMEOUT_MS`. |
| Agent is idle for 5 minutes | Red on the next sidebar timer tick. |
| Agent starts work after being red | Yellow immediately on submit/output, because running takes priority over stale. |
| Claude uses Bash tool and foreground process briefly becomes `bash` | Stay yellow. Process polling cannot clear running. |
| Agent runs a long command that produces periodic output | Stay yellow because PTY output extends the timer. |
| Agent runs a truly silent tool longer than timeout | May turn green early, then yellow again on next output. This is preferable to permanent stuck yellow and is self-healing. |
| User exits agent CLI after it is idle | Stay green initially, then internal state can become `none` after 2 shell polls. UI remains green unless stale. |
| Plain shell tab with no agent | Never yellow. Green initially, red after 5 minutes idle. |
| Hidden tab receives agent output | State still updates because `onPtyData()` fires for hidden tabs before buffering. |
| Workspace has multiple top tabs and one is running | Sidebar workspace dot is yellow because `summarizeSession()` prioritizes any running tab. |

## Testing Plan

### Automated checks

Run after implementation:

```sh
npm run build
```

There is no current test suite in the repo, so build/typechecking is the available automated verification.

### Manual validation matrix

Before testing, close stale Emu/Electron instances so results are not coming from an old build.

1. Claude Code basic completion

- Open a new tab.
- Launch Claude Code.
- Submit a small task that clearly finishes.
- Expected: yellow during work, green within the silence timeout after completion, red after 5 minutes with no activity.

2. OpenCode basic completion

- Open a new tab.
- Launch OpenCode.
- Submit a small coding/search task.
- Expected: same yellow to green to red behavior.

3. Codex basic completion

- Open a new tab.
- Launch Codex.
- Submit a small task.
- Expected: same yellow to green to red behavior.

4. Shell subprocess protection

- In Claude/OpenCode/Codex, submit a task that runs several shell commands.
- Expected: foreground process may briefly show shell, but the dot stays yellow until output stops.

5. Hidden tab behavior

- Start a long agent task.
- Switch to another workspace or top tab while it runs.
- Expected: hidden tab/workspace remains yellow while output continues; after completion it turns green without needing to view the tab.

6. Stale red behavior

- Let a green idle tab sit untouched for 5 minutes.
- Expected: red appears within the sidebar's 30-second refresh window.

7. Red to yellow recovery

- Return to a red agent tab and submit a new task.
- Expected: yellow immediately, proving stale state does not block running state.

8. Plain shell control

- Open a tab and never launch an agent.
- Run normal shell commands.
- Expected: no yellow; green after command output, red after 5 minutes idle.

## Implementation Checklist

- [ ] Add `AGENT_TASK_SILENCE_TIMEOUT_MS`.
- [ ] Add `armAgentTaskSilenceTimer()`.
- [ ] Change `markAgentRunning()` to arm the silence timer.
- [ ] Change `markAgentIdle()` to be unconditional for known agent sessions and not depend on `agentTaskInFlightRef`.
- [ ] Remove `scheduleAgentIdleCheck()`.
- [ ] Remove `scheduleAgentIdleCheck()` call from `onPtyData()`.
- [ ] Extend running state from `onPtyData()` only when `agentStateRef.current === 'running'`.
- [ ] Delete `agentTaskInFlightRef`.
- [ ] Add `agentShellPollStreakRef`.
- [ ] Change `refreshAgentProcess()` so shell snapshots cannot clear `running`.
- [ ] Require 2 consecutive shell polls before clearing an idle agent session.
- [ ] Keep `STALE_AFTER_MS` at 5 minutes.
- [ ] Update indicator titles to mention all agent providers.
- [ ] Run `npm run build`.
- [ ] Complete the manual validation matrix.

## Success Criteria

- No tab remains yellow after an agent has visibly returned to an idle prompt.
- Green appears shortly after task completion without requiring the user to click, type, or switch tabs.
- Red appears after 5 minutes of no activity.
- Yellow takes precedence over red whenever a task is actively running.
- Shell subprocesses do not cause false green mid-task.
- The behavior is provider-agnostic across Claude, OpenCode, and Codex.

## Non-Goals

- Adding per-top-tab indicator dots in `TopTabBar.tsx`. The current request is about the lefthand sidebar indicator.
- Rewriting permission prompt detection.
- Rewriting rich input routing.
- Building a full agent protocol integration. The plan uses the PTY and process signals currently available.
