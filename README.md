# Emu

**Emu** is a feature-rich terminal emulator designed to be 10x more beautiful and functional than the default macOS terminal. Built on Electron + xterm.js with native GPU rendering, Emu is everything you wished your terminal was.

Learn more on the website: https://richling98.github.io/emu/

---

## Features

### Productivity
- **Split-Screen Mode** — Two terminals side-by-side. Drag the divider to resize, drop any tab into either pane, close individual panes with the ✕ button.
- **Unlimited Tabs** — Spin up as many named tabs as you need. Each gets its own PTY, timestamps, and history. Rename any tab with a double-click.
- **Command Log** — `⌘⇧L` opens a searchable, time-stamped log of every command you've run, with output previews and one-click jump-to.
- **Output Copy Button** — Every entry in the Command Log has a one-click copy button that grabs clean, formatted output — stripping prompts and terminal noise.
- **Jump to Prompt** — `⌘↑` / `⌘↓` jumps through your scrollback history one command at a time.
- **Scroll to Bottom** — A button appears whenever you scroll up in a busy session, letting you jump back to live output in one click.
- **Prompt Spacing** — A blank line automatically appears between each command's output and the next prompt, making dense output easy to scan.
- **Clickable URLs & Domains** — Every URL (`https://`) and bare domain (`nvidia.com`, `perplexity.ai`) is `Cmd+click`able and opens in your browser.
- **Clickable File Paths** — Any `/absolute` or `./relative` path in output is `Cmd+click`able and opens in Finder.
- **Multi-Line Paste** — Paste a block of commands and Emu hands them to your shell as a unit, waiting for a single Enter.
- **Tab Drag & Drop** — Drag any session tab and drop it onto a split pane to reassign it instantly.
- **Highlight-to-Delete** — Select text, press backspace to delete exactly that many characters.
- **Font Zoom** — `⌘+` / `⌘−` to scale font size, `⌘0` to reset.
- **GPU Rendering** — WebGL-accelerated text rendering with full Retina support.
- **Screenshot & File Drop** — Drag any file from Finder into the terminal to paste its shell-escaped path.

### Beauty
- **Color Themes** — 6 hand-tuned themes: Catppuccin, Matrix, Francisco, Haze, Mocha, and Monokai. Switch instantly from the titlebar.
- **Frosted Glass UI** — Vibrancy on the sidebar and titlebar that responds to your desktop in real time.
- **Premium Typography** — JetBrains Mono at pixel-perfect sizing with 1.0 line height and zero letter-spacing.
- **Unfocused Split Dimming** — The inactive pane dims back so your focus is always clear.
- **Smooth Animations** — Every transition is eased and timed so Emu never feels abrupt.
- **Rotating Greetings** — 20+ welcome banners, a fresh one every session.
- **Visual Polish** — Grain overlay, layered shadows, consistent border radii throughout.

---

## Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) 20+
- [npm](https://www.npmjs.com/)

### Install & Run

```bash
git clone https://github.com/richling98/emmy.git
cd emmy
npm install
npm run dev
```

### Build

```bash
npm run build
```

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `⌘T` | New tab |
| `⌘⇧L` | Toggle command log |
| `⌘↑` / `⌘↓` | Jump between prompts in scrollback |
| `⌘+` / `⌘−` | Increase / decrease font size |
| `⌘0` | Reset font size |
| `Cmd+click` | Open URL or file path |

---

## Tech Stack

- [Electron](https://www.electronjs.org/) 33
- [xterm.js](https://xtermjs.org/) 5.5 with WebGL renderer
- [React](https://react.dev/) 18
- [electron-vite](https://electron-vite.org/)
- [node-pty](https://github.com/microsoft/node-pty)
- [Catppuccin Mocha](https://github.com/catppuccin/catppuccin)

---

## License

MIT
