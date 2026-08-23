import test from 'node:test'
import assert from 'node:assert/strict'

import { processBelongsToWorkspace } from '../lib/bootstrap-process.mjs'

const WORKSPACE = '/Users/example/Documents/GitHub/moqui/maarg-oms'

test('recognizes a process whose working directory is inside the workspace', () => {
  assert.equal(processBelongsToWorkspace({
    cwd: `${WORKSPACE}/solr/server`,
    command: 'java -jar start.jar',
  }, WORKSPACE), true)
})

test('recognizes a process whose command references the workspace', () => {
  assert.equal(processBelongsToWorkspace({
    cwd: '',
    command: `java -Dsolr.install.dir=${WORKSPACE}/solr -jar start.jar`,
  }, WORKSPACE), true)
})

test('rejects sibling and unrelated processes', () => {
  assert.equal(processBelongsToWorkspace({
    cwd: `${WORKSPACE}-other/solr/server`,
    command: `java -Dsolr.install.dir=${WORKSPACE}-other/solr`,
  }, WORKSPACE), false)
  assert.equal(processBelongsToWorkspace({
    cwd: '/opt/homebrew/var/solr',
    command: 'java -Dsolr.install.dir=/opt/homebrew/opt/solr -jar start.jar',
  }, WORKSPACE), false)
})

test('rejects unsafe or missing workspace paths', () => {
  assert.equal(processBelongsToWorkspace({ cwd: '/tmp', command: 'java' }, ''), false)
  assert.equal(processBelongsToWorkspace({ cwd: '/tmp', command: 'java' }, '/'), false)
})
