import { useState, useCallback, useEffect, useRef } from 'react'
import Sidebar from './components/Sidebar'
import TerminalPane from './components/TerminalPane'
import SettingsModal from './components/SettingsModal'
import { getTheme, applyTheme, DEFAULT_THEME_ID } from './themes'
import './App.css'

export interface Session {
  id: string
  name: string
  createdAt: Date
  lastActiveAt: Date
  isActive: boolean
}

function createSession(): Session {
  const now = new Date()
  return {
    id: crypto.randomUUID(),
    name: now.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
    createdAt: now,
    lastActiveAt: now,
    isActive: true
  }
}

const initialSession = createSession()

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([initialSession])
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  const [selectedId, setSelectedId] = useState<string>(initialSession.id)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [openHistoryFor, setOpenHistoryFor] = useState<string | null>(null)
  const [layoutMode, setLayoutMode] = useState<'single' | 'split'>('single')
  const [rightPaneSessionId, setRightPaneSessionId] = useState<string | null>(null)
  const [splitRatio, setSplitRatio] = useState(0.5)
  const [themeId, setThemeId] = useState(() => localStorage.getItem('emmy-theme-id') ?? DEFAULT_THEME_ID)
  const [showSettings, setShowSettings] = useState(false)

  const touchSession = useCallback((id: string) => {
    const now = new Date()
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, lastActiveAt: now } : s)))
  }, [])

  const handleSelectTheme = useCallback((id: string) => {
    setThemeId(id)
    const theme = getTheme(id)
    applyTheme(theme)
    localStorage.setItem('emmy-theme-id', id)
  }, [])

  // In single mode, active pane always follows selection
  useEffect(() => {
    if (layoutMode === 'single') setActivePaneId(selectedId)
  }, [selectedId, layoutMode])

  // Track global drag state so both panes show drop zones during any drag
  const [isDragging, setIsDragging] = useState(false)
  const [dragOverLeft, setDragOverLeft] = useState(false)
  const [dragOverRight, setDragOverRight] = useState(false)
  const [activePaneId, setActivePaneId] = useState<string>(initialSession.id)

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

  // New tab appends to bottom; only auto-switches in single mode
  const handleNewSession = useCallback(() => {
    const s = createSession()
    setSessions((prev) => [...prev, s])
    if (layoutMode === 'single') {
      setSelectedId(s.id)
      setActivePaneId(s.id)
    }
  }, [layoutMode])

  const handleRename = useCallback((id: string, name: string) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, name } : s)))
  }, [])

  const handleSessionEnd = useCallback((id: string) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, isActive: false } : s)))
  }, [])

  const handleOpenHistory = useCallback((id: string) => {
    touchSession(id)
    setSelectedId(id)
    setOpenHistoryFor(id)
  }, [touchSession])

  const handleDeleteSession = useCallback((id: string) => {
    const current = sessionsRef.current
    if (current.length <= 1) return
    const remaining = current.filter((s) => s.id !== id)
    const next = [...remaining].sort((a, b) => b.lastActiveAt.getTime() - a.lastActiveAt.getTime())[0]
    setSessions(remaining)
    setSelectedId((cur) => (cur === id ? (next?.id ?? cur) : cur))
    setActivePaneId((cur) => (cur === id ? (next?.id ?? cur) : cur))
    setRightPaneSessionId((cur) => (cur === id ? null : cur))
  }, [])

  const handleSelect = useCallback((id: string) => {
    touchSession(id)
    if (layoutMode === 'split') {
      if (id === selectedId || id === rightPaneSessionId) return
      setSelectedId(id)
    } else {
      setSelectedId(id)
    }
  }, [layoutMode, selectedId, rightPaneSessionId, touchSession])

  const toggleSplitScreen = useCallback(() => {
    if (layoutMode === 'single') {
      setLayoutMode('split')
      setRightPaneSessionId(null)
    } else {
      setLayoutMode('single')
      setRightPaneSessionId(null)
    }
  }, [layoutMode])

  // Close a specific split pane:
  // • Right pane → clear it (shows "Drag a tab here" placeholder)
  // • Left pane  → if right has a session, promote it to left; otherwise exit split
  const handleCloseLeftPane = useCallback(() => {
    if (rightPaneSessionId) {
      touchSession(rightPaneSessionId)
      setSelectedId(rightPaneSessionId)
      setActivePaneId(rightPaneSessionId)
      setRightPaneSessionId(null)
    } else {
      setLayoutMode('single')
    }
  }, [rightPaneSessionId, touchSession])

  const handleCloseRightPane = useCallback(() => {
    setRightPaneSessionId(null)
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
    const sessionId = e.dataTransfer.getData('application/session-id')
    if (sessionId) {
      touchSession(sessionId)
      setSelectedId(sessionId)
      setActivePaneId(sessionId)
    }
    setDragOverLeft(false)
  }

  const handleDropRight = (e: React.DragEvent) => {
    e.preventDefault()
    const sessionId = e.dataTransfer.getData('application/session-id')
    if (sessionId) {
      touchSession(sessionId)
      setRightPaneSessionId(sessionId)
      setActivePaneId(sessionId)
    }
    setDragOverRight(false)
  }

  return (
    <div className="app">
      <div className="titlebar">
        <div className="titlebar-drag-area" />
        <div className="titlebar-actions">
          {/* Settings */}
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
          {/* Split-screen toggle */}
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
          sessions={sessions}
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
          className={`terminal-area terminal-area--${layoutMode}`}
          style={layoutMode === 'split' ? { '--split-ratio': splitRatio } as React.CSSProperties : undefined}
        >
          {sessions.map((session) => {
            const isLeftSlot = session.id === selectedId
            const isRightSlot = layoutMode === 'split' && session.id === rightPaneSessionId
            const slot = layoutMode === 'split'
              ? (isRightSlot ? 'right' : (isLeftSlot ? 'left' : 'hidden'))
              : 'full'
            return (
              <TerminalPane
                key={session.id}
                session={session}
                isVisible={isLeftSlot || isRightSlot}
                slot={slot}
                isActive={session.id === activePaneId}
                onActivate={() => {
                  touchSession(session.id)
                  setActivePaneId(session.id)
                }}
                onSessionEnd={() => handleSessionEnd(session.id)}
                openDrawer={openHistoryFor === session.id}
                onDrawerClose={() => setOpenHistoryFor(null)}
                onClosePane={isLeftSlot ? handleCloseLeftPane : isRightSlot ? handleCloseRightPane : undefined}
                onOpenSettings={() => setShowSettings(true)}
                xtermTheme={getTheme(themeId).terminal}
              />
            )
          })}

          {/* Draggable divider */}
          {layoutMode === 'split' && (
            <div className="pane-divider pane-divider--vertical" onMouseDown={handleDividerMouseDown} />
          )}

          {/* Always-available drop overlays in split mode, shown during drag */}
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

          {/* Static empty-pane placeholder when right is empty and not dragging */}
          {layoutMode === 'split' && !rightPaneSessionId && !isDragging && (
            <div
              className="empty-pane"
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); setDragOverRight(true) }}
              onDrop={handleDropRight}
            >
              Drag a tab here
            </div>
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
    </div>
  )
}
