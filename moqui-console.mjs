#!/usr/bin/env node
// moqui-console — a lightweight, LOCAL-ONLY dev cockpit for bare-metal Moqui + (optionally) its PWAs.
// Part of hotwax/devkit. Run it from anywhere with no install:
//
//   npx github:hotwax/devkit            # from your Moqui checkout or PWA workspace
//   node moqui-console.mjs              # if you have the file locally
//
// It self-locates MOQUI_HOME (the running Moqui process, your current directory if it's inside a
// checkout, $MOQUI_HOME, or a run script), then serves a dashboard at http://127.0.0.1:7070:
//   preflight (Java 21, ports, MySQL/Solr, liveness) · effective config (MoquiActualConf.xml) ·
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
import { readFile, open, readdir, lstat, readlink, realpath, mkdir, mkdtemp, rename, unlink, stat, rm, copyFile, writeFile } from 'node:fs/promises'
import { existsSync, openSync, writeFileSync, readFileSync, mkdirSync, createWriteStream, writeSync, closeSync } from 'node:fs'
import { join, dirname, basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, tmpdir } from 'node:os'
import { configureMysqlDatasource } from './lib/bootstrap-config.mjs'
import { processBelongsToWorkspace, solrBootstrapJavaArgs } from './lib/bootstrap-process.mjs'
import {
  buildEntityExportForm,
  getRemoteEntityProfile,
  inspectMoquiEntityLoadLog,
  keychainPasswordArgs,
  moquiEntityLoadArgs,
  normalizeHotwaxSource,
  remoteEntityEndpoints,
  remoteEntityProfiles,
  remoteEntityResetSql,
  saveEntityExportResponse,
  sanitizeExcludedEntityReferences,
  splitEntityExportForLoad,
} from './lib/remote-entity-import.mjs'

// ─── CONFIG (env-overridable defaults; per-project override via devkit.config.json) ──────────
const CONFIG = {
  host: '127.0.0.1',
  port: Number(process.env.MOQUI_CONSOLE_PORT || process.env.PORT) || 7070,
  // Moqui framework currently compiles with Java 21. Keep the legacy key so existing
  // devkit.config.json files continue to work, but prefer JAVA_HOME/JAVA21_HOME.
  java11Home: process.env.JAVA_HOME || process.env.JAVA21_HOME || process.env.JAVA11_HOME || '/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home',
  ports: { moqui: 8080, mysql: 3306, solr: 8983, elasticsearch: 9200 },
  moquiLiveness: 'http://localhost:8080/rest/s1/admin/checkLoginOptions',
  solrProbe: 'http://localhost:8983/solr/',              // 401 here still means "Solr is alive"
  // MOQUI_HOME is normally auto-discovered; these are explicit fallbacks (empty = rely on discovery).
  moquiHome: process.env.MOQUI_HOME || '',
  moquiRunScript: process.env.MOQUI_RUN_SCRIPT || '',     // optional: a script that cd's in + `gradlew run`
  screens: { moqui: 'moqui', solr: 'moqui-solr' },        // detached GNU screen session names this tool creates
  expectedComponentSet: 'oms-suite',                      // per maarg-docker-config local-setup doc
  envsDir: process.env.MOQUI_ENVS_DIR || join(homedir(), 'moqui-envs'), // where cloned environments live
  // HotWax PWA conventions (only used when a PWA workspace is detected in the working dir).
  // `dir` is relative to your working dir; `filter` (pnpm workspace name) or `prefix` (path) launches dev.
  pwaApps: [
    { name: 'bopis', port: 8100, dir: 'apps/bopis' },
    { name: 'fulfillment', port: 8101, dir: 'apps/fulfillment' },
    { name: 'receiving', port: 8102, dir: 'apps/receiving' },
    { name: 'available-to-promise', port: 8103, dir: 'apps/available-to-promise' },
    { name: 'order-routing-rules', port: 8104, dir: 'apps/order-routing' },
    { name: 'job-manager', port: 8105, dir: 'apps/job-manager' },
    { name: 'order-manager', port: 8106, dir: 'apps/order-manager' },
    { name: 'products', port: 8107, dir: 'apps/products' },
  ],
}

const PKG_DIR = fileURLToPath(new URL('.', import.meta.url)) // where this script + .html live (npm cache under npx)
const CWD = process.cwd()                                    // where the dev invoked us (their project / checkout)
const SANE_PATH = '/usr/sbin:/usr/bin:/bin:/sbin:/opt/homebrew/bin:' + (process.env.PATH || '')
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

// This build's version (from package.json next to the script). Used by the freshness check.
const VERSION = (() => { try { return JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')).version || '0.0.0' } catch { return '0.0.0' } })()
const UPDATE_CMD = 'rm -rf ~/.npm/_npx && npx github:hotwax/devkit'

// Freshness check: compare this build to main's package.json version. npx caches github: specs by
// name and won't re-fetch new commits, so a cached clone runs old code silently — this makes it loud.
// Cached for an hour; silent when current, offline, or unparseable. (Releases must bump the version.)
let _ver = null, _verAt = 0
function semverBehind(cur, latest) {
  const a = String(cur).split('.').map((n) => parseInt(n, 10) || 0)
  const b = String(latest).split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) { if ((b[i] || 0) > (a[i] || 0)) return true; if ((b[i] || 0) < (a[i] || 0)) return false }
  return false
}
async function checkVersion(force = false) {
  if (_ver && !force && Date.now() - _verAt < 3600000) return _ver
  let latest = null
  try {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 2500)
    const r = await fetch('https://raw.githubusercontent.com/hotwax/devkit/main/package.json', { signal: ac.signal })
    clearTimeout(t)
    if (r.ok) latest = (await r.json()).version
  } catch { /* offline / timeout — stay silent */ }
  _ver = { current: VERSION, latest, stale: !!(latest && semverBehind(VERSION, latest)), updateCmd: UPDATE_CMD }
  _verAt = Date.now()
  return _ver
}

// Per-project overrides: a devkit.config.json in the working dir wins over the defaults above.
try { Object.assign(CONFIG, JSON.parse(readFileSync(join(CWD, 'devkit.config.json'), 'utf8'))) } catch { /* none */ }
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
    return { ok: false, error: e.code || e.name || String(e) }
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

async function moquiWarPid() {
  const ps = await run('ps', ['-ax', '-o', 'pid=,command='])
  for (const line of ps.stdout.split('\n')) {
    if (line.includes('-jar moqui.war')) { const m = line.trim().match(/^(\d+)/); if (m) return m[1] }
  }
  return null
}

const pwaApp = (name) => CONFIG.pwaApps.find((a) => a.name === name)
const pwaDir = (a, root) => (a.dir ? (a.dir.startsWith('/') ? a.dir : join(root || CWD, a.dir)) : null)

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
  // Multi-environment: map to a running instance for the active http port + pid. An explicitly-pinned
  // port (SETTINGS.moquiPort) selects the whole environment — home included — overriding discovery.
  const instances = await discoverInstances()
  let inst = null
  if (SETTINGS.moquiPort) inst = instances.find((i) => i.port === Number(SETTINGS.moquiPort))
  if (!inst) inst = instances.find((i) => samePath(i.home, home))
  if (!inst && !home && instances.length) inst = instances[0]
  let httpPort = CONFIG.ports.moqui
  if (inst) {
    httpPort = inst.port; pid = inst.pid
    if (SETTINGS.moquiPort && !samePath(inst.home, home)) {     // pinned env wins over the discovered home
      source = 'env-pinned'; rawHome = inst.home
      try { home = await realpath(inst.home) } catch { home = inst.home }
      const resolved = resolveMoquiHome(home)
      if (resolved !== home) { adjusted = true; try { home = await realpath(resolved) } catch { home = resolved } }
      valid = looksLikeMoquiHome(home)
    }
  } else if (home) {
    const byConf = await readHttpPort(home); if (byConf) httpPort = byConf   // not running — read its conf
  }
  _moquiHome = { pid, home, source, valid, rawHome, adjusted, httpPort, instanceCount: instances.length }
  return _moquiHome
}

async function readHttpPort(home) {
  if (!home) return null
  try {
    const xml = await readFile(join(home, 'runtime', 'log', 'MoquiActualConf.xml'), 'utf8')
    const m = xml.match(/<default-property\s+name="webapp_http_port"\s+value="(\d+)"/)
    if (m) return Number(m[1])
  } catch { /* not run yet */ }
  return null
}

// All running Moqui instances on this box: {pid, port, home}. Lets devkit target a chosen environment
// when more than one Moqui is up (e.g. :8080 and :8081) instead of silently picking the first.
async function discoverInstances() {
  const listening = await listeningTcpPorts()
  const out = [], seen = new Set()
  for (const p of listening) {
    if (p.port < 8080 || p.port > 8099) continue       // Moqui http ports; excludes the 8025 sidecar
    if (!/java/i.test(p.command || '')) continue
    if (seen.has(p.port)) continue
    const home = await pidCwd(p.pid)
    if (!home || !looksLikeMoquiHome(home)) continue
    seen.add(p.port); out.push({ pid: p.pid, port: p.port, home })
  }
  out.sort((a, b) => a.port - b.port)
  return out
}
const samePath = (a, b) => !!a && !!b && a.replace(/\/$/, '') === b.replace(/\/$/, '')
const moquiLivenessUrl = (port) => `http://localhost:${port || CONFIG.ports.moqui}/rest/s1/admin/checkLoginOptions`

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
  const mport = (await discover()).httpPort || CONFIG.ports.moqui
  const [java11, bareJava, moqui, mysql, solr, es, live, solrProbe] = await Promise.all([
    run(CONFIG.java11, ['-version']),
    run('java', ['-version'], 6000, { PATH: process.env.PATH || '' }), // use the launching shell's real PATH, not SANE_PATH (which forces /usr/bin's Apple stub first)
    portOwner(mport),
    portOwner(CONFIG.ports.mysql),
    portOwner(CONFIG.ports.solr),
    portOwner(CONFIG.ports.elasticsearch),
    probe(moquiLivenessUrl(mport)),
    probe(CONFIG.solrProbe),
  ])
  const java11Ver = (java11.stderr || java11.stdout).split('\n')[0] || ''
  return {
    java11: { ok: !java11.failed, detail: java11.failed ? 'Java 21 not found at ' + CONFIG.java11 + ' (set JAVA_HOME or JAVA21_HOME)' : java11Ver },
    bareJava: { ok: !bareJava.failed, detail: bareJava.failed ? 'bare `java` not on PATH (fine — the run script / JAVA_HOME handles it)' : (bareJava.stderr || '').split('\n')[0] },
    ports: {
      moqui: { ...moqui, expected: mport },
      mysql: { ...mysql, expected: CONFIG.ports.mysql },
      solr: { ...solr, expected: CONFIG.ports.solr },
      elasticsearch: { ...es, expected: CONFIG.ports.elasticsearch },
    },
    moquiLive: live.ok && live.status === 200,
    moquiLiveDetail: live.ok ? `HTTP ${live.status}` : `unreachable (${live.error})`,
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
    search: {
      elasticsearchUrl: props.elasticsearch_url || '', elasticsearchPrefix: props.elasticsearch_index_prefix || '',
      solrAdminUrl: props['solr.admin.url'] || '', solrCollection: props['solr.default.collection'] || props['solr.shared.core.name'] || '',
    },
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
  for (const name of names.sort()) {
    if (name === 'README' || name.startsWith('.')) continue
    const full = join(dir, name)
    let target = null, isLink = false
    try { const st = await lstat(full); isLink = st.isSymbolicLink(); if (isLink) target = await readlink(full) } catch { /* ignore */ }
    // one `git status -b --porcelain` gives the current branch AND the uncommitted-change state
    const g = await run('git', ['-C', full, 'status', '-b', '--porcelain=v1'])
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

  if (!pre.java11.ok) add('error', 'Java 21 not found', `${CONFIG.java11} did not run.`, 'brew install openjdk@21  (or set JAVA_HOME / JAVA21_HOME)')
  else if (!pre.bareJava.ok) add('info', 'Java 21 present but not on PATH', 'Fine — DevKit sets JAVA_HOME for managed commands.')

  if (!pre.ports.mysql.listening) add('error', 'MySQL is down', `Moqui expects MySQL on ${CONFIG.ports.mysql} (db ${cfg.db?.database}, user ${cfg.db?.user}).`, 'brew services start mysql')
  if (!pre.solrAlive) add('warn', 'Solr is not responding on 8983', 'Search-backed APIs will fail.')
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
      n('solr', 'Solr', pre.solrAlive ? 'up' : 'down', pre.solrDetail, { port: 8983, url: pre.solrAlive ? 'http://localhost:8983/solr/' : undefined }),
      n('es', 'ElasticSearch', pre.ports.elasticsearch.listening ? 'up' : 'info',
        pre.ports.elasticsearch.listening ? ':9200' : 'configured but not running (expected if you use Solr)', { port: 9200, url: pre.ports.elasticsearch.listening ? 'http://localhost:9200' : undefined }),
    ] },
    { id: 'jvm', label: 'Java 21 JVM · foundation', nodes: [
      n('jvm', 'Java 21', pre.java11.ok ? (procUp ? 'up' : 'info') : 'down',
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
  const d = await discover()
  const mport = d.httpPort || CONFIG.ports.moqui
  const [moqui, live, version] = await Promise.all([portOwner(mport), probe(moquiLivenessUrl(mport), 3000), checkVersion()])
  return { moquiHome: d.home, pid: d.pid, source: d.source, valid: d.valid, adjusted: d.adjusted, rawHome: d.rawHome, moquiPort: mport, instanceCount: d.instanceCount, moquiLive: live.ok && live.status === 200, port8080: moqui.listening, version }
}

// ─── write endpoints: guarded lifecycle (localhost only) ──────────────────────

const moquiScreen = (port) => (port === CONFIG.ports.moqui ? CONFIG.screens.moqui : `${CONFIG.screens.moqui}-${port}`)

async function startMoqui() {
  const d = await discover(true)
  const mport = d.httpPort || CONFIG.ports.moqui
  const screen = moquiScreen(mport)
  const o = await portOwner(mport)
  if (o.listening) return { ok: false, message: `Moqui already running (pid ${o.pid} on :${mport}).` }
  // A run script only applies to the default env; a non-default env always starts from its own home.
  if (CONFIG.moquiRunScript && existsSync(CONFIG.moquiRunScript) && mport === CONFIG.ports.moqui) {
    const r = await run('screen', ['-dmS', screen, 'bash', CONFIG.moquiRunScript])
    if (r.failed) return { ok: false, message: `Failed to launch screen: ${r.stderr || r.code}` }
    return { ok: true, message: `Launched Moqui in screen "${screen}" via the run script. Booting (~60s) — watch the status dot.` }
  }
  if (!d.home) return { ok: false, message: 'No MOQUI_HOME found — set MOQUI_HOME or run from inside the checkout.' }
  const cmd = `cd ${d.home} && export JAVA_HOME=${CONFIG.java11Home} && export PATH="$JAVA_HOME/bin:$PATH" && exec ./gradlew run >> runtime/log/moqui-console.log 2>&1`
  const r = await run('screen', ['-dmS', screen, 'bash', '-c', cmd])
  if (r.failed) return { ok: false, message: `Failed to launch: ${r.stderr || r.code}` }
  return { ok: true, message: `Launched Moqui (gradlew run) from ${d.home} in screen "${screen}". Booting (~60s).` }
}

async function stopMoqui() {
  const d = await discover()
  const mport = d.httpPort || CONFIG.ports.moqui
  const screen = moquiScreen(mport)
  const killed = []
  await run('screen', ['-S', screen, '-X', 'quit'])
  // Kill the JVM that actually owns the active port (correct even with several Moqui instances up),
  // falling back to the discovered pid. Never a blanket moqui.war kill — that could hit another env.
  let o = await portOwner(mport)
  const target = o.listening ? o.pid : d.pid
  if (target) { await run('kill', [target]); killed.push({ pid: target, what: `moqui.war JVM (:${mport})` }) }
  await delay(1500)
  o = await portOwner(mport)
  if (o.listening) { // an orphan (e.g. GradleDaemon) still holds the port — kill exactly that PID
    await run('kill', [o.pid]); killed.push({ pid: o.pid, what: `${o.command} (held :${mport})` })
    await delay(1000); o = await portOwner(mport)
  }
  return { ok: !o.listening, killed, message: o.listening ? `:${mport} still held by pid ${o.pid} (${o.command}) — kill manually.` : `Stopped Moqui on :${mport}. Killed ${killed.map((k) => k.pid).join(', ') || 'nothing'}.` }
}

async function stopWorkspaceSolr(root) {
  let owner = await portOwner(CONFIG.ports.solr)
  if (!owner.listening) return { ok: true, skipped: true, message: `No Solr process is listening on :${CONFIG.ports.solr}.` }
  if (!owner.pid) return { ok: false, message: `Solr is listening on :${CONFIG.ports.solr}, but its PID could not be identified.` }

  const [cwd, command] = await Promise.all([pidCwd(owner.pid), pidArgs(owner.pid)])
  if (!processBelongsToWorkspace({ cwd, command }, root)) {
    return { ok: false, message: `Refusing to stop unrelated process ${owner.pid} on :${CONFIG.ports.solr} (cwd ${cwd || 'unknown'}).` }
  }

  const targetPid = owner.pid
  await run('kill', ['-TERM', targetPid])
  for (let i = 0; i < 20; i++) {
    await delay(500)
    owner = await portOwner(CONFIG.ports.solr)
    if (!owner.listening) return { ok: true, message: `Stopped workspace Solr process ${targetPid} on :${CONFIG.ports.solr}.` }
    if (owner.pid !== targetPid) return { ok: false, message: `A different process ${owner.pid} took :${CONFIG.ports.solr} while stopping Solr.` }
  }

  await run('kill', ['-KILL', targetPid])
  await delay(500)
  owner = await portOwner(CONFIG.ports.solr)
  return owner.listening
    ? { ok: false, message: `Workspace Solr process ${targetPid} would not release :${CONFIG.ports.solr}.` }
    : { ok: true, message: `Force-stopped workspace Solr process ${targetPid} on :${CONFIG.ports.solr}.` }
}

async function restartMoqui() {
  const mport = (await discover()).httpPort || CONFIG.ports.moqui
  const s = await stopMoqui()
  for (let i = 0; i < 12; i++) { const o = await portOwner(mport); if (!o.listening) break; await delay(1000) }
  const st = await startMoqui()
  return { ok: st.ok, killed: s.killed, message: `${s.message}  Then: ${st.message}` }
}

async function startPwa(name) {
  const root = accxuiRoot()
  if (!root) return { ok: false, message: 'No PWA workspace set — pick your accxui folder in Setup (Moqui-only mode).' }
  const a = pwaApp(name); if (!a) return { ok: false, message: `Unknown app ${name}` }
  const dir = pwaDir(a, root)
  if (dir && !existsSync(dir)) return { ok: false, message: `${name} is not installed (${dir} missing). Clone it under apps/ first.` }
  const o = await portOwner(a.port)
  if (o.listening) return { ok: false, message: `${name} already running (pid ${o.pid} on :${a.port}).` }
  const logDir = join(root, 'logs'); await mkdir(logDir, { recursive: true })
  const out = openSync(join(logDir, `${name}.log`), 'a')
  const args = a.prefix ? ['--prefix', a.prefix, 'dev', '--port', String(a.port)] : ['--filter', a.filter || name, 'dev', '--port', String(a.port)]
  const child = spawn('pnpm', args, { cwd: root, detached: true, stdio: ['ignore', out, out], env: { ...process.env, PATH: SANE_PATH } })
  writeFileSync(join(logDir, `${name}.pid`), String(child.pid))
  child.unref()
  return { ok: true, message: `Started ${name} (pid ${child.pid}) on :${a.port}. Give Vite a few seconds; tail logs/${name}.log.` }
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
  const r = await run('brew', ['services', 'start', 'mysql'], 30000)
  return { ok: !r.failed, message: r.failed ? `brew services start mysql failed: ${(r.stderr || r.stdout || '').slice(0, 200)}` : (r.stdout || 'Started MySQL via brew services.').trim() }
}

async function apiAction(target, action) {
  if (!['start', 'stop', 'restart'].includes(action)) return { ok: false, message: `Unknown action "${action}"` }
  if (target === 'moqui') return action === 'start' ? startMoqui() : action === 'stop' ? stopMoqui() : restartMoqui()
  if (target === 'mysql') return action === 'start' ? startMysql() : { ok: false, message: 'Only Start is supported for MySQL (stop is risky — other apps share it).' }
  if (target?.startsWith('pwa:')) { const name = target.slice(4); return action === 'start' ? startPwa(name) : action === 'stop' ? stopPwa(name) : restartPwa(name) }
  return { ok: false, message: `Unknown target "${target}"` }
}

// ─── settings: the folders the dev picks (persisted; native macOS folder picker) ──
function setPath(which, p) {
  p = (p || '').trim(); if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  if (which === 'moqui') SETTINGS.moquiHome = p || undefined
  else if (which === 'accxui') SETTINGS.accxuiHome = p || undefined
  else if (which === 'setupWorkspace') SETTINGS.setupWorkspace = p ? resolve(p) : undefined
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
    moquiHome: SETTINGS.moquiHome || '', accxuiHome: SETTINGS.accxuiHome || '', setupWorkspace: setupWorkspace(),
    resolvedMoquiHome: d.home || '', moquiSource: d.source, moquiValid: d.valid, moquiAdjusted: d.adjusted, moquiRaw: d.rawHome || '',
    activePort: d.httpPort, pinnedPort: SETTINGS.moquiPort || null, instanceCount: d.instanceCount,
    pwaManaged: !!root, accxuiResolved: root || '',
    platform: process.platform, settingsPath: SETTINGS_PATH,
  }
}

// All running Moqui environments, for the picker. `active` marks the one devkit currently targets.
async function apiInstances() {
  const instances = await discoverInstances()
  const active = await discover()
  const out = []
  for (const i of instances) {
    const live = await probe(moquiLivenessUrl(i.port), 2000)
    let database = '', dbConf = ''
    try { const xml = await readFile(join(i.home, 'runtime', 'log', 'MoquiActualConf.xml'), 'utf8')
      database = (xml.match(/name="entity_ds_database"\s+value="([^"]*)"/) || [])[1] || ''
      dbConf = (xml.match(/name="entity_ds_db_conf"\s+value="([^"]*)"/) || [])[1] || '' } catch { /* not run */ }
    out.push({ pid: i.pid, port: i.port, home: i.home, database, dbConf, live: live.ok && live.status === 200, active: i.port === active.httpPort && samePath(i.home, active.home) })
  }
  return { instances: out, pinnedPort: SETTINGS.moquiPort || null, activePort: active.httpPort }
}

// Pin the active Moqui environment by http port (also pins its home so they stay consistent). Empty = auto.
async function apiSelectEnv(port) {
  if (!port) { SETTINGS.moquiPort = undefined; const saved = saveSettings(); _moquiHome = null; return { ok: true, cleared: true, saved } }
  port = Number(port)
  const inst = (await discoverInstances()).find((i) => i.port === port)
  if (!inst) return { ok: false, message: `No running Moqui found on :${port}.` }
  SETTINGS.moquiPort = port; SETTINGS.moquiHome = inst.home
  const saved = saveSettings(); _moquiHome = null
  return { ok: true, port, home: inst.home, saved }
}

// ─── onboarding wizard: a guarded standard Maarg bootstrap ─────────────────────
// Standard setup only: MySQL 8, oms-suite, default ports. The workspace is an
// explicitly chosen parent folder; its moqui-framework child is the Moqui home.
const SETUP_DB = { conf: 'mysql8', host: '127.0.0.1', port: 3306, database: 'moqui', user: 'moqui', password: 'moqui' }
const SETUP_DEFAULT_WS = join(homedir(), 'maarg-oms')
const setupWorkspace = () => resolve((SETTINGS.setupWorkspace || CONFIG.setupWorkspace || '').trim() || (SETTINGS.moquiHome ? dirname(SETTINGS.moquiHome) : SETUP_DEFAULT_WS))
const setupHome = () => join(setupWorkspace(), 'moqui-framework')

async function apiSetupPlan() {
  const ws = setupWorkspace()
  const home = setupHome()
  const J = CONFIG.java11Home
  const gradle = (c) => `cd "${home}" && export JAVA_HOME="${J}" && ./gradlew ${c}`

  const [brewOk, gitOk, jdkOk, mysqlBin, mysqlUp, repoProbe, esUp, solr, live] = await Promise.all([
    run('brew', ['--version']).then((r) => !r.failed),
    run('git', ['--version']).then((r) => !r.failed),
    run(CONFIG.java11, ['-version']).then((r) => !r.failed),
    run('mysql', ['--version']).then((r) => !r.failed),
    portOwner(SETUP_DB.port).then((o) => o.listening),
    run('git', ['ls-remote', 'https://github.com/hotwax/oms.git', 'HEAD'], 10000, { GIT_TERMINAL_PROMPT: '0' }).then((r) => !r.failed),
    portOwner(9200).then((o) => o.listening),
    probe(CONFIG.solrProbe, 3000).then((r) => r.ok),
    probe(CONFIG.moquiLiveness, 3000),
  ])
  const frameworkOk = looksLikeMoquiHome(home) && existsSync(join(home, 'runtime'))
  const runtimeOk = existsSync(join(home, 'runtime', 'component'))
  const maargOk = existsSync(join(home, 'runtime', 'component', 'maarg-docker-config')) && existsSync(join(home, 'myaddons.xml'))
  const exp = maargOk ? await apiExpectations(CONFIG.expectedComponentSet).catch(() => null) : null
  const componentsOk = !!(exp && exp.counts && exp.counts.expected > 0 && exp.counts.missing === 0)
  const repoOk = repoProbe || componentsOk // if the private components are already cloned, access is proven
  // The guide must describe its selected bootstrap target, not an unrelated
  // running Moqui that discover() may find elsewhere on the machine.
  let dbConfigured = false
  try {
    const x = readFileSync(join(home, 'runtime', 'conf', 'MoquiDevConf.xml'), 'utf8')
    dbConfigured = /entity_ds_db_conf"\s+value="mysql8"/.test(x) && /entity_ds_database"\s+value="[^"]+"/.test(x)
  } catch { /* target does not exist yet */ }
  const omssetupOk = existsSync(join(home, 'runtime', 'conf', 'jwtKey.txt'))
  const moquiUp = live.ok && live.status === 200
  const searchOk = esUp || solr

  const steps = [
    { phase: 'Prerequisites', id: 'brew', title: 'Homebrew', why: 'Package manager for the rest.', status: brewOk ? 'done' : 'warn', manual: !brewOk, detail: brewOk ? 'installed' : 'install in a real Terminal — it prompts for your password', command: brewOk ? null : '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"' },
    { phase: 'Prerequisites', id: 'git', title: 'Git', why: 'To clone Moqui + components.', status: gitOk ? 'done' : 'todo', command: gitOk ? null : 'xcode-select --install   # or: brew install git' },
    { phase: 'Prerequisites', id: 'jdk21', title: 'JDK 21', why: 'Current Moqui framework compiles and runs on Java 21.', status: jdkOk ? 'done' : 'todo', detail: jdkOk ? J : 'not found', command: jdkOk ? null : 'brew install openjdk@21' },
    { phase: 'Prerequisites', id: 'mysql', title: 'MySQL 8', why: 'Standard OMS database.', status: mysqlUp ? 'done' : (mysqlBin ? 'warn' : 'todo'), detail: mysqlUp ? 'running on :3306' : (mysqlBin ? 'installed, not running' : 'not installed'), command: mysqlUp ? null : (mysqlBin ? 'brew services start mysql' : 'brew install mysql && brew services start mysql') },
    { phase: 'Prerequisites', id: 'node', title: 'Node 18+', why: 'Runs devkit + PWA dev servers.', status: 'done', detail: 'devkit is running on ' + process.version },
    { phase: 'Prerequisites', id: 'repo', title: 'HotWax repo access', why: 'oms-suite components are private.', status: repoOk ? 'done' : 'warn', detail: repoOk ? 'authenticated to github.com/hotwax' : 'no access detected — add an SSH key or run `gh auth login`', command: repoOk ? null : 'gh auth login   # or add an SSH key with access to github.com/hotwax' },

    { phase: 'Source', id: 'workspace', title: 'Workspace folder', why: 'The entire folder DevKit will replace before cloning.', status: 'info', editable: true, detail: ws + (existsSync(ws) ? '  (exists)' : '  (will be created)') },
    { phase: 'Source', id: 'framework', title: 'Clone moqui-framework', why: 'The Moqui engine.', status: frameworkOk ? 'done' : 'todo', command: frameworkOk ? null : `git clone -b main https://github.com/hotwax/moqui-framework.git "${home}"` },
    { phase: 'Source', id: 'runtime', title: 'Clone moqui-runtime', why: 'The runtime Moqui loads.', status: runtimeOk ? 'done' : (frameworkOk ? 'todo' : 'blocked'), command: runtimeOk ? null : `cd "${home}" && git clone -b main https://github.com/hotwax/moqui-runtime.git runtime` },
    { phase: 'Source', id: 'maarg', title: 'Clone maarg-docker-config + myaddons.xml', why: 'Declares the OMS components.', status: maargOk ? 'done' : (runtimeOk ? 'todo' : 'blocked'), command: maargOk ? null : `cd "${home}" && git clone -b main https://github.com/hotwax/hotwax-maarg-docker-config.git runtime/component/maarg-docker-config && cp runtime/component/maarg-docker-config/myaddons.xml myaddons.xml` },

    { phase: 'Components', id: 'components', title: 'Get oms-suite component set', why: 'The standard OMS components declared by myaddons.xml.', status: componentsOk ? 'done' : (maargOk ? 'todo' : 'blocked'), detail: exp?.counts ? `${exp.counts.present}/${exp.counts.expected} present` : 'needs maarg-docker-config first', command: componentsOk ? null : gradle('getComponentSet -PcomponentSet=oms-suite') },

    { phase: 'Database', id: 'dbcreate', title: 'Recreate database + user', why: `A clean bootstrap replaces local db "${SETUP_DB.database}" and uses user "${SETUP_DB.user}".`, status: dbConfigured ? 'done' : (mysqlUp ? 'todo' : 'blocked'), detail: 'bootstrap-only destructive step', command: `mysql -u root -e "DROP DATABASE IF EXISTS ${SETUP_DB.database}; CREATE DATABASE ${SETUP_DB.database}; CREATE USER IF NOT EXISTS '${SETUP_DB.user}'@'localhost' IDENTIFIED BY '${SETUP_DB.password}'; GRANT ALL ON ${SETUP_DB.database}.* TO '${SETUP_DB.user}'@'localhost'; FLUSH PRIVILEGES;"` },
    { phase: 'Database', id: 'dbconfig', title: 'Point Moqui at MySQL', why: 'Write the datasource props.', status: dbConfigured ? 'done' : (frameworkOk ? 'todo' : 'blocked'), detail: 'runtime/conf/MoquiDevConf.xml', command: `# add under <entity-facade> in "${home}"/runtime/conf/MoquiDevConf.xml:\n<default-property name="entity_ds_db_conf" value="mysql8"/>\n<default-property name="entity_ds_host" value="${SETUP_DB.host}"/>\n<default-property name="entity_ds_port" value="${SETUP_DB.port}"/>\n<default-property name="entity_ds_database" value="${SETUP_DB.database}"/>\n<default-property name="entity_ds_user" value="${SETUP_DB.user}"/>\n<default-property name="entity_ds_password" value="${SETUP_DB.password}"/>` },

    { phase: 'Initialize', id: 'omssetup', title: 'Run omsSetup', why: 'Generates JWT + encryption keys.', status: omssetupOk ? 'done' : (frameworkOk ? 'todo' : 'blocked'), command: gradle('omsSetup -PmaargOnly=true') },
    { phase: 'Initialize', id: 'data', title: 'Clear launch files, then load seed + install + ext data', why: 'Populates the database from a clean Moqui launch directory (slow, re-runnable).', status: 'todo', detail: 'best-effort detection; safe to re-run', command: `${gradle('cleanTempDir')}\n${gradle('loadProduction -Ptypes=seed,seed-initial,install -Praw')}\n${gradle('loadProduction -Ptypes=ext-seed -Praw')}\n${gradle('loadProduction -Ptypes=ext,ext-user -Praw')}` },

    { phase: 'Search (optional)', id: 'search', title: 'OpenSearch / Solr', why: 'Powers search-backed features — optional.', status: searchOk ? 'done' : 'optional', optional: true, command: searchOk ? null : `${gradle('downloadOpenSearch')} && ${gradle('startElasticSearch')}` },

    { phase: 'Run', id: 'run', title: 'Start Moqui', why: 'Launch the server at :8080.', status: moquiUp ? 'done' : (omssetupOk ? 'todo' : 'blocked'), command: moquiUp ? null : gradle('run') },
  ]
  const total = steps.filter((s) => s.status !== 'info').length
  const done = steps.filter((s) => s.status === 'done').length
  return { workspace: home, workspaceRoot: ws, javaHome: J, db: SETUP_DB, summary: { done, total }, steps }
}

const isWithin = (path, parent) => path === parent || path.startsWith(parent + '/')
function bootstrapRootIsSafe(root) {
  const resolved = resolve(root)
  const forbidden = new Set(['/', homedir(), resolve(PKG_DIR), dirname(resolve(PKG_DIR))])
  if (forbidden.has(resolved) || resolved.split('/').filter(Boolean).length < 3) return { ok: false, message: 'Choose a dedicated workspace folder, never /, your home folder, or the DevKit folder.' }
  return { ok: true, root: resolved, home: join(resolved, 'moqui-framework') }
}

function spawnLogged(bin, args, cwd, logFile, env = {}) {
  return new Promise((resolveRun) => {
    let fd
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      fd = openSync(logFile, 'a')
      writeSync(fd, `\n=== ${new Date().toISOString()} ===\n$ ${bin} ${args.join(' ')}\n`)
    } catch (e) { return resolveRun({ ok: false, code: -1, error: String(e) }) }
    const child = spawn(bin, args, { cwd, stdio: ['ignore', fd, fd], env: { ...process.env, PATH: `${CONFIG.java11Home}/bin:${SANE_PATH}`, JAVA_HOME: CONFIG.java11Home, ...env } })
    JOB.pid = child.pid
    child.on('error', (e) => { try { closeSync(fd) } catch { /* noop */ }; resolveRun({ ok: false, code: -1, error: String(e) }) })
    child.on('exit', (code) => { try { closeSync(fd) } catch { /* noop */ }; resolveRun({ ok: code === 0, code }) })
  })
}

async function writeBootstrapConfig(home) {
  const path = join(home, 'runtime', 'conf', 'MoquiDevConf.xml')
  const xml = await readFile(path, 'utf8')
  await writeFile(path, configureMysqlDatasource(xml, SETUP_DB))
}

async function waitForMoqui(port, timeoutMs = 180000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const live = await probe(moquiLivenessUrl(port), 4000)
    if (live.ok && live.status === 200) return { ok: true, detail: `HTTP ${live.status}` }
    await delay(2000)
  }
  return { ok: false, detail: `No HTTP 200 from ${moquiLivenessUrl(port)} within ${Math.round(timeoutMs / 1000)}s.` }
}

async function runBootstrap(root) {
  const job = JOB
  const checked = bootstrapRootIsSafe(root)
  if (!checked.ok) { job.ok = false; job.error = checked.message; job.done = true; return }
  const { home } = checked
  const logFile = join(root, '.devkit-bootstrap.log')
  // A bootstrap is intentionally a series of isolated Gradle invocations. This avoids a
  // leftover daemon or exploded Moqui WAR from a previous partial attempt sharing state
  // with the next setup stage.
  const gradleArgs = (...args) => ['--no-daemon', ...args]
  job.logFile = logFile
  const command = async (name, bin, args, cwd, env) => {
    const s = stepStart(name, `${bin} ${args.join(' ')}`)
    const result = await spawnLogged(bin, args, cwd, logFile, env)
    if (!result.ok) { stepEnd(s, 'fail', `exit ${result.code}${result.error ? ` · ${result.error}` : ''}`); throw new Error(`${name} failed — see ${logFile}`) }
    stepEnd(s, 'ok', 'completed')
  }
  try {
    let s = stepStart('Preflight')
    const [java, git, mysql] = await Promise.all([
      run(CONFIG.java11, ['-version']), run('git', ['--version']), run('mysql', ['--version']),
    ])
    if (java.failed || git.failed || mysql.failed) {
      const missing = [java.failed && 'JDK 21', git.failed && 'Git', mysql.failed && 'MySQL client'].filter(Boolean).join(', ')
      stepEnd(s, 'fail', `missing: ${missing}`); throw new Error(`Bootstrap requires ${missing}.`)
    }
    if (!(await portOwner(SETUP_DB.port)).listening) {
      const started = await startMysql()
      if (!started.ok) { stepEnd(s, 'fail', started.message); throw new Error(started.message) }
      for (let i = 0; i < 15 && !(await portOwner(SETUP_DB.port)).listening; i++) await delay(1000)
    }
    if (!(await portOwner(SETUP_DB.port)).listening) { stepEnd(s, 'fail', 'MySQL is not listening on :3306'); throw new Error('MySQL did not start.') }
    stepEnd(s, 'ok', `JDK ${CONFIG.java11Home}; Git and MySQL available`)

    const active = await discover()
    if (active.home && isWithin(active.home, checked.root)) {
      s = stepStart('Stop existing Moqui')
      const stopped = await stopMoqui()
      if (!stopped.ok) { stepEnd(s, 'fail', stopped.message); throw new Error(stopped.message) }
      stepEnd(s, 'ok', stopped.message)
    }

    s = stepStart('Stop existing Solr')
    const stoppedSolr = await stopWorkspaceSolr(checked.root)
    if (!stoppedSolr.ok) { stepEnd(s, 'fail', stoppedSolr.message); throw new Error(stoppedSolr.message) }
    stepEnd(s, stoppedSolr.skipped ? 'skip' : 'ok', stoppedSolr.message)

    s = stepStart('Wipe workspace', checked.root)
    await rm(checked.root, { recursive: true, force: true })
    await mkdir(checked.root, { recursive: true })
    stepEnd(s, 'ok', 'removed all prior workspace contents')

    await command('Clone moqui-framework', 'git', ['clone', '--branch', 'main', 'https://github.com/hotwax/moqui-framework.git', home], checked.root)
    // runtime/ is intentionally ignored by the framework checkout. A stale Gradle child can recreate it
    // between the workspace wipe and this point, so guarantee the clone destination is empty.
    s = stepStart('Clear runtime clone destination')
    await rm(join(home, 'runtime'), { recursive: true, force: true })
    stepEnd(s, 'ok', 'runtime destination is empty')
    await command('Clone moqui-runtime', 'git', ['clone', '--branch', 'main', 'https://github.com/hotwax/moqui-runtime.git', 'runtime'], home)
    await command('Clone maarg-docker-config', 'git', ['clone', '--branch', 'main', 'https://github.com/hotwax/hotwax-maarg-docker-config.git', 'runtime/component/maarg-docker-config'], home)

    s = stepStart('Install component manifest')
    await copyFile(join(home, 'runtime', 'component', 'maarg-docker-config', 'myaddons.xml'), join(home, 'myaddons.xml'))
    stepEnd(s, 'ok', 'myaddons.xml installed')

    await command('Get OMS component set', './gradlew', gradleArgs('getComponentSet', '-PcomponentSet=oms-suite'), home)
    await command('Get MySQL JDBC driver', './gradlew', gradleArgs('getMySqlJdbc'), home)

    s = stepStart('Configure local MySQL')
    const sql = `DROP DATABASE IF EXISTS \`${SETUP_DB.database}\`; CREATE DATABASE \`${SETUP_DB.database}\` CHARACTER SET utf8mb4; CREATE USER IF NOT EXISTS '${SETUP_DB.user}'@'localhost' IDENTIFIED BY '${SETUP_DB.password}'; GRANT ALL ON \`${SETUP_DB.database}\`.* TO '${SETUP_DB.user}'@'localhost'; FLUSH PRIVILEGES;`
    const db = await run('mysql', ['-u', (CONFIG.db && CONFIG.db.adminUser) || 'root', '-e', sql], 30000, mysqlEnv((CONFIG.db && CONFIG.db.adminPassword) || ''))
    if (db.failed) { stepEnd(s, 'fail', (db.stderr || db.stdout || `mysql exit ${db.code}`).slice(0, 300)); throw new Error('Could not recreate the local MySQL database and user.') }
    await writeBootstrapConfig(home)
    stepEnd(s, 'ok', `${SETUP_DB.database} on ${SETUP_DB.host}:${SETUP_DB.port}`)

    await command('Run OMS setup', './gradlew', gradleArgs('omsSetup', '-PmaargOnly=true'), home)
    const dbEnv = { entity_ds_db_conf: SETUP_DB.conf, entity_ds_host: SETUP_DB.host, entity_ds_port: String(SETUP_DB.port), entity_ds_database: SETUP_DB.database, entity_ds_user: SETUP_DB.user, entity_ds_password: SETUP_DB.password }
    await command('Clear temporary Moqui launch files', './gradlew', gradleArgs('cleanTempDir'), home)
    await command('Load seed + install data', './gradlew', gradleArgs('loadProduction', '-Ptypes=seed,seed-initial,install', '-Praw'), home, dbEnv)
    await command('Load extension seed data', './gradlew', gradleArgs('loadProduction', '-Ptypes=ext-seed', '-Praw'), home, dbEnv)
    await command('Load extension data', './gradlew', gradleArgs('loadProduction', '-Ptypes=ext,ext-user', '-Praw'), home, dbEnv)
    await command('Set up Solr', './gradlew', gradleArgs(':runtime:component:maarg-util:setupSolr', '-PdownloadSolr=true'), home)
    await command('Start Solr', './gradlew', gradleArgs(':runtime:component:maarg-util:startSolr'), home)
    const solrRunnerDir = join(home, 'build', 'devkit-solr-bootstrap')
    await rm(solrRunnerDir, { recursive: true, force: true })
    await command('Prepare Solr initializer', 'unzip', ['-q', '-o', join(home, 'moqui.war'), '-d', solrRunnerDir], home)
    try {
      await command('Initialize Solr collections', CONFIG.java11,
        solrBootstrapJavaArgs(home, solrRunnerDir, join(PKG_DIR, 'lib', 'bootstrap-solr.groovy')), home, dbEnv)
    } finally {
      await rm(solrRunnerDir, { recursive: true, force: true })
    }

    s = stepStart('Start Moqui')
    const pid = spawnRun(home, logFile)
    if (!pid) { stepEnd(s, 'fail', 'could not launch Gradle'); throw new Error('Could not start Moqui.') }
    job.pid = pid
    const live = await waitForMoqui(CONFIG.ports.moqui)
    if (!live.ok) { stepEnd(s, 'fail', live.detail); throw new Error(live.detail) }
    stepEnd(s, 'ok', live.detail)

    SETTINGS.moquiHome = home
    SETTINGS.setupWorkspace = checked.root
    saveSettings(); _moquiHome = null
    job.receipt = { workspace: checked.root, home, database: SETUP_DB.database, moqui: `http://localhost:${CONFIG.ports.moqui}`, solr: `http://localhost:${CONFIG.ports.solr}/solr/`, note: 'Clean standard OMS suite bootstrapped by DevKit.' }
    job.ok = true
  } catch (e) { job.ok = false; job.error = String(e && e.message || e) }
  finally { job.done = true; job.finishedAt = new Date().toISOString() }
}

async function apiBootstrapStart(root, confirm) {
  const busy = jobBusy(); if (busy) return { ok: false, message: busy }
  const checked = bootstrapRootIsSafe(root || setupWorkspace())
  if (!checked.ok) return { ok: false, message: checked.message }
  if (String(confirm || '') !== checked.root) return { ok: false, message: `Type the workspace path exactly to confirm its complete deletion: ${checked.root}` }
  newJob('bootstrap'); runBootstrap(checked.root)
  return { ok: true, started: true, jobId: JOB.id }
}

// ─── DB: reset-to-seed · snapshot · revert (guarded, localhost only) ──────────
// devkit stays a stateless orchestrator: snapshots are plain .sql.gz files under the project's
// own runtime/db-snapshots/ (durable across npx-cache wipes, self-cleaning with the checkout) — the
// directory listing IS the state. All destructive ops are localhost-only, fail-closed, and show
// exactly what they did. Secrets are resolved server-side and NEVER sent to the browser or the log.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', ''])
const DB_NAME_RE = /^[A-Za-z0-9_]+$/                       // safe to backtick-quote into SQL
const SNAP_LABEL_RE = /^[A-Za-z0-9_-]{1,64}$/              // safe as a filename segment
const LOAD_CMD_RE = /^\.\/gradlew [A-Za-z0-9 ,=._-]+$/     // whitelist for the parsed DB_LOAD command
const MYSQL_CONFS = new Set(['mysql8', 'mysql'])
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`  // single-quote for the one bash -c we use
const stripXmlComments = (xml) => String(xml || '').replace(/<!--[\s\S]*?-->/g, '')
const snapshotDir = (home) => join(home, 'runtime', 'db-snapshots')

function isLocalUrl(u) { try { return LOCAL_HOSTS.has(new URL(u).hostname.replace(/^\[|\]$/g, '')) } catch { return false } }

// Minimal JSON-over-HTTP for ES/Solr admin calls (Node 18+ global fetch). Never throws.
async function httpJson(method, url, body, ms = 8000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms)
  try {
    const opt = { method, signal: ac.signal, headers: {} }
    if (body !== undefined) { opt.body = typeof body === 'string' ? body : JSON.stringify(body); opt.headers['content-type'] = 'application/json' }
    const r = await fetch(url, opt)
    let text = ''; try { text = await r.text() } catch { /* ignore */ }
    let data = null; try { data = text ? JSON.parse(text) : null } catch { /* not json */ }
    return { ok: true, status: r.status, text, json: data }
  } catch (e) { return { ok: false, error: e.code || e.name || String(e) } }
  finally { clearTimeout(t) }
}

// Byte-offset tail of any file (used to stream the job log). Returns null if unreadable.
async function tailFile(path, kb = 64) {
  let fh
  try {
    fh = await open(path, 'r'); const { size } = await fh.stat()
    const len = Math.min(kb * 1024, size); const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, size - len)
    return { size, shown: len, tail: buf.toString('utf8') }
  } catch { return null } finally { if (fh) await fh.close() }
}

// ── credential + target resolver (the safety core) ──
// Identity comes from Moqui's own merged, comment-free MoquiActualConf.xml — NEVER a raw regex over
// the hand-edited MoquiDevConf.xml (whose mysql8 block is often commented out → a regex would grab a
// commented password and drop the wrong DB). Password is resolved separately and only used server-side.
async function resolveDbPassword() {
  const cfgDb = CONFIG.db || {}
  if (cfgDb.password != null) return { password: String(cfgDb.password), source: 'devkit.config.json' }
  if (process.env.entity_ds_password) return { password: process.env.entity_ds_password, source: 'env:entity_ds_password' }
  if (process.env.MYSQL_PWD) return { password: process.env.MYSQL_PWD, source: 'env:MYSQL_PWD' }
  const d = await discover()
  const fromConf = async (rel) => {
    if (!d.home) return null
    let xml; try { xml = await readFile(join(d.home, rel), 'utf8') } catch { return null }
    const vals = [...stripXmlComments(xml).matchAll(/<default-property\s+name="entity_ds_password"\s+value="([^"]*)"/g)]
      .map((m) => m[1]).filter((v) => v && v !== '***')
    const uniq = [...new Set(vals)]
    return uniq.length === 1 ? uniq[0] : null   // 0 or ambiguous → don't guess
  }
  let v = await fromConf(join('runtime', 'conf', 'MoquiDevConf.xml'))
  if (v) return { password: v, source: 'MoquiDevConf.xml' }
  if (CONFIG.moquiRunScript) {
    try { const m = (await readFile(CONFIG.moquiRunScript, 'utf8')).match(/entity_ds_password["'=:\s]+([^\s"';]+)/); if (m) return { password: m[1], source: 'run script' } } catch { /* ignore */ }
  }
  v = await fromConf(join('runtime', 'conf', 'MoquiProductionConf.xml'))
  if (v) return { password: v, source: 'MoquiProductionConf.xml' }
  return { password: '', source: null }
}

async function resolveDbTarget() {
  const cfgDb = CONFIG.db || {}
  const cfg = await apiConfig().catch(() => null)
  const haveActual = cfg && !cfg.error && cfg.db
  const id = haveActual ? cfg.db : {}
  const refuse = (why) => ({ ok: false, refuse: why })

  const dbConf = String(cfgDb.dbConf || id.conf || '').trim()
  const host = String(cfgDb.host || id.host || '').trim()
  const port = String(cfgDb.port || id.port || 3306).trim()
  const database = String(cfgDb.database || id.database || '').trim()
  const user = String(cfgDb.user || id.user || '').trim()
  const instance = haveActual ? (cfg.instance && cfg.instance.name) || '' : ''

  if (!haveActual && !(cfgDb.host && cfgDb.database)) return refuse('Moqui has not generated its effective config yet (runtime/log/MoquiActualConf.xml is missing). Start Moqui once, or set "db" in devkit.config.json.')
  if (!MYSQL_CONFS.has(dbConf)) return refuse(`active datasource is "${dbConf || 'unknown'}", not MySQL — reset/snapshot/revert only support a local MySQL database.`)
  if (!LOCAL_HOSTS.has(host)) return refuse(`datasource host is "${host}", not localhost — refusing to touch a non-local database.`)
  if (!DB_NAME_RE.test(database)) return refuse(`database name "${database || '(empty)'}" is not a simple identifier — refusing.`)
  if (!user) return refuse('could not resolve the database user from MoquiActualConf.xml.')

  const pw = await resolveDbPassword()
  const adminUser = cfgDb.adminUser ? String(cfgDb.adminUser) : user
  const adminPassword = cfgDb.adminUser ? String(cfgDb.adminPassword ?? '') : pw.password
  return {
    ok: true, dbConf, host: host || 'localhost', port, database, user,
    password: pw.password, pwSource: pw.source, adminUser, adminPassword, instance,
    search: (haveActual && cfg.search) || {},
  }
}

// mysql/mysqldump auth: password via MYSQL_PWD child env — NEVER argv (visible in ps), never logged.
function mysqlEnv(password) { return { MYSQL_PWD: password || '' } }
function mysqlArgs(t, who) { return ['-h', t.host, '-P', String(t.port), '-u', who === 'admin' ? t.adminUser : t.user] }

async function dbPing(t, who = 'user') {
  const pw = who === 'admin' ? t.adminPassword : t.password
  const r = await run('mysql', [...mysqlArgs(t, who), '-N', '-B', '-e', 'SELECT 1'], 10000, mysqlEnv(pw))
  return { ok: !r.failed, error: r.failed ? (r.stderr || `exit ${r.code}`).split('\n')[0].slice(0, 240) : null }
}

async function dbCounts(t) {
  // table_rows is approximate for InnoDB — fine for a "what am I about to wipe" preview.
  const sql = `SELECT COUNT(*), COALESCE(SUM(table_rows),0) FROM information_schema.tables WHERE table_schema='${t.database}'`
  const r = await run('mysql', [...mysqlArgs(t, 'user'), '-N', '-B', '-e', sql], 15000, mysqlEnv(t.password))
  if (r.failed) return null
  const [tables, rows] = (r.stdout.trim().split('\n').pop() || '').split('\t').map((x) => parseInt(x, 10))
  return { tables: tables || 0, rows: rows || 0 }
}

async function dropCreateDatabase(t) {
  const sql = `DROP DATABASE IF EXISTS \`${t.database}\`; CREATE DATABASE \`${t.database}\` CHARACTER SET utf8mb4;`
  const r = await run('mysql', [...mysqlArgs(t, 'admin'), '-e', sql], 120000, mysqlEnv(t.adminPassword))
  return { ok: !r.failed, code: r.code, stderr: (r.stderr || '').slice(0, 800) }
}

// The team's canonical load command, read from maarg-docker-config (compose or Dockerfile). Whitelisted.
async function resolveLoadCommand() {
  const d = await discover()
  const tried = []
  if (d.home) {
    const base = join(d.home, 'runtime', 'component', 'maarg-docker-config', 'docker')
    tried.push(join(base, 'docker-compose.yml'), join(base, 'Dockerfile'))
  }
  for (const p of tried) {
    let txt; try { txt = await readFile(p, 'utf8') } catch { continue }
    const m = txt.match(/DB_LOAD["']?\s*[:=]\s*["']([^"'\n]+)["']/)
    if (m) {
      const cmd = m[1].trim()
      if (LOAD_CMD_RE.test(cmd)) return { command: cmd, source: p }
    }
  }
  return { command: './gradlew load', source: 'fallback (no valid DB_LOAD found in maarg-docker-config)' }
}

// ── search index clearing (no Moqui auth — plain local HTTP) ──
// up:false only on a real connection failure. A reachable-but-401/403 search server is UP but
// auth-protected (we just can't enumerate/clear without credentials) — never report that as "down".
const isAuthStatus = (s) => s === 401 || s === 403
async function esIndices(baseUrl) {
  const r = await httpJson('GET', baseUrl + '/_cat/indices?format=json&h=index')
  if (!r.ok) return { up: false, error: r.error }
  if (r.status >= 200 && r.status < 300 && Array.isArray(r.json)) return { up: true, protected: false, indices: r.json.map((x) => x.index).filter(Boolean) }
  return { up: true, protected: isAuthStatus(r.status), indices: null, status: r.status }
}
async function solrStatus(adminUrl) {
  const list = await httpJson('GET', adminUrl + '/admin/collections?action=LIST&wt=json')
  if (list.ok && list.status >= 200 && list.status < 300 && list.json && Array.isArray(list.json.collections)) return { up: true, protected: false, mode: 'cloud', names: list.json.collections }
  const cores = await httpJson('GET', adminUrl + '/admin/cores?action=STATUS&wt=json')
  if (cores.ok && cores.status >= 200 && cores.status < 300 && cores.json && cores.json.status) return { up: true, protected: false, mode: 'cores', names: Object.keys(cores.json.status) }
  if (list.ok || cores.ok) return { up: true, protected: isAuthStatus(list.status) || isAuthStatus(cores.status), names: null, status: list.status || cores.status }
  return { up: false, error: list.error || cores.error }
}

async function clearSearch() {
  const cfg = await apiConfig().catch(() => null)
  const search = (cfg && !cfg.error && cfg.search) || {}
  const instance = (cfg && !cfg.error && cfg.instance && cfg.instance.name) || ''
  const out = { es: null, solr: null }

  // ElasticSearch / OpenSearch — delete the DataDocument indexes (conservative: skip system "." indexes,
  // and when a prefix/instance is known, only touch matching indexes).
  const esUrl = (search.elasticsearchUrl || 'http://127.0.0.1:9200').replace(/\/$/, '')
  if (!isLocalUrl(esUrl)) out.es = { skipped: true, reason: 'non-local ElasticSearch URL — refusing', url: esUrl }
  else {
    const es = await esIndices(esUrl)
    if (!es.up) out.es = { skipped: true, reason: `not reachable (${es.error})`, url: esUrl }
    else if (!es.indices) out.es = { skipped: true, reason: es.protected ? 'up but auth-protected — cannot clear without credentials' : `unreadable (HTTP ${es.status})`, url: esUrl }
    else {
      const prefix = search.elasticsearchPrefix || instance || ''
      let idxs = es.indices.filter((i) => !i.startsWith('.'))
      if (prefix) idxs = idxs.filter((i) => i.toLowerCase().startsWith(prefix.toLowerCase()))
      const deleted = [], failed = []
      for (const i of idxs) {
        const r = await httpJson('DELETE', esUrl + '/' + encodeURIComponent(i))
        if (r.ok && r.status < 300) deleted.push(i); else failed.push(i)
      }
      out.es = { url: esUrl, deleted, failed, considered: es.indices.length }
    }
  }

  // Solr — empty the instance's collections (delete-by-query keeps the collection; no configset re-upload).
  const solrUrl = (search.solrAdminUrl || 'http://localhost:8983/solr').replace(/\/$/, '')
  if (!isLocalUrl(solrUrl)) out.solr = { skipped: true, reason: 'non-local Solr URL — refusing', url: solrUrl }
  else {
    const sr = await solrStatus(solrUrl)
    if (!sr.up) out.solr = { skipped: true, reason: `not reachable (${sr.error})`, url: solrUrl }
    else if (!sr.names) out.solr = { skipped: true, reason: sr.protected ? 'up but auth-protected — cannot clear without credentials' : `unreadable (HTTP ${sr.status})`, url: solrUrl }
    else if (!instance) out.solr = { skipped: true, reason: 'instance name unknown — skipped to avoid clearing shared collections', url: solrUrl, found: sr.names }
    else {
      const targets = sr.names.filter((c) => c === instance || c.toLowerCase().startsWith(instance.toLowerCase()))
      const cleared = [], failed = []
      for (const c of targets) {
        const r = await httpJson('POST', `${solrUrl}/${encodeURIComponent(c)}/update?commit=true`, { delete: { query: '*:*' } })
        if (r.ok && r.status < 300) cleared.push(c); else failed.push(c)
      }
      out.solr = { url: solrUrl, cleared, failed, skippedCollections: sr.names.filter((c) => !targets.includes(c)) }
    }
  }
  return out
}
function summarizeSearch(s) {
  const es = s.es && s.es.deleted ? `ES: cleared ${s.es.deleted.length} index(es)` : `ES: ${s.es && s.es.reason || 'n/a'}`
  const solr = s.solr && s.solr.cleared ? `Solr: emptied ${s.solr.cleared.length} collection(s)` : `Solr: ${s.solr && s.solr.reason || 'n/a'}`
  return `${es} · ${solr}`
}

// ── pipes (Node stdio, no shell): mysqldump|gzip→file and gunzip|mysql ──
function dumpToFile(t, outPath) {
  return new Promise((resolve) => {
    const env = { ...process.env, PATH: SANE_PATH, ...mysqlEnv(t.password) }
    const out = createWriteStream(outPath)
    const dump = spawn('mysqldump', ['--single-transaction', '--no-tablespaces', '--set-gtid-purged=OFF', '--column-statistics=0', ...mysqlArgs(t, 'user'), t.database], { env })
    const gz = spawn('gzip', [], { env })
    let derr = '', gerr = '', dc = null, gc = null, oc = false, done = false
    const fin = () => { if (done || dc === null || gc === null || !oc) return; done = true; resolve({ ok: dc === 0 && gc === 0, dumpCode: dc, gzCode: gc, stderr: (derr || gerr).slice(0, 1200) }) }
    dump.stderr.on('data', (d) => { derr += d.toString().slice(0, 4000) })
    gz.stderr.on('data', (d) => { gerr += d.toString().slice(0, 2000) })
    dump.stdout.pipe(gz.stdin); gz.stdout.pipe(out)
    dump.on('error', (e) => { derr += String(e); dc = dc ?? -1; try { gz.stdin.end() } catch { /* */ } fin() })
    gz.on('error', (e) => { gerr += String(e); gc = gc ?? -1; fin() })
    dump.on('close', (c) => { dc = c })
    gz.on('close', (c) => { gc = c; fin() })
    out.on('close', () => { oc = true; fin() })
    out.on('error', (e) => { gerr += String(e); gc = gc ?? -1; oc = true; fin() })
  })
}
function restoreFromFile(t, file) {
  return new Promise((resolve) => {
    const env = { ...process.env, PATH: SANE_PATH, ...mysqlEnv(t.password) }
    const gun = spawn('gunzip', ['-c', file], { env })
    const my = spawn('mysql', [...mysqlArgs(t, 'user'), t.database], { env })
    let gerr = '', merr = '', gc = null, mc = null, done = false
    const fin = () => { if (done || gc === null || mc === null) return; done = true; resolve({ ok: gc === 0 && mc === 0, gunzipCode: gc, mysqlCode: mc, stderr: (merr || gerr).slice(0, 1200) }) }
    gun.stderr.on('data', (d) => { gerr += d.toString().slice(0, 2000) })
    my.stderr.on('data', (d) => { merr += d.toString().slice(0, 4000) })
    gun.stdout.pipe(my.stdin)
    gun.on('error', (e) => { gerr += String(e); gc = gc ?? -1; try { my.stdin.end() } catch { /* */ } fin() })
    my.on('error', (e) => { merr += String(e); mc = mc ?? -1; fin() })
    gun.on('close', (c) => { gc = c })
    my.on('close', (c) => { mc = c; fin() })
  })
}

async function ensureSnapshotDir(home) {
  const dir = snapshotDir(home)
  await mkdir(dir, { recursive: true })
  const gi = join(dir, '.gitignore')   // dir is NOT covered by moqui-runtime/.gitignore — keep dumps out of git
  if (!existsSync(gi)) { try { writeFileSync(gi, '# devkit DB snapshots — never commit\n*\n') } catch { /* */ } }
  return dir
}

// ── job model: one global current job, spawned long ops, status by poll ──
let JOB = null
function newJob(kind) {
  JOB = { id: 'job-' + Date.now(), kind, phase: 'starting', steps: [], pid: null, logFile: null, startedAt: new Date().toISOString(), finishedAt: null, done: false, ok: null, error: null, receipt: null }
  return JOB
}
function stepStart(name, detail) { const s = { name, status: 'running', detail: detail || '', startedAt: Date.now() }; JOB.steps.push(s); JOB.phase = name; return s }
function stepEnd(s, status, detail) { s.status = status; if (detail !== undefined) s.detail = detail; s.ms = Date.now() - s.startedAt }

// Run the gradle load detached to a logfile (it streams for minutes). entity_ds_* are passed via the
// CHILD ENV (not argv/log) so the password never leaks and the load targets the exact DB we wiped.
function spawnLoad(home, loadCommand, logFile, t) {
  return new Promise((resolve) => {
    let fd
    try { mkdirSync(dirname(logFile), { recursive: true }); fd = openSync(logFile, 'a'); writeSync(fd, `\n=== devkit ${JOB.kind} · load · ${new Date().toISOString()} ===\n$ ${loadCommand}\n`) } catch (e) { return resolve({ ok: false, code: -1, error: String(e) }) }
    const env = {
      ...process.env, PATH: `${CONFIG.java11Home}/bin:${SANE_PATH}`, JAVA_HOME: CONFIG.java11Home,
      entity_ds_db_conf: t.dbConf, entity_ds_host: t.host, entity_ds_port: String(t.port),
      entity_ds_database: t.database, entity_ds_user: t.user, entity_ds_password: t.password,
    }
    const child = spawn('bash', ['-c', `cd ${shq(home)} && exec ${loadCommand}`], { detached: true, stdio: ['ignore', fd, fd], env })
    JOB.pid = child.pid
    child.on('error', (e) => { try { closeSync(fd) } catch { /* */ } resolve({ ok: false, code: -1, error: String(e) }) })
    child.on('exit', (code) => { try { closeSync(fd) } catch { /* */ } resolve({ ok: code === 0, code }) })
  })
}

// Import one validated entity-export file with Moqui's standard loader. No shell is involved and
// datasource credentials stay in the child environment, never argv or the job log.
function spawnEntityLoad(home, location, logFile, t, expectedRecords) {
  return new Promise((resolve) => {
    let fd
    const marker = `=== devkit remote entity import · ${JOB.id} · ${new Date().toISOString()} ===`
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      fd = openSync(logFile, 'a')
      writeSync(fd, `\n${marker}\n`)
    } catch (e) { return resolve({ ok: false, code: -1, error: String(e) }) }
    const env = {
      ...process.env, PATH: `${CONFIG.java11Home}/bin:${SANE_PATH}`, JAVA_HOME: CONFIG.java11Home,
      entity_ds_db_conf: t.dbConf, entity_ds_host: t.host, entity_ds_port: String(t.port),
      entity_ds_database: t.database, entity_ds_user: t.user, entity_ds_password: t.password,
    }
    const child = spawn(CONFIG.java11, moquiEntityLoadArgs(home, location), { cwd: home, stdio: ['ignore', fd, fd], env })
    JOB.pid = child.pid
    child.on('error', (e) => { try { closeSync(fd) } catch { /* */ }; resolve({ ok: false, code: -1, error: String(e) }) })
    child.on('exit', async (code) => {
      try { closeSync(fd) } catch { /* */ }
      let importLog
      try {
        const completeLog = await readFile(logFile, 'utf8')
        const markerAt = completeLog.lastIndexOf(marker)
        importLog = markerAt >= 0 ? completeLog.slice(markerAt + marker.length) : ''
      } catch (e) {
        return resolve({ ok: false, code, error: `Could not validate the Moqui loader log: ${e.message}` })
      }
      const inspected = inspectMoquiEntityLoadLog(importLog, expectedRecords)
      resolve({ ok: code === 0 && inspected.ok, code, error: inspected.error, records: inspected.records })
    })
  })
}

async function clearRemoteEntityTarget(t) {
  const result = await run(
    'mysql',
    [...mysqlArgs(t, 'user'), '-e', remoteEntityResetSql(t.database)],
    120000,
    mysqlEnv(t.password),
  )
  return { ok: !result.failed, code: result.code, error: result.failed ? (result.stderr || `exit ${result.code}`).split('\n')[0].slice(0, 300) : null }
}

async function readHotwaxKeychainPassword(account, source) {
  const r = await run('/usr/bin/security', keychainPasswordArgs(account, source), 15000)
  const password = r.stdout.trimEnd()
  if (r.failed || !password) throw new Error(`Could not read the ${account} HotWax domain credential from macOS Keychain.`)
  return password
}

function responseCookies(response) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean)
  return values.map((value) => value.split(';', 1)[0]).join('; ')
}

async function runRemoteEntityImport({ source, account, profileId }) {
  const job = JOB
  let tempDir = null
  let wasUp = false
  let restarted = false
  let referenceSanitization = null
  try {
    const sourceOrigin = normalizeHotwaxSource(source)
    const profile = getRemoteEntityProfile(profileId)
    const endpoints = remoteEntityEndpoints(sourceOrigin)
    const d = await discover(); if (!d.home) throw new Error('No MOQUI_HOME.')

    let s = stepStart('Resolve local MySQL target')
    const t = await resolveDbTarget()
    if (!t.ok) { stepEnd(s, 'fail', t.refuse); throw new Error(t.refuse) }
    const ping = await dbPing(t, 'user')
    if (!ping.ok) { stepEnd(s, 'fail', ping.error); throw new Error(`Cannot connect to local MySQL: ${ping.error}`) }
    stepEnd(s, 'ok', `${t.database} @ ${t.host}:${t.port}`)

    s = stepStart('Authenticate source', `${sourceOrigin} · Keychain account ${account}`)
    let password = await readHotwaxKeychainPassword(account, sourceOrigin)
    let authorization = `Basic ${Buffer.from(`${account}:${password}`, 'utf8').toString('base64')}`
    const login = await fetch(endpoints.login, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ username: account, password }),
      redirect: 'manual',
      signal: AbortSignal.timeout(30000),
    })
    await login.arrayBuffer()
    const cookies = responseCookies(login)
    if (login.status !== 200 || !cookies) throw new Error(`Source login failed (HTTP ${login.status}).`)
    stepEnd(s, 'ok', 'temporary authenticated session established')

    s = stepStart('Verify source release')
    const infoResponse = await fetch(endpoints.information, {
      headers: { authorization, cookie: cookies, accept: 'application/json' },
      signal: AbortSignal.timeout(30000),
    })
    if (!infoResponse.ok) throw new Error(`Could not read source release information (HTTP ${infoResponse.status}).`)
    const sourceInfo = await infoResponse.json()
    const instanceInfo = sourceInfo.instanceInfo || {}
    const sourceSha = String(instanceInfo.commitSHA || '')
    const release = String(instanceInfo.componentRelease || 'unknown')
    if (!/^[0-9a-f]{7,40}$/i.test(sourceSha)) throw new Error('Source did not report a valid maarg-docker-config commit SHA.')
    const dockerConfigDir = join(d.home, 'runtime', 'component', 'maarg-docker-config')
    const ancestry = await run('git', ['-C', dockerConfigDir, 'merge-base', '--is-ancestor', sourceSha, 'HEAD'], 15000)
    if (ancestry.failed) throw new Error(`Source release ${release} (${sourceSha.slice(0, 12)}) is not an ancestor of local maarg-docker-config; update the local main checkout before importing.`)
    stepEnd(s, 'ok', `${release} · ${sourceSha.slice(0, 12)} · local checkout is same or newer`)

    s = stepStart('Export safe entity profile', `${profile.label} · ${profile.entities.length} entities · source remains read-only`)
    const exported = await fetch(endpoints.export, {
      method: 'POST',
      headers: {
        authorization, cookie: cookies,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/xml,text/xml',
      },
      body: buildEntityExportForm(profile),
      redirect: 'manual',
      signal: AbortSignal.timeout(10 * 60 * 1000),
    })
    if (exported.status !== 200) throw new Error(`Entity export failed (HTTP ${exported.status}).`)
    tempDir = await mkdtemp(join(tmpdir(), 'devkit-entity-import-'))
    const exportFile = join(tempDir, 'entity-export.xml')
    const exportStats = await saveEntityExportResponse(exported, exportFile)
    const sourceRecords = exportStats.records
    let records = sourceRecords
    const { bytes } = exportStats
    password = ''; authorization = ''
    stepEnd(s, 'ok', `${records.toLocaleString()} records · ${(bytes / 1048576).toFixed(1)} MB`)

    if (profile.entities.includes('org.apache.ofbiz.product.inventory.InventoryItem')) {
      s = stepStart('Sanitize excluded references', 'remove only foreign keys to Party, Geo, GeoPoint, and reset entities excluded from this safe profile')
      referenceSanitization = await sanitizeExcludedEntityReferences(exportFile)
      records -= referenceSanitization.recordsRemoved
      stepEnd(s, 'ok', `${referenceSanitization.referencesRemoved.toLocaleString()} excluded-entity references removed · ${referenceSanitization.recordsRemoved.toLocaleString()} orphan details dropped`)
    }

    s = stepStart('Prepare bounded load files', 'split the export into transactions of at most 100,000 records')
    const loadChunks = await splitEntityExportForLoad(exportFile, join(tempDir, 'load-chunks'), 100000)
    const chunkRecords = loadChunks.reduce((total, chunk) => total + chunk.records, 0)
    if (chunkRecords !== records) throw new Error(`Chunk preparation counted ${chunkRecords} of ${records} sanitized records.`)
    stepEnd(s, 'ok', `${loadChunks.length} private transaction files · ${chunkRecords.toLocaleString()} records`)

    const stopped = await stopMoquiForJob(stepStart('Stop local Moqui'))
    wasUp = stopped.wasUp

    s = stepStart('Clear local commerce target', `${t.database} · fixed catalog and inventory tables only`)
    const cleared = await clearRemoteEntityTarget(t)
    if (!cleared.ok) { stepEnd(s, 'fail', cleared.error); throw new Error(`Could not clear the local commerce target: ${cleared.error}`) }
    stepEnd(s, 'ok', 'fixed commerce tables cleared; shared seed/configuration tables preserved')

    s = stepStart('Load into local MySQL', `bounded raw loads into pre-cleared ${t.database} commerce tables`)
    job.logFile = join(d.home, 'runtime', 'log', 'devkit-db-job.log')
    let loadedRecords = 0
    for (let index = 0; index < loadChunks.length; index++) {
      const chunk = loadChunks[index]
      s.detail = `transaction ${index + 1}/${loadChunks.length} · ${loadedRecords.toLocaleString()}/${records.toLocaleString()} committed`
      const loaded = await spawnEntityLoad(d.home, chunk.location, job.logFile, t, chunk.records)
      if (!loaded.ok) {
        stepEnd(s, 'fail', `transaction ${index + 1}/${loadChunks.length} · Moqui loader exit ${loaded.code}${loaded.error ? ' · ' + loaded.error : ''}`)
        throw new Error(`Entity load failed in transaction ${index + 1}/${loadChunks.length}: ${loaded.error || `exit ${loaded.code}`}. See the job log.`)
      }
      loadedRecords += loaded.records
    }
    stepEnd(s, 'ok', `${loadedRecords.toLocaleString()} exported records processed in ${loadChunks.length} committed transactions`)

    s = stepStart('Restart local Moqui')
    const started = await startMoqui(); restarted = started.ok
    if (!started.ok) throw new Error('Import succeeded but local Moqui did not restart: ' + started.message)
    const live = await waitForMoqui(d.httpPort || CONFIG.ports.moqui)
    stepEnd(s, live.ok ? 'ok' : 'fail', `${started.message} · ${live.detail}`)
    if (!live.ok) throw new Error('Import succeeded and Moqui launched, but its health check failed: ' + live.detail)

    job.receipt = {
      source: sourceOrigin, profile: profile.id, profileLabel: profile.label, entities: profile.entities,
      sourceRecords, records, bytes, release, sourceCommit: sourceSha, db: t.database,
      referenceSanitization, loadTransactions: loadChunks.length,
      note: `Imported the fixed ${profile.label} profile from ${sourceOrigin}. Authentication came from Keychain; the temporary export was deleted. Search indexes were not changed.`,
    }
    job.ok = true
  } catch (e) {
    job.ok = false
    job.error = String(e && e.message || e)
    if (wasUp && !restarted) {
      const s = stepStart('Recover local Moqui')
      const started = await startMoqui().catch((error) => ({ ok: false, message: String(error) }))
      restarted = started.ok
      stepEnd(s, started.ok ? 'ok' : 'fail', started.message)
    }
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {})
    job.done = true
    job.finishedAt = new Date().toISOString()
  }
}

async function stopMoquiForJob(s) {
  const mport = (await discover()).httpPort || CONFIG.ports.moqui
  const wasUp = (await portOwner(mport)).listening
  if (!wasUp) { stepEnd(s, 'skip', `nothing on :${mport}`); return { wasUp: false } }
  const stop = await stopMoqui()
  if (!stop.ok) { stepEnd(s, 'fail', stop.message); throw new Error('Moqui would not stop: ' + stop.message + ' — aborting before touching the database.') }
  const o = await portOwner(mport)
  if (o.listening) { stepEnd(s, 'fail', `:${mport} still held by pid ${o.pid}`); throw new Error('Moqui is still running after stop — aborting before DROP.') }
  stepEnd(s, 'ok', stop.message)
  return { wasUp: true }
}

async function runReset() {
  const job = JOB
  try {
    let s = stepStart('Resolve & verify target')
    const t = await resolveDbTarget()
    if (!t.ok) { stepEnd(s, 'fail', t.refuse); throw new Error(t.refuse) }                 // TOCTOU: re-resolved here, not trusted from confirm-time
    const ping = await dbPing(t, 'admin')
    if (!ping.ok) { stepEnd(s, 'fail', ping.error); throw new Error(`cannot connect as "${t.adminUser}": ${ping.error}. Set db.password (or db.adminUser/adminPassword) in devkit.config.json.`) }
    stepEnd(s, 'ok', `${t.database} @ ${t.host}:${t.port} (user ${t.user})`)
    const d = await discover(); if (!d.home) throw new Error('No MOQUI_HOME.')

    const { wasUp } = await stopMoquiForJob(stepStart('Stop Moqui'))

    s = stepStart('Drop + create database')
    const dc = await dropCreateDatabase(t)
    if (!dc.ok) { stepEnd(s, 'fail', `mysql exit ${dc.code}: ${dc.stderr}`); throw new Error('DROP/CREATE failed — the database may now be missing. ' + dc.stderr) }
    stepEnd(s, 'ok', `recreated \`${t.database}\``)

    const load = await resolveLoadCommand()
    s = stepStart('Load base data', load.command)
    job.logFile = join(d.home, 'runtime', 'log', 'devkit-db-job.log')
    const res = await spawnLoad(d.home, load.command, job.logFile, t)
    if (!res.ok) { stepEnd(s, 'fail', `gradle exit ${res.code}${res.error ? ' · ' + res.error : ''}`); throw new Error(`Load failed (exit ${res.code}) — the database is only partially loaded; re-run reset. See the job log.`) }
    stepEnd(s, 'ok', 'base data loaded')

    s = stepStart('Clear search index')
    const search = await clearSearch(); stepEnd(s, 'ok', summarizeSearch(search))

    s = stepStart('Restart Moqui')
    let restartMsg = 'was not running before reset'
    if (wasUp) { const st = await startMoqui(); stepEnd(s, st.ok ? 'ok' : 'fail', st.message); restartMsg = st.message } else stepEnd(s, 'skip', restartMsg)

    job.receipt = { db: t.database, host: t.host, load: load.command, loadSource: load.source, search, restarted: wasUp, restartMsg, note: 'Search was cleared. ES auto-reindexes on restart for DataFeeds with indexOnStartEmpty=Y; Solr stays empty until reindexed.' }
    job.ok = true
  } catch (e) { job.ok = false; job.error = String(e && e.message || e) }
  finally { job.done = true; job.finishedAt = new Date().toISOString() }
}

async function runRevert(file) {
  const job = JOB
  try {
    const d = await discover(); if (!d.home) throw new Error('No MOQUI_HOME.')
    const dir = snapshotDir(d.home)
    if (basename(file) !== file || !file.endsWith('.sql.gz')) throw new Error('Invalid snapshot reference.')
    const full = join(dir, file)
    if (dirname(full) !== dir || !existsSync(full)) throw new Error('Snapshot not found: ' + file)

    let s = stepStart('Verify snapshot integrity')
    if ((await run('gzip', ['-t', full], 120000)).failed) { stepEnd(s, 'fail', 'archive is corrupt'); throw new Error('Snapshot failed its gzip integrity check — aborting; your current database is untouched.') }
    stepEnd(s, 'ok', 'gzip -t passed')

    s = stepStart('Resolve & verify target')
    const t = await resolveDbTarget()
    if (!t.ok) { stepEnd(s, 'fail', t.refuse); throw new Error(t.refuse) }
    const ping = await dbPing(t, 'admin')
    if (!ping.ok) { stepEnd(s, 'fail', ping.error); throw new Error(`cannot connect as "${t.adminUser}": ${ping.error}.`) }
    stepEnd(s, 'ok', `${t.database} @ ${t.host}:${t.port}`)

    const { wasUp } = await stopMoquiForJob(stepStart('Stop Moqui'))

    s = stepStart('Drop + create database')
    const dc = await dropCreateDatabase(t)
    if (!dc.ok) { stepEnd(s, 'fail', `mysql exit ${dc.code}: ${dc.stderr}`); throw new Error('DROP/CREATE failed. ' + dc.stderr) }
    stepEnd(s, 'ok', `recreated \`${t.database}\``)

    s = stepStart('Restore snapshot')
    const r = await restoreFromFile(t, full)
    if (!r.ok) { stepEnd(s, 'fail', `gunzip ${r.gunzipCode} / mysql ${r.mysqlCode}: ${r.stderr}`); throw new Error('Restore failed — the database is only partially restored. ' + r.stderr) }
    stepEnd(s, 'ok', 'data restored from snapshot')

    s = stepStart('Clear search index')
    const search = await clearSearch(); stepEnd(s, 'ok', summarizeSearch(search))

    s = stepStart('Restart Moqui')
    let restartMsg = 'was not running before revert'
    if (wasUp) { const st = await startMoqui(); stepEnd(s, st.ok ? 'ok' : 'fail', st.message); restartMsg = st.message } else stepEnd(s, 'skip', restartMsg)

    job.receipt = { db: t.database, host: t.host, restoredFrom: file, search, restarted: wasUp, restartMsg, note: 'Search cleared to match the restored DB. ES rebuilds on restart (indexOnStartEmpty); if you use Solr, trigger your reindex.' }
    job.ok = true
  } catch (e) { job.ok = false; job.error = String(e && e.message || e) }
  finally { job.done = true; job.finishedAt = new Date().toISOString() }
}

async function runSnapshot(label) {
  const job = JOB
  try {
    const t = await resolveDbTarget(); if (!t.ok) throw new Error(t.refuse)
    const ping = await dbPing(t, 'user'); if (!ping.ok) throw new Error(`cannot connect as "${t.user}": ${ping.error}. Set db.password in devkit.config.json.`)
    const d = await discover(); if (!d.home) throw new Error('No MOQUI_HOME.')
    let s = stepStart('Preflight')
    if ((await run('mysqldump', ['--version'])).failed) { stepEnd(s, 'fail', 'mysqldump not on PATH'); throw new Error('mysqldump not found on PATH.') }
    const dir = await ensureSnapshotDir(d.home); stepEnd(s, 'ok', dir)

    s = stepStart('Dump + compress', `${t.database} → ${label}`)
    const base = `${label}__${new Date().toISOString().replace(/[:.]/g, '-')}`
    const finalPath = join(dir, base + '.sql.gz'); const partPath = finalPath + '.partial'
    const res = await dumpToFile(t, partPath)
    if (!res.ok) { try { await unlink(partPath) } catch { /* */ } stepEnd(s, 'fail', `mysqldump ${res.dumpCode}/gzip ${res.gzCode}: ${res.stderr}`); throw new Error('mysqldump failed; partial file removed. ' + res.stderr) }
    if ((await run('gzip', ['-t', partPath], 120000)).failed) { try { await unlink(partPath) } catch { /* */ } stepEnd(s, 'fail', 'integrity check failed'); throw new Error('Snapshot failed gzip -t; removed.') }
    await rename(partPath, finalPath)                                  // atomic: only a verified dump becomes "final"
    const st = await stat(finalPath)
    const gitBranch = (await run('git', ['-C', d.home, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim() || null
    const gitSha = (await run('git', ['-C', d.home, 'rev-parse', '--short', 'HEAD'])).stdout.trim() || null
    const meta = { label, file: base + '.sql.gz', db: t.database, host: t.host, created: new Date().toISOString(), bytes: st.size, gitBranch, gitSha }
    try { writeFileSync(join(dir, base + '.json'), JSON.stringify(meta, null, 2)) } catch { /* sidecar is best-effort */ }
    stepEnd(s, 'ok', `${(st.size / 1048576).toFixed(2)} MB`)
    job.receipt = meta; job.ok = true
  } catch (e) { job.ok = false; job.error = String(e && e.message || e) }
  finally { job.done = true; job.finishedAt = new Date().toISOString() }
}

// ── DB endpoints ──
async function apiDbTarget() {
  const t = await resolveDbTarget()
  const load = await resolveLoadCommand()
  if (!t.ok) return { ok: false, refuse: t.refuse, loadCommand: load.command, loadSource: load.source }
  const ping = await dbPing(t, 'user')
  const counts = ping.ok ? await dbCounts(t).catch(() => null) : null
  // non-destructive search detection
  const cfg = await apiConfig().catch(() => null)
  const search = (cfg && !cfg.error && cfg.search) || {}
  const esUrl = (search.elasticsearchUrl || 'http://127.0.0.1:9200').replace(/\/$/, '')
  const solrUrl = (search.solrAdminUrl || 'http://localhost:8983/solr').replace(/\/$/, '')
  const es = await esIndices(esUrl)
  const solr = await solrStatus(solrUrl)
  return {
    ok: true, dbConf: t.dbConf, host: t.host, port: t.port, database: t.database, user: t.user,
    adminUser: t.adminUser !== t.user ? t.adminUser : undefined,
    hasPassword: !!t.password, pwSource: t.pwSource, connect: ping, counts,
    loadCommand: load.command, loadSource: load.source, instance: t.instance,
    search: {
      es: es.up ? { url: esUrl, up: true, protected: !!es.protected, indexCount: es.indices ? es.indices.filter((i) => !i.startsWith('.')).length : null } : { url: esUrl, up: false },
      solr: solr.up ? { url: solrUrl, up: true, protected: !!solr.protected, collectionCount: solr.names ? solr.names.length : null } : { url: solrUrl, up: false },
    },
    snapshotDir: snapshotDir((await discover()).home || ''),
  }
}

async function apiSnapshotList() {
  const d = await discover(); if (!d.home) return { dir: null, snapshots: [] }
  const dir = snapshotDir(d.home)
  let names = []; try { names = await readdir(dir) } catch { return { dir, snapshots: [] } }
  const snaps = []
  for (const n of names) {
    if (!n.endsWith('.sql.gz')) continue
    const full = join(dir, n); let st; try { st = await stat(full) } catch { continue }
    const base = n.replace(/\.sql\.gz$/, ''); let meta = null
    try { meta = JSON.parse(await readFile(join(dir, base + '.json'), 'utf8')) } catch { /* no sidecar */ }
    const us = base.indexOf('__')
    snaps.push({ file: n, label: us >= 0 ? base.slice(0, us) : base, createdAt: (meta && meta.created) || st.mtime.toISOString(), bytes: st.size, db: meta && meta.db, gitBranch: meta && meta.gitBranch, gitSha: meta && meta.gitSha, complete: !!meta })
  }
  snaps.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  return { dir, snapshots: snaps }
}

async function apiJob() {
  if (!JOB) return { job: null }
  const job = { ...JOB }                              // JOB never holds a password — safe to return
  if (JOB.logFile) { const t = await tailFile(JOB.logFile, 64); if (t) job.logTail = t.tail }
  return { job }
}

function jobBusy() { return JOB && !JOB.done ? `A ${JOB.kind} job is already running — wait for it to finish.` : null }

async function apiSnapshotStart(label) {
  const busy = jobBusy(); if (busy) return { ok: false, message: busy }
  label = String(label || '').trim()
  if (!SNAP_LABEL_RE.test(label)) return { ok: false, message: 'Label must be 1–64 characters: letters, numbers, _ or - (no spaces, dots, or slashes).' }
  const t = await resolveDbTarget(); if (!t.ok) return { ok: false, message: t.refuse }
  newJob('snapshot'); runSnapshot(label)
  return { ok: true, started: true, jobId: JOB.id }
}

async function apiResetStart(confirm) {
  const busy = jobBusy(); if (busy) return { ok: false, message: busy }
  const t = await resolveDbTarget(); if (!t.ok) return { ok: false, message: t.refuse }
  if (String(confirm || '') !== t.database) return { ok: false, message: `Type the database name "${t.database}" exactly to confirm the reset.` }
  newJob('reset'); runReset()
  return { ok: true, started: true, jobId: JOB.id }
}

async function apiRevertStart(snapshot, confirm) {
  const busy = jobBusy(); if (busy) return { ok: false, message: busy }
  const t = await resolveDbTarget(); if (!t.ok) return { ok: false, message: t.refuse }
  if (String(confirm || '') !== t.database) return { ok: false, message: `Type the database name "${t.database}" exactly to confirm the revert (this permanently replaces your current data).` }
  const file = String(snapshot || '')
  if (basename(file) !== file || !file.endsWith('.sql.gz')) return { ok: false, message: 'Invalid snapshot reference.' }
  const d = await discover(); if (!d.home || !existsSync(join(snapshotDir(d.home), file))) return { ok: false, message: 'Snapshot not found.' }
  newJob('revert'); runRevert(file)
  return { ok: true, started: true, jobId: JOB.id }
}

async function apiRemoteEntityProfiles() {
  return {
    profiles: Object.values(remoteEntityProfiles).map(({ id, label, description, entities }) => ({
      id, label, description, entityCount: entities.length,
    })),
    defaults: { source: 'https://rails-uat.hotwax.io', account: 'codex.aditya', profile: 'catalog-inventory' },
  }
}

async function apiRemoteEntityImportStart(p) {
  const busy = jobBusy(); if (busy) return { ok: false, message: busy }
  const t = await resolveDbTarget(); if (!t.ok) return { ok: false, message: t.refuse }
  if (String(p.confirm || '') !== t.database) return { ok: false, message: `Type the database name "${t.database}" exactly to confirm local create/update.` }
  let source, profile
  try { source = normalizeHotwaxSource(p.source); profile = getRemoteEntityProfile(p.profile) }
  catch (e) { return { ok: false, message: String(e && e.message || e) } }
  const account = String(p.account || '').trim()
  if (!/^[A-Za-z0-9._@-]{1,128}$/.test(account)) return { ok: false, message: 'Keychain account contains unsupported characters.' }
  newJob('remote-import')
  runRemoteEntityImport({ source, account, profileId: profile.id })
  return { ok: true, started: true, jobId: JOB.id }
}

// ─── environment cloning: git-worktree based, own MySQL DB + port (localhost only) ──────────────
// Automates the proven local pattern (cf. moqui-products-dev): a self-contained env is git worktrees
// of the framework + runtime + each component, with its own runtime/conf overrides (port, DB, instance)
// and its own MySQL database. Stateless: envs are discovered by scanning CONFIG.envsDir.

const ENV_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,30}$/

async function gitRoot(dir) { const r = await run('git', ['-C', dir, 'rev-parse', '--show-toplevel']); return r.failed ? null : r.stdout.trim() }
async function gitHead(repo) { const r = await run('git', ['-C', repo, 'rev-parse', 'HEAD']); return r.failed ? null : r.stdout.trim() }
// The SOURCE repo backing a worktree (its main checkout) — needed to remove the worktree and delete its
// branch from the right place. --show-toplevel returns the worktree's own dir, which is wrong for that.
async function sourceRepoOf(dir) {
  const r = await run('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (r.failed) return null
  const common = r.stdout.trim()                        // e.g. /Users/.../oms/.git
  return common.endsWith('/.git') ? dirname(common) : (await gitRoot(dir))
}

async function freeMoquiPort() {
  for (let p = 8082; p <= 8099; p++) { if (!(await portOwner(p)).listening) return p }
  return null
}

// Read a few default-property values (comment-stripped) from a conf file.
async function readConfProps(confPath, names) {
  const out = {}
  let xml = ''
  try { xml = stripXmlComments(await readFile(confPath, 'utf8')) } catch { return out }
  for (const n of names) {
    const m = xml.match(new RegExp(`name="${n.replace(/[.\\]/g, '\\$&')}"\\s+value="([^"]*)"`))
    out[n] = m ? m[1] : ''
  }
  return out
}

// All cloned environments under CONFIG.envsDir (each subdir with runtime/conf/MoquiDevConf.xml is one).
async function discoverEnvs() {
  const dir = CONFIG.envsDir
  let names = []
  try { names = await readdir(dir) } catch { return { dir, envs: [] } }
  const instances = await discoverInstances()
  const active = await discover()
  const envs = []
  for (const name of names.sort()) {
    if (name.startsWith('.')) continue
    const home = join(dir, name)
    const confPath = join(home, 'runtime', 'conf', 'MoquiDevConf.xml')
    if (!existsSync(confPath)) continue
    const p = await readConfProps(confPath, ['webapp_http_port', 'entity_ds_database', 'entity_ds_db_conf', 'ofbiz.instance.name'])
    const port = Number(p.webapp_http_port) || null
    const inst = instances.find((i) => samePath(i.home, home) || (port && i.port === port))
    envs.push({
      name, home, port, db: p.entity_ds_database || '', dbConf: p.entity_ds_db_conf || '', instance: p['ofbiz.instance.name'] || name,
      running: !!inst, pid: inst ? inst.pid : null, active: samePath(home, active.home),
    })
  }
  envs.sort((a, b) => (a.port || 0) - (b.port || 0))
  return { dir, envs }
}
async function apiEnvs() { return discoverEnvs() }

// Resolve the source env's repos + current commits to worktree from.
async function envSourceLayout(srcHome) {
  const framework = await gitRoot(srcHome)
  let runtimeReal = srcHome
  try { runtimeReal = await realpath(join(srcHome, 'runtime')) } catch { /* */ }
  const runtime = await gitRoot(runtimeReal)
  const components = []
  let names = []
  try { names = await readdir(join(runtimeReal, 'component')) } catch { /* */ }
  for (const n of names.sort()) {
    if (n === 'README' || n.startsWith('.')) continue
    let target = join(runtimeReal, 'component', n)
    try { target = await realpath(target) } catch { /* */ }
    const repo = await gitRoot(target)
    if (repo) components.push({ name: n, repo, head: await gitHead(repo) })
  }
  return { framework, frameworkHead: await gitHead(framework), runtime, runtimeHead: await gitHead(runtime), runtimeReal, components }
}

// git worktree add (new branch env/<name>; fall back to detached if the branch already exists).
async function addWorktree(repo, dest, head, branch) {
  let r = await run('git', ['-C', repo, 'worktree', 'add', '-b', branch, dest, head], 120000)
  if (r.failed) r = await run('git', ['-C', repo, 'worktree', 'add', '--detach', dest, head], 120000)
  return { ok: !r.failed, error: r.failed ? (r.stderr || `exit ${r.code}`).slice(0, 300) : null }
}

async function cleanRuntimeData(envHome) {
  for (const d of ['log', 'elasticsearch', 'db', 'txlog', 'tmp', 'sessions']) {
    try { await rm(join(envHome, 'runtime', d), { recursive: true, force: true }) } catch { /* */ }
  }
}

// Inject the env's self-contained datasource + port + instance overrides into its MoquiDevConf.xml.
async function writeEnvConf(envHome, { port, db, instance, t }) {
  const confPath = join(envHome, 'runtime', 'conf', 'MoquiDevConf.xml')
  let xml
  try { xml = await readFile(confPath, 'utf8') } catch (e) { throw new Error(`env conf missing at ${confPath} (${e.code})`) }
  const block =
`    <!-- devkit-managed env "${instance}": own port, MySQL database, and instance name -->
    <default-property name="webapp_http_port" value="${port}"/>
    <default-property name="ofbiz.instance.name" value="${instance}"/>
    <default-property name="entity_ds_db_conf" value="mysql8"/>
    <default-property name="entity_ds_host" value="${t.host}"/>
    <default-property name="entity_ds_port" value="${t.port}"/>
    <default-property name="entity_ds_database" value="${db}"/>
    <default-property name="entity_ds_user" value="${t.user}"/>
    <default-property name="entity_ds_password" value="${t.password}"/>
`
  const i = xml.indexOf('<default-property')
  if (i >= 0) { const ls = xml.lastIndexOf('\n', i) + 1; xml = xml.slice(0, ls) + block + xml.slice(ls) }
  else xml = xml.replace('</moqui-conf>', block + '</moqui-conf>')
  writeFileSync(confPath, xml)
}

// mysqldump <src> | mysql <dst> — copy a database wholesale (Node stdio pipe, MYSQL_PWD env, no shell).
function copyDatabase(srcT, dstT) {
  return new Promise((resolve) => {
    const dump = spawn('mysqldump', ['--single-transaction', '--no-tablespaces', '--set-gtid-purged=OFF', '--column-statistics=0', ...mysqlArgs(srcT, 'user'), srcT.database], { env: { ...process.env, PATH: SANE_PATH, ...mysqlEnv(srcT.password) } })
    const load = spawn('mysql', [...mysqlArgs(dstT, 'user'), dstT.database], { env: { ...process.env, PATH: SANE_PATH, ...mysqlEnv(dstT.password) } })
    let derr = '', lerr = '', dc = null, lc = null, done = false
    const fin = () => { if (done || dc === null || lc === null) return; done = true; resolve({ ok: dc === 0 && lc === 0, dumpCode: dc, loadCode: lc, stderr: (lerr || derr).slice(0, 1200) }) }
    dump.stderr.on('data', (d) => { derr += d.toString().slice(0, 4000) })
    load.stderr.on('data', (d) => { lerr += d.toString().slice(0, 4000) })
    dump.stdout.pipe(load.stdin)
    dump.on('error', (e) => { derr += String(e); dc = dc ?? -1; try { load.stdin.end() } catch { /* */ } fin() })
    load.on('error', (e) => { lerr += String(e); lc = lc ?? -1; fin() })
    dump.on('close', (c) => { dc = c })
    load.on('close', (c) => { lc = c; fin() })
  })
}

// Boot a cloned env: gradlew run from its home (port + DB come from its own conf). Detached; not awaited.
function spawnRun(envHome, logFile) {
  let fd
  try { mkdirSync(dirname(logFile), { recursive: true }); fd = openSync(logFile, 'a'); writeSync(fd, `\n=== devkit env boot · ${new Date().toISOString()} ===\n`) } catch { return null }
  const env = { ...process.env, PATH: `${CONFIG.java11Home}/bin:${SANE_PATH}`, JAVA_HOME: CONFIG.java11Home }
  const child = spawn('bash', ['-c', `cd ${shq(envHome)} && exec ./gradlew --no-daemon run`], { detached: true, stdio: ['ignore', fd, fd], env })
  child.unref()
  return child.pid
}

async function runCreateEnv({ name, dbMode, boot }) {
  const job = JOB
  try {
    name = String(name || '').trim()
    if (!ENV_NAME_RE.test(name)) throw new Error('Name must be 1–31 chars: lowercase letters, numbers, _ or - (starting alphanumeric).')
    await mkdir(CONFIG.envsDir, { recursive: true })
    const envHome = join(CONFIG.envsDir, name)
    if (existsSync(envHome)) throw new Error(`An environment named "${name}" already exists at ${envHome}.`)

    let s = stepStart('Resolve source environment')
    const srcT = await resolveDbTarget()
    if (!srcT.ok) throw new Error(`source must be a local MySQL environment — ${srcT.refuse}`)
    const srcHome = (await discover()).home
    if (!srcHome) throw new Error('No source environment home resolved.')
    const layout = await envSourceLayout(srcHome)
    if (!layout.framework || !layout.runtime) throw new Error('Source framework/runtime are not git repositories — cannot worktree.')
    stepEnd(s, 'ok', `${name} ← ${srcHome} (${layout.components.length} components)`)

    const port = await freeMoquiPort()
    if (!port) throw new Error('No free port in 8082–8099 for the new environment.')
    const db = `${srcT.database}_${name}`.replace(/[^A-Za-z0-9_]/g, '_')
    const branch = `env/${name}`
    const envT = { ...srcT, database: db }

    s = stepStart('Create git worktrees', `branch ${branch}`)
    const comps = []
    const fw = await addWorktree(layout.framework, envHome, layout.frameworkHead, branch)
    if (!fw.ok) throw new Error(`framework worktree failed: ${fw.error}`)
    try { if (existsSync(join(envHome, 'runtime'))) await rm(join(envHome, 'runtime'), { recursive: true, force: true }) } catch { /* */ }
    const rt = await addWorktree(layout.runtime, join(envHome, 'runtime'), layout.runtimeHead, branch)
    if (!rt.ok) throw new Error(`runtime worktree failed: ${rt.error}`)
    for (const c of layout.components) {
      const w = await addWorktree(c.repo, join(envHome, 'runtime', 'component', c.name), c.head, branch)
      comps.push({ name: c.name, ok: w.ok, error: w.error })
    }
    const failed = comps.filter((c) => !c.ok)
    stepEnd(s, failed.length ? 'warn' : 'ok', `framework + runtime + ${comps.length - failed.length}/${comps.length} components${failed.length ? ` (failed: ${failed.map((c) => c.name).join(', ')})` : ''}`)

    // Components keep their resolved dependency jars in a gitignored lib/ — worktrees don't carry it, and
    // Moqui builds the cross-component classpath from lib/*.jar at config time, so without it components
    // fail to compile. COW-clone each source lib/ into the env (APFS cp -c → fast, space-shared).
    s = stepStart('Clone component dependencies (lib/)')
    let libs = 0
    for (const c of layout.components) {
      const srcLib = join(c.repo, 'lib')
      if (!existsSync(srcLib)) continue
      const r = await run('cp', ['-cR', srcLib, join(envHome, 'runtime', 'component', c.name, 'lib')], 180000)
      if (!r.failed) libs++
    }
    stepEnd(s, 'ok', `${libs} component lib/ dirs cloned (copy-on-write)`)

    s = stepStart('Write env config + clean runtime')
    await writeEnvConf(envHome, { port, db, instance: name, t: envT })
    await cleanRuntimeData(envHome)
    stepEnd(s, 'ok', `:${port} · db ${db} · instance ${name}`)

    s = stepStart('Create database', `${db} (${dbMode})`)
    const adminUser = srcT.adminUser, adminPw = srcT.adminPassword
    const ddl = `CREATE DATABASE IF NOT EXISTS \`${db}\` CHARACTER SET utf8mb4; GRANT ALL ON \`${db}\`.* TO '${srcT.user}'@'localhost'; FLUSH PRIVILEGES;`
    const cr = await run('mysql', ['-h', srcT.host, '-P', String(srcT.port), '-u', adminUser, '-e', ddl], 60000, mysqlEnv(adminPw))
    if (cr.failed) {
      const hint = /access denied/i.test(cr.stderr) ? ` — user "${adminUser}" cannot CREATE a new database. Set db.adminUser/db.adminPassword (e.g. root) in devkit.config.json.` : ''
      stepEnd(s, 'fail', (cr.stderr || '').slice(0, 300)); throw new Error('CREATE DATABASE failed: ' + (cr.stderr || '').slice(0, 200) + hint)
    }
    stepEnd(s, 'ok', `created ${db}`)

    if (dbMode === 'copy') {
      s = stepStart('Copy source data', `${srcT.database} → ${db}`)
      const cp = await copyDatabase(srcT, envT)
      if (!cp.ok) { stepEnd(s, 'fail', `mysqldump ${cp.dumpCode}/mysql ${cp.loadCode}: ${cp.stderr}`); throw new Error('DB copy failed: ' + cp.stderr) }
      stepEnd(s, 'ok', 'data copied')
    } else if (dbMode === 'fresh') {
      s = stepStart('Load base data (builds the env)', 'gradle — may take minutes')
      job.logFile = join(envHome, 'runtime', 'log', 'devkit-db-job.log')
      const load = await resolveLoadCommand()
      const res = await spawnLoad(envHome, load.command, job.logFile, envT)
      if (!res.ok) { stepEnd(s, 'fail', `gradle exit ${res.code}`); throw new Error(`Base-data load failed (exit ${res.code}). See the job log.`) }
      stepEnd(s, 'ok', 'base data loaded')
    } else {
      stepStart('Database contents'); stepEnd(JOB.steps[JOB.steps.length - 1], 'skip', 'empty — Moqui will populate on first boot')
    }

    let booted = false
    if (boot) {
      s = stepStart('Boot environment', `gradlew run on :${port}`)
      job.logFile = join(envHome, 'runtime', 'log', 'devkit-db-job.log')
      const pid = spawnRun(envHome, job.logFile)
      booted = !!pid
      stepEnd(s, booted ? 'ok' : 'fail', booted ? `building + starting (pid ${pid}); first build takes a few minutes — watch :${port}` : 'failed to launch')
    }

    job.receipt = { name, home: envHome, port, db, dbMode, instance: name, components: comps, booted, source: srcHome, note: boot ? `Building + booting on :${port}. First gradle build takes several minutes; it appears live in the picker when ready.` : `Created (stopped). Start it from the environment list.` }
    job.ok = true
  } catch (e) { job.ok = false; job.error = String(e && e.message || e) }
  finally { job.done = true; job.finishedAt = new Date().toISOString() }
}

async function runDeleteEnv(name) {
  const job = JOB
  try {
    const home = join(CONFIG.envsDir, name)
    if (!existsSync(home)) throw new Error(`No environment "${name}".`)
    const confPath = join(home, 'runtime', 'conf', 'MoquiDevConf.xml')
    const p = await readConfProps(confPath, ['webapp_http_port', 'entity_ds_database'])
    const port = Number(p.webapp_http_port) || null
    const db = p.entity_ds_database || ''

    let s = stepStart('Stop environment')
    if (port && (await portOwner(port)).listening) {
      const o = await portOwner(port); if (o.pid) await run('kill', [o.pid])
      await delay(1500); const a = await portOwner(port)
      if (a.listening) await run('kill', [a.pid])
      stepEnd(s, 'ok', `stopped :${port}`)
    } else stepEnd(s, 'skip', 'not running')

    s = stepStart('Drop database', db)
    if (db && DB_NAME_RE.test(db)) {
      const t = await resolveDbTarget()
      const r = await run('mysql', ['-h', t.ok ? t.host : '127.0.0.1', '-P', t.ok ? String(t.port) : '3306', '-u', t.ok ? t.adminUser : 'root', '-e', `DROP DATABASE IF EXISTS \`${db}\`;`], 60000, mysqlEnv(t.ok ? t.adminPassword : ''))
      stepEnd(s, r.failed ? 'warn' : 'ok', r.failed ? (r.stderr || '').slice(0, 200) : `dropped ${db}`)
    } else stepEnd(s, 'skip', 'no MySQL database recorded')

    s = stepStart('Remove worktrees + branches')
    // Resolve (repo, dest) for every worktree BEFORE removing anything — removing the framework worktree
    // (home) deletes the nested dirs and would orphan their registrations. Remove leaf-first:
    // components → runtime → framework.
    const dests = [
      ...(await safeReaddir(join(home, 'runtime', 'component'))).map((n) => join(home, 'runtime', 'component', n)),
      join(home, 'runtime'),
      home,
    ]
    const pairs = []
    for (const dest of dests) { if (!existsSync(dest)) continue; const repo = await sourceRepoOf(dest); if (repo) pairs.push({ repo, dest }) }
    const repos = new Set(); let removed = 0
    for (const { repo, dest } of pairs) {
      const rr = await run('git', ['-C', repo, 'worktree', 'remove', '--force', dest], 60000)
      if (!rr.failed) removed++
      repos.add(repo)
    }
    for (const repo of repos) { await run('git', ['-C', repo, 'worktree', 'prune']); await run('git', ['-C', repo, 'branch', '-D', `env/${name}`]) }
    try { await rm(home, { recursive: true, force: true }) } catch { /* */ }
    stepEnd(s, 'ok', `removed ${removed} worktrees + env/${name} branches across ${repos.size} repos; deleted ${home}`)

    job.receipt = { name, db, port, removedWorktrees: removed, repos: repos.size }
    job.ok = true
  } catch (e) { job.ok = false; job.error = String(e && e.message || e) }
  finally { job.done = true; job.finishedAt = new Date().toISOString() }
}
async function safeReaddir(dir) { try { return (await readdir(dir)).filter((n) => n !== 'README' && !n.startsWith('.')) } catch { return [] } }

async function apiEnvCreateStart(p) {
  const busy = jobBusy(); if (busy) return { ok: false, message: busy }
  const name = String(p.name || '').trim()
  if (!ENV_NAME_RE.test(name)) return { ok: false, message: 'Name must be 1–31 chars: lowercase letters, numbers, _ or - (starting alphanumeric).' }
  if (existsSync(join(CONFIG.envsDir, name))) return { ok: false, message: `An environment named "${name}" already exists.` }
  const dbMode = ['copy', 'fresh', 'empty'].includes(p.dbMode) ? p.dbMode : 'copy'
  const srcT = await resolveDbTarget()
  if (!srcT.ok) return { ok: false, message: `Select a local MySQL environment to clone first — ${srcT.refuse}` }
  newJob('create-env'); runCreateEnv({ name, dbMode, boot: !!p.boot })
  return { ok: true, started: true, jobId: JOB.id }
}

async function apiEnvDeleteStart(p) {
  const busy = jobBusy(); if (busy) return { ok: false, message: busy }
  const name = String(p.name || '').trim()
  if (!existsSync(join(CONFIG.envsDir, name))) return { ok: false, message: `No environment "${name}".` }
  if (String(p.confirm || '') !== name) return { ok: false, message: `Type the environment name "${name}" to confirm deletion.` }
  newJob('delete-env'); runDeleteEnv(name)
  return { ok: true, started: true, jobId: JOB.id }
}

async function envPort(name) {
  const p = await readConfProps(join(CONFIG.envsDir, name, 'runtime', 'conf', 'MoquiDevConf.xml'), ['webapp_http_port'])
  return Number(p.webapp_http_port) || null
}
async function apiEnvStart(name) {
  const home = join(CONFIG.envsDir, name)
  if (!existsSync(home)) return { ok: false, message: `No environment "${name}".` }
  const port = await envPort(name)
  if (port && (await portOwner(port)).listening) return { ok: false, message: `"${name}" already running on :${port}.` }
  const pid = spawnRun(home, join(home, 'runtime', 'log', 'devkit-db-job.log'))
  return pid ? { ok: true, message: `Booting "${name}" on :${port} (pid ${pid}). First gradle build takes a few minutes — watch the dot.` } : { ok: false, message: 'Failed to launch.' }
}
async function apiEnvStop(name) {
  const home = join(CONFIG.envsDir, name)
  if (!existsSync(home)) return { ok: false, message: `No environment "${name}".` }
  const port = await envPort(name)
  if (!port) return { ok: false, message: 'No port recorded for this env.' }
  const o = await portOwner(port)
  if (!o.listening) return { ok: false, message: `"${name}" is not running on :${port}.` }
  await run('kill', [o.pid]); await delay(1200)
  const a = await portOwner(port)
  return { ok: !a.listening, message: a.listening ? `:${port} still held by pid ${a.pid}.` : `Stopped "${name}" (:${port}).` }
}

// ─── HTTP server ──────────────────────────────────────────────────────────────
const ROUTES = {
  '/api/discover': apiDiscover,
  '/api/preflight': apiPreflight,
  '/api/config': apiConfig,
  '/api/components': apiComponents,
  '/api/status': apiStatus,
  '/api/diagnose': apiDiagnose,
  '/api/topology': apiTopology,
  '/api/local-apps': apiLocalApps,
  '/api/setup/plan': apiSetupPlan,
  '/api/version': () => checkVersion(true),
  '/api/db/target': apiDbTarget,
  '/api/db/snapshots': apiSnapshotList,
  '/api/db/remote-profiles': apiRemoteEntityProfiles,
  '/api/db/job': apiJob,
  '/api/instances': apiInstances,
  '/api/envs': apiEnvs,
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
      if (path === '/api/action') return sendJson(await apiAction(p.target, p.action))
      if (path === '/api/pick-folder') return sendJson(await pickFolder(p.which))
      if (path === '/api/settings') return sendJson(setPath(p.which, p.path))
      if (path === '/api/db/snapshot') return sendJson(await apiSnapshotStart(p.label))
      if (path === '/api/db/reset') return sendJson(await apiResetStart(p.confirm))
      if (path === '/api/db/revert') return sendJson(await apiRevertStart(p.snapshot, p.confirm))
      if (path === '/api/db/remote-import') return sendJson(await apiRemoteEntityImportStart(p))
      if (path === '/api/setup/bootstrap') return sendJson(await apiBootstrapStart(p.workspace, p.confirm))
      if (path === '/api/select-env') return sendJson(await apiSelectEnv(p.port))
      if (path === '/api/envs/create') return sendJson(await apiEnvCreateStart(p))
      if (path === '/api/envs/delete') return sendJson(await apiEnvDeleteStart(p))
      if (path === '/api/envs/start') return sendJson(await apiEnvStart(String(p.name || '').trim()))
      if (path === '/api/envs/stop') return sendJson(await apiEnvStop(String(p.name || '').trim()))
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
  console.log(`\n  moqui-console (hotwax/devkit ${VERSION})  →  http://${CONFIG.host}:${CONFIG.port}   (localhost only; Start/Stop/Restart enabled)`)
  console.log(`  mode: ${root ? 'PWA workspace ' + root : 'Moqui-only (pick your folders in Setup ⚙)'}`)
  discover(true).then((d) => {
    if (d.home) console.log(`  MOQUI_HOME = ${d.home}  (via ${d.source}${d.pid ? ', pid ' + d.pid : ''})\n`)
    else console.log('  No Moqui found — open http://127.0.0.1:7070, click Setup ⚙, and pick your Moqui project folder.\n')
  })
  checkVersion().then((v) => {
    if (v.stale) {
      console.log(`  ⚠ devkit ${v.latest} is available — you're running ${v.current} (likely a cached npx clone).`)
      console.log(`     Update:  ${v.updateCmd}\n`)
    }
  })
})
