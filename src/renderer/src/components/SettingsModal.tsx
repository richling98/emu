import { useEffect, useState } from 'react'
import { THEMES } from '../themes'
import { BEAUTY_FEATURES, FEATURE_FEATURES } from './AboutModal'
import './SettingsModal.css'

interface Props {
  activeThemeId: string
  onSelectTheme: (id: string) => void
  onClose: () => void
}

type SettingsSection = 'appearance' | 'optimizer' | 'about'

export default function SettingsModal({ activeThemeId, onSelectTheme, onClose }: Props) {
  const [section, setSection] = useState<SettingsSection>('appearance')
  const [optimizerProvider, setOptimizerProvider] = useState<OptimizerProvider>('openai')
  const [optimizerModel, setOptimizerModel] = useState('gpt-5-mini')
  const [optimizerApiKey, setOptimizerApiKey] = useState('')
  const [optimizerConfigured, setOptimizerConfigured] = useState(false)
  const [optimizerBusy, setOptimizerBusy] = useState(false)
  const [optimizerStatus, setOptimizerStatus] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  useEffect(() => {
    let isMounted = true
    window.api.optimizerGetSettings()
      .then((settings) => {
        if (!isMounted) return
        setOptimizerProvider(settings.provider ?? 'openai')
        setOptimizerModel(settings.model ?? 'gpt-5-mini')
        setOptimizerConfigured(settings.configured)
      })
      .catch((err) => {
        if (!isMounted) return
        setOptimizerStatus({
          type: 'error',
          text: err instanceof Error ? err.message : 'Could not load optimizer settings.'
        })
      })
    return () => { isMounted = false }
  }, [])

  const optimizerCanSave = optimizerModel.trim().length > 0 && (optimizerApiKey.trim().length > 0 || optimizerConfigured)
  const optimizerCanTest = optimizerModel.trim().length > 0 && (optimizerApiKey.trim().length > 0 || optimizerConfigured)

  const handleSaveOptimizerSettings = async () => {
    if (!optimizerCanSave) return
    setOptimizerBusy(true)
    setOptimizerStatus(null)
    try {
      const settings = await window.api.optimizerSaveSettings({
        provider: optimizerProvider,
        model: optimizerModel.trim(),
        apiKey: optimizerApiKey.trim() || undefined
      })
      setOptimizerConfigured(settings.configured)
      setOptimizerProvider(settings.provider ?? 'openai')
      setOptimizerModel(settings.model ?? optimizerModel.trim())
      setOptimizerApiKey('')
      setOptimizerStatus({ type: 'success', text: 'Prompt Optimizer settings saved.' })
    } catch (err) {
      setOptimizerStatus({
        type: 'error',
        text: err instanceof Error ? err.message : 'Could not save optimizer settings.'
      })
    } finally {
      setOptimizerBusy(false)
    }
  }

  const handleTestOptimizerSettings = async () => {
    if (!optimizerCanTest) return
    setOptimizerBusy(true)
    setOptimizerStatus(null)
    try {
      const result = await window.api.optimizerTestSettings({
        provider: optimizerProvider,
        model: optimizerModel.trim(),
        apiKey: optimizerApiKey.trim() || undefined
      })
      setOptimizerStatus(result.ok
        ? { type: 'success', text: 'OpenAI connection verified.' }
        : { type: 'error', text: result.error ?? 'Optimizer settings are invalid.' }
      )
    } catch (err) {
      setOptimizerStatus({
        type: 'error',
        text: err instanceof Error ? err.message : 'Could not test optimizer settings.'
      })
    } finally {
      setOptimizerBusy(false)
    }
  }

  const handleClearOptimizerSettings = async () => {
    setOptimizerBusy(true)
    setOptimizerStatus(null)
    try {
      const settings = await window.api.optimizerClearSettings()
      setOptimizerConfigured(settings.configured)
      setOptimizerProvider(settings.provider ?? 'openai')
      setOptimizerModel(settings.model ?? 'gpt-5-mini')
      setOptimizerApiKey('')
      setOptimizerStatus({ type: 'success', text: 'Prompt Optimizer settings cleared.' })
    } catch (err) {
      setOptimizerStatus({
        type: 'error',
        text: err instanceof Error ? err.message : 'Could not clear optimizer settings.'
      })
    } finally {
      setOptimizerBusy(false)
    }
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
              className={`settings-nav-item${section === 'optimizer' ? ' settings-nav-item--active' : ''}`}
              onClick={() => setSection('optimizer')}
            >
              Prompt Optimizer
            </button>
            <button
              className={`settings-nav-item${section === 'about' ? ' settings-nav-item--active' : ''}`}
              onClick={() => setSection('about')}
            >
              About
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

            {section === 'optimizer' && (
              <section className="settings-section" aria-labelledby="optimizer-settings-title">
                <h2 id="optimizer-settings-title" className="settings-section-title">Prompt Optimizer</h2>
                <div className="settings-form">
                  <label className="settings-field">
                    <span className="settings-field-label">Provider</span>
                    <select
                      className="settings-input"
                      value={optimizerProvider}
                      onChange={(e) => setOptimizerProvider(e.target.value as OptimizerProvider)}
                      disabled={optimizerBusy}
                    >
                      <option value="openai">OpenAI</option>
                    </select>
                  </label>

                  <label className="settings-field">
                    <span className="settings-field-label">API Key</span>
                    <input
                      className="settings-input"
                      type="password"
                      value={optimizerApiKey}
                      onChange={(e) => setOptimizerApiKey(e.target.value)}
                      placeholder={optimizerConfigured ? 'Saved key configured; leave blank to keep it' : 'sk-...'}
                      autoComplete="off"
                      disabled={optimizerBusy}
                    />
                    <span className="settings-field-help">
                      {optimizerConfigured ? 'A key is saved locally. It is never shown again after saving.' : 'Your key is stored locally by the main process.'}
                    </span>
                  </label>

                  <label className="settings-field">
                    <span className="settings-field-label">Model</span>
                    <input
                      className="settings-input"
                      type="text"
                      value={optimizerModel}
                      onChange={(e) => setOptimizerModel(e.target.value)}
                      spellCheck={false}
                      disabled={optimizerBusy}
                    />
                  </label>

                  {optimizerStatus && (
                    <div className={`settings-status settings-status--${optimizerStatus.type}`}>
                      {optimizerStatus.text}
                    </div>
                  )}

                  <div className="settings-actions">
                    <button
                      className="settings-secondary-btn"
                      type="button"
                      disabled={optimizerBusy || !optimizerCanTest}
                      onClick={handleTestOptimizerSettings}
                    >
                      Test
                    </button>
                    <button
                      className="settings-secondary-btn"
                      type="button"
                      disabled={optimizerBusy || !optimizerConfigured}
                      onClick={handleClearOptimizerSettings}
                    >
                      Clear Key
                    </button>
                    <button
                      className="settings-primary-btn"
                      type="button"
                      disabled={optimizerBusy || !optimizerCanSave}
                      onClick={handleSaveOptimizerSettings}
                    >
                      Save
                    </button>
                  </div>
                </div>
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
          </div>
        </div>
      </div>
    </div>
  )
}
