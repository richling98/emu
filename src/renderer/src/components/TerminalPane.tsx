import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import type { AgentState, TerminalTab } from '../App'
import {
  AgentPermissionPromptDetector,
  agentPermissionMissDiagnostic,
  agentPermissionMissSnapshot,
  getAgentProviderFromCommand,
  getAgentProviderFromProcess,
  isAgentLaunchCommand,
  isAgentProcessName,
  type AgentPermissionProvider
} from '../../../shared/agentPermissionPrompts'

function shouldDebugScrollWheel(): boolean {
  try {
    return window.localStorage.getItem('emu.debugScrollWheel') === '1' ||
      window.localStorage.getItem('thinking.debugScrollWheel') === '1'
  } catch {
    return false
  }
}
import CommandHistoryDrawer, { type HistoryEntry } from './CommandHistoryDrawer'
import RichInputComposer, { type ComposerImageAttachment } from './RichInputComposer'
import '@xterm/xterm/css/xterm.css'
import './TerminalPane.css'

const DEFAULT_FONT_SIZE = 13
const AGENT_BUSY_ACTIVITY_GRACE_MS = 15_000
const AGENT_BUSY_SCREEN_CHECK_MS = 1_000
const AGENT_BUSY_MAX_WITHOUT_EVIDENCE_MS = 2 * 60 * 1000
const AGENT_PROCESS_POLL_MS = 4_000
const HIDDEN_AGENT_PROCESS_POLL_MS = 16_000
const AGENT_SUBMIT_SINGLE_LINE_SETTLE_MS = 180
const AGENT_SUBMIT_BRACKETED_PASTE_SETTLE_MS = 650
const AGENT_SUBMIT_RETRY_WAIT_MS = 650
const AGENT_SUBMIT_ECHO_WAIT_INTERVAL_MS = 80
const AGENT_SUBMIT_ECHO_WAIT_MAX_MS = 1_200
const MAX_COMMAND_OUTPUT_CHARS = 200_000
const COMMAND_OUTPUT_HEAD_CHARS = 100_000
const COMMAND_OUTPUT_TAIL_CHARS = 100_000
const HIDDEN_OUTPUT_BUFFER_MAX_CHARS = 2 * 1024 * 1024
const HIDDEN_OUTPUT_REPLAY_CHARS_PER_FRAME = 128 * 1024
const DEFAULT_PERMISSION_TAIL_LINES = 28
const AGENT_PERMISSION_TAIL_LINES = 80
const AGENT_PERMISSION_RAW_BUFFER_MAX_CHARS = 32 * 1024
const CLAUDE_PERMISSION_SCAN_DELAYS_MS = [0, 50, 150, 300] as const
const AGENT_PERMISSION_WATCHDOG_INTERVAL_MS = 500
const AGENT_PERMISSION_WATCHDOG_DURATION_MS = 30_000

function shouldUseWebglRenderer(): boolean {
  return window.api.diagnosticsConfig.webglEnabled
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
type ScrollFollowTrigger = 'auto-follow-snap' | 'button' | 'exit' | 'hidden-replay' | 'manual'
type DropTarget = 'terminal' | 'composer'
type TerminalPerfEvent =
  | 'ptyDataEvents'
  | 'ptyDataBytes'
  | 'visiblePtyDataEvents'
  | 'visiblePtyDataBytes'
  | 'hiddenPtyDataEvents'
  | 'hiddenPtyDataBytes'
  | 'terminalWriteCalls'
  | 'terminalWriteBytes'
  | 'processPolls'
  | 'agentIdleChecks'
  | 'rawTuiPromptChecks'
  | 'commandPreviewUpdates'
  | 'commandFullOutputUpdates'
  | 'outputFlushes'
  | 'outputFlushLines'
  | 'outputFlushMs'
  | 'webglActivations'
  | 'webglContextLosses'
  | 'webglFailures'
  | 'webglDisabled'
  | 'hiddenBufferedBytes'
  | 'hiddenReplayWrites'
  | 'hiddenReplayBytes'
  | 'hiddenOmittedBytes'

interface DropHighlightRect {
  left: number
  top: number
  width: number
  height: number
}

interface ComposerCommitPayload {
  commandText: string
  bodyWrite: string
  fingerprint: string
  lastLineFingerprint: string
  usesBracketedPaste: boolean
}

interface ComposerSubmitTransaction {
  id: string
  fingerprint: string
  lastLineFingerprint: string
  agentTarget: boolean
  settleMs: number
  startedAt: number
  sentEnterAt: number | null
  retriedEnterAt: number | null
  tailAtEnter: string
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

function getTerminalVisibleText(terminal: Terminal): string {
  const buffer = terminal.buffer.active
  const startLine = buffer.baseY
  const endLine = buffer.baseY + terminal.rows - 1
  const lines: string[] = []

  for (let line = startLine; line <= endLine; line++) {
    const bufferLine = buffer.getLine(line)
    if (bufferLine) lines.push(bufferLine.translateToString(true).trimEnd())
  }

  return lines.join('\n')
}

function shouldDebugAgentPermission(): boolean {
  try {
    return window.localStorage.getItem('emu.debugAgentPermission') === '1' ||
      window.localStorage.getItem('thinking.debugAgentPermission') === '1'
  } catch {
    return false
  }
}

function shouldDebugScrollFollow(): boolean {
  try {
    return window.localStorage.getItem('emu.debugScrollFollow') === '1' ||
      window.localStorage.getItem('thinking.debugScrollFollow') === '1'
  } catch {
    return false
  }
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

function looksLikeAgentActiveTail(text: string): boolean {
  const normalized = text
    .split('\n')
    .slice(-8)
    .map((line) => line.replace(/\s+/g, ' ').trim().toLowerCase())
    .join('\n')

  return [
    /\besc(?:ape)? to interrupt\b/,
    /\bctrl-c to interrupt\b/,
    /\bthinking\b/,
    /\bworking\b/,
    /\brunning\b/,
    /\bexecuting\b/,
    /\bcalling\b/,
    /\bsearching\b/,
    /\btool\b.*\b(use|call|running|executing)\b/
  ].some((pattern) => pattern.test(normalized))
}

function looksLikeAgentBusy(text: string): boolean {
  const normalized = text
    .split('\n')
    .slice(-12)
    .map((line) => line.replace(/\s+/g, ' ').trim().toLowerCase())
    .join('\n')

  return [
    /\bthinking\b/,
    /\bworking\b/,
    /\brunning\b/,
    /\bexecuting\b/,
    /\bcalling\b/,
    /\bsearching\b/,
    /\breading\b/,
    /\bwriting\b/,
    /\bediting\b/,
    /\besc(?:ape)? to interrupt\b/,
    /\bctrl-c to interrupt\b/,
    /\bpress esc to interrupt\b/,
    /\btool\b.*\b(use|call|running|executing)\b/
  ].some((pattern) => pattern.test(normalized))
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
  const cwdPattern = /\x1b\]633;(?:EmuCwd|ThinkingCwd)=([^\x07\x1b]*)(?:\x07|\x1b\\)/g
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

function capCommandOutput(text: string): string {
  if (text.length <= MAX_COMMAND_OUTPUT_CHARS) return text
  const omitted = text.length - COMMAND_OUTPUT_HEAD_CHARS - COMMAND_OUTPUT_TAIL_CHARS
  return [
    text.slice(0, COMMAND_OUTPUT_HEAD_CHARS).trimEnd(),
    '',
    `[Emu truncated ${omitted.toLocaleString()} characters of command output]`,
    '',
    text.slice(-COMMAND_OUTPUT_TAIL_CHARS).trimStart()
  ].join('\n')
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

function normalizeSubmitText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function normalizeSubmitFingerprint(text: string): string {
  return normalizeSubmitText(text).slice(-180)
}

function normalizeSubmitLastLineFingerprint(text: string): string {
  const lastLine = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(normalizeSubmitText)
    .filter(Boolean)
    .at(-1) ?? ''
  return lastLine.slice(-180)
}

function buildComposerCommitPayload(text: string, imagePaths: string): ComposerCommitPayload | null {
  const commandText = [normalizeComposerCommitText(text), imagePaths].filter(Boolean).join(' ').trim()
  if (!commandText) return null

  const usesBracketedPaste = commandText.includes('\n')
  const bodyWrite = usesBracketedPaste
    ? `\x1b[200~${commandText.replace(/\n/g, '\r')}\x1b[201~`
    : commandText

  return {
    commandText,
    bodyWrite,
    fingerprint: normalizeSubmitFingerprint(commandText),
    lastLineFingerprint: normalizeSubmitLastLineFingerprint(commandText),
    usesBracketedPaste
  }
}

function terminalTailContainsSubmitFingerprint(tail: string, fingerprint: string): boolean {
  if (fingerprint.length < 2) return false
  return normalizeSubmitText(tail).includes(fingerprint)
}

function terminalTailContainsSubmitEvidence(tail: string, transaction: ComposerSubmitTransaction): boolean {
  return terminalTailContainsSubmitFingerprint(tail, transaction.fingerprint) ||
    terminalTailContainsSubmitFingerprint(tail, transaction.lastLineFingerprint)
}

function shouldDebugRichSubmit(): boolean {
  try {
    return window.localStorage.getItem('emu.debugRichSubmit') === '1' ||
      window.localStorage.getItem('thinking.debugRichSubmit') === '1'
  } catch {
    return false
  }
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
  session: TerminalTab
  workspaceName?: string
  isVisible: boolean
  slot?: 'full' | 'left' | 'right' | 'hidden'
  isActive?: boolean
  onActivate?: () => void
  onSessionEnd: () => void
  openDrawer?: boolean
  onDrawerClose?: () => void
  onClosePane?: () => void
  onSessionTouched?: () => void
  onAgentStateChange?: (state: AgentState, foregroundProcess?: string | null) => void
  onCurrentCwdChange?: (cwd: string) => void
  onOpenMarkdown?: (result: MarkdownOpenResult) => void
  onPerfEvent?: (sessionId: string, event: TerminalPerfEvent, value?: number) => void
  focusSignal?: number
  layoutSignal?: string
  xtermTheme?: ITheme
}

export default function TerminalPane({ session, workspaceName, isVisible, slot = 'full', isActive = true, onActivate, onSessionEnd, openDrawer, onDrawerClose, onClosePane, onSessionTouched, onAgentStateChange, onCurrentCwdChange, onOpenMarkdown, onPerfEvent, focusSignal = 0, layoutSignal = '', xtermTheme }: Props) {
  const paneRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const composerDropRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const fitAndResizeRef = useRef<((forcePtyResize?: boolean) => void) | null>(null)
  const replayHiddenOutputRef = useRef<(() => void) | null>(null)
  const isVisibleRef = useRef(isVisible)
  const isActiveRef = useRef(isActive)
  const onSessionTouchedRef = useRef(onSessionTouched)
  const onAgentStateChangeRef = useRef(onAgentStateChange)
  const onCurrentCwdChangeRef = useRef(onCurrentCwdChange)
  const onOpenMarkdownRef = useRef(onOpenMarkdown)
  const onPerfEventRef = useRef(onPerfEvent)
  const workspaceNameRef = useRef(workspaceName)
  const currentWorkingDirectoryRef = useRef<string | null>(null)
  const agentStateRef = useRef<AgentState>('none')
  const agentProcessRef = useRef<string | null>(null)
  const agentProviderRef = useRef<AgentPermissionProvider | null>(getAgentProviderFromProcess(session.foregroundProcess))
  const agentSessionRef = useRef(false)
  const agentTaskStartedAtRef = useRef(0)
  const agentLastBusyEvidenceAtRef = useRef(0)
  const agentLastOutputAtRef = useRef(0)
  const agentBusyCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const agentShellPollStreakRef = useRef(0)
  const agentProcessPollRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const agentPermissionDetectorRef = useRef(new AgentPermissionPromptDetector())
  const agentPermissionRawBufferRef = useRef('')
  const agentPermissionWatchdogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const agentPermissionWatchdogUntilRef = useRef(0)

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
  const hiddenOutputBufferRef = useRef<string[]>([])
  const hiddenOutputBufferCharsRef = useRef(0)
  const hiddenOutputOmittedCharsRef = useRef(0)
  const hiddenOutputReplayFrameRef = useRef<number | null>(null)

  const [commandHistory, setCommandHistory] = useState<HistoryEntry[]>([])
  const commandHistoryRef = useRef<HistoryEntry[]>([])
  const promptNavIndexRef = useRef(-1)
  const [showDrawer, setShowDrawer] = useState(false)
  const [fileDropActive, setFileDropActive] = useState(false)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const [terminalDropRect, setTerminalDropRect] = useState<DropHighlightRect | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [isAtBottom, setIsAtBottom] = useState(true)
  const [isAltAgentReviewingHistory, setIsAltAgentReviewingHistory] = useState(false)
  const isAtBottomRef = useRef(true)
  const isAltAgentReviewingHistoryRef = useRef(false)
  const shouldAutoFollowOutputRef = useRef(true)
  const autoFollowFrameRef = useRef<number | null>(null)
  const autoFollowOutputRenderUntilRef = useRef(0)
  const scrollToBottomAnimRef = useRef<number | null>(null)
  const [composerText, setComposerText] = useState('')
  const [composerImages, setComposerImages] = useState<ComposerImageAttachment[]>([])
  const [richInputActive, setRichInputActive] = useState(true)
  const composerImagesRef = useRef<ComposerImageAttachment[]>([])
  const richInputActiveRef = useRef(true)
  const inputOwnerRef = useRef<InputOwner>('composer')
  const rawTuiModeRef = useRef<RawTuiMode | null>(null)
  const rawTuiReturnOwnerRef = useRef<InputOwner>('composer')
  const rawTuiStartedAtRef = useRef(0)
  const rawTuiExitingUntilRef = useRef(0)
  const rawTuiShellPollCountRef = useRef(0)
  const commitComposerRef = useRef<(text: string) => void>(() => {})
  const composerSubmitRef = useRef<ComposerSubmitTransaction | null>(null)
  const wheelAccumulatorRef = useRef(0)
  const composerSubmitRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const recordPerfEvent = useCallback((event: TerminalPerfEvent, value = 1) => {
    onPerfEventRef.current?.(session.id, event, value)
  }, [session.id])

  const appendHiddenOutput = useCallback((data: string) => {
    hiddenOutputBufferRef.current.push(data)
    hiddenOutputBufferCharsRef.current += data.length
    recordPerfEvent('hiddenBufferedBytes', data.length)

    while (hiddenOutputBufferCharsRef.current > HIDDEN_OUTPUT_BUFFER_MAX_CHARS && hiddenOutputBufferRef.current.length > 0) {
      const removed = hiddenOutputBufferRef.current.shift() ?? ''
      hiddenOutputBufferCharsRef.current -= removed.length
      hiddenOutputOmittedCharsRef.current += removed.length
      recordPerfEvent('hiddenOmittedBytes', removed.length)
    }
  }, [recordPerfEvent])

  const clearHiddenReplayFrame = useCallback(() => {
    if (hiddenOutputReplayFrameRef.current !== null) {
      cancelAnimationFrame(hiddenOutputReplayFrameRef.current)
      hiddenOutputReplayFrameRef.current = null
    }
  }, [])

  // Keep isVisibleRef in sync so the key handler can check it
  useEffect(() => { isVisibleRef.current = isVisible }, [isVisible])
  useEffect(() => { isActiveRef.current = isActive }, [isActive])
  useEffect(() => { onSessionTouchedRef.current = onSessionTouched }, [onSessionTouched])
  useEffect(() => { onAgentStateChangeRef.current = onAgentStateChange }, [onAgentStateChange])
  useEffect(() => { onCurrentCwdChangeRef.current = onCurrentCwdChange }, [onCurrentCwdChange])
  useEffect(() => { onOpenMarkdownRef.current = onOpenMarkdown }, [onOpenMarkdown])
  useEffect(() => { onPerfEventRef.current = onPerfEvent }, [onPerfEvent])
  useEffect(() => { workspaceNameRef.current = workspaceName }, [workspaceName])
  useEffect(() => { isAtBottomRef.current = isAtBottom }, [isAtBottom])
  useEffect(() => { isAltAgentReviewingHistoryRef.current = isAltAgentReviewingHistory }, [isAltAgentReviewingHistory])

  useEffect(() => {
    void window.api.agentPermissionSessionMetadata({
      sessionId: session.id,
      workspaceName
    })
  }, [session.id, workspaceName])

  useEffect(() => { composerImagesRef.current = composerImages }, [composerImages])
  useEffect(() => { richInputActiveRef.current = richInputActive }, [richInputActive])
  useEffect(() => { currentInputRef.current = composerText }, [composerText])

  const selectComposerInput = useCallback(() => {
    if (rawTuiModeRef.current) return
    inputOwnerRef.current = 'composer'
    richInputActiveRef.current = true
    currentInputRef.current = composerText
    setRichInputActive(true)
  }, [composerText])

  // Keep commandHistoryRef in sync so key handlers can read latest history
  useEffect(() => { commandHistoryRef.current = commandHistory }, [commandHistory])

  // Cmd/Ctrl+Shift+L — toggle Command History Drawer
  // Cmd+↑ / Cmd+↓ — jump between prompt positions in scrollback
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!isActiveRef.current) return

      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault()
        e.stopPropagation()
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

  const getViewportElement = () => {
    return containerRef.current?.querySelector('.xterm-viewport') as HTMLElement | null
  }

  const distanceFromBottom = (viewport: HTMLElement) => {
    return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
  }

  const isViewportAtBottom = (viewport: HTMLElement) => {
    return distanceFromBottom(viewport) < 10
  }

  const debugScrollFollow = (event: string, details: Record<string, unknown> = {}) => {
    if (!shouldDebugScrollFollow()) return
    const payload = {
      sessionId: session.id,
      event,
      proc: agentProcessRef.current,
      agentState: agentStateRef.current,
      agentSession: agentSessionRef.current,
      rawTuiMode: rawTuiModeRef.current,
      isVisible: isVisibleRef.current,
      isAltScreen: isAltScreenRef.current,
      isAtBottom: isAtBottomRef.current,
      shouldAutoFollow: shouldAutoFollowOutputRef.current,
      followWindowMsLeft: Math.max(0, autoFollowOutputRenderUntilRef.current - Date.now()),
      scrollAnimActive: scrollToBottomAnimRef.current !== null,
      ...details
    }
    console.debug('[scroll-follow]', payload)
  }

  const isOpencodeAltScreen = () => {
    return terminalRef.current?.buffer.active.type === 'alternate' &&
      (agentProviderRef.current === 'opencode' || getAgentProviderFromProcess(agentProcessRef.current) === 'opencode')
  }

  const resetAltAgentScrollReview = () => {
    isAltAgentReviewingHistoryRef.current = false
    setIsAltAgentReviewingHistory(false)
  }

    const snapTerminalToBottom = (trigger: ScrollFollowTrigger = 'manual') => {
      const terminal = terminalRef.current
      const viewport = getViewportElement()
      if (!terminal || !viewport || terminal.buffer.active.type === 'alternate') return

    // Do NOT call terminal.scrollToBottom() here. It fires _onScroll with
    // suppressScrollEvent:false, which schedules a deferred _innerRefresh via
    // requestAnimationFrame. That rAF snaps scrollTop back to the bottom AFTER
    // the user has started scrolling up, fighting every gesture frame-by-frame.
    // Setting scrollTop directly triggers _handleScroll with suppressScrollEvent:true —
    // it correctly updates ydisp without scheduling any deferred snap.
      viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight
      shouldAutoFollowOutputRef.current = true
      isAtBottomRef.current = true
      setIsAtBottom(true)
      debugScrollFollow('snap-bottom', {
        trigger,
        scrollTop: viewport.scrollTop,
        scrollHeight: viewport.scrollHeight,
        clientHeight: viewport.clientHeight
      })
    }

    const scheduleAutoFollowSnap = () => {
      if (autoFollowFrameRef.current !== null) return
      autoFollowOutputRenderUntilRef.current = Date.now() + 250
      debugScrollFollow('auto-follow-armed')
      autoFollowFrameRef.current = requestAnimationFrame(() => {
        autoFollowFrameRef.current = null
        if (!shouldAutoFollowOutputRef.current) {
          debugScrollFollow('auto-follow-cancelled')
          return
        }
        debugScrollFollow('auto-follow-snap-frame')
        snapTerminalToBottom('auto-follow-snap')
      })
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
      const viewport = getViewportElement()

      if (scrollToBottomAnimRef.current !== null) {
        cancelAnimationFrame(scrollToBottomAnimRef.current)
        scrollToBottomAnimRef.current = null
      }

      if (isOpencodeAltScreen()) {
        window.api.ptyWrite(session.id, '\x1b[6~'.repeat(8))
        resetAltAgentScrollReview()
        shouldAutoFollowOutputRef.current = true
        isAtBottomRef.current = true
        setIsAtBottom(true)
        terminalRef.current?.focus()
        return
      }

      if (!viewport) return

    shouldAutoFollowOutputRef.current = true
    debugScrollFollow('button-scroll-start', { startPos: viewport.scrollTop })
    const DURATION = 300  // ms
    const startTime = performance.now()
    const startPos = viewport.scrollTop

    const step = (now: number) => {
      scrollToBottomAnimRef.current = null
      const elapsed = now - startTime
      const progress = Math.min(elapsed / DURATION, 1)
      const eased = 1 - Math.pow(1 - progress, 3)
      const target = viewport.scrollHeight - viewport.clientHeight
      shouldAutoFollowOutputRef.current = true
      autoFollowOutputRenderUntilRef.current = Date.now() + 80
      viewport.scrollTop = startPos + (target - startPos) * eased
      debugScrollFollow('button-scroll-step', { progress, eased, startPos, target })

      if (progress < 1) {
        scrollToBottomAnimRef.current = requestAnimationFrame(step)
      } else {
        snapTerminalToBottom('button')
      }
    }

    scrollToBottomAnimRef.current = requestAnimationFrame(step)
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
    let webglAddon: WebglAddon | null = null
    let webglContextLossDisposable: { dispose: () => void } | null = null
    const loadWebglRenderer = () => {
      if (disposed) return
      try {
        webglContextLossDisposable?.dispose()
        webglAddon?.dispose()
        webglAddon = new WebglAddon()
        webglContextLossDisposable = webglAddon.onContextLoss(() => {
          if (disposed) return
          recordPerfEvent('webglContextLosses')
          try {
            webglContextLossDisposable?.dispose()
            webglAddon?.dispose()
          } catch {
            // Ignore renderer cleanup errors; xterm will fall back to its default renderer.
          }
          webglContextLossDisposable = null
          webglAddon = null
          window.setTimeout(() => {
            if (!disposed) loadWebglRenderer()
          }, 0)
        })
        terminal.loadAddon(webglAddon)
        recordPerfEvent('webglActivations')
      } catch {
        webglContextLossDisposable = null
        webglAddon = null
        recordPerfEvent('webglFailures')
      }
    }
    if (shouldUseWebglRenderer()) {
      loadWebglRenderer()
    } else {
      recordPerfEvent('webglDisabled')
    }
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

    let getPermissionScanText: (tailLines?: number) => string = () => ''
    let detectPermissionPrompt: (
      text: string,
      source: 'raw' | 'raw-buffer' | 'write-parsed' | 'followup' | 'watchdog' | 'hidden-replay'
    ) => boolean = () => false

    const replayHiddenOutput = () => {
      if (disposed || !isVisibleRef.current || hiddenOutputReplayFrameRef.current !== null) return

      const step = () => {
        hiddenOutputReplayFrameRef.current = null
        if (disposed || !isVisibleRef.current) return

        let replayedOutput = false
        if (hiddenOutputOmittedCharsRef.current > 0) {
          const omitted = hiddenOutputOmittedCharsRef.current
          hiddenOutputOmittedCharsRef.current = 0
          const marker = `\r\n\x1b[2m[Emu omitted ${omitted.toLocaleString()} characters of hidden output while this tab was inactive]\x1b[0m\r\n`
          if (shouldAutoFollowOutputRef.current) autoFollowOutputRenderUntilRef.current = Date.now() + 250
          terminal.write(marker)
          debugScrollFollow('hidden-replay-marker', { omitted })
          replayedOutput = true
          recordPerfEvent('hiddenReplayWrites')
          recordPerfEvent('hiddenReplayBytes', marker.length)
          recordPerfEvent('terminalWriteCalls')
          recordPerfEvent('terminalWriteBytes', marker.length)
        }

        let written = 0
        while (hiddenOutputBufferRef.current.length > 0 && written < HIDDEN_OUTPUT_REPLAY_CHARS_PER_FRAME) {
          let chunk = hiddenOutputBufferRef.current[0]
          const remainingBudget = HIDDEN_OUTPUT_REPLAY_CHARS_PER_FRAME - written
          if (chunk.length <= remainingBudget) {
            hiddenOutputBufferRef.current.shift()
            hiddenOutputBufferCharsRef.current -= chunk.length
          } else {
            hiddenOutputBufferRef.current[0] = chunk.slice(remainingBudget)
            chunk = chunk.slice(0, remainingBudget)
            hiddenOutputBufferCharsRef.current -= chunk.length
          }
          if (shouldAutoFollowOutputRef.current) autoFollowOutputRenderUntilRef.current = Date.now() + 250
          terminal.write(chunk, () => {
            if (disposed) return
            detectPermissionPrompt(getPermissionScanText(AGENT_PERMISSION_TAIL_LINES), 'hidden-replay')
            debugScrollFollow('hidden-replay-write', { chunkLength: chunk.length })
          })
          written += chunk.length
        }

        if (written > 0) {
          replayedOutput = true
          recordPerfEvent('hiddenReplayWrites')
          recordPerfEvent('hiddenReplayBytes', written)
          recordPerfEvent('terminalWriteCalls')
          recordPerfEvent('terminalWriteBytes', written)
        }

        if (replayedOutput && shouldAutoFollowOutputRef.current) {
          debugScrollFollow('hidden-replay-snap-request')
          scheduleAutoFollowSnap()
        }

        if (hiddenOutputBufferRef.current.length > 0 || hiddenOutputOmittedCharsRef.current > 0) {
          hiddenOutputReplayFrameRef.current = requestAnimationFrame(step)
        } else if (currentEntryIdRef.current) {
          if (shouldAutoFollowOutputRef.current) scheduleAutoFollowSnap()
          if (outputFlushTimerRef.current) clearTimeout(outputFlushTimerRef.current)
          outputFlushTimerRef.current = setTimeout(flushOutputBuffer, 600)
        }
      }

      hiddenOutputReplayFrameRef.current = requestAnimationFrame(step)
    }
    replayHiddenOutputRef.current = replayHiddenOutput

    let disposed = false

    const touchSessionActivity = () => {
      onSessionTouchedRef.current?.()
    }

    const debugRichSubmit = (event: string, details: Record<string, unknown> = {}) => {
      if (!shouldDebugRichSubmit()) return
      console.debug('[rich-submit]', event, { sessionId: session.id, ...details })
    }

    let runAgentBusyCheck: () => void = () => {}

    const clearAgentBusyCheckTimer = () => {
      if (agentBusyCheckTimerRef.current) {
        clearTimeout(agentBusyCheckTimerRef.current)
        agentBusyCheckTimerRef.current = null
      }
    }

    const ensureAgentBusyCheckTimer = () => {
      if (disposed || agentBusyCheckTimerRef.current) return
      agentBusyCheckTimerRef.current = window.setTimeout(runAgentBusyCheck, AGENT_BUSY_SCREEN_CHECK_MS)
    }

    const clearComposerSubmitTimers = () => {
      if (composerSubmitRetryTimerRef.current) {
        clearTimeout(composerSubmitRetryTimerRef.current)
        composerSubmitRetryTimerRef.current = null
      }
    }

    const finishComposerSubmitTransaction = (id: string) => {
      if (composerSubmitRef.current?.id !== id) return
      clearComposerSubmitTimers()
      composerSubmitRef.current = null
    }

    const maybeRetryComposerSubmit = (id: string) => {
      const transaction = composerSubmitRef.current
      if (!transaction || transaction.id !== id || !transaction.agentTarget) return
      if (!transaction.sentEnterAt || transaction.retriedEnterAt) return

      const currentTail = getTerminalTailText(terminal, 16)
      const tailLooksActive = looksLikeAgentActiveTail(currentTail)
      const tailStillContainsSubmit = terminalTailContainsSubmitEvidence(currentTail, transaction)
      debugRichSubmit('retry-check', {
        id,
        tailLooksActive,
        tailStillContainsSubmit,
        elapsedMs: Date.now() - transaction.startedAt
      })

      if (!tailLooksActive && tailStillContainsSubmit) {
        transaction.retriedEnterAt = Date.now()
        debugRichSubmit('retry-enter', { id })
        window.api.ptyWriteSequence(session.id, [{ data: '\r' }]).finally(() => {
          finishComposerSubmitTransaction(id)
        })
        return
      }

      finishComposerSubmitTransaction(id)
    }

    const waitForComposerSubmitEchoThenEnter = (id: string) => {
      const transaction = composerSubmitRef.current
      if (!transaction || transaction.id !== id || transaction.sentEnterAt) return

      const currentTail = getTerminalTailText(terminal, 24)
      const tailContainsSubmit = terminalTailContainsSubmitEvidence(currentTail, transaction)
      const elapsedMs = Date.now() - transaction.startedAt
      const timedOut = elapsedMs >= AGENT_SUBMIT_ECHO_WAIT_MAX_MS
      debugRichSubmit('echo-check', {
        id,
        tailContainsSubmit,
        timedOut,
        elapsedMs
      })

      if (tailContainsSubmit || timedOut) {
        sendComposerSubmitEnter(id)
        return
      }

      composerSubmitRetryTimerRef.current = setTimeout(() => {
        composerSubmitRetryTimerRef.current = null
        waitForComposerSubmitEchoThenEnter(id)
      }, AGENT_SUBMIT_ECHO_WAIT_INTERVAL_MS)
    }

    const sendComposerSubmitEnter = (id: string) => {
      const transaction = composerSubmitRef.current
      if (!transaction || transaction.id !== id || transaction.sentEnterAt) return

      transaction.sentEnterAt = Date.now()
      transaction.tailAtEnter = getTerminalTailText(terminal, 16)
      debugRichSubmit('send-enter', { id, agentTarget: transaction.agentTarget })
      window.api.ptyWriteSequence(session.id, [{ data: '\r' }]).then((result) => {
        if (!result.ok || composerSubmitRef.current?.id !== id) {
          finishComposerSubmitTransaction(id)
          return
        }

        if (transaction.agentTarget) {
          composerSubmitRetryTimerRef.current = setTimeout(() => {
            composerSubmitRetryTimerRef.current = null
            maybeRetryComposerSubmit(id)
          }, AGENT_SUBMIT_RETRY_WAIT_MS)
        } else {
          finishComposerSubmitTransaction(id)
        }
      }).catch(() => {
        finishComposerSubmitTransaction(id)
      })
    }

    const setAgentState = (state: AgentState, foregroundProcess: string | null = agentProcessRef.current) => {
      const previousState = agentStateRef.current
      agentStateRef.current = state
      agentProcessRef.current = foregroundProcess
      debugScrollFollow('agent-state', { state, foregroundProcess })
      onAgentStateChangeRef.current?.(state, foregroundProcess)
      // Fire task-complete notification when transitioning from running to idle
      if (previousState === 'running' && state === 'idle') {
        const tabName = session.name || 'Tab'
        window.api.showTaskComplete({
          tabName,
          sessionId: session.id,
          workspaceId: workspaceNameRef.current ?? session.id
        }).catch(() => {})
      }
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
      debugScrollFollow('raw-tui-start', { mode })
      setInputOwner('xterm')
    }

    const endRawTuiMode = () => {
      const mode = rawTuiModeRef.current
      rawTuiModeRef.current = null
      rawTuiStartedAtRef.current = 0
      rawTuiShellPollCountRef.current = 0
      currentInputRef.current = ''
      setComposerText('')
      debugScrollFollow('raw-tui-end', { mode })
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
      clearAgentBusyCheckTimer()
      agentTaskStartedAtRef.current = 0
      agentLastBusyEvidenceAtRef.current = 0
      agentLastOutputAtRef.current = 0
      if (!agentSessionRef.current && !isAgentProcessName(foregroundProcess)) return
      setAgentState('idle', foregroundProcess)
    }

    const markAgentRunning = (foregroundProcess: string | null = agentProcessRef.current) => {
      const now = Date.now()
      agentSessionRef.current = true
      agentTaskStartedAtRef.current = now
      agentLastBusyEvidenceAtRef.current = now
      agentLastOutputAtRef.current = now
      debugScrollFollow('agent-running', { foregroundProcess })
      setAgentState('running', foregroundProcess)
      ensureAgentBusyCheckTimer()
    }

    const clearAgentSession = (foregroundProcess: string | null = agentProcessRef.current) => {
      clearAgentBusyCheckTimer()
      agentSessionRef.current = false
      agentTaskStartedAtRef.current = 0
      agentLastBusyEvidenceAtRef.current = 0
      agentLastOutputAtRef.current = 0
      agentShellPollStreakRef.current = 0
      debugScrollFollow('agent-cleared', { foregroundProcess })
      setAgentState('none', foregroundProcess)
    }

    runAgentBusyCheck = () => {
      agentBusyCheckTimerRef.current = null
      if (disposed || agentStateRef.current !== 'running') return

      const now = Date.now()
      const hasBusyText = looksLikeAgentBusy(getTerminalTailText(terminal, 16))
      const lastOutputOrStartAt = Math.max(agentLastOutputAtRef.current, agentTaskStartedAtRef.current)
      // Busy text helps during quiet thinking, but stale text cannot hold yellow forever.
      const busyTextStillFresh = now - lastOutputOrStartAt < AGENT_BUSY_MAX_WITHOUT_EVIDENCE_MS
      if (hasBusyText && busyTextStillFresh) {
        agentLastBusyEvidenceAtRef.current = now
      }

      const noEvidenceForMs = now - agentLastBusyEvidenceAtRef.current
      if (noEvidenceForMs >= AGENT_BUSY_ACTIVITY_GRACE_MS) {
        recordPerfEvent('agentIdleChecks')
        markAgentIdle(agentProcessRef.current)
        return
      }

      ensureAgentBusyCheckTimer()
    }

    const recordCommittedCommand = (rawCommand: string) => {
      const cmd = rawCommand.trim()
      if (!cmd) return

      const launchedProvider = getAgentProviderFromCommand(cmd)
      if (launchedProvider) agentProviderRef.current = launchedProvider

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
      const payload = buildComposerCommitPayload(text, imagePaths)
      if (!payload) return
      const agentTarget =
        agentSessionRef.current ||
        agentStateRef.current !== 'none' ||
        isAgentProcessName(agentProcessRef.current) ||
        looksLikeAgentIdlePrompt(getTerminalTailText(terminal, 16))
      const submitId = crypto.randomUUID()
      touchSessionActivity()
      recordCommittedCommand(payload.commandText)
      currentInputRef.current = ''
      setComposerText('')
      setComposerImages((current) => {
        current.forEach((image) => URL.revokeObjectURL(image.previewUrl))
        return []
      })
      clearComposerSubmitTimers()
      const settleMs = payload.usesBracketedPaste
        ? AGENT_SUBMIT_BRACKETED_PASTE_SETTLE_MS
        : AGENT_SUBMIT_SINGLE_LINE_SETTLE_MS
      composerSubmitRef.current = {
        id: submitId,
        fingerprint: payload.fingerprint,
        lastLineFingerprint: payload.lastLineFingerprint,
        agentTarget,
        settleMs,
        startedAt: Date.now(),
        sentEnterAt: null,
        retriedEnterAt: null,
        tailAtEnter: ''
      }
      debugRichSubmit('start', {
        id: submitId,
        agentTarget,
        textLength: payload.commandText.length,
        usesBracketedPaste: payload.usesBracketedPaste,
        settleMs
      })

      if (agentTarget) {
        window.api.ptyWriteSequence(session.id, [
          { data: payload.bodyWrite, delayAfterMs: settleMs }
        ]).then((result) => {
          if (!result.ok || composerSubmitRef.current?.id !== submitId) {
            finishComposerSubmitTransaction(submitId)
            return
          }
          waitForComposerSubmitEchoThenEnter(submitId)
        }).catch(() => {
          finishComposerSubmitTransaction(submitId)
        })
        return
      }

      window.api.ptyWriteSequence(session.id, [
        { data: payload.bodyWrite, delayAfterMs: 40 },
        { data: '\r' }
      ]).then((result) => {
        if (!result.ok) {
          finishComposerSubmitTransaction(submitId)
          return
        }
        finishComposerSubmitTransaction(submitId)
      }).catch(() => {
        finishComposerSubmitTransaction(submitId)
      })
    }

    const refreshAgentProcess = async () => {
      recordPerfEvent('processPolls')
      const proc = await window.api.ptyGetProcess(session.id)
      if (disposed) return

      const isAgent = isAgentProcessName(proc)
      const previousProcess = agentProcessRef.current
      const previousProvider = agentProviderRef.current
      agentProcessRef.current = proc
      const detectedProvider = getAgentProviderFromProcess(proc)
      if (detectedProvider) agentProviderRef.current = detectedProvider
      if (previousProvider === 'opencode' && detectedProvider && detectedProvider !== 'opencode') {
        resetAltAgentScrollReview()
      }
      debugScrollFollow('process-refresh', {
        proc,
        previousProcess,
        detectedProvider,
        isAgent
      })

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
        agentShellPollStreakRef.current = 0
        if (agentStateRef.current === 'none') {
          setAgentState('idle', proc)
        } else if (previousProcess !== proc) {
          setAgentState(agentStateRef.current, proc)
        }
      } else if (isShellProcessName(proc)) {
        if (agentStateRef.current === 'running') {
          agentShellPollStreakRef.current = 0
        } else {
          agentShellPollStreakRef.current += 1
          if (agentShellPollStreakRef.current >= 2) {
            clearAgentSession(proc)
          }
        }
      } else if (!agentSessionRef.current && agentStateRef.current !== 'none') {
        agentShellPollStreakRef.current = 0
        clearAgentSession(proc)
      } else if (previousProcess !== proc && agentStateRef.current !== 'none') {
        agentShellPollStreakRef.current = 0
        setAgentState(agentStateRef.current, proc)
      } else {
        agentShellPollStreakRef.current = 0
      }
    }

    const getAgentProcessPollDelay = () => {
      if (isVisibleRef.current || rawTuiModeRef.current || agentStateRef.current === 'running') {
        return AGENT_PROCESS_POLL_MS
      }
      return HIDDEN_AGENT_PROCESS_POLL_MS
    }

    const scheduleAgentProcessPoll = () => {
      if (disposed || agentProcessPollRef.current) return
      agentProcessPollRef.current = setTimeout(() => {
        agentProcessPollRef.current = null
        refreshAgentProcess().finally(scheduleAgentProcessPoll)
      }, getAgentProcessPollDelay())
    }

    // ── Alternate-screen detection via xterm.js buffer events ────────────────
    // We listen to the authoritative buffer-switch event rather than scanning
    // raw PTY bytes for \x1b[?1049h / \x1b[?1049l.  The byte-scan approach
    // falsely triggers when ANY process echoes those characters as text (e.g.
    // `echo "\x1b[?1049h"` on a zsh that interprets \x escapes), breaking the
    // entire terminal session.  onBufferChange only fires when xterm.js actually
    // switches buffers — immune to text that merely looks like the sequence.
    terminal.buffer.onBufferChange(async (newBuffer) => {
      if (newBuffer.type === 'alternate') {
        isAltScreenRef.current = true
        wheelAccumulatorRef.current = 0
        resetAltAgentScrollReview()
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
        const detectedProvider = getAgentProviderFromProcess(proc)
        if (detectedProvider) agentProviderRef.current = detectedProvider
        updateInputOwner(proc)
        if (isAgentProcessName(proc)) {
          agentSessionRef.current = true
          if (agentStateRef.current === 'none') setAgentState('idle', proc)
        }

        if (shouldDebugScrollFollow()) {
          const enterPayload = {
            sessionId: session.id,
            proc,
            provider: detectedProvider,
            isAgent: isAgentProcessName(proc),
            entryLine: altScreenEntryLineRef.current
          }
          console.debug('[scroll-follow:alt-screen-enter]', enterPayload)
        }
      } else {
        const prevAltScreen = isAltScreenRef.current
        isAltScreenRef.current = false
        endRawTuiMode()
        wheelAccumulatorRef.current = 0
        resetAltAgentScrollReview()
        currentInputRef.current = ''
        promptStartLineRef.current = -1
        promptStartColRef.current = -1
        currentEntryIdRef.current = null
        currentEntryStartLineRef.current = -1
        if (outputFlushTimerRef.current) {
          clearTimeout(outputFlushTimerRef.current)
          outputFlushTimerRef.current = null
        }

        if (shouldDebugScrollFollow()) {
          const exitPayload = {
            sessionId: session.id,
            proc: agentProcessRef.current,
            provider: agentProviderRef.current,
            agentSession: agentSessionRef.current
          }
          console.debug('[scroll-follow:alt-screen-exit]', exitPayload)
        }

        // If user was auto-following before alt-screen entry, snap to bottom
        // on exit to reveal any output that arrived during alt-screen mode.
        if (prevAltScreen && shouldAutoFollowOutputRef.current) {
          snapTerminalToBottom('exit')
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
      if (isOpencodeAltScreen() && isAltAgentReviewingHistoryRef.current) return
      // < 10px from bottom counts as "at bottom" to handle sub-pixel rounding
      const atBottom = isViewportAtBottom(viewportEl)
      if (!atBottom && Date.now() < autoFollowOutputRenderUntilRef.current) {
        debugScrollFollow('scroll-state-suppressed', {
          scrollTop: viewportEl.scrollTop,
          scrollHeight: viewportEl.scrollHeight,
          clientHeight: viewportEl.clientHeight
        })
        return
      }
      if (isAtBottomRef.current !== atBottom) {
        debugScrollFollow('scroll-state-change', {
          atBottom,
          scrollTop: viewportEl.scrollTop,
          scrollHeight: viewportEl.scrollHeight,
          clientHeight: viewportEl.clientHeight
        })
      }
      isAtBottomRef.current = atBottom
      shouldAutoFollowOutputRef.current = atBottom
      setIsAtBottom(atBottom)
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
      const fontSize = terminal.options.fontSize ?? 14
      const lineHeight = terminal.options.lineHeight ?? 1.0
      const pxPerLine = fontSize * lineHeight
      const isAltScreen = terminal.buffer.active.type === 'alternate'
      const proc = agentProcessRef.current
      const rawTuiMode = rawTuiModeRef.current
      const scrollingUp = e.deltaY < 0
      const isOpencode = isAltScreen && (agentProviderRef.current === 'opencode' || getAgentProviderFromProcess(proc) === 'opencode')
      if (Date.now() < rawTuiExitingUntilRef.current) return

      if (shouldDebugScrollWheel()) {
        const wheelPayload = {
          sessionId: session.id,
          deltaY: e.deltaY,
          deltaMode: e.deltaMode,
          isAltScreen,
          rawTuiMode,
          proc,
          accumulator: wheelAccumulatorRef.current
        }
        console.debug('[scroll-wheel]', wheelPayload)
      }

      if (isOpencode) {
        if (scrollingUp) {
          autoFollowOutputRenderUntilRef.current = 0
          shouldAutoFollowOutputRef.current = false
          isAtBottomRef.current = false
          isAltAgentReviewingHistoryRef.current = true
          setIsAtBottom(false)
          setIsAltAgentReviewingHistory(true)
          debugScrollFollow('opencode-native-wheel-up', { rawTuiMode, proc, isAltScreen })
        }
        return
      }

      e.preventDefault()
      e.stopPropagation()

      if (scrollingUp) {
        autoFollowOutputRenderUntilRef.current = 0
        shouldAutoFollowOutputRef.current = false
        debugScrollFollow('wheel-scroll-up', { rawTuiMode, proc, isAltScreen })
        if (scrollToBottomAnimRef.current !== null) {
          cancelAnimationFrame(scrollToBottomAnimRef.current)
          scrollToBottomAnimRef.current = null
        }
      }
      if (isAltScreen) {
        // Alt-screen apps: accumulate wheel deltas and send proportional
        // scroll commands.  Sending one full-page command per event (the
        // old behavior) causes ~10+ page scrolls per trackpad flick because
        // macOS generates many small-delta events per gesture.  Instead we
        // accumulate pixels to lines and emit line-level commands so
        // trackpad momentum decelerates naturally.
        let deltaPx: number
        if (e.deltaMode === 0) {
          deltaPx = e.deltaY
        } else if (e.deltaMode === 1) {
          deltaPx = e.deltaY * pxPerLine
        } else {
          if (!viewportEl) return
          deltaPx = e.deltaY > 0 ? viewportEl.clientHeight : -viewportEl.clientHeight
        }
        wheelAccumulatorRef.current += deltaPx
        const absAccum = Math.abs(wheelAccumulatorRef.current)
        if (absAccum >= pxPerLine) {
          const lines = Math.floor(absAccum / pxPerLine)
          const scrollingDown = wheelAccumulatorRef.current > 0
          wheelAccumulatorRef.current = (absAccum % pxPerLine) * (scrollingDown ? 1 : -1)
          const clamped = Math.min(lines, 60)
          window.api.ptyWrite(session.id, scrollingDown ? '\x1b[B'.repeat(clamped) : '\x1b[A'.repeat(clamped))
        }
      } else if (rawTuiMode === 'pager' || isPagerProcessName(proc) || rawTuiMode === 'editor' || isEditorProcessName(proc)) {
        // Pager/editor in normal buffer (unusual but possible): accumulate
        // deltas and send Ctrl+B/Ctrl+F when a page threshold is exceeded,
        // otherwise cursor up/down for fine control.
        let deltaPx: number
        if (e.deltaMode === 0) {
          deltaPx = e.deltaY
        } else if (e.deltaMode === 1) {
          deltaPx = e.deltaY * pxPerLine
        } else {
          if (!viewportEl) return
          deltaPx = e.deltaY > 0 ? viewportEl.clientHeight : -viewportEl.clientHeight
        }
        wheelAccumulatorRef.current += deltaPx
        const absAccum = Math.abs(wheelAccumulatorRef.current)
        if (absAccum >= pxPerLine) {
          const lines = Math.floor(absAccum / pxPerLine)
          const scrollingDown = wheelAccumulatorRef.current > 0
          wheelAccumulatorRef.current = (absAccum % pxPerLine) * (scrollingDown ? 1 : -1)
          const clamped = Math.min(lines, 60)
          const pageThreshold = terminal.rows * 0.6
          if (clamped >= pageThreshold) {
            // Large accumulated scroll → page command
            window.api.ptyWrite(session.id, scrollingDown ? '\x06' : '\x02')
          } else {
            window.api.ptyWrite(session.id, scrollingDown ? '\x1b[B'.repeat(clamped) : '\x1b[A'.repeat(clamped))
          }
        }
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

    window.api.ptyCreate(session.id, {
      cwd: session.initialCwd,
      workspaceName: workspaceNameRef.current
    }).then(() => {
      if (disposed) return
      void refreshAgentProcess().finally(scheduleAgentProcessPoll)

      // Rotating greeting banners — picks a fresh one each time
      const GREETINGS = [
        "Hi there, let's build something great together!",
        "Hey! The terminal is yours. Go make magic.",
        "Welcome back — ready to ship something amazing?",
        "Good to see you. What are we creating today?",
        "Another tab, another project waiting to happen.",
        "Hey there, world-builder. Let's get to it.",
        "Fresh tab, fresh start. You've got this.",
        "Hello! Great things start with a single command.",
        "Welcome. The best code you'll ever write starts now.",
        "Hey! Let's turn coffee into code.",
        "A new tab just opened — and so did a new possibility.",
        "Ready when you are. Let's do something remarkable.",
        "Hey there, genius. Time to build.",
        "New project, new possibilities. Let's go.",
        "The world won't change itself — good thing you're here.",
        "Welcome to your workspace. Make it count.",
        "Hey! Every great product started exactly like this.",
        "You showed up. That's already half the battle.",
        "Clean slate, big plans. What's first?",
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
      const flushStartedAt = performance.now()
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
      recordPerfEvent('outputFlushes')
      recordPerfEvent('outputFlushLines', lines.length)
      recordPerfEvent('outputFlushMs', performance.now() - flushStartedAt)

      // Drop trailing blank lines
      while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()

      const outputFull = capCommandOutput(cleanCopiedOutput(lines.join('\n')))
      if (!outputFull) return

      setCommandHistory(prev =>
        prev.map(e => e.id === id ? { ...e, outputFull } : e)
      )
      recordPerfEvent('commandFullOutputUpdates')
    }

    const permissionContext = () => ({
      sessionId: session.id,
      provider: agentProviderRef.current ?? getAgentProviderFromProcess(agentProcessRef.current),
      agentSession: agentSessionRef.current || isAgentProcessName(agentProcessRef.current)
    })

    getPermissionScanText = (tailLines = DEFAULT_PERMISSION_TAIL_LINES) => {
      return isAltScreenRef.current
        ? `\n${getTerminalVisibleText(terminal)}`
        : `\n${getTerminalTailText(terminal, tailLines)}`
    }

    detectPermissionPrompt = (
      text: string,
      source: 'raw' | 'raw-buffer' | 'write-parsed' | 'followup' | 'watchdog' | 'hidden-replay'
    ): boolean => {
      const context = permissionContext()
      const permissionPrompt = agentPermissionDetectorRef.current.append(text, {
        sessionId: context.sessionId,
        provider: context.provider,
        agentSession: context.agentSession
      })
      if (shouldDebugAgentPermission()) {
        const missDiagnostic = permissionPrompt ? null : agentPermissionMissDiagnostic(text, context.provider)
        console.debug('[agent-permission:detect]', {
          sessionId: session.id,
          source,
          provider: context.provider,
          inferredProvider: missDiagnostic?.inferredProvider ?? null,
          agentSession: context.agentSession,
          altScreen: isAltScreenRef.current,
          rawTuiMode: rawTuiModeRef.current,
          matched: Boolean(permissionPrompt),
          parsedProvider: permissionPrompt?.provider ?? null,
          opencodeMatched: permissionPrompt?.provider === 'opencode',
          summary: permissionPrompt?.summary ?? null,
          missReason: missDiagnostic?.reason ?? null,
          missSnapshot: permissionPrompt ? null : missDiagnostic?.snapshot ?? agentPermissionMissSnapshot(text, context.provider),
          overlayIpcSent: Boolean(permissionPrompt),
          textTail: text.slice(-2_000)
        })
      }
      if (!permissionPrompt) return false

      agentProviderRef.current = permissionPrompt.provider
      window.api.agentPermissionPromptShow({
        ...permissionPrompt,
        workspaceName: workspaceNameRef.current
      }).catch(() => {})
      return true
    }

    const appendPermissionRawBuffer = (data: string) => {
      agentPermissionRawBufferRef.current = `${agentPermissionRawBufferRef.current}${data}`
      if (agentPermissionRawBufferRef.current.length > AGENT_PERMISSION_RAW_BUFFER_MAX_CHARS) {
        agentPermissionRawBufferRef.current = agentPermissionRawBufferRef.current.slice(-AGENT_PERMISSION_RAW_BUFFER_MAX_CHARS)
      }
      return agentPermissionRawBufferRef.current
    }

    const shouldUseAgentPermissionScan = () => {
      const context = permissionContext()
      return context.provider === 'claude' ||
        context.provider === 'codex' ||
        context.provider === 'opencode' ||
        context.agentSession ||
        isAltScreenRef.current ||
        Boolean(rawTuiModeRef.current)
    }

    const clearAgentPermissionWatchdog = () => {
      if (agentPermissionWatchdogTimerRef.current) {
        clearTimeout(agentPermissionWatchdogTimerRef.current)
        agentPermissionWatchdogTimerRef.current = null
      }
      agentPermissionWatchdogUntilRef.current = 0
    }

    const runAgentPermissionWatchdog = () => {
      agentPermissionWatchdogTimerRef.current = null
      if (disposed) return
      if (Date.now() > agentPermissionWatchdogUntilRef.current) {
        clearAgentPermissionWatchdog()
        return
      }

      detectPermissionPrompt(getPermissionScanText(AGENT_PERMISSION_TAIL_LINES), 'watchdog')

      if (Date.now() <= agentPermissionWatchdogUntilRef.current) {
        agentPermissionWatchdogTimerRef.current = window.setTimeout(
          runAgentPermissionWatchdog,
          AGENT_PERMISSION_WATCHDOG_INTERVAL_MS
        )
      }
    }

    const armAgentPermissionWatchdog = () => {
      if (!shouldUseAgentPermissionScan()) return
      agentPermissionWatchdogUntilRef.current = Date.now() + AGENT_PERMISSION_WATCHDOG_DURATION_MS
      if (agentPermissionWatchdogTimerRef.current) return
      agentPermissionWatchdogTimerRef.current = window.setTimeout(
        runAgentPermissionWatchdog,
        AGENT_PERMISSION_WATCHDOG_INTERVAL_MS
      )
    }

    const removeDataListener = window.api.onPtyData(session.id, (data) => {
      // Lightweight renderer-side throughput proxy. Main-process stats keep exact UTF-8 bytes.
      const bytes = data.length
      recordPerfEvent('ptyDataEvents')
      recordPerfEvent('ptyDataBytes', bytes)
      if (isVisibleRef.current) {
        recordPerfEvent('visiblePtyDataEvents')
        recordPerfEvent('visiblePtyDataBytes', bytes)
      } else {
        recordPerfEvent('hiddenPtyDataEvents')
        recordPerfEvent('hiddenPtyDataBytes', bytes)
      }
      touchSessionActivity()
      if (agentSessionRef.current && agentStateRef.current === 'running') {
        const now = Date.now()
        agentLastOutputAtRef.current = now
        agentLastBusyEvidenceAtRef.current = now
        ensureAgentBusyCheckTimer()
      }
      const cwd = extractEmuCwd(data)
      if (cwd) {
        currentWorkingDirectoryRef.current = cwd
        onCurrentCwdChangeRef.current?.(cwd)
      }
      detectPermissionPrompt(data, 'raw')
      detectPermissionPrompt(appendPermissionRawBuffer(data), 'raw-buffer')
      const shouldWriteImmediately = isVisibleRef.current ||
        isAltScreenRef.current ||
        Boolean(rawTuiModeRef.current) ||
        shouldUseAgentPermissionScan()
      if (shouldWriteImmediately) {
        const provider = agentProviderRef.current ?? getAgentProviderFromProcess(agentProcessRef.current)
        const useAgentScan = shouldUseAgentPermissionScan()
        const scanDelays = provider === 'claude' || useAgentScan ? CLAUDE_PERMISSION_SCAN_DELAYS_MS : [0]
        const tailLines = useAgentScan ? AGENT_PERMISSION_TAIL_LINES : DEFAULT_PERMISSION_TAIL_LINES
        const shouldAutoFollowOutput = shouldAutoFollowOutputRef.current
        if (shouldAutoFollowOutput) autoFollowOutputRenderUntilRef.current = Date.now() + 250
        debugScrollFollow('write-callback', {
          shouldAutoFollowOutput,
          tailLines,
          bytes
        })
        terminal.write(data, () => {
          if (disposed) return
          detectPermissionPrompt(getPermissionScanText(tailLines), 'write-parsed')
          if (shouldAutoFollowOutput && shouldAutoFollowOutputRef.current && !isAltAgentReviewingHistoryRef.current) {
            debugScrollFollow('write-callback-snap')
            snapTerminalToBottom('auto-follow-snap')
            scheduleAutoFollowSnap()
          }
          for (const delay of scanDelays) {
            if (delay === 0) continue
            window.setTimeout(() => {
              if (disposed) return
              detectPermissionPrompt(getPermissionScanText(tailLines), 'followup')
            }, delay)
          }
        })
        recordPerfEvent('terminalWriteCalls')
        recordPerfEvent('terminalWriteBytes', bytes)
        armAgentPermissionWatchdog()
      } else {
        appendHiddenOutput(data)
      }
      if (rawTuiModeRef.current && !isAltScreenRef.current) {
        window.setTimeout(() => {
          recordPerfEvent('rawTuiPromptChecks')
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
          recordPerfEvent('commandPreviewUpdates')
        }
      }

      // Arm/re-arm idle timer — when PTY goes quiet for 600ms, read the rendered buffer.
      // Hidden normal-screen output is buffered, so there is no rendered buffer to capture yet.
      if (currentEntryIdRef.current && shouldWriteImmediately) {
        if (outputFlushTimerRef.current) clearTimeout(outputFlushTimerRef.current)
        outputFlushTimerRef.current = setTimeout(flushOutputBuffer, 600)
      }
    })

    const removeExitListener = window.api.onPtyExit(session.id, () => {
      const shouldAutoFollowOutput = shouldAutoFollowOutputRef.current
      if (shouldAutoFollowOutput) autoFollowOutputRenderUntilRef.current = Date.now() + 250
      terminal.write('\r\n\x1b[2m[Process exited]\x1b[0m\r\n', () => {
        if (shouldAutoFollowOutput && shouldAutoFollowOutputRef.current) {
          debugScrollFollow('exit-snap')
          snapTerminalToBottom('exit')
          scheduleAutoFollowSnap()
        }
      })
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
            const launchedProvider = getAgentProviderFromCommand(cmd)
            if (launchedProvider) agentProviderRef.current = launchedProvider
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
      clearAgentBusyCheckTimer()
      clearAgentPermissionWatchdog()
      if (autoFollowFrameRef.current !== null) {
        cancelAnimationFrame(autoFollowFrameRef.current)
        autoFollowFrameRef.current = null
      }
      if (scrollToBottomAnimRef.current !== null) {
        cancelAnimationFrame(scrollToBottomAnimRef.current)
        scrollToBottomAnimRef.current = null
      }
      if (agentProcessPollRef.current) {
        clearTimeout(agentProcessPollRef.current)
        agentProcessPollRef.current = null
      }
      composerSubmitRef.current = null
      clearComposerSubmitTimers()
      if (outputFlushTimerRef.current) clearTimeout(outputFlushTimerRef.current)
      if (resizeDebounce) clearTimeout(resizeDebounce)
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame)
      if (zoomFitFrame !== null) cancelAnimationFrame(zoomFitFrame)
      if (zoomFitTimer) clearTimeout(zoomFitTimer)
      clearHiddenReplayFrame()
      replayHiddenOutputRef.current = null
      hiddenOutputBufferRef.current = []
      hiddenOutputBufferCharsRef.current = 0
      hiddenOutputOmittedCharsRef.current = 0
      agentPermissionRawBufferRef.current = ''
      const webglContextLossDisposableToDispose = webglContextLossDisposable
      webglContextLossDisposable = null
      webglAddon = null
      fitAndResizeRef.current = null
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
      setTimeout(() => {
        try { webglContextLossDisposableToDispose?.dispose() } catch { /* swallow disposal errors */ }
        try { terminal.dispose() } catch { /* swallow disposal errors */ }
      }, 0)
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
      if (hiddenOutputBufferRef.current.length > 0 || hiddenOutputOmittedCharsRef.current > 0) {
        snapTerminalToBottom('hidden-replay')
      }
      replayHiddenOutputRef.current?.()
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
      {(!isAtBottom || isAltAgentReviewingHistory) && (
        <button
          className="scroll-to-bottom-btn"
          onMouseDown={(event) => event.preventDefault()}
          onClick={handleScrollToBottom}
          title="Scroll to bottom"
        >
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
