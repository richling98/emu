import { useEffect, useState } from 'react'
import './PromptOptimizerDrawer.css'

interface Props {
  selectionText: string
  onClose: () => void
  onOpenSettings?: () => void
  onInsert?: (text: string) => void
}

type DrawerState = 'checking' | 'setupRequired' | 'loading' | 'success' | 'error'
const MAX_SELECTION_CHARS = 20_000

function friendlyOptimizerError(message: string): string {
  const lower = message.toLowerCase()
  if (lower.includes('401') || lower.includes('incorrect api key') || lower.includes('invalid api key')) {
    return 'OpenAI rejected the API key. Update your Prompt Optimizer key in Settings and try again.'
  }
  if (lower.includes('model') && (lower.includes('not found') || lower.includes('does not exist'))) {
    return 'OpenAI could not find that model. Check the model name in Settings.'
  }
  if (lower.includes('quota') || lower.includes('billing')) {
    return 'OpenAI reported a quota or billing issue for this API key.'
  }
  if (lower.includes('rate limit') || lower.includes('429')) {
    return 'OpenAI rate-limited this request. Wait a moment and try again.'
  }
  if (lower.includes('timed out') || lower.includes('network') || lower.includes('fetch')) {
    return 'The optimizer could not reach OpenAI. Check your network connection and try again.'
  }
  if (lower.includes('too long') || lower.includes('20,000')) {
    return 'The selected text is too long for V1. Select a smaller prompt and try again.'
  }
  return message
}

export default function PromptOptimizerDrawer({ selectionText, onClose, onOpenSettings, onInsert }: Props) {
  const [state, setState] = useState<DrawerState>('checking')
  const [optimizedPrompt, setOptimizedPrompt] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [showOriginal, setShowOriginal] = useState(false)

  const runOptimization = async () => {
    const trimmedSelection = selectionText.trim()
    if (!trimmedSelection) {
      setError('Select text to optimize.')
      setState('error')
      return
    }
    if (trimmedSelection.length > MAX_SELECTION_CHARS) {
      setError('The selected text is too long for V1. Select a smaller prompt and try again.')
      setState('error')
      return
    }
    setState('loading')
    setError('')
    setCopied(false)
    setActionBusy(true)
    try {
      const result = await window.api.optimizerOptimize({ selectedText: trimmedSelection })
      if (!result.optimizedPrompt.trim()) throw new Error('OpenAI returned an empty optimized prompt.')
      setOptimizedPrompt(result.optimizedPrompt)
      setState('success')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not optimize prompt.'
      setError(friendlyOptimizerError(message))
      setState('error')
    } finally {
      setActionBusy(false)
    }
  }

  useEffect(() => {
    let isMounted = true
    window.api.optimizerGetSettings()
      .then((settings) => {
        if (!isMounted) return
        if (!settings.configured) {
          setState('setupRequired')
          return
        }
        void runOptimization()
      })
      .catch((err) => {
        if (!isMounted) return
        setError(err instanceof Error ? err.message : 'Could not load optimizer settings.')
        setState('error')
      })
    return () => { isMounted = false }
  }, [selectionText])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const handleCopy = async () => {
    const text = optimizedPrompt.trim()
    if (!text || actionBusy) return
    setActionBusy(true)
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not copy optimized prompt.')
      setState('error')
    } finally {
      setActionBusy(false)
    }
  }

  const handleOpenSettings = () => {
    onOpenSettings?.()
    onClose()
  }

  const handleInsert = () => {
    const text = optimizedPrompt.trim()
    if (!text || !onInsert || actionBusy) return
    setActionBusy(true)
    onInsert(text)
  }

  return (
    <div className="pod-drawer">
      <div className="pod-header">
        <div className="pod-title-group">
          <span className="pod-title">Prompt Optimizer</span>
          <span className="pod-badge">AI</span>
        </div>
        <button className="pod-close" onClick={onClose} title="Close">x</button>
      </div>

      <div className="pod-body">
        {state === 'checking' && (
          <div className="pod-message">Checking optimizer settings...</div>
        )}

        {state === 'setupRequired' && (
          <div className="pod-stack">
            <div className="pod-message">
              Configure Prompt Optimizer in Settings before using this feature.
            </div>
            <div className="pod-actions">
              <button className="pod-secondary" onClick={onClose}>Dismiss</button>
              <button className="pod-primary" onClick={handleOpenSettings}>Open Settings</button>
            </div>
          </div>
        )}

        {state === 'loading' && (
          <div className="pod-loading">
            <div className="pod-spinner" />
            <span>Optimizing selected prompt...</span>
          </div>
        )}

        {state === 'error' && (
          <div className="pod-stack">
            <div className="pod-error">{error}</div>
            <div className="pod-actions">
              <button className="pod-secondary" onClick={onClose}>Dismiss</button>
              <button className="pod-primary" onClick={runOptimization} disabled={actionBusy}>Retry</button>
            </div>
          </div>
        )}

        {state === 'success' && (
          <div className="pod-stack pod-stack--fill">
            <textarea
              className="pod-textarea"
              value={optimizedPrompt}
              onChange={(e) => setOptimizedPrompt(e.target.value)}
              spellCheck={false}
            />

            <button
              className="pod-original-toggle"
              onClick={() => setShowOriginal((v) => !v)}
            >
              {showOriginal ? 'Hide Original' : 'Show Original'}
            </button>

            {showOriginal && (
              <pre className="pod-original">{selectionText}</pre>
            )}

            <div className="pod-actions">
              <button className="pod-secondary" onClick={onClose}>Dismiss</button>
              <button className="pod-secondary" onClick={runOptimization} disabled={actionBusy}>Regenerate</button>
              <button className="pod-secondary" onClick={handleCopy} disabled={actionBusy || !optimizedPrompt.trim()}>{copied ? 'Copied' : 'Copy'}</button>
              <button
                className="pod-primary"
                onClick={handleInsert}
                disabled={actionBusy || !onInsert || !optimizedPrompt.trim()}
              >
                Insert
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
