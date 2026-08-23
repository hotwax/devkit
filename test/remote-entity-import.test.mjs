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
  orderEntityExportByProfile,
  remoteEntityEndpoints,
  remoteEntityProfiles,
  remoteEntityResetSql,
  saveEntityExportResponse,
  sanitizeExcludedEntityReferences,
  sanitizeOrderCustomerData,
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
  assert.deepEqual(Object.keys(remoteEntityProfiles), ['products', 'catalog', 'inventory', 'catalog-inventory', 'orders-customers'])
  for (const profile of Object.values(remoteEntityProfiles)) {
    assert.ok(profile.entities.length > 0)
    assert.equal(new Set(profile.entities).size, profile.entities.length)
    assert.equal(profile.entities.some((name) => /security|useraccount|integration|systemproperty/i.test(name)), false)
  }
})

test('orders and customers use an explicit dependency-ordered allowlist', () => {
  const entities = getRemoteEntityProfile('orders-customers').entities
  const party = entities.indexOf('org.apache.ofbiz.party.party.Party')
  const contact = entities.indexOf('org.apache.ofbiz.party.contact.ContactMech')
  const shipmentMethod = entities.indexOf('org.apache.ofbiz.shipment.shipment.ShipmentMethodType')
  const partyRole = entities.indexOf('org.apache.ofbiz.party.party.PartyRole')
  const carrierMethod = entities.indexOf('org.apache.ofbiz.shipment.shipment.CarrierShipmentMethod')
  const paymentMethodType = entities.indexOf('org.apache.ofbiz.accounting.payment.PaymentMethodType')
  const inventoryItem = entities.indexOf('org.apache.ofbiz.product.inventory.InventoryItem')
  const shipmentBox = entities.indexOf('org.apache.ofbiz.shipment.shipment.ShipmentBoxType')
  const order = entities.indexOf('org.apache.ofbiz.order.order.OrderHeader')
  const shipment = entities.indexOf('org.apache.ofbiz.shipment.shipment.Shipment')
  assert.ok(party >= 0 && party < order)
  assert.ok(contact >= 0 && contact < order)
  assert.ok(order < entities.indexOf('org.apache.ofbiz.order.order.OrderItem'))
  assert.ok(shipmentMethod >= 0 && shipmentMethod < entities.indexOf('org.apache.ofbiz.order.order.OrderItem'))
  assert.ok(partyRole >= 0 && partyRole < carrierMethod)
  assert.ok(shipmentMethod < carrierMethod && carrierMethod < entities.indexOf('org.apache.ofbiz.order.order.OrderItemShipGroup'))
  assert.ok(paymentMethodType >= 0 && paymentMethodType < entities.indexOf('org.apache.ofbiz.order.order.OrderPaymentPreference'))
  assert.ok(inventoryItem >= 0 && inventoryItem < entities.indexOf('org.apache.ofbiz.order.order.OrderItemShipGrpInvRes'))
  assert.ok(shipmentBox >= 0 && shipmentBox < entities.indexOf('org.apache.ofbiz.shipment.shipment.ShipmentPackage'))
  assert.ok(order < shipment)
  assert.ok(shipment < entities.indexOf('org.apache.ofbiz.order.order.OrderShipment'))
  assert.equal(entities.some((name) => /UserLogin|PaymentMethod$|CreditCard|SystemMessageRemote/.test(name)), false)
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

test('builds a file-specific create-or-update command with side effects disabled', () => {
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
    'no-fk-create',
    'disable-eeca',
    'disable-audit-log',
    'disable-data-feed',
  ])
})

test('clears only fixed commerce target tables in dependency-safe order', () => {
  const sql = remoteEntityResetSql('moqui', 'catalog-inventory')
  assert.ok(sql.indexOf('`INVENTORY_ITEM_DETAIL`') < sql.indexOf('`INVENTORY_ITEM`'))
  assert.ok(sql.indexOf('`PRODUCT_CATEGORY_MEMBER`') < sql.indexOf('`PRODUCT`'))
  assert.ok(sql.indexOf('`PRODUCT`') < sql.indexOf('`PRODUCT_CATEGORY`'))
  assert.doesNotMatch(sql, /SYSTEM_MESSAGE|USER_LOGIN|PARTY|ENUMERATION/)
  const orderSql = remoteEntityResetSql('moqui', 'orders-customers')
  assert.match(orderSql, /`ORDER_HEADER`/)
  assert.match(orderSql, /`SHIPMENT`/)
  assert.doesNotMatch(orderSql, /`PARTY`|`PERSON`|`CONTACT_MECH`|SYSTEM_MESSAGE/)
  assert.ok(orderSql.indexOf('`ORDER_SHIPMENT`') < orderSql.indexOf('`ORDER_HEADER`'))
  assert.throws(() => remoteEntityResetSql('moqui; DROP DATABASE moqui', 'catalog-inventory'), /database name/)
  assert.throws(() => remoteEntityResetSql('moqui', 'everything'), /reset profile/)
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

test('streams order records into fixed parent-before-child entity order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devkit-order-profile-test-'))
  const output = join(dir, 'export.xml')
  const xml = [
    '<entity-facade-xml>',
    '  <org.apache.ofbiz.order.order.OrderItemShipGrpInvRes orderId="O1" shipGroupSeqId="00001" orderItemSeqId="00001" inventoryItemId="I1"/>',
    '  <org.apache.ofbiz.order.order.OrderItemShipGroup orderId="O1" shipGroupSeqId="00001"/>',
    '  <org.apache.ofbiz.order.order.OrderItem orderId="O1" orderItemSeqId="00001"/>',
    '  <org.apache.ofbiz.order.order.OrderHeader orderId="O1"/>',
    '</entity-facade-xml>',
  ].join('\n')
  await import('node:fs/promises').then(({ writeFile }) => writeFile(output, xml, { mode: 0o600 }))
  try {
    const result = await orderEntityExportByProfile(output, getRemoteEntityProfile('orders-customers').entities)
    const ordered = await readFile(output, 'utf8')
    assert.equal(result.records, 4)
    assert.equal(result.entitiesWithRecords, 4)
    assert.ok(ordered.indexOf('OrderHeader') < ordered.indexOf('OrderItem orderId'))
    assert.ok(ordered.indexOf('OrderItem orderId') < ordered.indexOf('OrderItemShipGroup'))
    assert.ok(ordered.indexOf('OrderItemShipGroup') < ordered.indexOf('OrderItemShipGrpInvRes'))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('filters to order-linked customers and deterministically scrubs customer and contact PII', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devkit-order-sanitize-test-'))
  const output = join(dir, 'export.xml')
  const xml = [
    '<entity-facade-xml>',
    '  <org.apache.ofbiz.party.party.Party partyId="COMPANY" partyTypeId="PARTY_GROUP" createdDate="2020-01-01T00:00:00Z"/>',
    '  <org.apache.ofbiz.party.party.Party partyId="CUSTOMER_1" partyTypeId="PERSON" externalId="shopify-customer-99" description="Private customer"><createdDate value="2025-01-01T00:00:00Z"/></org.apache.ofbiz.party.party.Party>',
    '  <org.apache.ofbiz.party.party.Party partyId="UNUSED_PERSON" partyTypeId="PERSON"/>',
    '  <org.apache.ofbiz.party.party.Person partyId="CUSTOMER_1" firstName="Alice" middleName="Private" lastName="Example" birthDate="1980-01-01" socialSecurityNumber="secret-ssn" comments="private"/>',
    '  <org.apache.ofbiz.party.party.Person partyId="UNUSED_PERSON" firstName="Not Ordered"/>',
    '  <org.apache.ofbiz.party.party.PartyIdentification partyId="CUSTOMER_1" partyIdentificationTypeId="SHOPIFY_CUSTOMER_ID" idValue="998877"/>',
    '  <org.apache.ofbiz.party.contact.ContactMech contactMechId="EMAIL_1" contactMechTypeId="EMAIL_ADDRESS" externalId="real-email-id" infoString="alice@example.com"/>',
    '  <org.apache.ofbiz.party.contact.ContactMech contactMechId="PHONE_1" contactMechTypeId="TELECOM_NUMBER"/>',
    '  <org.apache.ofbiz.party.contact.ContactMech contactMechId="ADDRESS_1" contactMechTypeId="POSTAL_ADDRESS"/>',
    '  <org.apache.ofbiz.party.contact.ContactMech contactMechId="UNUSED_EMAIL" contactMechTypeId="EMAIL_ADDRESS" infoString="unused@example.com"/>',
    '  <org.apache.ofbiz.party.contact.TelecomNumber contactMechId="PHONE_1" countryCode="44" areaCode="020" contactNumber="7946000000" askForName="Alice"/>',
    '  <org.apache.ofbiz.party.contact.PostalAddress contactMechId="ADDRESS_1" toName="Alice Example" attnName="Private" address1="1 Real Street" address2="Apartment 2" city="Chicago" postalCode="60601" countryGeoId="USA" stateProvinceGeoId="IL" geoPointId="PRIVATE_POINT" latitude="41.8818" longitude="-87.6231"/>',
    '  <org.apache.ofbiz.party.contact.PartyContactMech partyId="CUSTOMER_1" contactMechId="EMAIL_1" fromDate="2026-01-01T00:00:00Z" extension="123" comments="private"/>',
    '  <org.apache.ofbiz.party.contact.PartyContactMech partyId="CUSTOMER_1" contactMechId="PHONE_1" fromDate="2026-01-01T00:00:00Z"/>',
    '  <org.apache.ofbiz.party.contact.PartyContactMech partyId="CUSTOMER_1" contactMechId="ADDRESS_1" fromDate="2026-01-01T00:00:00Z"/>',
    '  <org.apache.ofbiz.order.order.OrderHeader orderId="ORDER_1" orderTypeId="SALES_ORDER" visitId="private-session" createdBy="employee" internalCode="private-code"/>',
    '  <co.hotwax.order.OrderIdentification orderIdentificationTypeId="SHOPIFY_ORDER_ID" orderId="ORDER_1" idValue="12345" fromDate="2026-01-01T00:00:00Z"/>',
    '  <org.apache.ofbiz.order.order.OrderRole orderId="ORDER_1" partyId="CUSTOMER_1" roleTypeId="PLACING_CUSTOMER" fromDate="2026-01-01T00:00:00Z"/>',
    '  <org.apache.ofbiz.order.order.OrderContactMech orderId="ORDER_1" contactMechPurposeTypeId="ORDER_EMAIL" contactMechId="EMAIL_1"/>',
    '  <org.apache.ofbiz.order.order.OrderItem orderId="ORDER_1" orderItemSeqId="00001" productId="P1" comments="private item note" changeByUserLoginId="employee"/>',
    '  <org.apache.ofbiz.order.order.OrderItemShipGroup orderId="ORDER_1" shipGroupSeqId="00001" contactMechId="ADDRESS_1" telecomContactMechId="PHONE_1" trackingNumber="real-tracking" shippingInstructions="leave at private door" giftMessage="Happy birthday Alice"/>',
    '  <org.apache.ofbiz.order.order.OrderItemShipGrpInvRes orderId="ORDER_1" shipGroupSeqId="00001" orderItemSeqId="00001" inventoryItemId="I1"/>',
    '  <org.apache.ofbiz.order.order.OrderAdjustment orderAdjustmentId="ADJ_1" orderId="ORDER_1" comments="private tax note" customerReferenceId="tax-id" createdByUserLogin="employee"/>',
    '  <org.apache.ofbiz.order.order.OrderPaymentPreference orderPaymentPreferenceId="PAY_1" orderId="ORDER_1" paymentMethodTypeId="CREDIT_CARD" paymentMethodId="CARD_1" securityCode="123" track2="secret-track" billingPostalCode="60601" manualAuthCode="secret-auth" manualRefNum="secret-ref" cardName="Alice Example" requestId="gateway-request" parentRefNum="gateway-parent" applicationIdentifier="gateway-app"/>',
    '  <org.apache.ofbiz.order.order.OrderStatus orderStatusId="STATUS_1" orderId="ORDER_1" statusId="ORDER_APPROVED" statusUserLogin="employee" changeReason="private reason"/>',
    '  <org.apache.ofbiz.shipment.shipment.Shipment shipmentId="SHIP_1" primaryOrderId="ORDER_1" partyIdTo="CUSTOMER_1" destinationContactMechId="ADDRESS_1" destinationTelecomNumberId="PHONE_1" handlingInstructions="private instruction" primaryReturnId="RETURN_1" picklistBinId="BIN_1"/>',
    '  <org.apache.ofbiz.shipment.shipment.ShipmentItem shipmentId="SHIP_1" shipmentItemSeqId="00001" productId="P1" shipmentContentDescription="private text"/>',
    '  <org.apache.ofbiz.shipment.shipment.ShipmentRouteSegment shipmentId="SHIP_1" shipmentRouteSegmentId="00001" deliveryId="DELIVERY_1" destContactMechId="ADDRESS_1" destTelecomNumberId="PHONE_1" trackingIdNumber="real-route-tracking" trackingDigest="secret-digest" thirdPartyAccountNumber="secret-account" thirdPartyPostalCode="60601" referenceNumber="private-reference" trackingUrl="https://carrier.example/private" labelImageUrl="https://carrier.example/label"/>',
    '  <org.apache.ofbiz.shipment.shipment.ShipmentPackageRouteSeg shipmentId="SHIP_1" shipmentPackageSeqId="00001" shipmentRouteSegmentId="00001" trackingCode="real-package-tracking" labelHtml="private label" labelImage="private-binary" labelImageUrl="https://carrier.example/label" gatewayMessage="private gateway response"/>',
    '  <org.apache.ofbiz.shipment.issuance.ItemIssuance itemIssuanceId="ISSUE_1" inventoryItemId="I1" orderId="ORDER_1" orderItemSeqId="00001" issuedByUserLoginId="employee" cancelledByUserLoginId="employee" wegsReferenceNumber="private-wegs" deliveredToParty="Alice Example"/>',
    '</entity-facade-xml>',
  ].join('\n')
  await import('node:fs/promises').then(({ writeFile }) => writeFile(output, xml, { mode: 0o600 }))

  try {
    const result = await sanitizeOrderCustomerData(output, new Set(['COMPANY']), new Set(['I1']))
    const sanitized = await readFile(output, 'utf8')
    assert.ok(result.recordsChanged > 0)
    assert.ok(result.fieldsRemoved > 0)
    assert.ok(result.fieldsReplaced > 0)
    assert.equal(result.recordsRemoved, 4)
    assert.equal(result.existingPartiesExcluded, 1)
    assert.doesNotMatch(sanitized, /Alice|alice@example\.com|7946000000|1 Real Street|60601|secret-|private|Happy birthday|real-.*tracking|UNUSED_PERSON|UNUSED_EMAIL|partyId="COMPANY"/)
    assert.match(sanitized, /infoString="test-[a-f0-9]{12}@example\.invalid"/)
    assert.match(sanitized, /areaCode="555"/)
    assert.match(sanitized, /address1="Test Address [a-f0-9]{12}"/)
    assert.doesNotMatch(sanitized, /countryGeoId=|stateProvinceGeoId=|latitude=|longitude=/)
    assert.match(sanitized, /firstName="Test"/)
    assert.match(sanitized, /lastName="Customer-[a-f0-9]{12}"/)
    assert.match(sanitized, /idValue="customer-[a-f0-9]{16}"/)
    assert.match(sanitized, /OrderIdentification[^>]*idValue="12345"/)
    assert.doesNotMatch(sanitized, /createdDate=|deliveryId=|securityCode=|track2=|paymentMethodId=|cardName=|requestId=|parentRefNum=|applicationIdentifier=|labelHtml=|labelImage=|labelImageUrl=|gatewayMessage=|issuedByUserLoginId=|cancelledByUserLoginId=|wegsReferenceNumber=|deliveredToParty=/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('refuses to drop fulfillment rows whose inventory parent is unavailable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devkit-order-parent-test-'))
  const output = join(dir, 'export.xml')
  const xml = [
    '<entity-facade-xml>',
    '  <org.apache.ofbiz.order.order.OrderItem orderId="O1" orderItemSeqId="00001"/>',
    '  <org.apache.ofbiz.order.order.OrderItemShipGroup orderId="O1" shipGroupSeqId="00001"/>',
    '  <org.apache.ofbiz.order.order.OrderItemShipGrpInvRes orderId="O1" shipGroupSeqId="00001" orderItemSeqId="00001" inventoryItemId="MISSING"/>',
    '</entity-facade-xml>',
  ].join('\n')
  await import('node:fs/promises').then(({ writeFile }) => writeFile(output, xml, { mode: 0o600 }))
  try {
    await assert.rejects(() => sanitizeOrderCustomerData(output, new Set(), new Set()), /refusing to drop data/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
