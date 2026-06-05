function repoBundleArchiveNames(repo) {
  return [`${repo.repo}.zip`, `${repo.owner}-${repo.repo}.zip`, `${repo.repo}.tar.gz`, `${repo.owner}-${repo.repo}.tar.gz`, `${repo.owner}/${repo.repo}.zip`]
}

export function privateRepoBundleRequestFromSource(source) {
  return (source.rows || [])
    .filter((repo) => repo.state === 'missing' || (repo.state === 'archive' && repo.purpose))
    .map((repo) => ({
      repo: `${repo.owner}/${repo.repo}`,
      owner: repo.owner,
      name: repo.repo,
      targetPath: repo.path,
      state: repo.state,
      reason: repo.state === 'archive' ? 'canonical git checkout or archive needed to replace current fallback' : 'missing locally',
      acceptableArchiveNames: repoBundleArchiveNames(repo),
    }))
}
