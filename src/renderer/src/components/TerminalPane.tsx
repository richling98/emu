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

// Strip ANSI escape sequences from a string
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '')
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
}

export default function TerminalPane({ session, isVisible, slot = 'full', isActive = true, onActivate, onSessionEnd, openDrawer, onDrawerClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const isVisibleRef = useRef(isVisible)
  const isActiveRef = useRef(isActive)

  const currentInputRef = useRef('')
  const waitingForPreviewRef = useRef<string | null>(null)

  const [commandHistory, setCommandHistory] = useState<HistoryEntry[]>([])
  const commandHistoryRef = useRef<HistoryEntry[]>([])
  const promptNavIndexRef = useRef(-1)
  const [showDrawer, setShowDrawer] = useState(false)
  const [fileDropActive, setFileDropActive] = useState(false)

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

  useEffect(() => {
    if (!containerRef.current) return

    const terminal = new Terminal({
      allowProposedApi: true,
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

    // ── Semantic output coloring ────────────────────────────────────────────

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

    // 3. Error / warning / success keyword decorations
    //    Only the matching keyword cells are colored — not the whole line.
    //    backgroundColor renders via the WebGL/canvas pipeline directly (no DOM needed).
    //    'g' flag required for String.matchAll().
    const LINE_PATTERNS = [
      { re: /\b(error|Error|ERROR|fatal|Fatal|FATAL|failed|Failed|FAILED|exception|Exception)\b/g,
        backgroundColor: '#4a1c1c' },
      { re: /\b(warning|Warning|WARNING|warn|WARN|deprecated|Deprecated)\b/g,
        backgroundColor: '#4a3c10' },
      { re: /\b(success|Success|SUCCESS|done|Done|DONE|installed|completed|Completed|passed|Passed|✓|✔)\b/g,
        backgroundColor: '#1c4a24' },
    ]

    let prevAbsLine = 0
    // Track the range of buffer lines the user typed on so we can exclude them
    // from decoration. Handles single keys and multi-line paste correctly.
    let inputRangeStart = -1
    let inputRangeEnd = -1

    terminal.onWriteParsed(() => {
      const newAbsLine = terminal.buffer.active.baseY + terminal.buffer.active.cursorY
      const start = prevAbsLine
      prevAbsLine = newAbsLine

      for (let absLine = start; absLine <= newAbsLine; absLine++) {
        // Skip lines the user was typing on — we decorate output only
        if (inputRangeStart >= 0 && absLine >= inputRangeStart && absLine <= inputRangeEnd) continue

        const bufLine = terminal.buffer.active.getLine(absLine)
        if (!bufLine) continue
        const text = bufLine.translateToString(true).trimEnd()
        if (!text) continue

        // One marker per line (created lazily on first keyword match)
        let marker: ReturnType<typeof terminal.registerMarker> | undefined
        for (const pattern of LINE_PATTERNS) {
          const matches = [...text.matchAll(pattern.re)]
          if (matches.length === 0) continue

          if (!marker) {
            marker = terminal.registerMarker(absLine - newAbsLine)
            if (!marker) break
          }
          for (const m of matches) {
            terminal.registerDecoration({
              marker,
              x: m.index!,
              width: m[0].length,
              height: 1,
              backgroundColor: pattern.backgroundColor,
              layer: 'bottom',
            })
          }
        }

      }
    })

    // ── End semantic output coloring ────────────────────────────────────────

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

    const removeDataListener = window.api.onPtyData(session.id, (data) => {
      terminal.write(data)

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
      // Track the range of lines the user is typing on so onWriteParsed can
      // exclude them. Multi-line paste occupies several lines, so we extend
      // inputRangeEnd by the number of newlines in the pasted data.
      const curAbsLine = terminal.buffer.active.baseY + terminal.buffer.active.cursorY
      if (inputRangeStart < 0 || curAbsLine > inputRangeEnd) inputRangeStart = curAbsLine
      const extraLines = (data.replace(/\x1b\[200~|\x1b\[201~/g, '').match(/[\r\n]/g) ?? []).length
      inputRangeEnd = curAbsLine + extraLines

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
        const cmd = currentInputRef.current.trim()
        currentInputRef.current = ''
        if (cmd) {
          const line = terminal.buffer.active.baseY + terminal.buffer.active.cursorY
          const entry: HistoryEntry = {
            id: crypto.randomUUID(),
            command: cmd,
            outputPreview: '',
            line,
            timestamp: new Date()
          }
          waitingForPreviewRef.current = entry.id
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
        />
      )}
    </div>
  )
}
