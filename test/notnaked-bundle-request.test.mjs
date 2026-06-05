import test from 'node:test'
import assert from 'node:assert/strict'

import { privateRepoBundleRequestFromSource } from '../notnaked-bundle-request.mjs'

test('privateRepoBundleRequestFromSource includes missing repos and archive fallbacks with reasons', () => {
  const request = privateRepoBundleRequestFromSource({
    rows: [
      { owner: 'hotwax', repo: 'poorti', path: '/workspace/poorti', state: 'missing' },
      { owner: 'hotwax', repo: 'ofbiz-oms-udm', path: '/workspace/ofbiz-oms-udm', state: 'archive', purpose: 'current local copy is fallback' },
      { owner: 'hotwax', repo: 'accxui', path: '/workspace/accxui', state: 'clone' },
      { owner: 'other', repo: 'archive-without-purpose', path: '/workspace/archive-without-purpose', state: 'archive' },
    ],
  })

  assert.deepEqual(request.map((repo) => repo.repo), ['hotwax/poorti', 'hotwax/ofbiz-oms-udm'])
  assert.equal(request[0].reason, 'missing locally')
  assert.equal(request[1].reason, 'canonical git checkout or archive needed to replace current fallback')
  assert.ok(request[1].acceptableArchiveNames.includes('ofbiz-oms-udm.zip'))
})
