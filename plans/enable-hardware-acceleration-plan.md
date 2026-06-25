# EMU Fix 4.1 Execution Plan — Re-Enable Electron Hardware Acceleration

> Sub-plan of `cpu-memory-optimization-plan.md` (Tier 4.1). Treat as a standalone, ship-blockable change with its own rollout + rollback.

---

## 1. Current State (as of v0.4.0)

| Item | Value | Source |
|---|---|---|
| Hardware acceleration | **Disabled** | `src/main/index.ts:6` calls `app.disableHardwareAcceleration()` |
| GPU mode | **In-process** (GPU helper runs inside the renderer process, not as a separate `GPU Process`) | `src/main/index.ts:7` calls `app.commandLine.appendSwitch('in-process-gpu')` |
| WebGL (xterm) | **Opt-in via launch flag only** (`--emu-enable-webgl=1` or `--thinking-enable-webgl=1`) | `src/preload/index.ts:9` → `diagnosticsConfig.webglEnabled`; consumed at `src/renderer/src/components/TerminalPane.tsx:62`, `:956` |
| Default xterm renderer (without flag) | xterm.js built-in canvas/DOM renderer (no `WebglAddon`) | `TerminalPane.tsx:956` only loads `WebglAddon` when `shouldUseWebglRenderer()` returns `true` |
| Electron version | `electron@^41.2.0` | `package.json` |
| macOS target arch | `arm64` only | `package.json` `build.mac.target[0].arch` |

### Why the disable was added (from git blame, commit `47c244de`)

```
// Prevent Chromium GPU process crash on macOS (exit_code=15 at startup).
// Running the GPU in-process sidesteps the separate GPU helper that crashes
// on some macOS configurations, and the app has no Angular/WebGL dependencies.
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('in-process-gpu')
```

Two things in that comment are now **stale**:
- "no Angular/WebGL dependencies" — **wrong**. `@xterm/addon-webgl@^0.19.0` is wired in (though gated behind a launch flag), and the BrowserWindow chrome, transparency, and vibrancy all still go through Chromium's compositor.
- The original `exit_code=15` GPU-process crash is a known issue that has largely been resolved in Chromium/Electron on arm64 in recent years. It is unverified whether it still reproduces on Electron 41 / arm64 macOS today.

### Observed cost today

With HW accel disabled + `in-process-gpu`:
- All Chromium compositing (every BrowserWindow's clear, transparency, blur, occlusion) is done via **SwiftShader** (software WebGL) **inside the renderer process**.
- That means the renderer process is doing: (a) JS render loop + (b) xterm writing + (c) compositor paint + (d) GPU rasterization — all on the same thread/process.
- Two persistent `BrowserWindow` overlays (permission + task-complete, post v0.4.0) each get their own software-composited surface. This compounds the renderer-main-thread cost.
- WebGL (`--emu-enable-webgl=1`) is software-rasterized in the renderer via SwiftShader — a known CPU hog for xterm's WebGL renderer.

---

## 2. Goal

Move GPU rasterization and window compositing **out** of the renderer process into a dedicated Chromium `GPU Process` so the renderer main thread is freed for React + xterm work, and the OS/dedicated GPU process manages texture memory more efficiently.

## 3. Constraints

- App targets **macOS arm64 only** today. The original `exit_code=15` was reportedly a macOS-specific GPU helper crash; we are not shipping to Intel Mac or Windows/Linux for now, but the fix must not regress them either.
- Must be **revertible** without a re-deploy if a user reports a crash — i.e. wire a launch flag fallback, not a hard removal.
- Must not break WebGL (when `--emu-enable-webgl=1` is passed) — verify it still loads.
- Must not regress visible-tab output throughput, overlay rendering, or window vibrancy.

## 4. Non-Goals (explicitly out of scope for this change)

- Switching the default xterm renderer from canvas to WebGL (separate item, Tier 4.2).
- Removing the `--emu-enable-webgl` flag gate or making WebGL default.
- Doing the DOM-overlay migration (Tier 3.1). This plan is independent of overlay location.
- Removing the BrowserWindow overlays themselves (Tier 3.1).

---

## 5. Implementation Plan

### 5.1 Source changes

**`src/main/index.ts`** — replace lines 1–7:

```ts
import { app, shell, BrowserWindow, ipcMain, nativeImage, screen } from 'electron'

// GPU acceleration: by default EMU runs with a dedicated Chromium GPU process
// (out-of-process GPU) so compositor paint + WebGL rasterization move off the
// renderer main thread. If a user hits a GPU-process crash or rendering glitch
// (e.g. historical exit_code=15 on certain macOS configs), they can force the
// old in-process / software-rasterization behavior back on with:
//   emu --disable-gpu
//   emu --in-process-gpu
// Both flags are standard Chromium switches that Electron honours when
// hardware acceleration is otherwise enabled.
// `app.disableHardwareAcceleration()` is intentionally NOT called any more.
if (!app.commandLine.hasSwitch('disable-gpu')) {
  // Hardware acceleration is on by default in Chromium when this flag is absent.
  // We do not call `app.disableHardwareAcceleration()`.
  // If `--in-process-gpu` is passed, keep GPU work in-process for compatibility.
  if (!app.commandLine.hasSwitch('in-process-gpu')) {
    // Out-of-process GPU (the default). Nothing else to do.
  }
} else {
  // User explicitly opted into the legacy fallback for diagnostics.
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('in-process-gpu')
}

import { autoUpdater } from 'electron-updater'
```

Notes:
- The above keeps a **user-facing escape hatch**: pass `--disable-gpu` (or `--in-process-gpu`) to revert to the previous behavior. Both are recognized by Chromium directly, so they work even without us interpreting them — but we explicitly call `app.disableHardwareAcceleration()` only when `--disable-gpu` is present, so the user gets the same legacy behavior they had pre-4.1.
- **Remove the stale comment** ("no Angular/WebGL dependencies") — it's now actively misleading.

### 5.2 WebGL addon — verify context-loss handling stays intact

`TerminalPane.tsx:927-955` already wires `WebglAddon.onContextLoss` to dispose + reload via `setTimeout(...,0)`. With a real GPU process, context loss becomes much rarer (it happens on GPU process crash or VRAM pressure, not on memory pressure inside the renderer), but the handler is still correct. **No code changes needed**; just verify.

### 5.3 Build config & launch scripts

- `package.json` `scripts.dev` — change `electron-vite dev` (the underlying Electron binary already launches with HW acceleration by default). No change needed; the source change in 5.1 is sufficient.
- `package.json` `scripts.dist` — no change (electron-builder packs the same app).
- The `.dmg` build pipeline does not need a new flag; users simply get the new default behavior on next release.
- Add a **diagnostics entry to expose the active GPU mode** so users (and we) can confirm what's running. Concretely, extend `src/preload/index.ts`'s `diagnosticsConfig`:

```ts
diagnosticsConfig: {
  webglEnabled: hasFlagValue('--emu-enable-webgl', '1') || hasFlagValue('--thinking-enable-webgl', '1'),
  vibrancyDisabled: hasFlagValue('--emu-disable-vibrancy', '1') || hasFlagValue('--thinking-disable-vibrancy', '1'),
  gpuForceInProcess: hasFlagValue('--in-process-gpu', '') || process.argv.some(a => a === '--in-process-gpu'),
  gpuDisabled: hasFlagValue('--disable-gpu', '') || process.argv.some(a => a === '--disable-gpu')
}
```

…and update `src/renderer/src/env.d.ts` `DiagnosticsConfig` (`env.d.ts:120`) to include `gpuForceInProcess: boolean` and `gpuDisabled: boolean`. These are read-only diagnostics — they show the user the running GPU mode and let us debug from screenshots.

### 5.4 No telemetry / auto-update coordination

This plan does not add telemetry. Electron's `app.getGPUInfo('complete')` and the `gpu-info-update` / `gpu-process-crashed` events on `app` give us everything we need for diagnostics if we choose to surface them later — **not required for ship**.

---

## 6. Verification & Rollout

### 6.1 Manual smoke matrix (on the dev box before shipping — Mac arm64)

Launch `npm run dev` and complete each scenario. Then re-launch with `--disable-gpu` to confirm the escape hatch reproduces the legacy behavior.

| Scenario | Pass criteria |
|---|---|
| Cold launch (no flags) | Window appears in <2s; no GPU-process crash in main process console; no `exit_code=15`; terminal renders first PTY bytes within 200ms of session start. |
| Multi-tab stress (6 parallel tabs) | Open 6 tabs, run heavy output (`yes`, `tail -f`, `npm run dev` × 3). Renderer CPU (Activity Monitor → "Emu Helper (Renderer)") should be visible lower than v0.4.0; GPU process now appears as a separate "Emu Helper (GPU)". |
| Visible-tab output throughput | In one tab, run `cat 100MB.log`. Scroll is fluid; not janky. Compare to v0.4.0 baseline. |
| Permission popup | Launch a real agent (Codex/Claude/opencode), trigger a permission prompt. Popup appears, transparent + vibrancy look identical to v0.4.0. |
| Task-complete popup | Let an agent finish. Popup appears at top-right (vibrancy intact), no flashing, chime plays. |
| Hidden tab visibility transition | Background a tab, run output, switch to it. Replay marker + scroll-to-bottom behave as before — no rendering glitch, no half-drawn frame. |
| WebGL path enabled | Launch `npm run dev -- --emu-enable-webgl=1`. Open a tab. Verify in Chrome DevTools console: WebGL is active (`recordPerfEvent('webglActivations')` fires); no context-loss loop (`webglContextLosses` should stay 0 over a minute of typing). |
| Alt-screen TUI | Run `vim` / `claude --tui` etc. Enter + exit cleanly; no flicker, no leftover artifacts on return to shell. |
| Escape hatch | Launch with `--disable-gpu`. Confirm legacy behavior matches v0.4.0 (renderer CPU spikes back up; GPU process no longer shows separately). |
| `--in-process-gpu` only | Launch with `--in-process-gpu`. Confirm GPU work is in-process (no GPU process in Activity Monitor) but hardware acceleration / partial accel still applies; verify no regression vs `--disable-gpu`. |

### 6.2 Performance measurement

- Open Chrome DevTools → Performance Manager while running 6-tab stress for 30s with v0.4.0 binary to get baseline.
- Apply the change, rerun, capture again.
- Compare renderer-main-thread "Scripting" + "Rendering" time slices. Expect a measurable reduction in "Rendering" (compositor work moved to GPU process). "Scripting" should be unchanged or slightly lower (less contention with paint).
- Mac Activity Monitor: confirm a new "Emu Helper (GPU)" entry exists; total GPU % should now be non-trivial. Renderer process CPU should drop.

Capture before/after numbers and save them in `plans/cpu-memory-optimization-plan.md` Estimated Cumulative Impact row "GPU process overhead" once done.

### 6.3 Regression checks — the GPU-process-crash scenario

The original disable reason was `exit_code=15` at startup on some macOS configurations. To detect recurrence:

- Cold-launch the app on the dev box 20 times (kill all Electron helper processes between runs). Zero crashes is required.
- Watch `app.on('gpu-process-crashed')` — log every event. To wire this now without changing behavior, add at app ready:
  ```ts
  app.on('gpu-process-crashed', (details) => {
    console.error('[emu:gpu-process-crashed]', details)
  })
  ```
  This is purely observational; we do not auto-restart because Electron will normally relaunch the GPU process automatically and you'll just see momentary flicker. If crashes recur frequently on user machines after ship, we reactivate `app.disableHardwareAcceleration()` for the next release.

### 6.4 Ship + rollback plan

1. **Ship** the change as part of the next .dmg (`v0.4.1` or `v0.5.x`).
2. **Watch** for any user reports of:
   - Crash on launch
   - Black/blank window at startup
   - Window not appearing at all
3. **If reports appear**: release a follow-up `.dmg` that re-applies `app.disableHardwareAcceleration()` + `in-process-gpu` (revert commit). Users who self-diagnose can also pass `--disable-gpu` from the terminal to launch the existing build with the legacy behavior — document this in the release notes.
4. **If no reports within 1 week of release**: close out §4.1 as complete and remove the legacy comment / escape hatch scaffolding in a follow-up cleanup commit (optional).

### 6.5 Release notes snippet (draft)

> **v0.4.1 — Performance**
> Emu now uses a dedicated GPU process on macOS, moving compositing and rendering off the main renderer process to reduce CPU usage under heavy terminal load.
> If you experience a crash or blank window on launch (rare, historically seen on some macOS configurations), launch from Terminal with `--disable-gpu` to restore prior behavior: `open -a Emu --args --disable-gpu`.

---

## 7. Risks & Mitigations

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| GPU-process crashes on cold launch (`exit_code=15`) reappears on the user's macOS config | Low–Medium (Chromium-side issue largely fixed; but unverified on the user's installed macOS) | High (window won't appear) | Escape hatch `--disable-gpu` is shipped on day 1; quick revert in next .dmg |
| Window appears blank/transparent because the GPU process crashed but Electron couldn't restore it | Low | High | `gpu-process-crashed` event logged; user passes `--disable-gpu` |
| WebGL renders nothing (blank terminal) when `--emu-enable-webgl=1` is used | Low — WebGL renderer has `onContextLoss` reload path, and out-of-process GPU is the *more* stable WebGL host, not the less | High (terminal text invisible) | Existing `WebglAddon` failure path falls back to xterm default renderer at `TerminalPane.tsx:950-953`; verify in §6.1 "WebGL path enabled" scenario before ship |
| Vibrancy/transparency looks different under HW accel | Very low (HW accel is the native path for vibrancy; the SwiftShader workaround is the unusual one) | Cosmetic | Visual check in §6.1 |
| Compositor-related input lag (mouse wheel, scroll) returns because Chromium scrolls via GPU process | Low | Low | Verify wheel smoothness in §6.1 — `passive: false` wheel handler from Tier 4.3 (still undone) is the relevant coupling if it lags |
| New "Emu Helper (GPU)" entry alarms users (unexpected process) | Low | Cosmetic | Call out in release notes |

---

## 8. Files Changed

| File | Change |
|---|---|
| `src/main/index.ts` (lines 1–7) | Replace disable-HW-accel / in-process-gpu block with conditional (only `--disable-gpu` triggers it). Stale comment removed. Add `app.on('gpu-process-crashed')` logging. |
| `src/preload/index.ts` (lines 8–11) | Add `gpuForceInProcess`, `gpuDisabled` to `diagnosticsConfig`. |
| `src/renderer/src/env.d.ts` (`DiagnosticsConfig`, line ~120) | Add `gpuForceInProcess: boolean`, `gpuDisabled: boolean`. |

(No tests directly cover GPU startup; the smoke matrix in §6.1 is the validation gate.)

---

## 9. Success Criteria (shipping gate)

All of:

- [ ] App cold-launches cleanly with no flags on the target macOS arm64 box, zero crashes across 20 launches.
- [ ] "Emu Helper (GPU)" appears as a separate process in Activity Monitor during normal use.
- [ ] Renderer process CPU is observably lower than v0.4.0 during the 6-tab stress scenario.
- [ ] Permission + task-complete popups render identically (vibrancy, transparency, position).
- [ ] `--emu-enable-webgl=1` path still activates xterm WebGL with no context-loss loop.
- [ ] `--disable-gpu` escape hatch reproduces v0.4.0 software-rasterization behavior.
- [ ] Release notes added describing the change + escape hatch.

Once all checked, the §4.1 row in `plans/cpu-memory-optimization-plan.md` Estimated Cumulative Impact ("GPU process overhead") goes from `In-process` → `Dedicated GPU process`.

---

## 10. Open Questions (resolve before ship)

1. Does any user on the team still reproduce startup `exit_code=15`? If yes, **do not ship 4.1**; instead add the gate (default ON but with `--disable-gpu`), and ship as a "Phase 0" diagnostic — collect logs for a release before flipping the default.
2. Should we **A/B-style default-off** in v0.4.1 (HW accel off by default, on with `--emu-enable-gpu=1`)? That gives us a release of telemetry before flipping default. More conservative; recommended if answer to (1) is "unknown".
3. Should the GPU mode toggle live next to the proposed overlay toggles (T-1, T-2) in the Settings UI? Probably not — it requires app relaunch, so it's better as a launch flag than a setting.
