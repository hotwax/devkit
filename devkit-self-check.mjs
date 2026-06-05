#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PKG_DIR = dirname(fileURLToPath(import.meta.url))

export function devkitSelfCheckCommands(cwd = PKG_DIR, node = process.execPath) {
  return [
    { id: 'tests', cwd, command: node, args: ['--test'] },
    { id: 'server-syntax', cwd, command: node, args: ['--check', join(cwd, 'moqui-console.mjs')] },
    { id: 'bootstrap-syntax', cwd, command: node, args: ['--check', join(cwd, 'bootstrap-hotwax-local.mjs')] },
    { id: 'gitless-clone-syntax', cwd, command: node, args: ['--check', join(cwd, 'gitless-clone.mjs')] },
    { id: 'pwa-dependency-bridge-syntax', cwd, command: node, args: ['--check', join(cwd, 'pwa-dependency-bridge.mjs')] },
    { id: 'bundle-discovery-syntax', cwd, command: node, args: ['--check', join(cwd, 'notnaked-bundle-discovery.mjs')] },
    { id: 'bundle-request-syntax', cwd, command: node, args: ['--check', join(cwd, 'notnaked-bundle-request.mjs')] },
    { id: 'access-summary-syntax', cwd, command: node, args: ['--check', join(cwd, 'notnaked-access-summary.mjs')] },
  ]
}

export async function runDevkitSelfCheck({ cwd = PKG_DIR, node = process.execPath } = {}) {
  const results = []
  for (const check of devkitSelfCheckCommands(cwd, node)) {
    const result = await run(check.command, check.args, { cwd: check.cwd })
    results.push({ ...check, ...result })
  }
  return {
    ok: results.every((result) => result.ok),
    count: results.filter((result) => result.ok).length,
    total: results.length,
    node,
    cwd,
    results,
  }
}

function run(command, args, { cwd }) {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, timeout: 120000 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error?.code ?? 0,
        signal: error?.signal || '',
        stdout,
        stderr,
      })
    })
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runDevkitSelfCheck()
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.ok ? 0 : 1)
}
