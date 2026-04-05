import { useState, useMemo } from 'react'
import AnsiToHtml from 'ansi-to-html'
import type { ChatMessage } from '../types'
import './MessageBubble.css'

const converter = new AnsiToHtml({
  fg: '#f0f0f0',
  bg: 'transparent',
  newline: true,
  escapeXML: true,
  stream: false
})

function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\[[0-9;]*[mGKHFABCDEFJSTsu]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[()][AB012]/g, '')
    .replace(/[\x0e\x0f]/g, '')
    .trim()
}

function cleanForDisplay(raw: string): string {
  return raw
    .replace(/\x1b\[[0-9;]*[ABCDEFGJKST]/g, '')
    .replace(/\x1b\[[0-9;]*[Hf]/g, '')
    .replace(/\x1b\[\?[0-9;]*[hl]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[()][AB012]/g, '')
    .replace(/[\x0e\x0f]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trimEnd()
}

interface Props {
  message: ChatMessage
  isLast: boolean
}

export default function MessageBubble({ message, isLast }: Props) {
  const [copied, setCopied] = useState(false)

  const html = useMemo(() => {
    if (message.role !== 'output') return ''
    try {
      return converter.toHtml(cleanForDisplay(message.content))
    } catch {
      return cleanForDisplay(message.content)
    }
  }, [message.content, message.role])

  const handleCopy = () => {
    navigator.clipboard.writeText(stripAnsi(message.content))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  if (message.role === 'input') {
    return (
      <div className="cmd-input">
        <span className="cmd-prompt">$</span>
        <span className="cmd-text">{message.content}</span>
      </div>
    )
  }

  return (
    <>
      <div className="cmd-output-wrap">
        <button className="cmd-copy" onClick={handleCopy} title="Copy output">
          {copied ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        </button>
        <pre className="cmd-output" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
      {!isLast && <hr className="cmd-divider" />}
    </>
  )
}
