import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import fs from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import * as pty from 'node-pty'
import os from 'os'

// Track active PTY processes by session ID
const ptyProcesses = new Map<string, pty.IPty>()

// Write zsh wrapper startup files to Emu's app-data dir and return the path.
// Setting ZDOTDIR to this dir makes zsh read our wrappers instead of ~/.zsh*;
// each wrapper sources the user's real file then our .zshrc appends the
// prompt-spacing hook so a blank line appears between output and the next prompt.
function setupShellIntegration(): string {
  const dir = join(app.getPath('userData'), 'shell-integration')
  fs.mkdirSync(dir, { recursive: true })

  // .zshenv — sourced for every zsh instance (login, interactive, scripts)
  fs.writeFileSync(join(dir, '.zshenv'),
    '[[ -f "$HOME/.zshenv" ]] && source "$HOME/.zshenv"\n')

  // .zprofile — sourced for login shells before .zshrc
  fs.writeFileSync(join(dir, '.zprofile'),
    '[[ -f "$HOME/.zprofile" ]] && source "$HOME/.zprofile"\n')

  // .zshrc — sourced for interactive shells; appends the spacing hook last
  fs.writeFileSync(join(dir, '.zshrc'), [
    '# Restore ZDOTDIR so any subshells use the normal ~/.zshrc, not this wrapper',
    'export ZDOTDIR="$HOME"',
    '',
    '# Source the user\'s real interactive config',
    '[[ -f "$HOME/.zshrc" ]] && source "$HOME/.zshrc"',
    '',
    '# Emu: print a blank line before each prompt to visually separate output from input',
    '_emu_prompt_spacing() { printf "\\n" }',
    'precmd_functions+=("_emu_prompt_spacing")',
  ].join('\n') + '\n')

  // .zlogin — sourced for login shells after .zshrc
  fs.writeFileSync(join(dir, '.zlogin'),
    '[[ -f "$HOME/.zlogin" ]] && source "$HOME/.zlogin"\n')

  return dir
}

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
  electronApp.setAppUserModelId('com.emu.terminal')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Create a new PTY session
  ipcMain.handle('pty:create', (event, sessionId: string) => {
    const shell = os.platform() === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/zsh')

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    }
    // Inject prompt-spacing hook for zsh via ZDOTDIR wrapper files
    if (shell.includes('zsh')) {
      env.ZDOTDIR = setupShellIntegration()
    }

    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: os.homedir(),
      env,
    })

    ptyProcesses.set(sessionId, ptyProcess)

    // Forward PTY output to renderer
    ptyProcess.onData((data) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(`pty:data:${sessionId}`, data)
      }
    })

    ptyProcess.onExit(() => {
      ptyProcesses.delete(sessionId)
      if (!event.sender.isDestroyed()) {
        event.sender.send(`pty:exit:${sessionId}`)
      }
    })

    return { pid: ptyProcess.pid }
  })

  // Return the name of the current foreground process in a PTY session.
  // Used by the renderer to distinguish real TUI apps (vim, claude) entering
  // alt-screen from accidental entries (e.g. echo outputting \x1b[?1049h]).
  ipcMain.handle('pty:process', (_, sessionId: string) => {
    return ptyProcesses.get(sessionId)?.process ?? null
  })

  // Open URLs in default browser
  ipcMain.handle('shell:openExternal', (_, url: string) => shell.openExternal(url))

  // Open file paths in Finder / default app
  ipcMain.handle('shell:openPath', (_, path: string) => shell.openPath(path))

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
