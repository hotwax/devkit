import test from 'node:test'
import assert from 'node:assert/strict'

import { parseCliArgs, resolveSnapshotFile, formatBytes, SNAP_LABEL_RE } from '../lib/db-cli.mjs'

test('parseCliArgs defaults to serve when no arguments are passed', () => {
  assert.deepEqual(parseCliArgs([]), { command: 'serve', options: {} })
})

test('parseCliArgs parses help and version flags', () => {
  assert.deepEqual(parseCliArgs(['-h']), { command: 'help', options: {} })
  assert.deepEqual(parseCliArgs(['--help']), { command: 'help', options: {} })
  assert.deepEqual(parseCliArgs(['help']), { command: 'help', options: {} })
  assert.deepEqual(parseCliArgs(['-v']), { command: 'version', options: {} })
  assert.deepEqual(parseCliArgs(['--version']), { command: 'version', options: {} })
  assert.deepEqual(parseCliArgs(['version']), { command: 'version', options: {} })
})

test('parseCliArgs parses snapshot and backup commands with default label', () => {
  assert.deepEqual(parseCliArgs(['snapshot']), {
    command: 'snapshot',
    label: 'manual',
    options: { yes: false },
  })
  assert.deepEqual(parseCliArgs(['backup']), {
    command: 'snapshot',
    label: 'manual',
    options: { yes: false },
  })
})

test('parseCliArgs parses snapshot with explicit label positional or flag', () => {
  assert.deepEqual(parseCliArgs(['snapshot', 'setup-clean']), {
    command: 'snapshot',
    label: 'setup-clean',
    options: { yes: false },
  })
  assert.deepEqual(parseCliArgs(['snapshot', '--label', 'post-seed']), {
    command: 'snapshot',
    label: 'post-seed',
    options: { yes: false },
  })
  assert.deepEqual(parseCliArgs(['backup', '--label=stage1']), {
    command: 'snapshot',
    label: 'stage1',
    options: { yes: false },
  })
})

test('parseCliArgs parses snapshot listing commands', () => {
  assert.deepEqual(parseCliArgs(['snapshots']), {
    command: 'snapshots',
    options: { yes: false },
  })
  assert.deepEqual(parseCliArgs(['backups']), {
    command: 'snapshots',
    options: { yes: false },
  })
  assert.deepEqual(parseCliArgs(['snapshot', 'list']), {
    command: 'snapshots',
    options: { yes: false },
  })
  assert.deepEqual(parseCliArgs(['snapshot', 'ls']), {
    command: 'snapshots',
    options: { yes: false },
  })
})

test('parseCliArgs parses restore and revert commands with target and flags', () => {
  assert.deepEqual(parseCliArgs(['restore', 'setup-clean', '-y']), {
    command: 'restore',
    target: 'setup-clean',
    options: { yes: true },
  })
  assert.deepEqual(parseCliArgs(['revert', 'manual__2026-08-24.sql.gz', '--yes']), {
    command: 'restore',
    target: 'manual__2026-08-24.sql.gz',
    options: { yes: true },
  })
})

test('parseCliArgs parses reset and status commands', () => {
  assert.deepEqual(parseCliArgs(['reset', '-y']), {
    command: 'reset',
    options: { yes: true },
  })
  assert.deepEqual(parseCliArgs(['status']), {
    command: 'status',
    options: {},
  })
  assert.deepEqual(parseCliArgs(['info']), {
    command: 'status',
    options: {},
  })
})

test('parseCliArgs parses serve command with custom port', () => {
  assert.deepEqual(parseCliArgs(['serve', '-p', '7080']), {
    command: 'serve',
    options: { port: 7080 },
  })
  assert.deepEqual(parseCliArgs(['start', '--port=8000']), {
    command: 'serve',
    options: { port: 8000 },
  })
})

test('parseCliArgs handles unknown commands', () => {
  assert.deepEqual(parseCliArgs(['foobar']), {
    command: 'unknown',
    raw: 'foobar',
    options: {},
  })
})

test('resolveSnapshotFile matches exact file, label, and prefix', () => {
  const snapshots = [
    { file: 'clean-setup__2026-08-24T20-00-00-000Z.sql.gz', label: 'clean-setup', createdAt: '2026-08-24T20:00:00.000Z' },
    { file: 'clean-setup__2026-08-24T10-00-00-000Z.sql.gz', label: 'clean-setup', createdAt: '2026-08-24T10:00:00.000Z' },
    { file: 'manual__2026-08-23T15-00-00-000Z.sql.gz', label: 'manual', createdAt: '2026-08-23T15:00:00.000Z' },
  ]

  // Exact file
  assert.equal(resolveSnapshotFile('manual__2026-08-23T15-00-00-000Z.sql.gz', snapshots), 'manual__2026-08-23T15-00-00-000Z.sql.gz')
  // Without extension
  assert.equal(resolveSnapshotFile('manual__2026-08-23T15-00-00-000Z', snapshots), 'manual__2026-08-23T15-00-00-000Z.sql.gz')
  // Label (returns latest matching)
  assert.equal(resolveSnapshotFile('clean-setup', snapshots), 'clean-setup__2026-08-24T20-00-00-000Z.sql.gz')
  // Prefix
  assert.equal(resolveSnapshotFile('man', snapshots), 'manual__2026-08-23T15-00-00-000Z.sql.gz')
  // No match / invalid
  assert.equal(resolveSnapshotFile('nonexistent', snapshots), null)
  assert.equal(resolveSnapshotFile('', snapshots), null)
  assert.equal(resolveSnapshotFile(null, snapshots), null)
})

test('formatBytes converts byte numbers to human readable units', () => {
  assert.equal(formatBytes(500), '500 B')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(15728640), '15.00 MB')
  assert.equal(formatBytes(2147483648), '2.00 GB')
})

test('SNAP_LABEL_RE validates safe filename segments', () => {
  assert.equal(SNAP_LABEL_RE.test('clean-setup'), true)
  assert.equal(SNAP_LABEL_RE.test('backup_v1'), true)
  assert.equal(SNAP_LABEL_RE.test('backup 1'), false)
  assert.equal(SNAP_LABEL_RE.test('backup/1'), false)
  assert.equal(SNAP_LABEL_RE.test('backup..1'), false)
})
