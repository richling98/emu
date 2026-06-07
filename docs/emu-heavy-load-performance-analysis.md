# Emu Heavy-Load CPU and Memory Analysis

Date: 2026-06-07  
Scope: local Emu codebase review plus current public architecture notes for Ghostty, Warp, and xterm.js.

## Executive Summary

The most likely root cause of the hot laptop / loud fan problem is CPU load, not memory pressure. Memory pressure can make the system worse once many terminals have large scrollback and command-history captures, but the code path that scales most directly with "many parallel processes" is terminal output throughput:

1. Every `node-pty` output chunk is forwarded immediately over Electron IPC.
2. Every tab is mounted as a live `TerminalPane`, even hidden tabs.
3. Hidden tabs keep live xterm.js instances, live PTYs, process polling, IPC listeners, output parsing, and command-history capture.
4. The WebGL renderer is installed as a dependency but not actually loaded in `TerminalPane.tsx`, so Emu appears to use xterm.js's default renderer path.
5. Emu does additional per-output work beyond plain terminal rendering: cwd OSC parsing, agent-idle heuristics, command preview extraction, output-flush timers, command-output copying support, link providers, scroll state, and React state updates.

This does not mean Emu's architecture is fundamentally wrong. Electron + xterm.js + node-pty can support a good terminal product, especially if the product value is richer UI and agent workflow. But Emu's current implementation is not optimized for many high-output background tabs. Ghostty and Warp do have stronger raw-throughput architecture: they are native/Rust/Zig GPU-first systems that avoid Electron's IPC and Chromium overhead.

My recommendation: do not rewrite the app first. Ship an Emu performance pass that batches PTY output, pauses/degrades hidden-pane rendering, enables the xterm WebGL renderer, caps retained output, and adds profiling. Only consider a native renderer or Tauri/native rewrite after measuring the remaining gap.

## What I Found In Emu

### The PTY Output Path Is Unbatched

`src/main/index.ts` creates one `node-pty` process per terminal tab and forwards every PTY data event directly to the renderer:

```ts
ptyProcess.onData((data) => {
  if (!event.sender.isDestroyed()) {
    event.sender.send(`pty:data:${sessionId}`, data)
  }
})
```

Source: `src/main/index.ts:811`.

That means high-throughput commands, build logs, agent output, or many concurrent CLIs can produce a large number of serialized IPC messages. The renderer then immediately calls:

```ts
terminal.write(data)
```

Source: `src/renderer/src/components/TerminalPane.tsx:1386`.

This is the first place I would optimize. A terminal should generally batch output to the display frame cadence, not render every producer chunk as an independent UI event.

Plain-English explanation:

Imagine each running process is handing Emu tiny scraps of paper with new terminal text on them. Right now Emu appears to walk each scrap from the terminal process, through Electron IPC, into the UI, and asks xterm.js to update the screen immediately. If 10 busy tabs each hand Emu hundreds of scraps per second, Emu spends a lot of time just handling deliveries.

Batching means Emu collects those scraps for a few milliseconds and delivers them as one envelope. The user still sees output essentially live, because the batch window is shorter than a frame of video, but the computer does much less bookkeeping. Instead of "wake up, cross IPC, parse, render" hundreds or thousands of times per second, Emu can do it tens of times per second with larger chunks.

The value is not that fewer bytes are rendered. The value is that the fixed overhead around each delivery is paid far fewer times.

### Hidden Tabs Are Still Fully Alive

`App.tsx` renders a `TerminalPane` for every tab:

```tsx
{allTabs.map(({ tab }) => {
  ...
  return <TerminalPane ... isVisible={isLeftSlot || isRightSlot} ... />
})}
```

Source: `src/renderer/src/App.tsx:592`.

Hidden panes get `display: none` through CSS:

```css
.terminal-pane--hidden {
  display: none;
}
```

Source: `src/renderer/src/components/TerminalPane.css:18`.

But CSS hiding does not stop the mounted component. Each hidden pane still owns:

- an xterm.js `Terminal` instance,
- a live PTY session,
- an IPC data listener,
- a `setInterval` polling foreground process every 4 seconds,
- output flush timers,
- link providers,
- scroll listeners and resize observers,
- command history and captured output state.

Important terminology:

"Hidden tab" means a tab/session that still exists in Emu and can be navigated back to, but is not currently visible in the active pane or split pane. It does not mean a physically deleted tab. Deleted tabs should have their PTY closed and their `TerminalPane` unmounted through the cleanup path.

So the issue is:

- current focused tab: visible and active;
- other split pane: visible but inactive;
- other tabs you can still click back to: hidden but still mounted;
- deleted tabs: not what I am referring to here.

For a user running many parallel agent/process tabs, this is likely the largest Emu-specific scaling problem. The app pays render/parse cost for terminal output that is not currently visible. That is useful if the goal is instant tab switching with perfectly up-to-date terminal state, but it is expensive when many hidden tabs are streaming output.

### WebGL Is Installed But Not Loaded

`package.json` includes:

```json
"@xterm/addon-webgl": "^0.19.0"
```

But `TerminalPane.tsx` imports and loads only:

- `@xterm/addon-fit`
- `@xterm/addon-web-links`

The current load sites are `terminal.loadAddon(fitAddon)` and `terminal.loadAddon(webLinks)`.

Source: `src/renderer/src/components/TerminalPane.tsx:692`, `src/renderer/src/components/TerminalPane.tsx:1240`.

This also contradicts the About modal claim:

```ts
{ title: 'GPU Rendering', desc: 'WebGL-accelerated text rendering ...' }
```

Source: `src/renderer/src/components/AboutModal.tsx:17`.

xterm.js's own README says WebGL is an optional addon and `@xterm/addon-webgl` renders xterm.js using a WebGL2 canvas context: https://github.com/xtermjs/xterm.js/#addons. Emu has the dependency but does not appear to activate it.

Plain-English explanation:

Without the WebGL addon, terminal text rendering is more likely to lean on browser/DOM-style rendering work on the CPU. With WebGL, xterm.js can hand more of the drawing work to the GPU, which is the part of the computer designed to draw lots of pixels quickly. For a terminal, this matters when output is moving fast, when the window is large, when scrollback is dense, or when multiple panes are visible.

The benefit is similar to using a graphics card for a game instead of asking the CPU to draw every frame itself. It will not make the child processes use less CPU, and it will not fix all Electron overhead, but it should reduce the renderer's cost for painting terminal text.

One caveat: if every hidden tab creates its own WebGL context, that can create GPU memory/context pressure. So WebGL should be paired with hidden-tab virtualization or suspension.

### Emu Does Extra Work On Every Output Burst

For each PTY data callback, `TerminalPane.tsx` also does:

- `touchSessionActivity()`
- scan output for `OSC 633;EmuCwd`
- `terminal.write(data)`
- schedule agent idle checks
- maybe schedule raw TUI prompt checks
- maybe strip ANSI and update command history preview
- re-arm a 600 ms output-capture timer

Source: `src/renderer/src/components/TerminalPane.tsx:1386`.

This is not inherently wrong, but it means Emu is not just a terminal renderer. It is a terminal renderer plus agent-state inference plus command logging plus rich UI features. Under heavy output, these features should be gated, batched, or disabled for hidden tabs.

Proposed fix:

1. Split the output path into "must happen immediately" and "can happen later."
   - Immediate for visible tabs: write output to xterm, keep the visible terminal responsive.
   - Immediate for all tabs: record that the tab had activity, keep a small latest-output marker if needed.
   - Deferred or skipped for hidden tabs: render output, scan terminal tail text, capture full command output, update rich UI state.

2. Parse cheap metadata before rendering, and only when needed.
   - CWD OSC parsing is cheap and useful, so it can stay in the batched output path.
   - Agent idle detection should only run for tabs known to be agent sessions.
   - Raw TUI prompt checks should not run on every burst for hidden tabs.

3. Move repeated work onto timers or state transitions.
   - Instead of scheduling idle checks on every chunk, run them after a quiet period and only for active agent tabs.
   - Instead of updating command history preview during the hot path, capture a preview from the first batched chunk or after output quiets.
   - Instead of recomputing tail text repeatedly, cache a small rolling tail buffer.

4. Add per-tab performance modes.
   - Visible active tab: full fidelity.
   - Visible inactive split pane: full rendering, reduced heuristics.
   - Hidden tab: no real-time xterm rendering, bounded output buffer, minimal status updates.
   - Deleted tab: no work; PTY and listeners disposed.

5. Make expensive features budgeted.
   - Cap full output capture.
   - Cap hidden output backlog.
   - Cap command history length per tab.
   - Store truncation markers instead of unbounded strings.

The goal is to preserve Emu's useful agent/workspace features without running all of them on every byte of output from every background process.

### Output Capture Can Retain Large Text

When a command finishes, Emu reads rendered xterm buffer lines and stores `outputFull` in React state:

```ts
for (let ln = startLine + 1; ln < endLine; ln++) {
  const bufLine = buf.getLine(ln)
  if (bufLine) lines.push(bufLine.translateToString(true).trimEnd())
}
...
setCommandHistory(prev =>
  prev.map(e => e.id === id ? { ...e, outputFull } : e)
)
```

Source: `src/renderer/src/components/TerminalPane.tsx:1352`.

This is a memory-pressure risk if long-running commands or agents produce large outputs. It can also create CPU spikes when converting many xterm buffer lines to strings. The risk is lower than the live-output rendering path because this runs after output goes quiet, but it should still be capped.

### Electron Transparency/Vibrancy May Add Compositor Cost

The main window uses:

```ts
transparent: true,
vibrancy: 'sidebar',
titleBarStyle: 'hiddenInset',
```

Source: `src/main/index.ts:712`.

This is probably not the primary issue, but it can increase compositor work on macOS, especially while many terminal panes are repainting. During performance tests, compare a non-transparent/non-vibrant build.

## CPU vs Memory: Likely Breakdown

### CPU Is More Likely

Symptoms match CPU:

- heat and fans rise during active parallel process output,
- the problem is workload-dependent,
- terminal rendering/parsing scales with bytes, lines, and visible/hidden pane count,
- Electron IPC overhead scales with message count.

Likely CPU buckets:

- child processes themselves: builds, agents, language servers, tests, package managers;
- main process: node-pty event handling and IPC serialization;
- renderer process: xterm parsing/rendering and JavaScript heuristics;
- GPU/compositor process: Chromium rendering, transparency, animation/compositing.

### Memory May Still Matter

Memory pressure becomes credible if:

- many tabs have large scrollback;
- command history stores large `outputFull` values;
- hidden xterm instances retain buffers indefinitely;
- image attachments or object URLs are retained;
- Chromium/V8 heap grows after tabs close.

The first memory mitigation is not a rewrite. Add hard caps and verify memory returns near baseline after closing busy tabs.

## Is Electron The Problem?

Partly, but not entirely.

Electron creates a baseline cost:

- Chromium renderer process;
- V8 JavaScript runtime;
- main/renderer IPC boundary;
- Chromium compositor/GPU process;
- DOM/CSS/layout interaction.

That means Emu will not match Ghostty or Warp on raw terminal throughput if they are fully optimized. But the current hot path has fixable issues inside the Electron model:

- no PTY output batching;
- hidden panes still render and parse output;
- WebGL addon is not loaded;
- command-output capture is uncapped;
- agent heuristics run for all tabs;
- no profiling/performance budget exists.

So the answer is: Electron imposes a ceiling, but Emu is currently below that ceiling.

## Competitor Architecture Comparison

### Ghostty

Ghostty's README describes it as fast, native, and GPU accelerated. It says Ghostty has a multi-threaded architecture with dedicated read, write, and render threads per terminal; uses OpenGL on Linux and Metal on macOS; and uses a heavily optimized parser with CPU-specific SIMD instructions.

Source: https://github.com/ghostty-org/ghostty#competitive-performance

Ghostty also uses native platform UI: SwiftUI and Metal/CoreText on macOS, GTK on Linux.

Source: https://github.com/ghostty-org/ghostty#native-platform-experiences

The relevant difference: Ghostty's hot path is built around native threads, native parsing, and native GPU rendering. Emu's hot path is PTY -> Electron main process -> serialized IPC -> JavaScript parser/rendering in a Chromium renderer.

### Warp

Warp's public architecture writeup says Warp briefly experimented with Electron, then pivoted to Rust and direct GPU rendering with Metal. It also says Warp uses a custom Rust UI framework and GPU primitives for rectangles, images, and glyphs.

Source: https://www.warp.dev/blog/how-warp-works

Warp's newer block-model writeup explains that it is not just a single terminal grid. It stores terminal output as typed blocks and virtualizes rendering so only viewport-intersecting blocks and rows are rendered.

Source: https://www.warp.dev/blog/block-model-behind-warps-agentic-development-environment

The relevant difference: Warp's architecture is designed to avoid paying render cost for non-visible history. Emu currently keeps a traditional xterm grid per tab and still processes hidden tabs.

## Root-Cause Hypotheses, Ranked

### P0: Hidden Tab Output Rendering

Hidden tabs are mounted and continue processing PTY output. With many parallel processes, this can multiply renderer CPU by number of busy tabs.

Fix:

- Keep PTY processes alive, but stop writing hidden output into xterm on every chunk.
- For hidden tabs, buffer bytes in the main process or a lightweight per-session store.
- Drain buffered output into xterm when the tab becomes visible.
- Apply a max hidden backlog; if exceeded, compact old data or mark "output truncated while hidden."
- Keep only minimal state for badges: last activity time, process name, maybe running/idle.

Risk:

- If a hidden TUI app relies on real-time terminal state, delayed rendering can make state reconstruction tricky. Start with non-active tabs that are not in alternate screen, or keep parsing but disable actual rendering. Measure both.

### P0: PTY Output Batching

Every `node-pty` chunk becomes one IPC message and one `terminal.write`. This is expensive under high output.

Fix:

- In `src/main/index.ts`, coalesce output per session.
- Flush at most once per animation frame / 8-16 ms / size threshold.
- Send `{ sessionId, data }` through one shared channel instead of many per-session channel names if useful.
- In renderer, call `terminal.write(batch)` once per flush.
- Consider backpressure: if renderer falls behind, drop or compact hidden-tab output first, never visible output.

Expected impact:

- Fewer IPC messages.
- Fewer JS callbacks.
- Fewer xterm parser invocations.
- Lower renderer main-thread pressure.

### P0: Load xterm WebGL Renderer

Emu has `@xterm/addon-webgl` but does not load it. xterm.js documents WebGL as an optional renderer addon.

Simple reason this helps:

WebGL lets xterm.js use the GPU for drawing terminal text. In plain terms, it moves more of the "paint the screen over and over" work from the CPU to the graphics hardware. That matters when output is flying by or when multiple terminal panes are visible. It will not reduce the CPU used by the actual commands running in the terminal, but it should reduce the CPU Emu spends displaying their output.

Fix:

- Import `WebglAddon`.
- Load it after `terminal.open`.
- Handle context loss via `onContextLoss`.
- Add a visible development warning or telemetry field when WebGL fails.
- Correct the About modal if WebGL is not active.

Risk:

- WebGL context limits matter if every hidden tab creates a WebGL canvas. This reinforces the need to virtualize or suspend hidden tabs.

### P1: Reduce Hot-Path Feature Work

Emu currently does useful workspace features during the same callback that handles raw terminal output. That callback should be treated as a hot path: it may run constantly when many processes are active.

Fix:

- Keep visible terminal rendering in the hot path.
- Keep only cheap metadata updates in the hot path, such as "this tab had activity."
- Move command preview, full-output capture, prompt-tail scanning, and agent-idle checks out of the per-chunk path.
- Run agent heuristics only for known agent tabs.
- Run expensive checks after output has been quiet for a short period, not on every burst.
- For hidden tabs, skip rich feature work unless the result is needed for a visible badge or later replay.

Plain-English version:

Right now Emu is doing multiple side chores every time new terminal text arrives. Some chores are valuable, but they do not all need to happen immediately. The fix is to let the terminal display stay fast, then do the bookkeeping later, less often, or only for the tab the user can actually see.

### P1: Cap Command History Output

`outputFull` can retain large strings. This is useful UX, but it needs a budget.

Fix:

- Store only first N KB and last N KB for huge command outputs.
- Track `truncated: true`.
- Add a setting or internal constant for per-command and per-tab retained output.
- Do not compute `outputFull` for hidden/background high-throughput tabs until requested.

### P1: Gate Agent Heuristics To Relevant Tabs

Foreground process polling and idle prompt detection run per pane. Most tabs do not need the full agent heuristic path all the time.

Fix:

- Poll process state less frequently for hidden tabs.
- Disable `getTerminalTailText` idle checks unless a tab is known to be an agent session.
- Use shell integration events for state when possible instead of buffer-text heuristics.

### P1: Add Profiling and Regression Budgets

Before a rewrite, make the problem measurable.

Recommended profiling:

- Add a dev-only stats overlay:
  - PTY bytes/sec per session.
  - PTY chunks/sec per session.
  - IPC flushes/sec.
  - `terminal.write` calls/sec.
  - visible vs hidden output bytes.
  - output backlog per hidden tab.
  - React renders/sec for `TerminalPane`, `Sidebar`, `TopTabBar`.
- Add main-process sampling:
  - `app.getAppMetrics()`.
  - `process.getCPUUsage()`.
  - `process.getProcessMemoryInfo()`.
- Add a local stress script:
  - open 1, 5, 10, 20 tabs;
  - run a controlled output producer in each;
  - compare visible-only vs hidden-heavy workloads;
  - record CPU, memory, dropped frames, and input latency.

Useful manual macOS checks:

```sh
ps -arcwwwxo pid,ppid,%cpu,%mem,comm | head -40
top -o cpu
sudo powermetrics --samplers tasks -n 1
```

The important question is whether CPU sits in Emu's renderer, Emu's main process, Electron Helper GPU, or the child processes. The fix depends on that split.

## Recommended Fix Plan

### Phase 1: Measure and Confirm

Add internal counters around:

- `ptyProcess.onData`;
- IPC send flushes;
- renderer `onPtyData`;
- `terminal.write`;
- output flush and command-history capture;
- foreground-process polls.

Implementation note:

Phase 1 instrumentation is available through an in-app performance overlay. In development builds it opens by default; in any build it can be toggled with `Cmd+Shift+P`.

What to look at:

- `PTY bytes`: how much raw output the child processes are producing.
- `IPC msgs`: how many times the main process is waking the renderer with terminal data.
- `xterm writes`: how many times the renderer calls into xterm.js.
- `Hidden bytes`: how much output is being processed for tabs that exist but are not visible.
- `Polls`: foreground-process polling volume from agent/TUI detection.
- Per-tab rows: identify which tabs are producing output and whether that output is visible or hidden.

How to interpret it:

- High `PTY bytes` with high system CPU in child processes means the workload itself is expensive.
- High `IPC msgs` relative to bytes means the output path needs batching.
- High `Hidden bytes` means Emu is spending work on tabs the user cannot currently see.
- High `xterm writes` means the renderer is doing frequent terminal updates and should benefit from batching and WebGL.
- High `Polls` means agent/process heuristics may need gating for hidden or non-agent tabs.

Run stress tests with:

- one visible busy terminal;
- ten hidden busy terminals;
- two visible split panes plus many hidden tabs;
- WebGL enabled vs disabled;
- transparent/vibrant window vs opaque window.

Success criterion:

- We can attribute CPU to child processes, Electron main, renderer JS, or GPU/compositor.

### Phase 2: Quick Runtime Wins

Implement:

- PTY output batching.
- WebGL addon activation as an experimental diagnostic path.
- lower polling frequency for hidden tabs.
- hard caps on `outputFull`.
- a non-vibrant performance test mode.

Implementation note:

Phase 2 now includes:

- Main-process PTY output batching with a 12 ms flush window and a 256 KB immediate flush threshold. The overlay's `PTY bytes` still shows raw input throughput, while `IPC msgs` should drop when output arrives in many small chunks.
- xterm.js WebGL activation is now treated as experimental and opt-in. Corrected diagnostics showed that when WebGL is truly enabled through `EMU_ENABLE_WEBGL=1`, the app can blank at launch in this Electron runtime. This happened even with vibrancy disabled, so WebGL should not be considered part of the stable performance path yet.
- Hidden-tab foreground-process polling reduced from every 4 seconds to every 16 seconds, while visible tabs and running agent/TUI states keep the faster cadence.
- Command-history `outputFull` capped at 200,000 characters, preserving the first and last 100,000 characters with a truncation marker.
- `EMU_DISABLE_VIBRANCY=1 npm run dev` test mode for launching an opaque, non-vibrant window to isolate macOS compositor cost.
- `EMU_ENABLE_WEBGL=1 npm run dev` test mode for explicitly enabling WebGL. The overlay shows the real WebGL/vibrancy mode so stale assumptions do not pollute test results.

Success criterion:

- Same workload produces fewer IPC events and fewer `terminal.write` calls with no visible regression.

### Phase 3: Hidden Tab Virtualization

Implement:

- visible tabs: real-time xterm writes;
- hidden tabs: buffered output and cheap metadata only;
- on activation: replay buffered output or restore from a lightweight terminal-state snapshot;
- cap hidden backlog and mark truncation.

Success criterion:

- CPU should scale primarily with visible busy terminals, not total busy tabs.

Implementation note:

Phase 3 now takes the conservative path:

- Hidden normal-screen tabs keep reading PTY output immediately, but defer `terminal.write`.
- Hidden output is stored in a bounded 2 MB per-tab buffer.
- If the buffer exceeds the cap, old hidden output is dropped and Emu records the omitted character count.
- When the tab becomes visible, Emu replays buffered output incrementally at up to 128 KB per animation frame.
- If output was omitted, Emu inserts a visible marker before replaying the retained tail:
  ```text
  [Emu omitted 2,400,000 characters of hidden output while this tab was inactive]
  ```
- Hidden alternate-screen/TUI tabs still render in real time for now, because apps like editors, pagers, and full-screen agent UIs rely on cursor movement and screen-state updates.

Expected overlay behavior:

- A hidden normal-screen tab should still show rising `Hidden bytes`.
- Its `xterm writes` should drop near `0/s` while hidden.
- When you switch back, `xterm writes` may briefly spike while buffered output replays.
- If the hidden tab is in alternate-screen/TUI mode, `xterm writes` may continue while hidden by design.

### Phase 3 Validation Checklist

Run these with the normal safe dev app, meaning no `EMU_ENABLE_WEBGL=1`.

Baseline expected overlay badges:

- `WebGL off`
- `Vibrancy on` unless testing with `EMU_DISABLE_VIBRANCY=1`

Test 1: visible output load

1. Open one tab.
2. Run:
   ```bash
   yes "emu visible throughput test $(date)" | head -n 200000
   ```
3. Expected:
   - `PTY bytes` rises sharply.
   - `IPC msgs` is bounded by batching rather than exploding per line.
   - `xterm writes` rises because the visible tab is actually rendering.

Test 2: one hidden busy tab

1. Open two top tabs.
2. In tab 2, run:
   ```bash
   while true; do date; sleep 0.1; done
   ```
3. Switch back to tab 1.
4. Expected:
   - tab 2 shows rising `Hidden bytes`;
   - tab 2 `xterm` stays near `0/s`;
   - the process in tab 2 keeps running normally.

Test 3: close a hidden busy tab

1. Keep tab 2 running the loop above.
2. Stay on tab 1.
3. Close tab 2.
4. Expected:
   - no blank window;
   - tab 1 remains usable;
   - tab 2 disappears from the overlay;
   - total PTYs drops by one.

Test 4: many hidden busy tabs

1. Create 5-10 top tabs.
2. In each hidden tab, run:
   ```bash
   while true; do date; sleep 0.1; done
   ```
3. Leave one quiet tab visible.
4. Expected:
   - total `Hidden bytes` rises;
   - total `xterm writes` remains low;
   - CPU should be far lower than if all hidden tabs were rendering in real time.

Test 5: backlog replay

1. Let a hidden busy tab run for at least 60 seconds.
2. Switch back to it.
3. Expected:
   - the tab catches up in chunks;
   - `xterm writes` briefly rises;
   - the app remains responsive;
   - if the backlog exceeded the cap, Emu prints an omission marker before the retained tail.

### Phase 4: WebGL Isolation

WebGL should be investigated separately from the stable CPU fix.

Current evidence:

- WebGL off: app is usable.
- Correctly enabled WebGL through `EMU_ENABLE_WEBGL=1`: app blanks on launch.
- WebGL with vibrancy disabled also blanked, so the issue is not only transparent-window composition.
- Earlier confusion came from a bad flag path: the overlay showed `WebGL off`, meaning the renderer was not actually running WebGL.

Next WebGL-specific experiment:

1. Build a tiny Electron repro with only one `BrowserWindow`, one xterm terminal, `@xterm/addon-fit`, and `@xterm/addon-webgl`.
2. If the tiny repro blanks, the issue is xterm WebGL plus this Electron/GPU runtime.
3. If the tiny repro works, the issue is Emu's mounting, CSS, or renderer lifecycle.
4. Until this is resolved, keep WebGL disabled by default and do not count it as part of the Phase 3 performance win.

### Phase 5: Architecture Reassessment

After Phases 1-4, decide whether Electron remains acceptable.

Stay with Electron if:

- visible terminal latency is good;
- CPU stays acceptable with many hidden processes;
- memory returns after closing tabs;
- Emu's differentiator is rich agent UI rather than fastest raw terminal throughput.

Consider native/Tauri/renderer rewrite if:

- visible terminal rendering remains hot after WebGL and batching;
- Chromium baseline memory is the top user complaint;
- heavy users require dozens of live visible terminals;
- the product goal is Ghostty-class terminal performance, not just better agent workflows.

## Is Emu's Architecture Fundamentally Wrong?

No, but it is currently mixing two product models:

1. Traditional terminal emulator: optimize byte stream parsing/rendering at very high throughput.
2. Agent workspace: track commands, infer agent state, provide rich prompt composition, output capture, markdown popouts, and workspace UI.

Electron/React is a reasonable choice for the second model. Ghostty's architecture is better for the first model. Warp's architecture is interesting because it rethinks terminal output as structured, virtualized blocks, which is closer to Emu's agent-workspace direction.

The strategic question is not "Electron or native?" It is:

> Should Emu optimize around raw terminal throughput, or around many agent sessions with structured state and selective rendering?

For the user-reported issue, the right near-term answer is selective rendering. Do not spend CPU rendering hidden agent/process output in real time.

## Pickup Plan

Current stable state:

- Ship candidate should keep WebGL off by default.
- PTY output batching is implemented in the main process.
- The performance overlay is implemented and should be left available in dev builds.
- Hidden normal-screen tabs keep their processes running, but no longer call `terminal.write` for every hidden output burst.
- Hidden output is buffered with a 2 MB per-tab cap and replayed incrementally when the tab becomes visible.
- Hidden tab process polling is reduced, while visible tabs and running agent/TUI states keep the faster cadence.
- Command-history retained output is capped to avoid unbounded memory growth.
- Manual validation confirmed the many-hidden-busy-tabs workflow behaves correctly with `WebGL off`.

Before shipping:

1. Re-run the Phase 3 validation checklist on a clean restart.
2. Confirm `Cmd+Shift+P` overlay shows `WebGL off`.
3. Confirm a visible high-output tab still renders normally.
4. Confirm 5-10 hidden busy tabs show rising `Hidden bytes` but low `xterm writes`.
5. Confirm closing hidden busy tabs does not blank the app.
6. Check memory after closing all busy tabs.
7. Check Activity Monitor and separate Emu/Electron CPU from child-process CPU and Defender CPU.

Recommended next code polish:

1. Add an automated regression test or manual test script for hidden-tab close under load.
2. Consider making the overlay dev-only unless a diagnostics setting is enabled.
3. Consider exposing hidden-buffer cap and replay rate as constants near the terminal performance code.
4. Add a small visible indicator when a tab has omitted hidden backlog, if users need better discoverability.

WebGL follow-up:

Do not re-enable WebGL in the main app until it is isolated. Corrected diagnostics showed that true `EMU_ENABLE_WEBGL=1` can blank the app at launch. The next WebGL task should be a tiny Electron + xterm + WebGL repro. If the repro blanks, the issue is the Electron/xterm/GPU runtime. If the repro works, the issue is Emu-specific mounting, CSS, or lifecycle.

Architecture decision:

If the stable path keeps CPU acceptable for many hidden agent sessions, Electron remains reasonable for Emu's product direction. Revisit native rendering or a Warp-like virtualized block model only if visible terminal rendering remains the bottleneck after the hidden-tab and batching fixes.
