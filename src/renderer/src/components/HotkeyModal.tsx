import './HotkeyModal.css'

interface Props {
  onClose: () => void
}

const SECTIONS = [
  {
    title: 'Emmy',
    rows: [
      { keys: ['⌘', '='], label: 'Zoom in' },
      { keys: ['⌘', '−'], label: 'Zoom out' },
      { keys: ['⌘', '0'], label: 'Reset zoom' },
      { keys: ['⌘', 'N'], label: 'New session' },
      { keys: ['⌘', '⇧', 'L'], label: 'Command log' },
      { keys: ['⌘', '↑'], label: 'Jump to previous prompt' },
      { keys: ['⌘', '↓'], label: 'Jump to next prompt' },
    ]
  },
  {
    title: 'Edit',
    rows: [
      { keys: ['⌘', 'C'], label: 'Copy selection' },
      { keys: ['⌘', 'V'], label: 'Paste' },
      { keys: ['⌘', 'K'], label: 'Clear screen' },
      { keys: ['⌃', 'C'], label: 'Interrupt / cancel' },
      { keys: ['⌃', 'D'], label: 'Send EOF / logout' },
      { keys: ['⌃', 'L'], label: 'Clear screen' },
      { keys: ['⌃', 'U'], label: 'Delete to start of line' },
      { keys: ['⌃', 'W'], label: 'Delete word backward' },
      { keys: ['⌃', 'K'], label: 'Delete to end of line' },
    ]
  },
  {
    title: 'Navigation',
    rows: [
      { keys: ['⌃', 'A'], label: 'Move to start of line' },
      { keys: ['⌃', 'E'], label: 'Move to end of line' },
      { keys: ['⌃', 'B'], label: 'Move back one character' },
      { keys: ['⌃', 'F'], label: 'Move forward one character' },
      { keys: ['⌥', '←'], label: 'Move back one word' },
      { keys: ['⌥', '→'], label: 'Move forward one word' },
    ]
  },
  {
    title: 'History',
    rows: [
      { keys: ['↑'], label: 'Previous command' },
      { keys: ['↓'], label: 'Next command' },
      { keys: ['⌃', 'R'], label: 'Search history' },
      { keys: ['⌃', 'G'], label: 'Cancel history search' },
    ]
  }
]

export default function HotkeyModal({ onClose }: Props) {
  return (
    <div className="hotkey-overlay" onClick={onClose}>
      <div className="hotkey-modal" onClick={(e) => e.stopPropagation()}>
        <div className="hotkey-modal-header">
          <span className="hotkey-modal-title">Keyboard Shortcuts</span>
          <button className="hotkey-close-btn" onClick={onClose}>✕</button>
        </div>
        <div className="hotkey-modal-body">
          {SECTIONS.map((section) => (
            <div key={section.title} className="hotkey-section">
              <div className="hotkey-section-title">{section.title}</div>
              {section.rows.map((row) => (
                <div key={row.label} className="hotkey-row">
                  <span className="hotkey-label">{row.label}</span>
                  <span className="hotkey-keys">
                    {row.keys.map((k, i) => (
                      <span key={i}>
                        <kbd className="kbd">{k}</kbd>
                        {i < row.keys.length - 1 && <span className="kbd-plus">+</span>}
                      </span>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
