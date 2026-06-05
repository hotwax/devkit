const DEP_SECTIONS = ['dependencies', 'devDependencies']

export function mergePwaDependencies(rootPackage, appPackages) {
  const next = structuredClone(rootPackage || {})
  next.dependencies = { ...(next.dependencies || {}) }
  next.devDependencies = { ...(next.devDependencies || {}) }
  let changed = false

  for (const appPackage of appPackages || []) {
    for (const section of DEP_SECTIONS) {
      for (const [name, version] of Object.entries(appPackage?.[section] || {})) {
        if (next.dependencies[name] || next.devDependencies[name]) continue
        next[section][name] = version
        changed = true
      }
    }
  }

  return { packageJson: next, changed }
}
