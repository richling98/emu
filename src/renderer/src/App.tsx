import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import Sidebar from './components/Sidebar'
import TerminalPane from './components/TerminalPane'
import TopTabBar from './components/TopTabBar'
import SettingsModal from './components/SettingsModal'
import MarkdownPopout from './components/MarkdownPopout'
import PerformanceOverlay, { type PerfOverlayModel, type PerfRow } from './components/PerformanceOverlay'
import { getTheme, applyTheme, DEFAULT_THEME_ID } from './themes'
import './App.css'

export type AgentState = 'none' | 'running' | 'idle'

export interface TerminalTab {
  id: string
  name: string
  createdAt: Date
  lastActiveAt: Date
  userSelectedAt: Date
  isActive: boolean
  agentState: AgentState
  foregroundProcess: string | null
  initialCwd: string | null
  currentCwd: string | null
}

export interface Session {
  id: string
  name: string
  autoRenameFromCwd: boolean
  createdAt: Date
  lastActiveAt: Date
  userSelectedAt: Date
  isActive: boolean
  agentState: AgentState
  foregroundProcess: string | null
  tabs: TerminalTab[]
  selectedTabId: string
  nextTopProjectNumber: number
}

type MarkdownViewMode = 'preview' | 'source'

const DEFAULT_MARKDOWN_WIDTH = 520
const MIN_MARKDOWN_WIDTH = 360
const MAX_MARKDOWN_WIDTH = 760
const MIN_TERMINAL_WIDTH = 320
const PERF_POLL_MS = 1_000
const RENDERER_PERF_KEYS = [
  'ptyDataEvents',
  'ptyDataBytes',
  'visiblePtyDataEvents',
  'visiblePtyDataBytes',
  'hiddenPtyDataEvents',
  'hiddenPtyDataBytes',
  'terminalWriteCalls',
  'terminalWriteBytes',
  'processPolls',
  'agentIdleChecks',
  'rawTuiPromptChecks',
  'commandPreviewUpdates',
  'commandFullOutputUpdates',
  'outputFlushes',
  'outputFlushLines',
  'outputFlushMs',
  'webglActivations',
  'webglContextLosses',
  'webglFailures',
  'webglDisabled',
  'hiddenBufferedBytes',
  'hiddenReplayWrites',
  'hiddenReplayBytes',
  'hiddenOmittedBytes'
] as const

type RendererPerfKey = typeof RENDERER_PERF_KEYS[number]
type RendererPerfCounters = Record<RendererPerfKey, number>

interface RendererPerfSnapshot {
  capturedAt: number
  sessions: Record<string, RendererPerfCounters>
}

interface PerfPreviousSnapshot {
  main: PerfStatsSnapshot
  renderer: RendererPerfSnapshot
}

function createRendererPerfCounters(): RendererPerfCounters {
  return RENDERER_PERF_KEYS.reduce((acc, key) => {
    acc[key] = 0
    return acc
  }, {} as RendererPerfCounters)
}

function cloneRendererPerfCounters(counters: RendererPerfCounters): RendererPerfCounters {
  return { ...counters }
}

function getRendererCounter(
  snapshot: RendererPerfSnapshot | null | undefined,
  sessionId: string,
  key: RendererPerfKey
): number {
  return snapshot?.sessions[sessionId]?.[key] ?? 0
}

function rate(current: number, previous: number, seconds: number): number {
  if (seconds <= 0) return 0
  return Math.max(0, (current - previous) / seconds)
}

function memoryMb(memory: Record<string, number> | undefined): number | null {
  if (!memory) return null
  const value = memory.privateBytes ?? memory.workingSetSize ?? memory.residentSet
  return typeof value === 'number' ? value / 1024 : null
}

function createTerminalTab(name: string, initialCwd: string | null = null): TerminalTab {
  const now = new Date()
  return {
    id: crypto.randomUUID(),
    name,
    createdAt: now,
    lastActiveAt: now,
    userSelectedAt: now,
    isActive: true,
    agentState: 'none',
    foregroundProcess: null,
    initialCwd,
    currentCwd: null
  }
}

function createSession(projectNumber: number): Session {
  const now = new Date()
  const firstTab = createTerminalTab('Project 1')
  return {
    id: crypto.randomUUID(),
    name: `Project ${projectNumber}`,
    autoRenameFromCwd: true,
    createdAt: now,
    lastActiveAt: now,
    userSelectedAt: now,
    isActive: true,
    agentState: 'none',
    foregroundProcess: null,
    tabs: [firstTab],
    selectedTabId: firstTab.id,
    nextTopProjectNumber: 2
  }
}

function getMostRecentTab(tabs: TerminalTab[]): TerminalTab | null {
  return [...tabs].sort((a, b) => b.lastActiveAt.getTime() - a.lastActiveAt.getTime())[0] ?? null
}

function folderNameFromCwd(cwd: string): string | null {
  const trimmed = cwd.trim()
  if (!trimmed) return null
  const withoutTrailingSlashes = trimmed.replace(/\/+$/, '')
  if (!withoutTrailingSlashes) return null
  const folderName = withoutTrailingSlashes.split('/').filter(Boolean).at(-1)
  return folderName || null
}

function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.closest('.xterm')) return false
  if (target.closest('.rich-input-composer__editor')) return false

  const tagName = target.tagName
  return (
    tagName === 'INPUT' ||
    tagName === 'TEXTAREA' ||
    tagName === 'SELECT' ||
    target.isContentEditable
  )
}

function summarizeSession(session: Session): Session {
  const runningTab = session.tabs.find((tab) => tab.agentState === 'running')
  const selectedTab = session.tabs.find((tab) => tab.id === session.selectedTabId) ?? getMostRecentTab(session.tabs)
  const statusTab = runningTab ?? selectedTab
  return {
    ...session,
    isActive: session.tabs.some((tab) => tab.isActive),
    agentState: runningTab ? 'running' : (statusTab?.agentState ?? 'none'),
    foregroundProcess: statusTab?.foregroundProcess ?? null,
    lastActiveAt: getMostRecentTab(session.tabs)?.lastActiveAt ?? session.lastActiveAt
  }
}

const initialSession = createSession(1)

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([initialSession])
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  const nextProjectNumberRef = useRef(2)
  const terminalAreaRef = useRef<HTMLDivElement>(null)
  const lastTouchAtByTabRef = useRef(new Map<string, number>())
  const terminalPerfRef = useRef(new Map<string, RendererPerfCounters>())
  const perfPreviousSnapshotRef = useRef<PerfPreviousSnapshot | null>(null)
  const [selectedId, setSelectedId] = useState<string>(initialSession.id)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [openHistoryFor, setOpenHistoryFor] = useState<string | null>(null)
  const [layoutMode, setLayoutMode] = useState<'single' | 'split'>('single')
  const [rightPaneTabId, setRightPaneTabId] = useState<string | null>(null)
  const [splitRatio, setSplitRatio] = useState(0.5)
  const [themeId, setThemeId] = useState(() => localStorage.getItem('emmy-theme-id') ?? DEFAULT_THEME_ID)
  const [showSettings, setShowSettings] = useState(false)
  const [markdownDocument, setMarkdownDocument] = useState<MarkdownOpenResult | null>(null)
  const [markdownCollapsed, setMarkdownCollapsed] = useState(false)
  const [markdownViewMode, setMarkdownViewMode] = useState<MarkdownViewMode>('preview')
  const [markdownWidth, setMarkdownWidth] = useState(DEFAULT_MARKDOWN_WIDTH)
  const [terminalFocusSignal, setTerminalFocusSignal] = useState(0)
  const [showPerfOverlay, setShowPerfOverlay] = useState(() =>
    import.meta.env.DEV || localStorage.getItem('emu-perf-overlay') === '1'
  )
  const [perfOverlayModel, setPerfOverlayModel] = useState<PerfOverlayModel | null>(null)
  const [perfOverlayError, setPerfOverlayError] = useState<string | null>(null)
  const markdownLayoutMode = markdownDocument
    ? (markdownCollapsed ? 'collapsed' : 'expanded')
    : 'closed'
  const terminalLayoutSignal = `${layoutMode}:${splitRatio}:${markdownLayoutMode}:${markdownWidth}`

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedId) ?? sessions[0],
    [selectedId, sessions]
  )
  const selectedTabId = selectedSession?.selectedTabId ?? null
  const sidebarSessions = useMemo(() => sessions.map(summarizeSession), [sessions])
  const allTabs = useMemo(
    () => sessions.flatMap((session) => session.tabs.map((tab) => ({ tab, workspaceId: session.id }))),
    [sessions]
  )
  const rightPaneSessionId = useMemo(() => {
    if (!rightPaneTabId) return null
    return allTabs.find((entry) => entry.tab.id === rightPaneTabId)?.workspaceId ?? null
  }, [allTabs, rightPaneTabId])

  const recordTerminalPerfEvent = useCallback((tabId: string, event: string, value = 1) => {
    if (!RENDERER_PERF_KEYS.includes(event as RendererPerfKey)) return
    let counters = terminalPerfRef.current.get(tabId)
    if (!counters) {
      counters = createRendererPerfCounters()
      terminalPerfRef.current.set(tabId, counters)
    }
    counters[event as RendererPerfKey] += value
  }, [])

  useEffect(() => {
    const handlePerfToggle = (event: KeyboardEvent) => {
      if (!event.metaKey || !event.shiftKey || event.key.toLowerCase() !== 'p') return
      if (isEditableShortcutTarget(event.target)) return
      event.preventDefault()
      setShowPerfOverlay((current) => {
        const next = !current
        localStorage.setItem('emu-perf-overlay', next ? '1' : '0')
        return next
      })
    }

    window.addEventListener('keydown', handlePerfToggle, true)
    return () => window.removeEventListener('keydown', handlePerfToggle, true)
  }, [])

  useEffect(() => {
    if (!showPerfOverlay) return
    let disposed = false

    const captureRendererSnapshot = (): RendererPerfSnapshot => {
      const sessions: RendererPerfSnapshot['sessions'] = {}
      for (const [sessionId, counters] of terminalPerfRef.current.entries()) {
        sessions[sessionId] = cloneRendererPerfCounters(counters)
      }
      return { capturedAt: Date.now(), sessions }
    }

    const buildOverlayModel = (main: PerfStatsSnapshot, renderer: RendererPerfSnapshot): PerfOverlayModel => {
      const previous = perfPreviousSnapshotRef.current
      const seconds = previous
        ? Math.max(0.001, (main.capturedAt - previous.main.capturedAt) / 1000)
        : PERF_POLL_MS / 1000
      const mainBySession = new Map(main.sessions.map((session) => [session.sessionId, session]))
      const rows: PerfRow[] = allTabs.map(({ tab }) => {
        const mainSession = mainBySession.get(tab.id)
        const previousMainSession = previous?.main.sessions.find((session) => session.sessionId === tab.id)
        const previousRenderer = previous?.renderer
        const visible = tab.id === selectedTabId || (layoutMode === 'split' && tab.id === rightPaneTabId)

        return {
          id: tab.id,
          name: tab.name,
          visible,
          mainBytesPerSec: rate(mainSession?.dataBytes ?? 0, previousMainSession?.dataBytes ?? 0, seconds),
          mainEventsPerSec: rate(mainSession?.dataEvents ?? 0, previousMainSession?.dataEvents ?? 0, seconds),
          ipcPerSec: rate(mainSession?.ipcMessages ?? 0, previousMainSession?.ipcMessages ?? 0, seconds),
          rendererBytesPerSec: rate(
            getRendererCounter(renderer, tab.id, 'ptyDataBytes'),
            getRendererCounter(previousRenderer, tab.id, 'ptyDataBytes'),
            seconds
          ),
          hiddenBytesPerSec: rate(
            getRendererCounter(renderer, tab.id, 'hiddenPtyDataBytes'),
            getRendererCounter(previousRenderer, tab.id, 'hiddenPtyDataBytes'),
            seconds
          ),
          terminalWritesPerSec: rate(
            getRendererCounter(renderer, tab.id, 'terminalWriteCalls'),
            getRendererCounter(previousRenderer, tab.id, 'terminalWriteCalls'),
            seconds
          ),
          processPollsPerSec: rate(
            (mainSession?.processPolls ?? 0) + getRendererCounter(renderer, tab.id, 'processPolls'),
            (previousMainSession?.processPolls ?? 0) + getRendererCounter(previousRenderer, tab.id, 'processPolls'),
            seconds
          ),
          outputFlushesPerSec: rate(
            getRendererCounter(renderer, tab.id, 'outputFlushes'),
            getRendererCounter(previousRenderer, tab.id, 'outputFlushes'),
            seconds
          ),
          totalMainBytes: mainSession?.dataBytes ?? 0,
          totalRendererBytes: getRendererCounter(renderer, tab.id, 'ptyDataBytes')
        }
      }).sort((a, b) => (
        b.rendererBytesPerSec + b.mainBytesPerSec + b.terminalWritesPerSec -
        (a.rendererBytesPerSec + a.mainBytesPerSec + a.terminalWritesPerSec)
      ))

      const previousMain = previous?.main
      const previousRenderer = previous?.renderer
      const rendererTotal = (key: RendererPerfKey) =>
        Object.keys(renderer.sessions).reduce((sum, sessionId) => sum + getRendererCounter(renderer, sessionId, key), 0)
      const previousRendererTotal = (key: RendererPerfKey) =>
        previousRenderer ? Object.keys(previousRenderer.sessions).reduce((sum, sessionId) => sum + getRendererCounter(previousRenderer, sessionId, key), 0) : 0
      const webglActivations = rendererTotal('webglActivations')
      const webglFailures = rendererTotal('webglFailures')
      const webglContextLosses = rendererTotal('webglContextLosses')
      const webglDisabled = rendererTotal('webglDisabled')
      const webglStatus =
        webglActivations > 0 ? 'on' :
          webglFailures > 0 ? 'failed' :
            webglDisabled > 0 ? 'off' :
              'pending'

      return {
        capturedAt: main.capturedAt,
        mainCpuPercent: main.process.cpuPercent,
        mainMemoryMb: memoryMb(main.process.memory),
        webglStatus,
        webglActivations,
        webglFailures,
        webglContextLosses,
        webglDisabled,
        vibrancyDisabled: window.api.diagnosticsConfig.vibrancyDisabled,
        activePtys: main.sessions.length,
        totalMainBytesPerSec: rate(main.totals.dataBytes, previousMain?.totals.dataBytes ?? 0, seconds),
        totalMainEventsPerSec: rate(main.totals.dataEvents, previousMain?.totals.dataEvents ?? 0, seconds),
        totalIpcPerSec: rate(main.totals.ipcMessages, previousMain?.totals.ipcMessages ?? 0, seconds),
        totalRendererBytesPerSec: rate(rendererTotal('ptyDataBytes'), previousRendererTotal('ptyDataBytes'), seconds),
        totalHiddenBytesPerSec: rate(rendererTotal('hiddenPtyDataBytes'), previousRendererTotal('hiddenPtyDataBytes'), seconds),
        totalTerminalWritesPerSec: rate(rendererTotal('terminalWriteCalls'), previousRendererTotal('terminalWriteCalls'), seconds),
        totalProcessPollsPerSec: rate(
          main.totals.processPolls + rendererTotal('processPolls'),
          (previousMain?.totals.processPolls ?? 0) + previousRendererTotal('processPolls'),
          seconds
        ),
        totalOutputFlushesPerSec: rate(rendererTotal('outputFlushes'), previousRendererTotal('outputFlushes'), seconds),
        rows
      }
    }

    const poll = async () => {
      try {
        if (typeof window.api.perfGetStats !== 'function') {
          throw new Error('Performance diagnostics are missing from the preload API. Restart Emu so the updated main/preload process is running.')
        }
        const [main, renderer] = await Promise.all([
          window.api.perfGetStats(),
          Promise.resolve(captureRendererSnapshot())
        ])
        if (disposed) return
        const model = buildOverlayModel(main, renderer)
        setPerfOverlayModel(model)
        setPerfOverlayError(null)
        perfPreviousSnapshotRef.current = { main, renderer }
      } catch (err) {
        if (!disposed) {
          setPerfOverlayModel(null)
          setPerfOverlayError(err instanceof Error ? err.message : 'Performance diagnostics failed.')
        }
      }
    }

    void poll()
    const interval = window.setInterval(() => { void poll() }, PERF_POLL_MS)
    return () => {
      disposed = true
      window.clearInterval(interval)
    }
  }, [allTabs, layoutMode, rightPaneTabId, selectedTabId, showPerfOverlay])

  const clampMarkdownWidth = useCallback((width: number) => {
    const areaWidth = terminalAreaRef.current?.getBoundingClientRect().width ?? window.innerWidth
    const maxByArea = Math.max(MIN_MARKDOWN_WIDTH, areaWidth - MIN_TERMINAL_WIDTH)
    const maxWidth = Math.min(MAX_MARKDOWN_WIDTH, maxByArea)
    return Math.min(Math.max(width, MIN_MARKDOWN_WIDTH), maxWidth)
  }, [])

  const touchTab = useCallback((tabId: string) => {
    const nowMs = Date.now()
    const lastTouchAt = lastTouchAtByTabRef.current.get(tabId) ?? 0
    if (nowMs - lastTouchAt < 1_000) return
    lastTouchAtByTabRef.current.set(tabId, nowMs)
    const now = new Date(nowMs)
    setSessions((prev) => prev.map((session) => {
      if (!session.tabs.some((tab) => tab.id === tabId)) return session
      return {
        ...session,
        lastActiveAt: now,
        tabs: session.tabs.map((tab) => (tab.id === tabId ? { ...tab, lastActiveAt: now } : tab))
      }
    }))
  }, [])

  const selectSession = useCallback((id: string) => {
    const now = new Date()
    setSessions((prev) => prev.map((session) => (
      session.id === id ? { ...session, lastActiveAt: now, userSelectedAt: now } : session
    )))
  }, [])

  const selectTopTab = useCallback((tabId: string) => {
    const workspace = sessionsRef.current.find((session) => session.tabs.some((tab) => tab.id === tabId))
    if (!workspace) return
    const now = new Date()
    setSessions((prev) => prev.map((session) => {
      if (session.id !== workspace.id) return session
      return {
        ...session,
        selectedTabId: tabId,
        lastActiveAt: now,
        userSelectedAt: now,
        tabs: session.tabs.map((tab) => (
          tab.id === tabId ? { ...tab, lastActiveAt: now, userSelectedAt: now } : tab
        ))
      }
    }))
    setSelectedId(workspace.id)
    setActivePaneId(tabId)
  }, [])

  useEffect(() => {
    const handleTopTabShortcut = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.metaKey || event.altKey || event.key !== 'Tab') return
      if (isEditableShortcutTarget(event.target)) return

      const tabs = selectedSession?.tabs ?? []
      if (tabs.length <= 1) return

      event.preventDefault()
      event.stopPropagation()

      const selectedIndex = selectedTabId
        ? tabs.findIndex((tab) => tab.id === selectedTabId)
        : -1
      const currentIndex = selectedIndex >= 0 ? selectedIndex : 0
      const direction = event.shiftKey ? -1 : 1
      const nextIndex = (currentIndex + direction + tabs.length) % tabs.length
      selectTopTab(tabs[nextIndex].id)
    }

    window.addEventListener('keydown', handleTopTabShortcut, true)
    return () => window.removeEventListener('keydown', handleTopTabShortcut, true)
  }, [selectedSession, selectedTabId, selectTopTab])

  const getSelectedTabIdForWorkspace = useCallback((workspaceId: string): string | null => {
    const workspace = sessionsRef.current.find((session) => session.id === workspaceId)
    return workspace?.selectedTabId ?? workspace?.tabs[0]?.id ?? null
  }, [])

  const getDroppedTabId = useCallback((event: React.DragEvent): string | null => {
    const tabId = event.dataTransfer.getData('application/top-tab-id')
    if (tabId) return tabId
    const workspaceId = event.dataTransfer.getData('application/session-id')
    if (workspaceId) return getSelectedTabIdForWorkspace(workspaceId)
    return null
  }, [getSelectedTabIdForWorkspace])

  const handleSelectTheme = useCallback((id: string) => {
    setThemeId(id)
    const theme = getTheme(id)
    applyTheme(theme)
    localStorage.setItem('emmy-theme-id', id)
  }, [])

  // In single mode, active pane always follows the selected workspace's selected top tab.
  useEffect(() => {
    if (layoutMode === 'single' && selectedTabId) setActivePaneId(selectedTabId)
  }, [selectedTabId, layoutMode])

  const [isDragging, setIsDragging] = useState(false)
  const [dragOverLeft, setDragOverLeft] = useState(false)
  const [dragOverRight, setDragOverRight] = useState(false)
  const [activePaneId, setActivePaneId] = useState<string>(initialSession.selectedTabId)

  useEffect(() => {
    const onDragStart = () => setIsDragging(true)
    const onDragEnd = () => { setIsDragging(false); setDragOverLeft(false); setDragOverRight(false) }
    window.addEventListener('dragstart', onDragStart)
    window.addEventListener('dragend', onDragEnd)
    return () => {
      window.removeEventListener('dragstart', onDragStart)
      window.removeEventListener('dragend', onDragEnd)
    }
  }, [])

  const handleNewSession = useCallback(() => {
    const projectNumber = nextProjectNumberRef.current
    nextProjectNumberRef.current += 1
    const session = createSession(projectNumber)
    setSessions((prev) => [...prev, session])
    if (layoutMode === 'single') {
      setSelectedId(session.id)
      setActivePaneId(session.selectedTabId)
    }
  }, [layoutMode])

  const handleNewTopTab = useCallback(() => {
    const workspace = selectedSession
    if (!workspace) return
    const activeTab = workspace.tabs.find((tab) => tab.id === workspace.selectedTabId) ?? workspace.tabs[0]
    const firstTab = workspace.tabs[0]
    const initialCwd = firstTab?.currentCwd ?? activeTab?.currentCwd ?? firstTab?.initialCwd ?? null
    const tab = createTerminalTab(`Project ${workspace.nextTopProjectNumber}`, initialCwd)
    setSessions((prev) => prev.map((session) => (
      session.id === workspace.id
        ? {
            ...session,
            selectedTabId: tab.id,
            nextTopProjectNumber: session.nextTopProjectNumber + 1,
            lastActiveAt: tab.lastActiveAt,
            userSelectedAt: tab.userSelectedAt,
            tabs: [...session.tabs, tab]
          }
        : session
    )))
    setActivePaneId(tab.id)
  }, [selectedSession])

  const handleRename = useCallback((id: string, name: string) => {
    setSessions((prev) => prev.map((session) => (
      session.id === id ? { ...session, name, autoRenameFromCwd: false } : session
    )))
  }, [])

  const handleRenameTopTab = useCallback((id: string, name: string) => {
    setSessions((prev) => prev.map((session) => (
      session.tabs.some((tab) => tab.id === id)
        ? { ...session, tabs: session.tabs.map((tab) => (tab.id === id ? { ...tab, name } : tab)) }
        : session
    )))
  }, [])

  const handleSessionEnd = useCallback((id: string) => {
    setSessions((prev) => prev.map((session) => (
      session.tabs.some((tab) => tab.id === id)
        ? {
            ...session,
            tabs: session.tabs.map((tab) => (
              tab.id === id ? { ...tab, isActive: false, agentState: 'none', foregroundProcess: null } : tab
            ))
          }
        : session
    )))
  }, [])

  const handleAgentStateChange = useCallback((id: string, agentState: AgentState, foregroundProcess: string | null = null) => {
    setSessions((prev) => prev.map((session) => (
      session.tabs.some((tab) => tab.id === id)
        ? {
            ...session,
            tabs: session.tabs.map((tab) => (
              tab.id === id && (tab.agentState !== agentState || tab.foregroundProcess !== foregroundProcess)
                ? { ...tab, agentState, foregroundProcess }
                : tab
            ))
          }
        : session
    )))
  }, [])

  const handleCurrentCwdChange = useCallback((id: string, currentCwd: string) => {
    setSessions((prev) => prev.map((session) => {
      if (!session.tabs.some((tab) => tab.id === id)) return session

      let tabChanged = false
      const tabs = session.tabs.map((tab) => {
        if (tab.id !== id || tab.currentCwd === currentCwd) return tab
        tabChanged = true
        return { ...tab, currentCwd }
      })
      const nextName = session.autoRenameFromCwd
        ? (folderNameFromCwd(currentCwd) ?? session.name)
        : session.name

      if (!tabChanged && nextName === session.name) return session
      return { ...session, name: nextName, tabs }
    }))
  }, [])

  const handleOpenHistory = useCallback((workspaceId: string) => {
    const tabId = getSelectedTabIdForWorkspace(workspaceId)
    if (!tabId) return
    touchTab(tabId)
    setSelectedId(workspaceId)
    setActivePaneId(tabId)
    setOpenHistoryFor(tabId)
  }, [getSelectedTabIdForWorkspace, touchTab])

  const restoreActiveTerminalFocus = useCallback(() => {
    setTerminalFocusSignal((value) => value + 1)
  }, [])

  const handleOpenMarkdown = useCallback((result: MarkdownOpenResult) => {
    setMarkdownDocument((current) => {
      if (!current || !current.ok || !result.ok || current.path !== result.path) {
        setMarkdownViewMode('preview')
      }
      return result
    })
    setMarkdownCollapsed(false)
  }, [])

  const handleMarkdownResizeStart = useCallback((clientX: number) => {
    const startX = clientX
    const startWidth = markdownWidth
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const onPointerMove = (event: PointerEvent) => {
      setMarkdownWidth(clampMarkdownWidth(startWidth + startX - event.clientX))
    }

    const onPointerUp = () => {
      document.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerup', onPointerUp)
      document.removeEventListener('pointercancel', onPointerUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setMarkdownWidth((width) => clampMarkdownWidth(width))
    }

    document.addEventListener('pointermove', onPointerMove)
    document.addEventListener('pointerup', onPointerUp)
    document.addEventListener('pointercancel', onPointerUp)
  }, [clampMarkdownWidth, markdownWidth])

  useEffect(() => {
    const onResize = () => setMarkdownWidth((width) => clampMarkdownWidth(width))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [clampMarkdownWidth])

  const handleDeleteTopTab = useCallback((id: string) => {
    const workspace = sessionsRef.current.find((session) => session.tabs.some((tab) => tab.id === id))
    if (!workspace || workspace.tabs.length <= 1) return
    const remaining = workspace.tabs.filter((tab) => tab.id !== id)
    const nextTab = getMostRecentTab(remaining) ?? remaining[0]
    setSessions((prev) => prev.map((session) => (
      session.id === workspace.id
        ? {
            ...session,
            selectedTabId: session.selectedTabId === id ? nextTab.id : session.selectedTabId,
            tabs: remaining
          }
        : session
    )))
    terminalPerfRef.current.delete(id)
    setActivePaneId((current) => (current === id ? nextTab.id : current))
    setRightPaneTabId((current) => (current === id ? null : current))
    setOpenHistoryFor((current) => (current === id ? null : current))
  }, [])

  const handleDeleteSession = useCallback((id: string) => {
    const current = sessionsRef.current
    if (current.length <= 1) return
    const deleted = current.find((session) => session.id === id)
    const deletedTabIds = new Set(deleted?.tabs.map((tab) => tab.id) ?? [])
    const remaining = current.filter((session) => session.id !== id)
    const next = [...remaining].sort((a, b) => b.lastActiveAt.getTime() - a.lastActiveAt.getTime())[0]
    deletedTabIds.forEach((tabId) => terminalPerfRef.current.delete(tabId))
    setSessions(remaining)
    setSelectedId((cur) => (cur === id ? (next?.id ?? cur) : cur))
    setActivePaneId((cur) => (deletedTabIds.has(cur) ? (next?.selectedTabId ?? cur) : cur))
    setRightPaneTabId((cur) => (cur && deletedTabIds.has(cur) ? null : cur))
    setOpenHistoryFor((cur) => (cur && deletedTabIds.has(cur) ? null : cur))
  }, [])

  const handleSelect = useCallback((id: string) => {
    const tabId = getSelectedTabIdForWorkspace(id)
    selectSession(id)
    setSelectedId(id)
    if (tabId) setActivePaneId(tabId)
  }, [getSelectedTabIdForWorkspace, selectSession])

  const toggleSplitScreen = useCallback(() => {
    if (layoutMode === 'single') {
      setLayoutMode('split')
      setRightPaneTabId(null)
    } else {
      setLayoutMode('single')
      setRightPaneTabId(null)
    }
  }, [layoutMode])

  const handleCloseLeftPane = useCallback(() => {
    if (rightPaneTabId) {
      const workspace = sessionsRef.current.find((session) => session.tabs.some((tab) => tab.id === rightPaneTabId))
      if (workspace) {
        selectSession(workspace.id)
        setSessions((prev) => prev.map((session) => (
          session.id === workspace.id ? { ...session, selectedTabId: rightPaneTabId } : session
        )))
        setSelectedId(workspace.id)
        setActivePaneId(rightPaneTabId)
      }
      setRightPaneTabId(null)
    } else {
      setLayoutMode('single')
    }
  }, [rightPaneTabId, selectSession])

  const handleCloseRightPane = useCallback(() => {
    setRightPaneTabId(null)
  }, [])

  const handleDividerMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    const area = (e.currentTarget as HTMLElement).parentElement!
    const areaRect = area.getBoundingClientRect()

    const onMouseMove = (ev: MouseEvent) => {
      const ratio = (ev.clientX - areaRect.left) / areaRect.width
      setSplitRatio(Math.min(Math.max(ratio, 0.2), 0.8))
    }
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  const handleDropLeft = (e: React.DragEvent) => {
    e.preventDefault()
    const tabId = getDroppedTabId(e)
    if (tabId) selectTopTab(tabId)
    setDragOverLeft(false)
  }

  const handleDropRight = (e: React.DragEvent) => {
    e.preventDefault()
    const tabId = getDroppedTabId(e)
    if (tabId) {
      setRightPaneTabId(tabId)
      setActivePaneId(tabId)
    }
    setDragOverRight(false)
  }

  return (
    <div className="app">
      <div className="titlebar">
        <div className="titlebar-drag-area" />
        <div className="titlebar-actions">
          <button
            className={`layout-btn${showSettings ? ' active' : ''}`}
            onClick={() => setShowSettings((v) => !v)}
            title="Settings"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6l-.04.1a2 2 0 0 1-3.92 0L10 20a1.7 1.7 0 0 0-1-.6 1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1l-.1-.04a2 2 0 0 1 0-3.92L4 10a1.7 1.7 0 0 0 .6-1 1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6l.04-.1a2 2 0 0 1 3.92 0L14 4a1.7 1.7 0 0 0 1 .6 1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.18.37.45.7.8 1l.1.04a2 2 0 0 1 0 3.92l-.1.04c-.35.3-.62.63-.8 1Z" />
            </svg>
          </button>
          <button
            className={`layout-btn ${layoutMode === 'split' ? 'active' : ''}`}
            onClick={toggleSplitScreen}
            title="Toggle split-screen"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="1" y="1" width="14" height="14" rx="2" stroke="currentColor" strokeWidth="1.5"/>
              <line x1="8" y1="1" x2="8" y2="15" stroke="currentColor" strokeWidth="1.5"/>
            </svg>
          </button>
        </div>
      </div>
      <div className="app-body">
        <Sidebar
          sessions={sidebarSessions}
          selectedId={selectedId}
          rightPaneSessionId={rightPaneSessionId}
          onSelect={handleSelect}
          onNew={handleNewSession}
          onRename={handleRename}
          onDelete={handleDeleteSession}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed((v) => !v)}
          onOpenHistory={handleOpenHistory}
        />
        <div
          ref={terminalAreaRef}
          className={`terminal-area terminal-area--${layoutMode} terminal-area--markdown-${markdownLayoutMode}`}
          style={{
            ...(layoutMode === 'split' ? { '--split-ratio': splitRatio } : {}),
            '--markdown-popout-width': `${markdownWidth}px`
          } as React.CSSProperties}
        >
          <TopTabBar
            tabs={selectedSession?.tabs ?? []}
            selectedTabId={selectedTabId}
            onSelect={selectTopTab}
            onNew={handleNewTopTab}
            onRename={handleRenameTopTab}
            onDelete={handleDeleteTopTab}
          />

          {allTabs.map(({ tab }) => {
            const isLeftSlot = tab.id === selectedTabId
            const isRightSlot = layoutMode === 'split' && tab.id === rightPaneTabId
            const slot = layoutMode === 'split'
              ? (isRightSlot ? 'right' : (isLeftSlot ? 'left' : 'hidden'))
              : (isLeftSlot ? 'full' : 'hidden')
            return (
              <TerminalPane
                key={tab.id}
                session={tab}
                isVisible={isLeftSlot || isRightSlot}
                slot={slot}
                isActive={tab.id === activePaneId}
                onActivate={() => {
                  touchTab(tab.id)
                  setActivePaneId(tab.id)
                }}
                onSessionTouched={() => touchTab(tab.id)}
                onAgentStateChange={(agentState, foregroundProcess) => handleAgentStateChange(tab.id, agentState, foregroundProcess)}
                onCurrentCwdChange={(cwd) => handleCurrentCwdChange(tab.id, cwd)}
                onSessionEnd={() => handleSessionEnd(tab.id)}
                openDrawer={openHistoryFor === tab.id}
                onDrawerClose={() => setOpenHistoryFor(null)}
                onClosePane={isLeftSlot ? handleCloseLeftPane : isRightSlot ? handleCloseRightPane : undefined}
                onOpenMarkdown={handleOpenMarkdown}
                onPerfEvent={recordTerminalPerfEvent}
                focusSignal={terminalFocusSignal}
                layoutSignal={terminalLayoutSignal}
                xtermTheme={getTheme(themeId).terminal}
              />
            )
          })}

          {layoutMode === 'split' && (
            <div className="pane-divider pane-divider--vertical" onMouseDown={handleDividerMouseDown} />
          )}

          {layoutMode === 'split' && isDragging && (
            <>
              <div
                className={`pane-drop-overlay pane-drop-overlay--left ${dragOverLeft ? 'drag-over' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setDragOverLeft(true) }}
                onDragLeave={() => setDragOverLeft(false)}
                onDrop={handleDropLeft}
              />
              <div
                className={`pane-drop-overlay pane-drop-overlay--right ${dragOverRight ? 'drag-over' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setDragOverRight(true) }}
                onDragLeave={() => setDragOverRight(false)}
                onDrop={handleDropRight}
              />
            </>
          )}

          {layoutMode === 'split' && !rightPaneTabId && !isDragging && (
            <div
              className="empty-pane"
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); setDragOverRight(true) }}
              onDrop={handleDropRight}
            >
              Drag a project tab here
            </div>
          )}
          {markdownDocument && (
            <MarkdownPopout
              document={markdownDocument}
              collapsed={markdownCollapsed}
              viewMode={markdownViewMode}
              onViewModeChange={setMarkdownViewMode}
              onCollapse={() => setMarkdownCollapsed(true)}
              onExpand={() => setMarkdownCollapsed(false)}
              onClose={() => setMarkdownDocument(null)}
              onOpenResult={handleOpenMarkdown}
              onRestoreFocus={restoreActiveTerminalFocus}
              onResizeStart={handleMarkdownResizeStart}
            />
          )}
        </div>
      </div>
      {showSettings && (
        <SettingsModal
          activeThemeId={themeId}
          onSelectTheme={handleSelectTheme}
          onClose={() => setShowSettings(false)}
        />
      )}
      {showPerfOverlay && (
        <PerformanceOverlay
          model={perfOverlayModel}
          error={perfOverlayError}
          onClose={() => {
            localStorage.setItem('emu-perf-overlay', '0')
            setShowPerfOverlay(false)
          }}
        />
      )}
    </div>
  )
}
