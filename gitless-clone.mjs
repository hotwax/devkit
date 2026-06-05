import fs from 'node:fs'
import git from 'isomorphic-git'
import http from 'isomorphic-git/http/node'

export function githubCloneUrl(owner, repo) {
  return `https://github.com/${owner}/${repo}.git`
}

export function githubTokenAuth(token) {
  const clean = String(token || '').trim()
  if (!clean) return undefined
  return () => ({ username: clean, password: 'x-oauth-basic' })
}

export async function gitlessClone({ owner, repo, branch, dir, token, depth = 1 }) {
  await git.clone({
    fs,
    http,
    dir,
    url: githubCloneUrl(owner, repo),
    ref: branch || 'main',
    singleBranch: true,
    depth,
    onAuth: githubTokenAuth(token),
  })
}
