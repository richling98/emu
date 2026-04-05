import { contextBridge, ipcRenderer, webUtils } from 'electron'

contextBridge.exposeInMainWorld('api', {
  // Create a new PTY session
  ptyCreate: (sessionId: string) => ipcRenderer.invoke('pty:create', sessionId),
  // Send input to PTY
  ptyWrite: (sessionId: string, data: string) => ipcRenderer.send('pty:write', sessionId, data),
  // Resize PTY
  ptyResize: (sessionId: string, cols: number, rows: number) =>
    ipcRenderer.send('pty:resize', sessionId, cols, rows),
  // Close PTY
  ptyClose: (sessionId: string) => ipcRenderer.send('pty:close', sessionId),
  // Listen for PTY output
  onPtyData: (sessionId: string, callback: (data: string) => void) => {
    const channel = `pty:data:${sessionId}`
    const listener = (_: Electron.IpcRendererEvent, data: string) => callback(data)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  // Listen for PTY exit
  onPtyExit: (sessionId: string, callback: () => void) => {
    const channel = `pty:exit:${sessionId}`
    const listener = () => callback()
    ipcRenderer.once(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  // Listen for font zoom triggered from main process (Cmd+-)
  onFontZoom: (callback: (delta: number) => void) => {
    const listener = (_: Electron.IpcRendererEvent, delta: number) => callback(delta)
    ipcRenderer.on('font:zoom', listener)
    return () => ipcRenderer.removeListener('font:zoom', listener)
  },
  // Get the filesystem path for a dropped File object (Electron 32+ API)
  getFilePath: (file: File) => webUtils.getPathForFile(file)
})
