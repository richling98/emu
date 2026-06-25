# EMU CPU & Memory Optimization Plan

## Diagnostic Summary

EMU runs hot because it was architected for correctness and feature depth — not efficiency at scale. With multiple parallel terminal sessions, the compounding effect of per-event, per-session scan/timer/poll overhead pushes the MacBook past thermal limits.

### The Core Problem

**Linear scaling of per-event work × number of sessions.** Every byte of PTY output triggers a cascade of synchronous work in both the main process and renderer process simultaneously — permission scans, buffer management, state checks, and IPC — all before the user even sees the character on screen. With N parallel sessions, this overhead multiplies by N.

---

## CPU Hotspots (ranked by impact)

### 1. Dual-Process Agent Permission Detection — #1 Offender

Every PTY `onData` event triggers **two independent, redundant agent permission scans** — one in the main process (`scanAgentPermissionPtyOutput`, `src/main/index.ts:255`) and **4-8 more** in the renderer (`detectPermissionPrompt`, `src/renderer/src/components/TerminalPane.tsx:1912`). Each scan:

- Strips ANSI escape codes via regex
- Splits into lines, normalizes, filters
- Runs 15-20 regex tests across multiple parsers
- Scans the full plain-text raw buffer (32KB rolling tail)

**In the renderer, per data event:**
- `raw` scan — immediate, on raw data
- `raw-buffer` scan — immediate, on accumulated 32KB raw buffer
- `write-parsed` scan — in `terminal.write()` callback (post-render)
- 3× `followup` scans — delayed at 50ms, 150ms, 300ms (Claude sessions)
- `watchdog` — every 500ms for 30s after output

**This is the single biggest source of unnecessary CPU work.** The main process scan is especially wasteful — it runs on raw terminal bytes *before* xterm renders them, performing the same regex work that the renderer then repeats.

### 2. PTY Output Pipeline (Every Byte, Every Session)

Data flows through 6 stages synchronously before the user sees it:
1. `node-pty` emits `onData` callback
2. Main process: scan agent permission → update perf stats → batch output (12ms window)
3. IPC: `send('pty:data:<id>', data)` — serializes large strings
4. Renderer: receive IPC → scan permission (raw + raw-buffer) → touch activity timers → check CWD escapes → `terminal.write(data)` → wait for render callback → scan again (write-parsed + followups)
5. xterm.js WebGL: parse, layout, render glyphs
6. If agent running: run busy-check scan against rendered buffer (12 lines)

### 3. Process Polling (Timer-Based, Not Event-Driven)

`refreshAgentProcess` runs `window.api.ptyGetProcess(session.id)` every **4 seconds** per visible tab, **16 seconds** per hidden tab. Each poll:
- IPC round-trip to main process
- State machine evaluation (agent state transitions, shell detection, raw TUI mode)
- With 6+ parallel sessions: ~90 IPC polls/minute

The foreground process name only changes when the user runs a command in that terminal. Timer-based polling is wasteful.

### 4. Agent Busy State Check (1s Interval While Running)

While `agentState == 'running'`, a `setTimeout` fires every **1 second** to:
- Read 16 lines from the xterm.js rendered buffer (line-by-line `buf.getLine()`)
- Run regex against the text for busy keywords
- Update timestamps and state

### 5. Wheel Handler (Capture Phase, Non-Passive)

All wheel events are captured at the document level with `{ capture: true, passive: false }` (`TerminalPane.tsx:1725`). This forces the browser to wait for the JS handler before scrolling, which defeats the compositor's ability to scroll on the GPU thread. Every scroll event goes through JavaScript first.

### 6. Command History Output Capture (Rendered Buffer Read)

`flushOutputBuffer` (`TerminalPane.tsx:1861`) reads the xterm.js rendered buffer **line by line** (`buf.getLine(ln).translateToString(true)`) after every command. For commands with 500+ lines of output, this iterates through every rendered line and joins them — then runs `cleanCopiedOutput` (strip ANSI) + `capCommandOutput` (head/tail truncate at 200K chars). This runs on every command regardless of whether the tab is visible or the command is trivial.

---

## Memory Hotspots

### 1. Hidden Output Buffers

Each non-visible tab accumulates up to **2 MB** of PTY output in `hiddenOutputBufferRef` before replaying. With 8 parallel sessions (6 hidden): up to **12 MB** of buffered terminal output in memory at all times.

### 2. xterm.js Scrollback × N Sessions

Each `Terminal` instance has `SCROLLBACK = 5000` lines. With WebGL rendering, each line incurs GPU memory for glyph textures. 6 parallel sessions = 6 xterm.js instances with separate WebGL renderers.

### 3. Command History Accumulation

Per-command output is stored in React state (up to 200K chars per command). Over a long session, this grows unboundedly.

### 4. Per-Session State Maps (Main Process)

Each session maintains separate state in 5+ maps:
- `ptyProcesses` — the node-pty process
- `ptyPerfStats` — cumulative counters
- `ptyOwnerWindowIds` — overlay targeting
- `agentPermissionSessionState` — detector instance + 32KB raw tail + provider state
- `ptyOutputBatches` — pending output batches

### 5. Separate BrowserWindow Overlays

Two persistent `BrowserWindow` instances (permission overlay + task complete notification) with transparency, always-on-top, and vibrancy consume GPU compositing resources even when idle.

---

## Optimization Strategies

### Tier 1: High Impact, Low Risk

#### 1.1 Eliminate Main Process Permission Scan

**What:** Remove `scanAgentPermissionPtyOutput()` from the main process `onData` callback. The renderer already runs an equivalent scan on rendered text.

**Why:** The main process scan runs on raw bytes, performs the same regex work, and duplicates renderer logic. Removing it eliminates ~40-50% of the per-event CPU cost in the main process.

**Risk Analysis — Is the main process scan critical?**

The main process scan (`src/main/index.ts:255`) does four things the renderer also does:

| Function | Main Process | Renderer |
|----------|-------------|----------|
| Provider from process name | Real-time via `ptyProcess.process` | Every 4-16s via polling (`pty:process` IPC) |
| Provider from text (`inferProviderFromText`) | On every data event | On every data event (`raw` + `raw-buffer` scans) |
| 32KB rolling raw tail buffer | Separate `rawTail` per session | Separate `agentPermissionRawBuffer` (also 32KB) |
| `AgentPermissionPromptDetector.append()` | Separate detector instance per session | Separate detector instance per tab |

**Key finding: The main process scan provides only one marginal advantage — real-time process name access.** When an agent starts and immediately outputs a permission prompt, the main process can detect `agentSession = true` from `ptyProcess.process` on the first `onData` event without waiting for a polling round-trip.

**However, this advantage is already covered by the renderer in two ways:**

1. **`inferProviderFromText`** — The renderer's `raw` scan (line 2030) runs unconditionally and calls `inferProviderFromText(data)` on every data chunk. Permission prompts inherently contain recognizable keywords (`Allow`, `Approve`, `Permission`, `Proceed`, `Command`, `Tool Use`, etc.). The regex patterns for these are in `src/shared/agentPermissionPrompts.ts:693-719`. If the data chunk contains any of these, the full detector runs regardless of `agentSession` state.

2. **`raw-buffer` scan** — The renderer's `raw-buffer` scan (line 2031) accumulates data into a 32KB rolling buffer and passes the full buffer to the detector. This catches multi-line prompts where individual chunks lack keywords but the accumulated buffer contains them. This mirrors the main process's `rawTail` mechanism exactly.

3. **Input-side agent marking** — When the user types a command that launches an agent, `recordCommittedCommand` (line 1289) and the raw xterm Enter handler (line 2229) both call `getAgentProviderFromCommand(cmd)` and `markAgentRunning()` immediately, setting `agentSessionRef.current = true` and `agentProviderRef.current` before any output arrives. Both paths are in the renderer, independent of main process scanning.

**Conclusion: The main process scan is fully redundant and can be safely removed.** The only theoretical gap — a multi-line prompt on a hidden tab where the agent started without user input and the polling hasn't fired yet — is covered by the renderer's `raw-buffer` scan, which accumulates up to 32KB of data and passes it to the detector on every data event.

**Where:** `src/main/index.ts:2003-2012` — remove the `scanAgentPermissionPtyOutput(sessionId, data, ...)` call and clean up `getAgentPermissionSessionState`, `trimAgentPermissionRawTail`, and related dead code.

**Keep:** `markAgentPermissionSessionFromCommand` (line 241) — this is called from `pty:write` handlers (input side, not output side) and marks sessions as agent when the user types commands. It is separate from `scanAgentPermissionPtyOutput` and should be preserved.

**Estimated Impact:** ~40-50% reduction in main process CPU per PTY event. No functionality loss.

---

#### 1.2 Pre-Filter Permission Scans with Keyword Gate

**What:** Before the expensive ANSI-stripping + line-splitting + multi-regex pipeline, check the data for a small set of fast keywords. If none of `allow`, `deny`, `approve`, `permission`, `proceed`, `confirm`, `tool use`, `would you like` are present, skip the scan entirely.

**Why:** 95%+ of terminal output does not contain permission-related text. A single `data.includes(...)` or simple regex is orders of magnitude cheaper than the full scan pipeline.

**Where:** `src/shared/agentPermissionPrompts.ts` — add at the top of `AgentPermissionPromptDetector.append()` and `detectSnapshot()`. Also in `TerminalPane.tsx` before the `detectPermissionPrompt` calls.

**Estimated Impact:** ~80-90% reduction in permission scan invocations for non-agent terminal output (most of the time).

---

#### 1.3 Collapse Renderer Scans from 5 Passes → 2 Passes

**What:** The renderer currently scans permission prompts at 5 different points per data event (raw, raw-buffer, write-parsed, hidden-replay, watchdog). Collapse these into 2 passes:

1. **Keep `raw-buffer` for hidden tabs** — The `raw-buffer` scan accumulates data into a 32KB rolling buffer and passes the full buffer to the detector. This is the safety net for multi-line prompts on hidden tabs where individual chunks may lack recognizable keywords. It's also the renderer's equivalent of the removed main process `rawTail`.

2. **Keep `write-parsed` for visible/agent tabs** — This runs inside the `terminal.write()` callback on clean rendered text (ANSI already stripped by xterm). It's the most reliable scan pass since it operates on what the user would actually see.

3. **Remove `raw` scan** — Runs on raw bytes before xterm renders them, duplicates `raw-buffer` for single-chunk detection. The `raw-buffer` scan already covers this because `inferProviderFromText` works on the first chunk just as well as on the accumulated buffer.

4. **Remove 3× `followup` scans for Claude sessions** — The 50ms/150ms/300ms delayed scans are a heuristic for catching incrementally-rendered Claude prompts. The `watchdog` at 500ms intervals (running for 30s) already covers this with better reliability. These followup scans create 3 extra timer-based scans per data event for no incremental value.

5. **Keep `watchdog`** — Scans every 500ms for 30s after output. This catches prompts that appear incrementally or due to delayed rendering.

6. **Keep `hidden-replay`** — Only fires during tab visibility transitions, which is infrequent. Essential for catching prompts in buffered output when a hidden tab becomes visible.

**Hidden tab scan behavior after changes:**

| Tab State | After optimization | Scans that run |
|-----------|-------------------|----------------|
| Visible, agent | `raw-buffer` + `write-parsed` + `watchdog` | 3 passes |
| Visible, non-agent | `raw-buffer` only (fast-path rejected) | 1 pass (cheap) |
| Hidden, agent | `raw-buffer` (other passes run when visible) | 1 pass |
| Hidden, non-agent | `raw-buffer` only (fast-path rejected) | 1 pass (cheap) |

**Mitigation for the polling gap:** After removing the main process scan, the renderer's `raw-buffer` scan provides the safety net for hidden tabs. If the 4-16s polling gap for process-name detection is still a concern, we can add an immediate process poll when data arrives for a tab with an unknown foreground process (see Tier 3, Event-Driven Polling).

**Where:** `src/renderer/src/components/TerminalPane.tsx` lines 2030-2066 — clean up scan passes.

**Estimated Impact:** ~70% reduction in renderer-side permission scan events.

---

### Tier 2: Medium Impact, Low Risk

#### 2.1 Reduce Process Poll Interval (4s → 10s visible, 16s → 30s hidden)

**What:** Increase the `AGENT_PROCESS_POLL_MS` from 4000ms to 10000ms, and `HIDDEN_AGENT_PROCESS_POLL_MS` from 16000ms to 30000ms.

**Why:** The foreground process name in a terminal changes only when the user runs a command. Polling every 4 seconds does not provide meaningful responsiveness gains over 10 seconds for the use case (agent state detection) and costs ~90 IPC polls/min at scale.

**Where:** `src/renderer/src/components/TerminalPane.tsx:35-36`

**Estimated Impact:** ~60% reduction in process polling IPC overhead at scale.

---

#### 2.2 Reduce Hidden Output Buffer from 2MB to 512KB

**What:** Lower `HIDDEN_OUTPUT_BUFFER_MAX_CHARS` from 2MB to 512KB.

**Why:** When a hidden tab becomes visible, only the last ~screenful of output is contextually useful. Buffering 2MB per hidden tab is excessive and wastes memory.

**Where:** `src/renderer/src/components/TerminalPane.tsx:45`

**Estimated Impact:** ~75% reduction in hidden buffer memory per tab (from 2MB to 512KB).

---

#### 2.3 Cap Command History per Session

**What:** Add a max entry limit to `commandHistory` (e.g., 500 entries per session). When exceeded, evict the oldest entries.

**Why:** Command history grows unboundedly over long sessions, each entry holding up to 200K chars of output. This accumulates in React state and contributes to renderer memory pressure.

**Where:** `src/renderer/src/components/TerminalPane.tsx` — in `setCommandHistory` calls or a wrapping function.

**Estimated Impact:** Prevents unbounded memory growth in long-running sessions.

---

#### 2.4 Skip Command Output Capture for Non-Agent Hidden Tabs

**What:** Only capture command output via `flushOutputBuffer` when the tab is visible or running an agent session. For hidden non-agent tabs, skip the buffer read.

**Why:** Reading the xterm rendered buffer line-by-line is expensive (iterate all rendered lines, `translateToString`, join, strip ANSI, truncate). Hidden tab output is never displayed until the user revisits, and even then the command history panel only shows a preview.

**Where:** `src/renderer/src/components/TerminalPane.tsx:1861` — early return in `flushOutputBuffer`.

**Estimated Impact:** Eliminates ~100% of command output capture overhead for hidden non-agent tabs.

---

### Tier 3: Medium Impact, Medium Risk

#### 3.1 Replace Separate BrowserWindow Overlays with In-Window DOM Overlays

**What:** Instead of creating separate `BrowserWindow` instances for the permission prompt and task-complete notification, render them as absolutely-positioned DOM elements within the main Electron window.

**Why:** Each `BrowserWindow` is a separate native window with its own compositing surface, GPU layer, and event loop overhead. Two persistent always-on-top transparent windows with vibrancy consume significant GPU compositing resources.

**Where:** `src/main/index.ts` — replace `ensureAgentPermissionOverlayWindow` / `ensureTaskCompleteOverlayWindow` with IPC calls to show/hide DOM overlays in the renderer.

**Risk:** Overlays won't be visible if the main window is minimized or obscured. Mitigation: this is actually desirable behavior — if you can't see the terminal, you shouldn't be approving permissions.

---

#### 3.2 Event-Driven Process Polling (Replace Timer with PTY-Output Trigger)

**What:** Instead of polling `ptyGetProcess` on a timer, poll it whenever new PTY output arrives. If the renderer's `agentProcessRef.current` is null or the tab is hidden, trigger an immediate poll on the first data event after a period of no data (e.g., 500ms of quiet).

**Why:** The foreground process only changes when a new command runs — output from the new process always follows. Timer-based polling at 4s/16s wastes IPC and CPU. Event-driven polling closes the 4-16s polling gap that was the main process scan's only marginal advantage.

**Mitigation for main process scan removal:** This event-driven approach ensures that when an agent starts on a hidden tab, the renderer detects the process name change within one data event + 500ms, rather than waiting up to 16s for the next timer tick. Combined with the `raw-buffer` scan, this eliminates the theoretical gap.

**Where:** `src/renderer/src/components/TerminalPane.tsx` — in the `onPtyData` handler, conditionally call `refreshAgentProcess` when the current process is unknown or the tab is hidden.

**Risk:** May miss edge cases where the process name changes without output (rare in practice — every process change produces at least a shell prompt or new output).

---

#### 3.3 Add a Global Throttle on Permission Scanning

**What:** Cap permission scans to once every 100ms regardless of how many data events arrive. Accumulate data between scans and present the full accumulated text to the detector.

**Why:** During heavy terminal output (build logs, `npm install`, `cat largefile`), data events arrive faster than 100ms intervals. Scanning every single event is wasteful — the permission prompt doesn't change between rapid events.

**Where:** `src/shared/agentPermissionPrompts.ts` — add a global throttle timestamp to `AgentPermissionPromptDetector`.

**Estimated Impact:** During high-throughput output, reduces scan count by ~90% (from 10-20 scans/second to 10 scans/second max).

---

### Tier 4: Lower Impact / Higher Risk

#### 4.1 Enable Electron Hardware Acceleration

**What:** Re-enable `app.hardwareAcceleration` and remove the `in-process-gpu` flag. The code comment says it was disabled to prevent GPU process crashes — but this forces all GPU work (including WebGL rendering) into the renderer process.

**Why:** With out-of-process GPU, the GPU work moves to a dedicated GPU process. This reduces renderer process CPU usage (the renderer thread isn't blocked by GPU work) and lets the OS manage GPU memory more efficiently.

**Risk:** May reintroduce GPU process crashes on certain hardware. Requires testing.

**Where:** `src/main/index.ts` — remove or modify the `app.disableHardwareAcceleration()` call.

---

#### 4.2 Switch from WebGL to Canvas Renderer (Per-Session Config)

**What:** Add a per-session option to use xterm.js's canvas renderer (`@xterm/addon-canvas`) instead of WebGL. Canvas rendering uses less GPU memory and may be more CPU-efficient for lower-throughput sessions.

**Why:** WebGL is designed for high-throughput rendering but consumes significant GPU resources per session. For hidden tabs or non-agent sessions, canvas is sufficient and lighter.

**Where:** `src/renderer/src/components/TerminalPane.tsx` — add renderer selection logic.

---

#### 4.3 Optimize Wheel Handler (Use Passive Listener When Possible)

**What:** Use `{ passive: true }` for the wheel handler in normal mode (non-alt-screen). Only use `passive: false` when alt-screen mode is active and arrow-key interception is needed.

**Why:** The browser can scroll on the compositor thread when `passive: true`, avoiding main-thread JS execution for every scroll frame. Currently all wheel events are `passive: false` which blocks compositor scrolling.

**Where:** `src/renderer/src/components/TerminalPane.tsx:1608-1725` — split the wheel handler registration into passive/non-passive based on mode.

---

#### 4.4 Reduce Agent Busy Check Interval (1s → 3s)

**What:** Increase `AGENT_BUSY_SCREEN_CHECK_MS` from 1000ms to 3000ms.

**Why:** The agent busy check reads 16 lines from xterm buffer and runs regex. Running this every 1 second is unnecessarily aggressive — the agent state transitions on a timescale of seconds to minutes, not milliseconds.

**Where:** `src/renderer/src/components/TerminalPane.tsx:34`

---

### Tier 5: v0.4.0 Regression Mitigations

These items address overhead introduced since v0.3.8 — primarily the persistent task-complete `BrowserWindow` overlay (commit `47c244de`) and per-event busy-evidence work from hybrid busy detection (commit `63363048`). They are the most likely cause of the new "always-on" lag users are reporting against the latest .dmg (v0.4.0).

#### 5.1 Destroy (don't just hide) the task-complete overlay window when its queue empties

**What:** `closeTaskCompleteOverlayIfEmpty()` already calls `taskCompleteOverlayWindow.close()` (`src/main/index.ts:777-781`), but `ensureTaskCompleteOverlayWindow` recreates the window with `alwaysOnTop: 'screen-saver'`, `setVisibleOnAllWorkspaces({ visibleOnFullScreen: true })`, vibrancy, and a separate HTML/compositing surface on every notification. Verify the window is **fully destroyed** (not just hidden) when `pendingTaskCompleteNotifications` is empty, null out `taskCompleteOverlayWindow`, and explicitly tear down the cached `AudioContext` used by the chime. Re-create lazily only on the next show.

**Why:** Each persistent `BrowserWindow` is a separate native window with its own GPU compositing surface, vibrancy layer, and event loop. After v0.4.0 the app runs **two** always-on-top transparent overlays concurrently (permission + task-complete). Keeping the task-complete one alive at idle is the only structurally new idle-GPU cost since v0.3.8 and is the prime suspect for the regression.

**Where:** `src/main/index.ts:431-870` — `ensureTaskCompleteOverlayWindow`, `ensureTaskCompleteOverlayVisible`, `closeTaskCompleteOverlayIfEmpty`, and the chime `AudioContext` cache.

**Estimated Impact:** Eliminates the second persistent overlay's idle GPU/compositing cost. Highest-leverage single change for the v0.4.0 lag.

#### 5.2 Coalesce hybrid busy-evidence bookkeeping on the data path

**What:** Hybrid busy detection added per-event work in the `onPtyData` handler — `agentLastOutputAtRef` / `agentLastBusyEvidenceAtRef` writes, `ensureAgentBusyCheckTimer()` invocation — plus a 1s timer (`runAgentBusyCheck`) that reads the xterm rendered buffer and runs busy-wording regex for up to 2 minutes. Gate the per-event busy-evidence timestamp writes and the `ensureAgentBusyCheckTimer()` call behind `agentSessionRef.current === true` so they only run for terminals that actually have a running agent; non-agent terminals should pay zero busy-detection cost per byte.

**Why:** Currently every PTY data event (including non-agent terminals) touches the busy-evidence refs and can arm a 1s timer that scans the rendered buffer. This compounds the still-unaddressed Plan Phase 1.3 (5 renderer permission scans per data event) and Tier 4.4 (1s busy-check interval).

**Where:** `src/renderer/src/components/TerminalPane.tsx:2019-2024` (per-data-event busy evidence), `TerminalPane.tsx:1060-1073` (`runAgentBusyCheck` timer setup).

**Estimated Impact:** Removes per-event bookkeeping from non-agent terminals; pairs with Tier 4.4 (1s→3s) and Phase 1.3 (scan collapse).

---

### Tier 6: User-Facing Overlay Toggles

Two user-facing toggles allow the user (and us during regression diagnosis) to independently disable each overlay and confirm whether they are the source of the lag. Both follow the existing `localStorage` settings pattern (`emu-perf-overlay` at `src/renderer/src/App.tsx:210-262`).

#### T-1. Permission popup toggle

**What:** Add a per-app setting `emu.permissionPopupEnabled` (default `true`). When `false`, the renderer still *detects* permission prompts (so the agent indicator state remains correct), but `window.api.agentPermissionPromptShow(...)` is no longer called and no permission `BrowserWindow` overlay is ever created.

**Behavior when off:** No permission popup appears. Underlying prompt detection and the sidebar agent indicator keep working. The user must approve/deny by typing in the terminal directly.

**Where:**
- Persist + read the flag in `src/renderer/src/App.tsx` via `localStorage` (mirror the `emu-perf-overlay` pattern at line 219 / 262).
- Gate the show call at `src/renderer/src/components/TerminalPane.tsx:1945` (`window.api.agentPermissionPromptShow`).
- Optionally early-return in main at the `agent-permission:show` IPC handler in `src/main/index.ts` so a stray IPC still won't create the window.
- Settings UI: add a new "Notifications" section to `src/renderer/src/components/SettingsModal.tsx` (alongside 'appearance' / 'hotkeys' / 'about' / 'updates', declared in the `SettingsSection` type at line 12) with a switch control.

#### T-2. Task-complete popup toggle

**What:** Add a per-app setting `emu.taskCompletePopupEnabled` (default `true`). When `false`, the renderer suppresses `window.api.showTaskComplete(...)` and the main process never creates the task-complete `BrowserWindow`.

**Behavior when off:** The yellow→green indicator transition still happens in the sidebar (that logic is independent and unrelated to the overlay). Only the separate notification window is suppressed — so the second persistent `BrowserWindow` from §5.1 is never created in the first place.

**Where:**
- Persist + read the flag in `src/renderer/src/App.tsx` (same `localStorage` pattern).
- Gate the trigger at `src/renderer/src/components/TerminalPane.tsx:1175` (`window.api.showTaskComplete`).
- Early-return in the IPC handler in `src/main/index.ts:819` (`ensureTaskCompleteOverlayVisible`) when globally disabled, as a defense-in-depth so the `BrowserWindow` is never created even if a stray IPC arrives.
- Settings UI: same new "Notifications" section in `SettingsModal.tsx`.

---

## Implementation Priority

```
Phase 0 (Immediate, v0.4.0 regression triage):
  └── 5.1 Destroy task-complete overlay window when queue empties
  └── 5.2 Gate busy-evidence bookkeeping on agentSession
  └── T-1 Permission popup toggle
  └── T-2 Task-complete popup toggle

Phase 1 (Immediate, Safe):
  └── 1.1 Remove main process permission scan
  └── 1.2 Add keyword pre-filter to permission scans
  └── 1.3 Collapse renderer scans from 5 → 1 pass
  └── 2.1 Reduce process poll interval

Phase 2 (Soon, Safe):
  └── 2.2 Reduce hidden output buffer to 512KB
  └── 2.3 Cap command history per session
  └── 2.4 Skip output capture for hidden non-agent tabs
  └── 3.3 Global throttle on permission scanning

Phase 3 (Medium-term, Needs Testing):
  └── 3.1 In-window DOM overlays instead of BrowserWindows
  └── 3.2 Event-driven process polling
  └── 4.3 Passive wheel handler in normal mode
  └── 4.4 Reduce agent busy check to 3s

Phase 4 (Long-term, Higher Risk):
  └── 4.1 Re-enable hardware acceleration
  └── 4.2 Canvas renderer fallback
```

## Estimated Cumulative Impact

| Metric | Before | After (Phase 1+2) | After (All Phases) |
|--------|--------|-------------------|-------------------|
| Main process CPU per PTY event | 100% | ~40% (60% reduction) | ~25% (75% reduction) |
| Renderer scans per data event | 5 | 2 (watchdog + write-parsed) | 1 (aggregated) |
| Process poll interval (visible) | 4s | 10s | Event-driven (near 0 idle) |
| Hidden buffer memory per tab | 2MB | 512KB | 512KB |
| GPU process overhead | In-process | In-process | Dedicated GPU process |
| Command history memory | Unbounded | Capped at 500 entries | Capped at 500 entries |
| Persistent overlay BrowserWindows (idle) | 2 (perm + task-complete) | 1 (perm only) | 0 (both → in-window DOM) |
| Per-event busy-evidence on non-agent tabs | yes | gated on agentSession | gated on agentSession |

## Key Code Locations

| File | Lines | What to Change |
|------|-------|----------------|
| `src/main/index.ts` | 2003-2012 | Remove main process permission scan from `onData` |
| `src/shared/agentPermissionPrompts.ts` | 779-808 | Add keyword pre-filter to `AgentPermissionPromptDetector.append()` |
| `src/shared/agentPermissionPrompts.ts` | 721-732 | Add keyword pre-filter to `detectSnapshot()` |
| `src/renderer/src/components/TerminalPane.tsx` | 2026-2066 | Collapse/remove redundant scan passes |
| `src/renderer/src/components/TerminalPane.tsx` | 35-36 | `AGENT_PROCESS_POLL_MS` and `HIDDEN_AGENT_PROCESS_POLL_MS` |
| `src/renderer/src/components/TerminalPane.tsx` | 45-46 | `HIDDEN_OUTPUT_BUFFER_MAX_CHARS` |
| `src/renderer/src/components/TerminalPane.tsx` | 1861-1898 | `flushOutputBuffer` — gate on visibility/agent |
| `src/renderer/src/components/TerminalPane.tsx` | 1725 | Wheel handler — split passive/non-passive |
| `src/renderer/src/components/TerminalPane.tsx` | 34 | `AGENT_BUSY_SCREEN_CHECK_MS` |
| `src/renderer/src/components/TerminalPane.tsx` | 1404-1462 | `refreshAgentProcess` — event-driven trigger |
| `src/main/index.ts` | 1359-1407 | Permission overlay — convert to DOM |
| `src/main/index.ts` | 821-862 | Task complete overlay — convert to DOM |
| `src/main/index.ts` | 431-870 | Task-complete overlay — destroy on empty queue (5.1); early-return when disabled (T-2) |
| `src/main/index.ts` | 819 | `ensureTaskCompleteOverlayVisible` — early-return when disabled |
| `src/renderer/src/components/TerminalPane.tsx` | 2019-2024 | Per-PTY-byte busy-evidence — gate on `agentSessionRef` (5.2) |
| `src/renderer/src/components/TerminalPane.tsx` | 1060-1073 | `runAgentBusyCheck` timer setup — gate scheduling on `agentSessionRef` |
| `src/renderer/src/components/TerminalPane.tsx` | 1175 | Gate `window.api.showTaskComplete` on `emu.taskCompletePopupEnabled` (T-2) |
| `src/renderer/src/components/TerminalPane.tsx` | 1945 | Gate `window.api.agentPermissionPromptShow` on `emu.permissionPopupEnabled` (T-1) |
| `src/renderer/src/components/SettingsModal.tsx` | 12 (`SettingsSection`) | Add 'notifications' section with two toggle switches |
| `src/renderer/src/App.tsx` | 210-262 | Persist new `localStorage` toggles (`emu.permissionPopupEnabled`, `emu.taskCompletePopupEnabled`) |
