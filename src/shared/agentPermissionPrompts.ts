export interface PtyWriteChunk {
  data: string
  delayAfterMs?: number
}

export type AgentPermissionProvider = 'claude' | 'codex' | 'opencode'

export interface AgentPermissionPrompt {
  id: string
  sessionId: string
  provider: AgentPermissionProvider
  workspaceName?: string
  summary: string
  detail: string
  rawExcerpt: string
  fingerprint: string
  createdAt: number
  approveAction: PtyWriteChunk[]
  denyAction: PtyWriteChunk[]
}

export type AgentPermissionMissReason =
  | 'no_permission_shape'
  | 'provider_mis_inference'
  | 'no_subject'
  | 'missing_approve_choice'
  | 'missing_deny_choice'
  | 'missing_wait_hint'
  | 'parser_rejected'

export interface AgentPermissionMissDiagnostic {
  reason: AgentPermissionMissReason
  snapshot: string
  providerHint: AgentPermissionProvider | null
  inferredProvider: AgentPermissionProvider | null
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
const MAX_FINGERPRINT_CHARS = 850

export function normalizeTerminalText(text: string): string {
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

function isStandaloneHotkeyLine(line: string): boolean {
  return /^\((?:y|n|a|d|p|esc|escape|enter|return)\)$/i.test(normalizeLine(line))
}

function isIndentedContinuationLine(line: string): boolean {
  return /^\s+\S/.test(line) && !isMenuChoiceLine(line) && !isWaitHintLine(line)
}

function isOpencodeExternalDirectoryLine(line: string): boolean {
  const normalized = normalizeLine(line).replace(/^[^\w$#]+/, '')
  return /^access\s+external\s+directory\b/i.test(normalized)
}

function logicalPromptLines(lines: string[]): string[] {
  const logicalLines: string[] = []

  for (const line of lines) {
    const normalized = normalizeLine(line)
    if (!normalized) continue

    const previous = logicalLines[logicalLines.length - 1]
    if (previous && (
      isStandaloneHotkeyLine(line) ||
      (isIndentedContinuationLine(line) && isMenuChoiceLine(previous)) ||
      (/^(reason|description):\s+/i.test(normalizeLine(previous)) && !/^\$\s+/.test(normalized) && !isMenuChoiceLine(line) && !isWaitHintLine(line) && !isClaudePromptStart(normalized))
    )) {
      logicalLines[logicalLines.length - 1] = `${previous} ${normalized}`
      continue
    }

    // Xterm hard-wrap: "Access external directory" on its own row followed by
    // the path "~/..." or "/..." on next physical row should be one logical line.
    if (previous && isOpencodeExternalDirectoryLine(previous) && !isOpencodeControlLine(line) && !opencodeIsPatternOrBulletLine(normalized)) {
      logicalLines[logicalLines.length - 1] = `${previous} ${line}`.trimEnd()
      continue
    }

    logicalLines.push(line)
  }

  return logicalLines
}

function normalizedLogicalPromptLines(text: string): string[] {
  return logicalPromptLines(snapshotLines(text))
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
  const hasReason = block.some((line) => /^reason:\s*.+/i.test(normalizeLine(line)))
  const hasWaitHint = block.some(isWaitHintLine)
  const hasWaitEvidence = hasWaitHint || (hasReason && block.some(isSelectedChoiceLine))
  if (!hasProceed || !hasDeny || !hasWaitEvidence) return null
  if (hasSubstantialOutputAfterControls(block, 'codex')) return null
  return block
}

function isWaitHintLine(line: string): boolean {
  return /press enter to confirm|enter (?:to )?(?:submit|confirm)|esc (?:to )?(?:cancel|dismiss)|esc dismiss|↵ select/i.test(normalizeLine(line))
}

function isSelectedChoiceLine(line: string): boolean {
  return /^[>›❯]/.test(line.trimStart())
}

function isMenuChoiceLine(line: string): boolean {
  const trimmed = line.trimStart().replace(/^[>›❯]\s*/, '')
  return /^\d+[.)]\s+/.test(trimmed) || /^\[[^\]]+\]\s+/.test(trimmed)
}

function isGenericPromptControlLine(line: string): boolean {
  return isMenuChoiceLine(line) || isWaitHintLine(line) || isSelectedChoiceLine(line)
}

function isOpencodeControlLine(line: string): boolean {
  return isGenericPromptControlLine(line) || isOpencodeApproveButton(line) || isOpencodeDenyButton(line)
}

function lastPermissionControlIndex(block: string[], provider: AgentPermissionProvider): number {
  let last = -1
  for (let index = 0; index < block.length; index++) {
    const line = block[index]
    if (provider === 'opencode' ? isOpencodeControlLine(line) : isGenericPromptControlLine(line)) {
      last = index
    }
  }
  return last
}

function hasSubstantialOutputAfterControls(block: string[], provider: AgentPermissionProvider): boolean {
  const lastControl = lastPermissionControlIndex(block, provider)
  if (lastControl === -1) return true
  for (const line of block.slice(lastControl + 1)) {
    const normalized = normalizeLine(line)
    if (!normalized) continue
    if (provider === 'opencode' ? isOpencodeControlLine(line) : isGenericPromptControlLine(line)) continue
    return true
  }
  return false
}

function isAgentActivityTraceLine(line: string): boolean {
  const normalized = normalizeLine(line)
  return /\bThought:\s*\d+ms\b/i.test(normalized) ||
    /^[^\w$#]*(?:Read|Edit|Write|Glob|Grep|List|WebFetch|WebSearch)\b\s+(?:\/|https?:|\.|~)/i.test(normalized) ||
    /\b(?:WebFetch|WebSearch)\s+https?:\/\//i.test(normalized) ||
    /%\s*(?:WebFetch|WebSearch)\s+https?:\/\//i.test(normalized) ||
    /^(?:open|collapse|close)(?:\s+(?:open|collapse|close))*$/i.test(normalized)
}

function hasAgentActivityTraceLine(block: string[]): boolean {
  return block.some(isAgentActivityTraceLine)
}

function isOpencodePermissionChromeLine(line: string): boolean {
  const normalized = normalizeLine(line)
  return !normalized ||
    isOpencodePermissionHeading(line) ||
    isOpencodeApproveButton(line) ||
    isOpencodeDenyButton(line) ||
    isWaitHintLine(line) ||
    isSelectedChoiceLine(line) ||
    // External-directory permission panels include a "Patterns" section with
    // glob bullets (e.g. "- /Users/.../*"). These are expected content and
    // must not be treated as "substantial non-chrome output" that would
    // cause the generic heading-only fallback to be suppressed.
    opencodeIsPatternOrBulletLine(normalized)
}

function commandLinesFromCodexBlock(block: string[]): string[] {
  const commandLines: string[] = []
  let commandStarted = false

  for (const line of block) {
    const normalized = normalizeLine(line)
    if (!commandStarted) {
      const match = /^\$\s+(.+)$/.exec(normalized)
      if (match?.[1]) {
        commandStarted = true
        commandLines.push(match[1].trim())
      }
      continue
    }

    if (!normalized ||
      (isMenuChoiceLine(line) && (isApproveChoice(normalized) || isDenyChoice(normalized))) ||
      isWaitHintLine(normalized)) {
      break
    }
    commandLines.push(normalized)
  }

  return commandLines
}

function commandFromCodexBlock(block: string[]): string | null {
  return commandLinesFromCodexBlock(block)[0] ?? null
}

function fullCommandFromCodexBlock(block: string[]): string | null {
  const commandLines = commandLinesFromCodexBlock(block)
  return commandLines.length > 0 ? commandLines.join('\n') : null
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
  const lines = logicalPromptLines(snapshotLines(text))
  return parseCodexCommandPermissionPrompt(lines) ?? parseCodexToolPermissionPrompt(lines)
}

function parseCodexCommandPermissionPrompt(lines: string[]): ParsedPermissionPrompt | null {
  const block = extractCodexPromptBlock(lines)
  if (!block) return null

  const command = commandFromCodexBlock(block)
  if (!command) return null
  const fullCommand = fullCommandFromCodexBlock(block) ?? command

  const reason = reasonFromCodexBlock(block)
  const rawExcerpt = block.map(normalizeLine).filter(Boolean).join('\n').slice(0, MAX_EXCERPT_CHARS)

  return {
    provider: 'codex',
    summary: `Run: ${command}`,
    detail: reason,
    rawExcerpt,
    fingerprint: `codex:command:${stableToken(fullCommand).slice(0, MAX_FINGERPRINT_CHARS)}`,
    approveAction: [{ data: 'y' }],
    denyAction: [{ data: '\x1b' }]
  }
}

function codexToolSubject(line: string): { appName: string, toolName: string } | null {
  const normalized = normalizeLine(line)
  const match = /^allow\s+(.+?)\s+to\s+(?:run|call|use)\s+tool\s+["“]([^"”]+)["”]\??$/i.exec(normalized)
  if (!match?.[1] || !match[2]) return null
  return {
    appName: match[1].trim(),
    toolName: match[2].trim()
  }
}

function extractCodexToolPromptBlock(lines: string[]): string[] | null {
  let start = -1
  for (let index = lines.length - 1; index >= 0; index--) {
    if (codexToolSubject(lines[index])) {
      start = index
      break
    }
  }
  if (start === -1) return null

  const block = lines.slice(start)
  const choices = approvalChoices(block)
  const hasApprove = choices.some((choice) => choice.kind === 'approve')
  const hasDeny = choices.some((choice) => choice.kind === 'deny')
  const hasWaitHint = block.some(isWaitHintLine) || choices.some((choice) => choice.selected)
  if (!hasApprove || !hasDeny || !hasWaitHint) return null
  if (hasSubstantialOutputAfterControls(block, 'codex')) return null
  return block
}

function detailLinesFromPromptBlock(block: string[]): string[] {
  const details: string[] = []
  for (const line of block.slice(1)) {
    const normalized = normalizeLine(line)
    if (!normalized ||
      (isMenuChoiceLine(line) && (isApproveChoice(normalized) || isDenyChoice(normalized))) ||
      isWaitHintLine(normalized)) {
      break
    }
    details.push(normalized)
  }
  return details
}

function parseCodexToolPermissionPrompt(lines: string[]): ParsedPermissionPrompt | null {
  const block = extractCodexToolPromptBlock(lines)
  if (!block) return null

  const subject = codexToolSubject(block[0])
  if (!subject) return null

  const details = detailLinesFromPromptBlock(block)
  const choices = approvalChoices(block)
  const rawExcerpt = block.map(normalizeLine).filter(Boolean).join('\n').slice(0, MAX_EXCERPT_CHARS)
  const fingerprintSource = [
    subject.appName,
    subject.toolName,
    ...details
  ].join('\n')

  return {
    provider: 'codex',
    summary: `Run tool: ${subject.appName} / ${subject.toolName}`.slice(0, 150),
    detail: details.join('\n').slice(0, 220),
    rawExcerpt,
    fingerprint: `codex:tool:${stableToken(fingerprintSource).slice(0, MAX_FINGERPRINT_CHARS)}`,
    approveAction: menuActionForChoice(choices, 'approve', block),
    denyAction: menuActionForChoice(choices, 'deny', block)
  }
}

function isClaudePromptStart(line: string): boolean {
  const normalized = normalizeLine(line)
  return /^(bash|shell)\s+command\b/i.test(normalized) ||
    /^tool\s+use\b/i.test(normalized) ||
    /^use\s+skill\b/i.test(normalized) ||
    /\b(approval|permission)\s+(required|needed)\b/i.test(normalized) ||
    /\b(needs|requires)\s+(your\s+)?(approval|permission)\b/i.test(normalized) ||
    /^(do you want to|would you like to)\b.*\b(proceed|continue|run|execute|allow|approve|use)\b/i.test(normalized) ||
    /\b(allow|approve)\b.*\b(command|tool|bash|shell|edit|write|file|network|mcp)\b/i.test(normalized)
}

function choiceText(line: string): string {
  return normalizeLine(line)
    .replace(/^\d+[.)]\s*/, '')
    .replace(/^\[[^\]]+\]\s*/, '')
    .trim()
}

function isApproveChoice(line: string): boolean {
  return /^(yes|approve|allow|always allow|proceed|continue)\b/i.test(choiceText(line))
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

function approvalChoices(block: string[]): ClaudeChoice[] {
  const choices: ClaudeChoice[] = []
  for (const line of block) {
    if (!isMenuChoiceLine(line)) continue
    const kind = isApproveChoice(line)
      ? 'approve'
      : isDenyChoice(line)
        ? 'deny'
        : null
    if (!kind) continue
    choices.push({
      kind,
      selected: isSelectedChoiceLine(line),
      hotkey: extractChoiceHotkey(line)
    })
  }
  return choices
}

function menuActionForChoice(choices: ClaudeChoice[], kind: 'approve' | 'deny', block: string[] = []): PtyWriteChunk[] {
  if (kind === 'deny' && block.some((line) => /esc to cancel/i.test(normalizeLine(line)))) {
    return [{ data: '\x1b' }]
  }

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
    if (isClaudePromptStart(normalized) || (/^claude( code)?\b/i.test(normalized) && /\b(allow|approve|approval|permission)\b/i.test(normalized))) {
      promptIndex = index
      break
    }
  }
  if (promptIndex === -1) return null

  const block = lines.slice(Math.max(0, promptIndex - 8))
  const choiceBlock = lines.slice(promptIndex)
  const choices = approvalChoices(choiceBlock)
  const hasApprove = choices.some((choice) => choice.kind === 'approve')
  const hasDeny = choices.some((choice) => choice.kind === 'deny')
  if (!hasApprove || !hasDeny) return null
  if (hasSubstantialOutputAfterControls(choiceBlock, 'claude')) return null
  return block
}

function parseClaudePermissionPrompt(text: string, providerConfirmed = true): ParsedPermissionPrompt | null {
  const lines = logicalPromptLines(snapshotLines(text))
  const block = extractClaudePromptBlock(lines, providerConfirmed)
  if (!block) return null

  const normalized = block.map(normalizeLine).filter(Boolean)
  const choices = approvalChoices(block)
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
    approveAction: menuActionForChoice(choices, 'approve', block),
    denyAction: menuActionForChoice(choices, 'deny', block)
  }
}

function isOpencodeApproveButton(line: string): boolean {
  const normalized = normalizeLine(line)
  return /\ballow(?:\s+(?:once|always))?\b/i.test(normalized) || /^approve$/i.test(normalized)
}

function isOpencodeDenyButton(line: string): boolean {
  return /(?:^|\s)(?:deny|reject)(?:\s|$)/i.test(normalizeLine(line))
}

function isOpencodeProceedChoice(line: string): boolean {
  return /^proceed\b/i.test(choiceText(line))
}

function isOpencodeQuestionPrompt(line: string): boolean {
  return /^can i use\b.+\?$/i.test(normalizeLine(line))
}

function isOpencodePermissionSubject(line: string): boolean {
  if (isOpencodeQuestionPrompt(line)) return true
  const normalized = normalizeLine(line).replace(/^[^\w$#]+/, '')
  return /^access\s+external\s+directory\b/i.test(normalized) ||
    /^(shell|bash|edit|write|read|web fetch|web search|task|skill|tool)\b/i.test(normalized) ||
    /^#\s+\S+/.test(normalized) ||
    /^\$\s+\S+/.test(normalized) ||
    /\b(requested|command|tool|file|edit|write|shell|bash)\b/i.test(normalized)
}

function isOpencodeStrongPermissionSubject(line: string): boolean {
  const normalized = normalizeLine(line).replace(/^[^\w$#]+/, '')
  return isOpencodeQuestionPrompt(normalized) ||
    /^#\s+\S+/.test(normalized) ||
    /^\$\s+\S+/.test(normalized) ||
    /^access\s+external\s+directory\b/i.test(normalized)
}

function opencodeIsPatternOrBulletLine(line: string): boolean {
  return /^patterns$/i.test(line) || /^-\s+/.test(line)
}

function opencodePathContinuationCharAllowed(char: string): boolean {
  return /^[\w./~:@\-\\* ]+$/.test(char)
}

function opencodeAccessExternalDirectorySubject(block: string[]): string | null {
  const normalized = block.map(normalizeLine).filter(Boolean)
  for (let index = 0; index < normalized.length; index++) {
    const raw = normalized[index].replace(/^[^\w$#]+/, '').trim()
    if (!/^access\s+external\s+directory\b/i.test(raw)) continue

    const parts: string[] = [raw]
    // Collect xterm-wrapped continuation of the directory path (may be split
    // when terminal is narrow or path contains escaped spaces).
    for (const nextRaw of normalized.slice(index + 1)) {
      const next = nextRaw.trim()
      if (!next) continue
      if (opencodeIsPatternOrBulletLine(next) || isOpencodeControlLine(nextRaw)) break
      // Path continuation: starts with ~/ or /, or looks like a plain path token
      // (including backslash escapes and common glob suffixes)
      if (/^(?:~|\/)/.test(next) || opencodePathContinuationCharAllowed(next)) {
        parts.push(next)
      } else {
        break
      }
    }

    return parts.join(' ').replace(/\s+/g, ' ').replace(/\/\s+/g, '/').trim()
  }
  return null
}

function isOpencodePromptStart(line: string): boolean {
  const normalized = normalizeLine(line)
  return /^[^\w$#]*permission required\b/i.test(normalized) || isOpencodeQuestionPrompt(normalized)
}

function isOpencodePermissionHeading(line: string): boolean {
  return /^[^\w$#]*permission required\b/i.test(normalizeLine(line))
}

function hasOpencodeWaitEvidence(block: string[]): boolean {
  return block.some(isWaitHintLine) || block.some(isSelectedChoiceLine)
}

function hasOpencodePromptShape(lines: string[]): boolean {
  const hasStart = lines.some(isOpencodePromptStart)
  const hasApprove = lines.some((line) => isOpencodeApproveButton(line) || (isMenuChoiceLine(line) && isOpencodeProceedChoice(line)))
  const hasReject = lines.some(isOpencodeDenyButton)
  const hasQuestion = lines.some(isOpencodeQuestionPrompt)
  return hasApprove && (hasReject || hasQuestion) && (hasStart || lines.some(isOpencodePermissionSubject))
}

function opencodeSummaryFromBlock(block: string[]): string {
  const normalized = block.map(normalizeLine).filter(Boolean)
  const command = normalized.find((line) => /^\$\s+\S+/.test(line))
  if (command) return `Run: ${command.replace(/^\$\s+/, '')}`.slice(0, 150)

  const accessDirectory = opencodeAccessExternalDirectorySubject(block)
  if (accessDirectory) return accessDirectory.slice(0, 150)

  const strongSubject = normalized.find((line) =>
    !isOpencodeApproveButton(line) &&
    !isOpencodeDenyButton(line) &&
    !isAgentActivityTraceLine(line) &&
    isOpencodeStrongPermissionSubject(line)
  )
  if (strongSubject) return strongSubject.replace(/^[^\w$#]+/, '').slice(0, 150)

  const subject = normalized.find((line) =>
    !isOpencodeApproveButton(line) &&
    !isOpencodeDenyButton(line) &&
    !isAgentActivityTraceLine(line) &&
    isOpencodePermissionSubject(line)
  )
  return (subject ?? 'Approval needed').slice(0, 150)
}

function parseOpencodePermissionPrompt(text: string): ParsedPermissionPrompt | null {
  const lines = normalizedLogicalPromptLines(text)
  let approveIndex = -1
  let denyIndex = -1
  let proceedIndex = -1

  for (let index = lines.length - 1; index >= 0; index--) {
    if (approveIndex === -1 && isOpencodeApproveButton(lines[index])) approveIndex = index
    if (denyIndex === -1 && isOpencodeDenyButton(lines[index])) denyIndex = index
    if (proceedIndex === -1 && isMenuChoiceLine(lines[index]) && isOpencodeProceedChoice(lines[index])) proceedIndex = index
  }
  const hasButtonPrompt = approveIndex !== -1 && denyIndex !== -1
  const hasQuestionPrompt = proceedIndex !== -1 && lines.some(isOpencodeQuestionPrompt) && lines.some(isWaitHintLine)
  if (!hasButtonPrompt && !hasQuestionPrompt) return null

  const anchor = hasButtonPrompt ? Math.min(approveIndex, denyIndex) : proceedIndex
  const start = Math.max(0, anchor - 8)
  const block = lines.slice(start)
  const hasExplicitPermissionModal = hasButtonPrompt && block.some(isOpencodePermissionHeading)
  if (!block.some(isOpencodePermissionSubject) && !hasExplicitPermissionModal) return null
  if (!hasOpencodeWaitEvidence(block) && !hasExplicitPermissionModal && !hasQuestionPrompt) return null
  if (hasSubstantialOutputAfterControls(block, 'opencode')) return null
  const hasStrongSubject = block.some((line) => isOpencodeStrongPermissionSubject(line) && !isAgentActivityTraceLine(line))
  if (hasExplicitPermissionModal && !hasStrongSubject && hasAgentActivityTraceLine(block)) return null
  if (hasExplicitPermissionModal && !hasStrongSubject && block.some((line) => !isOpencodePermissionChromeLine(line))) return null

  const normalized = block.map(normalizeLine).filter(Boolean)
  const rawExcerpt = normalized.join('\n').slice(0, MAX_EXCERPT_CHARS)
  const filteredFingerprintSource = normalized
    .filter((line) => !isOpencodePermissionHeading(line) && !isOpencodeApproveButton(line) && !isOpencodeDenyButton(line) && !isWaitHintLine(line) && !isAgentActivityTraceLine(line))
    .join('\n')
  const fingerprintSource = opencodeAccessExternalDirectorySubject(block) ??
    (filteredFingerprintSource || (normalized.some(isOpencodePermissionHeading) ? 'permission required' : 'opencode permission'))

  return {
    provider: 'opencode',
    summary: opencodeSummaryFromBlock(block),
    detail: normalized
      .filter((line) => !isOpencodePermissionHeading(line) && !isOpencodeApproveButton(line) && !isOpencodeDenyButton(line) && !isWaitHintLine(line) && !isAgentActivityTraceLine(line))
      .join('\n')
      .slice(0, 220),
    rawExcerpt,
    fingerprint: `opencode:approval:${stableToken(fingerprintSource).slice(0, MAX_FINGERPRINT_CHARS)}`,
    approveAction: hasQuestionPrompt ? menuActionForChoice([{ kind: 'approve', selected: true, hotkey: null }], 'approve') : [{ data: '\r' }],
    denyAction: [{ data: '\x1b' }]
  }
}

export function isAgentProcessName(processName: string | null): boolean {
  if (!processName) return false
  const normalized = processName.toLowerCase().replace(/\\/g, '/').split('/').pop()?.replace(/^-/, '') ?? ''
  return /\b(claude|codex|opencode)\b/.test(normalized)
}

function normalizedProcessBasename(processName: string | null): string {
  return processName?.toLowerCase().replace(/\\/g, '/').split('/').pop()?.replace(/^-/, '') ?? ''
}

export function getAgentProviderFromProcess(processName: string | null): AgentPermissionProvider | null {
  const normalized = normalizedProcessBasename(processName)
  if (normalized.includes('claude')) return 'claude'
  if (normalized.includes('codex')) return 'codex'
  if (normalized.includes('opencode')) return 'opencode'
  return null
}

export function isAgentLaunchCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase()
  if (!normalized) return false
  return /(^|[;&|]\s*)(claude|codex|opencode)([\s;&|]|$)/.test(normalized) ||
    /(^|[;&|]\s*)(npx|npm exec|bunx|pnpm dlx|yarn dlx)\s+([@\w./-]*claude[-\w./]*|[@\w./-]*codex[-\w./]*|[@\w./-]*opencode[-\w./]*)/.test(normalized)
}

export function getAgentProviderFromCommand(command: string): AgentPermissionProvider | null {
  const normalized = command.trim().toLowerCase()
  if (/(^|[;&|]\s*)(claude)([\s;&|]|$)/.test(normalized) ||
    /(^|[;&|]\s*)(npx|npm exec|bunx|pnpm dlx|yarn dlx)\s+([@\w./-]*claude[-\w./]*)/.test(normalized)) {
    return 'claude'
  }
  if (/(^|[;&|]\s*)(codex)([\s;&|]|$)/.test(normalized) ||
    /(^|[;&|]\s*)(npx|npm exec|bunx|pnpm dlx|yarn dlx)\s+([@\w./-]*codex[-\w./]*)/.test(normalized)) {
    return 'codex'
  }
  if (/(^|[;&|]\s*)(opencode)([\s;&|]|$)/.test(normalized) ||
    /(^|[;&|]\s*)(npx|npm exec|bunx|pnpm dlx|yarn dlx)\s+([@\w./-]*opencode[-\w./]*)/.test(normalized)) {
    return 'opencode'
  }
  return null
}

export function inferProviderFromText(text: string): AgentPermissionProvider | null {
  const normalized = text.toLowerCase()
  const lines = normalizedLogicalPromptLines(text)
  if (hasOpencodePromptShape(lines) ||
    /\bopencode\b/.test(normalized) ||
    /\ballow\s+(?:once|always)\b/i.test(text) ||
    /\b(?:deny|reject)\b/i.test(text) && /\ballow\s+(?:once|always)\b/i.test(text) ||
    /can i use\b.+\?/i.test(text) ||
    /\bapprove\b.*\b(?:command|tool|bash|shell|action|write|file)\b/i.test(text) ||
    /allow\s+(?:bash|shell|tool|command|action)\b/i.test(text) ||
    /\byou can press\b.*\b(?:enter|space|y|n)\b/i.test(text)) {
    return 'opencode'
  }
  if (/\bcodex\b/.test(normalized) ||
    /would you like to run the following command\?/i.test(text) ||
    /allow\s+.+?\s+to\s+(?:run|call|use)\s+tool\s+["“][^"”]+["”]\??/i.test(text) ||
    (/field\s+\d+\/\d+/i.test(text) && /enter to submit\s*\|\s*esc to cancel/i.test(text))) {
    return 'codex'
  }
  if (/\bclaude( code)?\b/.test(normalized) ||
    /\buse\s+skill\s+["'`][^"'`?]+["'`]?\??/i.test(text) ||
    /\bskill\s*\(\s*[^)]+?\s*\)/i.test(text) ||
    /\bbash\s*\(\s*command:/i.test(text)) {
    return 'claude'
  }
  return null
}

function detectSnapshot(text: string, providerHint: AgentPermissionProvider | null): ParsedPermissionPrompt | null {
  const opencodeParsed = parseOpencodePermissionPrompt(text)
  if (opencodeParsed) return opencodeParsed
  if (providerHint === 'opencode') return parseOpencodePermissionPrompt(text) ?? parseCodexPermissionPrompt(text) ?? parseClaudePermissionPrompt(text, false)
  const inferredProvider = inferProviderFromText(text)
  if (inferredProvider === 'codex') return parseCodexPermissionPrompt(text) ?? parseClaudePermissionPrompt(text, false)
  if (inferredProvider === 'claude') return parseClaudePermissionPrompt(text, true) ?? parseCodexPermissionPrompt(text)
  if (inferredProvider === 'opencode') return parseOpencodePermissionPrompt(text) ?? parseCodexPermissionPrompt(text) ?? parseClaudePermissionPrompt(text, false)
  if (providerHint === 'codex') return parseCodexPermissionPrompt(text) ?? parseClaudePermissionPrompt(text, false)
  if (providerHint === 'claude') return parseClaudePermissionPrompt(text, true) ?? parseCodexPermissionPrompt(text)
  return parseCodexPermissionPrompt(text) ?? parseClaudePermissionPrompt(text, false)
}

export function agentPermissionMissSnapshot(text: string, providerHint: AgentPermissionProvider | null): string | null {
  return agentPermissionMissDiagnostic(text, providerHint)?.snapshot ?? null
}

function opencodeMissReason(lines: string[], providerHint: AgentPermissionProvider | null, inferredProvider: AgentPermissionProvider | null): AgentPermissionMissReason | null {
  const hasOpencodeSignal = providerHint === 'opencode' || inferredProvider === 'opencode' || hasOpencodePromptShape(lines) || lines.some(isOpencodePromptStart)
  if (!hasOpencodeSignal) return null

  const hasSubject = lines.some(isOpencodePermissionSubject)
  const hasApprove = lines.some((line) => isOpencodeApproveButton(line) || (isMenuChoiceLine(line) && isOpencodeProceedChoice(line)))
  const hasDeny = lines.some(isOpencodeDenyButton)
  const hasQuestion = lines.some(isOpencodeQuestionPrompt)
  const hasWait = hasOpencodeWaitEvidence(lines)

  if (!hasSubject) return 'no_subject'
  if (!hasApprove) return 'missing_approve_choice'
  if (!hasDeny && !hasQuestion) return 'missing_deny_choice'
  if (!hasWait) return 'missing_wait_hint'
  if (providerHint && inferredProvider && providerHint !== inferredProvider) return 'provider_mis_inference'
  return 'parser_rejected'
}

export function agentPermissionMissDiagnostic(text: string, providerHint: AgentPermissionProvider | null): AgentPermissionMissDiagnostic | null {
  if (detectSnapshot(text, providerHint)) return null

  const lines = normalizedLogicalPromptLines(text)
  const normalized = lines.map(normalizeLine).filter(Boolean)
  const joined = normalized.join('\n')
  const choiceCount = lines.filter(isMenuChoiceLine).length
  const hasOpencodeButtonShape = lines.some(isOpencodeApproveButton) || lines.some(isOpencodeDenyButton) || lines.some(isOpencodePromptStart)
  const hasMenuShape = choiceCount >= 2 || normalized.some((line) => isWaitHintLine(line)) || hasOpencodeButtonShape
  const inferredProvider = inferProviderFromText(text)
  const hasPermissionSignal = Boolean(providerHint) ||
    Boolean(inferredProvider) ||
    /\b(permission|approval|approve|allow|proceed|command|tool|skill|bash|shell|cancel)\b/i.test(joined)

  if (!hasMenuShape || !hasPermissionSignal) return null
  return {
    reason: opencodeMissReason(lines, providerHint, inferredProvider) ?? 'parser_rejected',
    snapshot: joined.slice(-MAX_EXCERPT_CHARS),
    providerHint,
    inferredProvider
  }
}

// Fast keyword gate: ran before `inferProviderFromText`/`detectSnapshot` so that
// the 95%+ of PTY chunks with no permission-related vocabulary skip the expensive
// ANSI-stripping + line-splitting + multi-regex pipeline entirely. A single
// case-insensitive alternation is cheaper than lowercasing + repeated includes.
// False positives here do not change correctness — they just fall through to
// the existing detection pipeline; false negatives cannot happen for a real
// permission prompt because every parser's vocabulary overlaps this set.
const PERMISSION_KEYWORD_FAST_RE =
  /\b(?:allow|deny|approve|approval|permission|proceed|confirm|tool use|would you like)\b/i

function hasPermissionKeywordFast(text: string): boolean {
  return PERMISSION_KEYWORD_FAST_RE.test(text)
}

export class AgentPermissionPromptDetector {
  private lastFingerprint: string | null = null

  append(data: string, context: DetectionContext): AgentPermissionPrompt | null {
    if (!context.agentSession) {
      if (!hasPermissionKeywordFast(data)) {
        this.lastFingerprint = null
        return null
      }
      if (!inferProviderFromText(data)) {
        this.lastFingerprint = null
        return null
      }
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
  parseOpencodePermissionPrompt,
  normalizeTerminalText,
  logicalPromptLines,
  agentPermissionMissSnapshot,
  agentPermissionMissDiagnostic
}
