#!/usr/bin/env node
// Prints a shareable unblock report for the local NotNaked setup.

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKSPACE = process.env.HOTWAX_WORKSPACE || join(homedir(), 'Documents', 'github')

async function loadManifest() {
  const base = JSON.parse(await readFile(join(HERE, 'notnaked-target.json'), 'utf8'))
  const overridePath = join(WORKSPACE, 'notnaked-target.local.json')
  try {
    const override = JSON.parse(await readFile(overridePath, 'utf8'))
    return { ...base, ...override, _overridePath: overridePath }
  } catch {
    return base
  }
}

const manifest = await loadManifest()

function runScript(script) {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(HERE, script)], { env: { ...process.env, HOTWAX_WORKSPACE: WORKSPACE }, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ code: error?.code || 0, stdout: stdout || '', stderr: stderr || '' }))
  })
}

const [access, readiness] = await Promise.all([
  runScript('check-notnaked-access.mjs'),
  runScript('check-notnaked-readiness.mjs'),
])

const unconfirmed = (manifest.privateRepos || []).filter((repo) => repo.accessNote)

console.log('HotWax NotNaked local setup unblock report')
console.log(`Workspace: ${WORKSPACE}`)
console.log(`Target: ${manifest.name || 'notnaked-base'}`)
if (manifest._overridePath) console.log(`Target override: ${manifest._overridePath}`)
console.log('')
console.log('Required but currently unconfirmed/unreachable repos:')
for (const repo of unconfirmed) {
  console.log(`- ${repo.owner}/${repo.repo}`)
  console.log(`  ${repo.accessNote}`)
}
console.log('')
console.log('Repo access check:')
console.log(access.stdout.trim() || access.stderr.trim() || `(exit ${access.code})`)
console.log('')
console.log('Readiness check:')
console.log(readiness.stdout.trim() || readiness.stderr.trim() || `(exit ${readiness.code})`)
console.log('')
console.log('Next action needed:')
console.log('- Confirm the canonical NotNaked repo names and grant access, or provide a GitHub token that can fetch them.')
console.log('- Install Apple Command Line Tools (`xcode-select --install`) so archive checkouts can be upgraded to real git clones.')
process.exitCode = access.code || readiness.code || 0
