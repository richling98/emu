import './AboutModal.css'

interface Props {
  onClose: () => void
}

const FEATURE_FEATURES = [
  { title: 'Split-Screen Mode', desc: 'Two terminals, side-by-side. Drag the divider to resize, drop any tab into either pane, and work on two things at once without ever leaving Emmy.' },
  { title: 'Highlight-to-Delete', desc: 'Select any text in the terminal, then press backspace to delete exactly that many characters. Surgical edits without hunting for the right position.' },
  { title: 'Unlimited Tabs', desc: 'Spin up as many named tabs as you need. Each gets its own PTY, timestamps, and history. Rename any tab inline with a simple double-click.' },
  { title: 'Command Log', desc: '⌘⇧L opens a searchable, time-stamped log of every command you\'ve run — with output previews and one-click jump-to. Your full terminal history, always at hand.' },
  { title: 'Output Copy Button', desc: 'Every entry in the Command Log has a clipboard icon that copies the full output of that command to your clipboard in one click — clean text, no ANSI codes, no shell artifacts.' },
  { title: 'Jump to Prompt', desc: '⌘↑ / ⌘↓ lets you fly through your scrollback history one command at a time, jumping straight to each prompt so you can review output without losing your place.' },
  { title: 'Clickable Links & Paths', desc: 'Every URL and bare domain (nvidia.com, perplexity.ai) is Cmd+clickable and opens in your browser. Any /absolute or ./relative file path opens directly in Finder. No copying, no switching apps.' },
  { title: 'Multi-Line Paste', desc: 'Paste a block of commands and Emmy hands them to your shell as a unit — all lines land intact, waiting for a single Enter. Exactly how a real terminal should handle it.' },
  { title: 'Tab Drag & Drop', desc: 'In split mode, drag any session tab from the sidebar and drop it onto either pane to instantly reassign it. Rearrange your workspace in one motion.' },
  { title: 'GPU Rendering', desc: 'WebGL-accelerated text rendering with Retina support. Every character is razor-sharp at any font size, and scrolling is silky smooth even in dense output.' },
  { title: 'Font Zoom', desc: '⌘+ / ⌘− scales the terminal font instantly. ⌘0 snaps back to default. The layout auto-fits so your PTY always matches the visible terminal size.' },
]

const BEAUTY_FEATURES = [
  { title: 'Frosted Glass UI', desc: 'Vibrancy on the sidebar and titlebar — layered blur, saturation, and brightness that respond to your desktop in real time for a truly native macOS feel.' },
  { title: 'Catppuccin Mocha', desc: 'A hand-tuned Catppuccin Mocha theme with lavender highlights, warm magentas, and sky blues. Every color has a purpose and nothing fights for attention.' },
  { title: 'Premium Typography', desc: 'JetBrains Mono at pixel-perfect sizing — integer font size, 1.0 line height, zero letter-spacing — so characters never droop, blur, or crowd each other.' },
  { title: 'Unfocused Split Dimming', desc: 'When two panes are open, the inactive one dims back — giving an instant, clear focus signal. Click any pane to bring it to life. Hotkeys always go to whichever pane you\'re on.' },
  { title: 'Rotating Greetings', desc: '20+ welcome banners that pick a fresh message every session. A small touch that makes opening a new tab feel like a moment, not a chore.' },
  { title: 'Full-Width Title Bar', desc: 'Drag Emmy from anywhere along the top edge — the entire title bar is a drag target, just like a native macOS app.' },
  { title: 'Relative Timestamps', desc: 'Session tabs show human-friendly creation times. You\'ll always know which session you opened this morning vs. last week.' },
  { title: 'Smooth Animations', desc: 'Tab switches, sidebar collapse, drawer slide-ins, and pane transitions are all eased and timed so Emmy never feels abrupt or janky.' },
  { title: 'Visual Polish', desc: 'Grain overlay, layered shadows, consistent border radii, and obsessive color tuning throughout. The kind of detail you feel before you can name it.' },
]

export default function AboutModal({ onClose }: Props) {
  return (
    <div className="about-overlay" onClick={onClose}>
      <div className="about-modal" onClick={(e) => e.stopPropagation()}>
        <div className="about-header">
          <span className="about-title">Why Emmy is better than your Terminal</span>
          <button className="about-close" onClick={onClose}>✕</button>
        </div>
        <div className="about-body">
          <p className="about-intro">
            Emmy is a terminal emulator designed to be 10x more beautiful and functional than your default terminal. Here's what makes it special:
          </p>
          <div className="about-section-label">Features</div>
          <div className="about-features">
            {FEATURE_FEATURES.map((feature, i) => (
              <div key={i} className="about-feature">
                <span className="about-feature-title">{feature.title}</span>
                <span className="about-feature-desc">{feature.desc}</span>
              </div>
            ))}
          </div>
          <div className="about-section-label">Beauty</div>
          <div className="about-features">
            {BEAUTY_FEATURES.map((feature, i) => (
              <div key={i} className="about-feature">
                <span className="about-feature-title">{feature.title}</span>
                <span className="about-feature-desc">{feature.desc}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
