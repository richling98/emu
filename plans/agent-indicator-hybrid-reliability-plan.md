# Agent Indicator Hybrid Reliability Plan

**Status:** Plan only

**Supersedes:** `plans/agent-indicator-reliability-plan.md` and `plans/agent-indicator-first-principles-plan.md`

## Goal

Make the lefthand sidebar light reliable, simple, and understandable:

- **Yellow:** the agent is actively working, thinking, running commands, editing files, or otherwise busy.
- **Green:** the agent is open or the tab is active, but the agent is not currently working.
- **Red:** the tab has had no activity for more than 5 minutes, and the agent is not currently working.

The highest-priority fix is preventing **stuck yellow**. Yellow must never remain forever just because Emu once believed a task had started.

## Plain-English Behavior

The light should follow these simple rules:

- When you ask Claude, OpenCode, or Codex to do something, the light turns yellow immediately.
- While the agent is clearly busy, the light stays yellow.
- If the agent stops printing updates but the screen still says it is thinking, working, running, or interruptible, the light stays yellow.
- Once there is no new activity and no visible sign that the agent is busy, the light turns green shortly afterward.
- If nothing happens in the tab for more than 5 minutes, the light turns red.
- If a red tab starts doing agent work again, it turns yellow immediately.
- Yellow always wins over red while work is actually happening.
- Yellow can never last forever based only on old memory.

## Current Bug

The current implementation can leave the light yellow forever because yellow is controlled by an internal `running` state that gets set when Emu thinks an agent task started.

The normal path back to green depends on recognizing the agent's idle prompt from terminal text. That is brittle because Claude, OpenCode, and Codex can show different prompt layouts, wrapped lines, alternate-screen UIs, or updated wording.

When that idle-prompt detection misses, Emu keeps believing the task is running. Since yellow has priority over green and red, the light keeps flashing yellow and never reaches green or red.

## Design Principle

Do not try to perfectly understand every agent's idle prompt.

Instead, use a simpler question:

> Is there clear recent evidence that the agent is still busy?

If yes, keep yellow.

If no, let yellow expire to green.

This is intentionally different from the current approach:

- Current fragile approach: “Can we prove this exact screen is an idle prompt?”
- New simpler approach: “Can we see clear evidence that the agent is still busy?”

Busy evidence is easier and safer to detect than every possible idle prompt.

## High-Level Heuristic

Use three signals:

| Signal | Purpose |
|---|---|
| User submitted work to an agent | Starts yellow immediately. |
| Recent terminal activity | Keeps yellow alive while the agent is producing output. |
| Visible busy wording | Keeps yellow alive during quiet thinking periods. |

Then add one safety rule:

| Safety Rule | Purpose |
|---|---|
| Maximum yellow lifetime without fresh evidence | Prevents stuck yellow forever. |

## Proposed Constants

Add these timing constants in `src/renderer/src/components/TerminalPane.tsx` near the existing agent timing constants:

```ts
const AGENT_BUSY_ACTIVITY_GRACE_MS = 15_000
const AGENT_BUSY_SCREEN_CHECK_MS = 1_000
const AGENT_BUSY_MAX_WITHOUT_EVIDENCE_MS = 2 * 60 * 1000
```

Meaning:

- `AGENT_BUSY_ACTIVITY_GRACE_MS`: after the last useful task activity, wait 15 seconds before turning green.
- `AGENT_BUSY_SCREEN_CHECK_MS`: while yellow, inspect the visible terminal text once per second.
- `AGENT_BUSY_MAX_WITHOUT_EVIDENCE_MS`: if Emu cannot find fresh evidence for 2 minutes, force green rather than sticking yellow forever.

The exact values can be tuned, but these are a good first implementation:

- 15 seconds is long enough to cover small pauses between updates.
- 1 second is responsive without being expensive.
- 2 minutes is long enough for occasional quiet thinking, but short enough to end stuck yellow.

## State Model

Keep the public UI-facing state as-is:

```ts
export type AgentState = 'none' | 'running' | 'idle'
```

Internally in `TerminalPane.tsx`, replace the sticky task latch with timestamps:

```ts
const agentSessionRef = useRef(false)
const agentTaskStartedAtRef = useRef(0)
const agentLastBusyEvidenceAtRef = useRef(0)
const agentLastOutputAtRef = useRef(0)
const agentBusyCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
const agentShellPollStreakRef = useRef(0)
```

Remove:

```ts
const agentTaskInFlightRef = useRef(false)
```

The key change is that yellow is no longer a permanent latch. Yellow is a state that must be renewed by recent evidence.

## Busy Evidence

### Evidence 1: User asks the agent to work

When the user submits a command/message to an agent session, call `markAgentRunning()`.

This happens today through `recordCommittedCommand()` when:

- The command launches an agent.
- The tab is already an agent session.
- The foreground process looks like an agent.

Keep that behavior.

When `markAgentRunning()` runs, it should:

- Set `agentSessionRef.current = true`.
- Set `agentTaskStartedAtRef.current = Date.now()`.
- Set `agentLastBusyEvidenceAtRef.current = Date.now()`.
- Set `agentState` to `running`.
- Start the busy checker.

### Evidence 2: Terminal output while yellow

When PTY data arrives and the tab is currently yellow, treat that as fresh busy evidence:

```ts
if (agentSessionRef.current && agentStateRef.current === 'running') {
  agentLastOutputAtRef.current = Date.now()
  agentLastBusyEvidenceAtRef.current = Date.now()
  ensureAgentBusyCheckTimer()
}
```

Important: do not turn yellow on for every idle agent output. Some agents may redraw idle UI. PTY output should extend yellow only after the user has started a task and the tab is already `running`.

### Evidence 3: Visible busy wording

While the tab is yellow, periodically inspect the terminal's visible/tail text and look only for clear busy wording.

Use a function like:

```ts
function looksLikeAgentBusy(text: string): boolean {
  const normalized = text
    .split('\n')
    .slice(-12)
    .map((line) => line.replace(/\s+/g, ' ').trim().toLowerCase())
    .join('\n')

  return [
    /\bthinking\b/,
    /\bworking\b/,
    /\brunning\b/,
    /\bexecuting\b/,
    /\bcalling\b/,
    /\bsearching\b/,
    /\breading\b/,
    /\bwriting\b/,
    /\bediting\b/,
    /\besc(?:ape)? to interrupt\b/,
    /\bctrl-c to interrupt\b/,
    /\bpress esc to interrupt\b/,
    /\btool\b.*\b(use|call|running|executing)\b/
  ].some((pattern) => pattern.test(normalized))
}
```

This should replace the current yellow-to-green dependency on `looksLikeAgentIdlePrompt()`.

Key distinction:

- Keep detecting busy words.
- Stop requiring exact idle-prompt detection for the sidebar indicator.

## Busy Checker

Add one central checker that owns the yellow-to-green transition:

```ts
const ensureAgentBusyCheckTimer = () => {
  if (agentBusyCheckTimerRef.current) return
  agentBusyCheckTimerRef.current = window.setTimeout(runAgentBusyCheck, AGENT_BUSY_SCREEN_CHECK_MS)
}

const clearAgentBusyCheckTimer = () => {
  if (!agentBusyCheckTimerRef.current) return
  clearTimeout(agentBusyCheckTimerRef.current)
  agentBusyCheckTimerRef.current = null
}

const runAgentBusyCheck = () => {
  agentBusyCheckTimerRef.current = null
  if (disposed) return
  if (agentStateRef.current !== 'running') return

  const now = Date.now()
  const text = getTerminalTailText(terminal, 16)
  const hasBusyText = looksLikeAgentBusy(text)

  if (hasBusyText) {
    agentLastBusyEvidenceAtRef.current = now
  }

  const quietForMs = now - agentLastBusyEvidenceAtRef.current
  const runningForMs = now - agentTaskStartedAtRef.current

  if (quietForMs >= AGENT_BUSY_ACTIVITY_GRACE_MS) {
    markAgentIdle(agentProcessRef.current)
    return
  }

  if (runningForMs >= AGENT_BUSY_MAX_WITHOUT_EVIDENCE_MS && !hasBusyText) {
    markAgentIdle(agentProcessRef.current)
    return
  }

  ensureAgentBusyCheckTimer()
}
```

Implementation note: the maximum-without-evidence condition should be based on lack of fresh evidence, not merely total runtime. If a task is actively printing output or showing busy wording, it should remain yellow longer than 2 minutes.

A safer version is:

```ts
const noEvidenceForMs = now - agentLastBusyEvidenceAtRef.current
if (noEvidenceForMs >= AGENT_BUSY_MAX_WITHOUT_EVIDENCE_MS) {
  markAgentIdle(agentProcessRef.current)
  return
}
```

Use the safer version in implementation.

## Agent State Functions

### `markAgentRunning()`

Change to:

```ts
const markAgentRunning = (foregroundProcess: string | null = agentProcessRef.current) => {
  const now = Date.now()
  agentSessionRef.current = true
  agentTaskStartedAtRef.current = now
  agentLastBusyEvidenceAtRef.current = now
  debugScrollFollow('agent-running', { foregroundProcess })
  setAgentState('running', foregroundProcess)
  ensureAgentBusyCheckTimer()
}
```

### `markAgentIdle()`

Change to:

```ts
const markAgentIdle = (foregroundProcess: string | null = agentProcessRef.current) => {
  clearAgentBusyCheckTimer()
  agentTaskStartedAtRef.current = 0
  agentLastBusyEvidenceAtRef.current = 0
  if (!agentSessionRef.current && !isAgentProcessName(foregroundProcess)) return
  setAgentState('idle', foregroundProcess)
}
```

### `clearAgentSession()`

Change to:

```ts
const clearAgentSession = (foregroundProcess: string | null = agentProcessRef.current) => {
  clearAgentBusyCheckTimer()
  clearAgentIdleTimer()
  agentSessionRef.current = false
  agentTaskStartedAtRef.current = 0
  agentLastBusyEvidenceAtRef.current = 0
  agentShellPollStreakRef.current = 0
  debugScrollFollow('agent-cleared', { foregroundProcess })
  setAgentState('none', foregroundProcess)
}
```

If `agentIdleTimerRef` is fully unused after this rewrite, delete it too. If other code still uses it, keep it but do not use it for indicator state.

## Process Polling Changes

Process polling should not decide whether an active task is done.

It should only answer:

- Is this terminal currently an agent session?
- Has the agent CLI exited after it was already idle?
- What foreground process/provider should Emu display/use for input routing?

In `refreshAgentProcess()`:

- If the process is an agent, mark `agentSessionRef.current = true` and reset `agentShellPollStreakRef.current = 0`.
- If the process is a shell while `agentStateRef.current === 'running'`, do not clear the session.
- If the process is a shell while not running, increment `agentShellPollStreakRef.current`.
- Only call `clearAgentSession(proc)` after 2 consecutive shell polls while not running.
- Reset `agentShellPollStreakRef.current` when the process is neither shell nor agent.

This prevents a shell command run by the agent from falsely turning the light green mid-task.

## Sidebar Changes

Keep the sidebar color priority exactly this simple:

```ts
if (session.agentState === 'running') return 'running'
if (now.getTime() - session.lastActiveAt.getTime() >= STALE_AFTER_MS) return 'stale'
return 'complete'
```

Keep:

```ts
const STALE_AFTER_MS = 5 * 60 * 1000
```

Optional copy updates:

```ts
if (status === 'running') return 'Agent task active'
if (status === 'stale') return 'No activity for 5 minutes'
return 'Task complete or agent idle'
```

## Implementation Steps

### Step 1: Add the new timing constants

File: `src/renderer/src/components/TerminalPane.tsx`

Add:

```ts
const AGENT_BUSY_ACTIVITY_GRACE_MS = 15_000
const AGENT_BUSY_SCREEN_CHECK_MS = 1_000
const AGENT_BUSY_MAX_WITHOUT_EVIDENCE_MS = 2 * 60 * 1000
```

### Step 2: Add `looksLikeAgentBusy()`

File: `src/renderer/src/components/TerminalPane.tsx`

Place near the existing agent text helpers.

Keep it narrow and focused on clear busy evidence. Do not include broad idle-prompt matching.

### Step 3: Add new refs

File: `src/renderer/src/components/TerminalPane.tsx`

Add:

```ts
const agentLastBusyEvidenceAtRef = useRef(0)
const agentLastOutputAtRef = useRef(0)
const agentBusyCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
const agentShellPollStreakRef = useRef(0)
```

### Step 4: Remove the sticky latch

Delete:

```ts
const agentTaskInFlightRef = useRef(false)
```

Remove every read/write of `agentTaskInFlightRef.current`.

### Step 5: Replace `scheduleAgentIdleCheck()`

Delete the existing `scheduleAgentIdleCheck()` function that checks `looksLikeAgentIdlePrompt()`.

Add:

- `ensureAgentBusyCheckTimer()`
- `clearAgentBusyCheckTimer()`
- `runAgentBusyCheck()`

### Step 6: Update state transitions

Update:

- `markAgentRunning()`
- `markAgentIdle()`
- `clearAgentSession()`

Use the behavior described above.

### Step 7: Update `onPtyData()`

Remove:

```ts
scheduleAgentIdleCheck()
```

Add near the top of the PTY data handler, after activity is recorded:

```ts
if (agentSessionRef.current && agentStateRef.current === 'running') {
  const now = Date.now()
  agentLastOutputAtRef.current = now
  agentLastBusyEvidenceAtRef.current = now
  ensureAgentBusyCheckTimer()
}
```

### Step 8: Update process polling

Change the shell clearing branch in `refreshAgentProcess()` so shell process snapshots cannot clear `running`.

Require 2 consecutive shell polls while not running before clearing the agent session.

### Step 9: Update sidebar tooltip copy

File: `src/renderer/src/components/Sidebar.tsx`

Keep the 5-minute red threshold unchanged.

Update tooltip copy to mention all agents instead of only Claude/Codex.

### Step 10: Cleanup on unmount/exit

Make sure cleanup clears the new timer:

```ts
clearAgentBusyCheckTimer()
```

Add it wherever the existing terminal effect cleanup clears timers/listeners.

Also call it in `onPtyExit()` through `clearAgentSession(null)`.

## Expected Behavior Matrix

| Scenario | Expected light |
|---|---|
| User submits a task to Claude/OpenCode/Codex | Yellow immediately. |
| Agent streams output continuously | Yellow stays on. |
| Agent pauses output but screen says thinking/working/running | Yellow stays on. |
| Agent finishes and waits for next message | Green after about 15 seconds. |
| Agent is idle for 5 minutes | Red. |
| Red tab receives a new agent task | Yellow immediately. |
| Agent runs shell commands internally | Yellow does not get cleared by the shell process snapshot. |
| Agent silently works for a long time with no visible busy text | May turn green after the fallback window; turns yellow again on new output. |
| Plain shell tab runs normal shell commands | Does not become yellow. |
| Hidden tab receives agent output | Still updates because PTY data is handled even while hidden. |

## Why This Is Simple

This design does not require a full agent protocol or provider-specific integrations.

It uses only signals Emu already has:

- User submitted something.
- Terminal printed something.
- Terminal visibly says the agent is busy.
- Tab has been quiet for 5 minutes.

It avoids the current fragile requirement to recognize every possible idle prompt.

## Known Tradeoff

There is no perfect way to know that an agent is silently thinking if it prints nothing and shows no busy text.

The chosen tradeoff is:

- Prefer occasionally turning green too early during a truly silent long-running task.
- Avoid the much worse current failure of staying yellow forever after work is done.

This tradeoff is self-healing because any new output or new submitted task turns the light yellow again.

## Verification Plan

### Automated

Run:

```sh
npm run build
```

There is no existing test suite in the repo, so build/typechecking is the available automated check.

### Manual

Before testing, close stale Emu/Electron windows so the test is running the updated build.

Test these cases:

1. Claude normal task

- Launch Claude.
- Submit a small coding task.
- Confirm yellow while working.
- Confirm green shortly after completion.
- Confirm red after 5 minutes idle.

2. OpenCode normal task

- Launch OpenCode.
- Submit a small coding/search task.
- Confirm the same yellow to green to red flow.

3. Codex normal task

- Launch Codex.
- Submit a small task.
- Confirm the same yellow to green to red flow.

4. Long visible thinking

- Submit a task that causes visible thinking/working/running status.
- Confirm yellow remains while the screen shows busy wording, even if normal output pauses.

5. Shell subprocess

- Ask an agent to run shell commands.
- Confirm the light does not turn green just because the foreground process briefly looks like a shell.

6. Hidden tab

- Start an agent task.
- Switch to another tab/workspace.
- Confirm the sidebar dot still moves from yellow to green when the hidden task finishes.

7. Plain shell control

- Open a non-agent shell tab.
- Run normal commands.
- Confirm it never turns yellow.

8. Stuck-yellow regression

- Reproduce a case that used to stay yellow forever.
- Confirm it turns green without clicking, typing, or restarting.

## Success Criteria

- Yellow starts immediately when agent work is submitted.
- Yellow stays on during visible thinking or active output.
- Yellow turns green after the agent stops showing busy evidence.
- Red appears after 5 minutes of no activity.
- Shell subprocesses do not falsely clear yellow mid-task.
- No tab remains yellow forever after the agent has stopped working.
