import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import type { Session } from '../App'
import CommandHistoryDrawer, { type HistoryEntry } from './CommandHistoryDrawer'
import '@xterm/xterm/css/xterm.css'
import './TerminalPane.css'

const DEFAULT_FONT_SIZE = 14

// Collapse synchronized-output blocks (ESC[?2026h...ESC[?2026l) used by TUI apps
// (e.g. Claude Code spinner animation). Each block is one rendered frame; we keep
// only the last one (the final state) and discard all intermediate animation frames.
function collapseSyncBlocks(str: string): string {
  const SYNC_RE = /\x1b\[\?2026h([\s\S]*?)\x1b\[\?2026l/g
  const matches = [...str.matchAll(SYNC_RE)]
  if (matches.length <= 1) return str  // 0 or 1 block — nothing to collapse
  // Replace every block except the last with an empty string
  const lastIndex = matches[matches.length - 1].index!
  return str.replace(SYNC_RE, (match, _content, offset) =>
    offset === lastIndex ? match : ''
  )
}

// Strip ANSI escape sequences from a string, including cursor movement and bare CRs.
// Cursor-right sequences are replaced with equivalent spaces so word spacing is
// preserved in TUI app output (e.g. Claude Code streams words with \x1b[NC positioning).
function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\[(\d*)C/g, (_, n) => ' '.repeat(Number(n) || 1)) // cursor-right → spaces
    .replace(/\x1b\[[\x20-\x3f]*[\x40-\x7e]/g, '') // all other CSI sequences (full spec range)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences (window title, etc.)
    .replace(/\x1b[()][AB012]/g, '')              // character set designations
    .replace(/\x1b[@-Z\\-_]/g, '')                // other two-byte escape sequences
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '')    // control chars (keep \n = 0x0a)
    .replace(/\r(?!\n)/g, '\n')                   // bare CR → newline (progress bars)
}

// Remove trailing shell artifacts: zsh partial-line marker (%) and shell prompt lines.
// These are written to the PTY by the shell immediately after a command finishes,
// so they always end up in the output buffer regardless of the idle-timer window.
function trimShellArtifacts(str: string): string {
  const lines = str.split('\n')
  while (lines.length > 0) {
    const last = lines[lines.length - 1].trim()
    if (
      last === '' ||
      last === '%' ||
      last === '$' ||
      /^[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+/.test(last) // username@hostname prompt line
    ) {
      lines.pop()
    } else {
      break
    }
  }
  return lines.join('\n')
}

// Build the next currentInput given incoming data
function applyInput(current: string, data: string): string {
  if (data === '\x7f') return current.slice(0, -1)       // Backspace
  if (data === '\x15' || data === '\x03') return ''       // Ctrl+U / Ctrl+C
  if (data.startsWith('\x1b')) return current             // skip escape seqs
  const printable = data.replace(/[\x00-\x1f\x7f]/g, '') // strip control chars
  return current + printable
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
}

export default function TerminalPane({ session, isVisible, slot = 'full', isActive = true, onActivate, onSessionEnd, openDrawer, onDrawerClose, onClosePane }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const isVisibleRef = useRef(isVisible)
  const isActiveRef = useRef(isActive)

  const currentInputRef = useRef('')
  const waitingForPreviewRef = useRef<string | null>(null)

  // Output buffering — accumulates PTY output between commands for "Copy Output"
  const outputBufferRef = useRef('')
  const currentEntryIdRef = useRef<string | null>(null)
  const outputFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isAltScreenRef = useRef(false)

  const [commandHistory, setCommandHistory] = useState<HistoryEntry[]>([])
  const commandHistoryRef = useRef<HistoryEntry[]>([])
  const promptNavIndexRef = useRef(-1)
  const [showDrawer, setShowDrawer] = useState(false)
  const [fileDropActive, setFileDropActive] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  // Keep isVisibleRef in sync so the key handler can check it
  useEffect(() => { isVisibleRef.current = isVisible }, [isVisible])
  useEffect(() => { isActiveRef.current = isActive }, [isActive])

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

  // Scroll so the prompt line appears near the top with a small buffer above it
  const scrollToPromptLine = (line: number) => {
    terminalRef.current?.scrollToLine(Math.max(0, line - 2))
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

  useEffect(() => {
    if (!containerRef.current) return

    const terminal = new Terminal({
      theme: {
        background: '#1e1e2e',
        foreground: '#cdd6f4',
        cursor: '#f5e0dc',
        cursorAccent: '#1e1e2e',
        selectionBackground: 'rgba(88, 91, 112, 0.5)',
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

    // Flush the accumulated output buffer for the current command entry
    const flushOutputBuffer = () => {
      if (outputFlushTimerRef.current) {
        clearTimeout(outputFlushTimerRef.current)
        outputFlushTimerRef.current = null
      }
      const id = currentEntryIdRef.current
      let raw = outputBufferRef.current
      outputBufferRef.current = ''
      currentEntryIdRef.current = null
      if (!id || !raw.trim()) return
      const MAX_OUTPUT_BYTES = 500_000
      const truncated = raw.length > MAX_OUTPUT_BYTES
      if (truncated) raw = raw.slice(0, MAX_OUTPUT_BYTES)
      const clean = trimShellArtifacts(stripAnsi(collapseSyncBlocks(raw))).trim()
      if (!clean) return
      const outputFull = truncated ? clean + '\n[Output truncated — showing first 500 KB]' : clean
      setCommandHistory(prev =>
        prev.map(e => e.id === id ? { ...e, outputFull } : e)
      )
    }

    const removeDataListener = window.api.onPtyData(session.id, (data) => {
      terminal.write(data)

      // Detect alternate screen (vim, htop, man) — pause output capture to avoid garbage
      if (data.includes('\x1b[?1049h')) {
        isAltScreenRef.current = true
        outputBufferRef.current = ''
        currentEntryIdRef.current = null
        if (outputFlushTimerRef.current) { clearTimeout(outputFlushTimerRef.current); outputFlushTimerRef.current = null }
      }
      if (data.includes('\x1b[?1049l')) {
        isAltScreenRef.current = false
      }

      // Capture first line of output as preview for the most-recent command
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

      // Accumulate full output for "Copy Output" button in Command Log
      if (currentEntryIdRef.current && !isAltScreenRef.current) {
        outputBufferRef.current += data
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
      savedSelStartCol = pos ? pos.startColumn : -1
    })

    terminal.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
      if (ev.type !== 'keydown') return true

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
        return
      }

      savedSelection = ''
      savedSelStartCol = -1

      // Pass data to PTY as-is — bracketed paste markers (\x1b[200~...\x1b[201~)
      // are left intact so zsh buffers all pasted lines and waits for a single
      // Enter, matching standard macOS Terminal behaviour.

      // Track command history — record command on Enter
      if (data === '\r') {
        flushOutputBuffer()  // flush previous command's output immediately
        const cmd = currentInputRef.current.trim()
        currentInputRef.current = ''
        if (cmd) {
          const line = terminal.buffer.active.baseY + terminal.buffer.active.cursorY
          const id = crypto.randomUUID()
          const entry: HistoryEntry = {
            id,
            command: cmd,
            outputPreview: '',
            outputFull: '',
            line,
            timestamp: new Date()
          }
          waitingForPreviewRef.current = id
          currentEntryIdRef.current = id    // start capturing full output
          outputBufferRef.current = ''
          setCommandHistory(prev => [...prev, entry])
        }
      } else {
        currentInputRef.current = applyInput(currentInputRef.current, data)
      }

      window.api.ptyWrite(session.id, data)
    })

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit()
      window.api.ptyResize(session.id, terminal.cols, terminal.rows)
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
      removeDataListener()
      removeExitListener()
      resizeObserver.disconnect()
      containerRef.current?.removeEventListener('dragover', handleDragOver, { capture: true })
      containerRef.current?.removeEventListener('dragleave', handleDragLeave, { capture: true })
      containerRef.current?.removeEventListener('drop', handleDrop, { capture: true })
      terminal.dispose()
      window.api.ptyClose(session.id)
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
