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
    ptyGetProcess: (sessionId: string) => Promise<string | null>
    optimizerGetSettings: () => Promise<PublicOptimizerSettings>
    optimizerSaveSettings: (input: OptimizerSettingsInput) => Promise<PublicOptimizerSettings>
    optimizerClearSettings: () => Promise<PublicOptimizerSettings>
    optimizerTestSettings: (input?: Partial<OptimizerSettingsInput>) => Promise<OptimizerTestResult>
    optimizerOptimize: (input: OptimizePromptInput) => Promise<OptimizePromptResult>
  }
}
