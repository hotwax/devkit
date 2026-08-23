import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildEntityExportForm,
  keychainPasswordArgs,
  moquiEntityLoadArgs,
  getRemoteEntityProfile,
  keychainServiceForSource,
  normalizeHotwaxSource,
  remoteEntityEndpoints,
  remoteEntityProfiles,
  validateEntityExport,
} from '../lib/remote-entity-import.mjs'

test('normalizes an HTTPS HotWax instance to its origin', () => {
  assert.equal(normalizeHotwaxSource('rails-uat.hotwax.io'), 'https://rails-uat.hotwax.io')
  assert.equal(normalizeHotwaxSource('https://rails-uat.hotwax.io/qapps/tools'), 'https://rails-uat.hotwax.io')
})

test('rejects non-HTTPS and non-HotWax sources', () => {
  assert.throws(() => normalizeHotwaxSource('http://rails-uat.hotwax.io'), /HTTPS/)
  assert.throws(() => normalizeHotwaxSource('https://example.com'), /hotwax\.io/)
  assert.throws(() => normalizeHotwaxSource('https://user:pass@rails-uat.hotwax.io'), /credentials/)
})

test('uses the exact domain Keychain service for a HotWax source', () => {
  assert.equal(keychainServiceForSource('https://rails-uat.hotwax.io'), 'hotwax-domain:hotwax.io')
})

test('only exposes fixed profiles without security or integration entities', () => {
  assert.deepEqual(Object.keys(remoteEntityProfiles), ['products', 'catalog', 'inventory', 'catalog-inventory'])
  for (const profile of Object.values(remoteEntityProfiles)) {
    assert.ok(profile.entities.length > 0)
    assert.equal(new Set(profile.entities).size, profile.entities.length)
    assert.equal(profile.entities.some((name) => /security|useraccount|integration|systemproperty/i.test(name)), false)
  }
})

test('returns an immutable profile and rejects unknown profile ids', () => {
  const profile = getRemoteEntityProfile('catalog')
  assert.equal(profile.id, 'catalog')
  assert.equal(Object.isFrozen(profile), true)
  assert.equal(Object.isFrozen(profile.entities), true)
  assert.throws(() => getRemoteEntityProfile('everything'), /Unknown safe entity profile/)
})

test('builds the read-only Moqui XML export form for a fixed profile', () => {
  const form = buildEntityExportForm(getRemoteEntityProfile('products'))
  assert.equal(form.get('entityNames'), 'org.apache.ofbiz.product.product.Product')
  assert.equal(form.get('dependentLevels'), '0')
  assert.equal(form.get('fileType'), 'XML')
  assert.equal(form.get('output'), 'browser')
})

test('uses the supported login and streamed export endpoints', () => {
  assert.deepEqual(remoteEntityEndpoints('rails-uat.hotwax.io'), {
    login: 'https://rails-uat.hotwax.io/rest/s1/admin/login',
    information: 'https://rails-uat.hotwax.io/rest/s1/admin/maarg',
    export: 'https://rails-uat.hotwax.io/apps/tools/Entity/DataExport/EntityExport',
  })
})

test('builds an exact Keychain lookup without broad credential searches', () => {
  assert.deepEqual(keychainPasswordArgs('codex.aditya', 'rails-uat.hotwax.io'), [
    'find-generic-password', '-a', 'codex.aditya', '-s', 'hotwax-domain:hotwax.io', '-w',
  ])
  assert.throws(() => keychainPasswordArgs('', 'rails-uat.hotwax.io'), /account/)
})

test('builds a file-specific raw Moqui import command', () => {
  assert.deepEqual(moquiEntityLoadArgs('/workspace/moqui-framework', '/tmp/export.xml'), [
    '-server',
    '-Dmoqui.conf=conf/MoquiDevConf.xml',
    '-Dmoqui.runtime=runtime',
    '-jar',
    '/workspace/moqui-framework/moqui.war',
    'load',
    'location=/tmp/export.xml',
    'timeout=1800',
    'raw',
  ])
})

test('accepts only a non-empty Moqui XML entity export', () => {
  const xml = Buffer.from('<?xml version="1.0"?><entity-facade-xml><products productId="P1"/></entity-facade-xml>')
  assert.equal(validateEntityExport('application/xml;charset=utf-8', xml), 1)
  assert.throws(() => validateEntityExport('text/html', Buffer.from('<html></html>')), /XML/)
  assert.throws(() => validateEntityExport('application/xml', Buffer.from('<entity-facade-xml/>')), /no records/)
})
