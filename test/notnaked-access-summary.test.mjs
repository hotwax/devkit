import test from 'node:test'
import assert from 'node:assert/strict'

import { summarizeRepoAccess } from '../notnaked-access-summary.mjs'

test('summarizeRepoAccess names missing repos and explains local/token state', () => {
  const summary = summarizeRepoAccess({
    tokenPresent: false,
    missing: [
      { owner: 'hotwax', repo: 'poorti', localPresent: false, status: 404 },
      { owner: 'hotwax', repo: 'maarg-util', localPresent: false, status: 404 },
    ],
  })

  assert.equal(summary.ok, false)
  assert.deepEqual(summary.missingRepos, ['hotwax/poorti', 'hotwax/maarg-util'])
  assert.match(summary.headline, /hotwax\/poorti/)
  assert.match(summary.detail, /2\/2 missing locally/)
  assert.match(summary.detail, /No GitHub token/)
})

test('summarizeRepoAccess reports ready when nothing is missing', () => {
  const summary = summarizeRepoAccess({ missing: [] })

  assert.equal(summary.ok, true)
  assert.deepEqual(summary.missingRepos, [])
})
