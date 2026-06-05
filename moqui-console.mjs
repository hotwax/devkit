#!/usr/bin/env node
// moqui-console — a lightweight, LOCAL-ONLY dev cockpit for bare-metal Moqui + (optionally) its PWAs.
// Part of hotwax/devkit. Run it from anywhere with no install:
//
//   npx github:hotwax/devkit            # from your Moqui checkout or PWA workspace
//   node moqui-console.mjs              # if you have the file locally
//
// It self-locates MOQUI_HOME (the running Moqui process, your current directory if it's inside a
// checkout, $MOQUI_HOME, or a run script), then serves a dashboard at http://127.0.0.1:7070:
//   preflight (Java 11, ports, MySQL/Solr, liveness) · effective config (MoquiActualConf.xml) ·
//   loaded components + git branch/dirty state · EXPECTED components (maarg-docker-config myaddons.xml) ·
//   a JVM→data→Moqui→REST→PWA topology with click-to-Start/Stop/Restart · log tail · diagnose.
//
// First run: open the dashboard, click Setup (⚙) and pick your Moqui project folder (and your accxui
// workspace folder, to manage the PWAs). Choices persist in ~/.config/devkit/settings.json, so it
// works the same no matter where you launched it from. Also overridable per-project via a
// `devkit.config.json` in the working dir, or env: MOQUI_HOME, MOQUI_RUN_SCRIPT, JAVA11_HOME,
// MOQUI_CONSOLE_PORT, MOQUI_CONSOLE_NO_PWA=1.
//
// Zero dependencies, no build step. Requires Node 18+ (global fetch). Verified on Node 25.

import { createServer } from 'node:http'
import { execFile, spawn } from 'node:child_process'
import { readFile, open, readdir, lstat, readlink, realpath, mkdir, rename } from 'node:fs/promises'
import { existsSync, openSync, writeFileSync, readFileSync, mkdirSync, rmSync, symlinkSync, chmodSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { findCompleteLocalBundle } from './notnaked-bundle-discovery.mjs'
import { runDevkitSelfCheck } from './devkit-self-check.mjs'
import { summarizeRepoAccess } from './notnaked-access-summary.mjs'
import { privateRepoBundleRequestFromSource } from './notnaked-bundle-request.mjs'

// ─── CONFIG (env-overridable defaults; per-project override via devkit.config.json) ──────────
const DEFAULT_WORKSPACE = process.env.HOTWAX_WORKSPACE || join(homedir(), 'Documents', 'github')
const CONFIG = {
  host: '127.0.0.1',
  port: Number(process.env.MOQUI_CONSOLE_PORT || process.env.PORT) || 7070,
  java11Home: '/opt/homebrew/opt/openjdk@11', // mac/Homebrew default
  ports: { moqui: 8080, mysql: 3306, solr: 8983, elasticsearch: 9200 },
  moquiLiveness: 'http://localhost:8080/rest/s1/admin/checkLoginOptions',
  solrProbe: 'http://localhost:8983/solr/',              // 401 here still means "Solr is alive"
  // MOQUI_HOME is normally auto-discovered; these are explicit fallbacks (empty = rely on discovery).
  moquiHome: '',
  accxuiHome: '',
  moquiRunScript: '',     // optional: a script that cd's in + `gradlew run`
  screens: { moqui: 'moqui', mysql: 'hotwax-mysql', solr: 'hotwax-solr' }, // detached GNU screen session names this tool creates
  expectedComponentSet: 'notnaked-base',
  // HotWax PWA conventions (only used when a PWA workspace is detected in the working dir).
  // `dir` is relative to your working dir; `filter` (pnpm workspace name) or `prefix` (path) launches dev.
  pwaApps: [
    { name: 'fulfillment', port: 8101, dir: 'apps/fulfillment' },
    { name: 'receiving', port: 8102, dir: 'apps/receiving', script: 'serve' },
    { name: 'available-to-promise', port: 8105, dir: 'apps/available-to-promise' },
    { name: 'order-manager', port: 8106, dir: 'apps/order-manager' },
    { name: 'products', port: 8107, dir: 'apps/products' },
  ],
}

const PKG_DIR = fileURLToPath(new URL('.', import.meta.url)) // where this script + .html live (npm cache under npx)
const CWD = process.cwd()                                    // where the dev invoked us (their project / checkout)
const SANE_PATH = [
  join(DEFAULT_WORKSPACE, 'toolchains', 'bin'),
  '/usr/sbin',
  '/usr/bin',
  '/bin',
  '/sbin',
  '/opt/homebrew/bin',
  process.env.PATH || '',
].join(':')
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

function applyConfigFile(path) {
  try { Object.assign(CONFIG, JSON.parse(readFileSync(path, 'utf8'))) } catch { /* none */ }
}

// Bootstrap writes a workspace-level config under ~/Documents/github. Load it from any launch dir,
// then let a project-local config and explicit env vars take precedence.
const WORKSPACE_CONFIG = join(DEFAULT_WORKSPACE, 'devkit.config.json')
const CWD_CONFIG = join(CWD, 'devkit.config.json')
applyConfigFile(WORKSPACE_CONFIG)
if (CWD_CONFIG !== WORKSPACE_CONFIG) applyConfigFile(CWD_CONFIG)
if (process.env.JAVA11_HOME) CONFIG.java11Home = process.env.JAVA11_HOME
if (process.env.MOQUI_HOME) CONFIG.moquiHome = process.env.MOQUI_HOME
if (process.env.ACCXUI_HOME) CONFIG.accxuiHome = process.env.ACCXUI_HOME
if (process.env.MOQUI_RUN_SCRIPT) CONFIG.moquiRunScript = process.env.MOQUI_RUN_SCRIPT
CONFIG.java11 = CONFIG.java11 || join(CONFIG.java11Home, 'bin', 'java')
CONFIG.startHint = CONFIG.startHint || (CONFIG.moquiRunScript
  ? `screen -dmS ${CONFIG.screens.moqui} bash ${CONFIG.moquiRunScript}`
  : 'Start the Moqui box above (or run ./gradlew run with JAVA_HOME set)')

// Persistent, machine-global settings (the folders the dev picked). Survives `npx` runs, unlike CWD.
const SETTINGS_PATH = join(homedir(), '.config', 'devkit', 'settings.json')
let SETTINGS = {}
try { SETTINGS = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')) || {} } catch { SETTINGS = {} }
function saveSettings() {
  try { mkdirSync(dirname(SETTINGS_PATH), { recursive: true }); writeFileSync(SETTINGS_PATH, JSON.stringify(SETTINGS, null, 2)); return true }
  catch { return false }
}

// The PWA workspace root: the folder the dev picked, else the working dir if it already looks like one.
// null ⇒ Moqui-only mode (PWA band off). Recomputed each call so the folder picker takes effect live.
function accxuiRoot() {
  if (process.env.MOQUI_CONSOLE_NO_PWA) return null
  if (SETTINGS.accxuiHome && existsSync(SETTINGS.accxuiHome)) return SETTINGS.accxuiHome
  if (CONFIG.accxuiHome && existsSync(CONFIG.accxuiHome)) return CONFIG.accxuiHome
  if (existsSync(join(CWD, 'pnpm-workspace.yaml')) || existsSync(join(CWD, 'apps'))) return CWD
  return null
}

// Does `dir` look like a Moqui home (framework root / checkout)?
function looksLikeMoquiHome(dir) {
  return existsSync(join(dir, 'runtime', 'component')) || existsSync(join(dir, 'moqui.war')) ||
    (existsSync(join(dir, 'gradlew')) && existsSync(join(dir, 'runtime')))
}
// Walk up from `start` to self-locate a Moqui checkout (so the console works run from inside one).
function walkUpForMoqui(start) {
  let dir = start
  for (let i = 0; i < 8; i++) {
    if (looksLikeMoquiHome(dir)) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

// ─── small helpers ──────────────────────────────────────────────────────────

// Run a binary, never throw — always resolve {code, stdout, stderr}.
function run(bin, args, timeout = 6000, extraEnv = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, env: { ...process.env, PATH: SANE_PATH, ...extraEnv }, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout: stdout || '', stderr: stderr || '', failed: !!err }))
  })
}

async function developerToolsAvailable() {
  if (process.platform !== 'darwin') return true
  const r = await run('xcode-select', ['-p'])
  return !r.failed
}

async function gitAvailable() {
  if (!(await developerToolsAvailable())) return false
  const r = await run('git', ['--version'])
  return !r.failed
}

function parseSoftwareUpdateLabels(output) {
  return (output.match(/\* Label: .+/g) || []).map((line) => line.replace(/^\* Label:\s*/, '').trim())
}

async function commandLineToolsStatus() {
  if (process.platform !== 'darwin') return { platform: process.platform, installed: true, gitAvailable: await gitAvailable(), message: 'Apple CLT is macOS-only.' }
  const [selected, updates, gitPath] = await Promise.all([
    run('xcode-select', ['-p']),
    run('softwareupdate', ['--list'], 30000),
    run('which', ['git']),
  ])
  const labels = parseSoftwareUpdateLabels(updates.stdout + updates.stderr)
  const cltLabels = labels.filter((label) => /command line tools|cltools/i.test(label))
  const installed = !selected.failed
  const git = installed ? await run('git', ['--version']) : { failed: true, stdout: '', stderr: '' }
  const gitOk = !selected.failed && !git.failed
  return {
    platform: process.platform,
    installed,
    selectedPath: installed ? selected.stdout.trim() : '',
    gitPath: gitPath.failed ? '' : gitPath.stdout.trim(),
    gitAvailable: gitOk,
    gitVersion: gitOk ? git.stdout.trim() : '',
    softwareupdate: {
      ok: !updates.failed,
      labels,
      commandLineToolsLabels: cltLabels,
    },
    installCommand: 'xcode-select --install',
    fallback: {
      supported: true,
      dashboardAction: 'Setup -> NotNaked repo access -> Import local folder',
      description: 'Until Git is available, DevKit can import private repo folders or archives from a local bundle and use GitHub archive fallbacks for public repos.',
    },
    message: gitOk
      ? `Apple Command Line Tools are active at ${selected.stdout.trim()}.`
      : (cltLabels.length
        ? `Apple Command Line Tools are not active; softwareupdate lists ${cltLabels.length} CLT package(s).`
        : 'Apple Command Line Tools are not active, and softwareupdate does not currently list a CLT package. Use Install Apple CLT to open the macOS installer dialog.'),
  }
}

// HTTP probe with a hard timeout. ok:true means we got *a* response (even 401/403 = the server is alive).
async function probe(url, ms = 4000) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), ms)
  try {
    const r = await fetch(url, { signal: ac.signal, redirect: 'manual' })
    let body = ''
    try { body = (await r.text()).slice(0, 2000) } catch { /* ignore */ }
    return { ok: true, status: r.status, body }
  } catch (e) {
    return { ok: false, error: e.cause?.code || e.code || e.name || String(e) }
  } finally {
    clearTimeout(t)
  }
}

// Which process (if any) is LISTENing on a TCP port. Returns {listening, pid, command}.
async function portOwner(port) {
  const r = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpcn'])
  if (!r.stdout.trim()) return { listening: false }
  let pid, command
  for (const line of r.stdout.split('\n')) {
    if (line[0] === 'p') pid = line.slice(1)
    else if (line[0] === 'c') command = line.slice(1)
  }
  return { listening: true, pid, command }
}

function parseListenPort(name) {
  const m = String(name || '').match(/:(\d+)$/)
  return m ? Number(m[1]) : null
}

async function listeningTcpPorts() {
  const r = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'])
  const out = []
  let pid = null, command = null
  for (const line of r.stdout.split('\n')) {
    if (!line) continue
    if (line[0] === 'p') { pid = line.slice(1); command = null }
    else if (line[0] === 'c') command = line.slice(1)
    else if (line[0] === 'n' && pid) {
      const name = line.slice(1)
      const port = parseListenPort(name)
      if (port) out.push({ pid, command, name, port })
    }
  }
  const seen = new Set()
  return out.filter((p) => {
    const key = `${p.pid}:${p.port}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function pidCwd(pid) {
  const r = await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
  const line = r.stdout.split('\n').find((l) => l[0] === 'n')
  if (!line) return ''
  try { return await realpath(line.slice(1)) } catch { return line.slice(1) }
}

async function pidArgs(pid) {
  const r = await run('ps', ['-p', String(pid), '-o', 'command='])
  return r.stdout.trim()
}

async function readJsonFile(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return null }
}

function workspaceRoot() {
  return DEFAULT_WORKSPACE
}

function expandLocalPath(path) {
  const value = String(path || '').trim()
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return value
}

async function notNakedTarget() {
  const basePath = join(PKG_DIR, 'notnaked-target.json')
  const overridePath = join(workspaceRoot(), 'notnaked-target.local.json')
  const base = await readJsonFile(basePath)
  if (!base) return null
  const override = await readJsonFile(overridePath)
  return {
    ...base,
    ...(override || {}),
    _basePath: basePath,
    _overridePath: override ? overridePath : '',
  }
}

function runtimeDataRoot() {
  return join(workspaceRoot(), 'runtime-data')
}

function toolchainPaths() {
  const root = workspaceRoot()
  return {
    javaHome: CONFIG.java11Home,
    java: CONFIG.java11,
    mysql: join(root, 'toolchains', 'mysql', 'bin', 'mysql'),
    mysqld: join(root, 'toolchains', 'mysql', 'bin', 'mysqld'),
    solr: join(root, 'toolchains', 'solr', 'bin', 'solr'),
    node: join(root, 'toolchains', 'bin', 'node'),
    pnpm: join(root, 'toolchains', 'bin', 'pnpm'),
  }
}

async function checkGithubRepo(repo, explicitToken = '') {
  const token = explicitToken || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
  const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}`
  const workspace = workspaceRoot()
  const localPath = join(workspace, repo.path || repo.repo)
  const localPresent = existsSync(localPath)
  const localGitPresent = existsSync(join(localPath, '.git'))
  if (!token) {
    return {
      ...repo,
      ok: localPresent,
      reachable: false,
      localPresent,
      localGitPresent,
      status: 'not_checked',
      message: localPresent ? 'present locally; remote reachability not checked without token' : 'missing locally; paste a token to check remote access',
      url,
    }
  }
  const headers = { Authorization: `Bearer ${token}` }
  try {
    const res = await fetch(url, { headers })
    let message = ''
    try { message = (await res.json()).message || '' } catch { /* ignore */ }
    return { ...repo, ok: res.ok || localPresent, reachable: res.ok, localPresent, localGitPresent, status: res.status, message, url }
  } catch (error) {
    return { ...repo, ok: localPresent, reachable: false, localPresent, localGitPresent, status: 'network', url, error: error.message }
  }
}

async function apiNotNakedAccess() {
  return apiNotNakedAccessWithToken('')
}

async function apiNotNakedAccessWithToken(token = '') {
  const target = await notNakedTarget()
  if (!target) return { error: 'notnaked-target.json not found in devkit package' }
  const publicRepos = await Promise.all((target.publicRepos || []).map((repo) => checkGithubRepo(repo, token)))
  const privateRepos = await Promise.all((target.privateRepos || []).map((repo) => checkGithubRepo(repo, token)))
  const publicMissing = publicRepos.filter((r) => !r.ok)
  const privateMissing = privateRepos.filter((r) => !r.ok)
  const missing = [...publicMissing, ...privateMissing]
  const response = {
    target: target.name || 'notnaked-base',
    overridePath: target._overridePath || '',
    tokenPresent: !!(token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN),
    counts: {
      public: publicRepos.length,
      publicOk: publicRepos.length - publicMissing.length,
      private: privateRepos.length,
      privateOk: privateRepos.length - privateMissing.length,
      missing: missing.length,
    },
    ready: missing.length === 0,
    publicRepos,
    privateRepos,
    missing,
  }
  response.summary = summarizeRepoAccess(response)
  return response
}

async function fetchGithubJson(path, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined
  try {
    const res = await fetch(`https://api.github.com${path}`, { headers })
    const body = await res.json().catch(() => ({}))
    return { ok: res.ok, status: res.status, body, headers: Object.fromEntries(res.headers.entries()) }
  } catch (error) {
    return { ok: false, status: 'network', body: { message: error.message }, headers: {} }
  }
}

async function probeGithubZipball(owner, repo, ref, token, redirects = 5) {
  const headers = token
    ? { Authorization: `Bearer ${token}`, Range: 'bytes=0-1023' }
    : { Range: 'bytes=0-1023' }
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/zipball/${ref || 'main'}`, { headers, redirect: 'manual' })
    if (res.status >= 300 && res.status < 400 && res.headers.get('location') && redirects > 0) {
      const next = await fetch(res.headers.get('location'), { headers, redirect: 'manual' })
      return { ok: next.ok || next.status === 206, status: next.status, location: res.headers.get('location') || '', message: next.ok || next.status === 206 ? '' : await next.text().catch(() => '') }
    }
    return { ok: res.ok || res.status === 206, status: res.status, location: res.headers.get('location') || '', message: res.ok || res.status === 206 ? '' : await res.text().catch(() => '') }
  } catch (error) {
    return { ok: false, status: 'network', location: '', message: error.message }
  }
}

async function apiGithubTokenDiagnostics(options = {}) {
  const token = String(options.githubToken || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim()
  if (!token) {
    const source = await apiSourceState()
    return {
      ok: false,
      tokenPresent: false,
      user: { ok: false, status: 'none', login: '', message: 'No token provided.' },
      scopes: [],
      rate: { core: {}, search: {} },
      hotwaxOrg: { ok: false, status: 'not_checked', message: 'No token provided.', login: '' },
      repoAccess: null,
      archiveAccess: null,
      missing: (source.rows || []).filter((row) => row.state === 'missing').map((row) => ({ owner: row.owner, repo: row.repo, path: row.path, purpose: row.purpose })),
      advice: ['Paste a one-time GitHub token to diagnose private repo access. No unauthenticated GitHub calls were made.'],
    }
  }
  const target = await notNakedTarget()
  const privateRepos = target?.privateRepos || []
  const [user, rate, org, access] = await Promise.all([
    fetchGithubJson('/user', token),
    fetchGithubJson('/rate_limit', token),
    fetchGithubJson('/orgs/hotwax', token),
    apiNotNakedAccessWithToken(token),
  ])
  const archiveRows = user.ok ? await Promise.all(privateRepos.map(async (repo) => {
    const probe = await probeGithubZipball(repo.owner, repo.repo, repo.branch || 'main', token)
    return { owner: repo.owner, repo: repo.repo, ref: repo.branch || 'main', ok: probe.ok, status: probe.status, message: probe.message ? String(probe.message).slice(0, 200) : '' }
  })) : []
  const core = rate.body?.resources?.core || {}
  const search = rate.body?.resources?.search || {}
  const login = user.body?.login || ''
  const scopes = (user.headers['x-oauth-scopes'] || '').split(',').map((s) => s.trim()).filter(Boolean)
  const valid = token ? user.ok : false
  const hotwaxVisible = org.ok
  const missing = access.missing || []
  const advice = []
  if (!token) advice.push('Paste a one-time GitHub token to diagnose private repo access.')
  else if (!valid) advice.push(user.body?.message || 'Token did not authenticate with GitHub.')
  if (valid && !hotwaxVisible) advice.push('Token is valid, but HotWax org visibility was not confirmed.')
  if (valid && missing.length) advice.push(`Token still cannot reach ${missing.map((r) => `${r.owner}/${r.repo}`).join(', ')}.`)
  const archiveMissing = archiveRows.filter((row) => !row.ok)
  if (valid && archiveMissing.length) advice.push(`Token cannot fetch zipballs for ${archiveMissing.map((r) => `${r.owner}/${r.repo}`).join(', ')}.`)
  if (valid && !missing.length && !archiveMissing.length) advice.push('Token can reach and archive-fetch all repos in the current NotNaked target.')
  return {
    ok: valid && missing.length === 0 && archiveMissing.length === 0,
    tokenPresent: !!token,
    user: { ok: user.ok, status: user.status, login, message: user.body?.message || '' },
    scopes,
    rate: {
      core: { limit: core.limit, remaining: core.remaining, reset: core.reset },
      search: { limit: search.limit, remaining: search.remaining, reset: search.reset },
    },
    hotwaxOrg: { ok: org.ok, status: org.status, message: org.body?.message || '', login: org.body?.login || '' },
    repoAccess: access.counts || null,
    archiveAccess: { total: archiveRows.length, ok: archiveRows.filter((row) => row.ok).length, rows: archiveRows },
    missing,
    advice,
  }
}

async function apiSourceState() {
  const target = await notNakedTarget()
  if (!target) return { error: 'notnaked-target.json not found in devkit package' }
  const workspace = workspaceRoot()
  const repos = [
    ...(target.publicRepos || []),
    ...(target.optionalRepos || []),
    ...(target.privateRepos || []),
    ...(target.pwaApps || []),
  ]
  const rows = repos.map((repo) => {
    const path = join(workspace, repo.path || repo.repo)
    const present = existsSync(path)
    const git = existsSync(join(path, '.git'))
    return {
      owner: repo.owner,
      repo: repo.repo,
      path,
      present,
      git,
      state: git ? 'clone' : (present ? 'archive' : 'missing'),
      purpose: repo.purpose || '',
    }
  })
  const counts = {
    total: rows.length,
    clones: rows.filter((r) => r.state === 'clone').length,
    archives: rows.filter((r) => r.state === 'archive').length,
    missing: rows.filter((r) => r.state === 'missing').length,
  }
  return {
    workspace,
    target: target.name || 'notnaked-base',
    overridePath: target._overridePath || '',
    gitAvailable: await gitAvailable(),
    counts,
    ready: counts.missing === 0 && counts.archives === 0,
    rows,
  }
}

async function apiToolchains() {
  const root = workspaceRoot()
  const paths = toolchainPaths()
  const [java, mysql, solr, node, pnpm, mysqlPort, solrProbe] = await Promise.all([
    run(paths.java, ['-version']),
    run(paths.mysql, ['--version']),
    run(paths.solr, ['--version'], 10000, { JAVA_HOME: paths.javaHome, PATH: `${join(paths.javaHome, 'bin')}:${SANE_PATH}` }),
    run(paths.node, ['--version']),
    run(paths.pnpm, ['--version']),
    portOwner(CONFIG.ports.mysql),
    probe(CONFIG.solrProbe, 3000),
  ])
  const row = (name, path, result, parse = (r) => (r.stdout || r.stderr || '').split('\n')[0]) => ({
    name,
    path,
    present: existsSync(path),
    ok: !result.failed,
    version: result.failed ? '' : parse(result).trim(),
    detail: result.failed ? (result.stderr || result.stdout || `failed (${result.code})`).split('\n')[0] : '',
  })
  const rows = [
    row('Java 11', paths.java, java, (r) => (r.stderr || r.stdout).split('\n')[0]),
    row('MySQL client', paths.mysql, mysql),
    { name: 'MySQL server', path: paths.mysqld, present: existsSync(paths.mysqld), ok: mysqlPort.listening, version: mysqlPort.listening ? `running on :${CONFIG.ports.mysql}` : '', detail: mysqlPort.listening ? `pid ${mysqlPort.pid}` : 'not running' },
    row('Solr', paths.solr, solr),
    { name: 'Solr server', path: paths.solr, present: existsSync(paths.solr), ok: solrProbe.ok, version: solrProbe.ok ? `reachable on :${CONFIG.ports.solr}` : '', detail: solrProbe.ok ? `HTTP ${solrProbe.status}` : `unreachable (${solrProbe.error})` },
    row('Node', paths.node, node),
    row('pnpm', paths.pnpm, pnpm),
  ]
  return {
    root,
    ready: rows.every((r) => r.present && r.ok),
    counts: { total: rows.length, ok: rows.filter((r) => r.present && r.ok).length },
    rows,
  }
}

async function accxuiAppCatalog(root) {
  if (!root) return []
  const byDir = new Map()
  const add = async (entry) => {
    const dir = pwaDir(entry, root)
    if (!dir || !existsSync(dir)) return
    let realDir = dir
    try { realDir = await realpath(dir) } catch { /* keep dir */ }
    const pkg = await readJsonFile(join(realDir, 'package.json')) || await readJsonFile(join(dir, 'package.json')) || {}
    const existing = byDir.get(realDir) || {}
    const name = existing.name || entry.name || pkg.name || basename(realDir)
    const packageName = pkg.name || name
    byDir.set(realDir, {
      ...existing,
      ...entry,
      port: entry.port ?? existing.port,
      filter: entry.filter ?? existing.filter,
      name,
      packageName,
      dir,
      realDir,
      aliases: [...new Set([...(existing.aliases || []), entry.name, entry.filter, packageName, basename(dir), basename(realDir)].filter(Boolean))],
    })
  }

  for (const app of CONFIG.pwaApps) await add(app)
  let appDirs = []
  try { appDirs = await readdir(join(root, 'apps')) } catch { /* no apps dir */ }
  for (const appDir of appDirs) {
    const dir = join(root, 'apps', appDir)
    if (!existsSync(join(dir, 'package.json'))) continue
    const pkg = await readJsonFile(join(dir, 'package.json')) || {}
    await add({ name: pkg.name || appDir, dir: join('apps', appDir) })
  }
  return [...byDir.values()]
}

function commandHasApp(command, app) {
  const cmd = String(command || '')
  return app.aliases.some((alias) =>
    cmd.includes(`--filter ${alias}`) ||
    cmd.includes(`--filter=${alias}`) ||
    cmd.includes(`/apps/${alias}/`) ||
    cmd.includes(`/apps/${basename(app.dir)}/`) ||
    cmd.includes(`${app.realDir}/`) ||
    cmd.includes(`${app.dir}/`)
  )
}

function commandPrefixPath(command) {
  const m = String(command || '').match(/--prefix(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/)
  return m ? (m[1] || m[2] || m[3]) : ''
}

async function apiLocalApps() {
  const root = accxuiRoot()
  if (!root) return { root: null, managed: false, apps: [], count: 0, message: 'Choose your accxui workspace folder in Setup to map localhost servers to app names.' }

  let realRoot = root
  try { realRoot = await realpath(root) } catch { /* keep root */ }
  const catalog = await accxuiAppCatalog(realRoot)
  const byExpectedPort = new Map(catalog.filter((a) => a.port).map((a) => [Number(a.port), a]))
  const listening = await listeningTcpPorts()
  const rows = []

  await Promise.all(listening.map(async (proc) => {
    if (proc.port === CONFIG.port || proc.port === CONFIG.ports.moqui || proc.port === CONFIG.ports.mysql || proc.port === CONFIG.ports.solr || proc.port === CONFIG.ports.elasticsearch) return
    const [cwd, args] = await Promise.all([pidCwd(proc.pid), pidArgs(proc.pid)])
    const prefix = commandPrefixPath(args)
    let realPrefix = prefix
    if (prefix) { try { realPrefix = await realpath(prefix) } catch { /* keep prefix */ } }

    let app = byExpectedPort.get(proc.port)
    if (!app) app = catalog.find((a) => cwd === a.realDir || cwd === a.dir || realPrefix === a.realDir || realPrefix === a.dir || commandHasApp(args, a))
    if (!app) return

    rows.push({
      name: app.packageName || app.name,
      label: app.name,
      port: proc.port,
      url: `http://localhost:${proc.port}`,
      pid: proc.pid,
      command: proc.command,
      cwd,
      appDir: app.realDir,
      expectedPort: app.port || null,
      portMatchesConfig: app.port ? Number(app.port) === proc.port : null,
      source: byExpectedPort.get(proc.port) === app ? 'configured-port' : 'process-path',
    })
  }))

  rows.sort((a, b) => a.port - b.port || a.name.localeCompare(b.name))
  return { root: realRoot, managed: true, count: rows.length, apps: rows }
}

function htmlTitle(html) {
  const m = String(html || '').match(/<title[^>]*>([^<]*)<\/title>/i)
  return m ? m[1].trim() : ''
}

async function apiPwaHealth() {
  const apps = await apiLocalApps()
  if (!apps.managed) return { ...apps, ready: false, health: [] }
  const runningByName = new Map((apps.apps || []).map((app) => [app.label || app.name, app]))
  const health = await Promise.all(CONFIG.pwaApps.map(async (expectedApp) => {
    const running = runningByName.get(expectedApp.name)
    if (!running) {
      return { name: expectedApp.name, ok: false, running: false, port: expectedApp.port, url: `http://localhost:${expectedApp.port}`, detail: 'dev server not running' }
    }
    const page = await probe(running.url, 5000)
    const body = page.body || ''
    const ok = page.ok && page.status >= 200 && page.status < 400 && /<html/i.test(body)
    return {
      name: expectedApp.name,
      ok,
      running: true,
      port: running.port,
      url: running.url,
      status: page.status || null,
      title: htmlTitle(body),
      hasAppRoot: /id=["']app["']|id=["']root["']/i.test(body),
      hasViteClient: body.includes('/@vite/client'),
      detail: ok ? `HTTP ${page.status}` : `page unavailable (${page.error || page.status || 'unknown'})`,
    }
  }))
  return {
    root: apps.root,
    managed: true,
    ready: health.every((row) => row.ok),
    count: health.filter((row) => row.ok).length,
    total: CONFIG.pwaApps.length,
    health,
  }
}

const LOCAL_MOQUI_BASE = 'http://localhost:8080'
const LOCAL_MOQUI_REST = `${LOCAL_MOQUI_BASE}/rest/s1/`

const PWA_ENV_DEFAULTS = {
  fulfillment: {
    VITE_BASE_URL: LOCAL_MOQUI_REST,
    VITE_OMS_TYPE: 'MOQUI',
  },
  receiving: {
    VUE_APP_BASE_URL: LOCAL_MOQUI_REST,
    VUE_APP_OMS_TYPE: 'MOQUI',
  },
  'available-to-promise': {
    VITE_BASE_URL: LOCAL_MOQUI_REST,
    VITE_OMS_TYPE: 'MOQUI',
  },
  'order-manager': {
    VITE_MOQUI_BASE_URL: LOCAL_MOQUI_BASE,
    VITE_OMS_TYPE: 'MOQUI',
    VITE_DEV_OMS: 'localhost:8080',
    VITE_DEV_AUTO_LOGIN: 'true',
  },
  products: {
    VITE_OMS_TYPE: 'MOQUI',
    VITE_DEV_OMS: 'localhost:8080',
  },
}

function parseEnvText(text) {
  const out = {}
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
  return out
}

async function pwaEnvValues(dir) {
  const files = ['.env.example', '.env.development', '.env', '.env.local']
  const values = {}
  const presentFiles = []
  for (const file of files) {
    const path = join(dir, file)
    try {
      Object.assign(values, parseEnvText(await readFile(path, 'utf8')))
      presentFiles.push(file)
    } catch { /* absent */ }
  }
  return { values, presentFiles }
}

async function apiPwaBackendConfig() {
  const root = accxuiRoot()
  if (!root) return { ready: false, managed: false, rows: [], message: 'Choose your accxui workspace folder in Setup.' }
  const rows = await Promise.all(CONFIG.pwaApps.map(async (app) => {
    const dir = pwaDir(app, root)
    const defaults = PWA_ENV_DEFAULTS[app.name] || {}
    if (!dir || !existsSync(dir)) return { name: app.name, ok: false, dir, presentFiles: [], expected: defaults, actual: {}, missing: Object.keys(defaults), detail: 'app folder missing' }
    const env = await pwaEnvValues(dir)
    const missing = Object.entries(defaults)
      .filter(([key, value]) => env.values[key] !== value)
      .map(([key]) => key)
    return {
      name: app.name,
      ok: missing.length === 0,
      dir,
      envPath: join(dir, '.env.local'),
      presentFiles: env.presentFiles,
      expected: defaults,
      actual: Object.fromEntries(Object.keys(defaults).map((key) => [key, env.values[key] || ''])),
      missing,
      detail: missing.length ? `missing/mismatched ${missing.join(', ')}` : 'local Moqui backend defaults present',
    }
  }))
  return {
    ready: rows.every((row) => row.ok),
    managed: true,
    count: rows.filter((row) => row.ok).length,
    total: rows.length,
    rows,
  }
}

const LOCAL_PWA_USER = process.env.HOTWAX_LOCAL_PWA_USER || 'james.brown'
const LOCAL_PWA_PASSWORD = process.env.HOTWAX_LOCAL_PWA_PASSWORD || 'moqui'

function localPwaAuthHeader() {
  return `Basic ${Buffer.from(`${LOCAL_PWA_USER}:${LOCAL_PWA_PASSWORD}`).toString('base64')}`
}

function looksLikePwaData(name, json) {
  if (name === 'profile') return json?.username === LOCAL_PWA_USER
  if (Array.isArray(json)) return true
  if (json && typeof json === 'object') {
    if (Array.isArray(json.products)) return true
    if (Array.isArray(json.orders)) return true
    if (Array.isArray(json.list)) return true
    if (Array.isArray(json.results)) return true
  }
  return false
}

async function probePwaDataEndpoint(check) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), 6000)
  try {
    const res = await fetch(`${LOCAL_MOQUI_BASE}${check.path}`, {
      signal: ac.signal,
      headers: {
        Authorization: localPwaAuthHeader(),
        Accept: 'application/json',
      },
      redirect: 'manual',
    })
    let json = null
    let text = ''
    try {
      text = await res.text()
      json = text ? JSON.parse(text) : null
    } catch { /* non-json or empty body */ }
    const ok = res.status >= 200 && res.status < 300 && looksLikePwaData(check.name, json)
    return {
      ...check,
      ok,
      status: res.status,
      shape: Array.isArray(json) ? 'array' : (json && typeof json === 'object' ? Object.keys(json).slice(0, 5).join(',') : ''),
      detail: ok ? `HTTP ${res.status}` : `HTTP ${res.status}${text ? ` · ${text.slice(0, 160)}` : ''}`,
    }
  } catch (error) {
    return {
      ...check,
      ok: false,
      status: 'network',
      detail: error.cause?.code || error.code || error.name || error.message,
    }
  } finally {
    clearTimeout(t)
  }
}

async function apiPwaDataVerification() {
  const checks = [
    { name: 'profile', app: 'session', path: '/rest/s1/admin/user/profile', expects: `${LOCAL_PWA_USER} profile` },
    { name: 'fulfillment', app: 'fulfillment', path: '/rest/s1/poorti/picklists?pageSize=5', expects: 'picklist list' },
    { name: 'receiving', app: 'receiving', path: '/rest/s1/poorti/picklists?pageSize=5', expects: 'picklist list' },
    { name: 'available-to-promise', app: 'available-to-promise', path: '/rest/s1/available-to-promise/ruleGroups?pageSize=5', expects: 'rule group list' },
    { name: 'order-manager', app: 'order-manager', path: '/rest/s1/oms/orders?pageSize=5', expects: 'orders list' },
    { name: 'products', app: 'products', path: '/rest/s1/oms/products?pageSize=5', expects: 'products list' },
  ]
  const rows = await Promise.all(checks.map((check) => probePwaDataEndpoint(check)))
  const dataRows = rows.filter((row) => row.app !== 'session')
  const session = rows.find((row) => row.app === 'session')
  const ready = rows.every((row) => row.ok)
  return {
    ready,
    user: LOCAL_PWA_USER,
    count: dataRows.filter((row) => row.ok).length,
    total: dataRows.length,
    sessionOk: !!session?.ok,
    rows,
    detail: ready
      ? `${LOCAL_PWA_USER} can access ${dataRows.length}/${dataRows.length} representative PWA data APIs`
      : `${dataRows.filter((row) => row.ok).length}/${dataRows.length} data APIs reachable; session=${session?.ok ? 'ok' : 'failed'}`,
  }
}

function mergeEnvText(existing, values) {
  const lines = String(existing || '').split('\n')
  const seen = new Set()
  const out = lines.map((line) => {
    const m = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)(=)(.*)$/)
    if (!m || !(m[2] in values)) return line
    seen.add(m[2])
    return `${m[2]}=${values[m[2]]}`
  })
  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) out.push(`${key}=${value}`)
  }
  return out.join('\n').replace(/\n*$/, '\n')
}

async function apiWritePwaBackendConfig(options = {}) {
  const root = accxuiRoot()
  if (!root) return { ok: false, message: 'Choose your accxui workspace folder in Setup.' }
  const written = []
  for (const app of CONFIG.pwaApps) {
    const dir = pwaDir(app, root)
    const defaults = PWA_ENV_DEFAULTS[app.name] || {}
    if (!dir || !existsSync(dir) || !Object.keys(defaults).length) continue
    const envPath = join(dir, '.env.local')
    let existing = ''
    try { existing = await readFile(envPath, 'utf8') } catch { /* create */ }
    writeFileSync(envPath, mergeEnvText(existing, defaults))
    written.push({ name: app.name, envPath, keys: Object.keys(defaults) })
  }
  const restarts = []
  if (options.restartPwas) {
    for (const app of CONFIG.pwaApps) {
      const wasWritten = written.some((row) => row.name === app.name)
      if (!wasWritten) continue
      const result = await restartPwa(app.name)
      restarts.push({ target: `pwa:${app.name}`, ...result })
    }
  }
  const config = await apiPwaBackendConfig()
  return {
    ok: config.ready && (!options.restartPwas || restarts.every((row) => row.ok)),
    written,
    restarts,
    config,
    message: options.restartPwas
      ? `Wrote local backend config for ${written.length} PWA app(s) and restarted ${restarts.filter((row) => row.ok).length}/${restarts.length} PWA server(s).`
      : `Wrote local backend config for ${written.length} PWA app(s). Restart affected PWA dev servers to reload env files.`,
  }
}

async function moquiWarPid() {
  const ps = await run('ps', ['-ax', '-o', 'pid=,command='])
  for (const line of ps.stdout.split('\n')) {
    if (line.includes('-jar moqui.war')) { const m = line.trim().match(/^(\d+)/); if (m) return m[1] }
  }
  return null
}

const pwaApp = (name) => CONFIG.pwaApps.find((a) => a.name === name)
const pwaDir = (a, root) => (a.dir ? (a.dir.startsWith('/') ? a.dir : join(root || CWD, a.dir)) : null)

async function pwaPackage(dir) {
  return dir ? (await readJsonFile(join(dir, 'package.json')) || {}) : {}
}

function pwaStartScript(app, pkg) {
  if (app.script) return app.script
  const scripts = pkg?.scripts || {}
  if (scripts.dev) return 'dev'
  if (scripts.serve) return 'serve'
  return ''
}

// ─── discovery: find the ACTIVE Moqui checkout ───────────────────────────────
let _moquiHome = null
async function discover(force = false) {
  if (_moquiHome && !force) return _moquiHome
  let pid = await moquiWarPid()
  let home = null, source = 'process'
  if (pid) {
    const r = await run('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'])
    const n = r.stdout.split('\n').find((l) => l[0] === 'n')
    if (n) { try { home = await realpath(n.slice(1)) } catch { home = n.slice(1) } }
  }
  if (!home && SETTINGS.moquiHome && existsSync(SETTINGS.moquiHome)) { // the folder the dev picked
    source = 'picked'; try { home = await realpath(SETTINGS.moquiHome) } catch { home = SETTINGS.moquiHome }
  }
  if (!home && CONFIG.moquiHome && existsSync(CONFIG.moquiHome)) {
    source = 'config'; try { home = await realpath(CONFIG.moquiHome) } catch { home = CONFIG.moquiHome }
  }
  if (!home) { // self-locate: walk up from the working dir (run from inside a checkout)
    const w = walkUpForMoqui(CWD)
    if (w) { source = 'self-locate'; try { home = await realpath(w) } catch { home = w } }
  }
  if (!home && CONFIG.moquiRunScript) { // parse the `cd <path>` out of the run script
    source = 'runscript'
    try {
      const s = await readFile(CONFIG.moquiRunScript, 'utf8')
      const m = s.match(/^\s*cd\s+(\S+)/m)
      if (m) { try { home = await realpath(m[1]) } catch { home = m[1] } }
    } catch { /* ignore */ }
  }
  // Validate + self-heal: if the chosen path isn't a framework checkout, try to recover the real one
  // (e.g. the dev picked moqui-runtime or a subdir — use the sibling/ancestor moqui-framework).
  let valid = false, rawHome = home, adjusted = false
  if (home) {
    const resolved = resolveMoquiHome(home)
    if (resolved !== home) { adjusted = true; try { home = await realpath(resolved) } catch { home = resolved } }
    valid = looksLikeMoquiHome(home)
  }
  _moquiHome = { pid, home, source, valid, rawHome, adjusted }
  return _moquiHome
}

// Map a user-picked path to the real Moqui framework home, recovering common mistakes.
function resolveMoquiHome(picked) {
  if (!picked || looksLikeMoquiHome(picked)) return picked
  const up = walkUpForMoqui(picked)                 // they picked a subdir of the framework
  if (up) return up
  const sib = join(dirname(picked), 'moqui-framework') // they picked moqui-runtime (sibling of the framework)
  if (existsSync(sib) && looksLikeMoquiHome(sib)) return sib
  return picked                                      // give up — keep it, but discover() marks valid:false
}

// ─── read endpoints ───────────────────────────────────────────────────────────

async function apiDiscover() { return discover(true) }

async function apiPreflight() {
  const [java11, bareJava, moqui, mysql, solr, es, live, solrProbe] = await Promise.all([
    run(CONFIG.java11, ['-version']),
    run('java', ['-version']),
    portOwner(CONFIG.ports.moqui),
    portOwner(CONFIG.ports.mysql),
    portOwner(CONFIG.ports.solr),
    portOwner(CONFIG.ports.elasticsearch),
    probe(CONFIG.moquiLiveness),
    probe(CONFIG.solrProbe),
  ])
  const java11Ver = (java11.stderr || java11.stdout).split('\n')[0] || ''
  return {
    java11: { ok: !java11.failed, detail: java11.failed ? 'Java 11 not found at ' + CONFIG.java11 + ' (set JAVA11_HOME)' : java11Ver },
    bareJava: { ok: !bareJava.failed, detail: bareJava.failed ? 'bare `java` not on PATH (fine — the run script / JAVA_HOME handles it)' : (bareJava.stderr || '').split('\n')[0] },
    ports: {
      moqui: { ...moqui, expected: CONFIG.ports.moqui },
      mysql: { ...mysql, expected: CONFIG.ports.mysql },
      solr: { ...solr, expected: CONFIG.ports.solr },
      elasticsearch: { ...es, expected: CONFIG.ports.elasticsearch },
    },
    moquiLive: live.ok && live.status === 200,
    moquiLiveDetail: live.ok ? `HTTP ${live.status}` : (moqui.listening ? `unreachable (${live.error})` : `not listening on :${CONFIG.ports.moqui}`),
    solrAlive: solrProbe.ok,
    solrDetail: solrProbe.ok ? `HTTP ${solrProbe.status}${solrProbe.status === 401 ? ' (auth-protected, up)' : ''}` : `unreachable (${solrProbe.error})`,
  }
}

async function apiConfig() {
  const d = await discover()
  if (!d.home) return { error: 'Moqui checkout not found' }
  const confPath = join(d.home, 'runtime', 'log', 'MoquiActualConf.xml')
  let xml
  try { xml = await readFile(confPath, 'utf8') } catch (e) { return { error: `cannot read ${confPath}: ${e.code}` } }
  const props = {}
  const re = /<default-property\s+name="([^"]+)"\s+value="([^"]*)"(\s+is-secret="true")?\s*\/>/g
  let m
  while ((m = re.exec(xml))) props[m[1]] = m[3] ? '[secret]' : m[2]
  const searchRefs = [...new Set((xml.match(/https?:\/\/[^"'<>\s}]*(?:9200|8983)[^"'<>\s}]*/g) || []))]
  return {
    confPath,
    db: {
      conf: props.entity_ds_db_conf, host: props.entity_ds_host, port: props.entity_ds_port,
      database: props.entity_ds_database, user: props.entity_ds_user, schema: props.entity_ds_schema || '(default)',
    },
    searchRefs,
    instance: { purpose: props.instance_purpose, name: props['ofbiz.instance.name'], id: props['unique.instance.id'] },
    notable: {
      solr_cloud: props['solr.cloud.enable'], solr_cores: props['solr.shared.core.name'],
      shopify_api_version: props.shopify_api_version, locale: props.default_locale,
    },
  }
}

async function apiComponents() {
  const d = await discover()
  if (!d.home) return { error: 'No Moqui folder set. Open Setup (⚙) and pick your moqui-framework folder.' }
  if (!d.valid) return { error: `"${d.home}" is not a moqui-framework checkout (no runtime/component). In Setup (⚙), pick the moqui-framework folder.` }
  const dir = join(d.home, 'runtime', 'component')
  let names
  try { names = await readdir(dir) } catch (e) { return { error: `cannot read ${dir}: ${e.code}` } }
  const out = []
  const canGit = await gitAvailable()
  for (const name of names.sort()) {
    if (name === 'README' || name.startsWith('.')) continue
    const full = join(dir, name)
    let target = null, isLink = false
    try { const st = await lstat(full); isLink = st.isSymbolicLink(); if (isLink) target = await readlink(full) } catch { /* ignore */ }
    // one `git status -b --porcelain` gives the current branch AND the uncommitted-change state
    const g = canGit ? await run('git', ['-C', full, 'status', '-b', '--porcelain=v1']) : { failed: true, stdout: '' }
    let branch = null, modified = 0, untracked = 0
    if (!g.failed) {
      const lines = g.stdout.split('\n')
      branch = ((lines[0] || '').replace(/^## /, '').split('...')[0].split(' ')[0]) || null
      if (branch && branch.startsWith('HEAD')) branch = '(detached)'
      const changes = lines.slice(1).filter(Boolean)
      untracked = changes.filter((l) => l.startsWith('??')).length
      modified = changes.length - untracked
    }
    out.push({ name, branch, target, isLink, drift: !!branch && branch !== 'main', dirty: modified > 0, modified, untracked })
  }
  return { dir, components: out }
}

function requiredComponentLinks(target) {
  const required = [
    ...(target.activeComponents || []),
    ...(target.conditionalComponents || []).filter((c) => !c.optional),
  ]
  return [...new Set(required.map((c) => c.link || c.source).filter(Boolean))]
}

async function configuredMysqlOk() {
  const d = await discover()
  const home = d.home || MOQUI_HOME_FROM_SETTINGS_OR_DEFAULT()
  const confPath = join(home, 'runtime', 'conf', 'MoquiDevConf.xml')
  try {
    const xml = await readFile(confPath, 'utf8')
    return {
      ok: /name="entity_ds_db_conf"\s+value="mysql8"/.test(xml) &&
        /name="entity_ds_database"\s+value="moqui"/.test(xml) &&
        /name="entity_ds_user"\s+value="moqui"/.test(xml),
      confPath,
    }
  } catch (error) {
    return { ok: false, confPath, error: error.code || error.message }
  }
}

async function apiNotNakedReadiness() {
  const target = await notNakedTarget()
  if (!target) return { error: 'notnaked-target.json not found in devkit package' }
  const [access, source, toolchains, pre, comps, apps, pwaHealth, pwaBackend, pwaData, mysqlConf] = await Promise.all([
    apiNotNakedAccess(),
    apiSourceState(),
    apiToolchains(),
    apiPreflight(),
    apiComponents().catch((error) => ({ error: error.message })),
    apiLocalApps(),
    apiPwaHealth(),
    apiPwaBackendConfig(),
    apiPwaDataVerification(),
    configuredMysqlOk(),
  ])

  const requiredComponents = requiredComponentLinks(target)
  const actualComponents = new Set((comps.components || []).map((c) => c.name))
  const missingComponents = requiredComponents.filter((name) => !actualComponents.has(name))
  const expectedPwas = new Set((target.pwaApps || []).map((app) => app.repo))
  const runningPwas = new Set((apps.apps || []).map((app) => app.label || app.name))
  const missingPwas = [...expectedPwas].filter((name) => !runningPwas.has(name))

  const checks = [
    {
      id: 'repo-access',
      title: 'Required NotNaked repositories are present',
      ok: access.ready,
      detail: access.ready ? `${access.counts.publicOk + access.counts.privateOk}/${access.counts.public + access.counts.private} required repos present or reachable` :
        access.summary?.detail || `missing/unreachable ${access.missing.map((r) => `${r.owner}/${r.repo}`).join(', ')}`,
    },
    {
      id: 'real-clones',
      title: 'Sources are real git clones',
      ok: source.counts.archives === 0 && source.counts.missing === 0,
      detail: `${source.counts.clones} clones, ${source.counts.archives} archives, ${source.counts.missing} missing${source.gitAvailable ? '' : ' · Git/Apple CLT unavailable'}`,
    },
    {
      id: 'toolchains',
      title: 'Bundled local toolchains are ready',
      ok: toolchains.ready,
      detail: `${toolchains.counts.ok}/${toolchains.counts.total} toolchain checks passing`,
    },
    {
      id: 'java11',
      title: 'Java 11 is available',
      ok: pre.java11.ok,
      detail: pre.java11.detail,
    },
    {
      id: 'mysql',
      title: 'MySQL is running and Moqui is configured for mysql8',
      ok: pre.ports.mysql.listening && mysqlConf.ok,
      detail: `${pre.ports.mysql.listening ? `running on :${CONFIG.ports.mysql}` : 'not running'} · ${mysqlConf.ok ? 'MoquiDevConf.xml uses mysql8/moqui' : `MySQL config missing or wrong (${mysqlConf.confPath})`}`,
    },
    {
      id: 'solr',
      title: 'Solr is reachable',
      ok: pre.solrAlive,
      detail: pre.solrDetail,
    },
    {
      id: 'components',
      title: 'NotNaked component set is wired',
      ok: missingComponents.length === 0 && requiredComponents.length >= 10 && requiredComponents.length <= 15,
      detail: `${requiredComponents.length - missingComponents.length}/${requiredComponents.length} required component links present${missingComponents.length ? ` · missing ${missingComponents.join(', ')}` : ''}`,
    },
    {
      id: 'moqui',
      title: 'Moqui is running and answering REST',
      ok: pre.moquiLive,
      detail: pre.moquiLive ? pre.moquiLiveDetail : `not ready: ${pre.moquiLiveDetail}`,
    },
    {
      id: 'pwas',
      title: 'Five PWAs are running',
      ok: missingPwas.length === 0 && apps.count >= 5 && pwaHealth.ready,
      detail: `${apps.count || 0}/5 running, ${pwaHealth.count || 0}/${pwaHealth.total || 5} app shells loading${missingPwas.length ? ` · missing ${missingPwas.join(', ')}` : ''}`,
    },
    {
      id: 'pwa-backend-config',
      title: 'PWAs point at local Moqui',
      ok: pwaBackend.ready,
      detail: `${pwaBackend.count || 0}/${pwaBackend.total || 5} local backend env files configured`,
    },
    {
      id: 'pwa-data',
      title: 'PWAs are logged in and showing NotNaked data',
      ok: pwaData.ready,
      detail: pwaData.detail,
    },
  ]

  const failed = checks.filter((c) => !c.ok)
  return {
    ready: failed.length === 0,
    target: target.name || 'notnaked-base',
    overridePath: target._overridePath || '',
    summary: { passed: checks.length - failed.length, total: checks.length, failed: failed.length },
    checks,
    missing: failed.map((c) => ({ id: c.id, title: c.title, detail: c.detail })),
    evidence: {
      access: access.counts,
      source: source.counts,
      toolchains: toolchains.counts,
      requiredComponents,
      actualComponentCount: (comps.components || []).length,
      pwaCount: apps.count || 0,
      pwaPageCount: pwaHealth.count || 0,
      pwaBackendConfig: { count: pwaBackend.count || 0, total: pwaBackend.total || 5 },
      pwaData: { count: pwaData.count || 0, total: pwaData.total || 5, sessionOk: pwaData.sessionOk },
    },
  }
}

async function apiObjectiveAudit() {
  const target = await notNakedTarget()
  if (!target) return { error: 'notnaked-target.json not found in devkit package' }
  const [readiness, source, toolchains, pre, apps, pwaHealth, pwaBackend, pwaData, comps, mysqlConf] = await Promise.all([
    apiNotNakedReadiness(),
    apiSourceState(),
    apiToolchains(),
    apiPreflight(),
    apiLocalApps(),
    apiPwaHealth(),
    apiPwaBackendConfig(),
    apiPwaDataVerification(),
    apiComponents().catch(() => ({ components: [] })),
    configuredMysqlOk(),
  ])
  const requiredComponents = requiredComponentLinks(target)
  const actualComponents = new Set((comps.components || []).map((c) => c.name))
  const presentRequired = requiredComponents.filter((name) => actualComponents.has(name))
  const missingRequired = requiredComponents.filter((name) => !actualComponents.has(name))
  const pwaRows = (source.rows || []).filter((row) => row.path.includes('/apps/'))
  const pwaPresent = pwaRows.filter((row) => row.present).length
  const checks = [
    {
      id: 'workspace',
      title: 'Documents/github workspace exists',
      ok: existsSync(workspaceRoot()),
      evidence: workspaceRoot(),
    },
    {
      id: 'real-clones',
      title: 'HotWax/Moqui/PWA sources are real local clones',
      ok: source.counts.missing === 0 && source.counts.archives === 0 && source.counts.clones === source.counts.total,
      evidence: `${source.counts.clones} clones, ${source.counts.archives} archives, ${source.counts.missing} missing`,
    },
    {
      id: 'private-notnaked',
      title: 'NotNaked private/canonical repos are present',
      ok: readiness.checks?.find((c) => c.id === 'repo-access')?.ok || false,
      evidence: readiness.checks?.find((c) => c.id === 'repo-access')?.detail || '',
    },
    {
      id: 'components',
      title: '10-15 required NotNaked components are wired',
      ok: missingRequired.length === 0 && requiredComponents.length >= 10 && requiredComponents.length <= 15,
      evidence: `${presentRequired.length}/${requiredComponents.length} present${missingRequired.length ? `; missing ${missingRequired.join(', ')}` : ''}`,
    },
    {
      id: 'java11',
      title: 'Java 11 is available',
      ok: pre.java11.ok,
      evidence: pre.java11.detail,
    },
    {
      id: 'mysql',
      title: 'MySQL is running and Moqui config uses mysql8',
      ok: pre.ports.mysql.listening && mysqlConf.ok,
      evidence: `${pre.ports.mysql.listening ? 'running on :3306' : 'not running'}; mysql8 config=${mysqlConf.ok}`,
    },
    {
      id: 'solr',
      title: 'Solr is running',
      ok: pre.solrAlive,
      evidence: pre.solrDetail,
    },
    {
      id: 'pwa-sources',
      title: 'Five AccxUI PWA app folders are present',
      ok: pwaPresent === 5,
      evidence: `${pwaPresent}/5 app folders present`,
    },
    {
      id: 'pwas-running',
      title: 'Five PWAs are running',
      ok: apps.count === 5 && pwaHealth.ready,
      evidence: `${apps.count || 0}/5 running; ${pwaHealth.count || 0}/${pwaHealth.total || 5} app shells loading`,
    },
    {
      id: 'pwa-backend-config',
      title: 'Five PWAs point at local Moqui',
      ok: pwaBackend.ready,
      evidence: `${pwaBackend.count || 0}/${pwaBackend.total || 5} local backend env files configured`,
    },
    {
      id: 'moqui-live',
      title: 'Moqui is running with the NotNaked component set',
      ok: pre.moquiLive,
      evidence: pre.moquiLive ? pre.moquiLiveDetail : `not ready: ${pre.moquiLiveDetail}`,
    },
    {
      id: 'pwa-data',
      title: 'PWAs are logged in and showing NotNaked data',
      ok: pwaData.ready,
      evidence: pwaData.detail,
    },
  ]
  const passed = checks.filter((check) => check.ok).length
  return {
    ready: passed === checks.length,
    summary: { passed, total: checks.length, failed: checks.length - passed },
    checks,
    evidence: {
      readiness: readiness.summary,
      source: source.counts,
      toolchains: toolchains.counts,
      pwaData: { count: pwaData.count || 0, total: pwaData.total || 5, sessionOk: pwaData.sessionOk },
    },
  }
}

// Expected components, using maarg-docker-config/myaddons.xml as the system of record.
async function findManifest() {
  const d = await discover()
  const tried = []
  if (d.home) { tried.push(join(d.home, 'myaddons.xml'), join(d.home, 'runtime', 'component', 'maarg-docker-config', 'myaddons.xml')) }
  for (const p of tried) { try { return { path: p, xml: await readFile(p, 'utf8') } } catch { /* next */ } }
  return { path: null, xml: null, tried }
}

async function apiExpectations(setName) {
  setName = setName || CONFIG.expectedComponentSet
  const { path, xml, tried } = await findManifest()
  if (!xml) return { error: 'myaddons.xml not found (clone maarg-docker-config, or copy it to MOQUI_HOME)', tried, set: setName }
  const catalog = {}
  let m
  const cre = /<component\s+([^>]*?)\/>/g
  while ((m = cre.exec(xml))) {
    const attrs = {}
    for (const a of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = a[2]
    if (attrs.name) catalog[attrs.name] = { name: attrs.name, repoName: attrs['repository-name'] || attrs.name, group: attrs.group, branch: attrs.branch, version: attrs.version, private: attrs.private === 'Y' }
  }
  const sets = {}
  const sre = /<component-set\s+name="([^"]+)"\s+components="([^"]+)"\s*\/>/g
  while ((m = sre.exec(xml))) sets[m[1]] = m[2].split(',').map((s) => s.trim()).filter(Boolean)
  const expected = sets[setName] || []

  const d = await discover()
  let actual = []
  if (d.home) { try { actual = (await readdir(join(d.home, 'runtime', 'component'))).filter((x) => x !== 'README' && !x.startsWith('.')) } catch { /* ignore */ } }
  const has = new Set(actual)
  const present = expected.filter((c) => has.has(c))
  const missing = expected.filter((c) => !has.has(c)).map((c) => ({ ...(catalog[c] || { name: c }), command: `./gradlew getComponent -Pcomponent=${c}` }))
  const inSet = new Set(expected)
  const extra = actual.filter((c) => !inSet.has(c) && c !== 'maarg-docker-config')
  return {
    set: setName, setOptions: Object.keys(sets), manifestPath: path,
    counts: { expected: expected.length, present: present.length, missing: missing.length, extra: extra.length },
    present, missing, extra, setCommand: `./gradlew getComponentSet -PcomponentSet=${setName}`,
  }
}

async function apiLogs(kb = 64) {
  const d = await discover()
  if (!d.home) return { error: 'Moqui checkout not found' }
  // common bare-metal log names; first that exists wins
  const candidates = ['notnaked-local.log', 'moqui-console.log', 'moqui.log']
  let logPath = null
  for (const c of candidates) { if (existsSync(join(d.home, 'runtime', 'log', c))) { logPath = join(d.home, 'runtime', 'log', c); break } }
  if (!logPath) return { error: 'no Moqui log found in runtime/log (start Moqui first)' }
  let fh
  try {
    fh = await open(logPath, 'r')
    const { size } = await fh.stat()
    const len = Math.min(kb * 1024, size)
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, size - len)
    return { logPath, size, shown: len, tail: buf.toString('utf8') }
  } catch (e) {
    return { error: `cannot read log: ${e.code}` }
  } finally {
    if (fh) await fh.close()
  }
}

async function apiDiagnose() {
  const [pre, cfg, log, exp] = await Promise.all([apiPreflight(), apiConfig(), apiLogs(96), apiExpectations().catch(() => null)])
  const findings = []
  const add = (severity, title, detail, command) => findings.push({ severity, title, detail, command })
  const tail = (log.tail || '').toLowerCase()

  if (pre.moquiLive) add('ok', 'Moqui is up and serving', `${CONFIG.moquiLiveness} → ${pre.moquiLiveDetail}`)
  else if (pre.ports.moqui.listening) add('warn', 'Port 8080 is held but Moqui is not answering /rest', `pid ${pre.ports.moqui.pid} (${pre.ports.moqui.command}) holds 8080 but liveness ${pre.moquiLiveDetail}. Likely mid-boot or wedged.`)
  else add('error', 'Moqui is not running', 'Click Start on the Moqui box, or:', CONFIG.startHint)

  if (!pre.java11.ok) add('error', 'Java 11 not found', `${CONFIG.java11} did not run.`, 'brew install openjdk@11  (or set JAVA11_HOME)')
  else if (!pre.bareJava.ok) add('info', 'Java 11 present but not on PATH', 'Fine — the run script / JAVA_HOME handles it.')

  if (!pre.ports.mysql.listening) add('error', 'MySQL is down', `Moqui expects MySQL on ${CONFIG.ports.mysql} (db ${cfg.db?.database}, user ${cfg.db?.user}).`, 'Open System architecture, click MySQL, then Start.')
  if (!pre.solrAlive) add('warn', 'Solr is not responding on 8983', 'Search-backed APIs will fail.', 'Open System architecture, click Solr, then Start.')
  const refsES = (cfg.searchRefs || []).some((u) => u.includes('9200'))
  if (refsES && !pre.ports.elasticsearch.listening) add('info', 'Config references ElasticSearch :9200 but nothing is listening', 'If your stack uses Solr, this is expected.')

  if (exp && exp.counts?.missing > 0) add('warn', `${exp.counts.missing} expected component(s) missing (set "${exp.set}")`, exp.missing.map((c) => c.name).join(', '), exp.setCommand)

  const allComps = (await apiComponents()).components || []
  const drifted = allComps.filter((c) => c.drift)
  if (drifted.length) add('info', `${drifted.length} component(s) are off \`main\``, drifted.map((c) => `${c.name} → ${c.branch}`).join(', '))
  const dirtyComps = allComps.filter((c) => c.dirty)
  if (dirtyComps.length) add('info', `${dirtyComps.length} component(s) have uncommitted changes`, dirtyComps.map((c) => `${c.name} (${c.modified} modified${c.untracked ? `, +${c.untracked} untracked` : ''})`).join(', '))

  if (tail.includes('unable to locate a java runtime')) add('error', 'Log shows "Unable to locate a Java Runtime"', 'gradlew ran without JAVA_HOME. Start via the run script (which exports it).', CONFIG.startHint)
  if (tail.includes('address already in use')) add('error', 'Log shows "Address already in use"', 'A port (likely 8080) is held — often an orphaned GradleDaemon. Stop Moqui (scope-kills it), then Start.')
  if (tail.includes('communications link failure') || tail.includes('could not create connection to database')) add('error', 'Log shows a database connection failure', `Check MySQL on ${CONFIG.ports.mysql} (db ${cfg.db?.database}).`)
  if (tail.includes('build failed')) add('warn', 'Log shows "BUILD FAILED"', 'Gradle build failed during startup — read the tail.')

  return { findings }
}

// Full system topology, JVM → data → Moqui → REST → PWA, each node carrying live status + controls.
async function apiTopology() {
  const [pre, comps, exp] = await Promise.all([apiPreflight(), apiComponents(), apiExpectations().catch(() => null)])

  const root = accxuiRoot()
  let pwaNodes
  if (!root) {
    pwaNodes = [{ id: 'pwa:none', label: 'PWA apps — folder not set', status: 'absent',
      detail: 'Moqui-only mode. To manage the PWA dev servers, open Setup (⚙) and pick your accxui workspace folder.' }]
  } else {
    const pwaAll = await Promise.all(CONFIG.pwaApps.map(async (a) => {
      const dir = pwaDir(a, root)
      const installed = dir ? existsSync(dir) : true
      const o = installed ? await portOwner(a.port) : { listening: false }
      return {
        id: 'pwa:' + a.name, label: a.name, port: a.port, pid: o.pid, installed,
        status: !installed ? 'absent' : (o.listening ? 'up' : 'down'),
        detail: !installed ? `not installed (${dir})` : (o.listening ? `dev server live on :${a.port} (pid ${o.pid})` : `installed, not running on :${a.port}`),
        url: (installed && o.listening) ? `http://localhost:${a.port}` : undefined,
        hint: !installed ? `clone it under apps/${a.name}` : null,
        controls: installed ? { target: 'pwa:' + a.name, actions: o.listening ? ['stop', 'restart'] : ['start'] } : null,
      }
    }))
    const present = pwaAll.filter((p) => p.installed)
    if (present.length === 0) {
      pwaNodes = [{ id: 'pwa:none', label: 'No PWA apps installed', status: 'absent', detail: 'PWA workspace detected, but no apps cloned under apps/. Clone one to manage it here.' }]
    } else {
      pwaNodes = present.slice()
      const absent = pwaAll.filter((p) => !p.installed)
      if (absent.length) pwaNodes.push({ id: 'pwa:absent', label: `+${absent.length} not installed`, status: 'absent', detail: absent.map((p) => p.label).join(', ') })
    }
  }

  const moquiUp = pre.moquiLive
  const procUp = pre.ports.moqui.listening
  const total = (comps.components || []).length
  const driftCount = (comps.components || []).filter((c) => c.drift).length
  const dirtyCount = (comps.components || []).filter((c) => c.dirty).length
  const missing = exp?.counts?.missing ?? null
  const n = (id, label, status, detail, extra = {}) => ({ id, label, status, detail, ...extra })
  const moquiControls = { target: 'moqui', actions: procUp ? ['stop', 'restart'] : ['start'] }

  const compDetail = `${total} loaded` + (missing != null ? ` · ${missing} of ${exp.set} missing` : '') +
    (driftCount ? ` · ${driftCount} off main` : '') + (dirtyCount ? ` · ${dirtyCount} with local changes` : '')
  const bands = [
    { id: 'pwa', label: 'PWA apps · browser', nodes: pwaNodes },
    { id: 'api', label: 'HTTP / REST API', nodes: [
      n('api', 'Moqui REST', moquiUp ? 'up' : 'down', moquiUp ? '/rest/s1/admin/checkLoginOptions → 200' : 'not answering', { port: 8080, controls: moquiControls, url: moquiUp ? 'http://localhost:8080' : undefined }),
    ] },
    { id: 'app', label: 'Moqui app server', nodes: [
      n('moqui', 'Moqui Framework', moquiUp ? 'up' : (procUp ? 'warn' : 'down'),
        moquiUp ? `serving on :8080 (pid ${pre.ports.moqui.pid})` : (procUp ? `:8080 held by pid ${pre.ports.moqui.pid} but not answering` : 'stopped'),
        { port: 8080, pid: pre.ports.moqui.pid, controls: moquiControls, url: moquiUp ? 'http://localhost:8080' : undefined }),
      n('components', `Components · ${total}`, missing ? 'warn' : (moquiUp ? 'up' : 'unknown'), compDetail,
        { hint: missing ? exp.setCommand : null }),
    ] },
    { id: 'data', label: 'Data services', nodes: [
      n('mysql', 'MySQL', pre.ports.mysql.listening ? 'up' : 'down',
        pre.ports.mysql.listening ? `:3306 (pid ${pre.ports.mysql.pid})` : 'down', { port: 3306,
        controls: pre.ports.mysql.listening ? null : { target: 'mysql', actions: ['start'] } }),
      n('solr', 'Solr', pre.solrAlive ? 'up' : 'down', pre.solrDetail, {
        port: 8983,
        url: pre.solrAlive ? 'http://localhost:8983/solr/' : undefined,
        controls: { target: 'solr', actions: pre.solrAlive ? ['stop', 'restart'] : ['start'] },
      }),
      n('es', 'ElasticSearch', pre.ports.elasticsearch.listening ? 'up' : 'info',
        pre.ports.elasticsearch.listening ? ':9200' : 'configured but not running (expected if you use Solr)', { port: 9200, url: pre.ports.elasticsearch.listening ? 'http://localhost:9200' : undefined }),
    ] },
    { id: 'jvm', label: 'Java 11 JVM · foundation', nodes: [
      n('jvm', 'Java 11', pre.java11.ok ? (procUp ? 'up' : 'info') : 'down',
        procUp ? `Moqui JVM running (pid ${pre.ports.moqui.pid})` : pre.java11.detail),
    ] },
  ]

  const edges = [
    ...pwaNodes.filter((p) => p.port).map((p) => ({ from: p.id, to: 'api', kind: 'calls' })),
    { from: 'api', to: 'moqui', kind: 'serves' },
    { from: 'moqui', to: 'components', kind: 'loads' },
    { from: 'moqui', to: 'mysql', kind: 'connects' },
    { from: 'moqui', to: 'solr', kind: 'connects' },
    { from: 'moqui', to: 'es', kind: 'connects' },
    { from: 'moqui', to: 'jvm', kind: 'runs-on' },
  ]
  return { bands, edges, moquiHome: (await discover()).home }
}

async function apiStatus() {
  const [d, moqui, live] = await Promise.all([discover(), portOwner(CONFIG.ports.moqui), probe(CONFIG.moquiLiveness, 3000)])
  return { moquiHome: d.home, pid: d.pid, source: d.source, valid: d.valid, adjusted: d.adjusted, rawHome: d.rawHome, moquiLive: live.ok && live.status === 200, port8080: moqui.listening }
}

// ─── write endpoints: guarded lifecycle (localhost only) ──────────────────────

async function missingRequiredNotNakedRepos() {
  const access = await apiNotNakedAccess()
  if (access.error) return []
  return (access.privateRepos || []).filter((repo) => !repo.ok && ['poorti', 'maarg-util', 'notnaked'].includes(repo.repo))
}

async function startMoqui(options = {}) {
  const o = await portOwner(CONFIG.ports.moqui)
  if (o.listening) return { ok: false, message: `Moqui already running (pid ${o.pid} on :${CONFIG.ports.moqui}).` }
  const missingNotNaked = await missingRequiredNotNakedRepos()
  if (missingNotNaked.length && !options.forcePublicBaseline) {
    return {
      ok: false,
      requiresOverride: true,
      missingNotNaked: missingNotNaked.map((repo) => `${repo.owner}/${repo.repo}`),
      message: `NotNaked is incomplete: ${missingNotNaked.map((repo) => `${repo.owner}/${repo.repo}`).join(', ')} missing. Starting Moqui now would boot the public fallback that is known to data-load incorrectly. Use the override only for debugging.`,
    }
  }
  if (CONFIG.moquiRunScript && existsSync(CONFIG.moquiRunScript)) {
    const r = await run('screen', ['-dmS', CONFIG.screens.moqui, 'bash', CONFIG.moquiRunScript])
    if (r.failed) return { ok: false, message: `Failed to launch screen: ${r.stderr || r.code}` }
    return { ok: true, message: `Launched Moqui in screen "${CONFIG.screens.moqui}" via the run script. Booting (~60s) — watch the status dot.` }
  }
  const d = await discover(true)
  if (!d.home) return { ok: false, message: 'No MOQUI_HOME found — set MOQUI_HOME or run from inside the checkout.' }
  const cmd = `cd ${d.home} && mkdir -p runtime/log && export JAVA_HOME=${CONFIG.java11Home} && export PATH="$JAVA_HOME/bin:$PATH" && exec ./gradlew run >> runtime/log/moqui-console.log 2>&1`
  const r = await run('screen', ['-dmS', CONFIG.screens.moqui, 'bash', '-c', cmd])
  if (r.failed) return { ok: false, message: `Failed to launch: ${r.stderr || r.code}` }
  return { ok: true, message: `Launched Moqui (gradlew run) in screen "${CONFIG.screens.moqui}". Booting (~60s).` }
}

async function stopMoqui() {
  const killed = []
  await run('screen', ['-S', CONFIG.screens.moqui, '-X', 'quit'])
  const war = await moquiWarPid()
  if (war) { await run('kill', [war]); killed.push({ pid: war, what: 'moqui.war JVM' }) }
  await delay(1500)
  let o = await portOwner(CONFIG.ports.moqui)
  if (o.listening) { // an orphan (e.g. GradleDaemon) still holds 8080 — kill exactly that PID
    await run('kill', [o.pid]); killed.push({ pid: o.pid, what: `${o.command} (held :8080)` })
    await delay(1000); o = await portOwner(CONFIG.ports.moqui)
  }
  return { ok: !o.listening, killed, message: o.listening ? `:8080 still held by pid ${o.pid} (${o.command}) — kill manually.` : `Stopped Moqui. Killed ${killed.map((k) => k.pid).join(', ') || 'nothing'}.` }
}

async function restartMoqui(options = {}) {
  const s = await stopMoqui()
  for (let i = 0; i < 12; i++) { const o = await portOwner(CONFIG.ports.moqui); if (!o.listening) break; await delay(1000) }
  const st = await startMoqui(options)
  return { ok: st.ok, killed: s.killed, message: `${s.message}  Then: ${st.message}` }
}

async function startPwa(name) {
  const root = accxuiRoot()
  if (!root) return { ok: false, message: 'No PWA workspace set — pick your accxui folder in Setup (Moqui-only mode).' }
  const a = pwaApp(name); if (!a) return { ok: false, message: `Unknown app ${name}` }
  const dir = pwaDir(a, root)
  if (dir && !existsSync(dir)) return { ok: false, message: `${name} is not installed (${dir} missing). Clone it under apps/ first.` }
  const pnpm = await run('pnpm', ['--version'])
  if (pnpm.failed) return { ok: false, message: 'pnpm is not installed yet. Run the Setup bootstrap first, or install pnpm and retry.' }
  const pkg = await pwaPackage(dir)
  const script = pwaStartScript(a, pkg)
  if (!script) return { ok: false, message: `${name} has no dev/serve script in ${dir}/package.json.` }
  const o = await portOwner(a.port)
  if (o.listening) return { ok: false, message: `${name} already running (pid ${o.pid} on :${a.port}).` }
  const logDir = join(root, 'logs'); await mkdir(logDir, { recursive: true })
  const out = openSync(join(logDir, `${name}.log`), 'a')
  const filter = a.filter || pkg.name || name
  const args = ['--filter', filter, 'run', script, '--port', String(a.port)]
  const child = spawn('pnpm', args, {
    cwd: root,
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, PATH: SANE_PATH, TSC_COMPILE_ON_ERROR: 'true' },
  })
  writeFileSync(join(logDir, `${name}.pid`), String(child.pid))
  child.unref()
  return { ok: true, message: `Started ${name} with pnpm --filter ${filter} run ${script} (pid ${child.pid}) on :${a.port}. Give Vite a few seconds; tail logs/${name}.log.` }
}

async function stopPwa(name) {
  const a = pwaApp(name); if (!a) return { ok: false, message: `Unknown app ${name}` }
  const root = accxuiRoot() || CWD
  const killed = []
  const o = await portOwner(a.port)
  if (o.listening) { await run('kill', [o.pid]); killed.push(o.pid) }
  try { const pid = (await readFile(join(root, 'logs', `${name}.pid`), 'utf8')).trim(); if (pid && !killed.includes(pid)) { await run('kill', [pid]); killed.push(pid) } } catch { /* no pid file */ }
  await delay(800)
  const after = await portOwner(a.port)
  return { ok: !after.listening, killed, message: after.listening ? `:${a.port} still held by pid ${after.pid}.` : `Stopped ${name} (killed ${killed.join(', ') || 'nothing'}).` }
}

async function restartPwa(name) {
  const s = await stopPwa(name); await delay(600); const st = await startPwa(name)
  return { ok: st.ok, killed: s.killed, message: `${s.message}  Then: ${st.message}` }
}

async function startMysql() {
  const o = await portOwner(CONFIG.ports.mysql)
  if (o.listening) return { ok: false, message: `MySQL already running (pid ${o.pid}).` }
  const paths = toolchainPaths()
  const basedir = dirname(dirname(paths.mysqld))
  const dataRoot = runtimeDataRoot()
  const datadir = join(dataRoot, 'mysql')
  const logPath = join(dataRoot, 'mysql.log')
  const socketPath = join(dataRoot, 'mysql.sock')
  const pidPath = join(dataRoot, 'mysql.pid')
  if (!existsSync(paths.mysqld)) return { ok: false, message: `Bundled mysqld not found at ${paths.mysqld}. Run Bootstrap workspace first.` }
  await mkdir(dataRoot, { recursive: true })
  if (!existsSync(join(datadir, 'mysql'))) {
    await mkdir(datadir, { recursive: true })
    const init = await run(paths.mysqld, [`--initialize-insecure`, `--basedir=${basedir}`, `--datadir=${datadir}`], 120000)
    if (init.failed) return { ok: false, message: `MySQL initialize failed: ${(init.stderr || init.stdout || '').slice(0, 500)}` }
  }
  const cmd = [
    `exec "${paths.mysqld}"`,
    `--basedir="${basedir}"`,
    `--datadir="${datadir}"`,
    `--socket="${socketPath}"`,
    `--pid-file="${pidPath}"`,
    `--port=${CONFIG.ports.mysql}`,
    '--bind-address=127.0.0.1',
    '--mysqlx=0',
    `>> "${logPath}" 2>&1`,
  ].join(' ')
  const r = await run('screen', ['-dmS', CONFIG.screens.mysql, 'bash', '-lc', cmd])
  if (r.failed) return { ok: false, message: `Failed to launch bundled MySQL: ${r.stderr || r.code}` }
  for (let i = 0; i < 30; i++) {
    const after = await portOwner(CONFIG.ports.mysql)
    if (after.listening) return { ok: true, message: `Started bundled MySQL on :${CONFIG.ports.mysql} (pid ${after.pid}). Log: ${logPath}` }
    await delay(1000)
  }
  return { ok: false, message: `Launched bundled MySQL, but :${CONFIG.ports.mysql} did not open yet. Check ${logPath}` }
}

async function startSolr() {
  const o = await portOwner(CONFIG.ports.solr)
  if (o.listening) return { ok: false, message: `Solr already running (pid ${o.pid}).` }
  const paths = toolchainPaths()
  const dataRoot = runtimeDataRoot()
  const logPath = join(dataRoot, 'solr-launch.log')
  if (!existsSync(paths.solr)) return { ok: false, message: `Bundled Solr not found at ${paths.solr}. Run Bootstrap workspace first.` }
  await mkdir(dataRoot, { recursive: true })
  const cmd = `export JAVA_HOME="${paths.javaHome}"; export PATH="$JAVA_HOME/bin:$PATH"; exec "${paths.solr}" start -f -p ${CONFIG.ports.solr} >> "${logPath}" 2>&1`
  const r = await run('screen', ['-dmS', CONFIG.screens.solr, 'bash', '-lc', cmd])
  if (r.failed) return { ok: false, message: `Failed to launch bundled Solr: ${r.stderr || r.code}` }
  for (let i = 0; i < 30; i++) {
    const live = await probe(CONFIG.solrProbe, 3000)
    if (live.ok) return { ok: true, message: `Started bundled Solr on :${CONFIG.ports.solr}. Log: ${logPath}` }
    await delay(1000)
  }
  return { ok: false, message: `Launched bundled Solr, but :${CONFIG.ports.solr} did not respond yet. Check ${logPath}` }
}

async function stopSolr() {
  const paths = toolchainPaths()
  const killed = []
  await run(paths.solr, ['stop', '-p', String(CONFIG.ports.solr)], 30000, { JAVA_HOME: paths.javaHome, PATH: `${join(paths.javaHome, 'bin')}:${SANE_PATH}` })
  await run('screen', ['-S', CONFIG.screens.solr, '-X', 'quit'])
  await delay(1500)
  let o = await portOwner(CONFIG.ports.solr)
  if (o.listening) {
    await run('kill', [o.pid])
    killed.push(o.pid)
    await delay(1000)
    o = await portOwner(CONFIG.ports.solr)
  }
  return { ok: !o.listening, killed, message: o.listening ? `:${CONFIG.ports.solr} still held by pid ${o.pid}.` : `Stopped Solr (killed ${killed.join(', ') || 'nothing'}).` }
}

async function restartSolr() {
  const s = await stopSolr()
  await delay(800)
  const st = await startSolr()
  return { ok: st.ok, killed: s.killed, message: `${s.message}  Then: ${st.message}` }
}

async function ensurePwasRunning() {
  const results = []
  for (const app of CONFIG.pwaApps) {
    const o = await portOwner(app.port)
    if (o.listening) {
      results.push({ target: `pwa:${app.name}`, ok: true, skipped: true, message: `${app.name} already running on :${app.port} (pid ${o.pid}).` })
      continue
    }
    const r = await startPwa(app.name)
    results.push({ target: `pwa:${app.name}`, ...r })
  }
  return results
}

async function apiPrepareLocalStack(options = {}) {
  const steps = []
  const add = (target, result) => steps.push({ target, ok: !!result.ok, ...result })

  const bootstrap = await apiSetupBootstrap({ githubToken: options.githubToken || '' })
  add('bootstrap', bootstrap)

  const mysql = await startMysql()
  add('mysql', { ...mysql, ok: mysql.ok || /already running/i.test(mysql.message || '') })

  const solr = await startSolr()
  add('solr', { ...solr, ok: solr.ok || /already running/i.test(solr.message || '') })

  for (const result of await ensurePwasRunning()) add(result.target, result)

  const beforeMoqui = await apiNotNakedReadiness()
  const hardMissing = new Set(['repo-access', 'components'])
  const canStartMoqui = !beforeMoqui.missing.some((m) => hardMissing.has(m.id))
  if (canStartMoqui) {
    const moqui = await startMoqui()
    add('moqui', moqui)
  } else {
    const missing = beforeMoqui.missing.filter((m) => hardMissing.has(m.id)).map((m) => `${m.title}: ${m.detail}`).join(' | ')
    add('moqui', { ok: false, skipped: true, message: `Skipped Moqui start until real NotNaked repos/components are present. ${missing}` })
  }

  const readiness = await apiNotNakedReadiness()
  return {
    ok: steps.every((s) => s.ok || s.skipped),
    ready: readiness.ready,
    steps,
    readiness,
  }
}

async function apiResolveNotNakedWithToken(options = {}) {
  const token = String(options.githubToken || '').trim()
  if (!token) {
    return { ok: false, stage: 'token', message: 'Paste a one-time GitHub token to resolve NotNaked access.' }
  }
  const diagnostics = await apiGithubTokenDiagnostics({ githubToken: token })
  const discovery = await apiDiscoverNotNakedRepos({ githubToken: token })
  const access = await apiNotNakedAccessWithToken(token)
  const response = {
    ok: false,
    stage: 'access',
    diagnostics,
    discovery,
    access,
    proposal: discovery.proposal,
    message: '',
  }
  if (discovery.proposal?.changed && !access.ready) {
    response.stage = 'target'
    response.message = 'Discovery found a proposed target change. Review and save it, then run Resolve with token again.'
    return response
  }
  if (!access.ready) {
    response.message = `Token still cannot reach ${access.missing.map((r) => `${r.owner}/${r.repo}`).join(', ')}.`
    return response
  }
  const prepare = await apiPrepareLocalStack({ githubToken: token })
  return {
    ...response,
    ok: prepare.ok,
    stage: prepare.ready ? 'ready' : 'prepared',
    prepare,
    message: prepare.ready ? 'NotNaked target is ready.' : 'Local stack prepared; remaining readiness gates are shown below.',
  }
}

async function apiContinueSetup(options = {}) {
  const readiness = await apiNotNakedReadiness()
  if (readiness.ready) {
    return { ok: true, action: 'ready', ready: true, readiness, message: 'NotNaked target is already ready.' }
  }

  const missingIds = new Set((readiness.missing || []).map((missing) => missing.id))
  const hasHardPrivateGap = missingIds.has('repo-access') || missingIds.has('components')
  if (hasHardPrivateGap && !String(options.githubToken || '').trim()) {
    const autoImport = await apiAutoImportLocalPrivateBundle()
    if (autoImport?.ok) {
      const snapshot = await apiWriteStateSnapshot()
      return {
        ok: true,
        action: 'auto-imported-bundle',
        ready: !!autoImport.ready,
        autoImport,
        snapshot,
        readiness: autoImport.readiness || readiness,
        message: autoImport.ready
          ? `Imported local NotNaked private bundle from ${autoImport.bundle.rootPath}; local stack is ready.`
          : `Imported local NotNaked private bundle from ${autoImport.bundle.rootPath}; remaining readiness gates are shown below.`,
      }
    }
    const bundle = await apiWritePrivateBundleRequest()
    const snapshot = await apiWriteStateSnapshot()
    return {
      ok: true,
      action: 'bundle-request',
      ready: false,
      bundle,
      snapshot,
      readiness,
      message: `Private NotNaked repos/components are still missing. ${bundle.message}`,
    }
  }

  const prepare = await apiPrepareLocalStack({ githubToken: options.githubToken || '' })
  return {
    ok: prepare.ok,
    action: 'prepared',
    ready: prepare.ready,
    prepare,
    readiness: prepare.readiness,
    message: prepare.ready ? 'Local NotNaked stack is ready.' : 'Prepared all safe local services; remaining readiness gates are shown below.',
  }
}

async function apiDevkitSelfCheck() {
  return runDevkitSelfCheck({ cwd: PKG_DIR, node: process.execPath })
}

function localPrivateBundleCandidateRoots() {
  const workspace = workspaceRoot()
  const docs = join(homedir(), 'Documents')
  const downloads = join(homedir(), 'Downloads')
  const names = ['notnaked-private-bundle', 'notnaked-bundle', 'hotwax-notnaked-bundle', 'github-private', 'hotwax-private']
  return [...new Set([
    workspace,
    downloads,
    docs,
    ...names.map((name) => join(workspace, name)),
    ...names.map((name) => join(downloads, name)),
    ...names.map((name) => join(docs, name)),
  ])]
}

async function apiAutoImportLocalPrivateBundle() {
  const source = await apiSourceState()
  const missing = source.rows
    .filter((row) => row.state === 'missing')
    .map((row) => ({ owner: row.owner, repo: row.repo, path: row.path }))
  if (!missing.length) return null
  const bundle = await findCompleteLocalBundle(localPrivateBundleCandidateRoots(), missing)
  if (!bundle) return null
  const imported = await apiImportLocalTargetRoot({ rootPath: bundle.rootPath, prepareAfterImport: true })
  return {
    ok: !!imported.ok,
    ready: !!imported.ready,
    bundle,
    import: imported,
    readiness: imported.prepare?.readiness,
    message: imported.message,
  }
}

async function apiAction(target, action, options = {}) {
  if (!['start', 'stop', 'restart'].includes(action)) return { ok: false, message: `Unknown action "${action}"` }
  if (target === 'moqui') return action === 'start' ? startMoqui(options) : action === 'stop' ? stopMoqui() : restartMoqui(options)
  if (target === 'mysql') return action === 'start' ? startMysql() : { ok: false, message: 'Only Start is supported for MySQL (stop is risky — other apps share it).' }
  if (target === 'solr') return action === 'start' ? startSolr() : action === 'stop' ? stopSolr() : restartSolr()
  if (target?.startsWith('pwa:')) { const name = target.slice(4); return action === 'start' ? startPwa(name) : action === 'stop' ? stopPwa(name) : restartPwa(name) }
  return { ok: false, message: `Unknown target "${target}"` }
}

// ─── settings: the folders the dev picks (persisted; native macOS folder picker) ──
function setPath(which, p) {
  p = (p || '').trim(); if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  if (which === 'moqui') SETTINGS.moquiHome = p || undefined
  else if (which === 'accxui') SETTINGS.accxuiHome = p || undefined
  else return { ok: false, message: `Unknown setting "${which}"` }
  const saved = saveSettings(); _moquiHome = null // bust discovery cache so the change applies now
  return { ok: true, which, path: p, saved, settingsPath: SETTINGS_PATH }
}

async function pickFolder(which) {
  const label = which === 'moqui' ? 'your moqui-framework folder (the project root with gradlew and runtime, NOT moqui-runtime)'
    : 'your accxui / PWA workspace folder (the repo with apps/)'
  if (process.platform !== 'darwin') return { ok: false, message: `Native picker is macOS-only on this build (${label}).` }
  const r = await run('osascript', ['-e', `POSIX path of (choose folder with prompt "Select ${label}")`], 300000)
  if (r.failed) {
    const canceled = /cancel/i.test(r.stderr)
    return { ok: false, canceled, message: canceled ? 'Cancelled.' : `Picker failed: ${(r.stderr || '').trim()}` }
  }
  return setPath(which, r.stdout)
}

async function apiSettings() {
  const d = await discover(true)
  const root = accxuiRoot()
  return {
    moquiHome: SETTINGS.moquiHome || '', accxuiHome: SETTINGS.accxuiHome || '',
    resolvedMoquiHome: d.home || '', moquiSource: d.source, moquiValid: d.valid, moquiAdjusted: d.adjusted, moquiRaw: d.rawHome || '',
    pwaManaged: !!root, accxuiResolved: root || '',
    platform: process.platform, settingsPath: SETTINGS_PATH,
  }
}

// ─── onboarding wizard: detect the NotNaked target state and prescribe the next click ─────────
const SETUP_DB = { conf: 'mysql8', host: '127.0.0.1', port: 3306, database: 'moqui', user: 'moqui', password: 'moqui' }

async function apiSetupPlan() {
  const workspace = workspaceRoot()
  const target = await notNakedTarget()
  const [source, access, toolchains, pre, apps, mysqlConf] = await Promise.all([
    apiSourceState(),
    apiNotNakedAccess(),
    apiToolchains(),
    apiPreflight(),
    apiLocalApps(),
    configuredMysqlOk(),
  ])
  const targetPath = join(workspace, 'notnaked-target.local.json')
  const privateMissing = access.missing.filter((repo) => (target?.privateRepos || []).some((p) => p.owner === repo.owner && p.repo === repo.repo))
  const sourcePresent = source.counts.total > 0 && source.counts.missing === 0
  const realClones = sourcePresent && source.counts.archives === 0
  const mysqlOk = pre.ports.mysql.listening && mysqlConf.ok
  const pwasOk = apps.count === 5
  const moquiOk = pre.moquiLive

  const steps = [
    {
      phase: 'Target',
      id: 'workspace',
      title: 'Workspace folder',
      why: 'All HotWax, Moqui, toolchain, and PWA folders live here.',
      status: existsSync(workspace) ? 'done' : 'todo',
      detail: workspace,
      command: existsSync(workspace) ? null : `mkdir -p "${workspace}"`,
    },
    {
      phase: 'Target',
      id: 'target',
      title: 'NotNaked target definition',
      why: 'Declares the exact repos, active components, and five PWAs DevKit should prepare.',
      status: existsSync(targetPath) ? 'done' : 'todo',
      detail: existsSync(targetPath) ? targetPath : 'create or edit from Setup -> NotNaked repo access -> Edit target',
      command: existsSync(targetPath) ? null : 'Open Setup -> NotNaked repo access -> Write target override template.',
    },
    {
      phase: 'Access',
      id: 'repo-access',
      title: 'Private NotNaked repo access',
      why: 'poorti, maarg-util, and NotNaked data/setup repos are required before Moqui can run usefully.',
      status: privateMissing.length === 0 ? 'done' : 'warn',
      detail: privateMissing.length ? `missing ${privateMissing.map((r) => `${r.owner}/${r.repo}`).join(', ')}` : `${access.counts.publicOk + access.counts.privateOk}/${access.counts.public + access.counts.private} required repos present or reachable`,
      command: privateMissing.length ? 'Use Prepare with GitHub token, Import folder + prepare, or correct repo names with Edit target.' : null,
    },
    {
      phase: 'Access',
      id: 'git',
      title: 'Git / Apple Command Line Tools',
      why: 'Real clones need Git. DevKit can fetch archives as a temporary cold-start fallback.',
      status: source.gitAvailable ? 'done' : 'todo',
      detail: source.gitAvailable ? 'git clone mode available' : 'Apple Command Line Tools/Git unavailable; current sources are archive fallbacks',
      command: source.gitAvailable ? null : 'xcode-select --install; token/archive import still works before Git is available.',
    },
    {
      phase: 'Source',
      id: 'sources',
      title: 'HotWax/Moqui sources fetched',
      why: 'The NotNaked target needs public repos, private repos, and the five PWA repos in the right folder structure.',
      status: sourcePresent ? 'done' : 'todo',
      detail: `${source.counts.total - source.counts.missing}/${source.counts.total} present; ${source.counts.missing} missing`,
      command: sourcePresent ? null : 'Click Prepare with GitHub token or Bootstrap with GitHub token.',
    },
    {
      phase: 'Source',
      id: 'real-clones',
      title: 'Archive checkouts upgraded to git clones',
      why: 'The requested end state is local clones, not temporary archive folders.',
      status: realClones ? 'done' : (source.gitAvailable ? 'todo' : 'blocked'),
      detail: `${source.counts.clones} clones, ${source.counts.archives} archives, ${source.counts.missing} missing`,
      command: realClones ? null : (source.gitAvailable ? 'Click Upgrade with GitHub token.' : 'Install Apple CLT, then click Upgrade with GitHub token.'),
    },
    {
      phase: 'Services',
      id: 'toolchains',
      title: 'Bundled local toolchains',
      why: 'Cold-start setup should not require Homebrew for Java, MySQL, Solr, Node, or pnpm.',
      status: toolchains.ready ? 'done' : 'todo',
      detail: `${toolchains.counts.ok}/${toolchains.counts.total} ready`,
      command: toolchains.ready ? null : 'Click Prepare local stack.',
    },
    {
      phase: 'Services',
      id: 'mysql',
      title: 'MySQL 8 running and configured',
      why: 'Moqui must use MySQL, not H2.',
      status: mysqlOk ? 'done' : 'todo',
      detail: `${pre.ports.mysql.listening ? 'running on :3306' : 'not running'}; MoquiDevConf mysql8=${mysqlConf.ok}`,
      command: mysqlOk ? null : 'Click Prepare local stack, or open System architecture -> MySQL -> Start.',
    },
    {
      phase: 'Services',
      id: 'solr',
      title: 'Solr running',
      why: 'Search-backed OMS features need Solr available locally.',
      status: pre.solrAlive ? 'done' : 'todo',
      detail: pre.solrDetail,
      command: pre.solrAlive ? null : 'Click Prepare local stack, or open System architecture -> Solr -> Start.',
    },
    {
      phase: 'Apps',
      id: 'pwas',
      title: 'Five AccxUI PWAs running',
      why: 'Fulfillment, receiving, ATP, order-manager, and products should be available together.',
      status: pwasOk ? 'done' : 'todo',
      detail: `${apps.count || 0}/5 running`,
      command: pwasOk ? null : 'Click Prepare local stack.',
    },
    {
      phase: 'Run',
      id: 'moqui',
      title: 'Moqui running with NotNaked components',
      why: 'DevKit guards this until the real NotNaked repos/components are present.',
      status: moquiOk ? 'done' : (privateMissing.length || source.counts.missing ? 'blocked' : 'todo'),
      detail: moquiOk ? pre.moquiLiveDetail : pre.moquiLiveDetail,
      command: moquiOk ? null : (privateMissing.length || source.counts.missing ? 'Resolve missing repos, then click Prepare local stack.' : 'Click Prepare local stack.'),
    },
  ]
  const total = steps.filter((s) => s.status !== 'info').length
  const done = steps.filter((s) => s.status === 'done').length
  return { workspace, java11Home: CONFIG.java11Home, db: SETUP_DB, summary: { done, total }, steps }
}

async function apiSetupBootstrap(options = {}) {
  const workspace = process.env.HOTWAX_WORKSPACE || dirname(MOQUI_HOME_FROM_SETTINGS_OR_DEFAULT())
  const script = join(PKG_DIR, 'bootstrap-hotwax-local.mjs')
  if (!existsSync(script)) return { ok: false, message: `Bootstrap script not found at ${script}` }
  const token = String(options.githubToken || '').trim()
  const extraEnv = { HOTWAX_WORKSPACE: workspace }
  if (token) extraEnv.GITHUB_TOKEN = token
  const r = await run(process.execPath, [script], 300000, extraEnv)
  _moquiHome = null
  return {
    ok: !r.failed,
    workspace,
    tokenUsed: !!token,
    message: r.failed ? (r.stderr || r.stdout || `bootstrap failed with ${r.code}`).slice(0, 4000) : (r.stdout || 'Bootstrap complete.').trim(),
  }
}

async function apiUpgradeArchives(options = {}) {
  const before = await apiSourceState()
  if (!before.gitAvailable) {
    return {
      ok: false,
      needsGit: true,
      before,
      message: 'Apple Command Line Tools/Git are not installed yet. Run xcode-select --install, then use this action again to replace archive checkouts with real clones.',
    }
  }
  const bootstrap = await apiSetupBootstrap(options)
  const after = await apiSourceState()
  return {
    ok: bootstrap.ok && after.counts.archives === 0,
    bootstrap,
    before,
    after,
    message: bootstrap.ok
      ? `Upgrade complete: ${after.counts.clones} clones, ${after.counts.archives} archives, ${after.counts.missing} missing.`
      : bootstrap.message,
  }
}

async function apiUnblockReport() {
  const script = join(PKG_DIR, 'notnaked-unblock-report.mjs')
  if (!existsSync(script)) return { ok: false, report: '', message: `Unblock report script not found at ${script}` }
  const r = await run(process.execPath, [script], 300000, { HOTWAX_WORKSPACE: workspaceRoot() })
  return {
    ok: !r.failed,
    code: r.code,
    report: (r.stdout || r.stderr || '').trim(),
  }
}

async function apiWriteStateSnapshot() {
  const workspace = workspaceRoot()
  const path = join(workspace, 'hotwax-devkit-state.json')
  const [audit, readiness, source, toolchains, clt, apps, pwaHealth, pwaBackendConfig, plan] = await Promise.all([
    apiObjectiveAudit(),
    apiNotNakedReadiness(),
    apiSourceState(),
    apiToolchains(),
    commandLineToolsStatus(),
    apiLocalApps(),
    apiPwaHealth(),
    apiPwaBackendConfig(),
    apiSetupPlan(),
  ])
  const snapshot = {
    generatedAt: new Date().toISOString(),
    workspace,
    dashboard: `http://${CONFIG.host}:${CONFIG.port}`,
    objective: 'Blank NotNaked local setup with required Moqui components, MySQL, Solr, Java 11, and five AccxUI PWAs.',
    audit,
    readiness,
    source,
    toolchains,
    commandLineTools: clt,
    localApps: apps,
    pwaHealth,
    pwaBackendConfig,
    setupPlan: plan,
    nextActions: audit.checks.filter((check) => !check.ok).map((check) => ({ id: check.id, title: check.title, evidence: check.evidence })),
    privateRepoBundleRequest: privateRepoBundleRequestFromSource(source),
  }
  mkdirSync(workspace, { recursive: true })
  writeFileSync(path, JSON.stringify(snapshot, null, 2) + '\n')
  return {
    ok: true,
    path,
    summary: audit.summary,
    message: `Wrote DevKit state snapshot to ${path}`,
  }
}

function bundleRequestMarkdown(bundleRequest) {
  const lines = [
    '# NotNaked Private Repo Bundle Request',
    '',
    'DevKit is ready to import a private repo bundle through Setup -> NotNaked repo access -> Import local folder.',
    '',
    'Please provide a folder containing these repo folders or archives:',
    '',
  ]
  for (const repo of bundleRequest) {
    lines.push(`- ${repo.repo}`)
    lines.push(`  target: ${repo.targetPath}`)
    if (repo.reason) lines.push(`  reason: ${repo.reason}`)
    lines.push(`  accepted archive names: ${repo.acceptableArchiveNames.join(', ')}`)
  }
  lines.push(
    '',
    'After the bundle is present on this machine:',
    '',
    '1. Open DevKit at http://127.0.0.1:7070.',
    '2. Go to Setup -> NotNaked repo access.',
    '3. Click Import local folder and choose the bundle folder.',
    '',
  )
  return lines.join('\n')
}

function bundlePackScript(bundleRequest) {
  const repos = bundleRequest.map((repo) => `${repo.owner}/${repo.name}`)
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    'SRC_ROOT="${1:-$PWD}"',
    'OUT_DIR="${2:-./notnaked-private-bundle}"',
    'mkdir -p "$OUT_DIR"',
    'OUT_DIR="$(cd "$OUT_DIR" && pwd)"',
    '',
    'if command -v zip >/dev/null 2>&1; then',
    '  ARCHIVER=zip',
    'else',
    '  ARCHIVER=tar',
    'fi',
    '',
    `REPOS=(${repos.map((repo) => `"${repo}"`).join(' ')})`,
    '',
    'for full in "${REPOS[@]}"; do',
    '  owner="${full%%/*}"',
    '  repo="${full##*/}"',
    '  src=""',
    '  if [ -d "$SRC_ROOT/$repo" ]; then',
    '    src="$SRC_ROOT/$repo"',
    '  elif [ -d "$SRC_ROOT/$owner/$repo" ]; then',
    '    src="$SRC_ROOT/$owner/$repo"',
    '  fi',
    '  if [ -z "$src" ]; then',
    '    echo "missing $full under $SRC_ROOT" >&2',
    '    continue',
    '  fi',
    '  if [ "$ARCHIVER" = zip ]; then',
    '    (cd "$(dirname "$src")" && zip -qr "$OUT_DIR/$repo.zip" "$(basename "$src")")',
    '    echo "wrote $OUT_DIR/$repo.zip"',
    '  else',
    '    tar -czf "$OUT_DIR/$repo.tar.gz" -C "$(dirname "$src")" "$(basename "$src")"',
    '    echo "wrote $OUT_DIR/$repo.tar.gz"',
    '  fi',
    'done',
    '',
  ].join('\n')
}

async function apiWritePrivateBundleRequest() {
  const workspace = workspaceRoot()
  const source = await apiSourceState()
  const bundleRequest = privateRepoBundleRequestFromSource(source)
  const markdownPath = join(workspace, 'notnaked-private-bundle-request.md')
  const scriptPath = join(workspace, 'pack-notnaked-private-bundle.sh')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(markdownPath, bundleRequestMarkdown(bundleRequest))
  writeFileSync(scriptPath, bundlePackScript(bundleRequest))
  chmodSync(scriptPath, 0o755)
  return {
    ok: true,
    count: bundleRequest.length,
    markdownPath,
    scriptPath,
    bundleRequest,
    message: `Wrote private bundle request for ${bundleRequest.length} repo(s).`,
  }
}

function shQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function devkitLauncherScript() {
  const devkitDir = PKG_DIR.replace(/\/$/, '')
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    `DEVKIT_DIR=${shQuote(devkitDir)}`,
    'DASHBOARD_URL="http://127.0.0.1:7070"',
    '',
    'cd "$DEVKIT_DIR"',
    'echo "Starting HotWax DevKit..."',
    'node devkit-control.mjs restart',
    'echo "Opening $DASHBOARD_URL"',
    'open "$DASHBOARD_URL"',
    '',
  ].join('\n')
}

async function apiWriteDevKitLauncher() {
  const workspace = workspaceRoot()
  const launcherPath = join(workspace, 'Open HotWax DevKit.command')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(launcherPath, devkitLauncherScript())
  chmodSync(launcherPath, 0o755)
  return {
    ok: true,
    launcherPath,
    message: `Wrote DevKit launcher to ${launcherPath}`,
  }
}

async function apiWriteNotNakedTargetTemplate(options = {}) {
  const workspace = workspaceRoot()
  const basePath = join(PKG_DIR, 'notnaked-target.json')
  const overridePath = join(workspace, 'notnaked-target.local.json')
  if (existsSync(overridePath) && !options.force) {
    return { ok: true, exists: true, path: overridePath, message: `Target override already exists at ${overridePath}` }
  }
  const base = JSON.parse(readFileSync(basePath, 'utf8'))
  const template = {
    _note: 'Local-only DevKit override. Edit owner/repo/path/branch fields here when the canonical NotNaked repo names differ from the default manifest. Fields present in this file replace the packaged manifest fields.',
    ...base,
  }
  mkdirSync(workspace, { recursive: true })
  writeFileSync(overridePath, JSON.stringify(template, null, 2) + '\n')
  return { ok: true, exists: false, path: overridePath, message: `Wrote editable NotNaked target override at ${overridePath}` }
}

function stripTargetMetadata(target) {
  const out = { ...(target || {}) }
  delete out._basePath
  delete out._overridePath
  return out
}

function validateRepoList(target, field) {
  if (target[field] === undefined) return []
  if (!Array.isArray(target[field])) return [`${field} must be an array`]
  const errors = []
  target[field].forEach((repo, i) => {
    for (const key of ['owner', 'repo', 'branch', 'path']) {
      if (!repo || typeof repo[key] !== 'string' || !repo[key].trim()) errors.push(`${field}[${i}].${key} is required`)
    }
  })
  return errors
}

function validateComponentList(target, field) {
  if (target[field] === undefined) return []
  if (!Array.isArray(target[field])) return [`${field} must be an array`]
  const errors = []
  target[field].forEach((component, i) => {
    for (const key of ['source', 'link']) {
      if (!component || typeof component[key] !== 'string' || !component[key].trim()) errors.push(`${field}[${i}].${key} is required`)
    }
    if (component?.requires !== undefined && !Array.isArray(component.requires)) errors.push(`${field}[${i}].requires must be an array`)
  })
  return errors
}

function validateNotNakedTarget(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return ['target must be a JSON object']
  return [
    ...validateRepoList(target, 'publicRepos'),
    ...validateRepoList(target, 'optionalRepos'),
    ...validateRepoList(target, 'privateRepos'),
    ...validateRepoList(target, 'pwaApps'),
    ...validateComponentList(target, 'activeComponents'),
    ...validateComponentList(target, 'conditionalComponents'),
  ]
}

async function apiNotNakedTarget() {
  const target = await notNakedTarget()
  if (!target) return { ok: false, error: 'notnaked-target.json not found in devkit package' }
  const editable = stripTargetMetadata(target)
  const overridePath = join(workspaceRoot(), 'notnaked-target.local.json')
  return {
    ok: true,
    path: overridePath,
    exists: existsSync(overridePath),
    target: editable,
    text: JSON.stringify(editable, null, 2),
  }
}

async function apiSaveNotNakedTarget(options = {}) {
  let target
  try {
    target = typeof options.text === 'string' ? JSON.parse(options.text) : options.target
  } catch (error) {
    return { ok: false, errors: [`invalid JSON: ${error.message}`] }
  }
  target = stripTargetMetadata(target)
  const errors = validateNotNakedTarget(target)
  if (errors.length) return { ok: false, errors }
  const overridePath = join(workspaceRoot(), 'notnaked-target.local.json')
  mkdirSync(dirname(overridePath), { recursive: true })
  writeFileSync(overridePath, JSON.stringify(target, null, 2) + '\n')
  return { ok: true, path: overridePath, message: `Saved NotNaked target override at ${overridePath}` }
}

function allTargetRepos(target) {
  return [
    ...(target.publicRepos || []),
    ...(target.optionalRepos || []),
    ...(target.privateRepos || []),
    ...(target.pwaApps || []),
  ]
}

function findTargetRepo(target, key) {
  const needle = String(key || '').trim().toLowerCase()
  return allTargetRepos(target).find((repo) =>
    needle === `${repo.owner}/${repo.repo}`.toLowerCase() ||
    needle === repo.repo.toLowerCase() ||
    needle === String(repo.path || '').toLowerCase())
}

function workspaceComponentReady(source) {
  return existsSync(join(workspaceRoot(), source, 'component.xml'))
}

function linkDir(source, dest) {
  rmSync(dest, { recursive: true, force: true })
  symlinkSync(source, dest)
}

async function dirExists(path) {
  try { return (await lstat(path)).isDirectory() } catch { return false }
}

async function fileExists(path) {
  try { return (await lstat(path)).isFile() } catch { return false }
}

async function relinkReadyTargetComponents(target) {
  const moquiHome = MOQUI_HOME_FROM_SETTINGS_OR_DEFAULT()
  const componentDir = join(moquiHome, 'runtime', 'component')
  mkdirSync(componentDir, { recursive: true })
  const candidates = [
    ...(target.activeComponents || []),
    ...(target.conditionalComponents || []).filter((component) =>
      workspaceComponentReady(component.source) && (component.requires || []).every((required) => workspaceComponentReady(required))),
  ]
  const linked = []
  for (const component of candidates) {
    if (!workspaceComponentReady(component.source)) continue
    const linkName = component.link || component.source
    linkDir(join(workspaceRoot(), component.source), join(componentDir, linkName))
    linked.push(linkName)
  }
  return linked
}

async function importTargetRepoFromPath(target, repo, sourcePath, { refreshLinks = true } = {}) {
  if (await fileExists(sourcePath)) return importTargetRepoFromArchive(target, repo, sourcePath, { refreshLinks })
  const sourceReal = await realpath(sourcePath)
  const dest = join(workspaceRoot(), repo.path || repo.repo)
  let backupPath = ''
  if (existsSync(dest)) {
    const destReal = await realpath(dest).catch(() => '')
    if (destReal === sourceReal) {
      const linkedComponents = refreshLinks ? await relinkReadyTargetComponents(target) : []
      return {
        ok: true,
        imported: false,
        path: dest,
        sourcePath: sourceReal,
        linkedComponents,
        message: `${repo.owner}/${repo.repo} is already linked to ${sourceReal}${refreshLinks ? `. Refreshed ${linkedComponents.length} component link(s).` : '.'}`,
      }
    }
    if (!existsSync(join(dest, '.git'))) {
      backupPath = await backupImportFallback(dest, repo)
    } else {
      return { ok: false, imported: false, path: dest, sourcePath: sourceReal, message: `${dest} already exists as a git checkout. Move it aside before importing a different local path.` }
    }
  }
  mkdirSync(dirname(dest), { recursive: true })
  symlinkSync(sourceReal, dest)
  const linkedComponents = refreshLinks ? await relinkReadyTargetComponents(target) : []
  return {
    ok: true,
    imported: true,
    repo: `${repo.owner}/${repo.repo}`,
    path: dest,
    sourcePath: sourceReal,
    backupPath,
    linkedComponents,
    message: `Linked ${repo.owner}/${repo.repo} to ${dest}${backupPath ? ` and backed up the previous local fallback to ${backupPath}` : ''}.`,
  }
}

const ARCHIVE_EXTENSIONS = ['.zip', '.tar.gz', '.tgz', '.tar.bz2', '.tbz2', '.tar.xz', '.txz', '.tar']

function isSupportedArchive(path) {
  const lower = String(path || '').toLowerCase()
  return ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

function archiveCandidatePaths(root, repo) {
  const path = repo.path || repo.repo
  const bases = [
    join(root, path),
    join(root, repo.repo),
    join(root, repo.owner, repo.repo),
    join(root, `${repo.owner}-${repo.repo}`),
  ]
  return [...new Set(bases.flatMap((base) => ARCHIVE_EXTENSIONS.map((ext) => `${base}${ext}`)))]
}

async function backupImportFallback(dest, repo) {
  const backupDir = join(workspaceRoot(), '.archive-backups')
  mkdirSync(backupDir, { recursive: true })
  const backupPath = join(backupDir, `${(repo.path || repo.repo).replaceAll('/', '__')}-import-${Date.now()}`)
  await rename(dest, backupPath)
  return backupPath
}

async function extractedArchiveRoot(tempDir) {
  const names = (await readdir(tempDir)).filter((name) => name !== '__MACOSX' && name !== '.DS_Store')
  if (names.length === 1 && await dirExists(join(tempDir, names[0]))) return join(tempDir, names[0])
  return tempDir
}

async function importTargetRepoFromArchive(target, repo, archivePath, { refreshLinks = true } = {}) {
  if (!isSupportedArchive(archivePath)) return { ok: false, imported: false, archivePath, message: `Unsupported archive type: ${archivePath}` }
  const archiveReal = await realpath(archivePath)
  const dest = join(workspaceRoot(), repo.path || repo.repo)
  let backupPath = ''
  if (existsSync(dest)) {
    if (existsSync(join(dest, '.git'))) return { ok: false, imported: false, path: dest, archivePath: archiveReal, message: `${dest} already exists as a git checkout. Move it aside before importing archive ${archiveReal}.` }
    backupPath = await backupImportFallback(dest, repo)
  }

  const tempParent = join(workspaceRoot(), '.devkit-imports')
  const tempDir = join(tempParent, `${repo.repo}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tempDir, { recursive: true })
  const lower = archiveReal.toLowerCase()
  const extract = lower.endsWith('.zip')
    ? await run('unzip', ['-q', archiveReal, '-d', tempDir], 120000)
    : await run('tar', ['-xf', archiveReal, '-C', tempDir], 120000)
  if (extract.failed) {
    rmSync(tempDir, { recursive: true, force: true })
    if (backupPath && !existsSync(dest)) await rename(backupPath, dest)
    return { ok: false, imported: false, archivePath: archiveReal, backupPath, message: `Could not extract ${archiveReal}: ${(extract.stderr || extract.stdout || '').trim()}` }
  }
  const extractedRoot = await extractedArchiveRoot(tempDir)
  mkdirSync(dirname(dest), { recursive: true })
  await rename(extractedRoot, dest)
  if (extractedRoot !== tempDir) rmSync(tempDir, { recursive: true, force: true })
  const linkedComponents = refreshLinks ? await relinkReadyTargetComponents(target) : []
  return {
    ok: true,
    imported: true,
    archiveImported: true,
    repo: `${repo.owner}/${repo.repo}`,
    path: dest,
    archivePath: archiveReal,
    backupPath,
    linkedComponents,
    message: `Extracted ${repo.owner}/${repo.repo} archive to ${dest}${backupPath ? ` and backed up the previous local fallback to ${backupPath}` : ''}.`,
  }
}

async function apiImportLocalTargetRepo(options = {}) {
  const target = await notNakedTarget()
  if (!target) return { ok: false, message: 'notnaked-target.json not found in devkit package' }
  const repo = findTargetRepo(target, options.key)
  if (!repo) return { ok: false, message: `No target repo matches "${options.key || ''}". Use owner/repo, repo name, or target path.` }
  const sourcePath = expandLocalPath(options.sourcePath)
  if (!sourcePath || !existsSync(sourcePath)) return { ok: false, message: `Source path not found: ${sourcePath || '(empty)'}` }
  return importTargetRepoFromPath(target, repo, sourcePath)
}

function localRepoCandidatePaths(root, repo) {
  const path = repo.path || repo.repo
  return [...new Set([
    join(root, path),
    join(root, repo.repo),
    join(root, repo.owner, repo.repo),
    join(root, `${repo.owner}-${repo.repo}`),
  ])]
}

async function apiImportLocalTargetRoot(options = {}) {
  const target = await notNakedTarget()
  if (!target) return { ok: false, message: 'notnaked-target.json not found in devkit package' }
  const root = expandLocalPath(options.rootPath)
  if (!root || !(await dirExists(root))) return { ok: false, message: `Local repo root not found: ${root || '(empty)'}` }
  const rows = []
  for (const repo of allTargetRepos(target)) {
    const candidates = localRepoCandidatePaths(root, repo)
    let sourcePath = null
    for (const candidate of candidates) {
      if (await dirExists(candidate)) { sourcePath = candidate; break }
    }
    const archiveCandidates = archiveCandidatePaths(root, repo)
    let archivePath = null
    if (!sourcePath) {
      for (const candidate of archiveCandidates) {
        if (await fileExists(candidate)) { archivePath = candidate; break }
      }
    }
    if (!sourcePath && !archivePath) {
      rows.push({ repo: `${repo.owner}/${repo.repo}`, targetPath: repo.path || repo.repo, ok: false, imported: false, state: 'not_found', candidates: [...candidates, ...archiveCandidates] })
      continue
    }
    const result = archivePath
      ? await importTargetRepoFromArchive(target, repo, archivePath, { refreshLinks: false })
      : await importTargetRepoFromPath(target, repo, sourcePath, { refreshLinks: false })
    rows.push({ repo: `${repo.owner}/${repo.repo}`, targetPath: repo.path || repo.repo, state: result.ok ? (result.archiveImported ? 'archive_imported' : (result.imported ? 'imported' : 'already_linked')) : 'skipped', ...result })
  }
  const linkedComponents = await relinkReadyTargetComponents(target)
  const response = {
    ok: rows.some((row) => row.ok),
    rootPath: await realpath(root),
    counts: {
      imported: rows.filter((row) => row.imported).length,
      archiveImported: rows.filter((row) => row.archiveImported).length,
      alreadyLinked: rows.filter((row) => row.ok && !row.imported).length,
      skipped: rows.filter((row) => row.state === 'skipped').length,
      notFound: rows.filter((row) => row.state === 'not_found').length,
    },
    rows,
    linkedComponents,
    message: `Imported ${rows.filter((row) => row.imported).length} target repo(s), confirmed ${rows.filter((row) => row.ok && !row.imported).length}, refreshed ${linkedComponents.length} component link(s).`,
  }
  if (options.prepareAfterImport) {
    response.prepare = await apiPrepareLocalStack({ githubToken: options.githubToken || '' })
    response.ready = response.prepare.ready
    response.message += response.prepare.ready
      ? ' Local stack is ready.'
      : ' Local stack prepare ran; remaining readiness gates are shown in prepare.readiness.'
  }
  return response
}

function discoveryTerms(target) {
  const terms = new Set(['poorti', 'maarg-util', 'maarg util', 'notnaked', 'not naked', 'ofbiz-oms-udm', 'ofbiz oms udm'])
  for (const repo of target?.privateRepos || []) {
    if (repo.repo) terms.add(repo.repo)
    if (repo.path) terms.add(repo.path)
  }
  return [...terms]
}

async function searchGithubRepos(term, token) {
  const q = `org:hotwax ${term}`.trim()
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=8`
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined
  try {
    const res = await fetch(url, { headers })
    const body = await res.json().catch(() => ({}))
    return {
      term,
      ok: res.ok,
      status: res.status,
      message: body.message || '',
      total: body.total_count || 0,
      repos: (body.items || []).map((repo) => ({
        fullName: repo.full_name,
        owner: repo.owner?.login,
        repo: repo.name,
        private: !!repo.private,
        defaultBranch: repo.default_branch,
        htmlUrl: repo.html_url,
        description: repo.description || '',
      })),
    }
  } catch (error) {
    return { term, ok: false, status: 'network', message: error.message, total: 0, repos: [] }
  }
}

async function apiDiscoverNotNakedRepos(options = {}) {
  const token = String(options.githubToken || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim()
  const target = await notNakedTarget()
  if (!target) return { ok: false, error: 'notnaked-target.json not found in devkit package' }
  const results = await Promise.all(discoveryTerms(target).map((term) => searchGithubRepos(term, token)))
  const byFullName = new Map()
  for (const result of results) {
    for (const repo of result.repos) {
      const prior = byFullName.get(repo.fullName) || { ...repo, matchedTerms: [] }
      prior.matchedTerms.push(result.term)
      byFullName.set(repo.fullName, prior)
    }
  }
  const suggestions = [...byFullName.values()].sort((a, b) => b.matchedTerms.length - a.matchedTerms.length || a.fullName.localeCompare(b.fullName))
  const proposal = buildTargetProposal(target, suggestions)
  return {
    ok: results.some((r) => r.ok),
    tokenPresent: !!token,
    results,
    suggestions,
    proposal,
    message: suggestions.length
      ? `Found ${suggestions.length} candidate HotWax repos.`
      : 'No candidate HotWax repos found. The token may not have access, or the repos may use unrelated names.',
  }
}

function normalizeRepoName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function bestRepoMatch(repo, suggestions) {
  const wanted = new Set([repo.repo, repo.path].map(normalizeRepoName).filter(Boolean))
  const exact = suggestions.filter((s) => wanted.has(normalizeRepoName(s.repo)))
  if (exact.length === 1) return { repo: exact[0], confidence: 'exact' }
  if (exact.length > 1) return { repo: exact.sort((a, b) => b.matchedTerms.length - a.matchedTerms.length)[0], confidence: 'ambiguous-exact' }
  const strong = suggestions.filter((s) => (s.matchedTerms || []).some((term) => wanted.has(normalizeRepoName(term))))
  if (strong.length === 1) return { repo: strong[0], confidence: 'strong' }
  return null
}

function buildTargetProposal(target, suggestions) {
  const proposedTarget = stripTargetMetadata(target)
  const changes = []
  proposedTarget.privateRepos = (proposedTarget.privateRepos || []).map((repo) => {
    const match = bestRepoMatch(repo, suggestions)
    if (!match) return repo
    const next = {
      ...repo,
      owner: match.repo.owner || repo.owner,
      repo: match.repo.repo || repo.repo,
      branch: match.repo.defaultBranch || repo.branch || 'main',
      path: repo.path || match.repo.repo,
    }
    if (next.owner !== repo.owner || next.repo !== repo.repo || next.branch !== repo.branch) {
      changes.push({
        from: `${repo.owner}/${repo.repo}#${repo.branch || 'main'}`,
        to: `${next.owner}/${next.repo}#${next.branch}`,
        path: next.path,
        confidence: match.confidence,
        matchedTerms: match.repo.matchedTerms || [],
      })
    }
    return next
  })
  return {
    changed: changes.length > 0,
    changes,
    target: proposedTarget,
    text: JSON.stringify(proposedTarget, null, 2),
  }
}

async function apiInstallCommandLineTools() {
  if (process.platform !== 'darwin') {
    return { ok: false, message: 'Apple Command Line Tools installer is only available on macOS.' }
  }
  const existing = await run('xcode-select', ['-p'])
  if (!existing.failed) return { ok: true, installed: true, status: await commandLineToolsStatus(), message: `Apple Command Line Tools already installed at ${existing.stdout.trim()}.` }
  const r = await run('xcode-select', ['--install'], 10000)
  const out = (r.stderr || r.stdout || '').trim()
  const alreadyRequested = /install requested|already installed|software update/i.test(out)
  return {
    ok: !r.failed || alreadyRequested,
    installed: false,
    status: await commandLineToolsStatus(),
    message: alreadyRequested ? 'Apple Command Line Tools installer is already open or requested.' : (out || 'Apple Command Line Tools installer requested. Follow the macOS dialog, then return to devkit.'),
  }
}

function MOQUI_HOME_FROM_SETTINGS_OR_DEFAULT() {
  return ((SETTINGS.moquiHome || '').trim() || CONFIG.moquiHome || join(workspaceRoot(), 'moqui-framework'))
}

// ─── HTTP server ──────────────────────────────────────────────────────────────
const ROUTES = {
  '/api/discover': apiDiscover,
  '/api/preflight': apiPreflight,
  '/api/toolchains': apiToolchains,
  '/api/notnaked/access': apiNotNakedAccess,
  '/api/notnaked/target': apiNotNakedTarget,
  '/api/notnaked/readiness': apiNotNakedReadiness,
  '/api/objective-audit': apiObjectiveAudit,
  '/api/source-state': apiSourceState,
  '/api/config': apiConfig,
  '/api/components': apiComponents,
  '/api/status': apiStatus,
  '/api/diagnose': apiDiagnose,
  '/api/topology': apiTopology,
  '/api/local-apps': apiLocalApps,
  '/api/pwa-health': apiPwaHealth,
  '/api/pwa-backend-config': apiPwaBackendConfig,
  '/api/pwa-data-verification': apiPwaDataVerification,
  '/api/devkit/self-check': apiDevkitSelfCheck,
  '/api/setup/plan': apiSetupPlan,
  '/api/setup/clt-status': commandLineToolsStatus,
  '/api/unblock-report': apiUnblockReport,
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${CONFIG.host}:${CONFIG.port}`)
    const path = url.pathname
    const sendJson = (data) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)) }

    if (path === '/' || path === '/index.html') {
      const html = await readFile(join(PKG_DIR, 'moqui-console.html'), 'utf8')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(html)
    }
    if (req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += chunk
      let p = {}; try { p = JSON.parse(body || '{}') } catch { /* ignore */ }
      if (path === '/api/action') return sendJson(await apiAction(p.target, p.action, p.options || {}))
      if (path === '/api/setup/bootstrap') return sendJson(await apiSetupBootstrap(p.options || {}))
      if (path === '/api/setup/continue') return sendJson(await apiContinueSetup(p.options || {}))
      if (path === '/api/setup/upgrade-archives') return sendJson(await apiUpgradeArchives(p.options || {}))
      if (path === '/api/setup/install-clt') return sendJson(await apiInstallCommandLineTools())
      if (path === '/api/setup/prepare-local-stack') return sendJson(await apiPrepareLocalStack(p.options || {}))
      if (path === '/api/notnaked/resolve-with-token') return sendJson(await apiResolveNotNakedWithToken(p.options || {}))
      if (path === '/api/state-snapshot') return sendJson(await apiWriteStateSnapshot())
      if (path === '/api/notnaked/access-check') return sendJson(await apiNotNakedAccessWithToken(String(p.options?.githubToken || '').trim()))
      if (path === '/api/github/token-diagnostics') return sendJson(await apiGithubTokenDiagnostics(p.options || {}))
      if (path === '/api/notnaked/discover-repos') return sendJson(await apiDiscoverNotNakedRepos(p.options || {}))
      if (path === '/api/notnaked/write-target-template') return sendJson(await apiWriteNotNakedTargetTemplate(p.options || {}))
      if (path === '/api/notnaked/target') return sendJson(await apiSaveNotNakedTarget(p.options || {}))
      if (path === '/api/notnaked/import-local') return sendJson(await apiImportLocalTargetRepo(p.options || {}))
      if (path === '/api/notnaked/import-local-root') return sendJson(await apiImportLocalTargetRoot(p.options || {}))
      if (path === '/api/notnaked/private-bundle-request') return sendJson(await apiWritePrivateBundleRequest())
      if (path === '/api/devkit/launcher') return sendJson(await apiWriteDevKitLauncher())
      if (path === '/api/pwa-backend-config') return sendJson(await apiWritePwaBackendConfig(p.options || {}))
      if (path === '/api/pick-folder') return sendJson(await pickFolder(p.which))
      if (path === '/api/settings') return sendJson(setPath(p.which, p.path))
    }
    if (path === '/api/settings') return sendJson(await apiSettings())
    if (path === '/api/expectations') return sendJson(await apiExpectations(url.searchParams.get('set') || undefined))
    if (path === '/api/logs') return sendJson(await apiLogs(Math.min(parseInt(url.searchParams.get('kb') || '64', 10) || 64, 512)))
    if (ROUTES[path]) return sendJson(await ROUTES[path]())

    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: String(e?.stack || e) }))
  }
})

server.listen(CONFIG.port, CONFIG.host, () => {
  const root = accxuiRoot()
  console.log(`\n  moqui-console (hotwax/devkit)  →  http://${CONFIG.host}:${CONFIG.port}   (localhost only; Start/Stop/Restart enabled)`)
  console.log(`  mode: ${root ? 'PWA workspace ' + root : 'Moqui-only (pick your folders in Setup ⚙)'}`)
  discover(true).then((d) => {
    if (d.home) console.log(`  MOQUI_HOME = ${d.home}  (via ${d.source}${d.pid ? ', pid ' + d.pid : ''})\n`)
    else console.log('  No Moqui found — open http://127.0.0.1:7070, click Setup ⚙, and pick your Moqui project folder.\n')
  })
})
