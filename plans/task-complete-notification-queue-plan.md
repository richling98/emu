# Task-Complete Notification Queue

Add a navigation queue to the task-complete notification overlay so multiple
completed tabs are displayed in a single popup with prev/next navigation,
mirroring the existing permission overlay queue pattern.

---

## Current State

The task-complete overlay is single-shot: when one task finishes, the popup
appears; if another finishes within the 30s debounce window for the same
session, it is silently dropped. Different-session completions would each try
to show/hide the overlay, causing flicker.

```
TerminalPane                 Main Process                Overlay Window
    │                            │                           │
    ├──showTaskComplete(tab)────>│                           │
    │                            ├──debounce check           │
    │                            ├──showOverlay()───────────>│
    │                            │                           │
    │ (30s later, auto-dismiss)  │<────────────────────close │
    │                            │                           │
    ├──showTaskComplete(tab2)───>│                           │
    │                            ├──showOverlay()───────────>│
```

---

## Target State

Multiple completed tabs stack into a queue. The overlay shows one at a time
with `<` / `>` navigation arrows and a "1 of 3" counter. Navigating or
clicking "Visit" advances/removes the entry.

```
TerminalPane                 Main Process                Overlay Window
    │                            │                           │
    ├──showTaskComplete(tab1)───>│                           │
    │                            ├──queue(tab1)              │
    │                            ├──showOverlay()───────────>│  [emu is done!  1 of 1  >]
    │                            │                           │
    ├──showTaskComplete(tab2)───>│                           │
    │                            ├──queue(tab2)              │
    │                            ├──updateState()───────────>│  [emu is done!  1 of 2  < >]
    │                            │                           │
    │  (user clicks  > )         │                           │
    │                            │<── action: next           │
    │                            ├──navigate(next)           │
    │                            ├──updateState()───────────>│  [blog is done!  2 of 2  < >]
    │                            │                           │
    │  (user clicks Visit)       │                           │
    │                            │<── action: visit(id)      │
    │                            ├──remove from queue        │
    │                            ├──navigate(next or close)  │
    │                            ├──send visit to main window│
```

---

## Data Structures

All additions in `src/main/index.ts`:

```typescript
// ── Queue entry (internal) ──────────────────────────────────────────
interface PendingTaskCompleteNotification {
  id: string
  sessionId: string
  tabName: string
  workspaceName: string
  status: 'pending' | 'resolved'
  createdAt: number
}

// ── What we send to the overlay ─────────────────────────────────────
interface TaskCompleteOverlayNotification {
  id: string
  sessionId: string
  tabName: string
  workspaceName: string
}

interface TaskCompleteOverlayState {
  notifications: TaskCompleteOverlayNotification[]
  activeNotificationId: string | null
}

// ── Actions the overlay can send back ───────────────────────────────
type TaskCompleteOverlayAction =
  | { type: 'previous' | 'next' }
  | { type: 'visit'; notificationId: string }
```

---

## Module-Level State

Add alongside existing `taskCompleteOverlayWindow`:

```typescript
const pendingTaskCompleteNotifications: PendingTaskCompleteNotification[] = []
let activeTaskCompleteNotificationId: string | null = null
```

---

## New Functions (in `src/main/index.ts`)

All modeled after their `agent-permission` counterparts:

### `serializeTaskCompleteState(): TaskCompleteOverlayState`

Filters `pending` entries, maps to overlay-safe shape, returns `{
notifications, activeNotificationId }`.

### `getActiveTaskCompleteNotification(): PendingTaskCompleteNotification | null`

Finds the entry matching `activeTaskCompleteNotificationId` with status
`'pending'`. Returns `null` if none.

### `pruneResolvedTaskCompleteNotifications(): void`

Removes entries with status `'resolved'` from the array.

### `addTaskCompleteNotification(sessionId, tabName, workspaceName): void`

1. Check debounce (existing `taskCompleteDebounceTimestamps` — per sessionId)
2. Generate unique `id`
3. Push `{ id, sessionId, tabName, workspaceName, status: 'pending',
   createdAt }` to `pendingTaskCompleteNotifications`
4. If no active notification, set `activeTaskCompleteNotificationId = id`
5. Call `ensureTaskCompleteOverlayVisible()` (new function below)

### `navigateTaskCompleteNotification(direction: 'previous' | 'next'): void`

1. Filter `pending` entries
2. Find current index by `activeTaskCompleteNotificationId`
3. Calculate next index (wrap around)
4. Set `activeTaskCompleteNotificationId = next.id`
5. Call `sendTaskCompleteState()` + `ensureTaskCompleteOverlayVisible()`

### `resolveTaskCompleteNotification(notificationId: string): void`

1. Find the notification, set `status = 'resolved'`
2. Auto-advance to next pending (or null)
3. `pruneResolved()` + `closeIfEmpty()` + `sendState()`

### `sendTaskCompleteState(): void`

Sends `serializeTaskCompleteState()` to the overlay via
`task-complete:state` IPC channel.

### `closeTaskCompleteOverlayIfEmpty(): void`

If no `pending` entries remain, close the overlay window.

### `ensureTaskCompleteOverlayVisible(playChime: boolean): void`

If the overlay is not visible, shows it; if it is visible, just updates
state. This replaces the old `showTaskCompleteOverlay()` for the queue
flow. The chime is only played when a *new* notification arrives
(`playChime = true`), not on navigation.

---

## Modified Functions

### `showTaskCompleteOverlay()` → replaced

Instead of taking a single `{ tabName, sessionId, workspaceName }`, it now
takes no data argument. It simply:
1. Ensures the overlay window exists
2. Positions it
3. Sends current queue state
4. Shows the window (if not visible)
5. Sets auto-dismiss timer

### IPC handler `task-complete:show`

Replaces `showTaskCompleteOverlay()` call with
`addTaskCompleteNotification()`.

### IPC handler `task-complete:visit`

Now resolves the notification via
`resolveTaskCompleteNotification(notificationId)` instead of closing the
overlay directly.

### Auto-dismiss (per-notification, auto-advance)

A single auto-dismiss timer (8s) cycles through the queue:

1. When the overlay appears, the 8s timer starts
2. User interaction (navigation click, visit click) or a new notification
   arriving **resets** the timer
3. When the timer fires, the **current** notification is removed from the
   queue (status = `'auto-dismissed'`)
4. If more notifications remain, auto-advance to the next and show it (timer
   restarts)
5. If the queue is empty, close the overlay

This matches macOS notification stacking: each notification gets ~8s of
attention before auto-advancing, preventing the queue from blocking
indefinitely.

---

## New IPC Handler

```typescript
ipcMain.handle('task-complete:action', (_, action: TaskCompleteOverlayAction) => {
  if (action.type === 'previous' || action.type === 'next') {
    navigateTaskCompleteNotification(action.type)
  } else if (action.type === 'visit') {
    resolveTaskCompleteNotification(action.notificationId)
    // Also send visit to main window (existing logic)
    const mainWindow = getMainWindow()
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
      mainWindow.webContents.send('task-complete:visit', sessionId)
    }
  }
})
```

---

## Preload Bridge (`src/preload/index.ts`)

Add:

```typescript
taskCompleteOverlayAction: (action: { type: string; notificationId?: string }) =>
  ipcRenderer.invoke('task-complete:action', action),
```

---

## Type Declarations (`src/renderer/src/env.d.ts`)

Add:

```typescript
taskCompleteOverlayAction: (action: TaskCompleteOverlayAction) => Promise<void>
```

And update the `onTaskCompleteOverlayState` callback type to receive the new
state shape.

---

## Overlay HTML Changes (`buildTaskCompleteOverlayHtml`)

The overlay `<script>` gains:

1. **State variable**: `let state = { notifications: [], activeNotificationId:
   null }`

2. **Helper functions** (same pattern as permission overlay):
   - `activeIndex()` — find current notification index in array
   - `activeNotification()` — get current notification object
   - `render()` — update DOM based on current state

3. **Navigation UI** — conditionally show `<` / `>` buttons + "N of M" count
   when `notifications.length > 1`. Sent as action to main process.

4. **State listener** — `window.api.onTaskCompleteOverlayState(nextState => { state = nextState; render() })`

5. **Visit button click** — calls `window.api.taskCompleteOverlayAction({ type: 'visit', notificationId })`

6. **Navigation button clicks** — calls `window.api.taskCompleteOverlayAction({ type: 'previous' })` / `'next'`

### HTML Structure

```html
<section class="overlay">
  <div class="header">
    <div class="message" id="message">emu is done!</div>
    <div class="queue" id="queue">
      <span class="count" id="count"></span>
      <button class="icon" id="previous">&lt;</button>
      <button class="icon" id="next">&gt;</button>
    </div>
  </div>
  <button class="visit-btn" id="visitBtn">Visit</button>
</section>
```

The header row puts the message on the left and the queue controls on the
right — matching the permission overlay layout.

### CSS Additions

Add `.header` (flex row), `.queue` (flex, no-drag), `.count` (small muted
text), and `.icon` (square button with border, same as permission overlay's
`.icon`).

---

## Data Flow Diagram

```
                          Main Process
                     ┌──────────────────────┐
                     │  taskCompleteDebounce │
                     │  Timestamps (Map)     │
                     │        │              │
  TerminalPane       │        v              │        Overlay Window
    showTaskComplete │  addTaskComplete()    │        ┌──────────────┐
    ────────────────>│    ├─ debounce check  │        │  onOverlay   │
                     │    ├─ push to queue   │        │  State       │
                     │    ├─ ensureVisible() │───────>│  ──render()  │
                     │    │     │            │        │              │
                     │    │     │            │        │  prev/next   │
                     │    │     │            │<───────│  click       │
                     │    │     v            │        │              │
                     │    │  navigate()      │        │  visit click │
                     │    │  ──set active    │        └──────┬───────┘
                     │    │  ──send state    │────────>      │
                     │    │                  │               │
                     │    │  resolve()       │        ┌──────┴───────┐
                     │    │  ──mark resolved │        │ Main Window  │
                     │    │  ──auto-advance  │        │ (renderer)   │
                     │    │  ──closeIfEmpty  │        │  focus tab   │
                     │    └──────────────────┼────────>│              │
                     └──────────────────────┘        └──────────────┘
```

---

## Files Changed

| File | Changes |
|------|---------|
| `src/main/index.ts` | ~80 new lines: queue state + 8 functions + modified IPC handler + new `task-complete:action` handler |
| `src/preload/index.ts` | +3 lines: `taskCompleteOverlayAction` bridge |
| `src/renderer/src/env.d.ts` | +1 type + update state type signature |
| `buildTaskCompleteOverlayHtml()` (inline in main/index.ts) | Restructure HTML + rewrite script with queue render loop |

No changes to:
- `TerminalPane.tsx` — data payload is already correct
- `App.tsx` — visit handler already works

---

## Edge Cases

1. **Last item visited** → Remove from queue, close overlay
2. **Multiple items arrive while overlay is visible** → Push to queue, update
   state (no chime repeat for items after the first in the same batch — the
   chime plays for the first queued item only)
3. **Navigate past the end** → Wrap around (circular), like permission overlay
4. **Debounce still applies** per sessionId — same task completing again within
   30s is dropped
5. **Overlay auto-dismissed while items remain** → next `addTaskComplete()` just
   shows the overlay again with the remaining queue
6. **Window closed by user** → `closed` event sets `taskCompleteOverlayWindow =
   null`; queue persists in memory; next `addTaskComplete()` creates a fresh
   window

---

## Open Questions

1. Should the chime play for **every** new item added to the queue, or only
   the **first**?  (permission overlay plays chime for each new prompt)
2. Should clicking "Visit" also auto-advance to the next notification, or
   just close the overlay?
3. When the queue is empty after a Visit, should the overlay close
   immediately or show a brief "all done" state?
