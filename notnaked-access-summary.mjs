export function summarizeRepoAccess(access) {
  const missing = access?.missing || []
  if (!missing.length) {
    return {
      ok: true,
      headline: 'All NotNaked target repos are reachable or present locally.',
      missingRepos: [],
      detail: 'No missing repositories.',
    }
  }

  const missingRepos = missing.map((repo) => `${repo.owner}/${repo.repo}`)
  const tokenText = access.tokenPresent ? 'The provided token still cannot reach them.' : 'No GitHub token is active for this DevKit request.'
  const localMissing = missing.filter((repo) => repo.localPresent === false).length
  const github404 = missing.filter((repo) => repo.status === 404).length
  const statusBits = []
  if (localMissing) statusBits.push(`${localMissing}/${missing.length} missing locally`)
  if (github404) statusBits.push(`${github404}/${missing.length} returned GitHub 404`)
  const status = statusBits.length ? statusBits.join('; ') : `${missing.length} unavailable`

  return {
    ok: false,
    headline: `Missing NotNaked repos: ${missingRepos.join(', ')}`,
    missingRepos,
    detail: `${status}. ${tokenText}`,
  }
}
