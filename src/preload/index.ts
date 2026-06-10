import { contextBridge, ipcRenderer, webUtils } from 'electron'

function hasFlagValue(name: string, value: string): boolean {
  return process.argv.includes(`${name}=${value}`)
}

contextBridge.exposeInMainWorld('api', {
  diagnosticsConfig: {
    webglEnabled: hasFlagValue('--emu-enable-webgl', '1') || hasFlagValue('--thinking-enable-webgl', '1'),
    vibrancyDisabled: hasFlagValue('--emu-disable-vibrancy', '1') || hasFlagValue('--thinking-disable-vibrancy', '1')
  },
  // Create a new PTY session
  ptyCreate: (sessionId: string, options?: { cwd?: string | null }) => ipcRenderer.invoke('pty:create', sessionId, options),
  // Send input to PTY
  ptyWrite: (sessionId: string, data: string) => ipcRenderer.send('pty:write', sessionId, data),
  ptyWriteSequence: (sessionId: string, writes: Array<{ data: string; delayAfterMs?: number }>) =>
    ipcRenderer.invoke('pty:writeSequence', sessionId, writes),
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
  getFilePath: (file: File) => webUtils.getPathForFile(file),
  // Get the foreground process name for a PTY session
  ptyGetProcess: (sessionId: string) => ipcRenderer.invoke('pty:process', sessionId),
  // Open a URL in the system default browser
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  // Open a file path in Finder / default app
  openPath: (path: string) => ipcRenderer.invoke('shell:openPath', path),
  // Read a local Markdown file through the main process
  markdownOpen: (input: unknown) => ipcRenderer.invoke('markdown:open', input),
  // Read a local Markdown image asset through the main process
  markdownImage: (input: unknown) => ipcRenderer.invoke('markdown:image', input),
  // Save pasted clipboard image data to a temporary file and return its path
  imageSaveTemp: (dataUrl: string, suggestedName?: string) => ipcRenderer.invoke('image:saveTemp', dataUrl, suggestedName),
  // Dev performance diagnostics
  perfGetStats: () => ipcRenderer.invoke('perf:getStats'),
  // Prompt Optimizer settings and calls
  optimizerGetSettings: () => ipcRenderer.invoke('optimizer:getSettings'),
  optimizerSaveSettings: (input: unknown) => ipcRenderer.invoke('optimizer:saveSettings', input),
  optimizerClearSettings: () => ipcRenderer.invoke('optimizer:clearSettings'),
  optimizerTestSettings: (input?: unknown) => ipcRenderer.invoke('optimizer:testSettings', input),
  optimizerOptimize: (input: unknown) => ipcRenderer.invoke('optimizer:optimize', input),
  // Agent permission approval popup
  agentPermissionPromptShow: (prompt: unknown) => ipcRenderer.invoke('agent-permission:show', prompt),
  agentPermissionPromptDismissSession: (sessionId: string) => ipcRenderer.invoke('agent-permission:dismissSession', sessionId),
  agentPermissionOverlayAction: (input: unknown) => ipcRenderer.invoke('agent-permission:overlayAction', input),
  onAgentPermissionOverlayState: (callback: (state: unknown) => void) => {
    const listener = (_: Electron.IpcRendererEvent, state: unknown) => callback(state)
    ipcRenderer.on('agent-permission:state', listener)
    return () => ipcRenderer.removeListener('agent-permission:state', listener)
  }
})
