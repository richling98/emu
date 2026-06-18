# Top Terminal Tabs Feature Plan

## Implementation Progress

- [x] Plan captured and updated with cwd-based sidebar naming plus `Project N` top-tab naming.
- [x] Introduce workspace/top-tab data model in `App.tsx`.
- [x] Add `TopTabBar` UI with hover pencil rename behavior.
- [x] Rewire terminal rendering and split panes to use top-tab IDs.
- [x] Add cwd-aware PTY creation and cwd propagation.
- [x] Update layout CSS for the top tab bar.
- [x] Run build verification and record results.

Last updated: implementation complete; `npm run build` passed.

## Understanding

You want Thinking to add a second tab layer across the main terminal area, directly below the existing macOS-style titlebar that contains the window controls, settings button, and split-screen toggle.

The left sidebar tabs should represent the folder or broader workspace the user is working in. Inside whichever left sidebar item is selected, the new top navbar should show project or feature tabs for that same folder:

- The left sidebar should show the folder name from the workspace cwd once the terminal reports it, such as `Thinking-dev` for `/Users/rling/Documents/Vibing/Thinking-dev`.
- The first top tab should be named `Project 1` by default.
- The user can rename `Project 1` to something meaningful, such as `Auth refactor`, `Bug fix`, or `Release prep`.
- The user can create additional top tabs named `Project 2`, `Project 3`, and so on.
- Each top tab should show a pencil icon on hover, matching the left sidebar rename affordance, so users can click the pencil and rename the tab inline.
- Each top tab should have its own terminal process and terminal state.
- When the user creates a new top tab, that terminal should start in the same folder that the first tab for that workspace is already in, so the new tab is immediately scoped to the same project folder.

In short: left sidebar equals workspace or folder, with names derived from cwd folder names; top tabs equal parallel efforts inside that workspace or folder, with default names like `Project 1`.

## Current Repo Context

The current app has a single tab/session model:

- `src/renderer/src/App.tsx` owns `Session[]`, `selectedId`, split-screen state, and renders one `TerminalPane` per `Session`.
- `src/renderer/src/components/Sidebar.tsx` renders those `Session`s as the left sidebar tabs and already supports rename/delete/new session behavior.
- `src/renderer/src/components/TerminalPane.tsx` owns one xterm instance and talks to one PTY using `session.id`.
- `src/main/index.ts` creates PTYs in `ipcMain.handle('pty:create')`.
- `src/preload/index.ts` exposes `ptyCreate(sessionId, options?)`.
- `src/renderer/src/env.d.ts` types that preload API.
- Shell integration already reports cwd via the OSC sequence `633;ThinkingCwd=...`, and `TerminalPane` already stores that in `currentWorkingDirectoryRef`.
- However, `pty:create` currently always spawns new PTYs in `os.homedir()`, so the new feature needs an IPC-level cwd parameter.
- The current sidebar default name is based on creation date/time; this should change to ordinal project naming.

## Assumptions

- The existing left sidebar should remain visually and behaviorally intact for now, even though its meaning becomes "workspace/folder" rather than "terminal tab."
- The new top tabs should be scoped per left sidebar item. Selecting a different sidebar workspace shows that workspace's own top tabs.
- A new top tab should inherit the first top tab's latest known cwd for that workspace. If that cwd is not known yet, it should inherit the active top tab's latest known cwd. If no cwd is known, it should fall back to the app's existing default startup cwd.
- Renaming top tabs is local UI state for now unless the repo already has persistence added later.
- Closing the last top tab in a workspace should be disallowed or should immediately recreate a default `Project 1`; disallowing deletion is the cleaner first implementation.
- Split-screen should continue to work, but the draggable pane identity should move from sidebar session IDs to terminal tab IDs.

## Data Model Plan

Replace the current flat `Session` concept in the renderer with a two-level model while keeping names conservative:

```ts
interface WorkspaceSession {
  id: string
  name: string
  createdAt: Date
  lastActiveAt: Date
  userSelectedAt: Date
  tabs: TerminalTab[]
  selectedTabId: string
}

interface TerminalTab {
  id: string
  name: string
  createdAt: Date
  lastActiveAt: Date
  userSelectedAt: Date
  isActive: boolean
  agentState: AgentState
  foregroundProcess: string | null
  initialCwd: string | null
  currentCwd: string | null
}
```

The existing `Session` shape is closest to the terminal tab, not the workspace. To keep the change surgical, implementation can either:

- Rename `Session` to `TerminalTab` and introduce `WorkspaceSession`, or
- Keep `Session` temporarily as the left sidebar workspace type and introduce `TerminalTab`.

The clearer long-term version is to rename, but the lower-risk first implementation is to preserve the exported `Session` type for sidebar compatibility and add `TerminalTab` separately.

## UI Plan

Add a new component:

- `src/renderer/src/components/TopTabBar.tsx`
- `src/renderer/src/components/TopTabBar.css`

Expected controls:

- Horizontal tab list inside the terminal area, below `.titlebar` and to the right of the left sidebar.
- Active tab styling matching the existing restrained terminal UI.
- Inline rename behavior matching the sidebar rename pattern.
- A pencil rename icon that appears when hovering over each top tab title, matching the left sidebar interaction.
- `+` icon button to create a new top tab.
- Optional close button on each tab, hidden or disabled when only one top tab exists.

Layout changes:

- `App.tsx` should render `TopTabBar` as the first child inside `.terminal-area`.
- Terminal panes should render below the top tab bar.
- Add a CSS variable such as `--top-tabbar-height: 34px`.
- Update `.terminal-pane--full`, `.terminal-pane--left`, `.terminal-pane--right`, `.pane-divider--vertical`, `.empty-pane`, and drag/drop overlays so their `top` starts below the top tab bar.
- Markdown popout reservation should continue to work because it is controlled horizontally through `--markdown-reserved-width`.

## PTY/Cwd Plan

Add cwd-aware PTY creation:

1. Update preload:

```ts
ptyCreate: (sessionId: string, options?: { cwd?: string | null }) =>
  ipcRenderer.invoke('pty:create', sessionId, options)
```

2. Update `env.d.ts` with the same signature.

3. Update main process:

```ts
ipcMain.handle('pty:create', (event, sessionId: string, options?: { cwd?: string | null }) => {
  const cwd = normalizeSafeCwd(options?.cwd) ?? os.homedir()
  // spawn with cwd
})
```

4. Add a small cwd validator in `src/main/index.ts`:

- Accept only absolute paths.
- Require the path to exist.
- Require the path to be a directory.
- Fall back to `os.homedir()` if invalid.

5. Update `TerminalPane` props:

```ts
initialCwd?: string | null
onCurrentCwdChange?: (cwd: string) => void
```

6. Pass `initialCwd` into `window.api.ptyCreate(tab.id, { cwd: initialCwd })`.

7. When `TerminalPane` receives a cwd OSC update, call `onCurrentCwdChange(cwd)` so `App.tsx` can persist the latest cwd for that top tab.

## Behavior Plan

Initial startup:

- Create one workspace in the sidebar.
- Name the first workspace `Project 1`.
- That workspace contains one top tab named `Project 1`.
- Render that tab active.
- Spawn its PTY using the current default behavior.

Creating a new left sidebar workspace:

- Create a new workspace named `Project N`, where `N` is the next workspace creation ordinal.
- That workspace starts with one top tab named `Project 1`.
- Select that workspace in single-pane mode, matching current behavior.

Creating a new top tab:

- Find the selected workspace.
- Resolve inherited cwd:
  - Prefer the workspace's first tab `currentCwd`.
  - Else prefer the currently selected top tab's `currentCwd`.
  - Else prefer the first tab `initialCwd`.
  - Else use `null` and allow main process fallback.
- Create a new terminal tab named `Project N`, where `N` is the next available top-tab number in that workspace.
- Select the new top tab.
- Spawn its PTY with the inherited cwd.

Renaming a top tab:

- Show a pencil icon when hovering over the top tab title.
- Clicking the pencil starts inline editing like the sidebar.
- Commit on Enter or blur.
- Cancel on Escape.
- Do not allow an empty name; preserve the previous name.

Renaming a sidebar workspace:

- Preserve the existing sidebar rename behavior.
- Default names should now be ordinal `Project N` names instead of date/time strings.

Deleting a top tab:

- If the workspace has one top tab, do not show delete or disable it.
- If deleting the active top tab, select the most recently active remaining tab.
- Close the PTY for the deleted top tab through existing `ptyClose`.

Deleting a sidebar workspace:

- Close every PTY owned by that workspace's top tabs.
- Preserve existing behavior for selecting the next workspace.

Split-screen:

- Track left and right panes by terminal tab ID, not workspace ID.
- Split mode should allow dragging top tabs into the right pane.
- Sidebar selection changes should update the visible workspace and its selected tab, but should not accidentally orphan the right pane.
- If split behavior becomes too broad for the first implementation, keep split-screen constrained to top tabs within the selected workspace and document that as the first shipped scope.

## Implementation Steps

1. Introduce the top-tab data model in `App.tsx`.
   - Add `TerminalTab` and workspace helper creation functions.
   - Migrate existing session state initialization to create one workspace with one `Project 1` top tab.
   - Replace date/time default sidebar naming with cwd-based folder naming.
   - Add `Project N` naming for top tabs scoped to each workspace.
   - Add helpers for selecting, touching, renaming, creating, and deleting top tabs.

2. Add `TopTabBar`.
   - Follow the sidebar's inline rename pattern.
   - Show a pencil icon on hover for each top project tab.
   - Use simple icon buttons and compact tab styling.
   - Keep stable tab dimensions with ellipsis for long names.

3. Rewire terminal rendering.
   - Render `TerminalPane` per terminal tab instead of per sidebar item.
   - Key panes by top tab ID.
   - Pass terminal tab metadata to `TerminalPane`.
   - Update activity, agent state, cwd, drawer, and pane close handlers to target top tab IDs.

4. Update PTY creation to accept `initialCwd`.
   - Modify preload, env types, and main IPC.
   - Add safe cwd normalization in main.
   - Pass the cwd from `TerminalPane`.

5. Add cwd propagation from terminal to app state.
   - When `extractThinkingCwd(data)` returns a cwd, update the tab's `currentCwd`.
   - Use that state when creating future top tabs.

6. Update layout CSS.
   - Add `.top-tab-bar` styles.
   - Reserve vertical space inside `.terminal-area`.
   - Move terminal panes, split divider, empty pane, and drag overlays below the top tab bar.

7. Preserve sidebar behavior.
   - Sidebar should still receive a list of workspace-like items.
   - Status dots should summarize the selected or most active top tab in that workspace.
   - Rename/delete/new sidebar behavior should remain unchanged from the user's perspective.

8. Verify and tighten edge cases.
   - Check first render, top tab rename, new top tab cwd inheritance, delete tab, delete workspace, split mode, markdown popout, and terminal resizing.

## Files Expected To Change

- `src/renderer/src/App.tsx`
- `src/renderer/src/App.css`
- `src/renderer/src/components/TerminalPane.tsx`
- `src/renderer/src/components/TerminalPane.css`
- `src/renderer/src/components/Sidebar.tsx`
- `src/renderer/src/components/TopTabBar.tsx`
- `src/renderer/src/components/TopTabBar.css`
- `src/preload/index.ts`
- `src/renderer/src/env.d.ts`
- `src/main/index.ts`

## Verification Plan

Automated checks:

- `npm run build` passed after implementation.

Manual checks in `npm run dev`:

Status: not run in this implementation pass; use this checklist for interactive Electron QA.

- App starts with one sidebar workspace that updates to its cwd folder name and one top tab named `Project 1`.
- Create another sidebar workspace and confirm it also updates to its own cwd folder name.
- Hover over `Project 1`, click the pencil icon, rename it, switch away and back, and confirm the name remains.
- Run `pwd`, `cd` into a repo folder, create `Project 2`, and confirm `pwd` in `Project 2` matches the inherited folder.
- Create `Project 3` and confirm numbering is stable.
- Switch between top tabs and confirm each terminal keeps independent scrollback, composer text, and running process state.
- Confirm each sidebar workspace gets its own independent `Project 1` sequence.
- Delete a non-active top tab and confirm its PTY exits without affecting other tabs.
- Try deleting the only top tab and confirm the UI prevents it.
- Toggle split-screen and confirm pane sizing, focus, drag/drop, and close-pane behavior still work.
- Open a Markdown file and confirm the markdown popout still reserves horizontal space correctly.
- Resize the window and confirm top tab labels truncate instead of overlapping controls.

## Risks And Open Decisions

- The existing term `Session` currently means left sidebar terminal tab. The new feature changes the product meaning of that layer, so the code may be clearer after a later rename pass.
- Split-screen behavior is the highest-risk part because it currently uses sidebar session IDs. The first implementation should keep split behavior simple and test it manually.
- The first tab's cwd is only known after shell integration reports it. If a user creates `Project 2` immediately on app launch, the app may need to fall back to the default cwd.
- Cwd inheritance should be implemented through PTY spawn cwd, not by sending `cd ...` after startup, so startup is cleaner and avoids command-history pollution.
