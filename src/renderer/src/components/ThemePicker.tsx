import { useEffect } from 'react'
import { THEMES } from '../themes'
import './ThemePicker.css'

interface Props {
  activeThemeId: string
  onSelect: (id: string) => void
  onClose: () => void
}

export default function ThemePicker({ activeThemeId, onSelect, onClose }: Props) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div className="tp-overlay" onClick={onClose}>
      <div className="tp-modal" onClick={(e) => e.stopPropagation()}>
        <div className="tp-header">
          <span className="tp-title">Color Theme</span>
          <button className="tp-close" onClick={onClose}>✕</button>
        </div>
        <div className="tp-grid">
          {THEMES.map((theme) => (
            <button
              key={theme.id}
              className={`tp-swatch${activeThemeId === theme.id ? ' tp-swatch--active' : ''}`}
              style={{
                '--sw-bg': theme.bgBase,
                '--sw-accent': theme.accent,
                '--sw-accent-alt': theme.accentAlt,
              } as React.CSSProperties}
              onClick={() => { onSelect(theme.id); onClose() }}
              title={theme.name}
            >
              {/* Mini terminal lines — suggest code content */}
              <div className="tp-swatch-lines">
                <span className="tp-line tp-line--long" />
                <span className="tp-line tp-line--med" />
                <span className="tp-line tp-line--short" />
              </div>
              {/* Accent strip at the bottom */}
              <div className="tp-swatch-strip" />
              {/* Active checkmark */}
              {activeThemeId === theme.id && (
                <div className="tp-swatch-check">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
              )}
            </button>
          ))}
        </div>
        {/* Labels row — separate from the buttons so grid layout stays clean */}
        <div className="tp-labels">
          {THEMES.map((theme) => (
            <span
              key={theme.id}
              className={`tp-label${activeThemeId === theme.id ? ' tp-label--active' : ''}`}
            >
              {theme.name}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
