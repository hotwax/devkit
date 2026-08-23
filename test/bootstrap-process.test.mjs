import test from 'node:test'
import assert from 'node:assert/strict'

import { processBelongsToWorkspace, solrBootstrapJavaArgs } from '../lib/bootstrap-process.mjs'

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

test('builds a standalone Moqui service runner classpath for Solr initialization', () => {
  const home = `${WORKSPACE}/moqui-framework`
  const extractedWar = `${home}/build/devkit-solr-bootstrap`
  const script = '/devkit/lib/bootstrap-solr.groovy'
  const args = solrBootstrapJavaArgs(home, extractedWar, script)

  assert.deepEqual(args.slice(0, 3), [
    `-Dmoqui.runtime=${home}/runtime`,
    '-Dmoqui.conf=conf/MoquiDevConf.xml',
    '-Dmoqui.init.static=true',
  ])
  assert.equal(args[3], '-cp')
  assert.match(args[4], /build\/devkit-solr-bootstrap\/WEB-INF\/classes/)
  assert.match(args[4], /build\/devkit-solr-bootstrap\/WEB-INF\/lib\/\*/)
  assert.match(args[4], /build\/devkit-solr-bootstrap\/execlib\/\*/)
  assert.deepEqual(args.slice(-2), ['groovy.ui.GroovyMain', script])
})
