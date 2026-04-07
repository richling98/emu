/// <reference types="vite/client" />

interface Window {
  api: {
    ptyCreate: (sessionId: string) => Promise<{ pid: number }>
    ptyWrite: (sessionId: string, data: string) => void
    ptyResize: (sessionId: string, cols: number, rows: number) => void
    ptyClose: (sessionId: string) => void
    onPtyData: (sessionId: string, callback: (data: string) => void) => () => void
    onPtyExit: (sessionId: string, callback: () => void) => () => void
    onFontZoom: (callback: (delta: number) => void) => () => void
    getFilePath: (file: File) => string
    openExternal: (url: string) => Promise<void>
    openPath: (path: string) => Promise<string>
  }
}
