# Agent Permission Popup Plan

## Goal

When Claude Code or Codex running inside an Thinking terminal needs permission approval, Thinking should show a macOS-visible popup in the top-right of the screen, above other app windows. The popup should summarize the requested permission and offer two actions:

- **Approve**
- **Deny**

Clicking either action should send the correct response to the original Thinking terminal session.

## Current Architecture Notes

Thinking is an Electron app.

- Main process: `src/main/index.ts`
  - Owns `BrowserWindow` creation.
  - Owns PTY lifecycle in `ptyProcesses`.
  - Already exposes `pty:write` and `pty:writeSequence`.
- Preload bridge: `src/preload/index.ts`
  - Exposes PTY operations to the renderer through `window.api`.
- Terminal renderer: `src/renderer/src/components/TerminalPane.tsx`
  - Owns xterm.js rendering.
  - Tracks Claude/Codex sessions with `isAgentProcessName`, `isAgentLaunchCommand`, agent idle/running state, and foreground process polling.
  - Receives PTY data through `window.api.onPtyData`.
  - Buffers hidden tab output instead of always writing it immediately to xterm.
- App state: `src/renderer/src/App.tsx`
  - Tracks sessions, tabs, agent state, active tab, split panes, and focus signals.

The feature should reuse this architecture instead of adding a second terminal-control path.

## Key Assumptions

- This feature is macOS-first.
- The popup is an Electron overlay window, not a native macOS notification. Native notifications are not reliably always-on-top and have limited custom button behavior.
- Approval/denial can be performed by writing deterministic keystrokes to the PTY session.
- Claude Code and Codex permission prompts can be detected from PTY output text with provider-specific patterns.
- The popup should appear even when Thinking is not the foreground app.

## Product Decisions

- The popup should appear on the active display that contains the Thinking window for the terminal session that needs approval.
- The popup should appear over full-screen apps and across macOS Spaces.
- Clicking **Approve** should immediately approve in the underlying Thinking terminal. It should not bring Thinking forward for a second confirmation.
- The first version should support both Claude Code and Codex.
- All approval prompts should trigger the popup, including command execution, file edits, network access, sandbox escalation, MCP/tool access, and other approval classes exposed by the agent TUI.
- Multiple simultaneous approvals should be shown one at a time in a queue.
- The popup should include arrow navigation controls in the top-right corner of the popup rectangle so the user can move between queued approvals.
- After approving or denying one queued prompt, Thinking should advance to the next queued prompt.
- The popup should not have a timeout.
- Thinking should play a short chime when a new approval popup appears.
- **Deny** should send the terminal's normal denial keystroke. It should not send Escape or Ctrl-C unless that is the normal denial action for the current prompt.

## Permission Model References

- Claude Code documents that Bash commands and file modification require approval in its tiered permission system, and that permission rules can apply to Bash, Read, Edit, WebFetch, MCP, and related tools.
- Claude Code permission modes also explicitly describe approval pauses for file edits, shell commands, and network requests.
- Codex CLI approval modes document that Codex asks before touching anything outside the working-directory scope or using the network in its default mode.

These docs confirm the approval classes Thinking needs to watch, but they do not define stable terminal keystroke sequences for every prompt. The implementation should capture provider/version-specific prompt fixtures from real Claude Code and Codex TUI sessions and encode the resulting approve/deny sequences in tests.

## Proposed Design

### 1. Add a Permission Prompt Detector

Add a small detector module, likely under:

`src/renderer/src/lib/agentPermissionPrompts.ts`

Responsibilities:

- Accept PTY output chunks and maintain a bounded normalized tail per terminal session.
- Strip ANSI/control sequences for detection while preserving the raw PTY stream for terminal rendering.
- Detect provider:
  - Claude Code when `foregroundProcess` or launch command indicates `claude`.
  - Codex when `foregroundProcess` or launch command indicates `codex`.
- Return a structured prompt candidate:

```ts
interface AgentPermissionPrompt {
  id: string
  sessionId: string
  provider: 'claude' | 'codex'
  summary: string
  rawExcerpt: string
  fingerprint: string
  createdAt: number
  approveAction: PtyWriteChunk[]
  denyAction: PtyWriteChunk[]
}
```

Detection should happen on raw PTY data in `TerminalPane.tsx` before hidden-output buffering decisions. This matters because a hidden tab may not have the prompt rendered into xterm yet.

The first implementation should keep detection conservative. It should only fire when a prompt has:

- A known agent process/session.
- Clear permission language.
- Clear approve/deny options.
- A stable tail fingerprint so duplicate chunks do not create duplicate popups.

Examples of prompt classes to support once confirmed:

- Command execution approval.
- File write/edit approval.
- Network or sandbox escalation approval.
- MCP/tool permission approval.
- Plan approval prompts.
- Any other provider prompt with explicit approve/deny choices.

### 2. Surface Prompt Events to Main Process

Add preload APIs:

```ts
agentPermissionPromptShow(prompt: AgentPermissionPrompt): Promise<void>
agentPermissionPromptResolve(input: { promptId: string; decision: 'approve' | 'deny' }): Promise<void>
agentPermissionPromptDismiss(input: { promptId: string; reason: string }): Promise<void>
onAgentPermissionDecision(callback: (decision: AgentPermissionDecision) => void): () => void
```

The renderer should notify main when it detects a prompt. Main should own the overlay window and send the user's decision back to the renderer or directly to the PTY.

Preferred path:

1. `TerminalPane.tsx` detects prompt and calls `agentPermissionPromptShow`.
2. Main creates or updates the overlay window.
3. Overlay button click sends `agent-permission:decision` to main.
4. Main validates that the prompt is still current.
5. Main writes `approveAction` or `denyAction` to the original PTY using the existing `ptyProcesses` map.

Writing from main is preferable because main already owns PTY objects. It avoids depending on whichever renderer pane is currently mounted or visible.

### 3. Add a Small Always-On-Top Overlay Window

Add an overlay window manager in `src/main/index.ts`, or split into:

`src/main/agentPermissionOverlay.ts`

Use `BrowserWindow` with settings along these lines:

```ts
new BrowserWindow({
  width: 380,
  height: 150,
  frame: false,
  resizable: false,
  movable: false,
  alwaysOnTop: true,
  skipTaskbar: true,
  show: false,
  focusable: true,
  transparent: true,
  webPreferences: {
    preload: join(__dirname, '../preload/permission-overlay.js'),
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false
  }
})
```

Then configure macOS visibility:

```ts
overlayWindow.setAlwaysOnTop(true, 'screen-saver')
overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
```

Position it using Electron's `screen` module:

- Find the `BrowserWindow` that owns the target terminal session.
- Use the display containing that Thinking window's bounds.
- Place the popup at `workArea.x + workArea.width - width - 16`, `workArea.y + 16`.
- If the owning Thinking window is minimized or cannot be resolved, fall back to the primary display.

The overlay should auto-close when:

- The user clicks approve or deny.
- No pending prompts remain in the queue.
- The PTY exits.
- The terminal emits output indicating the permission prompt resolved.

The overlay should not auto-close solely because time elapsed.

### 4. Overlay UI

Add a dedicated renderer route or HTML entry for the overlay. The simplest Electron/Vite-friendly option is a lightweight React component loaded by route/query param from the same renderer bundle, for example:

- `src/renderer/src/components/AgentPermissionOverlay.tsx`
- `src/renderer/src/components/AgentPermissionOverlay.css`

The UI should be compact:

- Title: `Codex needs approval` or `Claude Code needs approval`.
- One-line summary.
- Optional small excerpt in muted monospace text.
- Queue position text such as `2 of 4` when more than one approval is pending.
- Previous/next arrow icon buttons in the popup rectangle's top-right corner when more than one approval is pending.
- Buttons: `Deny`, `Approve`.

Button order should be confirmed. macOS destructive/cancel patterns usually put the safer action on the left and primary action on the right.

Resolved button behavior:

- `Approve` immediately sends the approval sequence for the currently displayed prompt.
- `Deny` immediately sends the normal denial sequence for the currently displayed prompt.
- After either action, remove the prompt from the queue and show the next pending approval if one exists.

Chime behavior:

- Play one short chime when the overlay first appears from an empty queue.
- If the overlay is already open and another prompt is added to the queue, play a short chime for that newly queued prompt.
- Do not play another chime just because the user navigates between already queued prompts.
- Prefer Electron's native system beep for the first implementation unless a custom branded sound is added later.

### 5. Approval/Deny Keystroke Mapping

Do not hardcode one global `y`/`n` mapping unless both tools confirm that is always correct.

Instead, make detector results include provider-specific write sequences:

```ts
const CODEX_APPROVE = [{ data: 'y' }, { data: '\r' }]
const CODEX_DENY = [{ data: 'n' }, { data: '\r' }]
```

If a prompt uses arrow-key selection rather than direct `y`/`n`, the mapping may need to be:

- Approve: `\r`
- Deny: `\x1b[B\r`
- Or another provider-specific sequence.

This needs real captured prompt samples before implementation is finalized. The captured samples can come from running current Claude Code and Codex versions locally during implementation; the user does not need to provide them.

### 6. Stale Prompt Protection

Before sending approval/denial, main should validate:

- `promptId` exists in the pending prompt map.
- `sessionId` still has a live PTY.
- The prompt is still pending.
- The decision has not already been sent.

Recommended pending state:

```ts
interface PendingAgentPermissionPrompt {
  prompt: AgentPermissionPrompt
  status: 'pending' | 'resolved' | 'dismissed'
  createdAt: number
}
```

After a button click, mark it resolved before writing to the PTY. This prevents double-clicks from sending duplicate keystrokes.

### 7. Queue Multiple Pending Prompts

Main should own a queue of pending prompts:

```ts
interface AgentPermissionPromptQueue {
  prompts: PendingAgentPermissionPrompt[]
  activePromptId: string | null
}
```

Queue behavior:

- Add newly detected prompts to the end of the queue after fingerprint dedupe.
- Show one prompt at a time.
- Use previous/next arrow buttons to change `activePromptId` without resolving prompts.
- When a prompt is approved or denied, remove it from the queue.
- After resolving a prompt, show the next prompt if available, otherwise the previous prompt, otherwise close the overlay.
- Keep prompts indefinitely until the user acts, the PTY exits, or Thinking detects that the prompt has resolved in the terminal.
- If two prompts from the same session have identical fingerprints, keep only one.

### 8. Settings and User Control

Add a setting in `SettingsModal.tsx` after the first working implementation:

- `Show approval popup when Thinking is in background`

Default recommendation: enabled, because the feature is explicitly about not missing permission prompts.

Optional follow-up settings:

- Only show for Codex.
- Only show for Claude Code.
- Do not show while Do Not Disturb / Focus mode is active, if Electron exposes enough signal.

Keep these out of the first pass unless needed.

## Implementation Steps

1. **Capture real prompt samples**
   - Run Codex and Claude Code in Thinking.
   - Trigger each permission class.
   - Save normalized excerpts and exact keystrokes needed for approve/deny.
   - Use these as detector fixtures.
   - Use public docs and current CLI behavior as references, but trust local captured TUI behavior for the final write sequences.

2. **Build detector**
   - Add `agentPermissionPrompts.ts`.
   - Add focused unit tests if the repo has a test harness, or add a small script-based fixture test if not.
   - Test false positives with normal agent output, shell prompts, and command logs.

3. **Add IPC and main pending state**
   - Add `agent-permission:show`, `agent-permission:decision`, and `agent-permission:dismiss`.
   - Store pending prompts in main.
   - Route decisions to `ptyProcesses.get(sessionId)?.write(...)` or the existing write-sequence logic.

4. **Build overlay window**
   - Add overlay window creation/positioning.
   - Use always-on-top and all-workspaces behavior on macOS.
   - Ensure only one overlay window appears at a time.
   - Add queued prompt navigation with top-right previous/next arrow buttons.
   - Play a short chime when a new approval prompt is queued.

5. **Connect TerminalPane detection**
   - In `onPtyData`, feed raw data to the detector.
   - Emit prompt events only for known agent sessions.
   - Dedupe by fingerprint.
   - Dismiss pending prompts when the PTY exits.

6. **Manual QA**
   - Thinking focused, prompt appears and buttons work.
   - Thinking backgrounded behind another app, prompt appears above the other app.
   - Thinking or another app is full-screen; prompt still appears.
   - Hidden Thinking tab receives prompt, popup still appears.
   - Split pane receives prompt, correct session gets the keystroke.
   - Multiple prompts in quick succession queue correctly.
   - A short chime plays when the popup appears and when a new prompt joins the queue.
   - Navigating between already queued prompts does not replay the chime.
   - Arrow navigation moves between queued approvals without sending terminal input.
   - Approving or denying one queued prompt advances to the next prompt.
   - PTY exits while popup is open; popup closes or disables actions.

## Risks

- **Prompt text changes:** Claude Code and Codex prompt layouts may change. Keep detectors provider-specific and fixture-backed.
- **Wrong keystroke mapping:** The most dangerous failure mode is sending an approval to the wrong UI state. Do not ship until real approve/deny sequences are captured.
- **macOS full-screen behavior:** Always-on-top Electron windows can behave differently across Spaces and full-screen apps. This needs manual testing on macOS.
- **Focus stealing:** A focusable overlay is needed for clickable buttons, but it may steal focus from the user's current app. If this is too disruptive, use a non-focusable window plus a main-process click handler approach only if button interaction still works reliably.
- **Multiple displays:** The product decision is to use the display containing the relevant Thinking window. The implementation needs a fallback for minimized or missing windows.

## Resolved Questions

1. Display: use the active display containing the relevant Thinking window.
2. Full-screen and Spaces: show over full-screen apps and other Spaces.
3. Approval behavior: approve immediately.
4. Provider scope: support both Claude Code and Codex in the first version.
5. Prompt samples: implementation should obtain current prompt samples through docs and local CLI capture; the user does not need to provide samples.
6. Permission classes: all approval prompts.
7. Multiple prompts: one popup with a queue and top-right arrow navigation.
8. Timeout: no timeout.
9. Denial behavior: send the normal denial keystroke only.

## Remaining Implementation Questions

1. What should the popup do if Thinking is minimized and the target terminal's display cannot be inferred: primary display or display nearest cursor?
2. Should queued prompts be ordered strictly by detection time, or should the active selected Thinking tab's prompt jump to the front?

## Recommended First Version

Ship the first version as:

- macOS-only.
- Enabled by default.
- One always-on-top popup window at a time, backed by a queue.
- Top-right arrow navigation for queued approval prompts.
- Detect only confirmed Codex and Claude Code permission prompts from fixture-backed patterns.
- Use main-process PTY writes, not UI automation.
- Place the popup on the display containing the Thinking window for the terminal session that needs approval.
- Show over full-screen apps and macOS Spaces.
- No timeout.
- Short chime when a new approval prompt appears.
- Immediate approve/deny.
- Require exact prompt samples from current local Claude Code and Codex sessions before finalizing approve/deny keystrokes.
