# Top Tab Keyboard Shortcuts Plan

## Goal

Let users switch between the dashboard's top project tabs with browser-style shortcuts:

- `Ctrl+Tab` selects the next top tab to the right.
- `Ctrl+Shift+Tab` selects the previous top tab to the left.

This applies only to the top tab bar inside the selected sidebar workspace, not to the left sidebar workspaces.

## Assumptions

- The shortcut should operate on `selectedSession.tabs`, which are the top tabs shown by `TopTabBar`.
- Tab order should follow the current rendered order in `selectedSession.tabs`.
- The shortcut should wrap around at the ends, matching browser tab behavior.
- The shortcut should be a no-op when there are zero or one top tabs.
- The shortcut should select tabs through the existing `selectTopTab(tabId)` path so timestamps, selected workspace state, and active pane state stay consistent.
- The shortcut should not fire while the user is editing a top-tab name or typing in another focused text control.

## Current Code Context

- `src/renderer/src/App.tsx` owns the selected sidebar workspace, the selected top-tab id, and the `selectTopTab` callback.
- `src/renderer/src/components/TopTabBar.tsx` renders `selectedSession.tabs` in order and calls `onSelect(tab.id)` on click.
- `src/renderer/src/components/TerminalPane.tsx` has its own keyboard handling for terminal-specific shortcuts and xterm key forwarding.
- Other global shortcuts use `window.addEventListener('keydown', handler)` in React effects.

The smallest implementation is to add the top-tab shortcut handler in `App.tsx`, near the other app-level state and callbacks, because it has direct access to `selectedSession`, `selectedTabId`, and `selectTopTab`.

## Implementation Plan

1. Add a small focused helper in `App.tsx` for detecting editable targets.
   - Treat `input`, `textarea`, `select`, and `contenteditable` elements as editable.
   - This prevents `Ctrl+Tab` from interrupting inline rename or future text-entry controls.

2. Add a `useEffect` in `App.tsx` that registers a `keydown` listener on `window`.
   - Match `event.ctrlKey && !event.metaKey && event.key === 'Tab'`.
   - Use `event.shiftKey` to choose direction.
   - Ignore the shortcut if the event target is editable.
   - Ignore the shortcut if the selected workspace has fewer than two top tabs.
   - Call `event.preventDefault()` before selecting the next tab so the browser/Electron shell does not perform a default focus traversal.

3. Compute the next tab from the selected workspace's current tab order.
   - Find the index of `selectedTabId` in `selectedSession.tabs`.
   - If the current id is missing for any reason, start from index `0`.
   - For right navigation, use `(currentIndex + 1) % tabs.length`.
   - For left navigation, use `(currentIndex - 1 + tabs.length) % tabs.length`.
   - Call `selectTopTab(nextTab.id)`.

4. Keep the change scoped to `App.tsx`.
   - No `TopTabBar` API changes should be needed.
   - No CSS changes should be needed.
   - No terminal or PTY changes should be needed unless manual verification shows xterm consumes `Ctrl+Tab` before the window handler sees it.

## Edge Cases

- With a single top tab, `Ctrl+Tab` and `Ctrl+Shift+Tab` should do nothing.
- When the last tab is active, `Ctrl+Tab` should wrap to the first tab.
- When the first tab is active, `Ctrl+Shift+Tab` should wrap to the last tab.
- While renaming a top tab, the shortcut should not switch tabs.
- In split-screen mode, the shortcut should still change the selected workspace's left/top active tab through `selectTopTab`. It should not directly change the right pane assignment.
- The shortcut should not affect sidebar workspace ordering or sidebar selection except through the existing behavior of `selectTopTab` if the tab belongs to a workspace.

## Verification Plan

1. Static/build verification:
   - Run `npm run build`.

2. Manual app verification:
   - Start the app with `npm run dev`.
   - Create at least three top tabs in one sidebar workspace.
   - Press `Ctrl+Tab` repeatedly and confirm selection moves right and wraps from last to first.
   - Press `Ctrl+Shift+Tab` repeatedly and confirm selection moves left and wraps from first to last.
   - Rename a top tab and confirm pressing the shortcut while the rename input is focused does not switch tabs.
   - Confirm the left sidebar workspace selection does not cycle when using the shortcut.
   - In split-screen mode, confirm the shortcut changes the selected top tab without replacing the right pane.

## Risk

The main risk is key-event interception by xterm or Electron. If the app-level `window` listener does not receive `Ctrl+Tab` while the terminal is focused, the fallback is to add a matching `terminal.attachCustomKeyEventHandler` branch in `TerminalPane.tsx` and forward the intent through a new prop. That is broader, so it should only be done if manual verification proves the simple app-level handler is insufficient.
