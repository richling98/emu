#!/usr/bin/env node

let input = ''
let pasteMode = false
let pasteEndedAt = 0
let submitCount = 0

const PASTE_SETTLE_MS = 500

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
  renderPrompt()
}

function appendText(text) {
  input += text
  write(text.replace(/\n/g, '\r\n'))
}

function handleEnter() {
  const now = Date.now()
  if (pasteEndedAt > 0 && now - pasteEndedAt < PASTE_SETTLE_MS) {
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

write('Emu submit probe. Ctrl-C exits.')
renderPrompt()
