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
import { readFile, open, readdir, lstat, readlink, realpath, mkdir } from 'node:fs/promises'
import { existsSync, openSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

// ─── CONFIG (env-overridable defaults; per-project override via devkit.config.json) ──────────
const CONFIG = {
  host: '127.0.0.1',
  port: Number(process.env.MOQUI_CONSOLE_PORT || process.env.PORT) || 7070,
  java11Home: process.env.JAVA11_HOME || '/opt/homebrew/opt/openjdk@11', // mac/Homebrew default
  ports: { moqui: 8080, mysql: 3306, solr: 8983, elasticsearch: 9200 },
  moquiLiveness: 'http://localhost:8080/rest/s1/admin/checkLoginOptions',
  solrProbe: 'http://localhost:8983/solr/',              // 401 here still means "Solr is alive"
  // MOQUI_HOME is normally auto-discovered; these are explicit fallbacks (empty = rely on discovery).
  moquiHome: process.env.MOQUI_HOME || '',
  moquiRunScript: process.env.MOQUI_RUN_SCRIPT || '',     // optional: a script that cd's in + `gradlew run`
  screens: { moqui: 'moqui', solr: 'moqui-solr' },        // detached GNU screen session names this tool creates
  expectedComponentSet: 'oms-suite',                      // per maarg-docker-config local-setup doc
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

  if (!pre.java11.ok) add('error', 'Java 11 not found', `${CONFIG.java11} did not run.`, 'brew install openjdk@11  (or set JAVA11_HOME)')
  else if (!pre.bareJava.ok) add('info', 'Java 11 present but not on PATH', 'Fine — the run script / JAVA_HOME handles it.')

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

async function startMoqui() {
  const o = await portOwner(CONFIG.ports.moqui)
  if (o.listening) return { ok: false, message: `Moqui already running (pid ${o.pid} on :${CONFIG.ports.moqui}).` }
  if (CONFIG.moquiRunScript && existsSync(CONFIG.moquiRunScript)) {
    const r = await run('screen', ['-dmS', CONFIG.screens.moqui, 'bash', CONFIG.moquiRunScript])
    if (r.failed) return { ok: false, message: `Failed to launch screen: ${r.stderr || r.code}` }
    return { ok: true, message: `Launched Moqui in screen "${CONFIG.screens.moqui}" via the run script. Booting (~60s) — watch the status dot.` }
  }
  const d = await discover(true)
  if (!d.home) return { ok: false, message: 'No MOQUI_HOME found — set MOQUI_HOME or run from inside the checkout.' }
  const cmd = `cd ${d.home} && export JAVA_HOME=${CONFIG.java11Home} && export PATH="$JAVA_HOME/bin:$PATH" && exec ./gradlew run >> runtime/log/moqui-console.log 2>&1`
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

async function restartMoqui() {
  const s = await stopMoqui()
  for (let i = 0; i < 12; i++) { const o = await portOwner(CONFIG.ports.moqui); if (!o.listening) break; await delay(1000) }
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
  else return { ok: false, message: `Unknown setting "${which}"` }
  const saved = saveSettings(); _moquiHome = null // bust discovery cache so the change applies now
  return { ok: true, which, path: p, saved, settingsPath: SETTINGS_PATH }
}

async function pickFolder(which) {
  const label = which === 'moqui' ? 'your Moqui project folder (e.g. notnaked or moqui-framework)'
    : 'your accxui / PWA workspace folder'
  if (process.platform !== 'darwin') return { ok: false, message: `Native picker is macOS-only — type the path for ${label} in Setup instead.` }
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

// ─── onboarding wizard (Phase 1: read-only guide — detect state + prescribe the next command) ──
// Standard setup only: MySQL 8, oms-suite, default ports. No in-flow customization.
const SETUP_DB = { conf: 'mysql8', host: '127.0.0.1', port: 3306, database: 'moqui', user: 'moqui', password: 'moqui' }
const SETUP_DEFAULT_WS = join(homedir(), 'moqui-framework')
const setupWorkspace = () => ((SETTINGS.moquiHome || '').trim() || SETUP_DEFAULT_WS)

async function apiSetupPlan() {
  const ws = setupWorkspace()
  const d = await discover()
  const home = (d.home && existsSync(d.home)) ? d.home : ws
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
  const cfg = await apiConfig().catch(() => null) // effective merged config (authoritative once Moqui has run)
  let dbConfigured = !!(cfg && cfg.db && cfg.db.conf === 'mysql8' && cfg.db.database)
  if (!dbConfigured) {
    try {
      const x = readFileSync(join(home, 'runtime', 'conf', 'MoquiDevConf.xml'), 'utf8')
      dbConfigured = /entity_ds_db_conf"\s+value="mysql8"/.test(x) && /entity_ds_database"\s+value="[^"]+"/.test(x)
    } catch { /* not configured */ }
  }
  const omssetupOk = existsSync(join(home, 'runtime', 'conf', 'jwtKey.txt'))
  const moquiUp = live.ok && live.status === 200
  const searchOk = esUp || solr

  const steps = [
    { phase: 'Prerequisites', id: 'brew', title: 'Homebrew', why: 'Package manager for the rest.', status: brewOk ? 'done' : 'warn', manual: !brewOk, detail: brewOk ? 'installed' : 'install in a real Terminal — it prompts for your password', command: brewOk ? null : '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"' },
    { phase: 'Prerequisites', id: 'git', title: 'Git', why: 'To clone Moqui + components.', status: gitOk ? 'done' : 'todo', command: gitOk ? null : 'xcode-select --install   # or: brew install git' },
    { phase: 'Prerequisites', id: 'jdk11', title: 'JDK 11', why: 'Moqui runs on Java 11.', status: jdkOk ? 'done' : 'todo', detail: jdkOk ? J : 'not found', command: jdkOk ? null : 'brew install openjdk@11' },
    { phase: 'Prerequisites', id: 'mysql', title: 'MySQL 8', why: 'Standard OMS database.', status: mysqlUp ? 'done' : (mysqlBin ? 'warn' : 'todo'), detail: mysqlUp ? 'running on :3306' : (mysqlBin ? 'installed, not running' : 'not installed'), command: mysqlUp ? null : (mysqlBin ? 'brew services start mysql' : 'brew install mysql && brew services start mysql') },
    { phase: 'Prerequisites', id: 'node', title: 'Node 18+', why: 'Runs devkit + PWA dev servers.', status: 'done', detail: 'devkit is running on ' + process.version },
    { phase: 'Prerequisites', id: 'repo', title: 'HotWax repo access', why: 'oms-suite components are private.', status: repoOk ? 'done' : 'warn', detail: repoOk ? 'authenticated to github.com/hotwax' : 'no access detected — add an SSH key or run `gh auth login`', command: repoOk ? null : 'gh auth login   # or add an SSH key with access to github.com/hotwax' },

    { phase: 'Source', id: 'workspace', title: 'Workspace folder', why: 'Where Moqui gets cloned.', status: 'info', editable: true, detail: home + (existsSync(home) ? '  (exists)' : '  (will be created)') },
    { phase: 'Source', id: 'framework', title: 'Clone moqui-framework', why: 'The Moqui engine.', status: frameworkOk ? 'done' : 'todo', command: frameworkOk ? null : `git clone -b main https://github.com/hotwax/moqui-framework.git "${home}"` },
    { phase: 'Source', id: 'runtime', title: 'Clone moqui-runtime', why: 'The runtime Moqui loads.', status: runtimeOk ? 'done' : (frameworkOk ? 'todo' : 'blocked'), command: runtimeOk ? null : `cd "${home}" && git clone -b main https://github.com/hotwax/moqui-runtime.git runtime` },
    { phase: 'Source', id: 'maarg', title: 'Clone maarg-docker-config + myaddons.xml', why: 'Declares the OMS components.', status: maargOk ? 'done' : (runtimeOk ? 'todo' : 'blocked'), command: maargOk ? null : `cd "${home}" && git clone -b main https://github.com/hotwax/hotwax-maarg-docker-config.git runtime/component/maarg-docker-config && cp runtime/component/maarg-docker-config/myaddons.xml myaddons.xml` },

    { phase: 'Components', id: 'components', title: 'Get oms-suite component set', why: 'The 13 standard OMS components.', status: componentsOk ? 'done' : (maargOk ? 'todo' : 'blocked'), detail: exp?.counts ? `${exp.counts.present}/${exp.counts.expected} present` : 'needs maarg-docker-config first', command: componentsOk ? null : gradle('getComponentSet -PcomponentSet=oms-suite') },

    { phase: 'Database', id: 'dbcreate', title: 'Create database + user', why: `Standard db "${SETUP_DB.database}", user "${SETUP_DB.user}".`, status: dbConfigured ? 'done' : (mysqlUp ? 'todo' : 'blocked'), command: `mysql -u root -e "CREATE DATABASE IF NOT EXISTS ${SETUP_DB.database}; CREATE USER IF NOT EXISTS '${SETUP_DB.user}'@'localhost' IDENTIFIED BY '${SETUP_DB.password}'; GRANT ALL ON ${SETUP_DB.database}.* TO '${SETUP_DB.user}'@'localhost'; FLUSH PRIVILEGES;"` },
    { phase: 'Database', id: 'dbconfig', title: 'Point Moqui at MySQL', why: 'Write the datasource props.', status: dbConfigured ? 'done' : (frameworkOk ? 'todo' : 'blocked'), detail: 'runtime/conf/MoquiDevConf.xml', command: `# add under <entity-facade> in "${home}"/runtime/conf/MoquiDevConf.xml:\n<default-property name="entity_ds_db_conf" value="mysql8"/>\n<default-property name="entity_ds_host" value="${SETUP_DB.host}"/>\n<default-property name="entity_ds_port" value="${SETUP_DB.port}"/>\n<default-property name="entity_ds_database" value="${SETUP_DB.database}"/>\n<default-property name="entity_ds_user" value="${SETUP_DB.user}"/>\n<default-property name="entity_ds_password" value="${SETUP_DB.password}"/>` },

    { phase: 'Initialize', id: 'omssetup', title: 'Run omssetup', why: 'Generates JWT + encryption keys.', status: omssetupOk ? 'done' : (frameworkOk ? 'todo' : 'blocked'), command: gradle('omssetup') },
    { phase: 'Initialize', id: 'data', title: 'Load seed + install + ext data', why: 'Populates the database (slow, re-runnable).', status: 'todo', detail: 'best-effort detection; safe to re-run', command: `${gradle('loadProduction -Ptypes=seed,seed-initial,install -Praw')}\n${gradle('loadProduction -Ptypes=ext-seed -Praw')}\n${gradle('loadProduction -Ptypes=ext,ext-user -Praw')}` },

    { phase: 'Search (optional)', id: 'search', title: 'OpenSearch / Solr', why: 'Powers search-backed features — optional.', status: searchOk ? 'done' : 'optional', optional: true, command: searchOk ? null : `${gradle('downloadOpenSearch')} && ${gradle('startElasticSearch')}` },

    { phase: 'Run', id: 'run', title: 'Start Moqui', why: 'Launch the server at :8080.', status: moquiUp ? 'done' : (omssetupOk ? 'todo' : 'blocked'), command: moquiUp ? null : gradle('run') },
  ]
  const total = steps.filter((s) => s.status !== 'info').length
  const done = steps.filter((s) => s.status === 'done').length
  return { workspace: home, java11Home: J, db: SETUP_DB, summary: { done, total }, steps }
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
