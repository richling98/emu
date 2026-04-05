import { useState, useCallback } from 'react'
import Sidebar from './components/Sidebar'
import TerminalPane from './components/TerminalPane'
import './App.css'

export interface Session {
  id: string
  name: string
  createdAt: Date
  isActive: boolean
}

function createSession(): Session {
  const now = new Date()
  return {
    id: crypto.randomUUID(),
    name: now.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
    createdAt: now,
    isActive: true
  }
}

const initialSession = createSession()

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([initialSession])
  const [selectedId, setSelectedId] = useState<string>(initialSession.id)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  const handleNewSession = useCallback(() => {
    const s = createSession()
    setSessions((prev) => [s, ...prev])
    setSelectedId(s.id)
  }, [])

  const handleRename = useCallback((id: string, name: string) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, name } : s)))
  }, [])

  const handleSessionEnd = useCallback((id: string) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, isActive: false } : s)))
  }, [])

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onNew={handleNewSession}
        onRename={handleRename}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed((v) => !v)}
      />
      <div className="terminal-area">
        {sessions.map((session) => (
          <TerminalPane
            key={session.id}
            session={session}
            isVisible={session.id === selectedId}
            onSessionEnd={() => handleSessionEnd(session.id)}
          />
        ))}
      </div>
    </div>
  )
}
