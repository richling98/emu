export type AgentPermissionProvider = 'claude' | 'codex'

export interface AgentPermissionPrompt {
  id: string
  sessionId: string
  provider: AgentPermissionProvider
  summary: string
  detail: string
  rawExcerpt: string
  fingerprint: string
  createdAt: number
  approveAction: PtyWriteChunk[]
  denyAction: PtyWriteChunk[]
}

interface DetectionContext {
  sessionId: string
  provider: AgentPermissionProvider | null
  agentSession: boolean
}

interface ParsedPermissionPrompt {
  provider: AgentPermissionProvider
  summary: string
  detail: string
  rawExcerpt: string
  fingerprint: string
  approveAction: PtyWriteChunk[]
  denyAction: PtyWriteChunk[]
}

const MAX_SNAPSHOT_LINES = 80
const MAX_EXCERPT_CHARS = 900

function normalizeTerminalText(text: string): string {
  return text
    .replace(/\x1b\[[\x20-\x3f]*[\x40-\x7e]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[()][AB012]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(/\r/g, '\n')
}

function normalizeLine(line: string): string {
  return line
    .replace(/[│┃┆┊╎╏║]/g, ' ')
    .replace(/[╭╮╰╯┌┐└┘├┤┬┴┼─━═]+/g, ' ')
    .replace(/^[\s>›❯*•●]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function stableToken(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

function promptId(): string {
  return crypto.randomUUID()
}

function snapshotLines(text: string): string[] {
  return normalizeTerminalText(text)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => normalizeLine(line).length > 0)
    .slice(-MAX_SNAPSHOT_LINES)
}

function extractCodexPromptBlock(lines: string[]): string[] | null {
  let start = -1
  for (let index = lines.length - 1; index >= 0; index--) {
    const normalized = normalizeLine(lines[index])
    if (/would you like to run the following command\?/i.test(normalized) ||
      /would you like to .*following command\?/i.test(normalized)) {
      start = index
      break
    }
  }
  if (start === -1) return null

  const block = lines.slice(start)
  const hasProceed = block.some((line) => /\byes,\s*proceed\b/i.test(normalizeLine(line)) && /\(y\)/i.test(line))
  const hasDeny = block.some((line) => /\bno,\s*and\b/i.test(normalizeLine(line)) && /\(esc\)/i.test(line))
  const hasConfirmHint = block.some((line) => /press enter to confirm|esc to cancel/i.test(normalizeLine(line)))
  if (!hasProceed || !hasDeny || !hasConfirmHint) return null
  return block
}

function commandFromCodexBlock(block: string[]): string | null {
  for (const line of block) {
    const normalized = normalizeLine(line)
    const match = /^\$\s+(.+)$/.exec(normalized)
    if (match?.[1]) return match[1].trim()
  }
  return null
}

function reasonFromCodexBlock(block: string[]): string {
  for (const line of block) {
    const normalized = normalizeLine(line)
    const match = /^reason:\s*(.+)$/i.exec(normalized)
    if (match?.[1]) return match[1].trim()
  }
  return ''
}

function parseCodexPermissionPrompt(text: string): ParsedPermissionPrompt | null {
  const lines = snapshotLines(text)
  const block = extractCodexPromptBlock(lines)
  if (!block) return null

  const command = commandFromCodexBlock(block)
  if (!command) return null

  const reason = reasonFromCodexBlock(block)
  const rawExcerpt = block.map(normalizeLine).filter(Boolean).join('\n').slice(0, MAX_EXCERPT_CHARS)

  return {
    provider: 'codex',
    summary: `Run: ${command}`,
    detail: reason,
    rawExcerpt,
    fingerprint: `codex:command:${stableToken(command)}`,
    approveAction: [{ data: 'y' }],
    denyAction: [{ data: '\x1b' }]
  }
}

function isClaudePromptStart(line: string): boolean {
  const normalized = normalizeLine(line)
  return /^(bash|shell)\s+command\b/i.test(normalized) ||
    /^tool\s+use\b/i.test(normalized) ||
    /^use\s+skill\b/i.test(normalized) ||
    /\b(approval|permission)\s+(required|needed)\b/i.test(normalized) ||
    /\b(needs|requires)\s+(your\s+)?(approval|permission)\b/i.test(normalized) ||
    /\b(do you want to|would you like to)\b.*\b(proceed|continue|run|execute|allow|approve|use)\b/i.test(normalized) ||
    /\b(allow|approve)\b.*\b(command|tool|bash|shell|edit|write|file|network|mcp)\b/i.test(normalized)
}

function choiceText(line: string): string {
  return normalizeLine(line)
    .replace(/^\d+[.)]\s*/, '')
    .replace(/^\[[^\]]+\]\s*/, '')
    .trim()
}

function isApproveChoice(line: string): boolean {
  return /^(yes|approve|allow|proceed|continue)\b/i.test(choiceText(line))
}

function isDenyChoice(line: string): boolean {
  return /^(no|deny|reject|cancel)\b/i.test(choiceText(line))
}

function extractChoiceHotkey(line: string): string | null {
  const match = /\(([^)]+)\)/.exec(line)
  if (!match?.[1]) return null
  const hotkey = match[1].trim().toLowerCase()
  if (/^(y|n|a|d|esc|escape|enter|return)$/.test(hotkey)) return hotkey
  return null
}

function ptyActionForHotkey(hotkey: string): PtyWriteChunk[] {
  switch (hotkey) {
    case 'esc':
    case 'escape':
      return [{ data: '\x1b' }]
    case 'enter':
    case 'return':
      return [{ data: '\r' }]
    default:
      return [{ data: hotkey }]
  }
}

interface ClaudeChoice {
  kind: 'approve' | 'deny'
  selected: boolean
  hotkey: string | null
}

function claudeChoices(block: string[]): ClaudeChoice[] {
  const choices: ClaudeChoice[] = []
  for (const line of block) {
    const kind = isApproveChoice(line)
      ? 'approve'
      : isDenyChoice(line)
        ? 'deny'
        : null
    if (!kind) continue
    const trimmed = line.trimStart()
    choices.push({
      kind,
      selected: /^[>›❯]/.test(trimmed),
      hotkey: extractChoiceHotkey(line)
    })
  }
  return choices
}

function menuActionForClaudeChoice(choices: ClaudeChoice[], kind: 'approve' | 'deny'): PtyWriteChunk[] {
  const choiceIndex = choices.findIndex((choice) => choice.kind === kind)
  if (choiceIndex === -1) return kind === 'approve' ? [{ data: 'y' }] : [{ data: 'n' }]

  const hotkey = choices[choiceIndex].hotkey
  if (hotkey) return ptyActionForHotkey(hotkey)

  const selectedIndex = choices.findIndex((choice) => choice.selected)
  const firstApproveIndex = choices.findIndex((choice) => choice.kind === 'approve')
  const fromIndex = selectedIndex === -1 ? Math.max(0, firstApproveIndex) : selectedIndex
  if (choiceIndex === fromIndex) return [{ data: '\r' }]

  const arrow = choiceIndex > fromIndex ? '\x1b[B' : '\x1b[A'
  return [
    { data: arrow.repeat(Math.abs(choiceIndex - fromIndex)) },
    { data: '\r' }
  ]
}

function commandFromClaudeBlock(block: string[]): string | null {
  for (let index = 0; index < block.length; index++) {
    const normalized = normalizeLine(block[index])
    const bashCall = /\bBash\s*\(\s*([^)]+?)\s*\)/i.exec(normalized)
    if (bashCall?.[1]) {
      return bashCall[1]
        .trim()
        .replace(/^command:\s*/i, '')
        .replace(/^["'`]|["'`]$/g, '')
    }

    const shellCommand = /^(?:bash|shell)?\s*command:\s*(.+)$/i.exec(normalized)
    if (shellCommand?.[1]) return shellCommand[1].trim().replace(/^["'`]|["'`]$/g, '')

    const dollarCommand = /^\$\s+(.+)$/.exec(normalized)
    if (dollarCommand?.[1]) return dollarCommand[1].trim()

    if (/^(bash|shell)\s+command$/i.test(normalized)) {
      for (const candidate of block.slice(index + 1, index + 5)) {
        const candidateLine = normalizeLine(candidate).replace(/^\$\s+/, '').trim()
        if (!candidateLine || isApproveChoice(candidateLine) || isDenyChoice(candidateLine)) continue
        if (isClaudePromptStart(candidateLine)) continue
        return candidateLine.replace(/^["'`]|["'`]$/g, '')
      }
    }
  }
  return null
}

function skillFromClaudeBlock(block: string[]): string | null {
  for (const line of block) {
    const normalized = normalizeLine(line)
    const useSkill = /^use\s+skill\s+["'`]?([^"'`?]+)["'`]?\??$/i.exec(normalized)
    if (useSkill?.[1]) return useSkill[1].trim()

    const skillCall = /\bSkill\s*\(\s*([^)]+?)\s*\)/i.exec(normalized)
    if (skillCall?.[1]) return skillCall[1].trim().replace(/^["'`]|["'`]$/g, '')
  }
  return null
}

function detailFromClaudeBlock(block: string[]): string {
  for (const line of block) {
    const normalized = normalizeLine(line)
    const match = /^(reason|description):\s*(.+)$/i.exec(normalized)
    if (match?.[2]) return match[2].trim()
  }
  const toolLine = block.map(normalizeLine).find((line) =>
    /\b(edit|write|read|webfetch|mcp|network|tool|skill)\b/i.test(line) &&
    !isApproveChoice(line) &&
    !isDenyChoice(line)
  )
  return toolLine ?? ''
}

function extractClaudePromptBlock(lines: string[], providerConfirmed: boolean): string[] | null {
  const hasExplicitClaude = lines.some((line) => /\bclaude( code)?\b/i.test(normalizeLine(line)))
  if (!providerConfirmed && !hasExplicitClaude) return null

  let promptIndex = -1
  for (let index = lines.length - 1; index >= 0; index--) {
    const normalized = normalizeLine(lines[index])
    if (isClaudePromptStart(normalized) || (/claude/i.test(normalized) && /\b(allow|approve|permission)\b/i.test(normalized))) {
      promptIndex = index
      break
    }
  }
  if (promptIndex === -1) return null

  const block = lines.slice(Math.max(0, promptIndex - 8))
  const choices = claudeChoices(block)
  const hasApprove = choices.some((choice) => choice.kind === 'approve')
  const hasDeny = choices.some((choice) => choice.kind === 'deny')
  if (!hasApprove || !hasDeny) return null
  return block
}

function parseClaudePermissionPrompt(text: string, providerConfirmed = true): ParsedPermissionPrompt | null {
  const lines = snapshotLines(text)
  const block = extractClaudePromptBlock(lines, providerConfirmed)
  if (!block) return null

  const normalized = block.map(normalizeLine).filter(Boolean)
  const choices = claudeChoices(block)
  const command = commandFromClaudeBlock(block)
  const skill = skillFromClaudeBlock(block)
  const detail = detailFromClaudeBlock(block)
  const action = command
    ? `Run: ${command}`
    : skill
      ? `Use skill: ${skill}`
    : normalized.find((line) =>
        /\b(bash|command|edit|write|tool|skill|mcp|network|webfetch|permission|approval)\b/i.test(line) &&
        !isApproveChoice(line) &&
        !isDenyChoice(line)
      ) ?? normalized[0]
  if (!action) return null
  const fingerprintSource = command ? `command:${command}` : skill ? `skill:${skill}` : action

  return {
    provider: 'claude',
    summary: action.slice(0, 150),
    detail: detail.slice(0, 220),
    rawExcerpt: normalized.join('\n').slice(0, MAX_EXCERPT_CHARS),
    fingerprint: `claude:${stableToken(fingerprintSource).slice(0, 180)}`,
    approveAction: menuActionForClaudeChoice(choices, 'approve'),
    denyAction: menuActionForClaudeChoice(choices, 'deny')
  }
}

function inferProviderFromText(text: string): AgentPermissionProvider | null {
  const normalized = text.toLowerCase()
  if (/\bcodex\b/.test(normalized) || /would you like to run the following command\?/i.test(text)) return 'codex'
  if (/\bclaude( code)?\b/.test(normalized)) return 'claude'
  return null
}

function detectSnapshot(text: string, providerHint: AgentPermissionProvider | null): ParsedPermissionPrompt | null {
  const inferredProvider = inferProviderFromText(text)
  if (inferredProvider === 'codex') return parseCodexPermissionPrompt(text) ?? parseClaudePermissionPrompt(text, false)
  if (inferredProvider === 'claude') return parseClaudePermissionPrompt(text, true) ?? parseCodexPermissionPrompt(text)
  if (providerHint === 'codex') return parseCodexPermissionPrompt(text) ?? parseClaudePermissionPrompt(text, false)
  if (providerHint === 'claude') return parseClaudePermissionPrompt(text, true) ?? parseCodexPermissionPrompt(text)
  return parseCodexPermissionPrompt(text) ?? parseClaudePermissionPrompt(text, false)
}

export class AgentPermissionPromptDetector {
  private lastFingerprint: string | null = null

  append(data: string, context: DetectionContext): AgentPermissionPrompt | null {
    if (!context.agentSession && !inferProviderFromText(data)) {
      this.lastFingerprint = null
      return null
    }

    const parsed = detectSnapshot(data, context.provider)
    if (!parsed) {
      this.lastFingerprint = null
      return null
    }
    if (parsed.fingerprint === this.lastFingerprint) return null
    this.lastFingerprint = parsed.fingerprint

    return {
      id: promptId(),
      sessionId: context.sessionId,
      provider: parsed.provider,
      summary: parsed.summary,
      detail: parsed.detail,
      rawExcerpt: parsed.rawExcerpt,
      fingerprint: parsed.fingerprint,
      createdAt: Date.now(),
      approveAction: parsed.approveAction,
      denyAction: parsed.denyAction
    }
  }
}

export const __agentPermissionPromptTest = {
  parseCodexPermissionPrompt,
  parseClaudePermissionPrompt,
  normalizeTerminalText
}
