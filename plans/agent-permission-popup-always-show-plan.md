# Agent Permission Popup Always-Show Plan

## End Result

If you approve this plan and we implement it, Emu will show the permission popup every time Codex or Claude asks for approval, no matter where that request happens.

In plain terms:

- If the approval is in the tab you are looking at, the popup appears.
- If the approval is in a hidden tab, the popup still appears.
- If the approval is in another workspace, the popup still appears.
- If Emu is in the background while you are using another app, the popup still appears.
- If multiple approvals are waiting at the same time, one popup shows all of them in a queue so you can approve or deny each one.
- Approving or denying one request should not make the others disappear.
- Repeated redraws of the same terminal prompt should not create duplicate popup entries.

The practical outcome is that you should not have to hunt through tabs or manually notice a waiting terminal prompt. When an agent needs permission, Emu brings that approval to you.

## Goal

Make the native agent permission popup appear every time any Codex or Claude terminal session is waiting for user approval.

The product rule is:

> If an agent permission prompt is pending anywhere in Emu, the native popup must be visible and must include that permission in the queue.

This includes:

- The focused terminal tab.
- Hidden top tabs.
- Inactive split panes.
- Tabs from workspaces that are not currently selected.
- Emu being unfocused while another macOS app is frontmost.
- Multiple permissions becoming pending at roughly the same time.

The desired user-visible behavior is one global native popup with a reliable queue. If three permissions are pending, all three should be represented in that popup, regardless of which tabs produced them.

## Current Architecture Deep Dive

### Session And Tab Rendering

`src/renderer/src/App.tsx` keeps workspaces in `sessions`, and each workspace owns `tabs`.

Important details:

- `allTabs` is built from every workspace:

  ```ts
  sessions.flatMap((session) => session.tabs.map((tab) => ({ tab, workspaceId: session.id })))
  ```

- The render path maps `allTabs` to `TerminalPane`, so panes exist for tabs across workspaces, not only the selected workspace.
- `isVisible` is true only for the selected top tab and, in split mode, the right pane tab.
- Hidden tabs are still mounted, but they take the hidden-output path inside `TerminalPane`.

This means the renderer currently has a listener per mounted tab, but terminal visibility still changes how output is processed.

### PTY Ownership And Output Flow

`src/main/index.ts` owns the actual PTY processes:

- `ptyProcesses: Map<string, pty.IPty>`
- `ptyOwnerWindowIds: Map<string, number>`
- `ptyPerfStats`
- `ptyOutputBatches`

On `pty:create`, main creates the PTY and registers `ptyProcess.onData(...)`.

Current output flow:

1. PTY emits data in main.
2. Main batches output for up to `PTY_OUTPUT_BATCH_MS` or `PTY_OUTPUT_BATCH_MAX_BYTES`.
3. Main sends `pty:data:${sessionId}` to the renderer.
4. The matching `TerminalPane` receives the data through `window.api.onPtyData(...)`.
5. `TerminalPane` runs permission detection, then either writes to xterm or buffers hidden output.
6. If a prompt is detected, renderer calls `agent-permission:show`.
7. Main queues the prompt and shows the native popup.

The key architectural issue is that permission detection currently happens after the authoritative PTY stream has already left main.

### Renderer Detection Today

`src/renderer/src/components/TerminalPane.tsx` detects from:

- Raw PTY chunks.
- xterm rendered buffer after `terminal.write(data, callback)`.
- Delayed follow-up scans.
- A bounded watchdog.

This is good for rendered TUI fallback, but it has gaps:

- Raw chunks can split one permission prompt across multiple events.
- Hidden output can be buffered without becoming a rendered xterm snapshot.
- Detection behavior depends on `isVisible`, `isAltScreen`, `rawTuiMode`, and agent classification timing.
- A prompt can be real and waiting while the renderer has not assembled a parseable snapshot.

### Hidden Output Path

When a pane is hidden and Emu decides not to write immediately, output goes to:

```ts
appendHiddenOutput(data)
```

That buffer exists for later visual replay, not as a permission-detection source of truth. If the single raw chunk scan misses because the prompt was split across chunks, the hidden buffer can contain a pending permission without reliably raising the native popup.

### Main Popup Queue Today

The main process already has the right high-level queue shape:

- `pendingAgentPermissionPrompts`
- `activeAgentPermissionPromptId`
- `recentlyResolvedAgentPermissionPrompts`
- `addAgentPermissionPrompt(...)`
- `showAgentPermissionOverlay(...)`
- `resolveAgentPermissionPrompt(...)`
- `navigateAgentPermissionPrompt(...)`

It dedupes by:

```ts
sessionId + fingerprint
```

This is the right model for multiple permissions:

- Distinct permissions from different sessions should become separate pending entries.
- Distinct permissions from the same session should become separate pending entries if their fingerprints differ.
- Repaints of the same prompt should refresh the existing pending entry, not create duplicates.

The weak point is not the queue shape. The weak point is that prompts only enter the queue if renderer detection catches them.

## Architectural Recommendation

Move the primary permission detector to the main process, directly on PTY output.

Renderer detection should remain as a secondary rendered-screen fallback for cases where raw PTY bytes do not represent final TUI screen state cleanly.

The target architecture is:

```text
PTY output
  -> main process session detector
  -> global permission queue
  -> native popup
  -> renderer output delivery
  -> renderer rendered-buffer fallback detector
  -> same main queue, deduped by session + fingerprint
```

This makes the popup independent of:

- Which tab is visible.
- Which workspace is selected.
- Whether xterm has rendered the latest output.
- Whether a hidden output buffer is replayed.
- Whether multiple sessions emit permission prompts in the same short time window.

## Assumptions

- The native popup should stay global, not per tab.
- One popup window should show a queue when multiple permissions are pending.
- New pending permissions should not steal focus from the currently active pending prompt unless there is no active prompt.
- A new pending permission should still reshow/move the popup to the top and update the count.
- Duplicate repaints should not create duplicate prompt cards.
- Parser confidence should stay high. Prefer better scan coverage over loose keyword detection.
- Approve and Deny semantics should not change unless testing proves current mappings are wrong.

## Non-Goals

- Do not move approval UI into the main Emu window.
- Do not add a setting to disable this.
- Do not create one popup per permission.
- Do not replace provider-specific parsing with broad `allow` or `approve` keyword matching.
- Do not refactor unrelated terminal rendering, command history, or tab management.
- Do not redesign popup visuals, chime behavior, or navigation beyond queue reliability requirements.

## Plan

### 1. Move Permission Parsing Into A Shared Module

Create a shared module for code used by both main and renderer:

```text
src/shared/agentPermissionPrompts.ts
```

Move or extract from `src/renderer/src/agentPermissionPrompts.ts`:

- `AgentPermissionPromptDetector`
- prompt types
- Codex parser
- Claude parser
- terminal text normalization
- provider inference helpers
- test exports

Update imports:

- `TerminalPane.tsx` imports from `src/shared/agentPermissionPrompts`.
- `src/main/index.ts` imports the same parser/detector.
- `scripts/verify-agent-permission-detector.mjs` bundles the shared file.

Update TypeScript config:

- Include `src/shared/**/*` in both `tsconfig.node.json` and `tsconfig.web.json`.

Acceptance criteria:

- No duplicated parser logic.
- Main and renderer use the same fingerprints and action mappings.
- Existing detector fixtures still pass.

### 2. Add Main-Process Session Detector State

Add a main-process map keyed by `sessionId`:

```ts
interface AgentPermissionSessionState {
  detector: AgentPermissionPromptDetector
  provider: AgentPermissionProvider | null
  agentSession: boolean
  rawTail: string
}
```

Use this state before batching output to renderer.

On every `ptyProcess.onData(data)`:

1. Refresh provider from `ptyProcess.process` when it identifies `codex` or `claude`.
2. Append `data` to `rawTail`.
3. Cap `rawTail` to a small fixed size, for example 16-32 KB or 120 normalized lines.
4. Call the shared detector with:

   ```ts
   {
     sessionId,
     provider,
     agentSession
   }
   ```

5. If a prompt is detected, call `addAgentPermissionPrompt(prompt, ownerWindowId)` directly.
6. Continue batching/sending PTY output to renderer as before.

Acceptance criteria:

- Detection runs for every PTY stream even if the tab is hidden.
- Detection runs before renderer visibility or xterm rendering can affect behavior.
- Memory growth is bounded per session.
- Main cleans up detector state on `pty:close` and PTY exit.

### 3. Track Agent Session And Provider In Main

Main currently knows the foreground process through `ptyProcess.process`, but renderer has more agent-session heuristics. Main should get enough state to make permission detection reliable without over-broad parsing.

Provider sources:

- Foreground process name from `ptyProcess.process`.
- User command text observed through `pty:write` and `pty:writeSequence`.
- Provider markers inside PTY output, using the shared parser's provider inference.

Implementation details:

- Add shared helpers equivalent to `isAgentProcessName`, `getAgentProviderFromProcess`, and `getAgentProviderFromCommand`.
- In `pty:write`, inspect user input for `codex` or `claude` launch commands and mark the session as an agent session.
- In `pty:writeSequence`, do the same for each write chunk.
- In `ptyProcess.onData`, refresh provider from foreground process when available.
- If output itself contains a provider marker or a complete Codex/Claude prompt shape, allow detection even if `agentSession` has not been marked yet.

Acceptance criteria:

- The first permission after launching Codex or Claude can be detected before renderer process polling catches up.
- Unknown shell output does not produce popups unless it matches a high-confidence provider prompt.
- Provider state is cleared when the PTY exits or is closed.

### 4. Keep Renderer Detection As Rendered-TUI Fallback

Do not delete renderer detection.

Renderer detection is still valuable because xterm has already resolved:

- Cursor movement.
- Alternate-screen repainting.
- In-place TUI updates.
- Wrapped visual lines.

But renderer detection should become a fallback path:

- It still calls `agent-permission:show`.
- Main still sanitizes and dedupes the prompt.
- If main already queued the same `sessionId + fingerprint`, renderer detection refreshes the pending entry without creating a duplicate.

Update renderer detection to include:

- A rolling raw buffer inside `TerminalPane` as an additional fallback.
- Explicit `raw-buffer` and `hidden-replay` debug sources.
- Hidden replay scans after xterm write callbacks, if practical.

Acceptance criteria:

- Renderer fallback can catch prompts that only become parseable after xterm renders them.
- Renderer fallback cannot create duplicates for prompts main already queued.
- Hidden replay can improve confidence but is not required for the first popup appearance.

### 5. Make Queue Visibility A Hard Main-Process Invariant

Add a helper in `src/main/index.ts`:

```ts
function ensureAgentPermissionOverlayVisible(reason: string, playChime: boolean): void
```

Use it whenever pending prompts exist:

- After a new prompt is queued.
- After a duplicate pending prompt refreshes an existing entry.
- After navigating prompts.
- After resolving a prompt if another prompt remains.
- After overlay state is resent.

Invariant:

> If `pendingAgentPermissionPrompts.some(entry => entry.status === 'pending')` is true, the overlay window should be visible and have the latest state.

Acceptance criteria:

- A pending prompt always implies a visible popup.
- Duplicate prompt refreshes reshow/move the popup to the top.
- If multiple prompts arrive close together, the popup shows a correct count and navigation state.

### 6. Define Multi-Permission Queue Semantics

Multiple permissions can arrive from:

- Two hidden tabs.
- One visible tab and one hidden tab.
- Two different workspaces.
- A visible split pane and an inactive split pane.
- The same session requesting a second distinct permission after the first.

Rules:

- Queue identity remains `sessionId + fingerprint`.
- Same identity: update existing pending prompt, keep original `id` and `createdAt`.
- Different identity: append a new pending prompt.
- If no active prompt exists, make the new prompt active.
- If an active prompt already exists, keep it active and show the new prompt through count/navigation.
- Always reshow/move the popup when any new distinct prompt is added.
- Chime only for new distinct prompts, not duplicate refreshes.

Acceptance criteria:

- Two simultaneous prompts from different sessions appear as `1 of 2` / `2 of 2`.
- A visible-tab prompt and hidden-tab prompt both appear in the same queue.
- Duplicate repaints do not increment the count.
- Approving or denying one prompt advances to another pending prompt if one exists.

### 7. Instrument Every Gate

Extend debug logging behind existing flags:

- Renderer: `localStorage.emu.debugAgentPermission = "1"`
- Main: `EMU_DEBUG_AGENT_PERMISSION=1`

Main logs:

- `main-pty-scan`
- `main-pty-scan-matched`
- `main-session-provider-updated`
- `main-session-agent-marked`
- `ipc-show-received`
- `prompt-queued`
- `prompt-deduped`
- `prompt-suppressed-recently-resolved`
- `overlay-visible-ensured`
- `overlay-shown`

Renderer logs:

- `raw-scan`
- `raw-buffer-scan`
- `write-parsed-scan`
- `hidden-replay-scan`
- `watchdog-scan`
- `prompt-show-ipc-sent`

Each scan log should include:

- `sessionId`
- source
- provider
- `agentSession`
- matched flag
- fingerprint when matched
- summary when matched
- capped text tail

Acceptance criteria:

- A missed popup can be classified as parse miss, queue suppression, or overlay display issue.
- Multiple simultaneous prompts show one log event per queued prompt.

### 8. Review Recently-Resolved Suppression

Current behavior suppresses `sessionId + fingerprint` for `2s` after approve/deny.

Keep it initially because it prevents the same prompt repaint from reopening immediately after a decision.

Add evidence:

- Log the suppression with timestamp, session, provider, and fingerprint.
- During manual testing, verify whether a legitimate second identical permission can occur within `2s`.

Only tune if observed:

- Reduce the window.
- Include a prompt generation counter.
- Suppress only if the PTY receives the approval/denial write successfully.

Acceptance criteria:

- Duplicate repaint after approval does not reopen the popup.
- A legitimately pending prompt is not silently lost without a debug log explaining suppression.

### 9. Tests

Update `scripts/verify-agent-permission-detector.mjs` after moving the parser to shared code.

Detector fixtures:

- Codex prompt parses.
- Claude prompt parses.
- Codex prompt split across chunks emits after accumulated buffer.
- Claude prompt split across chunks emits after accumulated buffer.
- Duplicate repaint emits once.
- Two distinct prompts in one session emit twice.
- False-positive text does not parse.

Main-process queue tests or a focused helper:

- Main detector scans PTY output before renderer delivery.
- Two different sessions queue two prompts.
- Visible and hidden session sources share the same queue.
- Duplicate `sessionId + fingerprint` refreshes existing entry.
- Resolving one of two pending prompts leaves the popup visible.
- Recently-resolved suppression logs and suppresses only the expected identity.

Renderer fallback tests or probes:

- Rendered xterm scan can still call `agent-permission:show`.
- Main dedupe prevents renderer fallback from duplicating a main-detected prompt.

Acceptance criteria:

- The tests cover the "hidden tab still pops" requirement.
- The tests cover the "multiple permissions at the same time" requirement.

### 10. Manual Verification Matrix

Run with debug logging enabled:

```bash
localStorage.emu.debugAgentPermission = "1"
EMU_DEBUG_AGENT_PERMISSION=1
```

Verify:

- Visible Codex permission prompt opens popup.
- Visible Claude permission prompt opens popup.
- Hidden top-tab Codex prompt opens popup without switching tabs.
- Hidden top-tab Claude prompt opens popup without switching tabs.
- Prompt from a non-selected workspace opens popup.
- Prompt in inactive split pane opens popup.
- Prompt while another macOS app is frontmost opens popup.
- One visible-tab prompt plus one hidden-tab prompt queue together.
- Two hidden-tab prompts queue together.
- Two different workspace prompts queue together.
- Duplicate TUI repaint does not increase queue count.
- Approve works for visible-tab prompt.
- Approve works for hidden-tab prompt.
- Deny works for visible-tab prompt.
- Deny works for hidden-tab prompt.
- Resolving one prompt leaves the popup visible when another prompt remains.

## Proposed Implementation Order

1. Move parser/detector code to `src/shared/agentPermissionPrompts.ts`.
2. Update TypeScript configs and existing imports.
3. Add main-process per-session detector state.
4. Scan PTY output in main before batching to renderer.
5. Track provider and agent-session state in main from process names and writes.
6. Strengthen popup visibility invariants.
7. Define and test multi-permission queue semantics.
8. Keep and improve renderer fallback detection.
9. Add debug logging for all gates.
10. Run automated checks and manual matrix.

## Verification Commands

Run after implementation:

```bash
node scripts/verify-agent-permission-detector.mjs
npm exec tsc -- --noEmit
npm run build
git diff --check
```

For manual validation, use the repo's normal dev or preview workflow and ensure only one Emu/Electron instance is under test.

## Risks And Mitigations

- **False positives from scanning every PTY stream.** Keep provider-aware parsing and require high-confidence prompt shapes.
- **Raw PTY text may include stale screen content.** Use bounded per-session buffers, fingerprint dedupe, and renderer rendered-screen fallback.
- **Main cannot perfectly know agent state at launch time.** Infer from writes, foreground process, and provider markers in output.
- **Renderer and main may detect the same prompt.** Deduping by `sessionId + fingerprint` should make this harmless.
- **Multiple prompt arrivals could reorder state.** Node's main process handles events sequentially; preserve insertion order for queue order.
- **Recent-resolved suppression may hide a real repeat.** Instrument first and tune only with evidence.

## Definition Of Done

- Any active Codex or Claude permission prompt in any Emu session causes the native popup to appear.
- Hidden tabs and non-focused workspaces are handled without waiting for the user to switch tabs.
- Multiple pending permissions from any mix of visible and hidden tabs appear in one global popup queue.
- Duplicate prompt repaints do not create duplicate queue entries.
- Approve and Deny work for prompts from visible and hidden sessions.
- Resolving one prompt keeps the popup visible if another prompt remains.
- Automated tests cover split chunks, duplicate suppression, and multi-session queueing.
- Manual validation confirms visible, hidden, split-pane, non-selected workspace, and unfocused-window cases.
