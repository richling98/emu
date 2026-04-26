import { app, shell, BrowserWindow, ipcMain, nativeImage, safeStorage } from 'electron'
import { join } from 'path'
import fs from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import * as pty from 'node-pty'
import os from 'os'

// Track active PTY processes by session ID
const ptyProcesses = new Map<string, pty.IPty>()

type OptimizerProvider = 'openai'

interface StoredSecret {
  encoding: 'safeStorage' | 'plain'
  value: string
}

interface StoredOptimizerSettings {
  provider: OptimizerProvider
  model: string
  apiKey?: StoredSecret
}

interface PublicOptimizerSettings {
  configured: boolean
  provider?: OptimizerProvider
  model?: string
}

interface OptimizerSettingsInput {
  provider: OptimizerProvider
  apiKey?: string
  model: string
}

interface OptimizePromptInput {
  selectedText: string
  terminalContext?: string
}

interface OptimizePromptResult {
  optimizedPrompt: string
}

interface ResolvedOptimizerConfig {
  provider: OptimizerProvider
  model: string
  apiKey: string
}

const DEFAULT_OPTIMIZER_MODEL = 'gpt-5-mini'
const MAX_OPTIMIZER_SELECTION_CHARS = 20_000
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses'

const OPTIMIZER_SYSTEM_PROMPT = [
  'You are an expert prompt engineer for terminal-based AI coding agents, especially Claude Code and Codex.',
  '',
  'Transform the user\'s selected rough prompt into a stronger prompt that works well in both Claude Code and Codex sessions.',
  '',
  'Do not merely rephrase. Improve the prompt by:',
  '- clarifying the goal',
  '- making the scope explicit',
  '- adding concrete acceptance criteria',
  '- instructing the agent to inspect the current codebase before editing when needed',
  '- asking the agent to follow existing project patterns',
  '- adding verification steps such as tests, builds, linting, or manual checks when appropriate',
  '- specifying the expected final response format',
  '- preserving the user\'s intent',
  '- avoiding invented repository details, file names, libraries, commands, or constraints',
  '',
  'Because the optimized prompt must work in both Claude Code and Codex:',
  '- do not mention provider-specific UI features',
  '- do not assume access to hidden tools or APIs',
  '- do not rely on model-specific commands',
  '- do not write role or system-prompt preambles such as "You are a coding agent"',
  '- phrase instructions in plain coding-agent language',
  '- prefer actionable steps over long meta-instructions',
  '',
  'If the user selected a vague prompt, make it actionable without assuming facts not provided.',
  'If the user selected a good prompt, tighten it without bloating it.',
  'Prefer concise, useful prompts over generic long templates.',
  '',
  'Return JSON matching the provided schema.'
].join('\n')

const OPTIMIZER_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['optimizedPrompt'],
  properties: {
    optimizedPrompt: {
      type: 'string',
      description: 'The improved prompt the user should paste into Claude Code or Codex.'
    }
  }
}

function optimizerSettingsPath(): string {
  return join(app.getPath('userData'), 'prompt-optimizer-settings.json')
}

function validateOptimizerProvider(provider: unknown): provider is OptimizerProvider {
  return provider === 'openai'
}

function normalizeOptimizerInput(input: OptimizerSettingsInput): OptimizerSettingsInput {
  if (!input || !validateOptimizerProvider(input.provider)) {
    throw new Error('Choose a supported optimizer provider.')
  }
  const model = String(input.model ?? '').trim()
  if (!model) throw new Error('Enter an optimizer model.')
  return {
    provider: input.provider,
    model,
    apiKey: typeof input.apiKey === 'string' ? input.apiKey.trim() : undefined
  }
}

function encryptSecret(secret: string): StoredSecret {
  if (safeStorage.isEncryptionAvailable()) {
    return {
      encoding: 'safeStorage',
      value: safeStorage.encryptString(secret).toString('base64')
    }
  }
  return { encoding: 'plain', value: secret }
}

function decryptSecret(secret: StoredSecret | undefined): string | null {
  if (!secret?.value) return null
  try {
    if (secret.encoding === 'safeStorage') {
      return safeStorage.decryptString(Buffer.from(secret.value, 'base64'))
    }
    return secret.value
  } catch {
    return null
  }
}

function readOptimizerSettings(): StoredOptimizerSettings | null {
  try {
    const raw = fs.readFileSync(optimizerSettingsPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<StoredOptimizerSettings>
    if (!validateOptimizerProvider(parsed.provider)) return null
    if (typeof parsed.model !== 'string' || !parsed.model.trim()) return null
    return {
      provider: parsed.provider,
      model: parsed.model.trim(),
      apiKey: parsed.apiKey
    }
  } catch {
    return null
  }
}

function writeOptimizerSettings(settings: StoredOptimizerSettings): void {
  fs.mkdirSync(app.getPath('userData'), { recursive: true })
  fs.writeFileSync(optimizerSettingsPath(), JSON.stringify(settings, null, 2), 'utf8')
}

function getPublicOptimizerSettings(): PublicOptimizerSettings {
  const settings = readOptimizerSettings()
  if (!settings) return { configured: false, provider: 'openai', model: DEFAULT_OPTIMIZER_MODEL }
  return {
    configured: Boolean(decryptSecret(settings.apiKey)),
    provider: settings.provider,
    model: settings.model
  }
}

function saveOptimizerSettings(input: OptimizerSettingsInput): void {
  const normalized = normalizeOptimizerInput(input)
  const existing = readOptimizerSettings()
  const existingKey = decryptSecret(existing?.apiKey)
  const nextKey = normalized.apiKey || existingKey
  if (!nextKey) throw new Error('Enter an API key before saving Prompt Optimizer settings.')

  writeOptimizerSettings({
    provider: normalized.provider,
    model: normalized.model,
    apiKey: encryptSecret(nextKey)
  })
}

function clearOptimizerSettings(): void {
  try {
    fs.unlinkSync(optimizerSettingsPath())
  } catch {
    // Missing settings file is already the cleared state.
  }
}

function validateOptimizerSettingsForUse(input?: Partial<OptimizerSettingsInput>): { ok: true } | { ok: false; error: string } {
  try {
    resolveOptimizerConfig(input)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not validate optimizer settings.' }
  }
}

function resolveOptimizerConfig(input?: Partial<OptimizerSettingsInput>): ResolvedOptimizerConfig {
  const existing = readOptimizerSettings()
  const provider = input?.provider ?? existing?.provider ?? 'openai'
  const model = String(input?.model ?? existing?.model ?? '').trim()
  const inputKey = typeof input?.apiKey === 'string' ? input.apiKey.trim() : ''
  const apiKey = inputKey || decryptSecret(existing?.apiKey)

  if (!validateOptimizerProvider(provider)) throw new Error('Choose a supported optimizer provider.')
  if (!model) throw new Error('Enter an optimizer model.')
  if (!apiKey) throw new Error('Enter an API key.')

  return { provider, model, apiKey }
}

function buildOptimizerUserPrompt(input: OptimizePromptInput): string {
  const selectedText = input.selectedText.trim()
  const parts = [
    'Optimize the following selected prompt for use in a terminal coding-agent session.',
    '',
    '<selected_prompt>',
    selectedText,
    '</selected_prompt>'
  ]

  const terminalContext = input.terminalContext?.trim()
  if (terminalContext) {
    parts.push(
      '',
      '<optional_terminal_context>',
      terminalContext.slice(0, 6000),
      '</optional_terminal_context>'
    )
  }

  return parts.join('\n')
}

function normalizeSelectedText(input: OptimizePromptInput): OptimizePromptInput {
  const selectedText = String(input?.selectedText ?? '').trim()
  if (!selectedText) throw new Error('Select text to optimize.')
  if (selectedText.length > MAX_OPTIMIZER_SELECTION_CHARS) {
    throw new Error(`Selected text is too long. Limit selections to ${MAX_OPTIMIZER_SELECTION_CHARS.toLocaleString()} characters for now.`)
  }
  return {
    selectedText,
    terminalContext: typeof input.terminalContext === 'string' ? input.terminalContext : undefined
  }
}

function parseOpenAIErrorBody(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const maybeError = (body as { error?: unknown }).error
  if (maybeError && typeof maybeError === 'object') {
    const message = (maybeError as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) return message.trim()
  }
  const message = (body as { message?: unknown }).message
  if (typeof message === 'string' && message.trim()) return message.trim()
  return null
}

function normalizeOpenAIError(message: string): string {
  const lower = message.toLowerCase()
  if (lower.includes('incorrect api key') || lower.includes('invalid api key') || lower.includes('401')) {
    return 'OpenAI rejected the API key.'
  }
  if (lower.includes('model') && (lower.includes('not found') || lower.includes('does not exist'))) {
    return 'OpenAI could not find that model.'
  }
  if (lower.includes('insufficient_quota') || lower.includes('quota') || lower.includes('billing')) {
    return 'OpenAI reported a quota or billing issue.'
  }
  if (lower.includes('rate limit') || lower.includes('429')) {
    return 'OpenAI rate-limited this request.'
  }
  return message
}

async function readOpenAIError(response: Response): Promise<string> {
  const fallback = `OpenAI request failed with HTTP ${response.status}.`
  try {
    const body = await response.json()
    return normalizeOpenAIError(parseOpenAIErrorBody(body) ?? fallback)
  } catch {
    try {
      const text = await response.text()
      return normalizeOpenAIError(text.trim() || fallback)
    } catch {
      return fallback
    }
  }
}

function extractResponseText(body: unknown): string {
  if (!body || typeof body !== 'object') return ''
  const direct = (body as { output_text?: unknown }).output_text
  if (typeof direct === 'string') return direct

  const output = (body as { output?: unknown }).output
  if (!Array.isArray(output)) return ''

  const chunks: string[] = []
  for (const item of output) {
    if (!item || typeof item !== 'object') continue
    const content = (item as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const text = (part as { text?: unknown }).text
      if (typeof text === 'string') chunks.push(text)
    }
  }

  return chunks.join('\n').trim()
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return fenced ? fenced[1].trim() : trimmed
}

function recoverOptimizedPromptFromJsonLikeText(text: string): string | null {
  const keyIndex = text.indexOf('"optimizedPrompt"')
  if (keyIndex < 0) return null

  const colonIndex = text.indexOf(':', keyIndex)
  if (colonIndex < 0) return null

  const firstQuoteIndex = text.indexOf('"', colonIndex + 1)
  if (firstQuoteIndex < 0) return null

  let value = ''
  let escaped = false
  for (let i = firstQuoteIndex + 1; i < text.length; i++) {
    const ch = text[i]
    if (escaped) {
      value += `\\${ch}`
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '"') {
      break
    }
    value += ch
  }

  if (!value.trim()) return null
  try {
    return JSON.parse(`"${value}"`).trim()
  } catch {
    return value
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
      .trim()
  }
}

function parseOptimizerResult(text: string): OptimizePromptResult {
  const trimmed = stripJsonFence(text)
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    const recovered = recoverOptimizedPromptFromJsonLikeText(trimmed)
    if (recovered) return { optimizedPrompt: recovered }
    if (!trimmed) throw new Error('OpenAI returned an empty optimizer response.')
    if (trimmed.startsWith('{')) throw new Error('OpenAI returned malformed optimizer JSON.')
    return { optimizedPrompt: trimmed }
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('OpenAI returned an invalid optimizer response.')
  }

  const optimizedPrompt = (parsed as { optimizedPrompt?: unknown }).optimizedPrompt
  if (typeof optimizedPrompt !== 'string' || !optimizedPrompt.trim()) {
    throw new Error('OpenAI returned an optimizer response without an optimized prompt.')
  }

  return {
    optimizedPrompt: optimizedPrompt.trim()
  }
}

async function createOpenAIResponse(apiKey: string, body: Record<string, unknown>): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 45_000)
  try {
    const response = await fetch(OPENAI_RESPONSES_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    })

    if (!response.ok) {
      throw new Error(await readOpenAIError(response))
    }

    return await response.json()
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('OpenAI request timed out.')
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }
}

async function optimizeWithOpenAI(config: ResolvedOptimizerConfig, input: OptimizePromptInput): Promise<OptimizePromptResult> {
  if (config.provider !== 'openai') throw new Error('Unsupported optimizer provider.')
  const normalized = normalizeSelectedText(input)
  const body = await createOpenAIResponse(config.apiKey, {
    model: config.model,
    input: [
      { role: 'system', content: OPTIMIZER_SYSTEM_PROMPT },
      { role: 'user', content: buildOptimizerUserPrompt(normalized) }
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'prompt_optimizer_result',
        strict: true,
        schema: OPTIMIZER_JSON_SCHEMA
      }
    },
    max_output_tokens: 3600
  })

  return parseOptimizerResult(extractResponseText(body))
}

async function testOpenAIConnection(config: ResolvedOptimizerConfig): Promise<void> {
  await createOpenAIResponse(config.apiKey, {
    model: config.model,
    input: [
      { role: 'system', content: 'Return JSON that matches the provided schema.' },
      { role: 'user', content: 'Validate this Prompt Optimizer connection.' }
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'optimizer_connection_test',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok'],
          properties: {
            ok: { type: 'boolean' }
          }
        }
      }
    },
    max_output_tokens: 40
  })
}

// Only allow http/https URLs to be opened externally.
// Blocks file://, javascript:, custom schemes, and anything else that could
// be used to open local files or trigger other installed apps maliciously.
function isSafeExternalUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

// Only allow real absolute filesystem paths (no URLs, no null bytes).
function isSafeOpenPath(p: string): boolean {
  return typeof p === 'string' && p.startsWith('/') && !p.includes('\0')
}

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

  // .zshrc — sourced for interactive shells
  fs.writeFileSync(join(dir, '.zshrc'), [
    '# Restore ZDOTDIR so any subshells use the normal ~/.zshrc, not this wrapper',
    'export ZDOTDIR="$HOME"',
    '',
    '# Source the user\'s real interactive config',
    '[[ -f "$HOME/.zshrc" ]] && source "$HOME/.zshrc"',
  ].join('\n') + '\n')

  // .zlogin — sourced for login shells after .zshrc
  fs.writeFileSync(join(dir, '.zlogin'),
    '[[ -f "$HOME/.zlogin" ]] && source "$HOME/.zlogin"\n')

  return dir
}

function createWindow(): void {
  const iconPath = join(__dirname, '../../build/icon.icns')
  const appIcon = nativeImage.createFromPath(iconPath)
  if (!appIcon.isEmpty()) app.dock?.setIcon(appIcon)

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
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
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
    if (isSafeExternalUrl(details.url)) shell.openExternal(details.url)
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

    const ptyProcess = pty.spawn(shell, ['-l'], {
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

  // Open URLs in default browser — only http/https allowed
  ipcMain.handle('shell:openExternal', (_, url: string) => {
    if (isSafeExternalUrl(url)) return shell.openExternal(url)
  })

  // Open file paths in Finder / default app — must be a real absolute path
  ipcMain.handle('shell:openPath', (_, path: string) => {
    if (isSafeOpenPath(path)) return shell.openPath(path)
  })

  ipcMain.handle('optimizer:getSettings', () => {
    return getPublicOptimizerSettings()
  })

  ipcMain.handle('optimizer:saveSettings', (_, input: OptimizerSettingsInput) => {
    saveOptimizerSettings(input)
    return getPublicOptimizerSettings()
  })

  ipcMain.handle('optimizer:clearSettings', () => {
    clearOptimizerSettings()
    return getPublicOptimizerSettings()
  })

  ipcMain.handle('optimizer:testSettings', async (_, input?: Partial<OptimizerSettingsInput>) => {
    const validation = validateOptimizerSettingsForUse(input)
    if (!validation.ok) return validation
    try {
      const config = resolveOptimizerConfig(input)
      await testOpenAIConnection(config)
      return { ok: true }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Could not connect to OpenAI.'
      }
    }
  })

  ipcMain.handle('optimizer:optimize', async (_, input: OptimizePromptInput) => {
    const config = resolveOptimizerConfig()
    return optimizeWithOpenAI(config, input)
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
