import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const outfile = '/tmp/emu-agent-permission-prompts.mjs'

await build({
  entryPoints: ['src/shared/agentPermissionPrompts.ts'],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  logLevel: 'silent'
})

const { AgentPermissionPromptDetector, __agentPermissionPromptTest } = await import(pathToFileURL(outfile).href)

const codexPrompt = [
  'Would you like to run the following command?',
  '',
  'Reason: Allow the Electron/Vite dev server to bind to localhost so you can test the app.',
  '',
  '$ npm run dev',
  '',
  '› 1. Yes, proceed (y)',
  "  2. Yes, and don't ask again for commands that start with `npm run dev` (p)",
  '  3. No, and tell Codex what to do differently (esc)',
  '',
  'Press enter to confirm or esc to cancel'
].join('\n')

const parsed = __agentPermissionPromptTest.parseCodexPermissionPrompt(codexPrompt)
assert(parsed, 'Codex prompt should parse')
assert.equal(parsed.summary, 'Run: npm run dev')
assert.equal(parsed.detail, 'Allow the Electron/Vite dev server to bind to localhost so you can test the app.')
assert.equal(parsed.fingerprint, 'codex:command:npm run dev')
assert.deepEqual(parsed.approveAction, [{ data: 'y' }])
assert.deepEqual(parsed.denyAction, [{ data: '\x1b' }])

const claudePrompt = [
  'Bash command',
  '$ npm run dev',
  '',
  'Do you want to proceed?',
  '❯ 1. Yes',
  "  2. Yes, and don't ask again for this command",
  '  3. No'
].join('\n')

const parsedClaude = __agentPermissionPromptTest.parseClaudePermissionPrompt(claudePrompt)
assert(parsedClaude, 'Claude command prompt should parse without requiring the word Claude')
assert.equal(parsedClaude.summary, 'Run: npm run dev')
assert.equal(parsedClaude.fingerprint, 'claude:command:npm run dev')
assert.deepEqual(parsedClaude.approveAction, [{ data: '\r' }])
assert.deepEqual(parsedClaude.denyAction, [{ data: '\x1b[B\x1b[B' }, { data: '\r' }])

const claudeHotkeyPrompt = [
  'Claude needs permission to use Bash',
  'Bash(command: "npm test")',
  '',
  'Do you want to allow this command?',
  '› 1. Yes (y)',
  '  2. No (esc)'
].join('\n')

const parsedClaudeHotkey = __agentPermissionPromptTest.parseClaudePermissionPrompt(claudeHotkeyPrompt)
assert(parsedClaudeHotkey, 'Claude hotkey prompt should parse')
assert.equal(parsedClaudeHotkey.summary, 'Run: npm test')
assert.deepEqual(parsedClaudeHotkey.approveAction, [{ data: 'y' }])
assert.deepEqual(parsedClaudeHotkey.denyAction, [{ data: '\x1b' }])

const claudeSkillPrompt = [
  '● Skill(run)',
  '',
  'Use skill "run"?',
  'Claude may use instructions, code, or files from this Skill.',
  '',
  "Launch and drive this project's app to see a change working.",
  '',
  'Do you want to proceed?',
  '❯ 1. Yes',
  "  2. Yes, and don't ask again for run in /Users/rling/Documents/Vibing/Emu-dev",
  '  3. No',
  '',
  'Esc to cancel · Tab to amend'
].join('\n')

const parsedClaudeSkill = __agentPermissionPromptTest.parseClaudePermissionPrompt(claudeSkillPrompt)
assert(parsedClaudeSkill, 'Claude skill permission prompt should parse')
assert.equal(parsedClaudeSkill.summary, 'Use skill: run')
assert.equal(parsedClaudeSkill.fingerprint, 'claude:skill:run')
assert.deepEqual(parsedClaudeSkill.approveAction, [{ data: '\r' }])
assert.deepEqual(parsedClaudeSkill.denyAction, [{ data: '\x1b[B\x1b[B' }, { data: '\r' }])

const exactClaudeSkillPrompt = [
  '╭── Claude Code v2.1.170 ───────────────────────────────────────────────────────────────────────────╮',
  '│ Welcome back Richard!                                      │ Tips for getting started              │',
  '│ Sonnet 4.6 with medium effort · API Usage Billing           │ /release-notes for more               │',
  '╰────────────────────────────────────────────────────────────────────────────────────────────────────╯',
  '',
  '│ Using Sonnet 4.6 (from managed settings) · /model',
  '',
  '› please run npm run dev',
  '',
  '● Skill(run)',
  '',
  '────────────────────────────────────────────────────────────────────────────────────────────────────',
  '',
  'Use skill "run"?',
  'Claude may use instructions, code, or files from this Skill.',
  '',
  "Launch and drive this project's app to see a change working. Use when asked to run, start, or screenshot the app,",
  'or to confirm a change works in the real app (not just tests). First looks for a project skill that already',
  'covers launching the app; otherwise falls back to built-in patterns per project type (CLI, server, TUI, Electron,',
  'browser-driven, library).',
  '',
  'Do you want to proceed?',
  '› 1. Yes',
  "  2. Yes, and don't ask again for run in /Users/rling/Documents/Vibing/Emu-dev",
  '  3. No',
  '',
  'Esc to cancel · Tab to amend'
].join('\n')

const parsedExactClaudeSkill = __agentPermissionPromptTest.parseClaudePermissionPrompt(exactClaudeSkillPrompt)
assert(parsedExactClaudeSkill, 'Exact Claude skill prompt from screenshot should parse')
assert.equal(parsedExactClaudeSkill.summary, 'Use skill: run')
assert.equal(parsedExactClaudeSkill.fingerprint, 'claude:skill:run')
assert.deepEqual(parsedExactClaudeSkill.approveAction, [{ data: '\r' }])
assert.deepEqual(parsedExactClaudeSkill.denyAction, [{ data: '\x1b[B\x1b[B' }, { data: '\r' }])

const withOldOutput = [
  'I can help with that. Here is a plan with tools and approval language.',
  'The agent previously said allow network later.',
  '',
  codexPrompt
].join('\n')
const parsedWithOldOutput = __agentPermissionPromptTest.parseCodexPermissionPrompt(withOldOutput)
assert(parsedWithOldOutput, 'Codex prompt with old output should parse')
assert.equal(parsedWithOldOutput.summary, 'Run: npm run dev')
assert(!parsedWithOldOutput.rawExcerpt.includes('previously said'), 'raw excerpt should contain only active prompt block')

const detector = new AgentPermissionPromptDetector()
const context = { sessionId: 'session-1', provider: 'codex', agentSession: true }
const first = detector.append(codexPrompt, context)
assert(first, 'first detector scan should emit')
for (let i = 0; i < 10; i++) {
  assert.equal(detector.append(codexPrompt, context), null, 'duplicate scans should not emit')
}
assert.equal(detector.append('Codex received your answer and returned to the prompt.', context), null)
const repeatedAfterDismiss = detector.append(codexPrompt, context)
assert(repeatedAfterDismiss, 'same prompt should emit again after it disappears and reappears')
assert.equal(repeatedAfterDismiss.fingerprint, 'codex:command:npm run dev')

const staleClaudeHintDetector = new AgentPermissionPromptDetector()
const codexWithStaleClaudeHint = staleClaudeHintDetector.append(codexPrompt, {
  sessionId: 'session-stale-claude',
  provider: 'claude',
  agentSession: true
})
assert(codexWithStaleClaudeHint, 'Codex prompt should still emit with a stale Claude provider hint')
assert.equal(codexWithStaleClaudeHint.provider, 'codex')

const claudeDetector = new AgentPermissionPromptDetector()
const claudeContext = { sessionId: 'session-claude', provider: 'claude', agentSession: true }
const firstClaude = claudeDetector.append(claudePrompt, claudeContext)
assert(firstClaude, 'first Claude prompt should emit')
assert.equal(firstClaude.summary, 'Run: npm run dev')
assert.equal(claudeDetector.append(claudePrompt, claudeContext), null, 'duplicate Claude scans should not emit')
const secondClaude = claudeDetector.append([
  'Bash command',
  '$ npm test',
  '',
  'Do you want to proceed?',
  '❯ 1. Yes',
  '  2. No'
].join('\n'), claudeContext)
assert(secondClaude, 'a second different Claude prompt should emit while the first remains pending in main')
assert.equal(secondClaude.summary, 'Run: npm test')

const splitCodexDetector = new AgentPermissionPromptDetector()
let splitCodexTail = ''
const splitCodexChunks = [
  codexPrompt.slice(0, 80),
  codexPrompt.slice(80, 180),
  codexPrompt.slice(180)
]
let splitCodexMatch = null
for (const chunk of splitCodexChunks) {
  splitCodexTail += chunk
  splitCodexMatch = splitCodexDetector.append(splitCodexTail, {
    sessionId: 'session-split-codex',
    provider: 'codex',
    agentSession: true
  }) ?? splitCodexMatch
}
assert(splitCodexMatch, 'Codex prompt split across PTY chunks should emit after accumulated buffer')
assert.equal(splitCodexMatch.summary, 'Run: npm run dev')
assert.equal(splitCodexDetector.append(splitCodexTail, {
  sessionId: 'session-split-codex',
  provider: 'codex',
  agentSession: true
}), null, 'split Codex accumulated buffer should not duplicate the same prompt')

const splitClaudeDetector = new AgentPermissionPromptDetector()
let splitClaudeTail = ''
const splitClaudeChunks = [
  claudePrompt.slice(0, 32),
  claudePrompt.slice(32, 88),
  claudePrompt.slice(88)
]
let splitClaudeMatch = null
for (const chunk of splitClaudeChunks) {
  splitClaudeTail += chunk
  splitClaudeMatch = splitClaudeDetector.append(splitClaudeTail, {
    sessionId: 'session-split-claude',
    provider: 'claude',
    agentSession: true
  }) ?? splitClaudeMatch
}
assert(splitClaudeMatch, 'Claude prompt split across PTY chunks should emit after accumulated buffer')
assert.equal(splitClaudeMatch.summary, 'Run: npm run dev')

const sessionADetector = new AgentPermissionPromptDetector()
const sessionBDetector = new AgentPermissionPromptDetector()
const sessionAPrompt = sessionADetector.append(codexPrompt, {
  sessionId: 'session-A',
  provider: 'codex',
  agentSession: true
})
const sessionBPrompt = sessionBDetector.append(claudePrompt, {
  sessionId: 'session-B',
  provider: 'claude',
  agentSession: true
})
assert(sessionAPrompt, 'first simultaneous session should emit')
assert(sessionBPrompt, 'second simultaneous session should emit')
assert.notEqual(sessionAPrompt.sessionId, sessionBPrompt.sessionId)
assert.notEqual(sessionAPrompt.fingerprint, sessionBPrompt.fingerprint)

const staleCodexHintDetector = new AgentPermissionPromptDetector()
const claudeWithStaleCodexHint = staleCodexHintDetector.append(claudeSkillPrompt, {
  sessionId: 'session-stale-codex',
  provider: 'codex',
  agentSession: true
})
assert(claudeWithStaleCodexHint, 'Claude prompt should still emit with a stale Codex provider hint')
assert.equal(claudeWithStaleCodexHint.provider, 'claude')

const exactClaudeWithStaleCodexHint = new AgentPermissionPromptDetector().append(exactClaudeSkillPrompt, {
  sessionId: 'session-exact-claude',
  provider: 'codex',
  agentSession: true
})
assert(exactClaudeWithStaleCodexHint, 'Exact Claude screenshot prompt should emit with a stale Codex provider hint')
assert.equal(exactClaudeWithStaleCodexHint.summary, 'Use skill: run')

const falsePositive = [
  'The plan may allow a tool later.',
  'We should ask for approval if network access is needed.',
  'No prompt is active here.'
].join('\n')
assert.equal(__agentPermissionPromptTest.parseCodexPermissionPrompt(falsePositive), null)
assert.equal(new AgentPermissionPromptDetector().append(falsePositive, context), null)
assert.equal(__agentPermissionPromptTest.parseClaudePermissionPrompt(falsePositive, false), null)

console.log('agent permission detector fixtures passed')
