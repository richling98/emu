import { contextBridge, ipcRenderer, webUtils } from 'electron'

function hasFlagValue(name: string, value: string): boolean {
  return process.argv.includes(`${name}=${value}`)
}

contextBridge.exposeInMainWorld('api', {
  diagnosticsConfig: {
    webglEnabled: hasFlagValue('--emu-enable-webgl', '1') || hasFlagValue('--thinking-enable-webgl', '1'),
    vibrancyDisabled: hasFlagValue('--emu-disable-vibrancy', '1') || hasFlagValue('--thinking-disable-vibrancy', '1'),
    gpuForceInProcess: process.argv.some((a) => a === '--in-process-gpu'),
    gpuDisabled: process.argv.some((a) => a === '--disable-gpu')
  },
  // Create a new PTY session
  ptyCreate: (sessionId: string, options?: { cwd?: string | null; workspaceName?: string | null }) => ipcRenderer.invoke('pty:create', sessionId, options),
  // Send input to PTY
  ptyWrite: (sessionId: string, data: string) => ipcRenderer.send('pty:write', sessionId, data),
  ptyWriteSequence: (sessionId: string, writes: Array<{ data: string; delayAfterMs?: number }>) =>
    ipcRenderer.invoke('pty:writeSequence', sessionId, writes),
  ptyChangeDirectory: (sessionId: string, cwd: string) => ipcRenderer.invoke('pty:changeDirectory', sessionId, cwd),
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
  selectWorkspaceFolder: (defaultPath?: string | null) => ipcRenderer.invoke('dialog:selectWorkspaceFolder', defaultPath),
  // Read a local Markdown file through the main process
  markdownOpen: (input: unknown) => ipcRenderer.invoke('markdown:open', input),
  // Read a local Markdown image asset through the main process
  markdownImage: (input: unknown) => ipcRenderer.invoke('markdown:image', input),
  // Save pasted clipboard image data to a temporary file and return its path
  imageSaveTemp: (dataUrl: string, suggestedName?: string) => ipcRenderer.invoke('image:saveTemp', dataUrl, suggestedName),
  // Dev performance diagnostics
  perfGetStats: () => ipcRenderer.invoke('perf:getStats'),
  // Agent permission approval popup
  agentPermissionSessionMetadata: (metadata: unknown) => ipcRenderer.invoke('agent-permission:sessionMetadata', metadata),
  agentPermissionPromptShow: (prompt: unknown) => ipcRenderer.invoke('agent-permission:show', prompt),
  agentPermissionPromptDismissSession: (sessionId: string) => ipcRenderer.invoke('agent-permission:dismissSession', sessionId),
  agentPermissionOverlayAction: (input: unknown) => ipcRenderer.invoke('agent-permission:overlayAction', input),
  onAgentPermissionOverlayState: (callback: (state: unknown) => void) => {
    const listener = (_: Electron.IpcRendererEvent, state: unknown) => callback(state)
    ipcRenderer.on('agent-permission:state', listener)
    return () => ipcRenderer.removeListener('agent-permission:state', listener)
  },
  onAgentPermissionPromptResolved: (callback: (sessionId: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, sessionId: string) => callback(sessionId)
    ipcRenderer.on('agent-permission:resolved', listener)
    return () => ipcRenderer.removeListener('agent-permission:resolved', listener)
  },
  // App updates (electron-updater)
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  downloadUpdate: () => ipcRenderer.invoke('updates:download'),
  onUpdateStatus: (callback: (status: unknown) => void) => {
    const listener = (_: Electron.IpcRendererEvent, status: unknown) => callback(status)
    ipcRenderer.on('updates:status', listener)
    return () => ipcRenderer.removeListener('updates:status', listener)
  },
  // Task-complete notification
  showTaskComplete: (info: { tabName: string; sessionId: string; workspaceId: string }) =>
    ipcRenderer.invoke('task-complete:show', info),
  taskCompleteVisit: (sessionId: string) => ipcRenderer.invoke('task-complete:visit', sessionId),
  taskCompleteOverlayAction: (action: { type: string; notificationId?: string }) =>
    ipcRenderer.invoke('task-complete:action', action),
  onTaskCompleteOverlayState: (callback: (state: { tabName: string; sessionId: string; workspaceName: string } | null) => void) => {
    const listener = (_: Electron.IpcRendererEvent, state: unknown) => callback(state as { tabName: string; sessionId: string; workspaceName: string })
    ipcRenderer.on('task-complete:state', listener)
    return () => ipcRenderer.removeListener('task-complete:state', listener)
  },
  onTaskCompleteChime: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('task-complete:chime', listener)
    return () => ipcRenderer.removeListener('task-complete:chime', listener)
  },
  onTaskCompleteVisit: (callback: (sessionId: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, sessionId: string) => callback(sessionId)
    ipcRenderer.on('task-complete:visit', listener)
    return () => ipcRenderer.removeListener('task-complete:visit', listener)
  }
})
