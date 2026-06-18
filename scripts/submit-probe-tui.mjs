#!/usr/bin/env node

let input = ''
let pasteMode = false
let pasteEndedAt = 0
let submitCount = 0
let firstEnterBecameNewline = false

function argValue(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  const value = Number(process.argv[index + 1])
  return Number.isFinite(value) ? value : fallback
}

const FIRST_ENTER_NEWLINE = process.argv.includes('--first-enter-newline') ||
  process.env.EMU_SUBMIT_PROBE_FIRST_ENTER_NEWLINE === '1'
const ECHO_DELAY_MS = argValue('--echo-delay-ms', Number(process.env.EMU_SUBMIT_PROBE_ECHO_DELAY_MS ?? 0))
const PASTE_SETTLE_MS = argValue('--paste-settle-ms', Number(process.env.EMU_SUBMIT_PROBE_PASTE_SETTLE_MS ?? 500))

function write(text) {
  process.stdout.write(text)
}

function renderPrompt() {
  write('\r\n> ')
}

function submit() {
  submitCount += 1
  const submitted = input.replace(/\s+/g, ' ').trim()
  write(`\r\nSUBMITTED:${submitCount}:${submitted}\r\n`)
  input = ''
  firstEnterBecameNewline = false
  renderPrompt()
}

function appendText(text) {
  input += text
  const rendered = text.replace(/\n/g, '\r\n')
  if (ECHO_DELAY_MS > 0) {
    setTimeout(() => write(rendered), ECHO_DELAY_MS)
  } else {
    write(rendered)
  }
}

function handleEnter() {
  const now = Date.now()
  if (pasteEndedAt > 0 && now - pasteEndedAt < PASTE_SETTLE_MS) {
    return
  }
  if (FIRST_ENTER_NEWLINE && input.trim() && !firstEnterBecameNewline) {
    firstEnterBecameNewline = true
    appendText('\n')
    return
  }
  if (input.trim()) submit()
}

function handleData(chunk) {
  let data = chunk.toString('utf8')

  while (data.length > 0) {
    if (data.startsWith('\x03')) {
      write('\r\n')
      process.exit(0)
    }

    if (data.startsWith('\x1b[200~')) {
      pasteMode = true
      data = data.slice('\x1b[200~'.length)
      continue
    }

    if (data.startsWith('\x1b[201~')) {
      pasteMode = false
      pasteEndedAt = Date.now()
      data = data.slice('\x1b[201~'.length)
      continue
    }

    const char = data[0]
    data = data.slice(1)

    if (char === '\r' || char === '\n') {
      if (pasteMode) {
        appendText('\n')
      } else {
        handleEnter()
      }
      continue
    }

    if (char === '\x7f') {
      input = input.slice(0, -1)
      write('\b \b')
      continue
    }

    appendText(char)
  }
}

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true)
}
process.stdin.resume()
process.stdin.on('data', handleData)

write(`Thinking submit probe. Ctrl-C exits. first-enter-newline=${FIRST_ENTER_NEWLINE ? 'on' : 'off'} echo-delay-ms=${ECHO_DELAY_MS} paste-settle-ms=${PASTE_SETTLE_MS}`)
renderPrompt()
