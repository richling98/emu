import { useEffect, useRef, useState } from 'react'
import type { TerminalTab } from '../App'
import './TopTabBar.css'

interface Props {
  tabs: TerminalTab[]
  selectedTabId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onRename: (id: string, name: string) => void
  onOpenFolder: (id: string) => void
  onDelete: (id: string) => void
}

export default function TopTabBar({ tabs, selectedTabId, onSelect, onNew, onRename, onOpenFolder, onDelete }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editingId) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editingId])

  const startEdit = (event: React.MouseEvent, tab: TerminalTab) => {
    event.stopPropagation()
    setEditingId(tab.id)
    setEditValue(tab.name)
  }

  const commitEdit = () => {
    if (editingId && editValue.trim()) {
      onRename(editingId, editValue.trim())
    }
    setEditingId(null)
  }

  return (
    <div className="top-tab-bar">
      <div className="top-tab-list">
        {tabs.map((tab) => {
          const isSelected = tab.id === selectedTabId
          return (
            <div
              key={tab.id}
              className={`top-tab${isSelected ? ' top-tab--selected' : ''}`}
              onClick={() => onSelect(tab.id)}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'copy'
                event.dataTransfer.setData('application/top-tab-id', tab.id)
              }}
            >
              {editingId === tab.id ? (
                <input
                  ref={inputRef}
                  className="top-tab-input"
                  value={editValue}
                  onChange={(event) => setEditValue(event.target.value)}
                  onBlur={commitEdit}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commitEdit()
                    if (event.key === 'Escape') setEditingId(null)
                  }}
                  onClick={(event) => event.stopPropagation()}
                />
              ) : (
                <>
                  <span className="top-tab-name">{tab.name}</span>
                  <button
                    className="top-tab-action top-tab-rename"
                    onClick={(event) => startEdit(event, tab)}
                    title="Rename project"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                  </button>
                  <button
                    className="top-tab-action top-tab-folder"
                    onClick={(event) => { event.stopPropagation(); onOpenFolder(tab.id) }}
                    title="Open folder in this project"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v1" />
                      <path d="M3 19.5 5.4 10h16L19 20H5a2 2 0 0 1-2-2.5Z" />
                    </svg>
                  </button>
                  {tabs.length > 1 && (
                    <button
                      className="top-tab-action top-tab-delete"
                      onClick={(event) => { event.stopPropagation(); onDelete(tab.id) }}
                      title="Delete project"
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  )}
                </>
              )}
            </div>
          )
        })}
      </div>
      <button className="top-tab-new" onClick={onNew} title="New project">+</button>
    </div>
  )
}
