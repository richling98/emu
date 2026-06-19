import { app, shell, BrowserWindow, ipcMain, nativeImage, screen } from 'electron'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'path'
import fs from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import * as pty from 'node-pty'
import os from 'os'
import { fileURLToPath } from 'url'
import {
  AgentPermissionPromptDetector,
  getAgentProviderFromCommand,
  getAgentProviderFromProcess,
  inferProviderFromText,
  isAgentLaunchCommand,
  isAgentProcessName,
  type AgentPermissionPrompt,
  type AgentPermissionProvider,
  type PtyWriteChunk
} from '../shared/agentPermissionPrompts'

// Track active PTY processes by session ID
const ptyProcesses = new Map<string, pty.IPty>()
const ptyPerfStats = new Map<string, PtyPerfStats>()
const ptyOutputBatches = new Map<string, PtyOutputBatch>()
const ptyOwnerWindowIds = new Map<string, number>()

interface PtyCreateOptions {
  cwd?: string | null
  workspaceName?: string | null
}

interface PtyPerfStats {
  sessionId: string
  pid: number
  createdAt: number
  dataEvents: number
  dataBytes: number
  ipcMessages: number
  ipcBytes: number
  ptyWriteEvents: number
  ptyWriteBytes: number
  resizeEvents: number
  processPolls: number
  lastDataAt: number | null
}

interface PtyOutputBatch {
  chunks: string[]
  bytes: number
  sender: Electron.WebContents
  timer: ReturnType<typeof setTimeout> | null
}

interface PerfStatsSnapshot {
  capturedAt: number
  process: {
    cpuPercent: number | null
    idleWakeupsPerSecond: number | null
    memory?: Record<string, number>
  }
  appMetrics: Electron.ProcessMetric[]
  totals: Omit<PtyPerfStats, 'sessionId' | 'pid' | 'createdAt' | 'lastDataAt'>
  sessions: PtyPerfStats[]
}

type PtyWriteSequenceResult = {
  ok: true
} | {
  ok: false
  reason: 'not-found' | 'invalid-input'
}

interface PendingAgentPermissionPrompt {
  prompt: AgentPermissionPrompt
  status: 'pending' | 'resolved' | 'dismissed'
  ownerWindowId: number | null
  createdAt: number
}

interface AgentPermissionOverlayPrompt {
  id: string
  sessionId: string
  provider: AgentPermissionProvider
  workspaceName?: string
  summary: string
  detail: string
  rawExcerpt: string
  createdAt: number
}

interface AgentPermissionOverlayState {
  prompts: AgentPermissionOverlayPrompt[]
  activePromptId: string | null
}

type AgentPermissionOverlayAction = {
  type: 'approve' | 'deny'
  promptId: string
} | {
  type: 'previous' | 'next'
}

interface MarkdownOpenInput {
  rawPath: string
  cwd?: string | null
}

interface MarkdownOpenSuccess {
  ok: true
  path: string
  name: string
  directory: string
  markdown: string
  size: number
  mtimeMs: number
}

interface MarkdownOpenFailure {
  ok: false
  reason: 'invalid-path' | 'not-markdown' | 'not-found' | 'not-file' | 'too-large' | 'read-error'
  error: string
  path?: string
}

type MarkdownImageResult = {
  ok: true
  dataUrl: string
  path: string
} | {
  ok: false
  error: string
}

const MAX_MARKDOWN_BYTES = 5 * 1024 * 1024
const MAX_MARKDOWN_IMAGE_BYTES = 10 * 1024 * 1024
const PTY_OUTPUT_BATCH_MS = 12
const PTY_OUTPUT_BATCH_MAX_BYTES = 256 * 1024
const AGENT_PERMISSION_RAW_TAIL_MAX_CHARS = 32 * 1024
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkd'])
const MARKDOWN_IMAGE_MIME_BY_EXT = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp']
])
const AGENT_PERMISSION_OVERLAY_WIDTH = 390
const AGENT_PERMISSION_OVERLAY_HEIGHT = 168
const AGENT_PERMISSION_OVERLAY_MARGIN = 16
const AGENT_PERMISSION_RESOLVED_SUPPRESSION_MS = 2_000
const DEBUG_AGENT_PERMISSION = process.env.EMU_DEBUG_AGENT_PERMISSION === '1' ||
  process.env.THINKING_DEBUG_AGENT_PERMISSION === '1'

let agentPermissionOverlayWindow: BrowserWindow | null = null
const pendingAgentPermissionPrompts: PendingAgentPermissionPrompt[] = []
const recentlyResolvedAgentPermissionPrompts = new Map<string, number>()
const agentPermissionSessionWorkspaceNames = new Map<string, string>()
let activeAgentPermissionPromptId: string | null = null
let agentPermissionOverlayUserMoved = false
let agentPermissionOverlayProgrammaticMoveUntil = 0
let agentPermissionOverlayBounds: Electron.Rectangle | null = null

interface AgentPermissionSessionState {
  detector: AgentPermissionPromptDetector
  provider: AgentPermissionProvider | null
  agentSession: boolean
  rawTail: string
}

const agentPermissionSessionStates = new Map<string, AgentPermissionSessionState>()

function debugAgentPermission(event: string, details: Record<string, unknown> = {}): void {
  if (!DEBUG_AGENT_PERMISSION) return
  console.info('[agent-permission:main]', { event, ...details })
}

function getAgentPermissionSessionState(sessionId: string): AgentPermissionSessionState {
  let state = agentPermissionSessionStates.get(sessionId)
  if (!state) {
    state = {
      detector: new AgentPermissionPromptDetector(),
      provider: null,
      agentSession: false,
      rawTail: ''
    }
    agentPermissionSessionStates.set(sessionId, state)
  }
  return state
}

function trimAgentPermissionRawTail(text: string): string {
  if (text.length <= AGENT_PERMISSION_RAW_TAIL_MAX_CHARS) return text
  return text.slice(-AGENT_PERMISSION_RAW_TAIL_MAX_CHARS)
}

function markAgentPermissionSessionFromCommand(sessionId: string, data: string): void {
  const provider = getAgentProviderFromCommand(data)
  if (!provider && !isAgentLaunchCommand(data)) return

  const state = getAgentPermissionSessionState(sessionId)
  if (provider) state.provider = provider
  state.agentSession = true
  debugAgentPermission('main-session-agent-marked', {
    sessionId,
    provider: state.provider,
    source: 'pty-write'
  })
}

function scanAgentPermissionPtyOutput(sessionId: string, data: string, processName: string | null): void {
  const state = getAgentPermissionSessionState(sessionId)
  const providerFromProcess = getAgentProviderFromProcess(processName)
  const providerFromText = inferProviderFromText(data)

  if (providerFromProcess && providerFromProcess !== state.provider) {
    state.provider = providerFromProcess
    debugAgentPermission('main-session-provider-updated', {
      sessionId,
      provider: state.provider,
      source: 'foreground-process'
    })
  } else if (!state.provider && providerFromText) {
    state.provider = providerFromText
    debugAgentPermission('main-session-provider-updated', {
      sessionId,
      provider: state.provider,
      source: 'pty-output'
    })
  }

  if (isAgentProcessName(processName) || providerFromProcess || providerFromText) {
    state.agentSession = true
  }

  state.rawTail = trimAgentPermissionRawTail(`${state.rawTail}${data}`)
  const prompt = state.detector.append(state.rawTail, {
    sessionId,
    provider: state.provider,
    agentSession: state.agentSession
  })
  debugAgentPermission('main-pty-scan', {
    sessionId,
    provider: state.provider,
    agentSession: state.agentSession,
    matched: Boolean(prompt),
    fingerprint: prompt?.fingerprint ?? null,
    summary: prompt?.summary ?? null,
    textTail: state.rawTail.slice(-2_000)
  })

  if (!prompt) return

  state.provider = prompt.provider
  state.agentSession = true
  debugAgentPermission('main-pty-scan-matched', {
    sessionId,
    provider: prompt.provider,
    fingerprint: prompt.fingerprint,
    summary: prompt.summary
  })
  addAgentPermissionPrompt(prompt, ptyOwnerWindowIds.get(sessionId) ?? null)
}

function clearAgentPermissionSessionState(sessionId: string): void {
  agentPermissionSessionStates.delete(sessionId)
  agentPermissionSessionWorkspaceNames.delete(sessionId)
}

function createPtyPerfStats(sessionId: string, pid: number): PtyPerfStats {
  return {
    sessionId,
    pid,
    createdAt: Date.now(),
    dataEvents: 0,
    dataBytes: 0,
    ipcMessages: 0,
    ipcBytes: 0,
    ptyWriteEvents: 0,
    ptyWriteBytes: 0,
    resizeEvents: 0,
    processPolls: 0,
    lastDataAt: null
  }
}

function byteLength(data: string): number {
  return Buffer.byteLength(data, 'utf8')
}

function flushPtyOutputBatch(sessionId: string): void {
  const batch = ptyOutputBatches.get(sessionId)
  if (!batch) return
  if (batch.timer) {
    clearTimeout(batch.timer)
    batch.timer = null
  }
  ptyOutputBatches.delete(sessionId)

  if (batch.chunks.length === 0 || batch.sender.isDestroyed()) return
  const data = batch.chunks.length === 1 ? batch.chunks[0] : batch.chunks.join('')
  batch.sender.send(`pty:data:${sessionId}`, data)

  const stats = ptyPerfStats.get(sessionId)
  if (stats) {
    stats.ipcMessages += 1
    stats.ipcBytes += batch.bytes
  }
}

function queuePtyOutput(sessionId: string, sender: Electron.WebContents, data: string, bytes: number): void {
  if (sender.isDestroyed()) return

  let batch = ptyOutputBatches.get(sessionId)
  if (!batch) {
    batch = {
      chunks: [],
      bytes: 0,
      sender,
      timer: null
    }
    ptyOutputBatches.set(sessionId, batch)
  }

  batch.chunks.push(data)
  batch.bytes += bytes
  batch.sender = sender

  if (batch.bytes >= PTY_OUTPUT_BATCH_MAX_BYTES) {
    flushPtyOutputBatch(sessionId)
    return
  }

  if (!batch.timer) {
    batch.timer = setTimeout(() => flushPtyOutputBatch(sessionId), PTY_OUTPUT_BATCH_MS)
  }
}

function normalizePtyWriteChunks(input: unknown): PtyWriteChunk[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > 8) return null
  const writes: PtyWriteChunk[] = []
  for (const write of input) {
    if (!write || typeof write !== 'object') return null
    const data = (write as { data?: unknown }).data
    const delayAfterMs = (write as { delayAfterMs?: unknown }).delayAfterMs
    if (typeof data !== 'string' || data.length > 2000) return null
    writes.push({
      data,
      delayAfterMs: typeof delayAfterMs === 'number'
        ? Math.max(0, Math.min(2_000, delayAfterMs))
        : undefined
    })
  }
  return writes
}

async function writePtySequence(sessionId: string, writes: PtyWriteChunk[]): Promise<PtyWriteSequenceResult> {
  const ptyProcess = ptyProcesses.get(sessionId)
  if (!ptyProcess) return { ok: false, reason: 'not-found' }
  if (!Array.isArray(writes) || writes.length === 0 || writes.length > 8) {
    return { ok: false, reason: 'invalid-input' }
  }

  for (const write of writes) {
    if (!write || typeof write.data !== 'string') return { ok: false, reason: 'invalid-input' }
    const stats = ptyPerfStats.get(sessionId)
    if (stats) {
      stats.ptyWriteEvents += 1
      stats.ptyWriteBytes += byteLength(write.data)
    }
    ptyProcess.write(write.data)
    const delayAfterMs = typeof write.delayAfterMs === 'number'
      ? Math.max(0, Math.min(2_000, write.delayAfterMs))
      : 0
    if (delayAfterMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayAfterMs))
    }
  }

  return { ok: true }
}

function sanitizeWorkspaceName(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const name = input
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!name) return null
  return name.slice(0, 80)
}

function sanitizeAgentPermissionPrompt(input: unknown): AgentPermissionPrompt | null {
  if (!input || typeof input !== 'object') return null
  const candidate = input as Partial<AgentPermissionPrompt>
  if (typeof candidate.id !== 'string' || candidate.id.length > 120) return null
  if (typeof candidate.sessionId !== 'string' || candidate.sessionId.length > 120) return null
  if (candidate.provider !== 'claude' && candidate.provider !== 'codex') return null
  if (typeof candidate.fingerprint !== 'string' || candidate.fingerprint.length > 900) return null
  if (typeof candidate.summary !== 'string' || !candidate.summary.trim()) return null
  if (typeof candidate.detail !== 'string') return null
  if (typeof candidate.rawExcerpt !== 'string') return null
  const approveAction = normalizePtyWriteChunks(candidate.approveAction)
  const denyAction = normalizePtyWriteChunks(candidate.denyAction)
  if (!approveAction || !denyAction) return null
  const workspaceName = sanitizeWorkspaceName(candidate.workspaceName)

  return {
    id: candidate.id,
    sessionId: candidate.sessionId,
    provider: candidate.provider,
    workspaceName: workspaceName ?? undefined,
    summary: candidate.summary.trim().slice(0, 120),
    detail: candidate.detail.trim().slice(0, 140),
    rawExcerpt: candidate.rawExcerpt.trim().slice(0, 1200),
    fingerprint: candidate.fingerprint,
    createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : Date.now(),
    approveAction,
    denyAction
  }
}

function serializeAgentPermissionState(): AgentPermissionOverlayState {
  const prompts = pendingAgentPermissionPrompts
    .filter((entry) => entry.status === 'pending')
    .map<AgentPermissionOverlayPrompt>((entry) => ({
      id: entry.prompt.id,
      sessionId: entry.prompt.sessionId,
      provider: entry.prompt.provider,
      workspaceName: entry.prompt.workspaceName,
      summary: entry.prompt.summary,
      detail: entry.prompt.detail,
      rawExcerpt: entry.prompt.rawExcerpt,
      createdAt: entry.prompt.createdAt
    }))
  return { prompts, activePromptId: activeAgentPermissionPromptId }
}

function getActiveAgentPermissionPrompt(): PendingAgentPermissionPrompt | null {
  if (!activeAgentPermissionPromptId) return null
  return pendingAgentPermissionPrompts.find((entry) =>
    entry.status === 'pending' && entry.prompt.id === activeAgentPermissionPromptId
  ) ?? null
}

function getAgentPermissionOverlayDisplay(): Electron.Display {
  const activePrompt = getActiveAgentPermissionPrompt()
  const ownerWindow = activePrompt?.ownerWindowId !== null && activePrompt?.ownerWindowId !== undefined
    ? BrowserWindow.fromId(activePrompt.ownerWindowId)
    : null
  return ownerWindow && !ownerWindow.isDestroyed() && !ownerWindow.isMinimized()
    ? screen.getDisplayMatching(ownerWindow.getBounds())
    : screen.getPrimaryDisplay()
}

function clampAgentPermissionOverlayBounds(
  bounds: Electron.Rectangle,
  display: Electron.Display
): Electron.Rectangle {
  const { workArea } = display
  const width = AGENT_PERMISSION_OVERLAY_WIDTH
  const height = AGENT_PERMISSION_OVERLAY_HEIGHT
  const minX = workArea.x + AGENT_PERMISSION_OVERLAY_MARGIN
  const minY = workArea.y + AGENT_PERMISSION_OVERLAY_MARGIN
  const maxX = workArea.x + workArea.width - width - AGENT_PERMISSION_OVERLAY_MARGIN
  const maxY = workArea.y + workArea.height - height - AGENT_PERMISSION_OVERLAY_MARGIN

  return {
    x: Math.round(Math.max(minX, Math.min(bounds.x, maxX))),
    y: Math.round(Math.max(minY, Math.min(bounds.y, maxY))),
    width,
    height
  }
}

function positionAgentPermissionOverlay(): void {
  if (!agentPermissionOverlayWindow || agentPermissionOverlayWindow.isDestroyed()) return
  const display = getAgentPermissionOverlayDisplay()
  const { workArea } = display
  const defaultBounds = {
    x: Math.round(workArea.x + workArea.width - AGENT_PERMISSION_OVERLAY_WIDTH - AGENT_PERMISSION_OVERLAY_MARGIN),
    y: Math.round(workArea.y + AGENT_PERMISSION_OVERLAY_MARGIN),
    width: AGENT_PERMISSION_OVERLAY_WIDTH,
    height: AGENT_PERMISSION_OVERLAY_HEIGHT
  }
  const nextBounds = agentPermissionOverlayUserMoved && agentPermissionOverlayBounds
    ? clampAgentPermissionOverlayBounds(agentPermissionOverlayBounds, screen.getDisplayMatching(agentPermissionOverlayBounds))
    : defaultBounds
  agentPermissionOverlayBounds = nextBounds
  agentPermissionOverlayProgrammaticMoveUntil = Date.now() + 250
  agentPermissionOverlayWindow.setBounds(nextBounds)
}

function sendAgentPermissionState(): void {
  if (!agentPermissionOverlayWindow || agentPermissionOverlayWindow.isDestroyed()) return
  agentPermissionOverlayWindow.webContents.send('agent-permission:state', serializeAgentPermissionState())
}

function closeAgentPermissionOverlayIfEmpty(): void {
  const hasPending = pendingAgentPermissionPrompts.some((entry) => entry.status === 'pending')
  if (hasPending) return
  activeAgentPermissionPromptId = null
  if (agentPermissionOverlayWindow && !agentPermissionOverlayWindow.isDestroyed()) {
    agentPermissionOverlayWindow.close()
  }
}

function pruneInactiveAgentPermissionPrompts(): void {
  for (let index = pendingAgentPermissionPrompts.length - 1; index >= 0; index--) {
    if (pendingAgentPermissionPrompts[index].status !== 'pending') {
      pendingAgentPermissionPrompts.splice(index, 1)
    }
  }
}

function buildAgentPermissionOverlayHtml(): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
  <style>
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      width: 100vw;
      height: 100vh;
      overflow: hidden;
      background: transparent;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      user-select: none;
    }
    .overlay {
      width: 100vw;
      height: 100vh;
      padding: 11px;
      color: #f8fafc;
      background: rgba(29, 29, 31, 0.88);
      border: 0.5px solid rgba(255, 255, 255, 0.18);
      border-radius: 12px;
      box-shadow: 0 14px 38px rgba(0, 0, 0, 0.38), inset 0 1px 0 rgba(255, 255, 255, 0.12);
      backdrop-filter: blur(34px) saturate(180%);
      -webkit-backdrop-filter: blur(34px) saturate(180%);
      display: flex;
      flex-direction: column;
      gap: 7px;
      overflow: hidden;
      -webkit-app-region: drag;
    }
    .header {
      min-height: 22px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
      line-height: 1.2;
      font-weight: 650;
      color: rgba(255, 255, 255, 0.96);
    }
    .queue {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      gap: 4px;
      -webkit-app-region: no-drag;
    }
    .count {
      font-size: 10.5px;
      line-height: 1;
      color: rgba(235, 235, 245, 0.62);
      white-space: nowrap;
      padding-right: 2px;
    }
    .icon {
      width: 22px;
      height: 22px;
      border: 0.5px solid rgba(255, 255, 255, 0.14);
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.09);
      color: rgba(255, 255, 255, 0.9);
      font-size: 13px;
      line-height: 1;
      cursor: pointer;
      -webkit-app-region: no-drag;
    }
    .icon:hover { background: rgba(255, 255, 255, 0.16); }
    .summary {
      flex: 0 1 auto;
      margin: 0;
      font-size: 12.5px;
      line-height: 1.28;
      font-weight: 520;
      color: rgba(255, 255, 255, 0.94);
      overflow: hidden;
      overflow-wrap: anywhere;
    }
    .detail {
      flex: 1 1 auto;
      min-height: 0;
      overflow: hidden;
      margin: 0;
      color: rgba(235, 235, 245, 0.68);
      font-size: 11.5px;
      line-height: 1.25;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .actions {
      flex: 0 0 auto;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 7px;
      -webkit-app-region: no-drag;
    }
    .button {
      height: 29px;
      border: 0.5px solid rgba(255, 255, 255, 0.15);
      border-radius: 7px;
      font-size: 12.5px;
      font-weight: 650;
      cursor: pointer;
      -webkit-app-region: no-drag;
    }
    .button:disabled {
      cursor: default;
      opacity: 0.55;
    }
    .deny {
      background: rgba(255, 255, 255, 0.1);
      color: rgba(255, 255, 255, 0.92);
    }
    .deny:hover:not(:disabled) { background: rgba(255, 255, 255, 0.17); }
    .approve {
      background: rgba(52, 199, 89, 0.95);
      border-color: rgba(52, 199, 89, 0.9);
      color: #062b12;
    }
    .approve:hover:not(:disabled) { background: rgba(62, 214, 104, 0.98); }
    .hidden { display: none; }
  </style>
</head>
<body>
  <section class="overlay">
    <div class="header">
      <div class="title" id="title">Approval needed</div>
      <div class="queue" id="queue">
        <span class="count" id="count"></span>
        <button class="icon" id="previous" type="button" title="Previous approval" aria-label="Previous approval">&lt;</button>
        <button class="icon" id="next" type="button" title="Next approval" aria-label="Next approval">&gt;</button>
      </div>
    </div>
    <p class="summary" id="summary"></p>
    <p class="detail" id="detail"></p>
    <div class="actions">
      <button class="button deny" id="deny" type="button">Deny</button>
      <button class="button approve" id="approve" type="button">Approve</button>
    </div>
  </section>
  <script>
    const title = document.getElementById('title')
    const queue = document.getElementById('queue')
    const count = document.getElementById('count')
    const summary = document.getElementById('summary')
    const detail = document.getElementById('detail')
    const previous = document.getElementById('previous')
    const next = document.getElementById('next')
    const deny = document.getElementById('deny')
    const approve = document.getElementById('approve')
    let state = { prompts: [], activePromptId: null }
    let busyPromptId = null

    function providerLabel(provider) {
      return provider === 'claude' ? 'Claude Code' : 'Codex'
    }

    function approvalLabel(prompt) {
      return prompt.workspaceName || providerLabel(prompt.provider)
    }

    function activeIndex() {
      const index = state.prompts.findIndex((prompt) => prompt.id === state.activePromptId)
      return index >= 0 ? index : 0
    }

    function activePrompt() {
      return state.prompts[activeIndex()] || null
    }

    function compactMiddle(value, maxLength) {
      const text = String(value || '')
      if (text.length <= maxLength) return text
      const sideLength = Math.max(8, Math.floor((maxLength - 3) / 2))
      return text.slice(0, sideLength) + '...' + text.slice(-sideLength)
    }

    let audioContext = null

    function getAudioContext() {
      if (!audioContext) {
        const AudioContextCtor = window.AudioContext || window.webkitAudioContext
        audioContext = new AudioContextCtor()
      }
      return audioContext
    }

    function playTone(context, destination, note) {
      const now = context.currentTime + 0.02
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      const start = now + note.start
      const end = start + note.duration
      const attackEnd = start + note.attack
      const releaseStart = Math.max(attackEnd, end - note.release)

      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(note.freq, start)
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(note.gain, attackEnd)
      gain.gain.setValueAtTime(note.gain, releaseStart)
      gain.gain.exponentialRampToValueAtTime(0.0001, end)

      oscillator.connect(gain)
      gain.connect(destination)
      oscillator.start(start)
      oscillator.stop(end + 0.04)
    }

    window.playAgentPermissionChime = async function playAgentPermissionChime() {
      const context = getAudioContext()
      if (context.state === 'suspended') await context.resume()

      const master = context.createGain()
      const compressor = context.createDynamicsCompressor()
      const filter = context.createBiquadFilter()

      master.gain.value = 0.68
      compressor.threshold.value = -18
      compressor.knee.value = 18
      compressor.ratio.value = 2.5
      compressor.attack.value = 0.003
      compressor.release.value = 0.18
      filter.type = 'lowpass'
      filter.frequency.value = 5200
      filter.Q.value = 0.35

      master.connect(filter)
      filter.connect(compressor)
      compressor.connect(context.destination)

      playTone(context, master, { freq: 660, start: 0, duration: 0.16, gain: 0.14, attack: 0.008, release: 0.14 })
      playTone(context, master, { freq: 990, start: 0.08, duration: 0.22, gain: 0.12, attack: 0.006, release: 0.18 })

      window.setTimeout(() => {
        try {
          master.disconnect()
          filter.disconnect()
          compressor.disconnect()
        } catch {}
      }, 700)
    }

    function setBusy(promptId) {
      busyPromptId = promptId
      render()
    }

    function send(action) {
      if (action.promptId) setBusy(action.promptId)
      else setBusy(null)
      window.api.agentPermissionOverlayAction(action).catch(() => setBusy(null))
    }

    function render() {
      const prompt = activePrompt()
      if (!prompt) {
        title.textContent = 'Approval needed'
        summary.textContent = ''
        detail.textContent = ''
        queue.classList.add('hidden')
        deny.disabled = true
        approve.disabled = true
        return
      }
      const index = activeIndex()
      const hasMultiple = state.prompts.length > 1
      title.textContent = compactMiddle(approvalLabel(prompt), 48) + ' needs approval'
      summary.textContent = compactMiddle(prompt.summary || 'Approval needed.', 96)
      detail.textContent = compactMiddle(prompt.detail || '', 112)
      count.textContent = String(index + 1) + ' of ' + String(state.prompts.length)
      queue.classList.toggle('hidden', !hasMultiple)
      deny.disabled = busyPromptId === prompt.id
      approve.disabled = busyPromptId === prompt.id
    }

    previous.addEventListener('click', () => send({ type: 'previous' }))
    next.addEventListener('click', () => send({ type: 'next' }))
    deny.addEventListener('click', () => {
      const prompt = activePrompt()
      if (prompt) send({ type: 'deny', promptId: prompt.id })
    })
    approve.addEventListener('click', () => {
      const prompt = activePrompt()
      if (prompt) send({ type: 'approve', promptId: prompt.id })
    })

    window.api.onAgentPermissionOverlayState((nextState) => {
      state = nextState
      if (busyPromptId && !state.prompts.some((prompt) => prompt.id === busyPromptId)) {
        busyPromptId = null
      }
      render()
    })
  </script>
</body>
</html>`
}

function ensureAgentPermissionOverlayWindow(): BrowserWindow {
  if (agentPermissionOverlayWindow && !agentPermissionOverlayWindow.isDestroyed()) {
    return agentPermissionOverlayWindow
  }

  debugAgentPermission('overlay-created')
  agentPermissionOverlayWindow = new BrowserWindow({
    width: AGENT_PERMISSION_OVERLAY_WIDTH,
    height: AGENT_PERMISSION_OVERLAY_HEIGHT,
    frame: false,
    resizable: false,
    fullscreenable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    focusable: true,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  agentPermissionOverlayWindow.setAlwaysOnTop(true, 'screen-saver')
  agentPermissionOverlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  agentPermissionOverlayWindow.on('moved', () => {
    if (!agentPermissionOverlayWindow || agentPermissionOverlayWindow.isDestroyed()) return
    if (Date.now() < agentPermissionOverlayProgrammaticMoveUntil) return
    agentPermissionOverlayUserMoved = true
    agentPermissionOverlayBounds = {
      ...agentPermissionOverlayWindow.getBounds(),
      width: AGENT_PERMISSION_OVERLAY_WIDTH,
      height: AGENT_PERMISSION_OVERLAY_HEIGHT
    }
    debugAgentPermission('overlay-user-moved', { bounds: agentPermissionOverlayBounds })
  })
  agentPermissionOverlayWindow.on('closed', () => {
    agentPermissionOverlayWindow = null
  })
  agentPermissionOverlayWindow.webContents.on('did-finish-load', sendAgentPermissionState)
  agentPermissionOverlayWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  agentPermissionOverlayWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildAgentPermissionOverlayHtml())}`)

  return agentPermissionOverlayWindow
}

function showAgentPermissionOverlay(playChime: boolean): void {
  const overlay = ensureAgentPermissionOverlayWindow()
  positionAgentPermissionOverlay()
  sendAgentPermissionState()
  if (!overlay.isVisible()) overlay.showInactive()
  overlay.moveTop()
  if (playChime) playAgentPermissionChime(overlay)
  debugAgentPermission('overlay-shown', { playChime, visible: overlay.isVisible() })
}

function ensureAgentPermissionOverlayVisible(reason: string, playChime: boolean): void {
  const pendingCount = pendingAgentPermissionPrompts.filter((entry) => entry.status === 'pending').length
  if (pendingCount === 0) {
    closeAgentPermissionOverlayIfEmpty()
    return
  }

  debugAgentPermission('overlay-visible-ensured', { reason, playChime, pendingCount })
  showAgentPermissionOverlay(playChime)
}

function playAgentPermissionChime(overlay: BrowserWindow): void {
  const play = () => {
    if (overlay.isDestroyed()) return
    overlay.webContents
      .executeJavaScript('window.playAgentPermissionChime?.()', true)
      .catch(() => shell.beep())
  }

  if (overlay.webContents.isLoading()) {
    overlay.webContents.once('did-finish-load', play)
    return
  }

  play()
}

function setActiveAgentPermissionPrompt(promptId: string | null): void {
  activeAgentPermissionPromptId = promptId
  positionAgentPermissionOverlay()
  sendAgentPermissionState()
}

function agentPermissionFingerprintKey(sessionId: string, fingerprint: string): string {
  return `${sessionId}\0${fingerprint}`
}

function pruneRecentlyResolvedAgentPermissionPrompts(now = Date.now()): void {
  for (const [key, expiresAt] of recentlyResolvedAgentPermissionPrompts) {
    if (expiresAt <= now) recentlyResolvedAgentPermissionPrompts.delete(key)
  }
}

function markAgentPermissionPromptRecentlyResolved(prompt: AgentPermissionPrompt): void {
  pruneRecentlyResolvedAgentPermissionPrompts()
  recentlyResolvedAgentPermissionPrompts.set(
    agentPermissionFingerprintKey(prompt.sessionId, prompt.fingerprint),
    Date.now() + AGENT_PERMISSION_RESOLVED_SUPPRESSION_MS
  )
}

function isAgentPermissionPromptRecentlyResolved(prompt: AgentPermissionPrompt): boolean {
  const now = Date.now()
  pruneRecentlyResolvedAgentPermissionPrompts(now)
  const expiresAt = recentlyResolvedAgentPermissionPrompts.get(
    agentPermissionFingerprintKey(prompt.sessionId, prompt.fingerprint)
  )
  return typeof expiresAt === 'number' && expiresAt > now
}

function withAgentPermissionWorkspaceName(prompt: AgentPermissionPrompt): AgentPermissionPrompt {
  const workspaceName = prompt.workspaceName ?? agentPermissionSessionWorkspaceNames.get(prompt.sessionId)
  return workspaceName ? { ...prompt, workspaceName } : prompt
}

function addAgentPermissionPrompt(prompt: AgentPermissionPrompt, ownerWindowId: number | null): void {
  const promptWithWorkspaceName = withAgentPermissionWorkspaceName(prompt)
  if (!ptyProcesses.has(promptWithWorkspaceName.sessionId)) {
    debugAgentPermission('prompt-rejected-missing-pty', {
      sessionId: promptWithWorkspaceName.sessionId,
      provider: promptWithWorkspaceName.provider,
      fingerprint: promptWithWorkspaceName.fingerprint
    })
    return
  }
  if (isAgentPermissionPromptRecentlyResolved(promptWithWorkspaceName)) {
    debugAgentPermission('prompt-suppressed-recently-resolved', {
      sessionId: promptWithWorkspaceName.sessionId,
      provider: promptWithWorkspaceName.provider,
      fingerprint: promptWithWorkspaceName.fingerprint
    })
    return
  }
  const duplicate = pendingAgentPermissionPrompts.find((entry) =>
    entry.status === 'pending' &&
    entry.prompt.sessionId === promptWithWorkspaceName.sessionId &&
    entry.prompt.fingerprint === promptWithWorkspaceName.fingerprint
  )
  if (duplicate) {
    duplicate.prompt = {
      ...promptWithWorkspaceName,
      workspaceName: promptWithWorkspaceName.workspaceName ?? duplicate.prompt.workspaceName,
      id: duplicate.prompt.id,
      createdAt: duplicate.prompt.createdAt
    }
    duplicate.ownerWindowId = ownerWindowId
    if (!getActiveAgentPermissionPrompt()) activeAgentPermissionPromptId = duplicate.prompt.id
    ensureAgentPermissionOverlayVisible('duplicate-refresh', false)
    debugAgentPermission('prompt-deduped', {
      sessionId: promptWithWorkspaceName.sessionId,
      provider: promptWithWorkspaceName.provider,
      fingerprint: promptWithWorkspaceName.fingerprint
    })
    return
  }

  pendingAgentPermissionPrompts.push({
    prompt: promptWithWorkspaceName,
    status: 'pending',
    ownerWindowId,
    createdAt: Date.now()
  })
  if (!activeAgentPermissionPromptId) activeAgentPermissionPromptId = promptWithWorkspaceName.id
  debugAgentPermission('prompt-queued', {
    sessionId: promptWithWorkspaceName.sessionId,
    provider: promptWithWorkspaceName.provider,
    fingerprint: promptWithWorkspaceName.fingerprint,
    pendingCount: pendingAgentPermissionPrompts.filter((entry) => entry.status === 'pending').length
  })
  ensureAgentPermissionOverlayVisible('new-prompt', true)
}

function dismissAgentPermissionPromptsForSession(sessionId: string): void {
  let changed = false
  for (const entry of pendingAgentPermissionPrompts) {
    if (entry.status === 'pending' && entry.prompt.sessionId === sessionId) {
      entry.status = 'dismissed'
      changed = true
    }
  }
  if (!changed) return

  if (activeAgentPermissionPromptId && !getActiveAgentPermissionPrompt()) {
    const nextPrompt = pendingAgentPermissionPrompts.find((entry) => entry.status === 'pending')
    activeAgentPermissionPromptId = nextPrompt?.prompt.id ?? null
  }
  pruneInactiveAgentPermissionPrompts()
  closeAgentPermissionOverlayIfEmpty()
  positionAgentPermissionOverlay()
  sendAgentPermissionState()
}

function navigateAgentPermissionPrompt(direction: 'previous' | 'next'): void {
  const pending = pendingAgentPermissionPrompts.filter((entry) => entry.status === 'pending')
  if (pending.length === 0) {
    closeAgentPermissionOverlayIfEmpty()
    return
  }
  const currentIndex = pending.findIndex((entry) => entry.prompt.id === activeAgentPermissionPromptId)
  const fallbackIndex = currentIndex === -1 ? 0 : currentIndex
  const nextIndex = direction === 'next'
    ? (fallbackIndex + 1) % pending.length
    : (fallbackIndex - 1 + pending.length) % pending.length
  setActiveAgentPermissionPrompt(pending[nextIndex].prompt.id)
  ensureAgentPermissionOverlayVisible('navigate', false)
}

async function resolveAgentPermissionPrompt(promptId: string, decision: 'approve' | 'deny'): Promise<void> {
  const pending = pendingAgentPermissionPrompts.filter((entry) => entry.status === 'pending')
  const index = pending.findIndex((entry) => entry.prompt.id === promptId)
  if (index === -1) return

  const entry = pending[index]
  debugAgentPermission('overlay-action', {
    promptId,
    decision,
    provider: entry.prompt.provider,
    fingerprint: entry.prompt.fingerprint
  })
  entry.status = 'resolved'
  markAgentPermissionPromptRecentlyResolved(entry.prompt)
  const writes = decision === 'approve' ? entry.prompt.approveAction : entry.prompt.denyAction
  const nextEntry = pending[index + 1] ?? pending[index - 1] ?? null
  activeAgentPermissionPromptId = nextEntry?.prompt.id ?? null
  pruneInactiveAgentPermissionPrompts()
  closeAgentPermissionOverlayIfEmpty()
  positionAgentPermissionOverlay()
  sendAgentPermissionState()
  ensureAgentPermissionOverlayVisible('resolved-with-pending', false)
  await writePtySequence(entry.prompt.sessionId, writes)
}

function isAgentPermissionOverlayAction(input: unknown): input is AgentPermissionOverlayAction {
  if (!input || typeof input !== 'object') return false
  const type = (input as { type?: unknown }).type
  if (type === 'previous' || type === 'next') return true
  if (type !== 'approve' && type !== 'deny') return false
  return typeof (input as { promptId?: unknown }).promptId === 'string'
}

async function getPerfStatsSnapshot(): Promise<PerfStatsSnapshot> {
  const sessions = Array.from(ptyPerfStats.values()).map((stats) => ({ ...stats }))
  const totals = sessions.reduce<PerfStatsSnapshot['totals']>((acc, stats) => {
    acc.dataEvents += stats.dataEvents
    acc.dataBytes += stats.dataBytes
    acc.ipcMessages += stats.ipcMessages
    acc.ipcBytes += stats.ipcBytes
    acc.ptyWriteEvents += stats.ptyWriteEvents
    acc.ptyWriteBytes += stats.ptyWriteBytes
    acc.resizeEvents += stats.resizeEvents
    acc.processPolls += stats.processPolls
    return acc
  }, {
    dataEvents: 0,
    dataBytes: 0,
    ipcMessages: 0,
    ipcBytes: 0,
    ptyWriteEvents: 0,
    ptyWriteBytes: 0,
    resizeEvents: 0,
    processPolls: 0
  })

  const electronProcess = process as NodeJS.Process & {
    getCPUUsage?: () => { percentCPUUsage?: number; idleWakeupsPerSecond?: number }
    getProcessMemoryInfo?: () => Promise<Record<string, number>>
  }
  const cpu = electronProcess.getCPUUsage?.()
  let memory: Record<string, number> | undefined
  try {
    memory = await electronProcess.getProcessMemoryInfo?.()
  } catch {
    memory = undefined
  }

  return {
    capturedAt: Date.now(),
    process: {
      cpuPercent: typeof cpu?.percentCPUUsage === 'number' ? cpu.percentCPUUsage : null,
      idleWakeupsPerSecond: typeof cpu?.idleWakeupsPerSecond === 'number' ? cpu.idleWakeupsPerSecond : null,
      memory
    },
    appMetrics: app.getAppMetrics(),
    totals,
    sessions
  }
}

function saveTempImage(dataUrl: string, suggestedName?: string): string {
  const match = /^data:image\/(png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
  if (!match) throw new Error('Unsupported image data.')

  const ext = match[1] === 'jpeg' ? 'jpg' : match[1]
  const safeStem = String(suggestedName ?? 'image')
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'image'
  const dir = join(app.getPath('temp'), 'emu-rich-input-images')
  fs.mkdirSync(dir, { recursive: true })
  const filePath = join(dir, `${safeStem}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`)
  fs.writeFileSync(filePath, Buffer.from(match[2], 'base64'))
  return filePath
}

// Only allow http/https URLs to be opened externally.
// Blocks file://, javascript:, custom schemes, and anything else that could
// be used to open local files or trigger other installed apps maliciously.
function isSafeExternalUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

// Only allow real absolute filesystem paths (no URLs, no null bytes).
function isSafeOpenPath(p: string): boolean {
  return typeof p === 'string' && p.startsWith('/') && !p.includes('\0')
}

function normalizeSafeCwd(cwd?: string | null): string | null {
  if (typeof cwd !== 'string' || !cwd.trim() || !isSafeOpenPath(cwd)) return null
  try {
    const stat = fs.statSync(cwd)
    return stat.isDirectory() ? cwd : null
  } catch {
    return null
  }
}

function cleanUserPath(rawPath: string): string {
  const cleaned = String(rawPath ?? '')
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/[),.;]+$/g, '')
  return cleaned.replace(/(\.(?:md|markdown|mdown|mkd)):\d+(?::\d+)?$/i, '$1')
}

function resolveLocalPath(rawPath: string, cwd?: string | null): { ok: true; path: string } | { ok: false; error: string } {
  const cleaned = cleanUserPath(rawPath)
  if (!cleaned || cleaned.includes('\0')) return { ok: false, error: 'Invalid file path.' }

  let candidate = cleaned
  if (candidate.startsWith('file://')) {
    try {
      candidate = fileURLToPath(candidate)
    } catch {
      return { ok: false, error: 'Invalid file URL.' }
    }
  } else if (candidate.startsWith('~/')) {
    candidate = join(os.homedir(), candidate.slice(2))
  } else if (!isAbsolute(candidate)) {
    const baseDir = cwd && isSafeOpenPath(cwd) ? cwd : os.homedir()
    candidate = resolve(baseDir, candidate)
  }

  if (!isSafeOpenPath(candidate)) return { ok: false, error: 'Invalid file path.' }
  return { ok: true, path: candidate }
}

function readMarkdownFile(input: MarkdownOpenInput): MarkdownOpenSuccess | MarkdownOpenFailure {
  const resolved = resolveLocalPath(input.rawPath, input.cwd)
  if (!resolved.ok) return { ok: false, reason: 'invalid-path', error: resolved.error }

  const filePath = resolved.path
  const extension = extname(filePath).toLowerCase()
  if (!MARKDOWN_EXTENSIONS.has(extension)) {
    return { ok: false, reason: 'not-markdown', error: 'This file is not Markdown.', path: filePath }
  }

  let stat: fs.Stats
  try {
    stat = fs.statSync(filePath)
  } catch {
    return { ok: false, reason: 'not-found', error: 'Markdown file was not found.', path: filePath }
  }

  if (!stat.isFile()) return { ok: false, reason: 'not-file', error: 'This path is not a file.', path: filePath }
  if (stat.size > MAX_MARKDOWN_BYTES) {
    return { ok: false, reason: 'too-large', error: 'Markdown file is too large to preview in Emu.', path: filePath }
  }

  try {
    return {
      ok: true,
      path: filePath,
      name: basename(filePath),
      directory: dirname(filePath),
      markdown: fs.readFileSync(filePath, 'utf8'),
      size: stat.size,
      mtimeMs: stat.mtimeMs
    }
  } catch {
    return { ok: false, reason: 'read-error', error: 'Could not read Markdown file.', path: filePath }
  }
}

function readMarkdownImage(input: MarkdownOpenInput): MarkdownImageResult {
  const resolved = resolveLocalPath(input.rawPath, input.cwd)
  if (!resolved.ok) return { ok: false, error: resolved.error }

  const filePath = resolved.path
  const mime = MARKDOWN_IMAGE_MIME_BY_EXT.get(extname(filePath).toLowerCase())
  if (!mime) return { ok: false, error: 'Unsupported image type.' }

  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) return { ok: false, error: 'Image path is not a file.' }
    if (stat.size > MAX_MARKDOWN_IMAGE_BYTES) return { ok: false, error: 'Image is too large to preview in Emu.' }
    const data = fs.readFileSync(filePath)
    return { ok: true, path: filePath, dataUrl: `data:${mime};base64,${data.toString('base64')}` }
  } catch {
    return { ok: false, error: 'Could not read Markdown image.' }
  }
}

// Write zsh wrapper startup files to Emu's app-data dir and return the path.
// Setting ZDOTDIR to this dir makes zsh read our wrappers instead of ~/.zsh*;
// each wrapper sources the user's real file then our .zshrc appends the
// prompt-spacing hook so a blank line appears between output and the next prompt.
function setupShellIntegration(): string {
  const dir = join(app.getPath('userData'), 'shell-integration')
  fs.mkdirSync(dir, { recursive: true })

  // .zshenv — sourced for every zsh instance (login, interactive, scripts)
  fs.writeFileSync(join(dir, '.zshenv'),
    '[[ -f "$HOME/.zshenv" ]] && source "$HOME/.zshenv"\n')

  // .zprofile — sourced for login shells before .zshrc
  fs.writeFileSync(join(dir, '.zprofile'),
    '[[ -f "$HOME/.zprofile" ]] && source "$HOME/.zprofile"\n')

  // .zshrc — sourced for interactive shells
  fs.writeFileSync(join(dir, '.zshrc'), [
    '# Restore ZDOTDIR so any subshells use the normal ~/.zshrc, not this wrapper',
    'export ZDOTDIR="$HOME"',
    '',
    '# Source the user\'s real interactive config',
    '[[ -f "$HOME/.zshrc" ]] && source "$HOME/.zshrc"',
    '',
    '# Tell Emu the current directory before each prompt so relative file links resolve correctly',
    'function _emu_report_cwd() { printf "\\033]633;EmuCwd=%s\\007" "$PWD" }',
    'autoload -Uz add-zsh-hook 2>/dev/null',
    'add-zsh-hook precmd _emu_report_cwd 2>/dev/null || precmd_functions+=(_emu_report_cwd)',
  ].join('\n') + '\n')

  // .zlogin — sourced for login shells after .zshrc
  fs.writeFileSync(join(dir, '.zlogin'),
    '[[ -f "$HOME/.zlogin" ]] && source "$HOME/.zlogin"\n')

  return dir
}

function createWindow(): void {
  const iconPath = join(__dirname, '../../build/icon.icns')
  const appIcon = nativeImage.createFromPath(iconPath)
  if (!appIcon.isEmpty()) app.dock?.setIcon(appIcon)
  const enableWebgl = process.env.EMU_ENABLE_WEBGL === '1' || process.env.THINKING_ENABLE_WEBGL === '1'
  const disableVibrancy = process.env.EMU_DISABLE_VIBRANCY === '1' || process.env.THINKING_DISABLE_VIBRANCY === '1'

  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    transparent: !disableVibrancy,
    ...(disableVibrancy ? { backgroundColor: '#1e1e2e' } : { vibrancy: 'sidebar' as const }),
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [
        `--emu-enable-webgl=${enableWebgl ? '1' : '0'}`,
        `--emu-disable-vibrancy=${disableVibrancy ? '1' : '0'}`
      ]
    }
  })

  const resetPageZoom = () => {
    // Electron/Chromium can persist page zoom per origin across app launches.
    // Keep global page zoom pinned at 100% so Cmd+/Cmd- only changes xterm's
    // font size in the terminal area and never scales the sidebar/layout chrome.
    mainWindow.webContents.setZoomLevel(0)
    mainWindow.webContents.setZoomFactor(1)
    mainWindow.webContents.setVisualZoomLevelLimits(1, 1)
  }

  mainWindow.on('ready-to-show', () => {
    resetPageZoom()
    mainWindow.show()
  })

  // Intercept font zoom at the main process level so Electron's page zoom and
  // menu accelerators never steal these keys from the terminal.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (!input.meta || input.type !== 'keyDown') return

    const key = input.key
    const code = input.code
    const zoomDelta =
      key === '=' || key === '+' || code === 'Equal' ? 1 :
      key === '-' || code === 'Minus' ? -1 :
      key === '0' || code === 'Digit0' ? 0 :
      null

    if (zoomDelta !== null) {
      event.preventDefault()
      resetPageZoom()
      mainWindow.webContents.send('font:zoom', zoomDelta)
    }
  })

  mainWindow.webContents.on('dom-ready', resetPageZoom)

  mainWindow.webContents.on('did-finish-load', () => {
    resetPageZoom()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (isSafeExternalUrl(details.url)) shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.emu.terminal')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Create a new PTY session
  ipcMain.handle('pty:create', (event, sessionId: string, options?: PtyCreateOptions) => {
    const shell = os.platform() === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/zsh')

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    }
    // Inject prompt-spacing hook for zsh via ZDOTDIR wrapper files
    if (shell.includes('zsh')) {
      env.ZDOTDIR = setupShellIntegration()
    }

    const ptyProcess = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: normalizeSafeCwd(options?.cwd) ?? os.homedir(),
      env,
    })

    ptyProcesses.set(sessionId, ptyProcess)
    ptyPerfStats.set(sessionId, createPtyPerfStats(sessionId, ptyProcess.pid))
    const workspaceName = sanitizeWorkspaceName(options?.workspaceName)
    if (workspaceName) agentPermissionSessionWorkspaceNames.set(sessionId, workspaceName)
    const ownerWindow = BrowserWindow.fromWebContents(event.sender)
    if (ownerWindow && !ownerWindow.isDestroyed()) {
      ptyOwnerWindowIds.set(sessionId, ownerWindow.id)
    }

    // Forward PTY output to renderer
    ptyProcess.onData((data) => {
      const stats = ptyPerfStats.get(sessionId)
      const bytes = byteLength(data)
      if (stats) {
        stats.dataEvents += 1
        stats.dataBytes += bytes
        stats.lastDataAt = Date.now()
      }
      scanAgentPermissionPtyOutput(sessionId, data, ptyProcess.process ?? null)
      queuePtyOutput(sessionId, event.sender, data, bytes)
    })

    ptyProcess.onExit(() => {
      flushPtyOutputBatch(sessionId)
      ptyProcesses.delete(sessionId)
      ptyPerfStats.delete(sessionId)
      ptyOwnerWindowIds.delete(sessionId)
      clearAgentPermissionSessionState(sessionId)
      dismissAgentPermissionPromptsForSession(sessionId)
      if (!event.sender.isDestroyed()) {
        event.sender.send(`pty:exit:${sessionId}`)
      }
    })

    return { pid: ptyProcess.pid }
  })

  // Return the name of the current foreground process in a PTY session.
  // Used by the renderer to distinguish real TUI apps (vim, claude) entering
  // alt-screen from accidental entries (e.g. echo outputting \x1b[?1049h]).
  ipcMain.handle('pty:process', (_, sessionId: string) => {
    const stats = ptyPerfStats.get(sessionId)
    if (stats) stats.processPolls += 1
    return ptyProcesses.get(sessionId)?.process ?? null
  })

  ipcMain.handle('perf:getStats', () => {
    return getPerfStatsSnapshot()
  })

  ipcMain.handle('agent-permission:sessionMetadata', (_, input: unknown) => {
    if (!input || typeof input !== 'object') return
    const candidate = input as { sessionId?: unknown; workspaceName?: unknown }
    if (typeof candidate.sessionId !== 'string' || !candidate.sessionId || candidate.sessionId.length > 120) return
    const workspaceName = sanitizeWorkspaceName(candidate.workspaceName)
    if (workspaceName) {
      agentPermissionSessionWorkspaceNames.set(candidate.sessionId, workspaceName)
    } else {
      agentPermissionSessionWorkspaceNames.delete(candidate.sessionId)
    }
  })

  // Open URLs in default browser — only http/https allowed
  ipcMain.handle('shell:openExternal', (_, url: string) => {
    if (isSafeExternalUrl(url)) return shell.openExternal(url)
    return null
  })

  // Open file paths in Finder / default app — must be a real absolute path
  ipcMain.handle('shell:openPath', (_, path: string) => {
    if (isSafeOpenPath(path)) return shell.openPath(path)
    return null
  })

  ipcMain.handle('markdown:open', (_, input: MarkdownOpenInput) => {
    return readMarkdownFile(input)
  })

  ipcMain.handle('markdown:image', (_, input: MarkdownOpenInput) => {
    return readMarkdownImage(input)
  })

  ipcMain.handle('image:saveTemp', (_, dataUrl: string, suggestedName?: string) => {
    return saveTempImage(dataUrl, suggestedName)
  })

  ipcMain.handle('agent-permission:show', (event, input: unknown) => {
    debugAgentPermission('ipc-show-received')
    const prompt = sanitizeAgentPermissionPrompt(input)
    if (!prompt) {
      debugAgentPermission('ipc-show-invalid-payload')
      return
    }
    const ownerWindow = BrowserWindow.fromWebContents(event.sender)
    const ownerWindowId = ownerWindow && !ownerWindow.isDestroyed()
      ? ownerWindow.id
      : (ptyOwnerWindowIds.get(prompt.sessionId) ?? null)
    addAgentPermissionPrompt(prompt, ownerWindowId)
  })

  ipcMain.handle('agent-permission:dismissSession', (_, sessionId: string) => {
    if (typeof sessionId === 'string') dismissAgentPermissionPromptsForSession(sessionId)
  })

  ipcMain.handle('agent-permission:overlayAction', async (_, input: unknown) => {
    if (!isAgentPermissionOverlayAction(input)) return
    if (input.type === 'previous' || input.type === 'next') {
      navigateAgentPermissionPrompt(input.type)
      return
    }
    await resolveAgentPermissionPrompt(input.promptId, input.type)
  })

  // Write input to PTY
  ipcMain.on('pty:write', (_, sessionId: string, data: string) => {
    const stats = ptyPerfStats.get(sessionId)
    if (stats) {
      stats.ptyWriteEvents += 1
      stats.ptyWriteBytes += byteLength(data)
    }
    markAgentPermissionSessionFromCommand(sessionId, data)
    ptyProcesses.get(sessionId)?.write(data)
  })

  ipcMain.handle('pty:writeSequence', async (_, sessionId: string, writes: PtyWriteChunk[]): Promise<PtyWriteSequenceResult> => {
    const normalizedWrites = normalizePtyWriteChunks(writes)
    if (!normalizedWrites) return { ok: false, reason: 'invalid-input' }
    for (const write of normalizedWrites) markAgentPermissionSessionFromCommand(sessionId, write.data)
    return writePtySequence(sessionId, normalizedWrites)
  })

  // Resize PTY
  ipcMain.on('pty:resize', (_, sessionId: string, cols: number, rows: number) => {
    const stats = ptyPerfStats.get(sessionId)
    if (stats) stats.resizeEvents += 1
    ptyProcesses.get(sessionId)?.resize(cols, rows)
  })

  // Close PTY
  ipcMain.on('pty:close', (_, sessionId: string) => {
    flushPtyOutputBatch(sessionId)
    ptyProcesses.get(sessionId)?.kill()
    ptyProcesses.delete(sessionId)
    ptyPerfStats.delete(sessionId)
    ptyOwnerWindowIds.delete(sessionId)
    clearAgentPermissionSessionState(sessionId)
    dismissAgentPermissionPromptsForSession(sessionId)
  })

  createWindow()

  app.on('activate', function () {
    const appWindows = BrowserWindow.getAllWindows().filter((window) => window !== agentPermissionOverlayWindow)
    if (appWindows.length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // Kill all PTY processes on exit
  ptyProcesses.forEach((pty) => pty.kill())
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
