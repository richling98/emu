#!/usr/bin/env node

const fs = require('fs')
const path = require('path')

const helperPath = path.join(
  __dirname,
  '..',
  'node_modules',
  'node-pty',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'spawn-helper'
)

try {
  if (!fs.existsSync(helperPath)) {
    console.warn(`[postinstall] node-pty spawn-helper not found at ${helperPath}`)
    process.exit(0)
  }

  // Ensure helper binary can be executed by node-pty on macOS/Linux.
  fs.chmodSync(helperPath, 0o755)
  console.log(`[postinstall] fixed executable bit on ${helperPath}`)
} catch (error) {
  console.warn('[postinstall] failed to set node-pty helper permissions:', error)
}
