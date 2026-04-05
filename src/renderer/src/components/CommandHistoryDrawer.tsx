import { useEffect } from 'react'
import './CommandHistoryDrawer.css'

export interface HistoryEntry {
  id: string
  command: string
  outputPreview: string
  line: number
  timestamp: Date
}

interface Props {
  entries: HistoryEntry[]
  onJump: (line: number) => void
  onClose: () => void
}

function relativeTime(date: Date): string {
  const secs = Math.floor((Date.now() - date.getTime()) / 1000)
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export default function CommandHistoryDrawer({ entries, onJump, onClose }: Props) {
  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const reversed = [...entries].reverse()

  return (
    <div className="chd-drawer">
      <div className="chd-header">
        <div className="chd-title-group">
          <span className="chd-title">Command Log</span>
          <span className="chd-shortcut">⌘⇧L</span>
        </div>
        <button className="chd-close" onClick={onClose}>✕</button>
      </div>
      <div className="chd-list">
        {reversed.length === 0 ? (
          <div className="chd-empty">No commands yet — start typing!</div>
        ) : (
          reversed.map((entry) => (
            <div
              key={entry.id}
              className="chd-entry"
              onClick={() => { onJump(entry.line); onClose() }}
            >
              <div className="chd-entry-top">
                <span className="chd-command">$ {entry.command}</span>
                <span className="chd-time">{relativeTime(entry.timestamp)}</span>
              </div>
              {entry.outputPreview && (
                <div className="chd-preview">{entry.outputPreview}</div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
