# Sidebar Folder Name Auto-Rename Plan

## Implementation Progress

- [x] Plan reviewed and manual-rename opt-out behavior accepted by implementation request.
- [x] Add `autoRenameFromCwd` project state.
- [x] Derive sidebar names from cwd folder basenames.
- [x] Preserve manual sidebar renames by disabling future auto-renames.
- [x] Run build verification and record result.

Last updated: implementation complete; `npm run build` passed.

## Understanding

When a user changes directory inside a terminal, the matching left-hand sidebar project should automatically rename to the folder name only, not the full path.

Example:

- User runs `cd /Users/rling/Documents/Vibing/Thinking-dev`
- Thinking already receives the cwd as `/Users/rling/Documents/Vibing/Thinking-dev`
- Sidebar project name changes from `Project 1` to `Thinking-dev`

The top project tabs should keep their own names, such as `Project 1`, `Project 2`, or a user-renamed project title. This change is only for the left sidebar project name.

## Current Code Context

The prior sidebar-project/top-project tab feature already gives us most of the plumbing:

- `TerminalPane` extracts cwd from the shell integration OSC sequence via `extractThinkingCwd`.
- `TerminalPane` calls `onCurrentCwdChange(cwd)` whenever cwd changes.
- `App.tsx` handles that in `handleCurrentCwdChange(id, currentCwd)`.
- `App.tsx` already knows which workspace owns the tab that reported the cwd.
- Sidebar project names are stored as `Session.name`.
- New sidebar projects currently default to `Project N`.
- Manual sidebar rename currently goes through `handleRename(id, name)`.

So this should be implemented in `App.tsx` without changing the main-process shell integration.

## Proposed Behavior

1. New projects still start as `Project 1`, `Project 2`, etc.
2. When any top project tab in a sidebar project reports a cwd, the owning sidebar project can rename to the cwd basename.
3. The displayed name should be only the final path segment:
   - `/Users/rling/Documents/Vibing/Thinking-dev` -> `Thinking-dev`
   - `/Users/rling/Documents/Vibing` -> `Vibing`
   - `/Users/rling` -> `rling`
4. The app should ignore invalid or empty cwd strings.
5. The app should not show a full path in the sidebar.

## Manual Rename Rule

Recommended behavior: manual sidebar rename should opt the project out of future automatic folder renames.

Reasoning:

- If the user explicitly renames a project to something meaningful, such as `Launch fixes`, Thinking should not overwrite it the next time a terminal prompt reports cwd.
- Default `Project N` names are placeholders, so replacing them with folder names is useful.
- Folder-name auto-renames are helpful only until the user intentionally gives the project a custom label.

Implementation detail:

- Add a field to the sidebar project model:

```ts
autoRenameFromCwd: boolean
```

- `createSession(projectNumber)` sets `autoRenameFromCwd: true`.
- `handleRename(id, name)` sets `autoRenameFromCwd: false`.
- `handleCurrentCwdChange(tabId, currentCwd)` updates `Session.name` only if `autoRenameFromCwd` is still `true`.

## Folder Name Helper

Add a small helper in `App.tsx`:

```ts
function folderNameFromCwd(cwd: string): string | null
```

Expected rules:

- Trim whitespace.
- Remove trailing slashes, except for root.
- Split on `/`.
- Return the final non-empty segment.
- Return `null` for empty input or root-only paths.

Examples:

- `/Users/rling/Documents/Vibing/Thinking-dev` -> `Thinking-dev`
- `/Users/rling/Documents/Vibing/Thinking-dev/` -> `Thinking-dev`
- `/` -> `null`
- `''` -> `null`

## Data Model Change

Update `Session` in `src/renderer/src/App.tsx`:

```ts
export interface Session {
  id: string
  name: string
  autoRenameFromCwd: boolean
  ...
}
```

This is renderer-only state for now, matching the current non-persistent sidebar-project and top-project tab model.

## Implementation Steps

1. Update `Session` with `autoRenameFromCwd`.
2. Set `autoRenameFromCwd: true` in `createSession`.
3. Add `folderNameFromCwd(cwd)` helper.
4. Update `handleCurrentCwdChange`:
   - Keep updating the reporting tab's `currentCwd`.
   - Find the owning session.
   - If `session.autoRenameFromCwd` is true, derive the folder name and update `session.name`.
   - Avoid state churn if the name is already the same.
5. Update `handleRename`:
   - Preserve the explicit user-entered name.
   - Set `autoRenameFromCwd: false`.
6. Run `npm run build`.
7. Manually test cwd changes in the dev app.

## Verification Plan

Automated:

- `npm run build` passed after implementation.

Manual:

Status: not run in this implementation pass; use this checklist for interactive Electron QA.

- Start the dev app.
- Confirm initial sidebar name is `Project 1`.
- In `Project 1`, run `cd /Users/rling/Documents/Vibing/Thinking-dev`.
- Confirm the sidebar name becomes `Thinking-dev`.
- Run `cd /Users/rling/Documents/Vibing`.
- Confirm the sidebar name becomes `Vibing` if the project has not been manually renamed.
- Manually rename the sidebar project to `Launch fixes`.
- Run another `cd`.
- Confirm the sidebar stays `Launch fixes`.
- Create a new sidebar project.
- Confirm it starts as `Project 2` and auto-renames independently when its own terminal cwd changes.

## Files Expected To Change

- `src/renderer/src/App.tsx`
- `plans/sidebar-folder-name-auto-rename-plan.md`

No changes are expected in `TerminalPane`, `Sidebar`, preload, or main process unless implementation discovers a missing cwd signal.

## Open Question For Review

Should manual sidebar renames permanently disable cwd auto-renaming for that project, as recommended above?

If you want sidebar names to always follow cwd, even after manual rename, the implementation should omit `autoRenameFromCwd` and always update the name from cwd.
