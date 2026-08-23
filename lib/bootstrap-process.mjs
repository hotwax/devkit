import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path'

function pathIsWithin(candidate, workspace) {
  if (!candidate) return false
  const rel = relative(workspace, resolve(candidate))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function processBelongsToWorkspace(process, workspace) {
  if (!workspace) return false
  const root = resolve(workspace)
  if (root === sep) return false
  if (pathIsWithin(process?.cwd, root)) return true

  const escapedRoot = escapeRegExp(root)
  const pathReference = new RegExp(`(?:^|[\\s\"'=:(])${escapedRoot}(?:$|[\\/\\s\"':)])`)
  return pathReference.test(String(process?.command || ''))
}

export function solrBootstrapJavaArgs(home, extractedWar, scriptPath) {
  const classpath = [
    join(extractedWar, 'WEB-INF', 'classes'),
    join(extractedWar, 'WEB-INF', 'lib', '*'),
    join(extractedWar, 'execlib', '*'),
  ].join(delimiter)

  return [
    `-Dmoqui.runtime=${join(home, 'runtime')}`,
    '-Dmoqui.conf=conf/MoquiDevConf.xml',
    '-Dmoqui.init.static=true',
    '-cp', classpath,
    'groovy.ui.GroovyMain', scriptPath,
  ]
}
