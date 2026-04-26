import { useEffect, useRef, useState } from 'react'
import { Terminal, type IBufferRange, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import type { Session } from '../App'
import CommandHistoryDrawer, { type HistoryEntry } from './CommandHistoryDrawer'
import PromptOptimizerDrawer from './PromptOptimizerDrawer'
import '@xterm/xterm/css/xterm.css'
import './TerminalPane.css'

const DEFAULT_FONT_SIZE = 14

// Strip ANSI escape sequences — used only for the one-line outputPreview capture.
// Full output (outputFull) is read from xterm.js's rendered buffer, not raw bytes.
function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\[[\x20-\x3f]*[\x40-\x7e]/g, '') // CSI sequences (full spec range)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences (window title, etc.)
    .replace(/\x1b[()][AB012]/g, '')              // character set designations
    .replace(/\x1b[@-Z\\-_]/g, '')                // other two-byte escape sequences
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '')    // control chars (keep \n = 0x0a)
    .replace(/\r/g, '')                            // bare CR
}

// Remove TUI chrome from copied output:
//   • Trailing separator lines (lines made entirely of box-drawing chars like ────)
//   • Leading TUI bullet indicator (⏺ ● • ◆ ❯ etc.) on the first content line
// These appear in Claude Code and similar terminal UIs but are not content.
function cleanCopiedOutput(text: string): string {
  const lines = text.split('\n')

  // Strip trailing lines that are blank or purely box-drawing/block-element chars
  // U+2500–U+257F = Box Drawing, U+2580–U+259F = Block Elements
  while (lines.length > 0) {
    const trimmed = lines[lines.length - 1].trim()
    if (trimmed === '' || /^[\u2500-\u259F]+$/.test(trimmed)) {
      lines.pop()
    } else {
      break
    }
  }

  // Strip leading TUI bullet from the first non-empty line
  // Targets: ⏺ (U+23FA) ● (U+25CF) • (U+2022) ◆ (U+25C6) ❯ (U+276F) ▶ ►
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      lines[i] = lines[i].replace(/^[\u23FA\u25CF\u2022\u25C6\u276F\u25B6\u25BA]\s+/, '')
      break
    }
  }

  return lines.join('\n').trim()
}

// Build the next currentInput given incoming data
function applyInput(current: string, data: string): string {
  if (data === '\x7f') return current.slice(0, -1)       // Backspace
  if (data === '\x15' || data === '\x03') return ''       // Ctrl+U / Ctrl+C
  if (data.startsWith('\x1b')) return current             // skip escape seqs
  const printable = data.replace(/[\x00-\x1f\x7f]/g, '') // strip control chars
  return current + printable
}

function rangeTouchesText(
  selection: IBufferRange,
  textStartLine: number,
  textStartCol: number,
  textLength: number,
  cols: number
): boolean {
  if (textStartLine < 0 || textStartCol < 0 || textLength <= 0 || cols <= 0) return false

  const selectionStartLine = selection.start.y - 1
  const selectionEndLine = selection.end.y - 1
  const selectionStartCol = selection.start.x - 1
  const selectionEndCol = selection.end.x - 1

  for (let i = 0; i < textLength; i++) {
    const absoluteCol = textStartCol + i
    const line = textStartLine + Math.floor(absoluteCol / cols)
    const col = absoluteCol % cols
    if (line < selectionStartLine || line > selectionEndLine) continue
    if (selectionStartLine === selectionEndLine) {
      if (col >= selectionStartCol && col < selectionEndCol) return true
    } else if (line === selectionStartLine) {
      if (col >= selectionStartCol) return true
    } else if (line === selectionEndLine) {
      if (col < selectionEndCol) return true
    } else {
      return true
    }
  }

  return false
}

function normalizedSelectionText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

interface Props {
  session: Session
  isVisible: boolean
  slot?: 'full' | 'left' | 'right' | 'hidden'
  isActive?: boolean
  onActivate?: () => void
  onSessionEnd: () => void
  openDrawer?: boolean
  onDrawerClose?: () => void
  onClosePane?: () => void
  onOpenSettings?: () => void
  xtermTheme?: ITheme
}

interface PromptSelection {
  text: string
  position: IBufferRange
  anchor: { x: number; y: number; placement: 'above' | 'below' }
}

export default function TerminalPane({ session, isVisible, slot = 'full', isActive = true, onActivate, onSessionEnd, openDrawer, onDrawerClose, onClosePane, onOpenSettings, xtermTheme }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const isVisibleRef = useRef(isVisible)
  const isActiveRef = useRef(isActive)

  const currentInputRef = useRef('')
  const waitingForPreviewRef = useRef<string | null>(null)

  // Track alternate-screen state (vim, claude code, etc. use \x1b[?1049h / \x1b[?1049l).
  // While in alt-screen, buffer.active refers to the ALTERNATE buffer — its baseY/cursorY
  // are completely different coordinates from the main scrollback.  We still track commands
  // typed inside TUI apps, but we anchor them to the main buffer line where the TUI launched
  // so navigation always ends up at a valid, scrollable position.
  const isAltScreenRef = useRef(false)
  const altScreenEntryLineRef = useRef(-1) // main-buffer line when alt-screen was entered

  // Record the buffer line where the user began typing the CURRENT command — i.e. the moment
  // currentInputRef transitions from empty to non-empty.  This is the start of the prompt line,
  // not the end.  Without this, multi-line commands navigate to the LAST line (where Enter was
  // pressed) instead of the first line, cutting off the beginning of the prompt.
  const promptStartLineRef = useRef(-1)
  const promptStartColRef = useRef(-1)

  // Full output capture — tracks the terminal buffer line range for each command.
  // We read from xterm.js's rendered buffer (not raw PTY bytes) so sync-output
  // animations, cursor movements, and shell prompts are already resolved correctly.
  const currentEntryIdRef = useRef<string | null>(null)
  const currentEntryStartLineRef = useRef<number>(-1)
  const outputFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [commandHistory, setCommandHistory] = useState<HistoryEntry[]>([])
  const commandHistoryRef = useRef<HistoryEntry[]>([])
  const promptNavIndexRef = useRef(-1)
  const [showDrawer, setShowDrawer] = useState(false)
  const [fileDropActive, setFileDropActive] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [isAtBottom, setIsAtBottom] = useState(true)
  const [promptSelection, setPromptSelection] = useState<PromptSelection | null>(null)
  const [capturedPromptSelection, setCapturedPromptSelection] = useState<PromptSelection | null>(null)
  const promptSelectionRef = useRef<PromptSelection | null>(null)

  // Keep isVisibleRef in sync so the key handler can check it
  useEffect(() => { isVisibleRef.current = isVisible }, [isVisible])
  useEffect(() => { isActiveRef.current = isActive }, [isActive])

  useEffect(() => { promptSelectionRef.current = promptSelection }, [promptSelection])

  useEffect(() => {
    if (!isVisible || !isActive) setPromptSelection(null)
  }, [isVisible, isActive])

  // Keep commandHistoryRef in sync so key handlers can read latest history
  useEffect(() => { commandHistoryRef.current = commandHistory }, [commandHistory])

  // Cmd+Shift+L — toggle Command History Drawer
  // Cmd+↑ / Cmd+↓ — jump between prompt positions in scrollback
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!isActiveRef.current) return

      if (e.metaKey && e.shiftKey && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault()
        setShowDrawer(v => !v)
        return
      }

      if (e.metaKey && e.key === 'ArrowUp') {
        e.preventDefault()
        const history = commandHistoryRef.current
        if (history.length === 0) return
        const next = promptNavIndexRef.current <= 0
          ? history.length - 1
          : promptNavIndexRef.current - 1
        promptNavIndexRef.current = next
        scrollToPromptLine(history[next].line)
        return
      }

      if (e.metaKey && e.key === 'ArrowDown') {
        e.preventDefault()
        const history = commandHistoryRef.current
        if (history.length === 0) return
        if (promptNavIndexRef.current < history.length - 1 && promptNavIndexRef.current >= 0) {
          promptNavIndexRef.current++
          scrollToPromptLine(history[promptNavIndexRef.current].line)
        } else {
          promptNavIndexRef.current = -1
          terminalRef.current?.scrollToBottom()
        }
        return
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Sync external openDrawer prop → local state
  useEffect(() => {
    if (openDrawer) setShowDrawer(true)
  }, [openDrawer])

  // Scroll so the prompt line appears at the top of the viewport.
  // We subtract a small offset because interactive apps like Claude Code re-render
  // the conversation after each exchange, placing the user's message 1-3 lines above
  // where the cursor was sitting when they started typing.  The offset ensures the
  // beginning of the command is always the first thing you see.  For plain zsh commands
  // this just shows a couple lines of prior context above the prompt, which is natural.
  const scrollToPromptLine = (line: number) => {
    terminalRef.current?.scrollToLine(Math.max(0, line - 3))
  }

  const handleCloseDrawer = () => {
    setShowDrawer(false)
    onDrawerClose?.()
  }

  const handleCopyOutput = (entryId: string) => {
    const entry = commandHistoryRef.current.find(e => e.id === entryId)
    if (!entry?.outputFull) return
    navigator.clipboard.writeText(entry.outputFull)
    setCopiedId(entryId)
    setTimeout(() => setCopiedId(null), 1800)
  }

  const handleScrollToBottom = () => {
    const viewport = containerRef.current?.querySelector('.xterm-viewport') as HTMLElement | null
    if (!viewport) return

    const DURATION = 300  // ms
    const startTime = performance.now()
    const startPos = viewport.scrollTop

    const step = (now: number) => {
      const elapsed = now - startTime
      const progress = Math.min(elapsed / DURATION, 1)
      // Ease-out cubic — fast start, gentle landing
      const eased = 1 - Math.pow(1 - progress, 3)
      // Recalculate target every frame so new content added mid-scroll is captured
      const target = viewport.scrollHeight - viewport.clientHeight
      viewport.scrollTop = startPos + (target - startPos) * eased

      if (progress < 1) {
        requestAnimationFrame(step)
      } else {
        // Hard snap at the end — guarantees we land exactly at the true bottom
        viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight
        terminalRef.current?.scrollToBottom()
      }
    }

    requestAnimationFrame(step)
  }

  const handleOptimizeSelection = () => {
    if (!promptSelection) return
    setCapturedPromptSelection(promptSelection)
    setPromptSelection(null)
  }

  const handleInsertOptimizedPrompt = (text: string) => {
    const prompt = text.trim()
    if (!prompt) return

    // Selection geometry is display state, not editable terminal state. Once
    // focus moves into the drawer, the reliable way to replace the user's
    // current prompt is to clear the active input line, then bracket-paste the
    // optimized version without pressing Enter.
    const input = `\x05\x15\x1b[200~${prompt}\x1b[201~`
    window.api.ptyWrite(session.id, input)
    currentInputRef.current = prompt
    setCapturedPromptSelection(null)
    window.setTimeout(() => terminalRef.current?.focus(), 0)
  }

  useEffect(() => {
    if (!containerRef.current) return

    const terminal = new Terminal({
      theme: {
        background: '#1e1e2e',
        foreground: '#cdd6f4',
        cursor: '#f5e0dc',
        cursorAccent: '#1e1e2e',
        selectionBackground: 'rgba(255, 214, 10, 0.82)',
        selectionForeground: '#111111',
        black: '#45475a',
        brightBlack: '#585b70',
        red: '#f38ba8',
        brightRed: '#f38ba8',
        green: '#a6e3a1',
        brightGreen: '#a6e3a1',
        yellow: '#f9e2af',
        brightYellow: '#f9e2af',
        blue: '#89b4fa',
        brightBlue: '#89b4fa',
        magenta: '#cba6f7',
        brightMagenta: '#cba6f7',
        cyan: '#89dceb',
        brightCyan: '#89dceb',
        white: '#bac2de',
        brightWhite: '#a6adc8'
      },
      fontFamily: '"JetBrains Mono", "Fira Code", Menlo, Monaco, monospace',
      fontSize: DEFAULT_FONT_SIZE,
      lineHeight: 1.0,
      letterSpacing: 0,
      fontWeight: '400',
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(containerRef.current)
    fitAddon.fit()

    // WebGL renderer — sharper text, GPU-accelerated, especially noticeable on Retina
    try {
      const webglAddon = new WebglAddon()
      webglAddon.onContextLoss(() => webglAddon.dispose())
      terminal.loadAddon(webglAddon)
    } catch {
      // Falls back to canvas renderer silently if WebGL isn't available
    }

    terminal.focus()
    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    const clearPromptSelection = () => {
      if (promptSelectionRef.current) setPromptSelection(null)
    }

    const getSelectionAnchor = (position: IBufferRange): PromptSelection['anchor'] | null => {
      const container = containerRef.current
      const screen = container?.querySelector('.xterm-screen') as HTMLElement | null
      if (!container || !screen || terminal.cols <= 0 || terminal.rows <= 0) return null

      const containerRect = container.getBoundingClientRect()
      const screenRect = screen.getBoundingClientRect()
      const cellWidth = screenRect.width / terminal.cols
      const cellHeight = screenRect.height / terminal.rows
      const viewportY = terminal.buffer.active.viewportY
      const startCol = Math.max(0, position.start.x - 1)
      const startRow = position.start.y - 1
      const visibleRow = startRow - viewportY
      if (visibleRow < 0 || visibleRow >= terminal.rows) return null

      const rawX = screenRect.left - containerRect.left + startCol * cellWidth
      const rawY = screenRect.top - containerRect.top + visibleRow * cellHeight
      const placement = rawY < 42 ? 'below' : 'above'
      return {
        x: Math.min(Math.max(rawX, 8), Math.max(8, containerRect.width - 430)),
        y: Math.min(Math.max(rawY, 8), Math.max(8, containerRect.height - 8)),
        placement
      }
    }

    const updatePromptSelection = () => {
      if (!isVisibleRef.current || !isActiveRef.current) {
        clearPromptSelection()
        return
      }
      const text = terminal.getSelection()
      const position = terminal.getSelectionPosition()
      const selectedUserText = normalizedSelectionText(text)
      if (!position || selectedUserText.length < 1) {
        clearPromptSelection()
        return
      }
      const touchesCurrentInput = rangeTouchesText(
        position,
        promptStartLineRef.current,
        promptStartColRef.current,
        currentInputRef.current.length,
        terminal.cols
      )
      const currentInputContainsSelection = normalizedSelectionText(currentInputRef.current)
        .includes(selectedUserText)
      const touchesHistoricalCommand = commandHistoryRef.current.some((entry) =>
        rangeTouchesText(
          position,
          entry.line,
          entry.commandStartCol ?? 0,
          entry.command.length,
          terminal.cols
        )
      )
      const historicalCommandContainsSelection = commandHistoryRef.current.some((entry) =>
        normalizedSelectionText(entry.command).includes(selectedUserText)
      )
      if (!touchesCurrentInput && !currentInputContainsSelection && !touchesHistoricalCommand && !historicalCommandContainsSelection) {
        clearPromptSelection()
        return
      }
      const anchor = getSelectionAnchor(position)
      if (!anchor) {
        clearPromptSelection()
        return
      }
      setPromptSelection({ text, position, anchor })
    }

    const selectionChangeDisposable = terminal.onSelectionChange(() => {
      window.setTimeout(updatePromptSelection, 0)
    })

    // ── Alternate-screen detection via xterm.js buffer events ────────────────
    // We listen to the authoritative buffer-switch event rather than scanning
    // raw PTY bytes for \x1b[?1049h / \x1b[?1049l.  The byte-scan approach
    // falsely triggers when ANY process echoes those characters as text (e.g.
    // `echo "\x1b[?1049h"` on a zsh that interprets \x escapes), breaking the
    // entire terminal session.  onBufferChange only fires when xterm.js actually
    // switches buffers — immune to text that merely looks like the sequence.
    // Shell process names — login shells on macOS appear with a leading dash
    const SHELL_NAMES = ['zsh', 'bash', 'fish', 'sh', 'dash', 'ksh', 'tcsh',
                         '-zsh', '-bash', '-fish', '-sh']

    terminal.buffer.onBufferChange(async (newBuffer) => {
      clearPromptSelection()
      if (newBuffer.type === 'alternate') {
        isAltScreenRef.current = true
        // Snapshot normal-buffer position — used as the navigation anchor for
        // commands typed inside TUI apps (alt buffer coords are not scrollable).
        altScreenEntryLineRef.current =
          terminal.buffer.normal.baseY + terminal.buffer.normal.cursorY
        currentInputRef.current = ''
        promptStartLineRef.current = -1
        promptStartColRef.current = -1
        if (outputFlushTimerRef.current) {
          clearTimeout(outputFlushTimerRef.current)
          outputFlushTimerRef.current = null
        }

        // Detect accidental alt-screen entry (e.g. echo outputting \x1b[?1049h]).
        // If the foreground PTY process is still the shell, no real TUI launched —
        // force the terminal back to the normal buffer so scrollback stays intact.
        // The check is async (IPC round-trip) but fast; we guard with isAltScreenRef
        // so we don't force-exit if a TUI already exited naturally during the await.
        const proc: string | null = await window.api.ptyGetProcess(session.id)
        const isShellForeground = proc !== null &&
          SHELL_NAMES.some(s => proc.toLowerCase() === s)
        if (isShellForeground && isAltScreenRef.current) {
          // Write the exit sequence directly to the terminal display (not the PTY)
          // to restore the normal buffer without disrupting the running shell.
          terminal.write('\x1b[?1049l')
        }
      } else {
        isAltScreenRef.current = false
        currentInputRef.current = ''
        promptStartLineRef.current = -1
        promptStartColRef.current = -1
        currentEntryIdRef.current = null
        currentEntryStartLineRef.current = -1
        if (outputFlushTimerRef.current) {
          clearTimeout(outputFlushTimerRef.current)
          outputFlushTimerRef.current = null
        }
      }
    })
    // ── End alternate-screen detection ───────────────────────────────────────

    // Track whether the viewport is scrolled to the bottom.
    // Use a native DOM scroll listener on .xterm-viewport rather than terminal.onScroll,
    // because terminal.onScroll only fires on xterm-internal scroll events (new output).
    // Manual user scrolls (trackpad, mouse wheel) after output stops are DOM-only events
    // and would be silently missed by terminal.onScroll.
    const viewportEl = containerRef.current.querySelector('.xterm-viewport') as HTMLElement | null
    const updateScrollState = () => {
      if (!viewportEl) return
      clearPromptSelection()
      // < 10px from bottom counts as "at bottom" to handle sub-pixel rounding
      const distFromBottom = viewportEl.scrollHeight - viewportEl.scrollTop - viewportEl.clientHeight
      setIsAtBottom(distFromBottom < 10)
    }
    viewportEl?.addEventListener('scroll', updateScrollState, { passive: true })

    // ── Scroll wheel override ─────────────────────────────────────────────────
    // xterm.js in alternate-screen mode converts wheel events into cursor-key
    // sequences (↑/↓) instead of scrolling the viewport.  This makes scroll
    // navigate shell history rather than the terminal buffer — the opposite of
    // what every macOS terminal app does.  We intercept all wheel events in the
    // capture phase and drive scrolling ourselves so the viewport always scrolls,
    // regardless of screen mode.
    //
    // In normal mode we write directly to viewportEl.scrollTop (pixel-precise)
    // rather than converting to integer line counts.  This preserves macOS
    // trackpad momentum: late-stage momentum events have tiny deltaY values
    // (e.g. 3 px) that would round to 0 lines and be silently dropped, causing
    // scroll to stop abruptly.  By accumulating sub-line deltas in scrollTop,
    // xterm.js's own scroll listener picks them up and re-renders when a full
    // line boundary is crossed — natural deceleration instead of a hard cutoff.
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const fontSize = terminal.options.fontSize ?? 14
      const lineHeight = terminal.options.lineHeight ?? 1.0
      const pxPerLine = fontSize * lineHeight
      const isAltScreen = terminal.buffer.active.type === 'alternate'
      if (isAltScreen) {
        // Alt-screen (vim, htop, etc.): use integer line scrolls to override
        // xterm.js cursor-key conversion.  No scrollback buffer here anyway.
        // deltaMode 0 = pixels, 1 = lines, 2 = pages
        let lines: number
        if (e.deltaMode === 1) {
          lines = Math.round(e.deltaY)
        } else if (e.deltaMode === 2) {
          lines = e.deltaY > 0 ? terminal.rows : -terminal.rows
        } else {
          lines = Math.round(e.deltaY / pxPerLine)
        }
        if (lines !== 0) terminal.scrollLines(lines)
      } else {
        // Normal mode: pixel-precise scroll — preserves trackpad momentum fully.
        if (!viewportEl) return
        if (e.deltaMode === 0) {
          // Pixels (trackpad) — apply raw delta, momentum events accumulate naturally
          viewportEl.scrollTop += e.deltaY
        } else if (e.deltaMode === 1) {
          // Lines (mouse wheel) — scale by line height for correct step size
          viewportEl.scrollTop += e.deltaY * pxPerLine
        } else {
          // Pages
          viewportEl.scrollTop += e.deltaY > 0 ? viewportEl.clientHeight : -viewportEl.clientHeight
        }
      }
    }
    containerRef.current.addEventListener('wheel', handleWheel, { capture: true, passive: false })
    // ── End scroll wheel override ─────────────────────────────────────────────

    // ── Clickable links ──────────────────────────────────────────────────────

    // 1. Clickable URLs — WebLinksAddon handles detection + edge cases
    const webLinks = new WebLinksAddon((_, url) => window.api.openExternal(url))
    terminal.loadAddon(webLinks)

    // 2a. Clickable bare-domain URLs — nvidia.com, perplexity.com/path, etc.
    //     WebLinksAddon already handles http(s):// URLs; this catches everything else.
    //     TLD filter blocks common file extensions to avoid false positives (main.go, index.ts…)
    //     startX uses m.index + prefix-length instead of the 'd' flag to avoid silent failures.
    const BARE_DOMAIN_RE = /(?:^|[\s"'`(<\[])([a-zA-Z0-9][a-zA-Z0-9-]*(?:\.[a-zA-Z0-9][a-zA-Z0-9-]*)*\.[a-zA-Z]{2,10}(?::[0-9]{1,5})?(?:\/[^\s"'`)\]>]*)?)/g
    const CODE_EXTS = new Set([
      'js','ts','jsx','tsx','mjs','cjs','py','go','rb','rs','java','kt','swift',
      'c','cpp','cc','h','hpp','cs','php','pl','r','sh','bash','zsh','fish',
      'md','txt','json','yaml','yml','toml','xml','html','htm','css','scss',
      'less','svg','png','jpg','jpeg','gif','ico','webp','pdf','zip','tar','gz',
      'bz2','xz','lock','sum','mod','env','cfg','conf','ini','log','sql','db',
      'sqlite','vue','svelte','dart','ex','exs','elm','hs','ml','clj','scala',
      'tf','hcl','proto','wasm','map','d','o','a','so','dylib','dll','exe',
    ])
    terminal.registerLinkProvider({
      provideLinks(lineY, callback) {
        // lineY is 1-based per xterm.js ILinkProvider contract (see OscLinkProvider.ts)
        const line = terminal.buffer.active.getLine(lineY - 1)
        if (!line) return callback([])
        const text = line.translateToString(true)
        const links: Parameters<typeof callback>[0] = []
        for (const m of text.matchAll(BARE_DOMAIN_RE)) {
          const raw = m[1]
          const domain = raw.split('/')[0].split(':')[0]
          const parts = domain.split('.')
          if (parts.length < 2) continue
          const tld = parts.at(-1)!.toLowerCase()
          if (CODE_EXTS.has(tld)) continue
          const startX = m.index! + (m[0].length - raw.length)
          links.push({
            text: raw,
            // Ranges are 1-based x; y is used as-is (already 1-based)
            range: { start: { x: startX + 1, y: lineY }, end: { x: startX + raw.length, y: lineY } },
            decorations: { underline: true, pointerCursor: true },
            activate: () => window.api.openExternal(`https://${raw}`),
          })
        }
        callback(links)
      }
    })

    // 2b. Clickable file paths — /absolute and ./relative, stops at shell terminators
    const FILE_PATH_RE = /(?:^|[\s"'`(])((?:\/|\.{1,2}\/)[^\s"'`)\]>]+)/g
    terminal.registerLinkProvider({
      provideLinks(lineY, callback) {
        // lineY is 1-based per xterm.js ILinkProvider contract (see OscLinkProvider.ts)
        const line = terminal.buffer.active.getLine(lineY - 1)
        if (!line) return callback([])
        const text = line.translateToString(true)
        const links: Parameters<typeof callback>[0] = []
        for (const m of text.matchAll(FILE_PATH_RE)) {
          const path = m[1]
          const startX = m.index! + (m[0].length - path.length)
          links.push({
            text: path,
            range: {
              // Ranges are 1-based x; y is used as-is (already 1-based)
              start: { x: startX + 1, y: lineY },
              end: { x: startX + path.length, y: lineY }
            },
            decorations: { underline: true, pointerCursor: true },
            activate: () => window.api.openPath(path),
          })
        }
        callback(links)
      }
    })

    // ── End clickable links ──────────────────────────────────────────────────

    window.api.ptyCreate(session.id).then(() => {
      // Rotating greeting banners — picks a fresh one each time
      const GREETINGS = [
        "Hi there, let's build something great together!",
        "Hey! The terminal is yours. Go make magic.",
        "Welcome back — ready to ship something amazing?",
        "Good to see you. What are we creating today?",
        "Another tab, another idea waiting to happen.",
        "Hey there, world-builder. Let's get to it.",
        "Fresh tab, fresh start. You've got this.",
        "Hello! Great things start with a single command.",
        "Welcome. The best code you'll ever write starts now.",
        "Hey! Let's turn coffee into code.",
        "A new tab just opened — and so did a new possibility.",
        "Ready when you are. Let's do something remarkable.",
        "Hey there, genius. Time to build.",
        "New session, new possibilities. Let's go.",
        "The world won't change itself — good thing you're here.",
        "Welcome to your workspace. Make it count.",
        "Hey! Every great product started exactly like this.",
        "You showed up. That's already half the battle.",
        "Clean slate, big ideas. What's first?",
        "Hi! The only limit today is your imagination.",
      ]
      const greeting = GREETINGS[Math.floor(Math.random() * GREETINGS.length)]
      terminal.write('\r\n')
      terminal.write('  \x1b[38;2;180;190;254m✦\x1b[0m  ')
      terminal.write(`\x1b[38;2;203;166;247m${greeting}\x1b[0m`)
      terminal.write('\r\n\r\n')
      terminal.focus()
    })

    // Read the terminal's rendered buffer between startLine and the current cursor
    // position to get clean output text. xterm.js has already resolved all in-place
    // updates, cursor movements, and sync-output animation frames — we just read the
    // final screen state, exactly as the user sees it.
    const flushOutputBuffer = () => {
      if (outputFlushTimerRef.current) {
        clearTimeout(outputFlushTimerRef.current)
        outputFlushTimerRef.current = null
      }
      // Never read output while alt-screen is active — buffer.active is the alt buffer
      // and its content would be TUI rendering garbage, not real command output.
      if (isAltScreenRef.current) return
      const id = currentEntryIdRef.current
      const startLine = currentEntryStartLineRef.current
      currentEntryIdRef.current = null
      currentEntryStartLineRef.current = -1
      if (!id || startLine < 0) return

      const buf = terminal.buffer.active
      const endLine = buf.baseY + buf.cursorY  // cursor is sitting at the new prompt

      const lines: string[] = []
      for (let ln = startLine + 1; ln < endLine; ln++) {
        const bufLine = buf.getLine(ln)
        if (bufLine) lines.push(bufLine.translateToString(true).trimEnd())
      }

      // Drop trailing blank lines
      while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()

      const outputFull = cleanCopiedOutput(lines.join('\n'))
      if (!outputFull) return

      setCommandHistory(prev =>
        prev.map(e => e.id === id ? { ...e, outputFull } : e)
      )
    }

    const removeDataListener = window.api.onPtyData(session.id, (data) => {
      terminal.write(data)

      // Capture first line of output as a quick preview for the Command Log entry
      if (waitingForPreviewRef.current) {
        const entryId = waitingForPreviewRef.current
        waitingForPreviewRef.current = null
        const stripped = stripAnsi(data).split('\n').map(l => l.trim()).filter(Boolean)[0] ?? ''
        if (stripped) {
          setCommandHistory(prev =>
            prev.map(e => e.id === entryId ? { ...e, outputPreview: stripped.slice(0, 80) } : e)
          )
        }
      }

      // Arm/re-arm idle timer — when PTY goes quiet for 600ms, read the rendered buffer
      if (currentEntryIdRef.current) {
        if (outputFlushTimerRef.current) clearTimeout(outputFlushTimerRef.current)
        outputFlushTimerRef.current = setTimeout(flushOutputBuffer, 600)
      }
    })

    const removeExitListener = window.api.onPtyExit(session.id, () => {
      terminal.write('\r\n\x1b[2m[Process exited]\x1b[0m\r\n')
      onSessionEnd()
    })

    // Selection tracking for highlight-to-delete
    let savedSelection = ''
    let savedSelStartCol = -1
    containerRef.current.addEventListener('mouseup', () => {
      savedSelection = terminal.getSelection()
      const pos = terminal.getSelectionPosition()
      savedSelStartCol = pos ? pos.start.x - 1 : -1
      window.setTimeout(updatePromptSelection, 0)
    })

    terminal.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
      if (ev.type !== 'keydown') return true
      if (ev.key === 'Escape') clearPromptSelection()

      // Font zoom: Cmd+= / Cmd+- / Cmd+0
      if (ev.metaKey) {
        const zoom = (delta: number) => {
          terminal.options.fontSize = Math.min(Math.max((terminal.options.fontSize ?? DEFAULT_FONT_SIZE) + delta, 8), 32)
          fitAddon.fit()
          window.api.ptyResize(session.id, terminal.cols, terminal.rows)
        }
        if (ev.key === '=' || ev.key === '+' || ev.code === 'Equal') {
          ev.preventDefault(); zoom(+1); return false
        }
        if (ev.key === '-' || ev.code === 'Minus') {
          ev.preventDefault(); zoom(-1); return false
        }
        if (ev.key === '0' || ev.code === 'Digit0') {
          ev.preventDefault()
          terminal.options.fontSize = DEFAULT_FONT_SIZE
          fitAddon.fit()
          window.api.ptyResize(session.id, terminal.cols, terminal.rows)
          return false
        }

      }

      return true // pass everything else through to xterm
    })

    terminal.onData((data) => {
      const BACKSPACE = '\x7f'

      // Highlight-to-delete
      if (data === BACKSPACE && savedSelection.length > 0) {
        const cursorX = terminal.buffer.active.cursorX
        const selLength = savedSelection.length
        const targetCol = savedSelStartCol + selLength
        const rightMoves = Math.max(0, targetCol - cursorX)
        let cmd = ''
        if (rightMoves > 0) cmd += '\x1b[C'.repeat(rightMoves)
        cmd += BACKSPACE.repeat(selLength)
        window.api.ptyWrite(session.id, cmd)
        savedSelection = ''
        savedSelStartCol = -1
        currentInputRef.current = ''
        promptStartLineRef.current = -1
        promptStartColRef.current = -1
        return
      }

      savedSelection = ''
      savedSelStartCol = -1
      clearPromptSelection()

      // Pass data to PTY as-is — bracketed paste markers (\x1b[200~...\x1b[201~)
      // are left intact so zsh buffers all pasted lines and waits for a single
      // Enter, matching standard macOS Terminal behaviour.

      // Track command history — record command on Enter.
      // Commands typed in TUI apps (Claude Code, vim, etc.) are still recorded, but their
      // navigation line is anchored to the main-buffer position where the TUI was launched
      // (altScreenEntryLineRef) rather than the alt-screen cursor, which lives in a separate
      // coordinate space and would produce garbage scroll targets on the main screen.
      if (data === '\r') {
        if (!isAltScreenRef.current) {
          flushOutputBuffer()  // flush previous command's output immediately
        }
        const cmd = currentInputRef.current.trim()
        currentInputRef.current = ''
        if (cmd) {
          // Alt-screen commands anchor to where the TUI launched in the main buffer.
          // Regular commands use promptStartLineRef — the line where the user began typing,
          // which is always the prompt line (first line of the command).  Falling back to
          // the Enter-time cursor position handles the rare case where we missed the first
          // keystroke (e.g. pasted text with no prior keystrokes tracked).
          const line = isAltScreenRef.current
            ? altScreenEntryLineRef.current
            : promptStartLineRef.current >= 0
              ? promptStartLineRef.current
              : terminal.buffer.active.baseY + terminal.buffer.active.cursorY
          const id = crypto.randomUUID()
          const entry: HistoryEntry = {
            id,
            command: cmd,
            outputPreview: '',
            outputFull: '',
            line,
            commandStartCol: promptStartColRef.current >= 0 ? promptStartColRef.current : 0,
            timestamp: new Date()
          }
          if (!isAltScreenRef.current) {
            // Output capture only makes sense for main-screen commands
            waitingForPreviewRef.current = id
            currentEntryIdRef.current = id
            currentEntryStartLineRef.current = line
          }
          promptStartLineRef.current = -1  // reset for next command
          promptStartColRef.current = -1
          setCommandHistory(prev => [...prev, entry])
        }
      } else {
        // Accumulate input on both main screen and alt screen.
        // applyInput already ignores escape sequences (arrow keys etc.) so TUI navigation
        // keystrokes won't corrupt the captured text.
        const wasEmpty = currentInputRef.current === ''
        currentInputRef.current = applyInput(currentInputRef.current, data)
        if (currentInputRef.current === '') {
          promptStartLineRef.current = -1
          promptStartColRef.current = -1
        }
        // Snapshot the buffer line the instant the user types their FIRST character.
        // This is the prompt line — the beginning of the command, not the end.
        // We only do this on the main screen; alt-screen uses altScreenEntryLineRef instead.
        if (!isAltScreenRef.current && wasEmpty && currentInputRef.current !== '') {
          promptStartLineRef.current = terminal.buffer.active.baseY + terminal.buffer.active.cursorY
          promptStartColRef.current = terminal.buffer.active.cursorX
        }
      }

      window.api.ptyWrite(session.id, data)
    })

    // Debounce resize events so that a slot change (which triggers TWO rapid
    // ResizeObserver fires — one for the width change and one for the pane-header
    // appearing and reducing the height) collapses into a single fit + ptyResize.
    // Without debouncing, two back-to-back SIGWINCH signals are sent to zsh, and
    // zsh outputs extra newlines while redrawing the prompt, which appear as
    // spurious blank lines in the terminal content.
    let resizeDebounce: ReturnType<typeof setTimeout> | null = null
    const resizeObserver = new ResizeObserver(() => {
      if (resizeDebounce) clearTimeout(resizeDebounce)
      resizeDebounce = setTimeout(() => {
        resizeDebounce = null
        clearPromptSelection()
        fitAddon.fit()
        window.api.ptyResize(session.id, terminal.cols, terminal.rows)
      }, 50)
    })
    resizeObserver.observe(containerRef.current)

    // File drag-and-drop: paste shell-escaped path(s) into the terminal
    const isFileDrag = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false

    const shellEscape = (path: string): string => {
      if (/^[a-zA-Z0-9._\-/]+$/.test(path)) return path
      return `'${path.replace(/'/g, "'\\''")}'`
    }

    const handleDragOver = (e: DragEvent) => {
      if (!isFileDrag(e)) return
      e.preventDefault()
      e.stopPropagation()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      setFileDropActive(true)
    }
    const handleDragLeave = (e: DragEvent) => {
      if (!isFileDrag(e)) return
      // Only clear if leaving the container entirely
      if (!containerRef.current?.contains(e.relatedTarget as Node)) {
        setFileDropActive(false)
      }
    }
    const handleDrop = (e: DragEvent) => {
      if (!isFileDrag(e)) return
      e.preventDefault()
      e.stopPropagation()
      setFileDropActive(false)
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (files.length === 0) return
      const paths = files
        .map((f) => shellEscape(window.api.getFilePath(f as File)))
        .filter(Boolean)
        .join(' ')
      if (paths) window.api.ptyWrite(session.id, paths)
      terminal.focus()
    }

    // Use capture:true so we fire before xterm's own drag handlers can consume the events
    containerRef.current.addEventListener('dragover', handleDragOver, { capture: true })
    containerRef.current.addEventListener('dragleave', handleDragLeave, { capture: true })
    containerRef.current.addEventListener('drop', handleDrop, { capture: true })

    return () => {
      if (outputFlushTimerRef.current) clearTimeout(outputFlushTimerRef.current)
      if (resizeDebounce) clearTimeout(resizeDebounce)
      selectionChangeDisposable.dispose()
      viewportEl?.removeEventListener('scroll', updateScrollState)
      removeDataListener()
      removeExitListener()
      resizeObserver.disconnect()
      containerRef.current?.removeEventListener('dragover', handleDragOver, { capture: true })
      containerRef.current?.removeEventListener('dragleave', handleDragLeave, { capture: true })
      containerRef.current?.removeEventListener('drop', handleDrop, { capture: true })
      containerRef.current?.removeEventListener('wheel', handleWheel, { capture: true })
      window.api.ptyClose(session.id)
      // Defer terminal disposal to the next tick so it runs after React finishes
      // its commit phase. Disposing the WebGL canvas synchronously during React's
      // commit can interact with Electron's compositor on a transparent window and
      // blank the entire frame. The PTY is already closed above so no output will
      // arrive in the meantime.
      setTimeout(() => { try { terminal.dispose() } catch { /* swallow disposal errors */ } }, 0)
    }
  }, [])

  // Handle Cmd+- forwarded from main process (macOS menu accelerator swallows it otherwise)
  useEffect(() => {
    const remove = window.api.onFontZoom((delta) => {
      if (!terminalRef.current || !fitAddonRef.current) return
      terminalRef.current.options.fontSize = Math.min(
        Math.max((terminalRef.current.options.fontSize ?? DEFAULT_FONT_SIZE) + delta, 8),
        32
      )
      fitAddonRef.current.fit()
      window.api.ptyResize(session.id, terminalRef.current.cols, terminalRef.current.rows)
    })
    return remove
  }, [])

  useEffect(() => {
    if (isVisible && fitAddonRef.current && terminalRef.current) {
      setTimeout(() => {
        fitAddonRef.current?.fit()
        window.api.ptyResize(session.id, terminalRef.current!.cols, terminalRef.current!.rows)
        terminalRef.current?.focus()
      }, 10)
    }
  }, [isVisible])

  // Apply xterm theme whenever the app theme changes
  useEffect(() => {
    if (terminalRef.current && xtermTheme) {
      terminalRef.current.options.theme = xtermTheme
    }
  }, [xtermTheme])

  return (
    <div
      className={`terminal-pane terminal-pane--${slot}${isVisible ? ' terminal-pane--visible' : ''}${isActive ? ' terminal-pane--active' : ''}`}
      onMouseDown={onActivate}
    >
      {(slot === 'left' || slot === 'right') && (
        <div className="pane-header">
          <span className="pane-header-name">{session.name}</span>
          <button
            className="pane-header-close"
            onClick={(e) => { e.stopPropagation(); onClosePane?.() }}
            title="Close pane"
          >✕</button>
        </div>
      )}
      <div ref={containerRef} className="terminal-container" />
      {promptSelection && (
        <button
          className={`prompt-optimize-btn prompt-optimize-btn--${promptSelection.anchor.placement}`}
          style={{
            left: promptSelection.anchor.x,
            top: promptSelection.anchor.y
          }}
          onMouseDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            handleOptimizeSelection()
          }}
          title="Optimize selected prompt"
        >
          Optimize
        </button>
      )}
      {capturedPromptSelection && (
        <PromptOptimizerDrawer
          selectionText={capturedPromptSelection.text}
          onClose={() => setCapturedPromptSelection(null)}
          onOpenSettings={onOpenSettings}
          onInsert={handleInsertOptimizedPrompt}
        />
      )}
      {!isAtBottom && (
        <button className="scroll-to-bottom-btn" onClick={handleScrollToBottom} title="Scroll to bottom">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      )}
      {fileDropActive && (
        <div className="file-drop-overlay">
          <div className="file-drop-badge">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 2L12 16M12 16L8 12M12 16L16 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M4 20H20" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
            Drop to paste path
          </div>
        </div>
      )}
      {showDrawer && (
        <CommandHistoryDrawer
          entries={commandHistory}
          onJump={(line) => scrollToPromptLine(line)}
          onClose={handleCloseDrawer}
          onCopy={handleCopyOutput}
          copiedId={copiedId}
        />
      )}
    </div>
  )
}
