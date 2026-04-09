import { useEffect } from 'react'
import './CommandHistoryDrawer.css'

export interface HistoryEntry {
  id: string
  command: string
  outputPreview: string
  outputFull: string
  line: number
  timestamp: Date
}

interface Props {
  entries: HistoryEntry[]
  onJump: (line: number) => void
  onClose: () => void
  onCopy: (entryId: string) => void
  copiedId: string | null
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

export default function CommandHistoryDrawer({ entries, onJump, onClose, onCopy, copiedId }: Props) {
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
                <div className="chd-entry-actions">
                  {entry.outputFull && (
                    <button
                      className={`chd-copy-btn${copiedId === entry.id ? ' chd-copy-btn--copied' : ''}`}
                      onClick={(e) => { e.stopPropagation(); onCopy(entry.id) }}
                      title="Copy output"
                    >
                      {copiedId === entry.id ? (
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      ) : (
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                        </svg>
                      )}
                    </button>
                  )}
                  <span className="chd-time">{relativeTime(entry.timestamp)}</span>
                </div>
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
