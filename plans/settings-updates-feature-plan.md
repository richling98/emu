# Feature Implementation Plan: Settings "Updates" Section

**Overall Progress:** `100%`

## TLDR

Add an "Updates" tab to the existing Settings modal that shows the installed version (e.g. "Emu v0.3.6"), checks GitHub for a newer release, and — if one exists — shows an "Update" button that downloads it, verifies it, and relaunches Emu into the new version automatically. If already current, it shows "You're on the latest version of Emu!". A silent check also runs once at app launch so a small dot can appear on the Settings icon when an update is already known to be available, without the user needing to open Settings first.

## Critical Decisions

* **Use `electron-updater` (Squirrel.Mac), not a hand-rolled download+open-Finder flow:** This is the standard, signature-verified Electron auto-update mechanism, and it's the only way to make "click Update → app relaunches on the new version" happen with zero manual drag-and-drop. Confirmed via user decision during planning.

* **Add a `zip` build target alongside the existing `dmg` target:** Squirrel.Mac's `autoUpdater` requires a `.zip` of the `.app` to install from — a `.dmg` alone does not work as an update payload (it's mount-only, not a Squirrel-compatible package). The `.dmg` stays as-is for first-time manual downloads from GitHub; the new `.zip` is only consumed by the in-app updater.

* **No GitHub Actions workflow changes needed for publishing.** `package.json`'s `build.publish` is already `[{ "provider": "github", "releaseType": "release" }]` (`package.json:16-21`), and electron-builder auto-publishes to GitHub itself during `npm run dist` whenever it detects CI + a matching tag + `GH_TOKEN` — which is exactly why `latest-mac.yml` already shows up in releases today even though `.github/workflows/release.yml:36-39` only explicitly uploads `dist/*.dmg`. Adding the `zip` target is enough; electron-builder will build it, regenerate `latest-mac.yml` to point at it, and publish all three (dmg, zip, yml) the same way it already does for the dmg.

* **Check timing:** silent check on launch (a few seconds after the main window is created, so it never blocks startup) to drive a small badge dot on the Settings gear icon, **and** a fresh check every time the Updates tab is opened. Confirmed via user decision during planning.

* **Download does not start automatically.** `autoUpdater.autoDownload` is set to `false`. The background/launch check only asks "is there a newer version" (cheap, just reads `latest-mac.yml`); the actual `.zip` download only begins when the user clicks "Update" in the Updates tab. After the download finishes, the app calls `quitAndInstall()` automatically — matching "click Update → it downloads → it relaunches" with exactly one click, not two.

* **Dev builds (`npm run dev`) disable the feature instead of erroring.** `electron-updater` requires `app.isPackaged` to be `true`; in dev mode the Updates tab will show a static "Updates aren't available in development builds" message rather than attempting a real check.

## Tasks

- [x] 🟩 **Step 1: Add the `electron-updater` dependency**
  - [x] 🟩 `npm install electron-updater` — added as a runtime dependency (`electron-updater@^6.8.9`).

- [x] 🟩 **Step 2: Add a `zip` target to the macOS build config**
  - [x] 🟩 `package.json` `mac.target` now builds both `dmg` and `zip` for `arm64`.
  - [x] 🟩 Validated by JSON/config review and a successful `npm run build`; a full `electron-builder` packaging run (dmg+zip) can't complete locally because the `afterSign` hook always calls Apple notarization, which requires the CI-only credentials — this matches the plan's own caveat that real packaging verification happens at the next CI release.

- [x] 🟩 **Step 3: Expose the app version and update-check API from the main process**
  - [x] 🟩 Implemented in `src/main/index.ts`: `autoUpdater` import + `autoDownload = false`, `performUpdateCheck()` / `performUpdateDownload()` / `broadcastUpdateStatus()` helpers, and the `app:getVersion` / `updates:check` / `updates:download` IPC handlers.
  - [x] 🟩 **Deviation from the original wording:** instead of comparing version strings manually, the check is event-driven (`autoUpdater.once('update-available' | 'update-not-available' | 'error', ...)`), which is electron-updater's documented idiom and correctly handles its own semver comparison rather than reinventing it.
  - [x] 🟩 **Deviation:** no separate `'background-check'` status — the launch-time check and the Settings-tab check both resolve to the same `'available' | 'not-available' | 'error'` payload, broadcast on the same `updates:status` channel. Simpler, and both consumers (badge dot, Updates tab) already react to those statuses directly.
  - [x] 🟩 Background check fires 5s after `createWindow()`, gated on `app.isPackaged`.

- [x] 🟩 **Step 4: Expose the new API via preload**
  - [x] 🟩 `getAppVersion`, `checkForUpdates`, `downloadUpdate`, `onUpdateStatus` added to `src/preload/index.ts`.
  - [x] 🟩 `UpdateStatus` union + four `window.api` signatures added to `src/renderer/src/env.d.ts`.

- [x] 🟩 **Step 5: Build the Updates tab UI**
  - [x] 🟩 `'updates'` section added to `SettingsModal.tsx` (type union, nav button, content block) covering all seven status states (`checking`, `not-available`, `available` + Update button, `downloading` + progress bar, `downloaded`, `error` + retry, `unsupported`).
  - [x] 🟩 Styling added to `SettingsModal.css` reusing existing section/typography conventions.

- [x] 🟩 **Step 6: Badge dot on the Settings gear icon**
  - [x] 🟩 `updateAvailable` state + `onUpdateStatus` subscription added to `App.tsx`; dot rendered on the Settings button, styled in `App.css` (`.layout-btn` given `position: relative` to anchor it).

## Edge Cases Covered

| Scenario | Behavior |
|---|---|
| No internet / GitHub unreachable during check | `updates:check` catches the error and returns `{ error: true }`; UI shows "Couldn't check for updates" + retry, never throws |
| User opens Updates tab while the launch-time background check is still running | Tab triggers its own `checkForUpdates()` call regardless; worst case is one harmless duplicate request |
| User clicks "Update" twice quickly | `downloadInFlight` guard in main process ignores the second call |
| Running via `npm run dev` (unpackaged) | `app.isPackaged` is `false` → tab shows the static "not available in development" message, no real network call attempted |
| App was run directly from the mounted `.dmg` instead of `/Applications` | Squirrel.Mac will fail to self-update from a read-only volume; this surfaces through the `error` event/status, shown as the same "Couldn't update automatically" message with a link to the GitHub Releases page as a manual fallback |
| Update available but user closes Settings mid-download | Download continues in the main process; reopening Settings re-subscribes to `onUpdateStatus` and shows current progress (state lives in main, not in the React component) |

## How to Verify

1. `npm run dist` locally after Step 2 and confirm `dist/` contains both the `.dmg` and the new `-mac.zip` + its blockmap, with no build errors. **Not run as-is** — the existing `afterSign` hook unconditionally calls Apple notarization, which needs CI-only credentials, so a full local `electron-builder` packaging run isn't possible on this machine. `npm run build` (the electron-vite compile step) passed cleanly instead.
2. ✅ **Verified live:** built the app, launched it via a throwaway Playwright `_electron` driver (not committed — used only for this check, then removed), clicked Settings → Updates, and confirmed: version reads "Emu v0.3.6", `app.isPackaged` is `false`, the tab shows "Updates aren't available in development builds.", and there were zero page errors. Screenshot matched the existing Appearance/Hotkeys/About tab styling.
3. **Not yet run — requires two real signed CI releases.** Squirrel.Mac validates code-signing continuity, so the actual download → install → relaunch flow can only be exercised once this ships as one release and a second release exists to update into. Recommended next step: cut v0.3.7 with this feature, then v0.3.8, and test updating between them on the installed `/Applications` copy.
4. Same dependency as #3 — needs a real installed build with a newer release on GitHub to confirm the badge dot lights up from the launch-time check.

## Files Touched

- `package.json` — new `electron-updater` dependency, new `zip` mac build target
- `src/main/index.ts` — `autoUpdater` wiring, four new IPC handlers, launch-time background check
- `src/preload/index.ts` — four new exposed API methods
- `src/renderer/src/env.d.ts` — type declarations for the new API surface
- `src/renderer/src/components/SettingsModal.tsx` — new "Updates" tab
- `src/renderer/src/components/SettingsModal.css` — styling for the new tab
- `src/renderer/src/App.tsx` — badge dot on the Settings icon
- `src/renderer/src/App.css` — badge dot styling
