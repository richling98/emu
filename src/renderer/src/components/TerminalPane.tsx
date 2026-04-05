import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import type { Session } from '../App'
import '@xterm/xterm/css/xterm.css'
import './TerminalPane.css'

interface Props {
  session: Session
  isVisible: boolean
  onSessionEnd: () => void
}

export default function TerminalPane({ session, isVisible, onSessionEnd }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    const terminal = new Terminal({
      theme: {
        background: '#1e1e2e',
        foreground: '#cdd6f4',
        cursor: '#f5e0dc',
        cursorAccent: '#1e1e2e',
        selectionBackground: 'rgba(88, 91, 112, 0.5)',
        black: '#45475a',
        brightBlack: '#585b70',
        red: '#f38ba8',
        brightRed: '#f38ba8',
        green: '#a6e3a1',
        brightGreen: '#a6e3a1',
        yellow: '#f9e2af',
        brightYellow: '#f9e2af',
        blue: '#89b4fa',
        brightBlue: '#89b4fa',
        magenta: '#cba6f7',
        brightMagenta: '#cba6f7',
        cyan: '#89dceb',
        brightCyan: '#89dceb',
        white: '#bac2de',
        brightWhite: '#a6adc8'
      },
      fontFamily: '"JetBrains Mono", "Fira Code", Menlo, Monaco, monospace',
      fontSize: 13.5,
      lineHeight: 1.2,
      letterSpacing: 0.3,
      fontWeight: '400',
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000
    })

    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(containerRef.current)
    fitAddon.fit()

    // WebGL renderer — sharper text, GPU-accelerated, especially noticeable on Retina
    try {
      const webglAddon = new WebglAddon()
      webglAddon.onContextLoss(() => webglAddon.dispose())
      terminal.loadAddon(webglAddon)
    } catch {
      // Falls back to canvas renderer silently if WebGL isn't available
    }

    terminal.focus()

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    window.api.ptyCreate(session.id).then(() => terminal.focus())

    const DEFAULT_FONT_SIZE = 13.5

    const removeDataListener = window.api.onPtyData(session.id, (data) => {
      terminal.write(data)
    })

    const removeExitListener = window.api.onPtyExit(session.id, () => {
      terminal.write('\r\n\x1b[2m[Process exited]\x1b[0m\r\n')
      onSessionEnd()
    })

    // Unified key interceptor — runs before xterm processes any key
    let savedSelection = ''
    let savedSelStartCol = -1
    containerRef.current.addEventListener('mouseup', () => {
      savedSelection = terminal.getSelection()
      const pos = terminal.getSelectionPosition()
      savedSelStartCol = pos ? pos.startColumn : -1
    })

    terminal.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
      if (ev.type !== 'keydown') return true

      // Font zoom: Cmd+= / Cmd+- / Cmd+0
      if (ev.metaKey) {
        const zoom = (delta: number) => {
          terminal.options.fontSize = Math.min(Math.max((terminal.options.fontSize ?? DEFAULT_FONT_SIZE) + delta, 8), 32)
          fitAddon.fit()
          window.api.ptyResize(session.id, terminal.cols, terminal.rows)
        }
        if (ev.key === '=' || ev.key === '+' || ev.code === 'Equal') {
          ev.preventDefault(); zoom(+1); return false
        }
        if (ev.key === '-' || ev.code === 'Minus') {
          ev.preventDefault(); zoom(-1); return false
        }
        if (ev.key === '0' || ev.code === 'Digit0') {
          ev.preventDefault()
          terminal.options.fontSize = DEFAULT_FONT_SIZE
          fitAddon.fit()
          window.api.ptyResize(session.id, terminal.cols, terminal.rows)
          return false
        }
      }

      return true // pass everything else through to xterm
    })

    terminal.onData((data) => {
      const BACKSPACE = '\x7f'

      if (data === BACKSPACE && savedSelection.length > 0) {
        const cursorX = terminal.buffer.active.cursorX
        const selLength = savedSelection.length
        const targetCol = savedSelStartCol + selLength
        const rightMoves = Math.max(0, targetCol - cursorX)
        let cmd = ''
        if (rightMoves > 0) cmd += '\x1b[C'.repeat(rightMoves)
        cmd += BACKSPACE.repeat(selLength)
        window.api.ptyWrite(session.id, cmd)
        savedSelection = ''
        savedSelStartCol = -1
        return
      }

      savedSelection = ''
      savedSelStartCol = -1

      // Strip bracketed paste markers so pasted text is echoed inline
      // instead of the shell showing a "[pasted text + N lines]" summary
      const out = data.replace(/\x1b\[200~([\s\S]*?)\x1b\[201~/g, '$1')
      window.api.ptyWrite(session.id, out)
    })

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit()
      window.api.ptyResize(session.id, terminal.cols, terminal.rows)
    })
    resizeObserver.observe(containerRef.current)

    return () => {
      window.removeEventListener('keydown', handleZoom)
      removeDataListener()
      removeExitListener()
      resizeObserver.disconnect()
      terminal.dispose()
      window.api.ptyClose(session.id)
    }
  }, [])

  // Handle Cmd+- forwarded from main process (macOS menu accelerator swallows it otherwise)
  useEffect(() => {
    const DEFAULT_FONT_SIZE = 13.5
    const remove = window.api.onFontZoom((delta) => {
      if (!terminalRef.current || !fitAddonRef.current) return
      terminalRef.current.options.fontSize = Math.min(
        Math.max((terminalRef.current.options.fontSize ?? DEFAULT_FONT_SIZE) + delta, 8),
        32
      )
      fitAddonRef.current.fit()
      window.api.ptyResize(session.id, terminalRef.current.cols, terminalRef.current.rows)
    })
    return remove
  }, [])

  useEffect(() => {
    if (isVisible && fitAddonRef.current && terminalRef.current) {
      setTimeout(() => {
        fitAddonRef.current?.fit()
        window.api.ptyResize(session.id, terminalRef.current!.cols, terminalRef.current!.rows)
        terminalRef.current?.focus()
      }, 10)
    }
  }, [isVisible])

  return (
    <div className={`terminal-pane${isVisible ? ' terminal-pane--visible' : ''}`}>
      <div ref={containerRef} className="terminal-container" />
    </div>
  )
}
