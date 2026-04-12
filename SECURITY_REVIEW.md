# Emu — Pre-Release Security Review

**Reviewer:** Senior Security Engineer (automated audit)
**Date:** 2026-04-10
**Branch:** `canary`
**Scope:** Full codebase — source, build config, CI/CD, dependencies

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 1 |
| High | 3 |
| Medium | 5 |
| Low / Hygiene | 8 |

**Recommendation: Do not ship until Critical and High items are resolved.**

---

## Critical

---

### C-1 — Electron Renderer Sandbox Explicitly Disabled

**File:** [src/main/index.ts:62](src/main/index.ts#L62)

```ts
webPreferences: {
  preload: join(__dirname, '../preload/index.js'),
  sandbox: false   // ← explicitly disabling a key security boundary
}
```

**What it means:** Electron 20+ defaults to `sandbox: true`. Setting it to `false` removes the OS-level process sandbox from the renderer, giving it access to Node.js builtins (`fs`, `child_process`, etc.) even though the app uses `contextBridge`. If the renderer is ever compromised — via a bug in xterm.js, the `ansi-to-html` converter, or any future dependency — the attacker lands in an unsandboxed process with the full power of Node.js on the user's machine.

This is the single most important pre-release fix because it turns every other renderer-side vulnerability from "UI glitch" into "arbitrary code execution."

> **🔵 In plain English — what this means:**
> Think of Emu like a bank building. The terminal window (where you type commands) is the public lobby. The part that actually runs your shell commands is the secure back office. A "sandbox" is like the bulletproof glass partition between the lobby and the back office — even if something bad happens in the lobby, the back office stays safe.
>
> Right now, that bulletproof glass is turned off. That means if any bug or malicious program ever managed to do something sneaky inside the terminal display area, it would have unrestricted access to your entire computer — your files, your network, everything — not just the terminal.
>
> **🔧 How we'll fix it:**
> We change one word in one config file: `sandbox: false` becomes `sandbox: true`. That re-enables the bulletproof glass. The terminal still works exactly the same — commands still run, PTY sessions still open — because the actual shell execution already lives safely in the back-office part of the app and is completely unaffected by this change.
>
> **✅ Outcome:** The terminal display is now properly isolated. A bug in a dependency can no longer reach your filesystem.
>
> **⚙️ Impact on core functionality: None.** Every feature — tabs, split screen, themes, history, file drag-and-drop — continues to work identically.

---

## High

---

### H-1 — `shell.openExternal` Called Without URL Scheme Validation (Two Locations)

**Files:**
- [src/main/index.ts:79-82](src/main/index.ts#L79) — `setWindowOpenHandler`
- [src/main/index.ts:147](src/main/index.ts#L147) — `shell:openExternal` IPC handler

```ts
// Location 1 — opens ANY URL a window.open() call produces
mainWindow.webContents.setWindowOpenHandler((details) => {
  shell.openExternal(details.url)  // ← no validation
  return { action: 'deny' }
})

// Location 2 — opens ANY URL the renderer requests via IPC
ipcMain.handle('shell:openExternal', (_, url: string) => shell.openExternal(url))
```

**What it means:** `shell.openExternal` hands the URL to the OS default handler. Without scheme validation an attacker who can influence the URL (e.g. via a crafted terminal escape sequence that triggers a `window.open()` race, or a compromised renderer) could pass:

- `file:///etc/passwd` → opens in the default text viewer, leaking sensitive file content.
- `javascript:...` → behavior depends on Electron version; historically exploitable.
- Custom URI schemes that trigger other installed apps (e.g. `zoommtg://`, `slack://`).
- Especially dangerous in combination with **C-1** (no renderer sandbox).

The [Electron security docs](https://www.electronjs.org/docs/latest/tutorial/security#15-do-not-use-shellopenwithshell-or-shellopenexternal-with-user-controlled-content) explicitly warn about this pattern.

> **🔵 In plain English — what this means:**
> The app has a helper that opens links in your web browser when you click them in the terminal (e.g. a URL that appears in command output). That helper is like a doorman who opens the door for anyone who shows up — it doesn't check whether the visitor is a website link or something more dangerous.
>
> Right now, if something in the terminal managed to slip in a fake "link" that actually points to a local file on your Mac (like your passwords file, SSH keys, or any private document), the doorman would happily open it in your default app — no questions asked. A crafted terminal program could theoretically exploit this.
>
> **🔧 How we'll fix it:**
> We add a short check in the doorman: before opening anything, look at what type of address it is. If it starts with `https://` or `http://`, open it. Anything else — local file paths, app-launch links, JavaScript — gets silently ignored. Two small functions, ~10 lines of code.
>
> **✅ Outcome:** Clicking a URL in the terminal still opens your browser as expected. Anything that isn't a real web address is blocked before it ever reaches the OS.
>
> **⚙️ Impact on core functionality: None.** Clickable URLs in terminal output (e.g. from `git push`, `npm run dev`, `curl`) still open normally. The only change is that non-web addresses can no longer be opened this way — which was never intentional behavior to begin with.

**Fix:** Add a strict allowlist in the main process before any `openExternal` call:

```ts
function isSafeExternalUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

// In setWindowOpenHandler:
mainWindow.webContents.setWindowOpenHandler((details) => {
  if (isSafeExternalUrl(details.url)) shell.openExternal(details.url)
  return { action: 'deny' }
})

// In IPC handler:
ipcMain.handle('shell:openExternal', (_, url: string) => {
  if (isSafeExternalUrl(url)) return shell.openExternal(url)
})
```

Also audit the `WebLinksAddon` callback in the renderer ([src/renderer/src/components/TerminalPane.tsx:371](src/renderer/src/components/TerminalPane.tsx#L371)) — it calls `window.api.openExternal(url)` with the raw URL from xterm.js link detection. The URL is already scheme-prefixed by the addon (always `http(s)://`), but the main-process allowlist provides defense-in-depth regardless.

---

### H-2 — Overly Broad macOS Entitlement: `allow-unsigned-executable-memory`

**File:** [build/entitlements.mac.plist:8](build/entitlements.mac.plist#L8)

```xml
<key>com.apple.security.cs.allow-unsigned-executable-memory</key>
<true/>
```

**What it means:** This entitlement disables a core Hardened Runtime protection that prevents mapping memory pages as both writable and executable (W^X). Removing this protection makes code-injection attacks significantly easier — an attacker who achieves memory corruption can write shellcode to heap memory and execute it without needing a code-signing bypass.

`com.apple.security.cs.allow-jit` (already in the plist) is specifically designed for V8/JavaScript JIT compilers and is sufficient for Electron's needs. The broader `allow-unsigned-executable-memory` entitlement should not be needed.

> **🔵 In plain English — what this means:**
> When macOS runs a signed app, it enforces a rule: any piece of memory that holds data cannot simultaneously be used to run code. Think of it like a city that says "a building can be a library OR a factory, but never both at the same time." This rule makes it much harder for attackers to sneak in malicious code — they can write bad data into memory all day, but macOS won't let it run.
>
> The entitlement `allow-unsigned-executable-memory` is like getting a city exemption that says "this building can be both a library AND a factory." It's a significant security downgrade. The app already has a narrower, safer exemption (`allow-jit`) that is specifically designed for Electron's JavaScript engine — which probably means the broader one isn't needed at all and was added as a "just in case."
>
> **🔧 How we'll fix it:**
> Delete one line from the entitlements file and run a test build. If the app works fine (very likely), we're done. If something breaks at startup, we investigate exactly which component needs it and find a more targeted solution.
>
> **✅ Outcome:** macOS's memory protection is fully re-enabled for the app, making it significantly harder for a memory-corruption bug to turn into arbitrary code execution.
>
> **⚙️ Impact on core functionality: Very likely none.** The narrower `allow-jit` entitlement covers everything Electron's JavaScript engine needs. This is a test-and-confirm fix — if the app boots and terminals open normally after the change, we're good.

**Fix:**
1. Remove `com.apple.security.cs.allow-unsigned-executable-memory` from `entitlements.mac.plist`.
2. Build and notarize the app. If the build fails or the app crashes at runtime, identify which specific native module requires it and file an upstream issue — the module itself may be the problem, not Electron.
3. If removal is not immediately possible, document exactly which component requires it.

---

### H-3 — Third-Party GitHub Actions Not Pinned to Commit SHAs (Supply Chain Risk)

**Files:**
- [.github/workflows/release.yml:37](.github/workflows/release.yml#L37) — `softprops/action-gh-release@v1`
- [.github/workflows/nodejs.yml:75](.github/workflows/nodejs.yml#L75) — `LabhanshAgrawal/upload-artifact@v3`
- [.github/workflows/nodejs.yml:90](.github/workflows/nodejs.yml#L90) — `GabrielBB/xvfb-action@v1.6`
- [.github/workflows/nodejs.yml:155](.github/workflows/nodejs.yml#L155) — `pguyot/arm-runner-action@v2.5.2`

**What it means:** Pinning to a mutable tag (e.g. `@v1`) means the action author (or an attacker who compromises their account) can push malicious code to that tag at any time. The next CI run then executes that code with access to all repository secrets — including `MAC_CERT_P12_BASE64`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`, and the `GITHUB_TOKEN`. A compromised signing certificate would allow distribution of backdoored builds under your identity.

> **🔵 In plain English — what this means:**
> Your automated build pipeline uses several third-party tools (think of them like subcontractors) to package and publish the app. You've hired them by name — "use tool version 1 from this GitHub account." The problem is that "version 1" is just a label that the tool's author can move to point at completely different code at any moment.
>
> So if any of these subcontractors' GitHub accounts got hacked, or if a subcontractor went rogue, they could silently update what "version 1" means — replacing it with malicious code. The very next time your build pipeline runs (e.g. when you push a new release), that malicious code would run with full access to your Apple developer certificate, your Apple account password, and your GitHub token. That's enough to publish a backdoored version of Emu to users under your own name and signature.
>
> **🔧 How we'll fix it:**
> Instead of hiring the subcontractor by their moving label ("version 1"), we hire them by their exact fingerprint — a specific commit hash like `a9d9f5a`. Even if the label moves, the fingerprint never changes. We look up the exact commit SHA that corresponds to each version tag right now, and hard-code that in the workflow files.
>
> **✅ Outcome:** The build pipeline is locked to specific, known-good versions of each tool. No one can silently swap in malicious code — the SHA either matches or the build fails.
>
> **⚙️ Impact on core functionality: None.** The build pipeline produces exactly the same output. The only change is that the tool versions are now locked rather than floating.

**Fix:** Pin every third-party action to an immutable commit SHA:

```yaml
# Before
- uses: softprops/action-gh-release@v1

# After — get the SHA for the specific tag via: git ls-remote https://github.com/softprops/action-gh-release refs/tags/v1
- uses: softprops/action-gh-release@v0.1.15  # replace with actual SHA
```

Use GitHub's `gh` CLI or a tool like `pin-github-action` to automate this. Only first-party actions (`actions/*`, `github/*`) are safe to reference by tag.

---

## Medium

---

### M-1 — `shell.openPath` Called Without Path Validation

**File:** [src/main/index.ts:150](src/main/index.ts#L150)

```ts
ipcMain.handle('shell:openPath', (_, path: string) => shell.openPath(path))
```

**What it means:** Any string the renderer sends is passed directly to `shell.openPath`, which opens the path in Finder or the default associated app. A compromised renderer (see C-1) could open sensitive files or directories, revealing their existence and contents through OS dialogs.

> **🔵 In plain English — what this means:**
> Emu has a feature where file paths that appear in your terminal output are clickable — click one and it opens in Finder. The code that handles this click takes whatever text was passed to it and opens it, no questions asked.
>
> In the very unlikely scenario that something malicious was running inside the terminal display, it could try to trick this feature into opening sensitive locations on your Mac — like your SSH keys folder, your Keychain file, or system directories — causing them to appear in Finder or open in associated apps, potentially leaking information.
>
> **🔧 How we'll fix it:**
> Add a quick sanity check: the path must look like a real file path (starts with `/`, contains no weird characters). If it doesn't pass that check, ignore it. It's a 4-line addition.
>
> **✅ Outcome:** Clicking file paths in terminal output still works exactly as before. The check only blocks strings that were never valid file paths to begin with.
>
> **⚙️ Impact on core functionality: None.** The clickable file path feature is fully preserved.

**Fix:** Validate that the argument is an absolute filesystem path and not a URL or other dangerous value:

```ts
ipcMain.handle('shell:openPath', (_, path: string) => {
  // Must be an absolute path, not a URL or relative path
  if (typeof path === 'string' && path.startsWith('/') && !path.includes('\0')) {
    return shell.openPath(path)
  }
})
```

---

### M-2 — Missing Explicit `contextIsolation` and `nodeIntegration` in `webPreferences`

**File:** [src/main/index.ts:60-64](src/main/index.ts#L60)

Both `contextIsolation: true` and `nodeIntegration: false` default to safe values in modern Electron, but they are not explicitly set. This creates fragility: a future Electron version change, a library that patches defaults, or a copy-paste of these options into a different context could silently produce an insecure configuration with no visible signal.

> **🔵 In plain English — what this means:**
> Two important security settings exist that are currently switched to their safe position by default — but nobody wrote them down explicitly. It's like a lock that comes from the factory already locked, but you've never actually turned the key yourself. If the factory ever ships a new model where "locked" is no longer the default, your door would be open and you'd have no idea.
>
> **🔧 How we'll fix it:**
> Add those two settings explicitly in the same config block where we fix C-1 — two extra lines of code that make the security posture explicit and obvious to anyone reading the code in the future.
>
> **✅ Outcome:** The settings are the same as before (already safe), but now they're documented and locked in regardless of future framework defaults.
>
> **⚙️ Impact on core functionality: Zero.** This is a documentation/defensive hygiene change. Nothing observable changes for the user.

**Fix:** Always declare security-critical defaults explicitly (already shown in the C-1 fix block above).

---

### M-3 — `unsafe-eval` in Content Security Policy

**File:** [src/renderer/index.html:6](src/renderer/index.html#L6)

```html
<meta http-equiv="Content-Security-Policy" 
  content="default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'" />
```

**What it means:** `'unsafe-eval'` allows `eval()`, `new Function()`, and similar dynamic code execution in the renderer. It is required by xterm.js's WebGL renderer and by V8's JIT compiler when the sandbox is disabled. However, it also disables a key XSS mitigation layer — if any string from terminal output ever reaches a `dangerouslySetInnerHTML` or `eval()` call without sanitization, `unsafe-eval` ensures the injected script executes.

Once C-1 (sandbox) is fixed, the risk surface narrows substantially, but `unsafe-eval` should still be removed if possible.

> **🔵 In plain English — what this means:**
> A Content Security Policy (CSP) is like a rulebook for the terminal's display window. One rule in that book currently says "you're allowed to run code that gets created on-the-fly while the app is running." This is needed because the GPU-accelerated terminal renderer generates some code dynamically. But this same permission, if misused, is how cross-site scripting (XSS) attacks work — an attacker tricks the app into generating and running malicious code.
>
> **🔧 How we'll fix it:**
> We'll test whether removing this permission breaks anything. If the WebGL terminal renderer still works without it (possible in newer versions of xterm.js), we remove the permission entirely. If it still needs it, we document why and accept the tradeoff — it's substantially less risky once C-1 (sandbox) is fixed.
>
> **✅ Outcome:** If removable, the display window can no longer run any dynamically generated code, closing a theoretical XSS path.
>
> **⚙️ Impact on core functionality: Possible, needs testing.** If xterm.js's WebGL renderer requires this permission, removing it would cause a graceful fallback to the canvas renderer — terminal still fully works, just without GPU acceleration. Text would still be crisp and readable, scrolling might be very slightly less buttery on extremely dense output.

---

### M-4 — `dangerouslySetInnerHTML` in Dead Code (Risk if Reactivated)

**File:** [src/renderer/src/components/MessageBubble.tsx:83](src/renderer/src/components/MessageBubble.tsx#L83)

```tsx
<pre className="cmd-output" dangerouslySetInnerHTML={{ __html: html }} />
```

`MessageBubble.tsx` is currently dead code (see L-1 below) and does not render in the app. However, it renders ANSI-converted HTML via `ansi-to-html` with `escapeXML: true`. The `escapeXML` option does escape HTML entities in terminal text, but the generated HTML still includes `<span style="...">` tags for colors, and subtle edge cases in the library could produce unexpected output.

> **🔵 In plain English — what this means:**
> There's an old component left over from an earlier version of Emu that used to display terminal output as styled chat bubbles. This component is no longer connected to anything in the app — it's like a room in the building that's been sealed off. It can't hurt anyone right now.
>
> But it contains a pattern called `dangerouslySetInnerHTML` — React's own way of saying "I'm putting raw HTML directly into the page, which could be dangerous." If someone ever re-opened this sealed room and connected it back to live data without noticing the danger, it could create an XSS vulnerability where terminal output injects malicious scripts into the app.
>
> **🔧 How we'll fix it:**
> Delete the file entirely as part of the dead-code cleanup (see L-1). There's nothing to preserve — it's not used anywhere and the current xterm.js terminal is a much better implementation.
>
> **✅ Outcome:** The risk is eliminated permanently by removing the code, not just papering over it.
>
> **⚙️ Impact on core functionality: Zero.** This code is not connected to any feature that currently works.

---

### M-5 — Outdated Electron Version

**File:** [package.json:69](package.json#L69)

```json
"electron": "^33.2.1"
```

Electron 33 was released in late 2024. As of April 2026, Electron 35+ is current. Older versions accumulate CVEs and may lack security patches for Chromium and Node.js embedded components.

> **🔵 In plain English — what this means:**
> Electron is the underlying engine that powers the entire app — it bundles a web browser (Chromium) and a JavaScript runtime (Node.js) together. Both of those components receive security patches on a regular basis. By being on Electron 33 when Electron 35 is the current version, the app is shipping with an older version of Chromium and Node.js that may have known, publicly disclosed security vulnerabilities.
>
> It's like driving a car that hasn't had its safety recalls applied.
>
> **🔧 How we'll fix it:**
> Update the Electron version in `package.json` to the latest stable release, run the build, and test that all features still work. Electron upgrades between minor versions are usually smooth. A major version jump (33 → 35) may require small API adjustments, but nothing architectural.
>
> **✅ Outcome:** The app ships with the latest security patches for both Chromium and Node.js embedded in it.
>
> **⚙️ Impact on core functionality: Very likely none**, but requires a full test pass after upgrading to confirm. PTY sessions, themes, split screen, and all features should be verified after the upgrade.

---

## Low / Hygiene

---

### L-1 — Dead Code: Four Files and One Dependency Unused

The following files implement a "chat bubble" shell I/O display that was superseded by the direct xterm.js terminal. None of these are imported anywhere in the active application:

| File | Why Dead |
|------|----------|
| [src/renderer/src/hooks/usePtyStream.ts](src/renderer/src/hooks/usePtyStream.ts) | Not imported by any component |
| [src/renderer/src/components/ChatView.tsx](src/renderer/src/components/ChatView.tsx) | Not imported by `App.tsx` or anything else |
| [src/renderer/src/components/MessageBubble.tsx](src/renderer/src/components/MessageBubble.tsx) | Only imported by dead `ChatView.tsx` |
| [src/renderer/src/types.ts](src/renderer/src/types.ts) | `ChatMessage` type only used by dead files above |

The NPM dependency `ansi-to-html` is also dead — it is only used in `MessageBubble.tsx`.

> **🔵 In plain English — what this means:**
> During development, Emu had an earlier design where terminal input and output was displayed as a chat-like conversation (similar to how iMessage shows messages). That design was replaced by the current full xterm.js terminal. However, four source files from the old design were never deleted — they're still sitting in the codebase doing nothing.
>
> Dead code is a security and maintenance problem for three reasons: (1) it confuses anyone reading the code about what the app actually does, (2) it bundles unnecessary code (and a third-party library) into the shipped app, and (3) if a vulnerability is ever found in that dead library (`ansi-to-html`), security scanners will flag the app even though the vulnerable code is never actually called.
>
> **🔧 How we'll fix it:**
> Delete the four source files and remove the `ansi-to-html` entry from `package.json`. Run the build to confirm it still compiles cleanly.
>
> **✅ Outcome:** The codebase only contains code that the app actually uses. Dependency scanners get a clean bill of health. The shipped app bundle is slightly smaller.
>
> **⚙️ Impact on core functionality: Zero.** None of these files are connected to anything the user sees or does.

---

### L-2 — `ptyGetProcess` Missing from `window.api` Type Definition

**File:** [src/renderer/src/env.d.ts](src/renderer/src/env.d.ts)

`TerminalPane.tsx` calls `window.api.ptyGetProcess(session.id)` ([line 306](src/renderer/src/components/TerminalPane.tsx#L306)), but `ptyGetProcess` is not declared in the `Window.api` interface in `env.d.ts`. TypeScript silently accepts this because `@typescript-eslint/no-unsafe-assignment` and similar rules are disabled in the ESLint config, but it means the type system provides no safety net for this call.

> **🔵 In plain English — what this means:**
> The app has a "contract" document (`env.d.ts`) that lists every function the terminal display is allowed to call on the main process. One function that's actually being called — `ptyGetProcess`, which detects whether a TUI app like vim is running — is missing from that contract document.
>
> The app still works because the function really does exist. But TypeScript's safety checker, which would normally catch typos or mismatched arguments, is flying blind for this particular call. If someone later renamed the function or changed its arguments, the code would break at runtime with no warning during development.
>
> **🔧 How we'll fix it:**
> Add one line to `env.d.ts` declaring `ptyGetProcess` with the correct type signature.
>
> **✅ Outcome:** TypeScript now knows about this function and will catch any future mistakes involving it at compile time, before they reach users.
>
> **⚙️ Impact on core functionality: Zero.** The feature already works. This is purely making the type system aware of something it was missing.

---

### L-3 — `nodejs.yml` CI Workflow Is Non-Functional (Cargo-Culted from Another Project)

**File:** [.github/workflows/nodejs.yml](.github/workflows/nodejs.yml)

This workflow contains numerous references that do not match the current codebase:

- Uses `yarn` commands but the project uses `npm` (`package-lock.json` exists, no `yarn.lock`)
- References `yarn.lock` and `app/yarn.lock` (neither exists)
- Runs `yarn run test` and `yarn run test:e2e` (no test scripts in `package.json`)
- References `target/node_modules/node-pty` (no `target/` directory)
- Builds for Linux ARM architectures but the app only targets macOS arm64
- References `canary.ico` and `canary.icns` build icons that don't exist in `build/`

This workflow would fail on every triggered run and is likely copied verbatim from Hyper terminal or a similar project.

> **🔵 In plain English — what this means:**
> GitHub Actions workflows are automated scripts that run when you push code — they're supposed to build the app and check that everything works. The `nodejs.yml` file is one of these scripts, but it was copy-pasted from a completely different terminal app (likely Hyper) and never updated to match Emu. It references folders that don't exist, package managers that aren't being used, test commands that don't exist, and tries to build versions of the app for platforms Emu doesn't target.
>
> If this workflow is triggered (e.g. by a pull request), it will simply fail — which means you get no automatic build verification at all. Worse, it's noise that makes it harder to notice real failures.
>
> **🔧 How we'll fix it:**
> Replace the entire file with a clean, minimal CI workflow that matches what Emu actually uses: check out the code, install dependencies with npm, and run the build. Simple, correct, and fast.
>
> **✅ Outcome:** CI actually works. Pushes and pull requests get real build verification.
>
> **⚙️ Impact on core functionality: None** on the app itself. This only affects the automated build pipeline.

**Fix:** Either delete `nodejs.yml` entirely (the `release.yml` workflow handles actual releases) or replace it with a minimal CI that actually matches this project:

```yaml
name: CI
on:
  push:
    branches: [canary]
  pull_request:
jobs:
  build:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22.x
      - run: npm install
      - run: npm run build
```

---

### L-4 — `dependabot.yml` Monitors a Non-Existent `/app` Directory

**File:** [.github/dependabot.yml:16](.github/dependabot.yml#L16)

```yaml
- package-ecosystem: npm
  directory: "/app"
```

There is no `/app` directory in this repository. Dependabot silently skips invalid directories, meaning this entry does nothing. It was likely copied from the same source project as `nodejs.yml`.

> **🔵 In plain English — what this means:**
> Dependabot is a GitHub bot that automatically checks your dependencies for security vulnerabilities and opens pull requests to update them. It's been told to monitor a folder called `/app` for outdated packages — but that folder doesn't exist in this project. So that monitoring entry silently does nothing.
>
> **🔧 How we'll fix it:**
> Delete the two lines that reference `/app` from the Dependabot config file.
>
> **✅ Outcome:** Dependabot configuration is clean and reflects reality.
>
> **⚙️ Impact on core functionality: None.**

---

### L-5 — ESLint Config References Non-Existent `tsconfig.eslint.json`

**File:** [.eslintrc.json:26](.eslintrc.json#L26)

```json
"project": ["./tsconfig.eslint.json"]
```

This file does not exist. As a result, all `@typescript-eslint/recommended-requiring-type-checking` rules (which catch real bugs) silently fail to run. ESLint still runs basic checks but the type-aware rules are disabled.

> **🔵 In plain English — what this means:**
> ESLint is the code quality checker — it reads the code and flags potential bugs or bad patterns. It's been configured to use a file called `tsconfig.eslint.json` to understand the project's TypeScript types, but that file doesn't exist. As a result, the most powerful category of checks (the ones that understand what type of data each variable holds) are silently skipped every time you run the linter. The linter appears to run fine but is operating at reduced capability.
>
> **🔧 How we'll fix it:**
> Point the ESLint config at the existing `tsconfig.json` instead of the missing file. One line change.
>
> **✅ Outcome:** ESLint runs with full type-aware checking enabled, catching a wider class of bugs during development.
>
> **⚙️ Impact on core functionality: None.** This only affects the developer tooling, not the shipped app.

**Fix:** Either create `tsconfig.eslint.json` (pointing at all source files including test files) or change the reference to `tsconfig.json`:

```json
"project": ["./tsconfig.json"]
```

---

### L-6 — ESLint Config Declares Lodash Rules Without Lodash Dependency

**File:** [.eslintrc.json:103-106](.eslintrc.json#L103)

```json
"lodash/prop-shorthand": ["error", "always"],
"lodash/import-scope": ["error", "method"],
"lodash/collection-return": "error",
"lodash/collection-method-value": "error"
```

Lodash is not in `package.json` and is not used anywhere in the codebase. These rules are dead configuration from the same source project.

> **🔵 In plain English — what this means:**
> Lodash is a JavaScript utility library. The linter config has four rules specifically for enforcing how Lodash should be used — but Lodash isn't installed in this project and isn't used anywhere in the code. These rules do nothing except add confusion and could cause the linter to fail to install if the `eslint-plugin-lodash` package isn't present.
>
> **🔧 How we'll fix it:**
> Remove the four Lodash rule entries and the Lodash plugin reference from the ESLint config.
>
> **✅ Outcome:** Clean linter config with no references to unused tools.
>
> **⚙️ Impact on core functionality: None.**

---

### L-7 — `@fontsource/courier-prime` Potentially Unused

**File:** [src/renderer/src/main.tsx:6-7](src/renderer/src/main.tsx#L6)

```ts
import '@fontsource/courier-prime/400.css'
import '@fontsource/courier-prime/700.css'
```

Courier Prime is imported unconditionally at startup (bundling its font files into the app), but the only `font-family` declaration in the live codebase is `"JetBrains Mono", "Fira Code", Menlo, Monaco, monospace"` (TerminalPane.tsx line 249). No CSS file in the active code references Courier Prime.

Bundled font files add significant weight to the app package (typically 200–400 KB per weight).

> **🔵 In plain English — what this means:**
> Two font files (Courier Prime Regular and Bold) are being loaded and bundled into the app every time it starts up, adding unnecessary weight to the download. No part of the active app actually uses Courier Prime — the terminal uses JetBrains Mono. These imports are likely leftovers from the same old chat-bubble design that became dead code.
>
> **🔧 How we'll fix it:**
> Do a quick search through all CSS files to confirm Courier Prime is truly unused. If confirmed, remove the two import lines from `main.tsx` and remove `@fontsource/courier-prime` from `package.json`.
>
> **✅ Outcome:** The app package is smaller (200–400 KB lighter). Users download and install slightly less data.
>
> **⚙️ Impact on core functionality: None.** The terminal font (JetBrains Mono) is completely unaffected.

---

### L-8 — `.yarnrc` Present But Project Uses npm

**File:** [.yarnrc](.yarnrc)

The project has a `package-lock.json` and uses npm scripts (`npm run dist`). The `.yarnrc` file is leftover from the source project and serves no purpose.

> **🔵 In plain English — what this means:**
> The project uses npm (one package manager) but there's a stale config file for Yarn (a different package manager) sitting in the root of the project. It's like having an old instruction manual for a tool you don't own anymore. It does nothing, but it confuses any developer who looks at the project and wonders which package manager they're supposed to use.
>
> **🔧 How we'll fix it:**
> Delete the `.yarnrc` file.
>
> **✅ Outcome:** No ambiguity about which package manager the project uses.
>
> **⚙️ Impact on core functionality: None.**

---

## Positive Findings

The following were explicitly checked and found to be correct:

- **No hardcoded secrets.** All credentials (Apple ID, code-signing cert, GitHub token) are stored as GitHub Actions secrets and referenced only via `${{ secrets.* }}`.
- **`contextBridge` used correctly.** The preload script properly uses `contextBridge.exposeInMainWorld` and does not expose raw `ipcRenderer` to the renderer.
- **Shell escaping for file drag-and-drop is correct.** The `shellEscape` function in TerminalPane correctly handles single-quote escaping.
- **ANSI stripping in `outputPreview` renders safely.** The stripped preview is rendered as React text content (not `innerHTML`), so no XSS risk there.
- **Session IDs use `crypto.randomUUID()`.** Not guessable, not sequential.
- **PTY sessions cleaned up on exit.** All PTY processes are killed on `window-all-closed`.
- **`setWindowOpenHandler` returns `{ action: 'deny' }`.** New windows are never opened within Electron — this is correct.
- **ZDOTDIR shell integration is written to app userData.** Not to the user's home directory directly; the original `~/.zshrc` is sourced via wrapper, not replaced.
- **CodeQL analysis is configured** and runs on push to `canary` and weekly.
- **Dependabot is configured** for npm and GitHub Actions packages.

---

## Prioritized Fix Order

| # | Issue | Effort | Functional Risk |
|---|-------|--------|-----------------|
| 1 | **C-1** — Enable sandbox | 5 min | None |
| 2 | **H-1** — URL scheme validation | 15 min | None |
| 3 | **H-2** — Remove broad entitlement | 30 min + test | None expected |
| 4 | **H-3** — Pin Actions to SHAs | 30 min | None |
| 5 | **L-1** — Delete dead code + `ansi-to-html` | 5 min | None |
| 6 | **M-1** — Path validation for `openPath` | 10 min | None |
| 7 | **M-2** — Explicit webPreferences | 2 min | None |
| 8 | **L-2** — Add `ptyGetProcess` to type def | 2 min | None |
| 9 | **L-3** — Fix/replace `nodejs.yml` | 20 min | None |
| 10 | **M-5** — Upgrade Electron | variable | Test required |
| 11 | **M-3** — Remove `unsafe-eval` | 30 min + test | Test required |
| 12 | Remaining low/hygiene items | 30 min total | None |
