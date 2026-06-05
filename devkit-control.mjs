#!/usr/bin/env node
// Reliable local controller for the DevKit dashboard process.
// It handles the macOS/screen case where the screen session disappears but the node listener remains.

import { execFile, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const CONSOLE = join(HERE, 'moqui-console.mjs')
const SESSION = process.env.HOTWAX_DEVKIT_SCREEN || 'hotwax-devkit'
const PORT = Number(process.env.MOQUI_CONSOLE_PORT || process.env.PORT || 7070)
const WORKSPACE = process.env.HOTWAX_WORKSPACE || join(homedir(), 'Documents', 'github')

function run(bin, args, options = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: options.timeout || 8000, env: { ...process.env, ...options.env }, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => resolve({ failed: !!error, code: error?.code || 0, stdout: stdout || '', stderr: stderr || '' }))
  })
}

async function portPids() {
  const r = await run('lsof', ['-nP', `-iTCP:${PORT}`, '-sTCP:LISTEN', '-Fpcn'])
  const rows = []
  let pid = '', command = '', name = ''
  for (const line of r.stdout.split('\n')) {
    if (!line) continue
    if (line[0] === 'p') {
      if (pid) rows.push({ pid, command, name })
      pid = line.slice(1); command = ''; name = ''
    } else if (line[0] === 'c') command = line.slice(1)
    else if (line[0] === 'n') name = line.slice(1)
  }
  if (pid) rows.push({ pid, command, name })
  return rows
}

async function psCommand(pid) {
  const r = await run('ps', ['-p', String(pid), '-o', 'command='])
  return r.stdout.trim()
}

async function devkitPids() {
  const rows = await portPids()
  const out = []
  for (const row of rows) {
    const command = await psCommand(row.pid)
    if (command.includes('moqui-console.mjs')) out.push({ ...row, command })
  }
  return out
}

async function stop() {
  await run('screen', ['-S', SESSION, '-X', 'quit'])
  const pids = await devkitPids()
  for (const row of pids) {
    try { process.kill(Number(row.pid), 'SIGTERM') } catch { /* already gone */ }
  }
  await new Promise((resolve) => setTimeout(resolve, 600))
  for (const row of await devkitPids()) {
    try { process.kill(Number(row.pid), 'SIGKILL') } catch { /* already gone */ }
  }
  return pids
}

async function start() {
  const existing = await devkitPids()
  if (existing.length) return { started: false, existing }
  const child = spawn('screen', ['-dmS', SESSION, process.execPath, CONSOLE], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, HOTWAX_WORKSPACE: WORKSPACE, MOQUI_CONSOLE_PORT: String(PORT) },
  })
  child.unref()
  await new Promise((resolve) => setTimeout(resolve, 1000))
  return { started: true, pids: await devkitPids() }
}

async function status() {
  const pids = await devkitPids()
  return { running: pids.length > 0, port: PORT, session: SESSION, pids }
}

const action = process.argv[2] || 'status'
if (!['status', 'start', 'stop', 'restart'].includes(action)) {
  console.error('usage: hotwax-devkit-control [status|start|stop|restart]')
  process.exit(2)
}

let result
if (action === 'status') result = await status()
else if (action === 'stop') result = { stopped: await stop(), ...(await status()) }
else if (action === 'start') result = await start()
else {
  const stopped = await stop()
  const started = await start()
  result = { stopped, started, ...(await status()) }
}

console.log(JSON.stringify(result, null, 2))
