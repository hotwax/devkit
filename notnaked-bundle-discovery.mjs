import { access } from 'node:fs/promises'
import { join, basename } from 'node:path'

export const ARCHIVE_EXTENSIONS = ['.zip', '.tar.gz', '.tgz', '.tar.bz2', '.tbz2', '.tar.xz', '.txz', '.tar']

async function exists(path) {
  try { await access(path); return true } catch { return false }
}

function repoName(repo) {
  return repo.repo || repo.name || basename(repo.path || '')
}

function repoPath(repo) {
  return repo.path || repoName(repo)
}

export function localRepoCandidatePaths(root, repo) {
  const name = repoName(repo)
  const path = repoPath(repo)
  return [...new Set([
    join(root, path),
    join(root, name),
    join(root, repo.owner || '', name),
    join(root, `${repo.owner || ''}-${name}`),
  ].filter((candidate) => !candidate.endsWith('/')))]
}

export function archiveCandidatePaths(root, repo) {
  return localRepoCandidatePaths(root, repo).flatMap((base) => ARCHIVE_EXTENSIONS.map((ext) => `${base}${ext}`))
}

export async function findCompleteLocalBundle(roots, repos) {
  const wanted = repos.filter((repo) => repo?.owner && repoName(repo))
  for (const root of [...new Set((roots || []).filter(Boolean))]) {
    const matches = []
    const missing = []
    for (const repo of wanted) {
      const candidates = [...localRepoCandidatePaths(root, repo), ...archiveCandidatePaths(root, repo)]
      const sourcePath = await firstExistingPath(candidates)
      if (sourcePath) matches.push({ repo: `${repo.owner}/${repoName(repo)}`, sourcePath })
      else missing.push(`${repo.owner}/${repoName(repo)}`)
    }
    if (wanted.length && matches.length === wanted.length) return { rootPath: root, matches, missing: [] }
    if (matches.length) continue
  }
  return null
}

async function firstExistingPath(paths) {
  for (const path of paths) {
    if (await exists(path)) return path
  }
  return null
}
