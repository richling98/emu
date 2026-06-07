/// <reference types="vite/client" />

type OptimizerProvider = 'openai'

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

interface OptimizerTestResult {
  ok: boolean
  error?: string
}

interface OptimizePromptInput {
  selectedText: string
  terminalContext?: string
}

interface OptimizePromptResult {
  optimizedPrompt: string
  summary?: string
  warnings?: string[]
}

interface MarkdownOpenInput {
  rawPath: string
  cwd?: string | null
}

interface MarkdownDocument {
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

type MarkdownOpenResult = MarkdownDocument | MarkdownOpenFailure

type MarkdownImageResult = {
  ok: true
  dataUrl: string
  path: string
} | {
  ok: false
  error: string
}

interface PtyWriteChunk {
  data: string
  delayAfterMs?: number
}

type PtyWriteSequenceResult = {
  ok: true
} | {
  ok: false
  reason: 'not-found' | 'invalid-input'
}

interface Window {
  api: {
    ptyCreate: (sessionId: string, options?: { cwd?: string | null }) => Promise<{ pid: number }>
    ptyWrite: (sessionId: string, data: string) => void
    ptyWriteSequence: (sessionId: string, writes: PtyWriteChunk[]) => Promise<PtyWriteSequenceResult>
    ptyResize: (sessionId: string, cols: number, rows: number) => void
    ptyClose: (sessionId: string) => void
    onPtyData: (sessionId: string, callback: (data: string) => void) => () => void
    onPtyExit: (sessionId: string, callback: () => void) => () => void
    onFontZoom: (callback: (delta: number) => void) => () => void
    getFilePath: (file: File) => string
    openExternal: (url: string) => Promise<void>
    openPath: (path: string) => Promise<string>
    markdownOpen: (input: MarkdownOpenInput) => Promise<MarkdownOpenResult>
    markdownImage: (input: MarkdownOpenInput) => Promise<MarkdownImageResult>
    ptyGetProcess: (sessionId: string) => Promise<string | null>
    imageSaveTemp: (dataUrl: string, suggestedName?: string) => Promise<string>
    optimizerGetSettings: () => Promise<PublicOptimizerSettings>
    optimizerSaveSettings: (input: OptimizerSettingsInput) => Promise<PublicOptimizerSettings>
    optimizerClearSettings: () => Promise<PublicOptimizerSettings>
    optimizerTestSettings: (input?: Partial<OptimizerSettingsInput>) => Promise<OptimizerTestResult>
    optimizerOptimize: (input: OptimizePromptInput) => Promise<OptimizePromptResult>
  }
}
