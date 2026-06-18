# Permission Popup Folder Title Plan

## Goal

Change the native permission popup title from provider-based text like:

- `Codex needs approval`
- `Claude Code needs approval`

to workspace-folder text like:

- `Emu-dev needs approval`
- `starboard needs approval`

The title should match the left-hand sidebar project name, because that sidebar name is already auto-derived from the terminal current working directory basename.

## Scope

This plan changes only the popup title source.

Do not change:

- Permission detection logic.
- Approve or Deny behavior.
- Popup size, layout, chime, drag behavior, queue navigation, or positioning.
- Sidebar auto-rename behavior.
- Top terminal tab names.

## Current Code Context

The relevant flow is split between renderer and main:

- `src/renderer/src/App.tsx`
  - Owns sidebar project state through `Session`.
  - Stores the visible sidebar project title in `Session.name`.
  - Has `autoRenameFromCwd`.
  - Has `folderNameFromCwd(cwd)`.
  - Updates `Session.name` in `handleCurrentCwdChange(tabId, currentCwd)`.

- `src/renderer/src/components/TerminalPane.tsx`
  - Receives one `TerminalTab` as `session`.
  - Emits cwd changes through `onCurrentCwdChange(cwd)`.
  - Detects permission prompts in the renderer and calls:
    - `window.api.agentPermissionPromptShow(permissionPrompt)`

- `src/main/index.ts`
  - Also scans PTY output directly through `scanAgentPermissionPtyOutput(...)`.
  - Enqueues prompts through `addAgentPermissionPrompt(...)`.
  - Builds the native overlay HTML in `buildAgentPermissionOverlayHtml()`.
  - Currently renders the title with:

```js
title.textContent = providerLabel(prompt.provider) + ' needs approval'
```

- `src/preload/index.ts`
  - Exposes `agentPermissionPromptShow(...)` from renderer to main.

Important detail: the permission prompt `sessionId` is the terminal tab id, not the sidebar project id.

## Design Decision

Use the sidebar project display name as the popup approval label.

Reasoning:

- The user explicitly tied this behavior to the left-hand sidebar name.
- `Session.name` is already the app's current user-facing project/workspace name.
- It already reflects cwd basename for normal auto-managed projects.
- It also respects manual sidebar renames, which is consistent with using the displayed project name as the source of truth.

Assumption for review:

- If the user manually renames the sidebar project to `Launch fixes`, a permission popup from that project should say `Launch fixes needs approval`, not the raw cwd folder name.

If strict cwd basename is preferred even after manual sidebar rename, the implementation should pass a separate cwd-derived title instead of `Session.name`.

## Proposed Behavior

1. When a terminal tab belongs to a sidebar project named `Emu-dev`, any permission popup from that tab says:

```text
Emu-dev needs approval
```

2. When a terminal tab belongs to a sidebar project named `starboard`, any permission popup from that tab says:

```text
starboard needs approval
```

3. For multiple queued permissions, navigating between queued prompts should update the title to the active prompt's workspace name.

4. If no workspace title is available, fall back to the current provider label:

```text
Codex needs approval
Claude Code needs approval
```

This fallback avoids blank or misleading popup titles during unexpected races.

## Data Flow

There are two detection paths that must both receive the workspace title.

### Renderer-Detected Prompt Path

Current:

```text
TerminalPane detects prompt
-> window.api.agentPermissionPromptShow(permissionPrompt)
-> main sanitizes prompt
-> main queues prompt
-> overlay title uses provider
```

Planned:

```text
App passes sidebar Session.name into TerminalPane as workspaceName
-> TerminalPane attaches workspaceName to permissionPrompt
-> window.api.agentPermissionPromptShow(permissionPromptWithWorkspaceName)
-> main sanitizes prompt.workspaceName
-> overlay title uses workspaceName
```

### Main-Detected Prompt Path

Current:

```text
main scans PTY output before renderer receives it
-> main detects prompt
-> main queues prompt without renderer context
-> overlay title uses provider
```

Planned:

```text
App/TerminalPane keeps main updated with tab session metadata:
  terminal tab id -> sidebar workspace name

main scans PTY output
-> main detects prompt with terminal tab id
-> main looks up workspace name for that terminal tab id
-> main queues prompt with workspaceName
-> overlay title uses workspaceName
```

This avoids a brief flash of `Codex needs approval` when main detects the prompt before the renderer duplicate-refresh path arrives.

## Implementation Steps

### 1. Extend Shared Permission Prompt Type

File: `src/shared/agentPermissionPrompts.ts`

Add an optional display field to `AgentPermissionPrompt`:

```ts
workspaceName?: string
```

Keep it optional so the detector code does not need to know about app-level workspace naming.

The detector-created prompt objects can omit this field.

### 2. Extend Renderer Global Types

File: `src/renderer/src/env.d.ts`

Update:

```ts
interface AgentPermissionPrompt {
  workspaceName?: string
}

interface AgentPermissionOverlayPrompt {
  workspaceName?: string
}
```

Add a small metadata API type:

```ts
interface AgentPermissionSessionMetadata {
  sessionId: string
  workspaceName?: string | null
}
```

Expose a preload API:

```ts
agentPermissionSessionMetadata: (metadata: AgentPermissionSessionMetadata) => Promise<void>
```

### 3. Add Preload IPC Bridge

File: `src/preload/index.ts`

Add:

```ts
agentPermissionSessionMetadata: (metadata: unknown) =>
  ipcRenderer.invoke('agent-permission:sessionMetadata', metadata)
```

Keep the input `unknown` at the preload boundary, matching the existing permission IPC style.

### 4. Track Session Metadata In Main

File: `src/main/index.ts`

Add a map keyed by terminal tab id:

```ts
const agentPermissionSessionWorkspaceNames = new Map<string, string>()
```

Add a sanitizer:

```ts
function sanitizeWorkspaceName(input: unknown): string | null
```

Suggested rules:

- Accept strings only.
- Trim whitespace.
- Remove control characters.
- Collapse repeated whitespace.
- Reject empty strings.
- Limit to about 80 characters.
- Do not reject hyphens, dots, underscores, spaces, or mixed case.

Do not require the value to look like a filesystem basename. Manual sidebar names can be normal user-facing titles.

Add an IPC handler:

```ts
ipcMain.handle('agent-permission:sessionMetadata', (_, input: unknown) => {
  // validate sessionId and workspaceName
  // set or delete map entry
})
```

Validation:

- `sessionId` must be a non-empty string with the same length cap used elsewhere, likely `<= 120`.
- `workspaceName` is sanitized with `sanitizeWorkspaceName`.
- If the sanitized name is null, delete the map entry for that session id.

Clean up the map when a PTY exits or closes, next to existing cleanup:

```ts
ptyOwnerWindowIds.delete(sessionId)
clearAgentPermissionSessionState(sessionId)
dismissAgentPermissionPromptsForSession(sessionId)
```

### 5. Optionally Seed Metadata At PTY Creation

Files:

- `src/preload/index.ts`
- `src/main/index.ts`
- `src/renderer/src/env.d.ts`
- `src/renderer/src/components/TerminalPane.tsx`

Extend `PtyCreateOptions` with:

```ts
workspaceName?: string | null
```

When `TerminalPane` creates the PTY, pass:

```ts
window.api.ptyCreate(session.id, {
  cwd: session.initialCwd,
  workspaceName
})
```

In main's `pty:create` handler, sanitize and store `options?.workspaceName`.

This is not enough by itself because the sidebar name can change after cwd reports, but it reduces race risk for early prompts.

### 6. Pass Sidebar Name Into TerminalPane

File: `src/renderer/src/App.tsx`

The render loop currently maps `allTabs` and passes each `tab` into `TerminalPane`.

Change the `allTabs` memo or render loop so each entry includes the owning sidebar session name:

```ts
const allTabs = useMemo(
  () => sessions.flatMap((session) =>
    session.tabs.map((tab) => ({
      tab,
      workspaceId: session.id,
      workspaceName: session.name
    }))
  ),
  [sessions]
)
```

Then pass:

```tsx
<TerminalPane
  ...
  workspaceName={workspaceName}
/>
```

### 7. Sync Metadata From TerminalPane

File: `src/renderer/src/components/TerminalPane.tsx`

Add `workspaceName?: string` to props.

Keep a ref for prompt detection, similar to existing callback refs:

```ts
const workspaceNameRef = useRef(workspaceName)
useEffect(() => {
  workspaceNameRef.current = workspaceName
}, [workspaceName])
```

Add an effect to keep main's session metadata current:

```ts
useEffect(() => {
  void window.api.agentPermissionSessionMetadata({
    sessionId: session.id,
    workspaceName
  })
}, [session.id, workspaceName])
```

This effect should run for hidden tabs too, because permissions can be detected for non-visible sessions by main's PTY scanner.

### 8. Attach Workspace Name To Renderer-Detected Prompts

File: `src/renderer/src/components/TerminalPane.tsx`

Change:

```ts
window.api.agentPermissionPromptShow(permissionPrompt).catch(() => {})
```

to:

```ts
window.api.agentPermissionPromptShow({
  ...permissionPrompt,
  workspaceName: workspaceNameRef.current
}).catch(() => {})
```

This ensures renderer-detected prompts carry the same title even if main metadata was stale.

### 9. Sanitize And Preserve Workspace Name In Main

File: `src/main/index.ts`

Update `sanitizeAgentPermissionPrompt(input)` to read:

```ts
const workspaceName = sanitizeWorkspaceName(candidate.workspaceName)
```

Return the sanitized field only when present:

```ts
workspaceName: workspaceName ?? undefined
```

Add a helper that enriches prompts before queuing:

```ts
function withAgentPermissionWorkspaceName(prompt: AgentPermissionPrompt): AgentPermissionPrompt {
  const workspaceName = prompt.workspaceName ?? agentPermissionSessionWorkspaceNames.get(prompt.sessionId)
  return workspaceName ? { ...prompt, workspaceName } : prompt
}
```

Use this at the start of `addAgentPermissionPrompt(...)`, before duplicate handling:

```ts
const promptWithWorkspaceName = withAgentPermissionWorkspaceName(prompt)
```

Then use `promptWithWorkspaceName` throughout the function.

This is important for:

- Main-detected prompts.
- Duplicate refreshes where renderer later supplies a workspace title.
- Active queued prompts whose title should update when duplicate refresh happens.

### 10. Serialize Workspace Name To Overlay State

File: `src/main/index.ts`

Update `AgentPermissionOverlayPrompt`:

```ts
workspaceName?: string
```

Update `serializeAgentPermissionState()`:

```ts
workspaceName: entry.prompt.workspaceName
```

Only include sanitized values from main.

### 11. Render Workspace Name In Overlay Title

File: `src/main/index.ts`

Inside `buildAgentPermissionOverlayHtml()`, replace provider-only title rendering.

Current:

```js
title.textContent = providerLabel(prompt.provider) + ' needs approval'
```

Planned:

```js
function approvalLabel(prompt) {
  return prompt.workspaceName || providerLabel(prompt.provider)
}

title.textContent = compactMiddle(approvalLabel(prompt), 48) + ' needs approval'
```

Use existing `compactMiddle(...)` so long manual names do not overflow the title row.

The CSS already has:

```css
.title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

So this should not require layout changes.

## Edge Cases

### Prompt Before First Cwd Report

If the sidebar is still `Project 1`, the popup may say:

```text
Project 1 needs approval
```

That is acceptable if `Project 1` is the current sidebar display name. If this is not desired, the implementation can suppress placeholder names matching `/^Project \d+$/` and fall back to provider until a cwd-derived name exists.

Recommendation: do not add placeholder suppression unless it becomes visually confusing in manual QA.

### Manual Sidebar Rename

With the proposed source of truth, manual sidebar renames are respected.

Example:

- User is in `/Users/rling/Documents/Vibing/Emu-dev`.
- Sidebar auto-renames to `Emu-dev`.
- User manually renames sidebar project to `Review work`.
- Popup says `Review work needs approval`.

This follows the visible sidebar title rather than the raw cwd.

### Multiple Sidebar Projects

Each terminal tab id maps to its owning sidebar project name.

Expected behavior:

- A permission from a tab under `Emu-dev` says `Emu-dev needs approval`.
- A permission from a tab under `starboard` says `starboard needs approval`.
- Queue navigation updates the title as the active prompt changes.

### Split Screen

Split screen uses terminal tab ids and does not change ownership. The popup title should still use the owning sidebar session name, independent of whether the tab is in the left or right pane.

### Hidden Tabs

Hidden `TerminalPane` instances are still mounted in the current render loop. The metadata sync effect should therefore keep main updated for hidden tabs as well.

### Main/Renderer Race

Because main scans PTY output before forwarding it to renderer, main can detect a prompt first.

The metadata map plus `ptyCreate` seeding handles this. Renderer duplicate-refresh also acts as a second path to update the prompt with `workspaceName`.

## Files Expected To Change

- `src/shared/agentPermissionPrompts.ts`
- `src/renderer/src/env.d.ts`
- `src/preload/index.ts`
- `src/renderer/src/App.tsx`
- `src/renderer/src/components/TerminalPane.tsx`
- `src/main/index.ts`
- `plans/permission-popup-folder-title-plan.md`

No CSS changes are expected.

## Verification Plan

Automated checks:

```bash
npm exec tsc -- --noEmit
npm run build
node scripts/verify-agent-permission-detector.mjs
git diff --check
```

Manual checks:

1. Start the dev app.
2. In a terminal tab, run:

```bash
cd /Users/rling/Documents/Vibing/Emu-dev
```

3. Confirm the left sidebar project title becomes `Emu-dev`.
4. Trigger a Codex approval prompt from that tab.
5. Confirm the popup title says:

```text
Emu-dev needs approval
```

6. Approve and confirm the approval still reaches the terminal.
7. In another sidebar project or tab, run:

```bash
cd /Users/rling/Documents/Vibing/starboard
```

8. Confirm its sidebar project title becomes `starboard`.
9. Trigger an approval prompt there.
10. Confirm the popup title says:

```text
starboard needs approval
```

11. Trigger two approvals from different sidebar projects before resolving them.
12. Use the popup queue arrows.
13. Confirm the title changes to match the active queued prompt's project.
14. Deny one prompt and approve the other.
15. Confirm both terminal actions still behave exactly as before.

Optional manual checks:

1. Manually rename the sidebar project to `Review work`.
2. Trigger an approval prompt.
3. Confirm the popup says `Review work needs approval`.
4. Decide during review whether that is preferred over strict cwd basename behavior.

## Rollback Plan

If the change causes stale or incorrect titles:

1. Keep the new metadata IPC harmless but stop using `workspaceName` in overlay rendering.
2. Restore:

```js
title.textContent = providerLabel(prompt.provider) + ' needs approval'
```

3. Remove `workspaceName` serialization only after confirming no other code depends on it.

The approval behavior itself should remain unaffected because approve/deny actions and fingerprints are not changed.

## Review Questions

1. Should manual sidebar renames appear in the popup title, or should the popup always use the raw cwd basename?
2. Should placeholder sidebar names like `Project 1` be allowed in the popup before the first cwd report?
3. Is `workspaceName` the preferred field name, or should this be named more generically, such as `approvalTitle`?

Recommendation for first implementation:

- Use `workspaceName`.
- Use the sidebar display name exactly.
- Allow `Project N` fallback if that is the current visible sidebar name.
