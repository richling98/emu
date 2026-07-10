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

const codexPromptWithoutFooter = [
  'Would you like to run the following command?',
  '',
  'Reason: Do you want to allow DNS lookups to confirm the current authoritative nameservers for starboard.place?',
  '',
  '$ dig +short NS starboard.place',
  '',
  '› 1. Yes, proceed (y)',
  '  2. Yes, and do not ask again for commands that start with `dig +short NS starboard.place` (p)',
  '  3. No, and tell Codex what to do differently (esc)'
].join('\n')

const parsedCodexPromptWithoutFooter = __agentPermissionPromptTest.parseCodexPermissionPrompt(codexPromptWithoutFooter)
assert(parsedCodexPromptWithoutFooter, 'Codex command prompt should parse when selected choices are visible even if footer is off-screen')
assert.equal(parsedCodexPromptWithoutFooter.summary, 'Run: dig +short NS starboard.place')
assert.equal(parsedCodexPromptWithoutFooter.fingerprint, 'codex:command:dig +short ns starboard.place')
assert.deepEqual(parsedCodexPromptWithoutFooter.approveAction, [{ data: 'y' }])
assert.deepEqual(parsedCodexPromptWithoutFooter.denyAction, [{ data: '\x1b' }])

const codexServerPromptWithoutFooter = [
  'Would you like to run the following command?',
  '',
  'Reason: Do you want to allow starting the local',
  'dashboard server on port 3000 for smoke testing?',
  '',
  '$ node website/server.js',
  '',
  '› 1. Yes, proceed (y)',
  "  2. Yes, and don't ask again for commands that",
  '     start with `node website/server.js` (p)',
  '  3. No, and tell Codex what to do differently',
  '     (esc)'
].join('\n')

const parsedCodexServerPromptWithoutFooter = __agentPermissionPromptTest.parseCodexPermissionPrompt(codexServerPromptWithoutFooter)
assert(parsedCodexServerPromptWithoutFooter, 'Screenshot Codex command prompt should parse without footer')
assert.equal(parsedCodexServerPromptWithoutFooter.summary, 'Run: node website/server.js')
assert.equal(parsedCodexServerPromptWithoutFooter.detail, 'Do you want to allow starting the local dashboard server on port 3000 for smoke testing?')
assert.equal(parsedCodexServerPromptWithoutFooter.fingerprint, 'codex:command:node website/server.js')
assert.deepEqual(parsedCodexServerPromptWithoutFooter.approveAction, [{ data: 'y' }])
assert.deepEqual(parsedCodexServerPromptWithoutFooter.denyAction, [{ data: '\x1b' }])

const codexWrappedApprovePrompt = [
  'Would you like to run the following command?',
  '',
  'Reason: Allow a local smoke-test server.',
  '',
  '$ node website/server.js',
  '',
  '› 1. Yes, proceed',
  '     (y)',
  "  2. Yes, and don't ask again for commands that start with `node website/server.js` (p)",
  '  3. No, and tell Codex what to do differently (esc)'
].join('\n')

const parsedCodexWrappedApprove = __agentPermissionPromptTest.parseCodexPermissionPrompt(codexWrappedApprovePrompt)
assert(parsedCodexWrappedApprove, 'Codex command prompt should parse when approve hotkey wraps')
assert.equal(parsedCodexWrappedApprove.summary, 'Run: node website/server.js')
assert.deepEqual(parsedCodexWrappedApprove.approveAction, [{ data: 'y' }])

const codexOutlookReadPrompt = [
  'Would you like to run the following command?',
  '',
  'Reason: Do you want to allow Outlook read access so I can verify the company hyperlinks saved in the draft?',
  '',
  '$ outlook-cli message read',
  "'AAMkADFmNDUxYzIwLWIzZmUtNDIxYy05YWU4LWI0NzZmNGI0ZTk1MABGAAAAAAD3LR020B42R4Khx_Zme6WFBwCoAzqXBVVTQpFYvpsF8zNfAAAAAAEPAABC9n-na00PRaI6STA86h7HAABiSKgaAAA=' --no-markdown --json > /tmp/joint_csp_draft_readback.json && python3 -",
  "<<'PY'",
  'import json',
  "body=json.load(open('/tmp/joint_csp_draft_readback.json'))['data']['body']",
  'content=body[\'content\']',
  "print('contentType:', body['contentType'])",
  "print('anchor_count:', content.count('<a href='))",
  'PY',
  '',
  '› 1. Yes, proceed (y)',
  '  2. No, and tell Codex what to do differently (esc)',
  '',
  'Press enter to confirm or esc to cancel'
].join('\n')

const parsedCodexOutlookRead = __agentPermissionPromptTest.parseCodexPermissionPrompt(codexOutlookReadPrompt)
assert(parsedCodexOutlookRead, 'Multiline Codex command prompt should parse')
assert.equal(parsedCodexOutlookRead.summary, 'Run: outlook-cli message read')
assert(parsedCodexOutlookRead.fingerprint.includes('outlook-cli message read'))
assert(parsedCodexOutlookRead.fingerprint.includes('aamkadfmnduxyziwlwizzmutndixyy05ywu4lwi0nzzmngi0ztk1mabgaaaaaad3lr020b42r4khx_zme6wfbwcoazqxbvvtqpfyvpsf8znfaaaaaaepaabc9n-na00prai6sta86h7haabiskgaaaa='))

const secondCodexOutlookReadPrompt = codexOutlookReadPrompt
  .replace('AAMkADFmNDUxYzIwLWIzZmUtNDIxYy05YWU4LWI0NzZmNGI0ZTk1MABGAAAAAAD3LR020B42R4Khx_Zme6WFBwCoAzqXBVVTQpFYvpsF8zNfAAAAAAEPAABC9n-na00PRaI6STA86h7HAABiSKgaAAA=', 'AAMkSECONDMESSAGEIDNDIxYy05YWU4LWI0NzZmNGI0ZTk1MABGAAAAAAD3LR020B42R4Khx_Zme6WFBwCoAzqXBVVTQpFYvpsF8zNfAAAAAAEPAABC9n-na00PRaI6STA86h7HAABiSKgaAAA=')

const parsedSecondCodexOutlookRead = __agentPermissionPromptTest.parseCodexPermissionPrompt(secondCodexOutlookReadPrompt)
assert(parsedSecondCodexOutlookRead, 'Second multiline Codex command prompt should parse')
assert.notEqual(
  parsedCodexOutlookRead.fingerprint,
  parsedSecondCodexOutlookRead.fingerprint,
  'Multiline Codex prompts with the same first line but different continuation lines should have different fingerprints'
)

const codexToolPrompt = [
  'Field 1/1',
  'Allow Microsoft Outlook Email to run tool "microsoft outlook email_draft_email"?',
  '',
  'subject: Joint CSP Startup Summary',
  'text_content: <div style="font-family: Arial, Helvetica, sans-serif; co...',
  'to: [{"email": "rling@nvidia.com", "name": "Richard Ling"}]',
  '',
  '› 1. Allow                  Run the tool and continue.',
  '  2. Allow for this session  Run the tool and remember this choice for this session.',
  '  3. Always allow            Run the tool and remember this choice for future tool calls.',
  '  4. Cancel                  Cancel this tool call',
  'enter to submit | esc to cancel'
].join('\n')

const parsedCodexTool = __agentPermissionPromptTest.parseCodexPermissionPrompt(codexToolPrompt)
assert(parsedCodexTool, 'Codex app connector tool prompt should parse')
assert.equal(parsedCodexTool.provider, 'codex')
assert.equal(parsedCodexTool.summary, 'Run tool: Microsoft Outlook Email / microsoft outlook email_draft_email')
assert(parsedCodexTool.detail.includes('subject: Joint CSP Startup Summary'))
assert(parsedCodexTool.detail.includes('to: [{"email": "rling@nvidia.com", "name": "Richard Ling"}]'))
assert.deepEqual(parsedCodexTool.approveAction, [{ data: '\r' }])
assert.deepEqual(parsedCodexTool.denyAction, [{ data: '\x1b' }])

const codexToolWithoutSession = new AgentPermissionPromptDetector().append(codexToolPrompt, {
  sessionId: 'session-codex-tool-no-agent',
  provider: null,
  agentSession: false
})
assert(codexToolWithoutSession, 'Codex tool prompt should infer provider even before agent session is marked')
assert.equal(codexToolWithoutSession.provider, 'codex')

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

const claudeWrappedDescriptionPrompt = [
  'Claude needs permission to use Bash',
  'Bash(command: "node website/server.js")',
  'Description: Start the local dashboard server',
  'for smoke testing on port 3000.',
  '',
  'Do you want to allow this command?',
  '› 1. Yes (y)',
  '  2. No (esc)'
].join('\n')

const parsedClaudeWrappedDescription = __agentPermissionPromptTest.parseClaudePermissionPrompt(claudeWrappedDescriptionPrompt)
assert(parsedClaudeWrappedDescription, 'Claude command prompt should parse with wrapped description')
assert.equal(parsedClaudeWrappedDescription.summary, 'Run: node website/server.js')
assert.equal(parsedClaudeWrappedDescription.detail, 'Start the local dashboard server for smoke testing on port 3000.')

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
assert.deepEqual(parsedClaudeSkill.denyAction, [{ data: '\x1b' }])

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
assert.deepEqual(parsedExactClaudeSkill.denyAction, [{ data: '\x1b' }])

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

const genericProceedFalsePositive = [
  'Do you want to proceed?',
  'This is ordinary prose, not a terminal approval menu.'
].join('\n')
assert.equal(new AgentPermissionPromptDetector().append(genericProceedFalsePositive, context), null)

const documentedPromptFalsePositive = [
  'Documentation example:',
  'Would you like to run the following command?',
  '$ npm run dev',
  'No active choices are visible in this paragraph.'
].join('\n')
assert.equal(new AgentPermissionPromptDetector().append(documentedPromptFalsePositive, context), null)

const assistantExplanationFalsePositive = [
  '› okay so now tell me in layman\'s terms how the permission popup should behave now',
  '',
  'Now the permission popup should show only when Emu thinks Codex or Claude is actually waiting for an approve/deny answer.',
  '',
  '- If Codex asks "Would you like to run this command?", the popup should appear.',
  '- If the text is just normal output talking about permissions, approval, commands, or tools, it should not show a popup.',
  '',
  'So this should work now:',
  '1. Yes, proceed',
  '   (y)',
  '3. No, and tell Codex what to do differently',
  '   (esc)'
].join('\n')
assert.equal(
  new AgentPermissionPromptDetector().append(assistantExplanationFalsePositive, {
    sessionId: 'session-assistant-explanation',
    provider: 'claude',
    agentSession: true
  }),
  null,
  'assistant explanations about permission popups should not emit approvals'
)

const permissionShapedMiss = [
  'Would you like to run the following command?',
  '$ npm run dev',
  '› 1. Maybe later',
  '  2. Ask again'
].join('\n')
const missSnapshot = __agentPermissionPromptTest.agentPermissionMissSnapshot(permissionShapedMiss, 'codex')
assert(missSnapshot, 'permission-shaped nonmatches should produce a debug miss snapshot')
assert(missSnapshot.includes('Would you like to run the following command?'))

const explanatoryMenuSnippetFalsePositive = [
  'A human can tell this is obviously a permission prompt:',
  'Would you like to run the following command?',
  '$ dig +short NS starboard.place',
  '› 1. Yes, proceed (y)',
  "  2. Yes, and don't ask again...",
  '  3. No ... (esc)'
].join('\n')
assert.equal(new AgentPermissionPromptDetector().append(explanatoryMenuSnippetFalsePositive, context), null)
assert.equal(
  new AgentPermissionPromptDetector().append(explanatoryMenuSnippetFalsePositive, {
    sessionId: 'session-opencode-false-positive',
    provider: 'opencode',
    agentSession: true
  }),
  null,
  'opencode fallback should not emit for explanatory menu snippets'
)

const opencodeProseFalsePositive = [
  'opencode can ask you to approve a command before it writes a file.',
  'This paragraph is documentation, not an active approval prompt.',
  'You can press y or n when a real prompt appears.'
].join('\n')
assert.equal(
  new AgentPermissionPromptDetector().append(opencodeProseFalsePositive, {
    sessionId: 'session-opencode-prose',
    provider: 'opencode',
    agentSession: true
  }),
  null,
  'opencode prose about approvals should not emit'
)

const opencodeButtonPrompt = [
  'Shell',
  '$ npm run dev',
  '',
  'Deny',
  'Allow Always',
  'Allow Once',
  '',
  'enter confirm   esc dismiss'
].join('\n')
const parsedOpencodeButtonPrompt = new AgentPermissionPromptDetector().append(opencodeButtonPrompt, {
  sessionId: 'session-opencode-buttons',
  provider: 'opencode',
  agentSession: true
})
assert(parsedOpencodeButtonPrompt, 'opencode button prompt should parse')
assert.equal(parsedOpencodeButtonPrompt.provider, 'opencode')
assert.equal(parsedOpencodeButtonPrompt.summary, 'Run: npm run dev')
assert.equal(parsedOpencodeButtonPrompt.fingerprint, 'opencode:approval:shell $ npm run dev')
assert.deepEqual(parsedOpencodeButtonPrompt.approveAction, [{ data: '\r' }])
assert.deepEqual(parsedOpencodeButtonPrompt.denyAction, [{ data: '\x1b' }])

const opencodeButtonPromptNoWaitHint = [
  'Shell',
  '$ npm run dev',
  '',
  'Deny',
  'Allow Always',
  'Allow Once'
].join('\n')
assert.equal(
  new AgentPermissionPromptDetector().append(opencodeButtonPromptNoWaitHint, {
    sessionId: 'session-opencode-buttons-no-wait',
    provider: 'opencode',
    agentSession: true
  }),
  null,
  'opencode button snippets without a permission heading or wait evidence should not parse'
)
const opencodeNoWaitDiagnostic = __agentPermissionPromptTest.agentPermissionMissDiagnostic(opencodeButtonPromptNoWaitHint, 'opencode')
assert(opencodeNoWaitDiagnostic, 'opencode button misses should include diagnostics')
assert.equal(opencodeNoWaitDiagnostic.reason, 'missing_wait_hint')

const opencodePermissionRequiredNoFooterPrompt = [
  '△ Permission required',
  '# Update local files',
  '',
  '$ apply_patch <<\'PATCH\'',
  '',
  'Deny',
  'Allow Always',
  'Allow Once'
].join('\n')
const parsedOpencodePermissionRequiredNoFooter = new AgentPermissionPromptDetector().append(opencodePermissionRequiredNoFooterPrompt, {
  sessionId: 'session-opencode-permission-no-footer',
  provider: 'opencode',
  agentSession: true
})
assert(parsedOpencodePermissionRequiredNoFooter, 'explicit opencode permission modal should parse even when footer is off-screen')
assert.equal(parsedOpencodePermissionRequiredNoFooter.provider, 'opencode')
assert.equal(parsedOpencodePermissionRequiredNoFooter.summary, 'Run: apply_patch <<\'PATCH\'')

const opencodeQuestionPrompt = [
  'Can I use file reads/searches and non-destructive Git commands to find the repo, inspect the project, and update the README accurately?',
  '',
  '1. Proceed',
  '   Use reads/searches and safe git commands for README work.',
  '2. Ask each step',
  '   Ask before each individual read/search/command.',
  '3. Type your own answer',
  '',
  '↑↓ select   enter submit   esc dismiss'
].join('\n')
const parsedOpencodeQuestionPrompt = new AgentPermissionPromptDetector().append(opencodeQuestionPrompt, {
  sessionId: 'session-opencode-question',
  provider: 'opencode',
  agentSession: true
})
assert(parsedOpencodeQuestionPrompt, 'opencode question prompt should parse')
assert.equal(parsedOpencodeQuestionPrompt.provider, 'opencode')
assert.equal(
  parsedOpencodeQuestionPrompt.summary,
  'Can I use file reads/searches and non-destructive Git commands to find the repo, inspect the project, and update the README accurately?'
)
assert.deepEqual(parsedOpencodeQuestionPrompt.approveAction, [{ data: '\r' }])
assert.deepEqual(parsedOpencodeQuestionPrompt.denyAction, [{ data: '\x1b' }])
assert(parsedOpencodeQuestionPrompt.fingerprint.startsWith('opencode:approval:can i use file reads/searches'))

const opencodePermissionRequiredPrompt = [
  '△ Permission required',
  '# Check if browse binary exists',
  '',
  '$ if test -x ~/.claude/skills/gstack/browse/dist/browse; then echo "READY_USER"; else echo "NEEDS_SETUP"; fi',
  '',
  'Allow once   Allow always   Reject',
  'ctrl+f fullscreen  ↵ select  enter confirm'
].join('\n')
const parsedOpencodePermissionRequiredPrompt = new AgentPermissionPromptDetector().append(opencodePermissionRequiredPrompt, {
  sessionId: 'session-opencode-permission-required',
  provider: 'opencode',
  agentSession: true
})
assert(parsedOpencodePermissionRequiredPrompt, 'opencode permission-required prompt should parse')
assert.equal(parsedOpencodePermissionRequiredPrompt.provider, 'opencode')
assert.equal(
  parsedOpencodePermissionRequiredPrompt.summary,
  'Run: if test -x ~/.claude/skills/gstack/browse/dist/browse; then echo "READY_USER"; else echo "NEEDS_SETUP"; fi'
)
assert.deepEqual(parsedOpencodePermissionRequiredPrompt.approveAction, [{ data: '\r' }])
assert.deepEqual(parsedOpencodePermissionRequiredPrompt.denyAction, [{ data: '\x1b' }])

const opencodeHeadingOnlyRepaint = [
  '△ Permission required',
  '',
  'Allow once   Allow always   Reject',
  'ctrl+f fullscreen  ↵ select  enter confirm'
].join('\n')
const parsedOpencodeHeadingOnlyRepaint = new AgentPermissionPromptDetector().append(opencodeHeadingOnlyRepaint, {
  sessionId: 'session-opencode-heading-only',
  provider: 'opencode',
  agentSession: true
})
assert(parsedOpencodeHeadingOnlyRepaint, 'opencode heading/buttons repaint should still surface a popup')
assert.equal(parsedOpencodeHeadingOnlyRepaint.summary, 'Approval needed')
assert.equal(parsedOpencodeHeadingOnlyRepaint.fingerprint, 'opencode:approval:permission required')

const opencodeHeadingWithLeftoverScriptTextFalsePositive = [
  '△ Permission required',
  'EOF cp /tmp/test_state_pause.json data/dqmv_state.json && ./run-dev.sh',
  '',
  'Allow once   Allow always   Reject',
  'ctrl+f fullscreen  ↵ select  enter confirm'
].join('\n')
assert.equal(
  new AgentPermissionPromptDetector().append(opencodeHeadingWithLeftoverScriptTextFalsePositive, {
    sessionId: 'session-opencode-leftover-script-text',
    provider: 'opencode',
    agentSession: true
  }),
  null,
  'generic opencode heading/buttons repaint should not emit when leftover script text is mistaken for prompt detail'
)

const opencodeHeadingWithReadTraceFalsePositive = [
  '△ Permission required',
  '⠂ Read /var/folders/94/mh4002897111zbkw3q_qsd7w0000gn/T/TemporaryItems/screenshot.png',
  '',
  'Allow once   Allow always   Reject',
  'ctrl+f fullscreen  ↵ select  enter confirm'
].join('\n')
assert.equal(
  new AgentPermissionPromptDetector().append(opencodeHeadingWithReadTraceFalsePositive, {
    sessionId: 'session-opencode-read-trace',
    provider: 'opencode',
    agentSession: true
  }),
  null,
  'opencode activity trace lines above stale controls should not emit generic approval popups'
)

const opencodeExternalDirectoryPermissionWithReadTrace = [
  '⠂ Read /var/folders/94/mh4002897111zbkw3q_qsd7w0000gn/T/TemporaryItems/NSIRD_screencaptureui_xmWxNq/Screenshot.png',
  '△ Permission required',
  '← Access external directory /var/folders/94/mh4002897111zbkw3q_qsd7w0000gn/T/TemporaryItems/',
  'NSIRD_screencaptureui_xmWxNq',
  '',
  'Patterns',
  '- /var/folders/94/mh4002897111zbkw3q_qsd7w0000gn/T/TemporaryItems/NSIRD_screencaptureui_xmWxNq/*',
  '',
  'Allow once   Allow always   Reject',
  'ctrl+f fullscreen  ↵ select  enter confirm'
].join('\n')
const parsedOpencodeExternalDirectoryPermissionWithReadTrace = new AgentPermissionPromptDetector().append(opencodeExternalDirectoryPermissionWithReadTrace, {
  sessionId: 'session-opencode-access-external-directory',
  provider: 'opencode',
  agentSession: true
})
assert(parsedOpencodeExternalDirectoryPermissionWithReadTrace, 'opencode external-directory permission should parse even with nearby read trace')
assert.equal(
  parsedOpencodeExternalDirectoryPermissionWithReadTrace.summary,
  'Access external directory /var/folders/94/mh4002897111zbkw3q_qsd7w0000gn/T/TemporaryItems/NSIRD_screencaptureui_xmWxNq'
)
assert.equal(
  parsedOpencodeExternalDirectoryPermissionWithReadTrace.fingerprint,
  'opencode:approval:access external directory /var/folders/94/mh4002897111zbkw3q_qsd7w0000gn/t/temporaryitems/nsird_screencaptureui_xmwxnq'
)
assert(!parsedOpencodeExternalDirectoryPermissionWithReadTrace.detail.includes('Read /var/folders'), 'read trace should not become permission detail')

// The user-reported ~/Library/Application\ Support escaped-space case (July 2026)
const opencodeExternalDirectoryTildeWithEscapedSpace = [
  '△ Permission required',
  '  ← Access external directory ~/Library/Application\\ Support',
  '',
  'Patterns',
  '- /Users/richardling/Library/Application\\ Support/*',
  '- /Users/richardling/Library/Caches/com.adamant.ai/*',
  '- /Users/richardling/Library/Caches/*',
  '- /Users/richardling/Library/Preferences/*',
  '- /Applications/Adamant.app/*',
  '',
  'Allow once      Allow always     Reject      ctrl+f fullscreen   ⇆ select   enter confirm'
].join('\n')
const parsedTildeEscaped = new AgentPermissionPromptDetector().append(opencodeExternalDirectoryTildeWithEscapedSpace, {
  sessionId: 'session-opencode-tilde-escaped',
  provider: 'opencode',
  agentSession: true
})
assert(parsedTildeEscaped, 'opencode external-dir with tilde and escaped space should parse')
assert(parsedTildeEscaped.summary.toLowerCase().includes('application'), 'escaped-space summary should include Application')
assert(parsedTildeEscaped.fingerprint.startsWith('opencode:approval:access external directory ~/library/application'))

// Xterm wrapping — "Access external directory" label on its own row, path next row,
// and long bullet globs wrapped — must still parse
const opencodeExternalDirectoryXtermWrapped = [
  '△ Permission required',
  '  ← Access external directory',
  '~/Library/Application\\ Support',
  '',
  'Patterns',
  '- /Users/richardling/Library/Application\\',
  'Support/*',
  '- /Users/richardling/Library/Caches/*',
  '',
  'Allow once   Allow always',
  'Reject',
  'ctrl+f fullscreen  ↵ select  enter confirm'
].join('\n')
const parsedWrapped = new AgentPermissionPromptDetector().append(opencodeExternalDirectoryXtermWrapped, {
  sessionId: 'session-opencode-xterm-wrapped',
  provider: 'opencode',
  agentSession: true
})
assert(parsedWrapped, 'xterm-wrapped external directory permission should parse')
assert(parsedWrapped.summary.includes('Application'), 'wrapped summary should contain Application')

const opencodeDescriptionOnlyRepaint = [
  '△ Permission required',
  '# Check if browse binary exists',
  '',
  'Allow once   Allow always   Reject',
  'ctrl+f fullscreen  ↵ select  enter confirm'
].join('\n')
const parsedOpencodeDescriptionOnlyRepaint = new AgentPermissionPromptDetector().append(opencodeDescriptionOnlyRepaint, {
  sessionId: 'session-opencode-description-only',
  provider: 'opencode',
  agentSession: true
})
assert(parsedOpencodeDescriptionOnlyRepaint, 'opencode description/buttons repaint should parse even when command body is off-screen')
assert.equal(parsedOpencodeDescriptionOnlyRepaint.summary, '# Check if browse binary exists')
assert.equal(parsedOpencodeDescriptionOnlyRepaint.fingerprint, 'opencode:approval:# check if browse binary exists')

const chainedOpencodeDetector = new AgentPermissionPromptDetector()
const firstChainedOpencode = chainedOpencodeDetector.append(opencodePermissionRequiredPrompt, {
  sessionId: 'session-opencode-chained',
  provider: 'opencode',
  agentSession: true
})
const secondChainedOpencodePrompt = opencodePermissionRequiredPrompt
  .replace('# Check if browse binary exists', '# List browse skill directory')
  .replace('if test -x ~/.claude/skills/gstack/browse/dist/browse; then echo "READY_USER"; else echo "NEEDS_SETUP"; fi', 'ls ~/.claude/skills/gstack/browse')
const secondChainedOpencode = chainedOpencodeDetector.append(secondChainedOpencodePrompt, {
  sessionId: 'session-opencode-chained',
  provider: 'opencode',
  agentSession: true
})
assert(firstChainedOpencode, 'first chained opencode prompt should emit')
assert(secondChainedOpencode, 'second chained opencode prompt with a new subject should emit')
assert.notEqual(firstChainedOpencode.fingerprint, secondChainedOpencode.fingerprint)

const parsedOpencodePermissionRequiredPromptAgain = new AgentPermissionPromptDetector().append(opencodePermissionRequiredPrompt, {
  sessionId: 'session-opencode-permission-required-stability',
  provider: 'opencode',
  agentSession: true
})
assert.equal(
  parsedOpencodePermissionRequiredPromptAgain?.fingerprint,
  parsedOpencodePermissionRequiredPrompt.fingerprint,
  'opencode permission-required fingerprint should be stable'
)

const parsedOpencodePermissionRequiredWithoutProvider = new AgentPermissionPromptDetector().append(opencodePermissionRequiredPrompt, {
  sessionId: 'session-opencode-permission-required-no-provider',
  provider: null,
  agentSession: true
})
assert(parsedOpencodePermissionRequiredWithoutProvider, 'opencode permission-required prompt should parse without provider hint')
assert.equal(parsedOpencodePermissionRequiredWithoutProvider.provider, 'opencode')

const parsedOpencodePermissionRequiredWithClaudeHint = new AgentPermissionPromptDetector().append(opencodePermissionRequiredPrompt, {
  sessionId: 'session-opencode-permission-required-claude-hint',
  provider: 'claude',
  agentSession: true
})
assert(parsedOpencodePermissionRequiredWithClaudeHint, 'opencode prompt with .claude command body should beat stale Claude hint')
assert.equal(parsedOpencodePermissionRequiredWithClaudeHint.provider, 'opencode')

const opencodePermissionRequiredMultilineCommandPrompt = [
  '△ Permission required',
  '# Navigate to TechCrunch startups page',
  '',
  '$ B=~/.claude/skills/gstack/browse/dist/browse',
  '$B goto https://techcrunch.com/category/startups/',
  '',
  'Allow once   Allow always   Reject',
  'ctrl+f fullscreen  ↵ select  enter confirm'
].join('\n')
const parsedOpencodePermissionRequiredMultilineCommandPrompt = new AgentPermissionPromptDetector().append(opencodePermissionRequiredMultilineCommandPrompt, {
  sessionId: 'session-opencode-permission-required-multiline',
  provider: 'opencode',
  agentSession: true
})
assert(parsedOpencodePermissionRequiredMultilineCommandPrompt, 'opencode permission-required multiline command prompt should parse')
assert.equal(parsedOpencodePermissionRequiredMultilineCommandPrompt.summary, 'Run: B=~/.claude/skills/gstack/browse/dist/browse')

const opencodeWrappedButtonPrompt = [
  '△ Permission required',
  '# Check if browse binary exists',
  '',
  '$ if test -x ~/.claude/skills/gstack/browse/dist/browse; then echo "READY_USER"; else echo "NEEDS_SETUP"; fi',
  '',
  'Allow once',
  'Allow always',
  'Reject',
  'ctrl+f fullscreen  ↵ select  enter confirm'
].join('\n')
const parsedOpencodeWrappedButtonPrompt = new AgentPermissionPromptDetector().append(opencodeWrappedButtonPrompt, {
  sessionId: 'session-opencode-wrapped-buttons',
  provider: null,
  agentSession: true
})
assert(parsedOpencodeWrappedButtonPrompt, 'opencode permission-required prompt with split button rows should parse')
assert.equal(parsedOpencodeWrappedButtonPrompt.provider, 'opencode')
assert.deepEqual(parsedOpencodeWrappedButtonPrompt.approveAction, [{ data: '\r' }])
assert.deepEqual(parsedOpencodeWrappedButtonPrompt.denyAction, [{ data: '\x1b' }])

const opencodePermissionRequiredProseFalsePositive = [
  'The documentation says Permission required appears before command execution.',
  'Users may see Allow once, Allow always, and Reject buttons.',
  'This is explanatory prose and has no active wait footer.'
].join('\n')
assert.equal(
  new AgentPermissionPromptDetector().append(opencodePermissionRequiredProseFalsePositive, {
    sessionId: 'session-opencode-permission-prose',
    provider: 'opencode',
    agentSession: true
  }),
  null,
  'opencode prose mentioning real buttons should not emit without wait evidence'
)

const opencodeBrowseSkillStalePermissionFalsePositive = [
  '△ Permission required',
  '# Check if browse binary exists',
  '',
  '$ if test -x ~/.claude/skills/gstack/browse/dist/browse; then echo "READY_USER"; else echo "NEEDS_SETUP"; fi',
  '',
  'Allow once   Allow always   Reject',
  'ctrl+f fullscreen  ↵ select  enter confirm',
  '+ Thought: 255ms -> Skill "browse"',
  '+ Thought: 182ms $ if test -x ~/.claude/skills/gstack/browse/dist/browse...',
  'READY_USER'
].join('\n')
assert.equal(
  new AgentPermissionPromptDetector().append(opencodeBrowseSkillStalePermissionFalsePositive, {
    sessionId: 'session-opencode-browse-stale-permission',
    provider: 'opencode',
    agentSession: true
  }),
  null,
  'resolved opencode browse permission followed by transcript output should not emit again'
)

const opencodeHeadingOnlyRepaintStaleFalsePositive = [
  '△ Permission required',
  '',
  'Allow once   Allow always   Reject',
  'ctrl+f fullscreen  ↵ select  enter confirm',
  '+ Thought: continuing with browse task',
  'Open   Collapse   Close'
].join('\n')
assert.equal(
  new AgentPermissionPromptDetector().append(opencodeHeadingOnlyRepaintStaleFalsePositive, {
    sessionId: 'session-opencode-heading-stale',
    provider: 'opencode',
    agentSession: true
  }),
  null,
  'opencode heading-only permission repaint should not emit after normal output follows'
)

const codexQuotedApprovalTranscriptFalsePositive = [
  'Documentation example:',
  'Would you like to run the following command?',
  '$ npm run dev',
  '› 1. Yes, proceed (y)',
  '  2. No, and tell Codex what to do differently (esc)',
  'Press enter to confirm or esc to cancel',
  '',
  'The build then continued and printed normal output.',
  'Compiled successfully.'
].join('\n')
assert.equal(
  new AgentPermissionPromptDetector().append(codexQuotedApprovalTranscriptFalsePositive, {
    sessionId: 'session-codex-quoted-transcript',
    provider: 'codex',
    agentSession: true
  }),
  null,
  'Codex approval prompt quoted in transcript followed by output should not emit'
)

const claudeBashPermissionTranscriptFalsePositive = [
  'Claude needs permission to use Bash',
  'Bash(command: "npm test")',
  'Do you want to allow this command?',
  '› 1. Yes (y)',
  '  2. No (esc)',
  '',
  'I will continue after approval. Here is the next step...'
].join('\n')
assert.equal(
  new AgentPermissionPromptDetector().append(claudeBashPermissionTranscriptFalsePositive, {
    sessionId: 'session-claude-bash-transcript',
    provider: 'claude',
    agentSession: true
  }),
  null,
  'Claude permission block followed by assistant narration should not emit'
)

const claudeSkillPromptDocumentationFalsePositive = [
  'For example, Claude may show:',
  'Use skill "browse"?',
  'Do you want to proceed?',
  '1. Yes',
  '2. No',
  '',
  'This paragraph is documentation, not an active terminal UI.'
].join('\n')
assert.equal(
  new AgentPermissionPromptDetector().append(claudeSkillPromptDocumentationFalsePositive, {
    sessionId: 'session-claude-skill-docs',
    provider: 'claude',
    agentSession: true
  }),
  null,
  'Claude skill prompt documentation should not emit as active approval'
)

const opencodeWebFetchTraceBeforeControlsFalsePositive = [
  '△ Permission required',
  '+ Thought: 508ms % WebFetch https://duckduckgo.com/?q=airaw+2025',
  'Allow once   Allow always   Reject',
  'ctrl+f fullscreen  ↵ select  enter confirm'
].join('\n')
assert.equal(
  new AgentPermissionPromptDetector().append(opencodeWebFetchTraceBeforeControlsFalsePositive, {
    sessionId: 'session-opencode-webfetch-before-controls',
    provider: 'opencode',
    agentSession: true
  }),
  null,
  'opencode WebFetch activity trace before stale controls should not emit approval'
)

const opencodeGenericWebFetchApprovalNeededFalsePositive = [
  '+ Thought: 319ms % WebFetch https://www.airaw.io/some-page',
  'Deny',
  'Approve'
].join('\n')
assert.equal(
  new AgentPermissionPromptDetector().append(opencodeGenericWebFetchApprovalNeededFalsePositive, {
    sessionId: 'session-opencode-generic-webfetch-approval-needed',
    provider: 'opencode',
    agentSession: true
  }),
  null,
  'generic Approval needed should not emit from WebFetch activity trace plus controls'
)

const codexBrowsePromptThenWebFetchTraceFalsePositive = [
  'Would you like to run the following command?',
  '$ browse https://example.com',
  '› 1. Yes, proceed (y)',
  '  2. No, and tell Codex what to do differently (esc)',
  'Press enter to confirm or esc to cancel',
  '+ Thought: 300ms % WebFetch https://example.com'
].join('\n')
assert.equal(
  new AgentPermissionPromptDetector().append(codexBrowsePromptThenWebFetchTraceFalsePositive, {
    sessionId: 'session-codex-browse-prompt-then-webfetch',
    provider: 'codex',
    agentSession: true
  }),
  null,
  'resolved Codex browse prompt followed by WebFetch trace should not emit'
)

console.log('agent permission detector fixtures passed')
