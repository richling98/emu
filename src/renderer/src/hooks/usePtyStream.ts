import { useState, useEffect, useRef, useCallback } from 'react'
import type { ChatMessage } from '../types'

// Detect alternate screen (vim, htop, man, etc.)
const ALT_SCREEN_ENTER = '\x1b[?1049h'
const ALT_SCREEN_EXIT = '\x1b[?1049l'

// How long the PTY must be quiet before we consider output "done"
const IDLE_MS = 600

export function usePtyStream(sessionId: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [mode, setMode] = useState<'shell' | 'interactive'>('shell')
  const [liveInput, setLiveInput] = useState('')

  const outputBufferRef = useRef('')
  const commandBufferRef = useRef('')
  const capturingOutputRef = useRef(false)
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const modeRef = useRef<'shell' | 'interactive'>('shell')

  const flushOutput = useCallback(() => {
    const raw = outputBufferRef.current
    outputBufferRef.current = ''
    capturingOutputRef.current = false
    if (raw.trim()) {
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: 'output', content: raw, timestamp: new Date() }
      ])
    }
  }, [])

  useEffect(() => {
    const removeDataListener = window.api.onPtyData(sessionId, (data) => {
      // Alternate screen detection
      if (data.includes(ALT_SCREEN_ENTER)) {
        if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
        flushOutput()
        modeRef.current = 'interactive'
        setMode('interactive')
        return
      }
      if (data.includes(ALT_SCREEN_EXIT)) {
        modeRef.current = 'shell'
        setMode('shell')
        return
      }

      // Don't capture output while in interactive mode
      if (modeRef.current === 'interactive') return

      // Accumulate output
      if (capturingOutputRef.current) {
        outputBufferRef.current += data
        if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
        idleTimerRef.current = setTimeout(flushOutput, IDLE_MS)
      }
    })

    return () => {
      removeDataListener()
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
    }
  }, [sessionId, flushOutput])

  // Called from TerminalPane's onData handler for every keystroke
  const handleInput = useCallback((data: string) => {
    const BACKSPACE = '\x7f'
    const ENTER = '\r'
    const CTRL_U = '\x15'
    const CTRL_C = '\x03'

    if (data === ENTER) {
      const command = commandBufferRef.current.trim()
      commandBufferRef.current = ''
      setLiveInput('')
      if (command) {
        setMessages((prev) => [
          ...prev,
          { id: crypto.randomUUID(), role: 'input', content: command, timestamp: new Date() }
        ])
      }
      // Start capturing output for this command
      outputBufferRef.current = ''
      capturingOutputRef.current = true
    } else if (data === BACKSPACE) {
      commandBufferRef.current = commandBufferRef.current.slice(0, -1)
      setLiveInput(commandBufferRef.current)
    } else if (data === CTRL_U || data === CTRL_C) {
      commandBufferRef.current = ''
      setLiveInput('')
    } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
      commandBufferRef.current += data
      setLiveInput(commandBufferRef.current)
    }
  }, [])

  return { messages, mode, liveInput, handleInput }
}
