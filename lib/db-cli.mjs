// lib/db-cli.mjs — CLI argument parsing, snapshot resolution, and formatting for devkit

export const SNAP_LABEL_RE = /^[A-Za-z0-9_-]{1,64}$/

export const CLI_HELP = `
devkit — local development cockpit for Moqui / Maarg

USAGE
  devkit [command] [options]
  npx github:hotwax/devkit [command] [options]

COMMANDS
  snapshot [label]        Take a compressed MySQL snapshot (alias: backup)
                          Default label is "manual". Files saved in runtime/db-snapshots/
  snapshots               List available database snapshots (aliases: backups, snapshot list)
  restore <file|label>    Restore the database from a snapshot (alias: revert)
                          Accepts exact .sql.gz filename, label, or prefix
  reset                   Reset local database to base seed data
  status                  Show local Moqui, database, Solr, and dev environment status (alias: info)
  serve                   Start the devkit web dashboard on http://127.0.0.1:7070 (default)

OPTIONS
  -y, --yes               Skip confirmation prompts for destructive operations (restore, reset)
  -l, --label <label>     Explicit snapshot label
  -h, --help              Show this help message
  -v, --version           Show devkit version
  -p, --port <port>       Port for the web dashboard (default: 7070)

EXAMPLES
  devkit snapshot initial-setup
  devkit snapshots
  devkit restore initial-setup
  devkit restore manual__2026-08-24T19-45-00-000Z.sql.gz -y
  devkit status
  devkit serve --port 7070
`

/**
 * Parses CLI arguments into a structured command object.
 * @param {string[]} rawArgs - process.argv.slice(2)
 * @returns {object} parsed command and options
 */
export function parseCliArgs(rawArgs = []) {
  const args = [...rawArgs]
  if (!args.length) {
    return { command: 'serve', options: {} }
  }

  const first = args[0]

  if (first === '-h' || first === '--help' || first === 'help') {
    return { command: 'help', options: {} }
  }

  if (first === '-v' || first === '--version' || first === 'version') {
    return { command: 'version', options: {} }
  }

  let yes = false
  let label = null
  let port = null
  const positional = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-y' || arg === '--yes') {
      yes = true
    } else if (arg === '-l' || arg === '--label') {
      label = args[++i] || null
    } else if (arg === '-p' || arg === '--port') {
      port = Number(args[++i]) || null
    } else if (arg.startsWith('--label=')) {
      label = arg.slice(8)
    } else if (arg.startsWith('--port=')) {
      port = Number(arg.slice(7)) || null
    } else if (!arg.startsWith('-')) {
      positional.push(arg)
    }
  }

  const sub = positional[0] || 'serve'

  if (sub === 'snapshot' || sub === 'backup') {
    const second = positional[1]
    if (second === 'list' || second === 'ls') {
      return { command: 'snapshots', options: { yes } }
    }
    const resolvedLabel = label || second || 'manual'
    return { command: 'snapshot', label: resolvedLabel, options: { yes } }
  }

  if (sub === 'snapshots' || sub === 'backups') {
    return { command: 'snapshots', options: { yes } }
  }

  if (sub === 'restore' || sub === 'revert') {
    const fileOrLabel = positional[1] || null
    return { command: 'restore', target: fileOrLabel, options: { yes } }
  }

  if (sub === 'reset') {
    return { command: 'reset', options: { yes } }
  }

  if (sub === 'status' || sub === 'info') {
    return { command: 'status', options: {} }
  }

  if (sub === 'serve' || sub === 'server' || sub === 'start') {
    return { command: 'serve', options: { port } }
  }

  // Unknown command
  return { command: 'unknown', raw: sub, options: {} }
}

/**
 * Resolves a snapshot input (filename, label, or prefix) to an exact snapshot filename from the available list.
 * @param {string} input - user-provided filename, label, or prefix
 * @param {Array<{file: string, label: string, createdAt: string}>} snapshots - available snapshots sorted newest first
 * @returns {string|null} resolved .sql.gz filename or null
 */
export function resolveSnapshotFile(input, snapshots = []) {
  if (!input || typeof input !== 'string') return null
  const query = input.trim()
  if (!query) return null

  // 1. Exact filename match
  const exact = snapshots.find((s) => s.file === query)
  if (exact) return exact.file

  // 2. Exact match with .sql.gz appended
  if (!query.endsWith('.sql.gz')) {
    const withExt = snapshots.find((s) => s.file === `${query}.sql.gz`)
    if (withExt) return withExt.file
  }

  // 3. Exact label match (snapshots is sorted newest first -> returns latest)
  const byLabel = snapshots.filter((s) => s.label === query)
  if (byLabel.length > 0) return byLabel[0].file

  // 4. Prefix match on filename or label
  const prefix = snapshots.filter((s) => s.file.startsWith(query) || s.label.startsWith(query))
  if (prefix.length > 0) return prefix[0].file

  return null
}

/**
 * Formats byte size into human readable string.
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (bytes == null || isNaN(bytes)) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
