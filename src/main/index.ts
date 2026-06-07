import { app, shell, BrowserWindow, ipcMain, nativeImage, safeStorage } from 'electron'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'path'
import fs from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import * as pty from 'node-pty'
import os from 'os'
import { fileURLToPath } from 'url'

// Track active PTY processes by session ID
const ptyProcesses = new Map<string, pty.IPty>()
const ptyPerfStats = new Map<string, PtyPerfStats>()
const ptyOutputBatches = new Map<string, PtyOutputBatch>()

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

interface PtyCreateOptions {
  cwd?: string | null
}

interface PtyWriteChunk {
  data: string
  delayAfterMs?: number
}

interface PtyPerfStats {
  sessionId: string
  pid: number
  createdAt: number
  dataEvents: number
  dataBytes: number
  ipcMessages: number
  ipcBytes: number
  ptyWriteEvents: number
  ptyWriteBytes: number
  resizeEvents: number
  processPolls: number
  lastDataAt: number | null
}

interface PtyOutputBatch {
  chunks: string[]
  bytes: number
  sender: Electron.WebContents
  timer: ReturnType<typeof setTimeout> | null
}

interface PerfStatsSnapshot {
  capturedAt: number
  process: {
    cpuPercent: number | null
    idleWakeupsPerSecond: number | null
    memory?: Record<string, number>
  }
  appMetrics: Electron.ProcessMetric[]
  totals: Omit<PtyPerfStats, 'sessionId' | 'pid' | 'createdAt' | 'lastDataAt'>
  sessions: PtyPerfStats[]
}

type PtyWriteSequenceResult = {
  ok: true
} | {
  ok: false
  reason: 'not-found' | 'invalid-input'
}

interface OptimizePromptResult {
  optimizedPrompt: string
}

interface MarkdownOpenInput {
  rawPath: string
  cwd?: string | null
}

interface MarkdownOpenSuccess {
  ok: true
  path: string
  name: string
  directory: string
  markdown: string
  size: number
  mtimeMs: number
}

interface MarkdownOpenFailure {
  ok: false
  reason: 'invalid-path' | 'not-markdown' | 'not-found' | 'not-file' | 'too-large' | 'read-error'
  error: string
  path?: string
}

type MarkdownImageResult = {
  ok: true
  dataUrl: string
  path: string
} | {
  ok: false
  error: string
}

interface ResolvedOptimizerConfig {
  provider: OptimizerProvider
  model: string
  apiKey: string
}

const DEFAULT_OPTIMIZER_MODEL = 'gpt-5-mini'
const MAX_OPTIMIZER_SELECTION_CHARS = 20_000
const MAX_MARKDOWN_BYTES = 5 * 1024 * 1024
const MAX_MARKDOWN_IMAGE_BYTES = 10 * 1024 * 1024
const PTY_OUTPUT_BATCH_MS = 12
const PTY_OUTPUT_BATCH_MAX_BYTES = 256 * 1024
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses'
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkd'])
const MARKDOWN_IMAGE_MIME_BY_EXT = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp']
])

function createPtyPerfStats(sessionId: string, pid: number): PtyPerfStats {
  return {
    sessionId,
    pid,
    createdAt: Date.now(),
    dataEvents: 0,
    dataBytes: 0,
    ipcMessages: 0,
    ipcBytes: 0,
    ptyWriteEvents: 0,
    ptyWriteBytes: 0,
    resizeEvents: 0,
    processPolls: 0,
    lastDataAt: null
  }
}

function byteLength(data: string): number {
  return Buffer.byteLength(data, 'utf8')
}

function flushPtyOutputBatch(sessionId: string): void {
  const batch = ptyOutputBatches.get(sessionId)
  if (!batch) return
  if (batch.timer) {
    clearTimeout(batch.timer)
    batch.timer = null
  }
  ptyOutputBatches.delete(sessionId)

  if (batch.chunks.length === 0 || batch.sender.isDestroyed()) return
  const data = batch.chunks.length === 1 ? batch.chunks[0] : batch.chunks.join('')
  batch.sender.send(`pty:data:${sessionId}`, data)

  const stats = ptyPerfStats.get(sessionId)
  if (stats) {
    stats.ipcMessages += 1
    stats.ipcBytes += batch.bytes
  }
}

function queuePtyOutput(sessionId: string, sender: Electron.WebContents, data: string, bytes: number): void {
  if (sender.isDestroyed()) return

  let batch = ptyOutputBatches.get(sessionId)
  if (!batch) {
    batch = {
      chunks: [],
      bytes: 0,
      sender,
      timer: null
    }
    ptyOutputBatches.set(sessionId, batch)
  }

  batch.chunks.push(data)
  batch.bytes += bytes
  batch.sender = sender

  if (batch.bytes >= PTY_OUTPUT_BATCH_MAX_BYTES) {
    flushPtyOutputBatch(sessionId)
    return
  }

  if (!batch.timer) {
    batch.timer = setTimeout(() => flushPtyOutputBatch(sessionId), PTY_OUTPUT_BATCH_MS)
  }
}

async function getPerfStatsSnapshot(): Promise<PerfStatsSnapshot> {
  const sessions = Array.from(ptyPerfStats.values()).map((stats) => ({ ...stats }))
  const totals = sessions.reduce<PerfStatsSnapshot['totals']>((acc, stats) => {
    acc.dataEvents += stats.dataEvents
    acc.dataBytes += stats.dataBytes
    acc.ipcMessages += stats.ipcMessages
    acc.ipcBytes += stats.ipcBytes
    acc.ptyWriteEvents += stats.ptyWriteEvents
    acc.ptyWriteBytes += stats.ptyWriteBytes
    acc.resizeEvents += stats.resizeEvents
    acc.processPolls += stats.processPolls
    return acc
  }, {
    dataEvents: 0,
    dataBytes: 0,
    ipcMessages: 0,
    ipcBytes: 0,
    ptyWriteEvents: 0,
    ptyWriteBytes: 0,
    resizeEvents: 0,
    processPolls: 0
  })

  const electronProcess = process as NodeJS.Process & {
    getCPUUsage?: () => { percentCPUUsage?: number; idleWakeupsPerSecond?: number }
    getProcessMemoryInfo?: () => Promise<Record<string, number>>
  }
  const cpu = electronProcess.getCPUUsage?.()
  let memory: Record<string, number> | undefined
  try {
    memory = await electronProcess.getProcessMemoryInfo?.()
  } catch {
    memory = undefined
  }

  return {
    capturedAt: Date.now(),
    process: {
      cpuPercent: typeof cpu?.percentCPUUsage === 'number' ? cpu.percentCPUUsage : null,
      idleWakeupsPerSecond: typeof cpu?.idleWakeupsPerSecond === 'number' ? cpu.idleWakeupsPerSecond : null,
      memory
    },
    appMetrics: app.getAppMetrics(),
    totals,
    sessions
  }
}

const OPTIMIZER_SYSTEM_PROMPT = [
  'Role: You are an expert prompt engineer. Your goal is to take a user\'s original prompt and transform it into a high-precision, direct instruction set for an AI coding agent (you are writing the prompt for the agent, so use "you" and direct commands).',
  '',
  '1. The Operational Framework (Plain Text)',
  'Transform the input into a professional instruction set using only these sections:',
  '',
  'OBJECTIVE',
  'Define the high-level goal and the clear criteria for success based on the user\'s intent.',
  '',
  'CONTEXT',
  'Provide only essential background or technical debt details mentioned by the user. If the user provided no additional context, omit this section entirely.',
  '',
  'CONSTRAINTS',
  'Set the guardrails using direct "you" language:',
  '',
  'CHAIN OF THOUGHT: Conduct internal reasoning and internal logic before providing the final output. This reasoning is for your internal processing to ensure accuracy. There is no need to show this to the user unless the user explicitly asked to see your reasoning.',
  '',
  'AMBIGUITY THRESHOLD: If your intent or the technical path is not >90% certain, you must stop and ask no more than 3 targeted follow-up questions to the user. Do not draft the specific questions here; simply instruct the agent to identify and ask them.',
  '',
  'SURGICAL IMPLEMENTATION: You must prioritize a comprehensive solution that integrates seamlessly with existing patterns found during your discovery. Avoid broad refactors unless necessary for the feature to function.',
  '',
  'DELIVERABLES',
  'Specify "A comprehensive code change" and the necessary verification steps (Manual and Automated) to confirm the feature works and has no regressions.',
  '',
  '2. Constraints',
  '',
  'NO HYPOTHETICALS: Do NOT invent file names, UI labels, interaction strings, or specific technical questions.',
  '',
  'TERMINOLOGY: Avoid the word "minimal." Focus on "comprehensive" and "surgical."',
  '',
  '3. Output Requirements',
  'GOAL: Create the most effective optimized prompt ever.',
  '',
  'CONCISENESS: Keep the optimized prompt as lean as possible. Focus strictly on high-signal instructions.',
  '',
  'DIRECT DELIVERY: Output ONLY the optimized prompt. No commentary, analysis, or footers.',
  '',
  'Constraints: Do not invent repository details. Do not invent facts. Do not over-assume. Do not restate or quote the user\'s original prompt. Your goal is to translate the sloppy prompt into a sharp, professional directive without any hallucinated workflow or meta-instructional clutter.',
  '',
  'Return JSON matching the provided schema, with only the optimized prompt in the optimizedPrompt field.'
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

function saveTempImage(dataUrl: string, suggestedName?: string): string {
  const match = /^data:image\/(png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
  if (!match) throw new Error('Unsupported image data.')

  const ext = match[1] === 'jpeg' ? 'jpg' : match[1]
  const safeStem = String(suggestedName ?? 'image')
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'image'
  const dir = join(app.getPath('temp'), 'emu-rich-input-images')
  fs.mkdirSync(dir, { recursive: true })
  const filePath = join(dir, `${safeStem}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`)
  fs.writeFileSync(filePath, Buffer.from(match[2], 'base64'))
  return filePath
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

function normalizeSafeCwd(cwd?: string | null): string | null {
  if (typeof cwd !== 'string' || !cwd.trim() || !isSafeOpenPath(cwd)) return null
  try {
    const stat = fs.statSync(cwd)
    return stat.isDirectory() ? cwd : null
  } catch {
    return null
  }
}

function cleanUserPath(rawPath: string): string {
  const cleaned = String(rawPath ?? '')
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/[),.;]+$/g, '')
  return cleaned.replace(/(\.(?:md|markdown|mdown|mkd)):\d+(?::\d+)?$/i, '$1')
}

function resolveLocalPath(rawPath: string, cwd?: string | null): { ok: true; path: string } | { ok: false; error: string } {
  const cleaned = cleanUserPath(rawPath)
  if (!cleaned || cleaned.includes('\0')) return { ok: false, error: 'Invalid file path.' }

  let candidate = cleaned
  if (candidate.startsWith('file://')) {
    try {
      candidate = fileURLToPath(candidate)
    } catch {
      return { ok: false, error: 'Invalid file URL.' }
    }
  } else if (candidate.startsWith('~/')) {
    candidate = join(os.homedir(), candidate.slice(2))
  } else if (!isAbsolute(candidate)) {
    const baseDir = cwd && isSafeOpenPath(cwd) ? cwd : os.homedir()
    candidate = resolve(baseDir, candidate)
  }

  if (!isSafeOpenPath(candidate)) return { ok: false, error: 'Invalid file path.' }
  return { ok: true, path: candidate }
}

function readMarkdownFile(input: MarkdownOpenInput): MarkdownOpenSuccess | MarkdownOpenFailure {
  const resolved = resolveLocalPath(input.rawPath, input.cwd)
  if (!resolved.ok) return { ok: false, reason: 'invalid-path', error: resolved.error }

  const filePath = resolved.path
  const extension = extname(filePath).toLowerCase()
  if (!MARKDOWN_EXTENSIONS.has(extension)) {
    return { ok: false, reason: 'not-markdown', error: 'This file is not Markdown.', path: filePath }
  }

  let stat: fs.Stats
  try {
    stat = fs.statSync(filePath)
  } catch {
    return { ok: false, reason: 'not-found', error: 'Markdown file was not found.', path: filePath }
  }

  if (!stat.isFile()) return { ok: false, reason: 'not-file', error: 'This path is not a file.', path: filePath }
  if (stat.size > MAX_MARKDOWN_BYTES) {
    return { ok: false, reason: 'too-large', error: 'Markdown file is too large to preview in Emu.', path: filePath }
  }

  try {
    return {
      ok: true,
      path: filePath,
      name: basename(filePath),
      directory: dirname(filePath),
      markdown: fs.readFileSync(filePath, 'utf8'),
      size: stat.size,
      mtimeMs: stat.mtimeMs
    }
  } catch {
    return { ok: false, reason: 'read-error', error: 'Could not read Markdown file.', path: filePath }
  }
}

function readMarkdownImage(input: MarkdownOpenInput): MarkdownImageResult {
  const resolved = resolveLocalPath(input.rawPath, input.cwd)
  if (!resolved.ok) return { ok: false, error: resolved.error }

  const filePath = resolved.path
  const mime = MARKDOWN_IMAGE_MIME_BY_EXT.get(extname(filePath).toLowerCase())
  if (!mime) return { ok: false, error: 'Unsupported image type.' }

  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) return { ok: false, error: 'Image path is not a file.' }
    if (stat.size > MAX_MARKDOWN_IMAGE_BYTES) return { ok: false, error: 'Image is too large to preview in Emu.' }
    const data = fs.readFileSync(filePath)
    return { ok: true, path: filePath, dataUrl: `data:${mime};base64,${data.toString('base64')}` }
  } catch {
    return { ok: false, error: 'Could not read Markdown image.' }
  }
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
    '',
    '# Tell Emu the current directory before each prompt so relative file links resolve correctly',
    'function _emu_report_cwd() { printf "\\033]633;EmuCwd=%s\\007" "$PWD" }',
    'autoload -Uz add-zsh-hook 2>/dev/null',
    'add-zsh-hook precmd _emu_report_cwd 2>/dev/null || precmd_functions+=(_emu_report_cwd)',
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
  const enableWebgl = process.env.EMU_ENABLE_WEBGL === '1'
  const disableVibrancy = process.env.EMU_DISABLE_VIBRANCY === '1'

  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    transparent: !disableVibrancy,
    ...(disableVibrancy ? { backgroundColor: '#1e1e2e' } : { vibrancy: 'sidebar' as const }),
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [
        `--emu-enable-webgl=${enableWebgl ? '1' : '0'}`,
        `--emu-disable-vibrancy=${disableVibrancy ? '1' : '0'}`
      ]
    }
  })

  const resetPageZoom = () => {
    // Electron/Chromium can persist page zoom per origin across app launches.
    // Keep global page zoom pinned at 100% so Cmd+/Cmd- only changes xterm's
    // font size in the terminal area and never scales the sidebar/layout chrome.
    mainWindow.webContents.setZoomLevel(0)
    mainWindow.webContents.setZoomFactor(1)
    mainWindow.webContents.setVisualZoomLevelLimits(1, 1)
  }

  mainWindow.on('ready-to-show', () => {
    resetPageZoom()
    mainWindow.show()
  })

  // Intercept font zoom at the main process level so Electron's page zoom and
  // menu accelerators never steal these keys from the terminal.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (!input.meta || input.type !== 'keyDown') return

    const key = input.key
    const code = input.code
    const zoomDelta =
      key === '=' || key === '+' || code === 'Equal' ? 1 :
      key === '-' || code === 'Minus' ? -1 :
      key === '0' || code === 'Digit0' ? 0 :
      null

    if (zoomDelta !== null) {
      event.preventDefault()
      resetPageZoom()
      mainWindow.webContents.send('font:zoom', zoomDelta)
    }
  })

  mainWindow.webContents.on('dom-ready', resetPageZoom)

  mainWindow.webContents.on('did-finish-load', () => {
    resetPageZoom()
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
  ipcMain.handle('pty:create', (event, sessionId: string, options?: PtyCreateOptions) => {
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
      cwd: normalizeSafeCwd(options?.cwd) ?? os.homedir(),
      env,
    })

    ptyProcesses.set(sessionId, ptyProcess)
    ptyPerfStats.set(sessionId, createPtyPerfStats(sessionId, ptyProcess.pid))

    // Forward PTY output to renderer
    ptyProcess.onData((data) => {
      const stats = ptyPerfStats.get(sessionId)
      const bytes = byteLength(data)
      if (stats) {
        stats.dataEvents += 1
        stats.dataBytes += bytes
        stats.lastDataAt = Date.now()
      }
      queuePtyOutput(sessionId, event.sender, data, bytes)
    })

    ptyProcess.onExit(() => {
      flushPtyOutputBatch(sessionId)
      ptyProcesses.delete(sessionId)
      ptyPerfStats.delete(sessionId)
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
    const stats = ptyPerfStats.get(sessionId)
    if (stats) stats.processPolls += 1
    return ptyProcesses.get(sessionId)?.process ?? null
  })

  ipcMain.handle('perf:getStats', () => {
    return getPerfStatsSnapshot()
  })

  // Open URLs in default browser — only http/https allowed
  ipcMain.handle('shell:openExternal', (_, url: string) => {
    if (isSafeExternalUrl(url)) return shell.openExternal(url)
    return null
  })

  // Open file paths in Finder / default app — must be a real absolute path
  ipcMain.handle('shell:openPath', (_, path: string) => {
    if (isSafeOpenPath(path)) return shell.openPath(path)
    return null
  })

  ipcMain.handle('markdown:open', (_, input: MarkdownOpenInput) => {
    return readMarkdownFile(input)
  })

  ipcMain.handle('markdown:image', (_, input: MarkdownOpenInput) => {
    return readMarkdownImage(input)
  })

  ipcMain.handle('image:saveTemp', (_, dataUrl: string, suggestedName?: string) => {
    return saveTempImage(dataUrl, suggestedName)
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
    const stats = ptyPerfStats.get(sessionId)
    if (stats) {
      stats.ptyWriteEvents += 1
      stats.ptyWriteBytes += byteLength(data)
    }
    ptyProcesses.get(sessionId)?.write(data)
  })

  ipcMain.handle('pty:writeSequence', async (_, sessionId: string, writes: PtyWriteChunk[]): Promise<PtyWriteSequenceResult> => {
    const ptyProcess = ptyProcesses.get(sessionId)
    if (!ptyProcess) return { ok: false, reason: 'not-found' }
    if (!Array.isArray(writes) || writes.length === 0 || writes.length > 8) {
      return { ok: false, reason: 'invalid-input' }
    }

    for (const write of writes) {
      if (!write || typeof write.data !== 'string') return { ok: false, reason: 'invalid-input' }
      const stats = ptyPerfStats.get(sessionId)
      if (stats) {
        stats.ptyWriteEvents += 1
        stats.ptyWriteBytes += byteLength(write.data)
      }
      ptyProcess.write(write.data)
      const delayAfterMs = typeof write.delayAfterMs === 'number'
        ? Math.max(0, Math.min(2_000, write.delayAfterMs))
        : 0
      if (delayAfterMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayAfterMs))
      }
    }

    return { ok: true }
  })

  // Resize PTY
  ipcMain.on('pty:resize', (_, sessionId: string, cols: number, rows: number) => {
    const stats = ptyPerfStats.get(sessionId)
    if (stats) stats.resizeEvents += 1
    ptyProcesses.get(sessionId)?.resize(cols, rows)
  })

  // Close PTY
  ipcMain.on('pty:close', (_, sessionId: string) => {
    flushPtyOutputBatch(sessionId)
    ptyProcesses.get(sessionId)?.kill()
    ptyProcesses.delete(sessionId)
    ptyPerfStats.delete(sessionId)
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
