# Sidebar Title From Terminal Folder Plan

## Goal

Automatically rename each left-hand sidebar project from its default placeholder title, such as `Project 1`, to the basename of the terminal's current working directory.

Primary example:

- Terminal command: `cd /Users/rling/Documents/Vibing/Emu-dev`
- Reported cwd: `/Users/rling/Documents/Vibing/Emu-dev`
- Sidebar project title: `Emu-dev`

This plan is scoped to the left-hand sidebar project title. Top terminal tab names can continue using their own names, such as `Project 1`, `Project 2`, or user-provided tab names.

## Assumptions

- The sidebar project title should follow the folder name only while the title is still auto-managed.
- A manual sidebar rename should be treated as user intent and should stop future cwd-based auto-renames for that sidebar project.
- The app should never show the full absolute path in the sidebar title.
- The feature can use the existing zsh shell-integration cwd signal instead of adding new IPC or terminal parsing infrastructure.
- Windows path handling is not a required target for this change because the current cwd signal accepts absolute paths beginning with `/`.

## Current Code Context

Emu already has most of the needed cwd plumbing:

- `src/main/index.ts` writes a zsh wrapper in `setupShellIntegration()`.
- That wrapper emits `OSC 633;EmuCwd=<absolute path>` before each prompt.
- `src/renderer/src/components/TerminalPane.tsx` parses that sequence with `extractEmuCwd(data)`.
- `TerminalPane` stores the latest cwd in `currentWorkingDirectoryRef`.
- `TerminalPane` calls `onCurrentCwdChange(cwd)` when a new cwd is received.
- `src/renderer/src/App.tsx` owns sidebar project state and already knows which sidebar project owns the reporting terminal tab.
- `src/renderer/src/components/Sidebar.tsx` renders `session.name`, so no visual component change should be required if `Session.name` is updated correctly.

The implementation should therefore live primarily in `src/renderer/src/App.tsx`.

## Desired Behavior

1. A new sidebar project still starts with its existing placeholder title, such as `Project 1`.
2. When any terminal tab inside that sidebar project reports a cwd, the owning sidebar project title changes to the cwd folder basename.
3. Only the final folder segment should be displayed:
   - `/Users/rling/Documents/Vibing/Emu-dev` -> `Emu-dev`
   - `/Users/rling/Documents/Vibing/` -> `Vibing`
   - `/Users/rling` -> `rling`
4. Empty, invalid, or root-only cwd values should not change the sidebar title.
5. Repeated cwd reports for the same folder should not cause unnecessary React state churn.
6. Manual sidebar renames should disable future auto-renames for that sidebar project.
7. Each sidebar project should auto-rename independently.

## Data Model

Add an auto-rename flag to the sidebar project model:

```ts
export interface Session {
  id: string
  name: string
  autoRenameFromCwd: boolean
  // existing fields...
}
```

Initialize it in `createSession(projectNumber)`:

```ts
autoRenameFromCwd: true
```

When the user manually renames a sidebar project, set it to `false`:

```ts
session.id === id ? { ...session, name, autoRenameFromCwd: false } : session
```

## Folder Name Helper

Add a small helper near the other `App.tsx` helper functions:

```ts
function folderNameFromCwd(cwd: string): string | null {
  const trimmed = cwd.trim()
  if (!trimmed) return null
  const withoutTrailingSlashes = trimmed.replace(/\/+$/, '')
  if (!withoutTrailingSlashes) return null
  const folderName = withoutTrailingSlashes.split('/').filter(Boolean).at(-1)
  return folderName || null
}
```

Expected examples:

| Input | Output |
| --- | --- |
| `/Users/rling/Documents/Vibing/Emu-dev` | `Emu-dev` |
| `/Users/rling/Documents/Vibing/Emu-dev/` | `Emu-dev` |
| `/Users/rling` | `rling` |
| `/` | `null` |
| `` | `null` |

## Implementation Steps

1. Update `Session` in `src/renderer/src/App.tsx`.
   - Add `autoRenameFromCwd: boolean`.
   - Keep the field renderer-local unless persistence is added elsewhere.

2. Update `createSession(projectNumber)`.
   - Set `autoRenameFromCwd: true` for new sidebar projects.
   - Leave the initial title as `Project ${projectNumber}` until a cwd arrives.

3. Add `folderNameFromCwd(cwd)`.
   - Keep it small and deterministic.
   - Do not add a new dependency for path parsing.
   - Normalize trailing slashes before taking the basename.

4. Update `handleCurrentCwdChange(tabId, currentCwd)`.
   - Continue updating the reporting tab's `currentCwd`.
   - Locate the session that owns the reporting tab.
   - If `session.autoRenameFromCwd` is `true`, derive `nextName` with `folderNameFromCwd(currentCwd)`.
   - If the helper returns `null`, preserve the existing `session.name`.
   - Return the existing session object when neither the tab cwd nor the session name changes.

5. Update `handleRename(id, name)`.
   - Preserve the user-entered title.
   - Set `autoRenameFromCwd: false` for that sidebar project.

6. Confirm no changes are needed in `Sidebar.tsx`.
   - It already displays `session.name`.
   - Its rename callback already reports the sidebar project id and new title.

7. Confirm no changes are needed in `TerminalPane.tsx` or `src/main/index.ts`.
   - `TerminalPane` already emits `onCurrentCwdChange(cwd)`.
   - The main process already emits cwd through zsh shell integration.

## Verification Plan

Automated checks:

1. Run `npm run build`.
2. If a focused test harness is added later, cover `folderNameFromCwd` edge cases:
   - normal absolute path
   - trailing slash
   - root path
   - empty string
   - whitespace-only string

Manual Electron QA:

1. Start the app with `npm run dev`.
2. Confirm the initial left sidebar project title is `Project 1`.
3. In the terminal, run:

   ```sh
   cd /Users/rling/Documents/Vibing/Emu-dev
   ```

4. Confirm the left sidebar project title changes to `Emu-dev`.
5. Run:

   ```sh
   cd /Users/rling/Documents/Vibing
   ```

6. Confirm the left sidebar project title changes to `Vibing`.
7. Manually rename the sidebar project to `Launch fixes`.
8. Run another `cd` command.
9. Confirm the sidebar project title stays `Launch fixes`.
10. Create a second sidebar project.
11. Confirm it starts as `Project 2`.
12. Run a `cd` command in the second project.
13. Confirm only the second sidebar project title changes.
14. Create a second top tab inside a sidebar project and run `cd` there.
15. Confirm the owning sidebar project title updates, while top tab names remain unchanged.

## Acceptance Criteria

- `cd /Users/rling/Documents/Vibing/Emu-dev` changes the left sidebar title to `Emu-dev`.
- The sidebar title uses the folder basename, not the full path.
- Manual sidebar renames are not overwritten by future cwd changes.
- Top terminal tab names remain independent.
- Multiple sidebar projects maintain independent titles and auto-rename state.
- `npm run build` passes.

## Risks And Follow-Ups

- The cwd signal currently depends on the zsh shell-integration wrapper. If another shell is used, the sidebar may not auto-rename until equivalent cwd reporting exists for that shell.
- The manual rename opt-out is one-way in this plan. If users need to re-enable auto-renaming, that should be a separate explicit UI affordance rather than implicit behavior.
- Existing sessions are in-memory today. If sidebar sessions become persisted later, `autoRenameFromCwd` should be included in the persisted schema or given a migration default.

