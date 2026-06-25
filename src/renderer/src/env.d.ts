/// <reference types="vite/client" />

interface MarkdownOpenInput {
  rawPath: string
  cwd?: string | null
}

interface MarkdownDocument {
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

type MarkdownOpenResult = MarkdownDocument | MarkdownOpenFailure

type MarkdownImageResult = {
  ok: true
  dataUrl: string
  path: string
} | {
  ok: false
  error: string
}

interface PtyWriteChunk {
  data: string
  delayAfterMs?: number
}

type PtyWriteSequenceResult = {
  ok: true
} | {
  ok: false
  reason: 'not-found' | 'invalid-input'
}

type AgentPermissionProvider = 'claude' | 'codex'

interface AgentPermissionPrompt {
  id: string
  sessionId: string
  provider: AgentPermissionProvider
  workspaceName?: string
  summary: string
  detail: string
  rawExcerpt: string
  fingerprint: string
  createdAt: number
  approveAction: PtyWriteChunk[]
  denyAction: PtyWriteChunk[]
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

interface AgentPermissionSessionMetadata {
  sessionId: string
  workspaceName?: string | null
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

interface PerfStatsSnapshot {
  capturedAt: number
  process: {
    cpuPercent: number | null
    idleWakeupsPerSecond: number | null
    memory?: Record<string, number>
  }
  appMetrics: unknown[]
  totals: Omit<PtyPerfStats, 'sessionId' | 'pid' | 'createdAt' | 'lastDataAt'>
  sessions: PtyPerfStats[]
}

interface DiagnosticsConfig {
  webglEnabled: boolean
  vibrancyDisabled: boolean
  gpuForceInProcess: boolean
  gpuDisabled: boolean
}

type UpdateStatus =
  | { status: 'checking' }
  | { status: 'available'; version: string }
  | { status: 'not-available' }
  | { status: 'downloading'; percent: number }
  | { status: 'downloaded' }
  | { status: 'error'; message: string }
  | { status: 'unsupported' }

interface Window {
  api: {
    diagnosticsConfig: DiagnosticsConfig
    ptyCreate: (sessionId: string, options?: { cwd?: string | null; workspaceName?: string | null }) => Promise<{ pid: number }>
    ptyWrite: (sessionId: string, data: string) => void
    ptyWriteSequence: (sessionId: string, writes: PtyWriteChunk[]) => Promise<PtyWriteSequenceResult>
    ptyResize: (sessionId: string, cols: number, rows: number) => void
    ptyClose: (sessionId: string) => void
    onPtyData: (sessionId: string, callback: (data: string) => void) => () => void
    onPtyExit: (sessionId: string, callback: () => void) => () => void
    onFontZoom: (callback: (delta: number) => void) => () => void
    getFilePath: (file: File) => string
    openExternal: (url: string) => Promise<void>
    openPath: (path: string) => Promise<string>
    markdownOpen: (input: MarkdownOpenInput) => Promise<MarkdownOpenResult>
    markdownImage: (input: MarkdownOpenInput) => Promise<MarkdownImageResult>
    ptyGetProcess: (sessionId: string) => Promise<string | null>
    imageSaveTemp: (dataUrl: string, suggestedName?: string) => Promise<string>
    perfGetStats: () => Promise<PerfStatsSnapshot>
    agentPermissionSessionMetadata: (metadata: AgentPermissionSessionMetadata) => Promise<void>
    agentPermissionPromptShow: (prompt: AgentPermissionPrompt) => Promise<void>
    agentPermissionPromptDismissSession: (sessionId: string) => Promise<void>
    agentPermissionOverlayAction: (input: AgentPermissionOverlayAction) => Promise<void>
    onAgentPermissionOverlayState: (callback: (state: AgentPermissionOverlayState) => void) => () => void
    getAppVersion: () => Promise<string>
    checkForUpdates: () => Promise<UpdateStatus>
    downloadUpdate: () => Promise<void>
    onUpdateStatus: (callback: (status: UpdateStatus) => void) => () => void
    // Task-complete notification
    showTaskComplete: (info: { tabName: string; sessionId: string; workspaceId: string }) => Promise<void>
    taskCompleteVisit: (sessionId: string) => Promise<void>
    taskCompleteOverlayAction: (action: { type: string; notificationId?: string }) => Promise<void>
    onTaskCompleteOverlayState: (callback: (state: { notifications: Array<{ id: string; sessionId: string; tabName: string; workspaceName: string }>; activeNotificationId: string | null } | null) => void) => () => void
    onTaskCompleteChime: (callback: () => void) => () => void
    onTaskCompleteVisit: (callback: (sessionId: string) => void) => () => void
  }
}
