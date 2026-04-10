import { useState, useRef, useEffect } from 'react'
import type { Session } from '../App'
import HotkeyModal from './HotkeyModal'
import AboutModal from './AboutModal'
import emuLogo from '../assets/emu-logo.png'
import './Sidebar.css'

interface Props {
  sessions: Session[]
  selectedId: string
  rightPaneSessionId?: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onRename: (id: string, name: string) => void
  collapsed: boolean
  onToggleCollapse: () => void
  onOpenHistory: (id: string) => void
}

function relativeTime(date: Date, now: Date): string {
  const secs = Math.floor((now.getTime() - date.getTime()) / 1000)
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs} hr ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

const COLLAPSE_THRESHOLD = 190
const MIN_WIDTH = 190
const MAX_WIDTH = 420

export default function Sidebar({ sessions, selectedId, rightPaneSessionId, onSelect, onNew, onRename, collapsed, onToggleCollapse, onOpenHistory }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [now, setNow] = useState(() => new Date())
  const [showHotkeys, setShowHotkeys] = useState(false)
  const [showAbout, setShowAbout] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(220)
  const inputRef = useRef<HTMLInputElement>(null)
  const collapsedRef = useRef(collapsed)
  useEffect(() => { collapsedRef.current = collapsed }, [collapsed])

  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = collapsedRef.current ? 80 : sidebarWidth
    let toggled = false

    const onMouseMove = (ev: MouseEvent) => {
      const newWidth = startWidth + (ev.clientX - startX)
      if (newWidth < COLLAPSE_THRESHOLD && !collapsedRef.current) {
        collapsedRef.current = true
        toggled = true
        onToggleCollapse()
      } else if (newWidth >= MIN_WIDTH && collapsedRef.current && toggled) {
        collapsedRef.current = false
        toggled = false
        onToggleCollapse()
        setSidebarWidth(Math.min(MAX_WIDTH, newWidth))
      } else if (!collapsedRef.current) {
        setSidebarWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, newWidth)))
      }
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

  // Refresh relative timestamps every 30 seconds
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(interval)
  }, [])

  const startEdit = (e: React.MouseEvent, session: Session) => {
    e.stopPropagation()
    setEditingId(session.id)
    setEditValue(session.name)
    setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
  }

  const commitEdit = () => {
    if (editingId && editValue.trim()) {
      onRename(editingId, editValue.trim())
    }
    setEditingId(null)
  }

  if (collapsed) {
    return (
      <>
        {showHotkeys && <HotkeyModal onClose={() => setShowHotkeys(false)} />}
        {showAbout && <AboutModal onClose={() => setShowAbout(false)} />}
        <div className="sidebar sidebar--collapsed">
          <div className="sidebar-resize-handle" onMouseDown={handleResizeStart} />
          <div className="sidebar-collapsed-actions">
            <button className="new-session-btn" onClick={onNew} title="New session">+</button>
            <button className="fire-btn" onClick={() => setShowHotkeys(true)} title="Keyboard shortcuts">🔥</button>
            <button className="collapse-btn" onClick={onToggleCollapse} title="Expand sidebar">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      {showHotkeys && <HotkeyModal onClose={() => setShowHotkeys(false)} />}
      {showAbout && <AboutModal onClose={() => setShowAbout(false)} />}
      <div className="sidebar" style={{ width: sidebarWidth, minWidth: sidebarWidth }}>
      <div className="sidebar-resize-handle" onMouseDown={handleResizeStart} />
      <div className="sidebar-header">
        <div className="sidebar-brand">
          <img src={emuLogo} alt="Emu" className="sidebar-logo" />
          <span className="sidebar-title">Emu</span>
        </div>
        <div className="sidebar-header-actions">
          <button className="fire-btn" onClick={() => setShowHotkeys(true)} title="Keyboard shortcuts">🔥</button>
          <button className="gear-btn" onClick={() => setShowAbout(true)} title="About Emu">⚙️</button>
          <button className="new-session-btn" onClick={onNew} title="New session">+</button>
          <button className="collapse-btn" onClick={onToggleCollapse} title="Collapse sidebar">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
        </div>
      </div>
      <div className="session-list">
        {sessions.map((session) => (
          <div
            key={session.id}
            className={`session-item ${session.id === selectedId || session.id === rightPaneSessionId ? 'selected' : ''}`}
            onClick={() => onSelect(session.id)}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'copy'
              e.dataTransfer.setData('application/session-id', session.id)
            }}
          >
            <div className="session-item-inner">
              {session.isActive && <span className="active-dot" />}
              {editingId === session.id ? (
                <input
                  ref={inputRef}
                  className="session-rename-input"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={commitEdit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitEdit()
                    if (e.key === 'Escape') setEditingId(null)
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <>
                  <span className="session-name">{session.name}</span>
                  <div className="session-actions">
                    <button className="history-btn" onClick={(e) => { e.stopPropagation(); onOpenHistory(session.id) }} title="Command history">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                        <line x1="3" y1="6"  x2="21" y2="6"  />
                        <line x1="3" y1="12" x2="21" y2="12" />
                        <line x1="3" y1="18" x2="21" y2="18" />
                      </svg>
                    </button>
                    <button className="rename-btn" onClick={(e) => startEdit(e, session)} title="Rename">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                      </svg>
                    </button>
                  </div>
                </>
              )}
            </div>
            <span className="session-time">{relativeTime(session.createdAt, now)}</span>
          </div>
        ))}
      </div>
    </div>
    </>
  )
}
