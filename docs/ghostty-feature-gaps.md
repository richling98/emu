# Ghostty Feature Gap Analysis

A comparison of Ghostty vs Emu to identify features worth building.
Research date: 2026-04-20.

---

## Summary

The biggest gaps affecting daily Emu users:

1. **No font choice** — hardcoded JetBrains Mono is a dealbreaker for many devs
2. **No config file** — zero customization beyond 6 built-in themes
3. **Only 2 panes** — Ghostty supports unlimited splits
4. **No Quick Terminal** — Ghostty's menu-bar dropdown is extremely popular
5. **No shell integration** — no prompt detection, click-to-move, or cursor awareness
6. **No inline images** — Kitty protocol is increasingly expected (e.g. Yazi file manager)

---

## Full Feature Gap Table

| Category | Feature | Ghostty | Emu | Notes |
|---|---|---|---|---|
| **Rendering** | Renderer | Native Metal (macOS) / OpenGL (Linux) | xterm.js WebGL | Ghostty's renderer is faster and uses less CPU |
| **Rendering** | Threading | Dedicated read/write/render threads per terminal | Single-threaded JS renderer | Ghostty stays smooth under heavy output |
| **Rendering** | Terminal parser | SIMD-optimized, written in Zig | xterm.js parser (JS) | Matters for `cat`-ing large files, fast build output |
| **Rendering** | Alpha blending | Linear-corrected mode (no text fringing) | Default browser alpha blending | Ghostty text looks cleaner on colored backgrounds |
| **Fonts** | Font selection | Full config: family, bold, italic, fallback chains | Hardcoded JetBrains Mono | Emu users can't change the font at all |
| **Fonts** | Ligatures | Full OpenType feature control (-calt, -liga, etc.) | None | |
| **Fonts** | Variable fonts | Axis control (wght, slnt, etc.) | None | |
| **Fonts** | Grapheme clustering | Correct emoji, skin tones, RTL scripts | Best-effort via xterm.js | |
| **Fonts** | Font thickening | Yes (macOS) | No | |
| **Fonts** | Cell metric adjustments | Baseline, underline, strikethrough, cursor sizes | None | |
| **Fonts** | Synthetic bold/italic | Configurable | No | |
| **Themes** | Built-in themes | Hundreds (Catppuccin, Rose Pine, etc.) | 6 themes | |
| **Themes** | Auto dark/light switching | Yes — different theme per OS mode | No | |
| **Themes** | Custom theme files | Yes | No | |
| **Themes** | 256-color palette control | Full per-index overrides + auto-generation | No | |
| **Background** | Background image | PNG/JPEG with position, fit, repeat, opacity | No | |
| **Background** | Background blur | Configurable intensity | macOS vibrancy only (no control) | |
| **Background** | Per-cell opacity | Optional (for Neovim/tmux compat) | No | |
| **Background** | Transparency | Full opacity control | Basic vibrancy | |
| **Windows** | Multiple windows | Yes | No — single window only | |
| **Windows** | Quick Terminal | Dropdown from menu bar (like Quake/Visor) | No | Major UX win for power users |
| **Tabs** | Tab renaming | Yes | No | |
| **Tabs** | Tab coloring | Yes | No | |
| **Tabs** | Native macOS tabs | Yes (SwiftUI) | Custom sidebar (HTML/CSS) | |
| **Splits** | Number of splits | Unlimited | 2 panes max | |
| **Shell Integration** | Prompt marking | Yes (OSC 133) | No | |
| **Shell Integration** | Cursor changes at prompt | Yes (bar at prompt, block in app) | No | |
| **Shell Integration** | Click-to-move cursor | Yes | No | |
| **Terminal Emulation** | Kitty graphics protocol | Yes — inline images | No | |
| **Terminal Emulation** | Kitty keyboard protocol | Yes | No | |
| **Terminal Emulation** | Synchronized rendering | Yes | No | Screen tearing on fast output |
| **Terminal Emulation** | Light/dark mode notifications | Yes | No | |
| **Terminal Emulation** | xterm compliance | Comprehensive audit vs xterm | xterm.js subset | |
| **macOS Integration** | AppleScript | Full scripting dictionary | No | |
| **macOS Integration** | Apple Shortcuts | AppIntents support | No | |
| **macOS Integration** | Proxy icon | Drag titlebar to access/move files | No | |
| **macOS Integration** | Quick Look | 3-finger tap for definitions | No | |
| **macOS Integration** | Secure keyboard entry | Auto-detects password prompts, lock icon | No | |
| **Cursor** | Cursor style | Block, bar, underline, hollow block | Default only | |
| **Cursor** | Cursor blink | Configurable | No | |
| **Cursor** | Cursor color/opacity | Full control | No | |
| **Selection** | Custom selection colors | Yes | No | |
| **Selection** | Word boundary chars | Configurable | Default only | |
| **Selection** | Clear-on-copy | Optional | Always | |
| **Accessibility** | Minimum contrast ratio | Enforced (WCAG 2.0) | None | |
| **Mouse** | Mouse hide while typing | Yes | No | |
| **Mouse** | Scroll multiplier | Per precision/discrete device | No | |
| **Mouse** | Mouse reporting control | Toggle per-terminal | No | |
| **Config** | User config file | Rich text format, hundreds of options, hot-reload | None | Emu has zero user-facing config |
| **Config** | CLI tools | `+list-fonts`, `+list-themes`, etc. | None | |
| **Platform** | Linux support | Yes (GTK, systemd integration) | No | |
| **Platform** | Auto-update | Yes | Manual DMG download | |

---

## Recommended Build Priority

### Tier 1 — High impact, relatively contained

- **Font picker UI + font config** — unblock users on day 1; xterm.js already supports custom fonts
- **User config file** — even a minimal JSON/TOML settings file would unlock font, theme, opacity
- **More themes** — low effort, high perceived value; hundreds of themes are available as open-source JSON

### Tier 2 — Medium effort, strong differentiation

- **Quick Terminal** — a second always-on-top `BrowserWindow` triggered by a global shortcut
- **Shell integration** — OSC 133 prompt marking enables cursor awareness, click-to-move, semantic zones
- **Tab renaming + coloring** — small UX polish that power users expect
- **Unlimited splits** — requires pane layout engine refactor beyond the current 2-pane split

### Tier 3 — Larger scope / platform-level

- **Kitty graphics protocol** — enables inline images; requires significant xterm.js extension or custom renderer patches
- **Synchronized rendering** — reduces screen tearing on fast output; needs PTY output buffering logic
- **Auto dark/light theme switching** — needs `nativeTheme.on('updated')` in Electron + theme hot-swap
- **Multiple windows** — needs window lifecycle management in main process
- **Auto-update** — Electron has `autoUpdater` built in; needs a release server or GitHub releases integration
