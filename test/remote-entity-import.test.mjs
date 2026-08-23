import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  assertRemoteEntityProfileSafe,
  buildEntityExportForm,
  keychainPasswordArgs,
  moquiEntityLoadArgs,
  getRemoteEntityProfile,
  inspectMoquiEntityLoadLog,
  keychainServiceForSource,
  normalizeHotwaxSource,
  remoteEntityEndpoints,
  remoteEntityProfiles,
  remoteEntityResetSql,
  saveEntityExportResponse,
  sanitizeExcludedEntityReferences,
  splitEntityExportForLoad,
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

test('always rejects the secret-bearing SystemMessageRemote entity', () => {
  assert.throws(
    () => assertRemoteEntityProfileSafe({
      id: 'unsafe',
      entities: ['moqui.service.message.SystemMessageRemote'],
    }),
    /SystemMessageRemote/,
  )
})

test('loads safe configuration and facility locations before inventory records', () => {
  const entities = getRemoteEntityProfile('inventory').entities
  assert.ok(entities.includes('moqui.basic.Enumeration'))
  assert.ok(entities.includes('org.apache.ofbiz.product.facility.FacilityLocation'))
  assert.ok(
    entities.indexOf('moqui.basic.Enumeration') <
    entities.indexOf('org.apache.ofbiz.product.inventory.InventoryItemDetail'),
  )
  assert.ok(
    entities.indexOf('org.apache.ofbiz.product.facility.FacilityLocation') <
    entities.indexOf('org.apache.ofbiz.product.inventory.InventoryItem'),
  )
})

test('orders the combined profile by foreign-key dependencies', () => {
  const entities = getRemoteEntityProfile('catalog-inventory').entities
  const product = entities.indexOf('org.apache.ofbiz.product.product.Product')
  assert.ok(entities.indexOf('moqui.basic.Enumeration') < product)
  assert.ok(entities.indexOf('org.apache.ofbiz.product.category.ProductCategory') < product)
  assert.ok(entities.indexOf('org.apache.ofbiz.product.facility.Facility') < product)
  assert.ok(product < entities.indexOf('org.apache.ofbiz.product.inventory.InventoryItem'))
  assert.ok(entities.indexOf('org.apache.ofbiz.product.inventory.InventoryItem') < entities.indexOf('org.apache.ofbiz.product.inventory.InventoryItemDetail'))
})

test('rejects Moqui loader errors and processed-count mismatches even when the CLI exits zero', () => {
  assert.deepEqual(
    inspectMoquiEntityLoadLog('Loaded [42] records in 1 seconds.', 42),
    { ok: true, records: 42 },
  )
  assert.match(
    inspectMoquiEntityLoadLog('ERROR Skipping to next file after error\nLoaded [21] records in 1 seconds.', 42).error,
    /reported an entity error/,
  )
  assert.match(
    inspectMoquiEntityLoadLog('Loaded [21] records in 1 seconds.', 42).error,
    /processed 21 of 42/,
  )
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

test('builds a file-specific raw command with background schedulers disabled', () => {
  assert.deepEqual(moquiEntityLoadArgs('/workspace/moqui-framework', '/tmp/export.xml'), [
    '-server',
    '-Dmoqui.conf=conf/MoquiDevConf.xml',
    '-Dmoqui.runtime=runtime',
    '-Dscheduled_job_check_time=0',
    '-Dscheduled.mdm.check.time=0',
    '-jar',
    '/workspace/moqui-framework/moqui.war',
    'load',
    'location=/tmp/export.xml',
    'timeout=1800',
    'raw',
  ])
})

test('clears only fixed commerce target tables in dependency-safe order', () => {
  const sql = remoteEntityResetSql('moqui')
  assert.ok(sql.indexOf('`INVENTORY_ITEM_DETAIL`') < sql.indexOf('`INVENTORY_ITEM`'))
  assert.ok(sql.indexOf('`PRODUCT_CATEGORY_MEMBER`') < sql.indexOf('`PRODUCT`'))
  assert.ok(sql.indexOf('`PRODUCT`') < sql.indexOf('`PRODUCT_CATEGORY`'))
  assert.doesNotMatch(sql, /SYSTEM_MESSAGE|USER_LOGIN|PARTY|ENUMERATION/)
  assert.throws(() => remoteEntityResetSql('moqui; DROP DATABASE moqui'), /database name/)
})

test('accepts only a non-empty Moqui XML entity export', () => {
  const xml = Buffer.from('<?xml version="1.0"?><entity-facade-xml><products productId="P1"/></entity-facade-xml>')
  assert.equal(validateEntityExport('application/xml;charset=utf-8', xml), 1)
  assert.throws(() => validateEntityExport('text/html', Buffer.from('<html></html>')), /XML/)
  assert.throws(() => validateEntityExport('application/xml', Buffer.from('<entity-facade-xml/>')), /no records/)
})

test('streams a chunked entity export to a private file while counting top-level records', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devkit-remote-test-'))
  const output = join(dir, 'export.xml')
  const encoder = new TextEncoder()
  const chunks = ['<?xml version="1.0"?><entity-fac', 'ade-xml><products productId="P1"/>', '<products productId="P2"><productName>Two</productName></products></entity-facade-xml>']
  const response = new Response(new ReadableStream({
    start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close() },
  }), { headers: { 'content-type': 'application/xml;charset=utf-8' } })

  try {
    const result = await saveEntityExportResponse(response, output)
    assert.equal(result.records, 2)
    assert.equal(result.bytes, Buffer.byteLength(chunks.join('')))
    assert.equal(await readFile(output, 'utf8'), chunks.join(''))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('splits a large entity export into bounded private transaction files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devkit-remote-split-test-'))
  const input = join(dir, 'export.xml')
  const chunksDir = join(dir, 'chunks')
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<entity-facade-xml>',
    '  <categories productCategoryId="PARENT"/>',
    '  <categories productCategoryId="CHILD" primaryParentCategoryId="PARENT"/>',
    '  <products productId="P1"/>',
    '  <products productId="P2"/>',
    '  <products productId="P3" description="A > B">',
    '    <longDescription>Nested product text</longDescription>',
    '  </products>',
    '</entity-facade-xml>',
  ].join('\n')
  await import('node:fs/promises').then(({ writeFile }) => writeFile(input, xml, { mode: 0o600 }))

  try {
    const chunks = await splitEntityExportForLoad(input, chunksDir, 2)
    assert.deepEqual(chunks.map(({ records }) => records), [2, 2, 1])
    const contents = await Promise.all(chunks.map(({ location }) => readFile(location, 'utf8')))
    assert.equal(contents.every((content) => content.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<entity-facade-xml>\n')), true)
    assert.equal(contents.every((content) => content.endsWith('</entity-facade-xml>\n')), true)
    assert.ok(contents[0].indexOf('PARENT') < contents[0].indexOf('CHILD'))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('removes only references to entities deliberately excluded from the safe profile', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devkit-remote-sanitize-test-'))
  const output = join(dir, 'export.xml')
  const xml = [
    '<entity-facade-xml>',
    '  <categories productCategoryId="CHILD" primaryParentCategoryId="PARENT"/>',
    '  <categories productCategoryId="PARENT"/>',
    '  <org.apache.ofbiz.product.facility.Facility facilityId="F2" parentFacilityId="F1"/>',
    '  <org.apache.ofbiz.product.facility.Facility facilityId="F1" ownerPartyId="P1" geoPointId="G1"/>',
    '  <org.apache.ofbiz.product.facility.FacilityLocation facilityId="F1" locationSeqId="L1" geoPointId="G2"/>',
    '  <org.apache.ofbiz.product.inventory.InventoryItem inventoryItemId="I1" facilityId="F1" locationSeqId="L1" partyId="P2" ownerPartyId="P3" quantityOnHandTotal="2"/>',
    '  <org.apache.ofbiz.product.inventory.InventoryItemDetail inventoryItemId="I1" inventoryItemDetailSeqId="1" resetItemId="R1"/>',
    '  <org.apache.ofbiz.product.inventory.InventoryItemDetail inventoryItemId="MISSING" inventoryItemDetailSeqId="2"/>',
    '  <products productId="P1" originGeoId="USA"/>',
    '  <org.apache.ofbiz.product.price.ProductPrice productId="P1" productPriceTypeId="DEFAULT_PRICE" productPricePurposeId="PURCHASE" currencyUomId="USD" fromDate="2026-01-01T00:00:00Z" taxAuthPartyId="TAX" taxAuthGeoId="USA"/>',
    '</entity-facade-xml>',
  ].join('\n')
  await import('node:fs/promises').then(({ writeFile }) => writeFile(output, xml, { mode: 0o600 }))

  try {
    const result = await sanitizeExcludedEntityReferences(output)
    const sanitized = await readFile(output, 'utf8')
    assert.deepEqual(result, { recordsChanged: 6, referencesRemoved: 9, recordsRemoved: 1 })
    assert.match(sanitized, /InventoryItem inventoryItemId="I1" facilityId="F1" locationSeqId="L1" quantityOnHandTotal="2"/)
    assert.doesNotMatch(sanitized, /ownerPartyId=|partyId=|geoPointId=|originGeoId=|resetItemId=|taxAuthPartyId=|taxAuthGeoId=/)
    assert.doesNotMatch(sanitized, /inventoryItemId="MISSING"/)
    assert.ok(sanitized.indexOf('productCategoryId="PARENT"') < sanitized.indexOf('productCategoryId="CHILD"'))
    assert.ok(sanitized.indexOf('facilityId="F1"') < sanitized.indexOf('facilityId="F2"'))
  } finally { await rm(dir, { recursive: true, force: true }) }
})
