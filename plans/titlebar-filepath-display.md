# Feature Implementation Plan: Titlebar Filepath Display

**Overall Progress:** `0%`

## TLDR

Show the active tab's current working directory (CWD) in the Emu titlebar at all times. When the user switches tabs, the displayed path instantly updates. The CWD is sourced via **OSC 7 escape sequences** — the same standard used by iTerm2, VS Code, and Warp — emitted by a `precmd` hook injected into our existing zsh shell integration wrapper. No IPC polling required; the path arrives through the existing PTY data channel.

## Critical Decisions

* **CWD tracking via OSC 7 (not polling):** Shells emit `\x1b]7;file://hostname/path\x07` before each prompt. We already write a `~/.zshrc` wrapper in `setupShellIntegration()` (main/index.ts:520–546). Adding a `precmd_functions` hook there makes this event-driven and zero-overhead — no new IPC handlers, no timers.

* **Store `cwd` on the `Session` object:** The `Session` interface in `App.tsx` is already threaded through all components as the source of truth for per-tab state. Adding `cwd: string` keeps it consistent with `agentState`, `foregroundProcess`, etc. Avoids a parallel `Map<string, string>` that React wouldn't track for re-renders.

* **Display in titlebar using absolute-centered positioning:** The titlebar has a flex layout with `.titlebar-drag-area` (flex: 1) and `.titlebar-actions` on the right. Adding a center-anchored `position: absolute` element for the path avoids disrupting the drag region geometry. The element gets `-webkit-app-region: no-drag` only on its own bounds, and `pointer-events: none` so the drag area remains functional.

* **Show active pane's CWD in split mode:** `activePaneId` already tracks which pane has focus. The displayed path follows `activePaneId`, not `selectedId`, so in split mode the path correctly reflects whichever pane the user is interacting with.

* **Path formatting — `~` substitution + left-truncation:** Replace the home directory prefix with `~` for readability. Use CSS `direction: rtl; text-overflow: ellipsis` to truncate deep paths from the left (so the trailing folder name always stays visible).

---

## Tasks

- [ ] 🟥 **Step 1: Inject OSC 7 hook into zsh shell integration**
  - [ ] 🟥 In `src/main/index.ts`, find `setupShellIntegration()` (line ~520). Append a `precmd` hook to the `.zshrc` content that emits `\033]7;file://$HOSTNAME$PWD\007` via `precmd_functions+=(_emu_report_cwd)`.
  - [ ] 🟥 Verify the injected hook doesn't break existing user `.zshrc` sourcing (it appends after `source "$HOME/.zshrc"`).

- [ ] 🟥 **Step 2: Add `cwd` to the Session interface and initial state**
  - [ ] 🟥 In `src/renderer/src/App.tsx`, add `cwd: string` to the `Session` interface (after `foregroundProcess`).
  - [ ] 🟥 In `createSession()`, set `cwd: ''` as the default.

- [ ] 🟥 **Step 3: Parse OSC 7 in TerminalPane and emit via new prop**
  - [ ] 🟥 Add `onCwdChange?: (cwd: string) => void` to the `Props` interface in `src/renderer/src/components/TerminalPane.tsx`.
  - [ ] 🟥 Create an `onCwdChangeRef` so the closure in `useEffect` always calls the latest prop (mirrors the pattern used for `onAgentStateChange`).
  - [ ] 🟥 In the `onPtyData` handler (inside the terminal `useEffect`), add an OSC 7 regex match: `/\x1b\]7;file:\/\/[^\x07\x1b/]*([^\x07\x1b]*)(?:\x07|\x1b\\)/`. Extract the path capture group, `decodeURIComponent()` it, and call `onCwdChangeRef.current?.(path)` when it differs from the previous value.
  - [ ] 🟥 Destructure `onCwdChange` from props and keep the ref in sync with a `useEffect`.

- [ ] 🟥 **Step 4: Wire `onCwdChange` through App to session state**
  - [ ] 🟥 In `src/renderer/src/App.tsx`, add a `handleCwdChange` callback: `useCallback((id, cwd) => setSessions(prev => prev.map(s => s.id === id ? { ...s, cwd } : s)), [])`.
  - [ ] 🟥 Pass `onCwdChange={(cwd) => handleCwdChange(session.id, cwd)}` to each `<TerminalPane>` in the `sessions.map(...)` render.

- [ ] 🟥 **Step 5: Display the filepath in the titlebar**
  - [ ] 🟥 In `src/renderer/src/App.tsx`, derive `activeCwd` from `sessions.find(s => s.id === activePaneId)?.cwd ?? ''`.
  - [ ] 🟥 Format it: replace a leading home-directory prefix (`/Users/username`) with `~` using `os.homedir()` equivalent — in the renderer, use `activeCwd.replace(/^\/Users\/[^/]+/, '~')` or pass the home dir from the main process. A simple approach: store the homedir once via `window.api` or derive it by checking if the path starts with the session's initial segment. Simplest: hardcode the replacement pattern `/\/Users\/[^/]+/` to `~` and `/home\/[^/]+/` to `~` as a regex.
  - [ ] 🟥 Render a `<div className="titlebar-path">` element inside `.titlebar`, positioned between the drag area and the actions (or absolutely centered). Only render it when `activeCwd` is non-empty.

- [ ] 🟥 **Step 6: Style the filepath display**
  - [ ] 🟥 In `src/renderer/src/App.css`, add `.titlebar-path` styles:
    - `position: absolute; left: 50%; transform: translateX(-50%)` — true center in the titlebar
    - `max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; unicode-bidi: plaintext` — left-truncation so the leaf folder name is always visible
    - `font-size: 11px; font-family: monospace; color: rgba(255,255,255,0.45); pointer-events: none; -webkit-app-region: no-drag; user-select: none`
  - [ ] 🟥 Ensure the titlebar container gets `position: relative` if it doesn't already have it, so the absolute child positions within it.

---

**Status Tracking:**
* 🟩 Done
* 🟨 In Progress
* 🟥 To Do
