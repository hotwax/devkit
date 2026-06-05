#!/usr/bin/env node
// Checks whether the repos needed for the NotNaked local target are reachable.

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

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
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
const headers = token ? { Authorization: `Bearer ${token}` } : undefined

async function checkRepo(repo) {
  const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}`
  const localPath = join(WORKSPACE, repo.path || repo.repo)
  const localPresent = existsSync(localPath)
  const localGitPresent = existsSync(join(localPath, '.git'))
  try {
    const res = await fetch(url, { headers })
    let message = ''
    try { message = (await res.json()).message || '' } catch { /* ignore */ }
    return { ...repo, ok: res.ok || localPresent, reachable: res.ok, localPresent, localGitPresent, status: res.status, message, url }
  } catch (error) {
    return { ...repo, ok: localPresent, reachable: false, localPresent, localGitPresent, status: 'network', url, error: error.message }
  }
}

const publicResults = await Promise.all(manifest.publicRepos.map(checkRepo))
const privateResults = await Promise.all(manifest.privateRepos.map(checkRepo))
const all = [...publicResults, ...privateResults]

for (const result of all) {
  const label = result.reachable ? 'ok' : (result.localPresent ? (result.localGitPresent ? 'local' : 'archive') : 'missing')
  console.log(`${label.padEnd(7)} ${String(result.status).padEnd(7)} ${result.owner}/${result.repo}`)
  if (!result.reachable && result.message) console.log(`        ${result.message}`)
  if (result.localPresent && !result.localGitPresent) console.log(`        present locally as an archive checkout; install git/CLT to replace with a real clone`)
  if (!result.ok && result.accessNote) console.log(`        ${result.accessNote}`)
  if (!result.ok && result.purpose) console.log(`        ${result.purpose}`)
}

const missingPrivate = privateResults.filter((result) => !result.ok)
if (missingPrivate.length) {
  console.log('')
  console.log('NotNaked is not fully accessible yet. Grant access, set GITHUB_TOKEN/GH_TOKEN, or confirm the canonical repo names for:')
  for (const result of missingPrivate) console.log(`- ${result.owner}/${result.repo}`)
  process.exitCode = 2
}
