#!/usr/bin/env node
// Cold-start HotWax/Moqui workspace bootstrap.
// Uses native git when available, pure-JS Git clones on fresh Macs, and GitHub archives as a final fallback.

import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { readFile, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { gitlessClone } from './gitless-clone.mjs'
import { mergePwaDependencies } from './pwa-dependency-bridge.mjs'

const WORKSPACE = process.env.HOTWAX_WORKSPACE || join(homedir(), 'Documents', 'github')
const MOQUI_HOME = join(WORKSPACE, 'moqui-framework')
const ACCXUI_HOME = join(WORKSPACE, 'accxui')
const DEVKIT_DIR = dirname(fileURLToPath(import.meta.url))

async function readTarget() {
  const base = JSON.parse(await readFile(new URL('./notnaked-target.json', import.meta.url), 'utf8'))
  const overridePath = join(WORKSPACE, 'notnaked-target.local.json')
  try {
    const override = JSON.parse(await readFile(overridePath, 'utf8'))
    return { ...base, ...override, _overridePath: overridePath }
  } catch {
    return base
  }
}

const TARGET = await readTarget()
const requiredRepos = [...TARGET.publicRepos, ...TARGET.pwaApps].map((repo) => [repo.owner, repo.repo, repo.branch, repo.path])
const optionalRepos = (TARGET.optionalRepos || []).map((repo) => [repo.owner, repo.repo, repo.branch, repo.path])
const privateNotNakedRepos = TARGET.privateRepos
const activeComponents = TARGET.activeComponents.map((component) => [component.source, component.link])
const conditionalComponents = (TARGET.conditionalComponents || []).map((component) => [component.source, component.link, component.requires || []])
const pwaApps = TARGET.pwaApps.map((app) => app.path.replace(/^apps\//, ''))
const archiveBackupDir = join(WORKSPACE, '.archive-backups')

function log(message) {
  console.log(message)
}

function githubToken() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
}

function run(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: options.stdio || 'inherit', ...options })
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${bin} ${args.join(' ')} exited ${code}`)))
  })
}

function runQuiet(bin, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: 'ignore', ...options })
    child.on('error', () => resolve(false))
    child.on('exit', (code) => resolve(code === 0))
  })
}

async function tryRun(bin, args, options = {}) {
  try {
    await run(bin, args, options)
    return true
  } catch {
    return false
  }
}

async function developerToolsAvailable() {
  if (process.platform !== 'darwin') return true
  return runQuiet('xcode-select', ['-p'])
}

async function gitAvailable() {
  if (!(await developerToolsAvailable())) return false
  return runQuiet('git', ['--version'])
}

async function download(url, dest, redirects = 5) {
  const token = githubToken()
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined
  const res = await fetch(url, { headers, redirect: 'manual' })
  if (res.status >= 300 && res.status < 400 && res.headers.get('location') && redirects > 0) {
    return download(res.headers.get('location'), dest, redirects - 1)
  }
  if (!res.ok) throw new Error(`${url} returned ${res.status}`)
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
}

async function githubRepoMeta(owner, repo) {
  const token = githubToken()
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers })
  if (!res.ok) throw new Error(`repo metadata ${owner}/${repo} returned ${res.status}`)
  return res.json()
}

async function fallbackBranches(owner, repo, branch) {
  const out = [branch || 'main']
  try {
    const meta = await githubRepoMeta(owner, repo)
    if (meta.default_branch && !out.includes(meta.default_branch)) out.push(meta.default_branch)
  } catch {
    /* repo metadata may be private/unreachable; keep manifest/default guesses */
  }
  for (const guess of ['main', 'master']) if (!out.includes(guess)) out.push(guess)
  return out
}

async function cloneRepo(owner, repo, branch, destRel, mode = 'git') {
  const dest = join(WORKSPACE, destRel)
  mkdirSync(dirname(dest), { recursive: true })
  let backup = ''
  if (existsSync(dest)) {
    if (existsSync(join(dest, '.git'))) {
      log(`exists clone ${destRel}`)
      return
    }
    mkdirSync(archiveBackupDir, { recursive: true })
    backup = join(archiveBackupDir, `${destRel.replaceAll('/', '__')}-${Date.now()}`)
    mkdirSync(dirname(backup), { recursive: true })
    await rename(dest, backup)
    log(`upgrade archive ${destRel} -> ${mode} clone (backup: ${backup})`)
  } else {
    log(`${mode} clone ${owner}/${repo}#${branch} -> ${destRel}`)
  }
  let lastError = null
  for (const candidate of await fallbackBranches(owner, repo, branch)) {
    try {
      if (candidate !== branch) log(`retry clone ${owner}/${repo} using default/alternate branch ${candidate}`)
      if (mode === 'git') {
        await run('git', ['clone', '--branch', candidate, '--single-branch', `https://github.com/${owner}/${repo}.git`, dest], {
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        })
      } else {
        await gitlessClone({ owner, repo, branch: candidate, dir: dest, token: githubToken() })
      }
      return
    } catch (error) {
      lastError = error
      rmSync(dest, { recursive: true, force: true })
    }
  }
  if (backup && existsSync(backup) && !existsSync(dest)) await rename(backup, dest)
  throw lastError
}

async function fetchRepoArchive(owner, repo, branch, destRel) {
  const dest = join(WORKSPACE, destRel)
  if (existsSync(dest)) {
    log(`exists ${destRel}`)
    return
  }
  mkdirSync(dirname(dest), { recursive: true })
  let lastError = null
  for (const candidate of await fallbackBranches(owner, repo, branch)) {
    const zip = join(tmpdir(), `${owner}-${repo}-${candidate}.zip`)
    const unzipDir = join(tmpdir(), `${owner}-${repo}-${candidate}-${Date.now()}`)
    await rm(zip, { force: true })
    await rm(unzipDir, { recursive: true, force: true })
    try {
      log(`fetch ${owner}/${repo}#${candidate} -> ${destRel}`)
      await download(`https://api.github.com/repos/${owner}/${repo}/zipball/${candidate}`, zip)
      mkdirSync(unzipDir, { recursive: true })
      await run('unzip', ['-q', zip, '-d', unzipDir])
      const roots = (await readdir(unzipDir)).filter((name) => name !== '__MACOSX' && name !== '.DS_Store')
      if (roots.length !== 1) throw new Error(`archive ${owner}/${repo} extracted ${roots.length} root folders`)
      await rename(join(unzipDir, roots[0]), dest)
      await rm(unzipDir, { recursive: true, force: true })
      return
    } catch (error) {
      await rm(unzipDir, { recursive: true, force: true })
      lastError = error
    }
  }
  throw lastError
}

async function fetchRepo(owner, repo, branch, destRel, sourceMode) {
  const dest = join(WORKSPACE, destRel)
  if (repo === 'devkit' && existsSync(join(dest, '.git')) && dest === DEVKIT_DIR) {
    log(`exists active devkit clone ${destRel}`)
    return
  }
  if (sourceMode === 'git') return cloneRepo(owner, repo, branch, destRel, 'git')
  if (sourceMode === 'gitless') {
    try {
      return await cloneRepo(owner, repo, branch, destRel, 'gitless')
    } catch (error) {
      log(`gitless clone failed for ${owner}/${repo}: ${error.message}; falling back to archive`)
    }
  }
  return fetchRepoArchive(owner, repo, branch, destRel)
}

async function tryFetchRepo(owner, repo, branch, destRel, sourceMode) {
  try {
    await fetchRepo(owner, repo, branch, destRel, sourceMode)
    return { ok: true, owner, repo, destRel, mode: sourceMode }
  } catch (error) {
    log(`skip ${owner}/${repo}: ${error.message}`)
    return { ok: false, owner, repo, destRel, mode: sourceMode, error: error.message }
  }
}

async function tryFetchPrivateRepo(repo, sourceMode) {
  const dest = join(WORKSPACE, repo.path || repo.repo)
  if (!githubToken()) {
    if (existsSync(dest)) {
      log(`exists private/local fallback ${repo.path || repo.repo} (set GITHUB_TOKEN to replace it with the canonical clone)`)
      return { ok: true, owner: repo.owner, repo: repo.repo, destRel: repo.path || repo.repo, mode: 'local' }
    }
    const message = 'no GitHub token available for private/canonical NotNaked repo'
    log(`skip private ${repo.owner}/${repo.repo}: ${message}`)
    return { ok: false, owner: repo.owner, repo: repo.repo, destRel: repo.path || repo.repo, mode: sourceMode, error: message }
  }
  return tryFetchRepo(repo.owner, repo.repo, repo.branch, repo.path, sourceMode)
}

function link(source, dest) {
  rmSync(dest, { recursive: true, force: true })
  symlinkSync(source, dest)
}

async function pruneComponentLinks(componentDir, keepNames) {
  const keep = new Set(keepNames)
  let entries = []
  try { entries = await readdir(componentDir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (entry.name === 'README' || keep.has(entry.name)) continue
    if (entry.isSymbolicLink()) {
      rmSync(join(componentDir, entry.name), { recursive: true, force: true })
      log(`removed extra component link ${entry.name}`)
    }
  }
}

async function copyMaargMyaddons() {
  const source = join(WORKSPACE, 'maarg-docker-config', 'myaddons.xml')
  if (!existsSync(source)) return
  writeFileSync(join(MOQUI_HOME, 'myaddons.xml'), await readFile(source))
}

async function ensureMysqlDevConf() {
  const confPath = join(MOQUI_HOME, 'runtime', 'conf', 'MoquiDevConf.xml')
  let conf = await readFile(confPath, 'utf8')
  const activeConf = () => conf.replace(/<!--[\s\S]*?-->/g, '')
  const mysqlDefaults = [
    '    <default-property name="entity_ds_db_conf" value="mysql8"/>',
    '    <default-property name="entity_ds_host" value="127.0.0.1"/>',
    '    <default-property name="entity_ds_port" value="3306"/>',
    '    <default-property name="entity_ds_database" value="moqui"/>',
    '    <default-property name="entity_ds_user" value="moqui"/>',
    '    <default-property name="entity_ds_password" value="moqui"/>',
  ].join('\n')

  conf = conf.replace(/    <entity-facade query-stats="true">[\s\S]*?    <\/entity-facade>/, '    <entity-facade query-stats="true"/>')
  if (!activeConf().includes('name="entity_ds_db_conf" value="mysql8"')) {
    conf = conf.replace(
      '    <default-property name="entity_lock_track" value="true"/>',
      `    <default-property name="entity_lock_track" value="true"/>\n${mysqlDefaults}`,
    )
  }
  writeFileSync(confPath, conf)
}

async function ensureMysqlGrants() {
  const mysql = join(WORKSPACE, 'toolchains', 'mysql', 'bin', 'mysql')
  if (!existsSync(mysql)) {
    log('skip mysql grants: bundled mysql client not found')
    return
  }

  const sql = [
    "CREATE DATABASE IF NOT EXISTS moqui CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci",
    "CREATE USER IF NOT EXISTS 'moqui'@'%' IDENTIFIED BY 'moqui'",
    "CREATE USER IF NOT EXISTS 'moqui'@'127.0.0.1' IDENTIFIED BY 'moqui'",
    "CREATE USER IF NOT EXISTS 'moqui'@'localhost' IDENTIFIED BY 'moqui'",
    "GRANT ALL PRIVILEGES ON moqui.* TO 'moqui'@'%'",
    "GRANT ALL PRIVILEGES ON moqui.* TO 'moqui'@'127.0.0.1'",
    "GRANT ALL PRIVILEGES ON moqui.* TO 'moqui'@'localhost'",
    "GRANT XA_RECOVER_ADMIN ON *.* TO 'moqui'@'%'",
    "GRANT XA_RECOVER_ADMIN ON *.* TO 'moqui'@'127.0.0.1'",
    "GRANT XA_RECOVER_ADMIN ON *.* TO 'moqui'@'localhost'",
    "FLUSH PRIVILEGES",
  ].join('; ')
  const ok = await tryRun(mysql, ['--protocol=tcp', '-h127.0.0.1', '-uroot', '-e', sql])
  log(ok ? 'configured mysql moqui user/grants' : 'skip mysql grants: mysql is not reachable on 127.0.0.1:3306')
}

async function ensurePwaDependencyBridge() {
  const rootPackagePath = join(ACCXUI_HOME, 'package.json')
  if (!existsSync(rootPackagePath)) return
  const rootPackage = JSON.parse(await readFile(rootPackagePath, 'utf8'))
  const appPackages = []
  for (const app of pwaApps) {
    const packagePath = join(WORKSPACE, 'apps', app, 'package.json')
    if (existsSync(packagePath)) appPackages.push(JSON.parse(await readFile(packagePath, 'utf8')))
  }
  const merged = mergePwaDependencies(rootPackage, appPackages)
  if (merged.changed) {
    writeFileSync(rootPackagePath, JSON.stringify(merged.packageJson, null, 2) + '\n')
    log('merged PWA app dependencies into accxui root package for symlinked app launches')
  }
  const pnpm = join(WORKSPACE, 'toolchains', 'bin', 'pnpm')
  if (existsSync(pnpm) && (merged.changed || !existsSync(join(ACCXUI_HOME, 'node_modules')))) {
    await tryRun(pnpm, ['install', '--force', '--dir', ACCXUI_HOME, '--dangerously-allow-all-builds'])
  }
  for (const app of pwaApps) {
    const appNodeModules = join(WORKSPACE, 'apps', app, 'node_modules')
    if (existsSync(join(ACCXUI_HOME, 'node_modules'))) link(join(ACCXUI_HOME, 'node_modules'), appNodeModules)
  }
}

async function componentName(folder) {
  const source = Array.isArray(folder) ? folder[0] : folder
  const xml = await readFile(join(WORKSPACE, source, 'component.xml'), 'utf8')
  return (xml.match(/<component[^>]*\bname="([^"]+)"/) || [])[1] || folder
}

function componentSource(component) {
  return Array.isArray(component) ? component[0] : component
}

function componentLinkName(component) {
  return Array.isArray(component) ? component[1] : component
}

function componentReady(source) {
  return existsSync(join(WORKSPACE, source, 'component.xml'))
}

function enabledConditionalComponents() {
  return conditionalComponents.filter(([source, , requires]) =>
    componentReady(source) && requires.every((required) => componentReady(required)))
}

async function main() {
  mkdirSync(WORKSPACE, { recursive: true })
  const useGit = await gitAvailable()
  const sourceMode = useGit ? 'git' : 'gitless'
  log(useGit ? 'source mode: native git clone' : 'source mode: pure-JS git clone (Apple Command Line Tools not available)')
  for (const repo of requiredRepos) await fetchRepo(...repo, sourceMode)
  const optionalResults = []
  for (const repo of optionalRepos) {
    optionalResults.push(await tryFetchRepo(...repo, sourceMode))
  }
  const privateResults = []
  for (const repo of privateNotNakedRepos) {
    privateResults.push(await tryFetchPrivateRepo(repo, sourceMode))
  }

  if (!existsSync(join(MOQUI_HOME, 'runtime'))) {
    await run('cp', ['-a', join(WORKSPACE, 'moqui-runtime'), join(MOQUI_HOME, 'runtime')])
  }
  await ensureMysqlDevConf()
  await ensureMysqlGrants()
  mkdirSync(join(MOQUI_HOME, 'runtime', 'component'), { recursive: true })
  const componentsToLink = [...activeComponents, ...enabledConditionalComponents()]
  await pruneComponentLinks(join(MOQUI_HOME, 'runtime', 'component'), componentsToLink.map(componentLinkName))
  for (const c of componentsToLink) {
    link(join(WORKSPACE, componentSource(c)), join(MOQUI_HOME, 'runtime', 'component', componentLinkName(c)))
  }
  await copyMaargMyaddons()

  mkdirSync(join(ACCXUI_HOME, 'apps'), { recursive: true })
  for (const app of pwaApps) {
    link(join(WORKSPACE, 'apps', app), join(ACCXUI_HOME, 'apps', app))
  }
  link(join(ACCXUI_HOME, 'common'), join(WORKSPACE, 'common'))
  link(join(ACCXUI_HOME, 'tsconfig.json'), join(WORKSPACE, 'tsconfig.json'))
  await ensurePwaDependencyBridge()

  writeFileSync(join(WORKSPACE, 'devkit.config.json'), JSON.stringify({
    moquiHome: MOQUI_HOME,
    accxuiHome: ACCXUI_HOME,
    java11Home: process.env.JAVA11_HOME || (existsSync(join(WORKSPACE, 'toolchains', 'jdk-11', 'bin', 'java'))
      ? join(WORKSPACE, 'toolchains', 'jdk-11')
      : '/opt/homebrew/opt/openjdk@11'),
  }, null, 2) + '\n')

  const names = await Promise.all(componentsToLink.map(componentName))
  log(`ready ${WORKSPACE}`)
  if (!useGit) log('Apple Command Line Tools are still recommended, but DevKit can create real .git checkouts with pure-JS Git on this machine')
  log(`active components (${names.length}): ${names.join(', ')}`)
  log(`pwa apps (${pwaApps.length}): ${pwaApps.join(', ')}`)
  const missingOptional = optionalResults.filter((result) => !result.ok && !existsSync(join(WORKSPACE, result.destRel)))
  if (missingOptional.length) {
    log('optional repos skipped:')
    for (const missing of missingOptional) log(`- ${missing.owner}/${missing.repo}: ${missing.error}`)
  }
  const missingPrivate = privateResults.filter((result) => !result.ok && !existsSync(join(WORKSPACE, result.destRel)))
  if (missingPrivate.length) {
    log('private NotNaked repos still required for full PWA/API verification:')
    for (const missing of missingPrivate) {
      const meta = privateNotNakedRepos.find((repo) => repo.repo === missing.repo)
      log(`- ${missing.owner}/${missing.repo}: ${meta?.purpose || missing.error}`)
    }
  }
}

main().catch((err) => {
  console.error(err.stack || String(err))
  process.exit(1)
})
