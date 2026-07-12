import { useEffect, useState } from 'react'
import { THEMES } from '../themes'
import { BEAUTY_FEATURES, FEATURE_FEATURES } from './AboutModal'
import './SettingsModal.css'

interface Props {
  activeThemeId: string
  onSelectTheme: (id: string) => void
  onClose: () => void
}

type SettingsSection = 'appearance' | 'hotkeys' | 'notifications' | 'about' | 'updates'

type NotificationSettings = {
  permissionPopupEnabled: boolean
  taskCompletePopupEnabled: boolean
}

const NOTIFICATION_DEFAULTS: NotificationSettings = {
  permissionPopupEnabled: true,
  taskCompletePopupEnabled: true
}

function readNotificationSettings(): NotificationSettings {
  try {
    return {
      permissionPopupEnabled: localStorage.getItem('emu.permissionPopupEnabled') !== '0',
      taskCompletePopupEnabled: localStorage.getItem('emu.taskCompletePopupEnabled') !== '0'
    }
  } catch {
    return { ...NOTIFICATION_DEFAULTS }
  }
}

const HOTKEY_SECTIONS = [
  {
    title: 'Emu',
    rows: [
      { keys: ['⌘', '='], label: 'Zoom in' },
      { keys: ['⌘', '−'], label: 'Zoom out' },
      { keys: ['⌘', '0'], label: 'Reset zoom' },
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
      { keys: ['⌃', 'D'], label: 'End input / exit shell' },
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

export default function SettingsModal({ activeThemeId, onSelectTheme, onClose }: Props) {
  const [section, setSection] = useState<SettingsSection>('appearance')
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)
  const [notificationSettings, setNotificationSettings] = useState<NotificationSettings>(() =>
    readNotificationSettings()
  )

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  useEffect(() => {
    window.api.getAppVersion().then(setAppVersion)
    return window.api.onUpdateStatus(setUpdateStatus)
  }, [])

  const checkForUpdates = (): void => {
    setUpdateStatus({ status: 'checking' })
    window.api.checkForUpdates().then(setUpdateStatus)
  }

  useEffect(() => {
    if (section === 'updates') checkForUpdates()
  }, [section])

  const handleDownloadUpdate = (): void => {
    setUpdateStatus({ status: 'downloading', percent: 0 })
    window.api.downloadUpdate()
  }

  const toggleNotification = (key: keyof NotificationSettings) => {
    setNotificationSettings((prev) => {
      const next = { ...prev, [key]: !prev[key] }
      try {
        if (key === 'permissionPopupEnabled') {
          localStorage.setItem('emu.permissionPopupEnabled', next.permissionPopupEnabled ? '1' : '0')
        }
        if (key === 'taskCompletePopupEnabled') {
          localStorage.setItem('emu.taskCompletePopupEnabled', next.taskCompletePopupEnabled ? '1' : '0')
        }
      } catch {}
      window.dispatchEvent(
        new CustomEvent('emu:notifications-changed', { detail: { key, value: next[key] } })
      )
      return next
    })
  }

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <span className="settings-title">Settings</span>
          <button className="settings-close" onClick={onClose} title="Close">x</button>
        </div>

        <div className="settings-body">
          <nav className="settings-sidebar" aria-label="Settings sections">
            <button
              className={`settings-nav-item${section === 'appearance' ? ' settings-nav-item--active' : ''}`}
              onClick={() => setSection('appearance')}
            >
              Appearance
            </button>
            <button
              className={`settings-nav-item${section === 'hotkeys' ? ' settings-nav-item--active' : ''}`}
              onClick={() => setSection('hotkeys')}
            >
              Hotkeys
            </button>
            <button
              className={`settings-nav-item${section === 'notifications' ? ' settings-nav-item--active' : ''}`}
              onClick={() => setSection('notifications')}
            >
              Notifications
            </button>
            <button
              className={`settings-nav-item${section === 'about' ? ' settings-nav-item--active' : ''}`}
              onClick={() => setSection('about')}
            >
              About
            </button>
            <button
              className={`settings-nav-item${section === 'updates' ? ' settings-nav-item--active' : ''}`}
              onClick={() => setSection('updates')}
            >
              Updates
            </button>
          </nav>

          <div className="settings-content">
            {section === 'appearance' && (
              <section className="settings-section" aria-labelledby="appearance-settings-title">
                <h2 id="appearance-settings-title" className="settings-section-title">Appearance</h2>
                <div className="settings-theme-grid">
                  {THEMES.map((theme) => (
                    <div key={theme.id} className="settings-theme-cell">
                      <span className={`settings-theme-label${activeThemeId === theme.id ? ' settings-theme-label--active' : ''}`}>
                        {theme.name}
                      </span>
                      <button
                        className={`settings-theme-swatch${activeThemeId === theme.id ? ' settings-theme-swatch--active' : ''}`}
                        style={{
                          '--sw-bg': theme.bgBase,
                          '--sw-accent': theme.accent,
                          '--sw-accent-alt': theme.accentAlt,
                        } as React.CSSProperties}
                        onClick={() => onSelectTheme(theme.id)}
                        title={theme.name}
                      >
                        <div className="settings-theme-lines">
                          <span className="settings-theme-line settings-theme-line--long" />
                          <span className="settings-theme-line settings-theme-line--med" />
                          <span className="settings-theme-line settings-theme-line--short" />
                        </div>
                        <div className="settings-theme-strip" />
                        {activeThemeId === theme.id && (
                          <div className="settings-theme-check">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          </div>
                        )}
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {section === 'hotkeys' && (
              <section className="settings-section settings-hotkeys-section" aria-labelledby="hotkeys-settings-title">
                <h2 id="hotkeys-settings-title" className="settings-section-title">Hotkeys</h2>
                <div className="settings-hotkey-list">
                  {HOTKEY_SECTIONS.map((hotkeySection) => (
                    <div key={hotkeySection.title} className="settings-hotkey-group">
                      <div className="settings-hotkey-group-title">{hotkeySection.title}</div>
                      {hotkeySection.rows.map((row) => (
                        <div key={row.label} className="settings-hotkey-row">
                          <span className="settings-hotkey-label">{row.label}</span>
                          <span className="settings-hotkey-keys">
                            {row.keys.map((key, index) => (
                              <span key={index} className="settings-hotkey-keyset">
                                <kbd className="settings-kbd">{key}</kbd>
                                {index < row.keys.length - 1 && <span className="settings-kbd-plus">+</span>}
                              </span>
                            ))}
                          </span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {section === 'notifications' && (
              <section className="settings-section settings-about-section" aria-labelledby="notifications-settings-title">
                <h2 id="notifications-settings-title" className="settings-section-title">Notifications</h2>
                <p className="settings-about-intro">
                  Control the extra overlay windows. Disabling these removes their GPU and idle cost while keeping sidebar indicators intact.
                </p>

                <div className="settings-about-label">Overlay windows</div>
                <div className="settings-about-list">
                  <div className="settings-about-item settings-about-item--row">
                    <div className="settings-about-item-copy">
                      <span className="settings-about-item-title">Permission popup</span>
                      <span className="settings-about-item-desc">
                        {notificationSettings.permissionPopupEnabled
                          ? 'Shows the floating approval overlay when an agent requests permission.'
                          : 'Hidden. Approve or deny directly in the terminal instead.'}
                      </span>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={notificationSettings.permissionPopupEnabled}
                      className={`settings-switch${notificationSettings.permissionPopupEnabled ? ' settings-switch--on' : ''}`}
                      onClick={() => toggleNotification('permissionPopupEnabled')}
                    >
                      <span className="settings-switch-thumb" />
                    </button>
                  </div>

                  <div className="settings-about-item settings-about-item--row">
                    <div className="settings-about-item-copy">
                      <span className="settings-about-item-title">Task complete popup</span>
                      <span className="settings-about-item-desc">
                        {notificationSettings.taskCompletePopupEnabled
                          ? 'Shows the yellow completion notification when an agent finishes.'
                          : 'Hidden. The sidebar will still turn from yellow (running) to green (idle).'}
                      </span>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={notificationSettings.taskCompletePopupEnabled}
                      className={`settings-switch${notificationSettings.taskCompletePopupEnabled ? ' settings-switch--on' : ''}`}
                      onClick={() => toggleNotification('taskCompletePopupEnabled')}
                    >
                      <span className="settings-switch-thumb" />
                    </button>
                  </div>
                </div>

                <p className="settings-about-intro" style={{ marginTop: 10 }}>
                  Tip: If Emu feels laggy on a busy machine, try turning one or both overlays off and measuring with Cmd+Shift+P before changing anything deeper.
                </p>
              </section>
            )}

            {section === 'about' && (
              <section className="settings-section settings-about-section" aria-labelledby="about-settings-title">
                <h2 id="about-settings-title" className="settings-section-title">Why Emu is better than your Terminal</h2>
                <p className="settings-about-intro">
                  Emu is a terminal emulator designed to be 10x more beautiful and functional than your default terminal. Here's what makes it special:
                </p>

                <div className="settings-about-label">Features</div>
                <div className="settings-about-list">
                  {FEATURE_FEATURES.map((feature, i) => (
                    <div key={i} className="settings-about-item">
                      <span className="settings-about-item-title">{feature.title}</span>
                      <span className="settings-about-item-desc">{feature.desc}</span>
                    </div>
                  ))}
                </div>

                <div className="settings-about-label">Beauty</div>
                <div className="settings-about-list">
                  {BEAUTY_FEATURES.map((feature, i) => (
                    <div key={i} className="settings-about-item">
                      <span className="settings-about-item-title">{feature.title}</span>
                      <span className="settings-about-item-desc">{feature.desc}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {section === 'updates' && (
              <section className="settings-section settings-updates-section" aria-labelledby="updates-settings-title">
                <h2 id="updates-settings-title" className="settings-section-title">Updates</h2>
                <p className="settings-updates-version">{appVersion ? `Emu v${appVersion}` : ' '}</p>

                {(!updateStatus || updateStatus.status === 'checking') && (
                  <p className="settings-updates-status">Checking for updates…</p>
                )}

                {updateStatus?.status === 'not-available' && (
                  <p className="settings-updates-status settings-updates-status--ok">You're on the latest version of Emu!</p>
                )}

                {updateStatus?.status === 'available' && (
                  <div className="settings-updates-row">
                    <p className="settings-updates-status">Emu v{updateStatus.version} is available.</p>
                    <button className="settings-updates-button" onClick={handleDownloadUpdate}>Update</button>
                  </div>
                )}

                {updateStatus?.status === 'downloading' && (
                  <div className="settings-updates-progress">
                    <p className="settings-updates-status">Downloading update… {updateStatus.percent}%</p>
                    <div className="settings-updates-progress-track">
                      <div className="settings-updates-progress-fill" style={{ width: `${updateStatus.percent}%` }} />
                    </div>
                  </div>
                )}

                {updateStatus?.status === 'downloaded' && (
                  <p className="settings-updates-status">Installing and relaunching…</p>
                )}

                {updateStatus?.status === 'error' && (
                  <div className="settings-updates-row">
                    <p className="settings-updates-status settings-updates-status--error">Couldn't check for updates.</p>
                    <button className="settings-updates-button settings-updates-button--secondary" onClick={checkForUpdates}>Try again</button>
                  </div>
                )}

                {updateStatus?.status === 'unsupported' && (
                  <p className="settings-updates-status">Updates aren't available in development builds.</p>
                )}
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
