#!/usr/bin/env node
// Terminal readiness gate for the local NotNaked target.

import { existsSync, readFileSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKSPACE = process.env.HOTWAX_WORKSPACE || join(homedir(), 'Documents', 'github')
const MOQUI_HOME = process.env.MOQUI_HOME || join(WORKSPACE, 'moqui-framework')
const ACCXUI_HOME = process.env.ACCXUI_HOME || join(WORKSPACE, 'accxui')

async function loadTarget() {
  const base = JSON.parse(await readFile(join(HERE, 'notnaked-target.json'), 'utf8'))
  const overridePath = join(WORKSPACE, 'notnaked-target.local.json')
  try {
    const override = JSON.parse(await readFile(overridePath, 'utf8'))
    return { ...base, ...override, _overridePath: overridePath }
  } catch {
    return base
  }
}

const TARGET = await loadTarget()
const JAVA_HOME = process.env.JAVA11_HOME || (existsSync(join(WORKSPACE, 'toolchains', 'jdk-11', 'bin', 'java')) ? join(WORKSPACE, 'toolchains', 'jdk-11') : '/opt/homebrew/opt/openjdk@11')
const PATH_PLUS = [join(WORKSPACE, 'toolchains', 'bin'), join(JAVA_HOME, 'bin'), process.env.PATH || ''].join(':')

function run(bin, args, timeout = 6000, extraEnv = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, env: { ...process.env, PATH: PATH_PLUS, ...extraEnv }, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => resolve({ failed: !!err, code: err?.code || 0, stdout: stdout || '', stderr: stderr || '' }))
  })
}

async function probe(url, timeout = 3000) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeout)
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: 'manual' })
    return { ok: true, status: res.status }
  } catch (error) {
    return { ok: false, error: error.name || String(error) }
  } finally {
    clearTimeout(timer)
  }
}

async function portListening(port) {
  const res = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'])
  if (!res.stdout.trim()) return { listening: false }
  const pid = (res.stdout.match(/\np(\d+)/) || res.stdout.match(/^p(\d+)/) || [])[1]
  const command = (res.stdout.match(/\nc([^\n]+)/) || [])[1]
  return { listening: true, pid, command }
}

function requiredComponentLinks() {
  return [...new Set([
    ...(TARGET.activeComponents || []),
    ...(TARGET.conditionalComponents || []).filter((component) => !component.optional),
  ].map((component) => component.link || component.source))]
}

async function componentNames() {
  try {
    return (await readdir(join(MOQUI_HOME, 'runtime', 'component'))).filter((name) => !name.startsWith('.') && name !== 'README')
  } catch {
    return []
  }
}

function mysqlConfigOk() {
  const path = join(MOQUI_HOME, 'runtime', 'conf', 'MoquiDevConf.xml')
  try {
    const xml = readFileSync(path, 'utf8')
    return /name="entity_ds_db_conf"\s+value="mysql8"/.test(xml) &&
      /name="entity_ds_database"\s+value="moqui"/.test(xml) &&
      /name="entity_ds_user"\s+value="moqui"/.test(xml)
  } catch {
    return false
  }
}

function repoRows() {
  const repos = [
    ...(TARGET.publicRepos || []),
    ...(TARGET.optionalRepos || []),
    ...(TARGET.privateRepos || []),
    ...(TARGET.pwaApps || []),
  ]
  return repos.map((repo) => {
    const path = join(WORKSPACE, repo.path || repo.repo)
    const present = existsSync(path)
    const git = existsSync(join(path, '.git'))
    return { ...repo, path, present, git, state: git ? 'clone' : (present ? 'archive' : 'missing') }
  })
}

async function localApps() {
  const results = []
  for (const app of TARGET.pwaApps || []) {
    const port = app.port
    const appPath = join(ACCXUI_HOME, app.path)
    const listening = await portListening(port)
    results.push({ ...app, appPath, installed: existsSync(appPath), running: listening.listening })
  }
  return results
}

const repos = repoRows()
const requiredRepoKeys = new Set([
  ...(TARGET.publicRepos || []),
  ...(TARGET.privateRepos || []),
  ...(TARGET.pwaApps || []),
].map((repo) => `${repo.owner}/${repo.repo}`))
const missingRepos = repos.filter((repo) => !repo.present && requiredRepoKeys.has(`${repo.owner}/${repo.repo}`))
const archiveRepos = repos.filter((repo) => repo.state === 'archive')
const [java, node, pnpm, mysqlPort, solrProbe, moquiProbe, components, apps] = await Promise.all([
  run(join(JAVA_HOME, 'bin', 'java'), ['-version']),
  run(join(WORKSPACE, 'toolchains', 'bin', 'node'), ['--version']),
  run(join(WORKSPACE, 'toolchains', 'bin', 'pnpm'), ['--version']),
  portListening(3306),
  probe('http://127.0.0.1:8983/solr/'),
  probe('http://127.0.0.1:8080/rest/s1/admin/checkLoginOptions'),
  componentNames(),
  localApps(),
])

const requiredComponents = requiredComponentLinks()
const missingComponents = requiredComponents.filter((name) => !components.includes(name))
const missingApps = apps.filter((app) => !app.running)
const checks = [
  { id: 'repo-access', ok: missingRepos.length === 0, detail: missingRepos.length ? `missing/unreachable ${missingRepos.map((repo) => `${repo.owner}/${repo.repo}`).join(', ')}` : `${requiredRepoKeys.size}/${requiredRepoKeys.size} required repos present` },
  { id: 'real-clones', ok: archiveRepos.length === 0 && missingRepos.length === 0, detail: `${repos.length - archiveRepos.length - missingRepos.length} clones, ${archiveRepos.length} archives, ${missingRepos.length} missing` },
  { id: 'toolchains', ok: !java.failed && !node.failed && !pnpm.failed, detail: `java=${java.failed ? 'missing' : 'ok'}, node=${node.failed ? 'missing' : 'ok'}, pnpm=${pnpm.failed ? 'missing' : 'ok'}` },
  { id: 'java11', ok: !java.failed && /version "11\./.test(java.stderr || java.stdout), detail: (java.stderr || java.stdout || 'missing').split('\n')[0] },
  { id: 'mysql', ok: mysqlPort.listening && mysqlConfigOk(), detail: `${mysqlPort.listening ? 'running on :3306' : 'not running'}; MoquiDevConf mysql8=${mysqlConfigOk()}` },
  { id: 'solr', ok: solrProbe.ok, detail: solrProbe.ok ? `HTTP ${solrProbe.status}` : `unreachable (${solrProbe.error})` },
  { id: 'components', ok: missingComponents.length === 0 && requiredComponents.length >= 10 && requiredComponents.length <= 15, detail: `${requiredComponents.length - missingComponents.length}/${requiredComponents.length} required links present${missingComponents.length ? `; missing ${missingComponents.join(', ')}` : ''}` },
  { id: 'moqui', ok: moquiProbe.ok && moquiProbe.status === 200, detail: moquiProbe.ok ? `HTTP ${moquiProbe.status}` : `unreachable (${moquiProbe.error})` },
  { id: 'pwas', ok: missingApps.length === 0 && apps.length === 5, detail: `${apps.length - missingApps.length}/5 running${missingApps.length ? `; missing ${missingApps.map((app) => app.repo).join(', ')}` : ''}` },
  { id: 'pwa-data', ok: false, detail: moquiProbe.ok && moquiProbe.status === 200 ? 'needs browser/session verification against live NotNaked data' : 'blocked until Moqui is live with real NotNaked data' },
]

const failed = checks.filter((check) => !check.ok)
for (const check of checks) {
  const label = check.ok ? 'pass' : 'todo'
  console.log(`${label.padEnd(5)} ${check.id.padEnd(12)} ${check.detail}`)
}
console.log('')
console.log(`NotNaked readiness: ${checks.length - failed.length}/${checks.length} passed`)
if (failed.length) process.exitCode = 2
