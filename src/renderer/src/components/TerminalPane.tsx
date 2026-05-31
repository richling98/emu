import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal, type IBufferRange, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import type { AgentState, Session } from '../App'
import CommandHistoryDrawer, { type HistoryEntry } from './CommandHistoryDrawer'
import PromptOptimizerDrawer from './PromptOptimizerDrawer'
import RichInputComposer, { type ComposerImageAttachment } from './RichInputComposer'
import '@xterm/xterm/css/xterm.css'
import './TerminalPane.css'

const DEFAULT_FONT_SIZE = 13
const AGENT_IDLE_CHECK_DELAY_MS = 900
const AGENT_PROCESS_POLL_MS = 4_000

function isAgentProcessName(processName: string | null): boolean {
  if (!processName) return false
  const normalized = processName.toLowerCase().replace(/\\/g, '/').split('/').pop()?.replace(/^-/, '') ?? ''
  return /\b(claude|codex)\b/.test(normalized)
}

function isAgentLaunchCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase()
  if (!normalized) return false
  return /(^|[;&|]\s*)(claude|codex)([\s;&|]|$)/.test(normalized) ||
    /(^|[;&|]\s*)(npx|npm exec|bunx|pnpm dlx|yarn dlx)\s+([@\w./-]*claude[-\w./]*|[@\w./-]*codex[-\w./]*)/.test(normalized)
}

function isShellProcessName(processName: string | null): boolean {
  if (!processName) return false
  const normalized = processName.toLowerCase().replace(/\\/g, '/').split('/').pop() ?? ''
  return ['zsh', 'bash', 'fish', 'sh', 'dash', 'ksh', 'tcsh', '-zsh', '-bash', '-fish', '-sh'].includes(normalized)
}

function normalizedProcessBasename(processName: string | null): string {
  return processName?.toLowerCase().replace(/\\/g, '/').split('/').pop()?.replace(/^-/, '') ?? ''
}

function isPagerProcessName(processName: string | null): boolean {
  return ['less', 'more', 'most'].includes(normalizedProcessBasename(processName))
}

function isEditorProcessName(processName: string | null): boolean {
  return ['vim', 'nvim', 'vi', 'nano', 'emacs'].includes(normalizedProcessBasename(processName))
}

type InputOwner = 'composer' | 'xterm'
type RawTuiMode = 'pager' | 'editor' | 'generic'
type DropTarget = 'terminal' | 'composer'

interface DropHighlightRect {
  left: number
  top: number
  width: number
  height: number
}

function getRawTuiModeForCommand(command: string): RawTuiMode | null {
  const firstCommand = command
    .trim()
    .split(/\s*(?:&&|\|\||[;|&])\s*/)[0]
    .trim()
  const parts = firstCommand.split(/\s+/).filter(Boolean)
  const executableToken = parts[0] === 'command' ? parts[1] : parts[0]
  const executable = executableToken?.split('/').pop()?.toLowerCase() ?? ''
  if (['less', 'more', 'most', 'man'].includes(executable)) return 'pager'
  if (['vim', 'nvim', 'vi', 'nano', 'emacs'].includes(executable)) return 'editor'
  return null
}

function looksLikeShellPrompt(text: string): boolean {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  const last = lines.at(-1) ?? ''
  if (!last || last === '~' || /\(END\)$/.test(last)) return false
  return /(?:^|\s|[\w./~)-])(?:[$%#❯>])\s*$/.test(last)
}

function distanceToRect(x: number, y: number, rect: DOMRect | DropHighlightRect): number {
  const dx = Math.max(rect.left - x, 0, x - (rect.left + rect.width))
  const dy = Math.max(rect.top - y, 0, y - (rect.top + rect.height))
  return Math.hypot(dx, dy)
}

function getTerminalTailText(terminal: Terminal, maxLines = 14): string {
  const buffer = terminal.buffer.active
  const endLine = buffer.baseY + buffer.cursorY
  const startLine = Math.max(0, endLine - maxLines + 1)
  const lines: string[] = []

  for (let line = startLine; line <= endLine; line++) {
    const bufferLine = buffer.getLine(line)
    if (bufferLine) lines.push(bufferLine.translateToString(true).trimEnd())
  }

  return lines.join('\n')
}

function looksLikeAgentIdlePrompt(text: string): boolean {
  const lines = text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const tailLines = lines.slice(-8).map((line) => line.toLowerCase())
  if (tailLines.length === 0) return false

  const activeMarkers = [
    /\besc(?:ape)? to interrupt\b/,
    /\bctrl-c to interrupt\b/,
    /\bthinking\b/,
    /\bworking\b/,
    /\brunning\b/,
    /\bexecuting\b/,
    /\bcalling\b/,
    /\bsearching\b/,
    /\btool\b.*\b(use|call|running|executing)\b/
  ]

  const idleMarkers = [
    /^[│┃]\s*[>›](?:\s|$).*$/,
    /^[>›](?:\s|$).*$/,
    /\bmessage (codex|claude)\b/,
    /\bask (codex|claude)\b/,
    /\btype .*message\b/,
    /\benter\b.*\bsend\b/,
    /\? for shortcuts\b/
  ]

  let lastIdleLine = -1
  for (let i = tailLines.length - 1; i >= 0; i--) {
    if (idleMarkers.some((pattern) => pattern.test(tailLines[i]))) {
      lastIdleLine = i
      break
    }
  }
  if (lastIdleLine === -1) return false

  const afterIdlePrompt = tailLines.slice(lastIdleLine).join('\n')
  return !activeMarkers.some((pattern) => pattern.test(afterIdlePrompt))
}

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

function extractEmuCwd(data: string): string | null {
  let latest: string | null = null
  const cwdPattern = /\x1b\]633;EmuCwd=([^\x07\x1b]*)(?:\x07|\x1b\\)/g
  for (const match of data.matchAll(cwdPattern)) {
    if (match[1]?.startsWith('/')) latest = match[1]
  }
  return latest
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
  if (data.startsWith('\x1b[200~')) {
    const pasted = data
      .replace(/^\x1b\[200~/, '')
      .replace(/\x1b\[201~$/, '')
      .replace(/\r/g, '')
    return current + pasted
  }
  if (data.startsWith('\x1b')) return current             // skip escape seqs
  const printable = data.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '') // strip control chars, keep \n
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

function normalizeComposerCommitText(text: string): string {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .split('\n')

  while (lines.length > 0 && lines[0].trim() === '') lines.shift()
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()

  return lines.join('\n').trim()
}

function buildComposerCommitWrites(text: string): string[] {
  const normalized = normalizeComposerCommitText(text)
  if (!normalized) return []
  if (normalized.includes('\n')) {
    return [`\x1b[200~${normalized.replace(/\n/g, '\r')}\x1b[201~`, '\r']
  }
  return [normalized, '\r']
}

function shellEscape(path: string): string {
  if (/^[a-zA-Z0-9._\-/]+$/.test(path)) return path
  return `'${path.replace(/'/g, "'\\''")}'`
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('Could not read image.'))
    reader.readAsDataURL(file)
  })
}

async function filesToShellEscapedPaths(files: File[]): Promise<string> {
  const paths = await Promise.all(files.map(async (file) => {
    const droppedPath = window.api.getFilePath(file)
    if (droppedPath) return shellEscape(droppedPath)
    if (file.type.startsWith('image/')) {
      return shellEscape(await window.api.imageSaveTemp(await fileToDataUrl(file), file.name || 'pasted-image'))
    }
    return ''
  }))

  return paths.filter(Boolean).join(' ')
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
  onSessionTouched?: () => void
  onAgentStateChange?: (state: AgentState, foregroundProcess?: string | null) => void
  onOpenMarkdown?: (result: MarkdownOpenResult) => void
  focusSignal?: number
  layoutSignal?: string
  xtermTheme?: ITheme
}

interface PromptSelection {
  text: string
  position: IBufferRange
  anchor: { x: number; y: number; placement: 'above' | 'below' }
}

export default function TerminalPane({ session, isVisible, slot = 'full', isActive = true, onActivate, onSessionEnd, openDrawer, onDrawerClose, onClosePane, onOpenSettings, onSessionTouched, onAgentStateChange, onOpenMarkdown, focusSignal = 0, layoutSignal = '', xtermTheme }: Props) {
  const paneRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const composerDropRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const fitAndResizeRef = useRef<((forcePtyResize?: boolean) => void) | null>(null)
  const isVisibleRef = useRef(isVisible)
  const isActiveRef = useRef(isActive)
  const onSessionTouchedRef = useRef(onSessionTouched)
  const onAgentStateChangeRef = useRef(onAgentStateChange)
  const onOpenMarkdownRef = useRef(onOpenMarkdown)
  const currentWorkingDirectoryRef = useRef<string | null>(null)
  const agentStateRef = useRef<AgentState>('none')
  const agentProcessRef = useRef<string | null>(null)
  const agentSessionRef = useRef(false)
  const agentTaskInFlightRef = useRef(false)
  const agentTaskStartedAtRef = useRef(0)
  const agentIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const agentProcessPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

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
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const [terminalDropRect, setTerminalDropRect] = useState<DropHighlightRect | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [isAtBottom, setIsAtBottom] = useState(true)
  const [promptSelection, setPromptSelection] = useState<PromptSelection | null>(null)
  const [capturedPromptSelection, setCapturedPromptSelection] = useState<PromptSelection | null>(null)
  const [composerText, setComposerText] = useState('')
  const [composerImages, setComposerImages] = useState<ComposerImageAttachment[]>([])
  const [richInputActive, setRichInputActive] = useState(true)
  const promptSelectionRef = useRef<PromptSelection | null>(null)
  const composerImagesRef = useRef<ComposerImageAttachment[]>([])
  const richInputActiveRef = useRef(true)
  const inputOwnerRef = useRef<InputOwner>('composer')
  const rawTuiModeRef = useRef<RawTuiMode | null>(null)
  const rawTuiReturnOwnerRef = useRef<InputOwner>('composer')
  const rawTuiStartedAtRef = useRef(0)
  const rawTuiExitingUntilRef = useRef(0)
  const rawTuiShellPollCountRef = useRef(0)
  const commitComposerRef = useRef<(text: string) => void>(() => {})
  const pendingComposerSubmitRef = useRef(false)
  const pendingComposerSubmitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Keep isVisibleRef in sync so the key handler can check it
  useEffect(() => { isVisibleRef.current = isVisible }, [isVisible])
  useEffect(() => { isActiveRef.current = isActive }, [isActive])
  useEffect(() => { onSessionTouchedRef.current = onSessionTouched }, [onSessionTouched])
  useEffect(() => { onAgentStateChangeRef.current = onAgentStateChange }, [onAgentStateChange])
  useEffect(() => { onOpenMarkdownRef.current = onOpenMarkdown }, [onOpenMarkdown])

  useEffect(() => { promptSelectionRef.current = promptSelection }, [promptSelection])
  useEffect(() => { composerImagesRef.current = composerImages }, [composerImages])
  useEffect(() => { richInputActiveRef.current = richInputActive }, [richInputActive])
  useEffect(() => { currentInputRef.current = composerText }, [composerText])

  useEffect(() => {
    if (!isVisible || !isActive) setPromptSelection(null)
  }, [isVisible, isActive])

  const selectComposerInput = useCallback(() => {
    if (rawTuiModeRef.current) return
    inputOwnerRef.current = 'composer'
    richInputActiveRef.current = true
    currentInputRef.current = composerText
    setRichInputActive(true)
  }, [composerText])

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

    if (richInputActiveRef.current) {
      setComposerText(prompt)
      setCapturedPromptSelection(null)
      return
    }

    // Move to end of line, kill backward (\x15 clears the whole buffer in zsh;
    // in bash it only kills back to the last newline), then backspace over any
    // remaining content. Use the selection text length as a fallback for
    // alt-screen contexts where currentInputRef may be empty.
    // Excess backspaces at an empty buffer are silently ignored by all shells.
    const originalPrompt = currentInputRef.current || capturedPromptSelection?.text.replace(/\r/g, '') || ''
    const clearLen = Math.max(originalPrompt.length + 100, 200)
    const input = `\x05\x15${'\x7f'.repeat(clearLen)}\x1b[200~${prompt}\x1b[201~`
    window.api.ptyWrite(session.id, input)
    onSessionTouchedRef.current?.()
    currentInputRef.current = prompt
    setCapturedPromptSelection(null)
    window.setTimeout(() => terminalRef.current?.focus(), 0)
  }

  const handleComposerCommit = useCallback((text: string) => {
    commitComposerRef.current(text)
  }, [])

  const handleComposerInterrupt = useCallback(() => {
    window.api.ptyWrite(session.id, '\x03')
    onSessionTouchedRef.current?.()
  }, [session.id])

  const handleComposerTerminalHotkey = useCallback((data: string) => {
    window.api.ptyWrite(session.id, data)
    onSessionTouchedRef.current?.()
  }, [session.id])

  const addComposerImageFiles = useCallback(async (files: File[]) => {
    const images = files.filter((file) => file.type.startsWith('image/'))
    if (images.length === 0) return

    const attachments = await Promise.all(images.map(async (file) => {
      const droppedPath = window.api.getFilePath(file)
      const path = droppedPath || await window.api.imageSaveTemp(await fileToDataUrl(file), file.name || 'pasted-image')
      return {
        id: crypto.randomUUID(),
        name: file.name || path.split('/').pop() || 'image',
        path,
        previewUrl: URL.createObjectURL(file)
      }
    }))

    setComposerImages((current) => [...current, ...attachments])
  }, [])

  const removeComposerImage = useCallback((id: string) => {
    setComposerImages((current) => {
      const removed = current.find((image) => image.id === id)
      if (removed) URL.revokeObjectURL(removed.previewUrl)
      return current.filter((image) => image.id !== id)
    })
  }, [])

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
      fontFamily: 'Menlo, Monaco, "SF Mono", "JetBrains Mono", monospace',
      fontSize: DEFAULT_FONT_SIZE,
      lineHeight: 1.15,
      letterSpacing: 0,
      fontWeight: '400',
      fontWeightBold: '600',
      cursorBlink: isVisible && isActive,
      cursorStyle: 'bar',
      scrollback: 5000
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(containerRef.current)
    fitAddon.fit()

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    const fitAndResizeTerminal = (forcePtyResize = false) => {
      const previousCols = terminal.cols
      const previousRows = terminal.rows

      fitAddon.fit()

      const resized = terminal.cols !== previousCols || terminal.rows !== previousRows
      if (resized || forcePtyResize) {
        window.api.ptyResize(session.id, terminal.cols, terminal.rows)
      }

      terminal.refresh(0, Math.max(0, terminal.rows - 1))
    }
    fitAndResizeRef.current = fitAndResizeTerminal

    const clearPromptSelection = () => {
      if (promptSelectionRef.current) setPromptSelection(null)
    }

    let disposed = false

    const touchSessionActivity = () => {
      onSessionTouchedRef.current?.()
    }

    const clearAgentIdleTimer = () => {
      if (agentIdleTimerRef.current) {
        clearTimeout(agentIdleTimerRef.current)
        agentIdleTimerRef.current = null
      }
    }

    const submitPendingComposerInput = () => {
      if (!pendingComposerSubmitRef.current) return
      pendingComposerSubmitRef.current = false
      if (pendingComposerSubmitTimerRef.current) {
        clearTimeout(pendingComposerSubmitTimerRef.current)
        pendingComposerSubmitTimerRef.current = null
      }
      window.api.ptyWrite(session.id, '\r')
    }

    const setAgentState = (state: AgentState, foregroundProcess: string | null = agentProcessRef.current) => {
      agentStateRef.current = state
      agentProcessRef.current = foregroundProcess
      onAgentStateChangeRef.current?.(state, foregroundProcess)
    }

    const setInputOwner = (owner: InputOwner) => {
      const previousOwner = inputOwnerRef.current
      inputOwnerRef.current = owner
      if (owner === 'xterm' && previousOwner === 'composer' && !rawTuiModeRef.current) {
        currentInputRef.current = ''
        promptStartLineRef.current = -1
        promptStartColRef.current = -1
      }
      const composerActive = owner === 'composer'
      richInputActiveRef.current = composerActive
      setRichInputActive(composerActive)
      if (owner === 'xterm') window.setTimeout(() => terminal.focus(), 0)
    }

    const startRawTuiMode = (mode: RawTuiMode) => {
      rawTuiReturnOwnerRef.current = inputOwnerRef.current
      rawTuiModeRef.current = mode
      rawTuiStartedAtRef.current = Date.now()
      rawTuiExitingUntilRef.current = 0
      rawTuiShellPollCountRef.current = 0
      setInputOwner('xterm')
    }

    const endRawTuiMode = () => {
      rawTuiModeRef.current = null
      rawTuiStartedAtRef.current = 0
      rawTuiShellPollCountRef.current = 0
      currentInputRef.current = ''
      setComposerText('')
      setInputOwner(rawTuiReturnOwnerRef.current)
    }

    const updateInputOwner = (foregroundProcess: string | null = agentProcessRef.current) => {
      // Explicit ownership: composer for shell/agent prompts, xterm for raw TUIs.
      // Process detection can be stale, so an active rawTuiMode always wins until
      // a clear exit signal (alt-screen exit, shell prompt return, or stable shell polls).
      if (rawTuiModeRef.current || isPagerProcessName(foregroundProcess) || isEditorProcessName(foregroundProcess)) {
        setInputOwner('xterm')
        return
      }

      if (inputOwnerRef.current === 'xterm') return
      setInputOwner('composer')
    }

    const markAgentIdle = (foregroundProcess: string | null = agentProcessRef.current) => {
      clearAgentIdleTimer()
      agentTaskInFlightRef.current = false
      agentTaskStartedAtRef.current = 0
      if (!agentSessionRef.current && !isAgentProcessName(foregroundProcess)) return
      setAgentState('idle', foregroundProcess)
    }

    const markAgentRunning = (foregroundProcess: string | null = agentProcessRef.current) => {
      agentSessionRef.current = true
      agentTaskInFlightRef.current = true
      agentTaskStartedAtRef.current = Date.now()
      setAgentState('running', foregroundProcess)
      clearAgentIdleTimer()
    }

    const clearAgentSession = (foregroundProcess: string | null = agentProcessRef.current) => {
      clearAgentIdleTimer()
      agentSessionRef.current = false
      agentTaskInFlightRef.current = false
      agentTaskStartedAtRef.current = 0
      setAgentState('none', foregroundProcess)
    }

    const recordCommittedCommand = (rawCommand: string) => {
      const cmd = rawCommand.trim()
      if (!cmd) return

      const rawTuiMode = getRawTuiModeForCommand(cmd)
      if (rawTuiMode) {
        startRawTuiMode(rawTuiMode)
      }

      if (!isAltScreenRef.current) {
        flushOutputBuffer()
      }

      if (isAgentLaunchCommand(cmd) || agentSessionRef.current || isAgentProcessName(agentProcessRef.current)) {
        markAgentRunning(agentProcessRef.current)
        updateInputOwner(agentProcessRef.current)
      } else if (agentStateRef.current !== 'running') {
        clearAgentSession(agentProcessRef.current)
        updateInputOwner(agentProcessRef.current)
      }

      const line = isAltScreenRef.current
        ? altScreenEntryLineRef.current
        : terminal.buffer.active.baseY + terminal.buffer.active.cursorY
      const id = crypto.randomUUID()
      const entry: HistoryEntry = {
        id,
        command: cmd,
        outputPreview: '',
        outputFull: '',
        line,
        commandStartCol: terminal.buffer.active.cursorX,
        timestamp: new Date()
      }

      if (!isAltScreenRef.current) {
        waitingForPreviewRef.current = id
        currentEntryIdRef.current = id
        currentEntryStartLineRef.current = line
      }

      promptStartLineRef.current = -1
      promptStartColRef.current = -1
      setCommandHistory(prev => [...prev, entry])
    }

    commitComposerRef.current = (text: string) => {
      const imagePaths = composerImagesRef.current.map((image) => shellEscape(image.path)).join(' ')
      const commandText = [normalizeComposerCommitText(text), imagePaths].filter(Boolean).join(' ')
      const command = commandText.trim()
      if (!command) return
      const commitWrites = buildComposerCommitWrites(commandText)
      if (commitWrites.length === 0) return
      touchSessionActivity()
      recordCommittedCommand(commandText)
      currentInputRef.current = ''
      setComposerText('')
      setComposerImages((current) => {
        current.forEach((image) => URL.revokeObjectURL(image.previewUrl))
        return []
      })
      // Send the edited prompt and Enter as distinct PTY writes.
      // Claude/Codex-style TUIs can treat a combined "text + CR" write as paste/input
      // without submitting; a separate CR mirrors a real keypress more reliably.
      pendingComposerSubmitRef.current = Boolean(commitWrites[1])
      if (pendingComposerSubmitTimerRef.current) clearTimeout(pendingComposerSubmitTimerRef.current)
      pendingComposerSubmitTimerRef.current = pendingComposerSubmitRef.current
        ? setTimeout(submitPendingComposerInput, 120)
        : null
      window.api.ptyWrite(session.id, commitWrites[0])
    }

    const scheduleAgentIdleCheck = () => {
      if (!agentTaskInFlightRef.current) return
      clearAgentIdleTimer()
      agentIdleTimerRef.current = setTimeout(() => {
        agentIdleTimerRef.current = null
        if (!agentTaskInFlightRef.current) return
        if (looksLikeAgentIdlePrompt(getTerminalTailText(terminal))) {
          markAgentIdle(agentProcessRef.current)
        }
      }, AGENT_IDLE_CHECK_DELAY_MS)
    }

    const refreshAgentProcess = async () => {
      const proc = await window.api.ptyGetProcess(session.id)
      if (disposed) return

      const isAgent = isAgentProcessName(proc)
      const previousProcess = agentProcessRef.current
      agentProcessRef.current = proc

      if (rawTuiModeRef.current && !isAltScreenRef.current && isShellProcessName(proc)) {
        const rawTuiAge = Date.now() - rawTuiStartedAtRef.current
        rawTuiShellPollCountRef.current += 1
        if (rawTuiAge > 1_200 && rawTuiShellPollCountRef.current >= 2) {
          endRawTuiMode()
        }
      } else if (rawTuiModeRef.current) {
        rawTuiShellPollCountRef.current = 0
      }
      updateInputOwner(proc)

      if (isAgent) {
        agentSessionRef.current = true
        if (agentStateRef.current === 'none') {
          setAgentState('idle', proc)
        } else if (previousProcess !== proc) {
          setAgentState(agentStateRef.current, proc)
        }
      } else if (isShellProcessName(proc) && (
        agentStateRef.current !== 'running' ||
        isAgentProcessName(previousProcess) ||
        Date.now() - agentTaskStartedAtRef.current > AGENT_PROCESS_POLL_MS
      )) {
        clearAgentSession(proc)
      } else if (!agentSessionRef.current && agentStateRef.current !== 'none') {
        clearAgentSession(proc)
      } else if (previousProcess !== proc && agentStateRef.current !== 'none') {
        setAgentState(agentStateRef.current, proc)
      }
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

        // Refresh the foreground process so the input mode can distinguish
        // agent CLIs (rich composer) from traditional TUIs like less/vim (raw xterm).
        const proc: string | null = await window.api.ptyGetProcess(session.id)
        agentProcessRef.current = proc
        updateInputOwner(proc)
        if (isAgentProcessName(proc)) {
          agentSessionRef.current = true
          if (agentStateRef.current === 'none') setAgentState('idle', proc)
        }
      } else {
        isAltScreenRef.current = false
        endRawTuiMode()
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
      const proc = agentProcessRef.current
      const rawTuiMode = rawTuiModeRef.current
      const scrollingUp = e.deltaY < 0
      if (Date.now() < rawTuiExitingUntilRef.current) return
      if (rawTuiMode === 'pager' || isPagerProcessName(proc)) {
        // Use Ctrl+B / Ctrl+F instead of literal `b` / Space so momentum wheel
        // events cannot leak visible spaces into the shell during pager exit.
        window.api.ptyWrite(session.id, scrollingUp ? '\x02' : '\x06')
      } else if (rawTuiMode === 'editor' || isEditorProcessName(proc)) {
        window.api.ptyWrite(session.id, scrollingUp ? '\x02' : '\x06')
      } else if (isAltScreen) {
        // Alt-screen apps own the screen; the xterm viewport has no scrollback
        // to move. Forward the wheel as app-native navigation.
        window.api.ptyWrite(session.id, scrollingUp ? '\x1b[5~' : '\x1b[6~')
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
    const openClickedFile = async (rawPath: string) => {
      const result = await window.api.markdownOpen({
        rawPath,
        cwd: currentWorkingDirectoryRef.current
      })
      if (result.ok) {
        onOpenMarkdownRef.current?.(result)
        return
      }
      if (result.reason === 'not-markdown' && result.path) {
        await window.api.openPath(result.path)
        return
      }
      onOpenMarkdownRef.current?.(result)
    }

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

    // 2b. Clickable file paths — /absolute, ./relative, file://, and bare Markdown filenames
    const FILE_PATH_RE = /(?:^|[\s"'`(])((?:file:\/\/|~\/|\/|\.{1,2}\/)[^\s"'`)\]>]+|(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:md|markdown|mdown|mkd)(?::\d+(?::\d+)?)?)/gi
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
            activate: () => { void openClickedFile(path) },
          })
        }
        callback(links)
      }
    })

    // ── End clickable links ──────────────────────────────────────────────────

    window.api.ptyCreate(session.id).then(() => {
      if (disposed) return
      refreshAgentProcess()
      agentProcessPollRef.current = setInterval(refreshAgentProcess, AGENT_PROCESS_POLL_MS)

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
      updateInputOwner(agentProcessRef.current)
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
      touchSessionActivity()
      const cwd = extractEmuCwd(data)
      if (cwd) currentWorkingDirectoryRef.current = cwd
      terminal.write(data)
      submitPendingComposerInput()
      scheduleAgentIdleCheck()

      if (rawTuiModeRef.current && !isAltScreenRef.current) {
        window.setTimeout(() => {
          if (rawTuiModeRef.current && !isAltScreenRef.current && looksLikeShellPrompt(getTerminalTailText(terminal, 6))) {
            endRawTuiMode()
          }
        }, 30)
      }

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
      clearAgentSession(null)
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

    let zoomFitFrame: number | null = null
    let zoomFitTimer: ReturnType<typeof setTimeout> | null = null

    const scheduleZoomFit = () => {
      fitAndResizeTerminal(true)

      if (zoomFitFrame !== null) cancelAnimationFrame(zoomFitFrame)
      zoomFitFrame = requestAnimationFrame(() => {
        zoomFitFrame = null
        fitAndResizeTerminal(true)
      })

      if (zoomFitTimer) clearTimeout(zoomFitTimer)
      zoomFitTimer = setTimeout(() => {
        zoomFitTimer = null
        fitAndResizeTerminal(true)
      }, 80)
    }

    const applyFontZoom = (delta: number) => {
      terminal.options.fontSize = delta === 0
        ? DEFAULT_FONT_SIZE
        : Math.min(Math.max((terminal.options.fontSize ?? DEFAULT_FONT_SIZE) + delta, 8), 32)
      scheduleZoomFit()
    }

    terminal.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
      if (ev.type !== 'keydown') return true
      if (ev.key === 'Escape') clearPromptSelection()

      // Font zoom: Cmd+= / Cmd+- / Cmd+0
      if (ev.metaKey) {
        if (ev.key === '=' || ev.key === '+' || ev.code === 'Equal') {
          ev.preventDefault(); applyFontZoom(+1); return false
        }
        if (ev.key === '-' || ev.code === 'Minus') {
          ev.preventDefault(); applyFontZoom(-1); return false
        }
        if (ev.key === '0' || ev.code === 'Digit0') {
          ev.preventDefault()
          applyFontZoom(0)
          return false
        }

      }

      if (inputOwnerRef.current === 'composer') return false

      return true // pass everything else through to xterm
    })

    terminal.onData((data) => {
      touchSessionActivity()
      if (inputOwnerRef.current === 'composer') return

      if (rawTuiModeRef.current || isPagerProcessName(agentProcessRef.current) || isEditorProcessName(agentProcessRef.current)) {
        if (data === 'q' || data === '\x03') {
          // Trackpads can emit momentum wheel events after the user exits a pager.
          // Suppress those so they don't become stray shell input while the prompt returns.
          rawTuiExitingUntilRef.current = Date.now() + 1_200
        }
        window.api.ptyWrite(session.id, data)
        return
      }

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
          const rawTuiMode = getRawTuiModeForCommand(cmd)
          if (rawTuiMode) startRawTuiMode(rawTuiMode)

          if (isAgentLaunchCommand(cmd) || agentSessionRef.current || isAgentProcessName(agentProcessRef.current)) {
            markAgentRunning(agentProcessRef.current)
          } else if (agentStateRef.current !== 'running') {
            clearAgentSession(agentProcessRef.current)
          }

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
    let resizeFrame: number | null = null
    const resizeObserver = new ResizeObserver(() => {
      if (resizeDebounce) clearTimeout(resizeDebounce)
      resizeDebounce = setTimeout(() => {
        resizeDebounce = null
        clearPromptSelection()
        if (resizeFrame !== null) cancelAnimationFrame(resizeFrame)
        resizeFrame = requestAnimationFrame(() => {
          resizeFrame = null
          fitAndResizeTerminal()
        })
      }, 50)
    })
    resizeObserver.observe(containerRef.current)

    // File drag-and-drop: paste shell-escaped path(s) into the terminal
    const isFileDrag = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false

    const getTerminalInputDropRect = (): DropHighlightRect | null => {
      const pane = paneRef.current
      const screen = containerRef.current?.querySelector('.xterm-screen') as HTMLElement | null
      if (!pane || !screen || terminal.cols <= 0 || terminal.rows <= 0) return null

      const paneRect = pane.getBoundingClientRect()
      const screenRect = screen.getBoundingClientRect()
      const cellHeight = screenRect.height / terminal.rows
      const cursorRow = Math.max(0, Math.min(terminal.rows - 1, terminal.buffer.active.cursorY))
      const height = Math.max(26, cellHeight * 1.9)
      const top = screenRect.top - paneRect.top + cursorRow * cellHeight - (height - cellHeight) / 2

      return {
        left: screenRect.left - paneRect.left - 4,
        top,
        width: screenRect.width + 8,
        height
      }
    }

    const chooseDropTarget = (clientX: number, clientY: number): { target: DropTarget | null; terminalRect: DropHighlightRect | null } => {
      const pane = paneRef.current
      if (!pane) return { target: null, terminalRect: null }

      const paneRect = pane.getBoundingClientRect()
      if (clientX < paneRect.left || clientX > paneRect.right || clientY < paneRect.top || clientY > paneRect.bottom) {
        return { target: null, terminalRect: null }
      }

      const terminalRect = getTerminalInputDropRect()
      const composerRect = composerDropRef.current?.getBoundingClientRect() ?? null
      if (!terminalRect && !composerRect) return { target: null, terminalRect: null }
      if (!terminalRect) return { target: 'composer', terminalRect: null }
      if (!composerRect) return { target: 'terminal', terminalRect }

      const paneRelativePoint = { x: clientX - paneRect.left, y: clientY - paneRect.top }
      const terminalDistance = distanceToRect(paneRelativePoint.x, paneRelativePoint.y, terminalRect)
      const composerDistance = distanceToRect(clientX, clientY, composerRect)

      return {
        target: composerDistance < terminalDistance ? 'composer' : 'terminal',
        terminalRect
      }
    }

    const updateDropTarget = (e: DragEvent): DropTarget | null => {
      const { target, terminalRect } = chooseDropTarget(e.clientX, e.clientY)
      setDropTarget(target)
      setTerminalDropRect(target === 'terminal' ? terminalRect : null)
      setFileDropActive(Boolean(target))
      if (e.dataTransfer) e.dataTransfer.dropEffect = target ? 'copy' : 'none'
      return target
    }

    const clearDropTarget = () => {
      setDropTarget(null)
      setTerminalDropRect(null)
      setFileDropActive(false)
    }

    const handleDragOver = (e: DragEvent) => {
      if (!isFileDrag(e)) return
      e.preventDefault()
      e.stopPropagation()
      updateDropTarget(e)
    }
    const handleDragLeave = (e: DragEvent) => {
      if (!isFileDrag(e)) return
      // Only clear if leaving the container entirely
      if (!paneRef.current?.contains(e.relatedTarget as Node)) {
        clearDropTarget()
      }
    }
    const handleDrop = async (e: DragEvent) => {
      if (!isFileDrag(e)) return
      e.preventDefault()
      e.stopPropagation()
      const { target } = chooseDropTarget(e.clientX, e.clientY)
      clearDropTarget()
      if (!target) return
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (files.length === 0) return
      const imageFiles = files.filter((file) => file.type.startsWith('image/'))
      const otherFiles = files.filter((file) => !file.type.startsWith('image/'))

      if (target === 'composer' && imageFiles.length > 0) {
        setInputOwner('composer')
        await addComposerImageFiles(imageFiles)
      }

      if (target === 'terminal') {
        setInputOwner('xterm')
        const paths = await filesToShellEscapedPaths(files)
        if (paths) {
          window.api.ptyWrite(session.id, paths)
          touchSessionActivity()
        }
        terminal.focus()
        return
      }

      const paths = otherFiles
        .map((f) => shellEscape(window.api.getFilePath(f as File)))
        .filter(Boolean)
        .join(' ')
      if (paths) {
        setComposerText((current) => `${current}${paths}`)
        touchSessionActivity()
      }
    }

    const handleTerminalMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      if (rawTuiModeRef.current) return
      setInputOwner('xterm')
    }

    const handleTerminalPaste = async (e: ClipboardEvent) => {
      if (inputOwnerRef.current !== 'xterm') return
      const files = Array.from(e.clipboardData?.files ?? []).filter((file) => file.type.startsWith('image/'))
      if (files.length === 0) return
      e.preventDefault()
      e.stopPropagation()
      const paths = await filesToShellEscapedPaths(files)
      if (paths) {
        window.api.ptyWrite(session.id, paths)
        touchSessionActivity()
      }
      terminal.focus()
    }

    // Use capture:true so we fire before xterm's own drag handlers can consume the events
    containerRef.current.addEventListener('mousedown', handleTerminalMouseDown, { capture: true })
    containerRef.current.addEventListener('paste', handleTerminalPaste, { capture: true })
    paneRef.current?.addEventListener('dragover', handleDragOver, { capture: true })
    paneRef.current?.addEventListener('dragleave', handleDragLeave, { capture: true })
    paneRef.current?.addEventListener('drop', handleDrop, { capture: true })

    return () => {
      disposed = true
      clearAgentIdleTimer()
      if (agentProcessPollRef.current) {
        clearInterval(agentProcessPollRef.current)
        agentProcessPollRef.current = null
      }
      pendingComposerSubmitRef.current = false
      if (pendingComposerSubmitTimerRef.current) {
        clearTimeout(pendingComposerSubmitTimerRef.current)
        pendingComposerSubmitTimerRef.current = null
      }
      if (outputFlushTimerRef.current) clearTimeout(outputFlushTimerRef.current)
      if (resizeDebounce) clearTimeout(resizeDebounce)
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame)
      if (zoomFitFrame !== null) cancelAnimationFrame(zoomFitFrame)
      if (zoomFitTimer) clearTimeout(zoomFitTimer)
      fitAndResizeRef.current = null
      selectionChangeDisposable.dispose()
      viewportEl?.removeEventListener('scroll', updateScrollState)
      removeDataListener()
      removeExitListener()
      resizeObserver.disconnect()
      containerRef.current?.removeEventListener('mousedown', handleTerminalMouseDown, { capture: true })
      containerRef.current?.removeEventListener('paste', handleTerminalPaste, { capture: true })
      paneRef.current?.removeEventListener('dragover', handleDragOver, { capture: true })
      paneRef.current?.removeEventListener('dragleave', handleDragLeave, { capture: true })
      paneRef.current?.removeEventListener('drop', handleDrop, { capture: true })
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

  // Handle font zoom forwarded from the main process before Electron can apply page zoom.
  useEffect(() => {
    const remove = window.api.onFontZoom((delta) => {
      const terminal = terminalRef.current
      if (!terminal || !fitAddonRef.current) return
      terminal.options.fontSize = delta === 0
        ? DEFAULT_FONT_SIZE
        : Math.min(Math.max((terminal.options.fontSize ?? DEFAULT_FONT_SIZE) + delta, 8), 32)
      fitAndResizeRef.current?.(true)
      requestAnimationFrame(() => fitAndResizeRef.current?.(true))
      setTimeout(() => fitAndResizeRef.current?.(true), 80)
    })
    return remove
  }, [])

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.cursorBlink = isVisible && isActive
    }
    if (isVisible && fitAddonRef.current && terminalRef.current) {
      setTimeout(() => {
        fitAndResizeRef.current?.()
        if (!richInputActiveRef.current && isActiveRef.current) terminalRef.current?.focus()
      }, 10)
    }
  }, [isVisible, isActive])

  useEffect(() => {
    if (isVisible && isActive && !richInputActiveRef.current) {
      terminalRef.current?.focus()
    }
  }, [focusSignal, isVisible, isActive])

  useEffect(() => {
    if (!isVisible || !fitAddonRef.current || !terminalRef.current) return
    requestAnimationFrame(() => fitAndResizeRef.current?.(true))
    setTimeout(() => fitAndResizeRef.current?.(true), 80)
  }, [layoutSignal, isVisible])

  // Apply xterm theme whenever the app theme changes
  useEffect(() => {
    if (terminalRef.current && xtermTheme) {
      terminalRef.current.options.theme = xtermTheme
    }
  }, [xtermTheme])

  return (
    <div
      ref={paneRef}
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
      {dropTarget === 'terminal' && terminalDropRect && (
        <div className="terminal-drop-target-highlight" style={terminalDropRect} />
      )}
      <RichInputComposer
        rootRef={composerDropRef}
        value={composerText}
        images={composerImages}
        active={isVisible && isActive}
        focused={richInputActive}
        dropActive={dropTarget === 'composer'}
        onChange={setComposerText}
        onCommit={handleComposerCommit}
        onActivate={selectComposerInput}
        onInterrupt={handleComposerInterrupt}
        onTerminalHotkey={handleComposerTerminalHotkey}
        onPasteImages={addComposerImageFiles}
        onRemoveImage={removeComposerImage}
      />
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
            {dropTarget === 'terminal' ? 'Drop into terminal' : 'Drop into rich prompt'}
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
