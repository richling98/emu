import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import * as pty from 'node-pty'
import os from 'os'

// Track active PTY processes by session ID
const ptyProcesses = new Map<string, pty.IPty>()

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    transparent: true,
    vibrancy: 'sidebar',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // Intercept Cmd+- at the main process level — macOS menu accelerator swallows it
  // before the renderer sees it, so we must catch it here and forward via IPC.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.meta && input.type === 'keyDown' && input.key === '-') {
      event.preventDefault()
      mainWindow.webContents.send('font:zoom', -1)
    }
  })

mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.emmy.terminal')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Create a new PTY session
  ipcMain.handle('pty:create', (event, sessionId: string) => {
    const shell = os.platform() === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/zsh')
    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: os.homedir(),
      env: process.env as Record<string, string>
    })

    ptyProcesses.set(sessionId, ptyProcess)

    // Forward PTY output to renderer
    ptyProcess.onData((data) => {
      event.sender.send(`pty:data:${sessionId}`, data)
    })

    ptyProcess.onExit(() => {
      ptyProcesses.delete(sessionId)
      event.sender.send(`pty:exit:${sessionId}`)
    })

    return { pid: ptyProcess.pid }
  })

  // Write input to PTY
  ipcMain.on('pty:write', (_, sessionId: string, data: string) => {
    ptyProcesses.get(sessionId)?.write(data)
  })

  // Resize PTY
  ipcMain.on('pty:resize', (_, sessionId: string, cols: number, rows: number) => {
    ptyProcesses.get(sessionId)?.resize(cols, rows)
  })

  // Close PTY
  ipcMain.on('pty:close', (_, sessionId: string) => {
    ptyProcesses.get(sessionId)?.kill()
    ptyProcesses.delete(sessionId)
  })

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // Kill all PTY processes on exit
  ptyProcesses.forEach((pty) => pty.kill())
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
