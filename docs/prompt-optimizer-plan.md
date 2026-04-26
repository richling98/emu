# Prompt Optimizer Implementation Plan

## Current Scope

V1 builds a highlight-to-optimize workflow inside Emu:

1. User highlights text in the terminal.
2. Emu shows a floating `Optimize` button.
3. User clicks it.
4. Emu sends the selected text to a locally configured optimizer LLM provider.
5. Emu shows the optimized result in a right-hand drawer.
6. User can edit, insert, copy, regenerate, or dismiss the optimized prompt.

V1 explicitly does **not** include repo context extraction, cwd tracking, active Claude/Codex session reuse, hidden background agents, hosted accounts, or replace-selection behavior.

The optimizer output should be compatible with both Claude Code and Codex. There is no target-agent selector.

## Completed

### Step 1: Settings Foundation

Implemented a real settings surface opened from the top-right titlebar gear button.

Completed changes:

- Replaced the top-right color-wheel button with a gear settings button.
- Added a settings modal with tabs:
  - `Appearance`
  - `Prompt Optimizer`
  - `About`
- Moved existing theme selection into the `Appearance` tab.
- Added placeholder Prompt Optimizer fields:
  - Provider
  - API Key
  - Model
  - disabled `Test`, `Clear Key`, and `Save` buttons
- Removed the old sidebar gear/About button.
- Moved the existing “Why Emu is better than your Terminal” writeup into the `About` tab.
- Made the settings modal a constant `50vh`.
- Added scrollbars to all settings tabs so content stays accessible when the app window is short.

Files touched:

- `src/renderer/src/App.tsx`
- `src/renderer/src/components/Sidebar.tsx`
- `src/renderer/src/components/SettingsModal.tsx`
- `src/renderer/src/components/SettingsModal.css`
- `src/renderer/src/components/AboutModal.tsx`

Verification:

- `npm run build` passes.

Manual checks already requested:

- Top-right gear opens settings.
- Settings has `Appearance`, `Prompt Optimizer`, and `About`.
- Appearance theme switching still works.
- Prompt Optimizer placeholder fields appear.
- About content scrolls inside settings.
- Settings remains half the app window height and all tabs scroll when short.
- Old sidebar gear/About button is gone.

### Step 2: Secure Optimizer Settings Storage + IPC

Implemented main-process settings storage and safe renderer IPC wiring.

Completed changes:

- Added encrypted Prompt Optimizer settings storage in the main process.
- Uses Electron `safeStorage` when available.
- Stores settings under `app.getPath('userData')`.
- Keeps the API key out of renderer reads.
- Added public settings shape with only:
  - configured state
  - provider
  - model
- Added preload APIs:
  - `optimizerGetSettings`
  - `optimizerSaveSettings`
  - `optimizerClearSettings`
  - `optimizerTestSettings`
  - `optimizerOptimize`
- Wired the Prompt Optimizer settings UI:
  - Save
  - Test
  - Clear Key
  - status messages
  - saved-key placeholder behavior

Files touched:

- `src/main/index.ts`
- `src/preload/index.ts`
- `src/renderer/src/env.d.ts`
- `src/renderer/src/components/SettingsModal.tsx`
- `src/renderer/src/components/SettingsModal.css`

Verification:

- `npm run build` passes.

Notes:

- `optimizerTestSettings` now performs a real OpenAI connection test.
- `optimizerOptimize` is wired to the OpenAI provider adapter.

## Remaining Steps

### Step 3: OpenAI Optimizer Provider Adapter

Goal: implement the first optimizer provider behind a small interface.

Interface:

```ts
interface OptimizerProvider {
  optimize(input: OptimizePromptInput): Promise<OptimizePromptResult>
}
```

Behavior:

- Build the optimizer system prompt.
- Send selected text to OpenAI.
- Prefer structured JSON response.
- Parse fallback text if JSON parsing fails.
- Normalize provider errors.

System prompt requirements:

- Expert prompt engineer for terminal coding agents.
- Optimize for both Claude Code and Codex.
- Do not invent repo details, filenames, commands, libraries, or constraints.
- Improve clarity, scope, acceptance criteria, verification, and final response format.
- Prefer concise, useful prompts over generic long templates.

Acceptance criteria:

- Given selected text, adapter returns an optimized prompt.
- Malformed model output does not crash UI.
- Provider errors surface as user-readable messages.

Status: complete.

Completed changes:

- Added a real OpenAI Responses API call path in the main process.
- Uses Structured Outputs with a JSON schema for:
  - `optimizedPrompt`
- Added a Claude Code + Codex compatible optimizer system prompt.
- Added selected-text normalization and a `20_000` character V1 selection limit.
- Added provider error parsing for OpenAI API errors.
- Added defensive recovery so malformed JSON-like output displays only the `optimizedPrompt` value instead of the raw JSON wrapper.
- Updated optimizer instructions to avoid role/system-prompt preambles like `You are a coding agent`.
- Added request timeout handling.
- Replaced the placeholder `optimizer:optimize` IPC handler with a real OpenAI optimizer call.
- Replaced local-only settings test with a real OpenAI connection test.
- Updated the settings UI success message to `OpenAI connection verified.`

Files touched:

- `src/main/index.ts`
- `src/renderer/src/components/SettingsModal.tsx`

Verification:

- `npm run build` passes.

Manual test notes:

- A valid OpenAI API key is required to test this end to end.
- In Settings → Prompt Optimizer, `Test` should now make a real OpenAI request.
- A bad key/model should show a readable provider error.
- The optimize IPC is implemented, but no terminal selection UI calls it yet. That happens in Step 4-6.

### Step 4: Selection Detection In `TerminalPane`

Goal: reliably detect xterm selected text and compute anchor geometry.

Implementation notes:

- Use `terminal.getSelection()`.
- Use `terminal.getSelectionPosition()`.
- Start with `mouseup` and `keyup`; add `onSelectionChange` if available.
- Compute anchor from xterm cell geometry, not DOM selection range.
- Hide selection UI on scroll, typing, resize, Escape, pane deactivation.
- Preserve existing highlight-to-delete behavior.

Acceptance criteria:

- Selecting text in the active terminal shows a valid selection state.
- Clearing selection hides it.
- Split panes use the correct active pane.
- No regression to highlight-to-delete.

Status: complete.

Completed changes:

- Added `PromptSelection` state to `TerminalPane`.
- Uses `terminal.getSelection()` and `terminal.getSelectionPosition()`.
- Uses `terminal.onSelectionChange` with a mouseup fallback update.
- Computes a pane-relative anchor from xterm screen/cell geometry.
- Gates Optimize visibility to selections that overlap tracked user-entered input/command text.
- Clears selection state on:
  - scroll
  - typing/input
  - resize
  - Escape
  - pane hidden/inactive
  - buffer mode changes
- Preserved highlight-to-delete behavior with the newer `IBufferRange` selection position shape.

Files touched:

- `src/renderer/src/components/TerminalPane.tsx`

Verification:

- `npm run build` passes.

Notes:

- Step 4 is internal state only. There is no visible Optimize button yet.
- Step 5 will render the floating button from this selection state.

### Step 5: Floating Optimize Button

Goal: lightweight entry point from selected text.

Behavior:

- Show only when selected text is meaningful.
- Position near selected text.
- Clamp inside active terminal pane.
- Click captures selected text and opens the optimizer popover.

Acceptance criteria:

- Button appears within roughly 100ms after mouse selection.
- Button disappears when user resumes terminal interaction.
- Button opens popover without writing to the terminal.

Status: complete, except the popover itself is Step 6.

Completed changes:

- Renders a floating `Optimize` button when `PromptSelection` exists.
- Positions the button using the selection anchor from Step 4.
- Supports above/below placement so top-of-pane selections remain visible.
- Clamps horizontal position inside the terminal pane.
- Stops mouse events from leaking through to xterm.
- Click captures the current selection and clears the transient button state.

Files touched:

- `src/renderer/src/components/TerminalPane.tsx`
- `src/renderer/src/components/TerminalPane.css`

Verification:

- `npm run build` passes.

Notes:

- Step 6 will replace the current captured-selection placeholder with the optimizer popover.

### Step 6: Optimizer Drawer

Goal: user can view, edit, insert, copy, regenerate, or dismiss from a right-hand drawer.

States:

- `setupRequired`
- `loading`
- `success`
- `error`

Success UI:

- Editable textarea with optimized prompt.
- Actions:
  - `Insert`
  - `Copy`
  - `Regenerate`
  - close
- Optional collapsed original prompt.

Setup-required UI:

- Tell user to configure Prompt Optimizer in Settings.
- Provide an `Open Settings` action.

Acceptance criteria:

- If no provider is configured, the drawer points the user to settings.
- If configured, optimization starts immediately.
- User can edit the optimized prompt before insert/copy.
- Regenerate repeats the call with the same selected text.

Status: complete.

Completed changes:

- Added `PromptOptimizerDrawer`.
- Added setup-required, checking, loading, success, and error states.
- Calls `optimizerGetSettings` before optimizing.
- Calls `optimizerOptimize` when settings are configured.
- Shows optimized prompt in an editable textarea.
- Supports:
  - Copy
  - Regenerate
  - Dismiss
  - Open Settings when setup is required
  - collapsed original prompt display
- Wires the drawer into `TerminalPane` after clicking the floating `Optimize` button.
- Passes `onOpenSettings` from `App` into `TerminalPane`.
- Replaced the anchored floating popover design with a command-log-style right-hand drawer to avoid viewport cutoff issues.

Files touched:

- `src/renderer/src/App.tsx`
- `src/renderer/src/components/TerminalPane.tsx`
- `src/renderer/src/components/PromptOptimizerDrawer.tsx`
- `src/renderer/src/components/PromptOptimizerDrawer.css`

Verification:

- `npm run build` passes.

Notes:

- The `Insert` button is present but disabled until Step 7 passes a terminal insert handler.

### Step 7: Terminal Insert + Copy

Goal: safely hand off optimized text.

Insert behavior:

```ts
window.api.ptyWrite(session.id, `\x1b[200~${optimizedPrompt}\x1b[201~`)
```

Do not append Enter.

Acceptance criteria:

- Insert pastes multiline prompt into active terminal without executing.
- Copy writes exact edited textarea content.
- Focus returns to terminal after insert/dismiss.

Status: complete.

Completed changes:

- Wired `PromptOptimizerDrawer` `Insert` action to `TerminalPane`.
- Clears the active editable input line with Ctrl+E then Ctrl+U, then inserts the edited optimized prompt via bracketed paste:
  - `\x1b[200~...prompt...\x1b[201~`
- Does not append Enter.
- Closes the optimizer drawer after insert.
- Restores terminal focus after insert.
- Existing Copy action continues to copy the edited textarea content.

Files touched:

- `src/renderer/src/components/TerminalPane.tsx`

Verification:

- `npm run build` passes.

### Step 8: Polish + Error Handling

Handle:

- Missing API key.
- Invalid API key.
- Network failure.
- Quota/rate limit.
- Model not found.
- Selected text too long.
- Empty model response.

Suggested limit:

- Max selected text: `20_000` characters for V1.

Acceptance criteria:

- Common failures produce actionable UI.
- No unhandled promise rejection.
- Popover remains usable after errors.

Status: complete.

Completed changes:

- Added drawer-side validation for empty and too-long selections.
- Added friendly error messages for common OpenAI failures:
  - invalid API key
  - missing model
  - quota/billing issue
  - rate limiting
  - network/timeout
- Normalized common OpenAI errors in the main process.
- Disabled Retry/Regenerate/Copy/Insert while an action is in flight.
- Added a busy guard around Copy and Insert to avoid double-submits.
- Handles empty optimized responses as errors.

Files touched:

- `src/main/index.ts`
- `src/renderer/src/components/PromptOptimizerDrawer.tsx`

Verification:

- `npm run build` passes.

### Step 9: Verification Pass

Manual matrix:

- Single terminal pane.
- Split pane left.
- Split pane right.
- Active prompt selection.
- Scrollback selection.
- Multiline selection.
- No optimizer configured.
- Bad API key.
- Valid API key.
- Insert multiline optimized prompt.
- Copy optimized prompt.
- Regenerate.
- Theme switching still works.
- Highlight-to-delete still works.

Build check:

```bash
npm run build
```

Acceptance criteria:

- Build passes.
- No TypeScript errors.
- No obvious layout overlap at normal and split widths.

Status: automated verification complete; manual UI matrix still needs to be run in the app.

Automated checks completed:

- `npm run build` passes.
- Grep pass found no stale `PromptOptimizerPopover` references.
- Current changed files are scoped to Prompt Optimizer, settings, and docs work.

Manual checks to run:

- Single terminal pane: select prompt text, click `Optimize`, verify drawer opens and optimizes.
- Insert replacement: verify `Insert` clears the original typed prompt and replaces it with the optimized prompt without pressing Enter.
- Copy: edit optimized text, click `Copy`, verify clipboard contains edited text.
- Regenerate: click `Regenerate`, verify the drawer updates and buttons do not double-fire.
- No key configured: clear key, click `Optimize`, verify drawer points to Settings.
- Bad key/model: save invalid settings, verify readable error.
- Split pane left and right: verify `Optimize` appears in the active pane and drawer opens in that pane.
- Multiline prompt: verify optimization, copy, and insert behavior.
- Settings regression: Appearance theme switching, Prompt Optimizer settings, About scroll.
- Existing terminal regression: highlight-to-delete still works.

## Next Step

Continue with **Step 3: OpenAI Optimizer Provider Adapter**.
