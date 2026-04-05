import { useState, useRef, useEffect } from 'react'
import type { Session } from '../App'
import './Sidebar.css'

interface Props {
  sessions: Session[]
  selectedId: string
  onSelect: (id: string) => void
  onNew: () => void
  onRename: (id: string, name: string) => void
  collapsed: boolean
  onToggleCollapse: () => void
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

export default function Sidebar({ sessions, selectedId, onSelect, onNew, onRename, collapsed, onToggleCollapse }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [now, setNow] = useState(() => new Date())
  const inputRef = useRef<HTMLInputElement>(null)

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
      <div className="sidebar sidebar--collapsed">
        <div className="sidebar-collapsed-actions">
          <button className="new-session-btn" onClick={onNew} title="New session">+</button>
          <button className="collapse-btn" onClick={onToggleCollapse} title="Expand sidebar">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">Emmy</span>
        <div className="sidebar-header-actions">
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
            className={`session-item ${session.id === selectedId ? 'selected' : ''}`}
            onClick={() => onSelect(session.id)}
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
                  <button className="rename-btn" onClick={(e) => startEdit(e, session)} title="Rename">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                  </button>
                </>
              )}
            </div>
            <span className="session-time">{relativeTime(session.createdAt, now)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
