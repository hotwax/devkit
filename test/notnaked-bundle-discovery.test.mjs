import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { findCompleteLocalBundle } from '../notnaked-bundle-discovery.mjs'

const missingRepos = [
  { owner: 'hotwax', repo: 'poorti', path: '/Users/example/Documents/github/poorti' },
  { owner: 'hotwax', repo: 'maarg-util', path: '/Users/example/Documents/github/maarg-util' },
  { owner: 'hotwax', repo: 'notnaked', path: '/Users/example/Documents/github/notnaked' },
]

test('findCompleteLocalBundle detects a folder containing all missing repo archives', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devkit-bundle-'))
  try {
    await writeFile(join(root, 'poorti.zip'), '')
    await writeFile(join(root, 'maarg-util.zip'), '')
    await writeFile(join(root, 'notnaked.zip'), '')

    const bundle = await findCompleteLocalBundle([root], missingRepos)

    assert.equal(bundle?.rootPath, root)
    assert.equal(bundle.matches.length, 3)
    assert.deepEqual(bundle.missing, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('findCompleteLocalBundle skips roots that do not cover every missing repo', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devkit-bundle-incomplete-'))
  try {
    await mkdir(join(root, 'poorti'))
    await writeFile(join(root, 'maarg-util.zip'), '')

    const bundle = await findCompleteLocalBundle([root], missingRepos)

    assert.equal(bundle, null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
