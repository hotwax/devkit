import { dirname, join } from 'node:path'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { createHash } from 'node:crypto'

function createPrivateWriteStream(location) {
  const stream = createWriteStream(location, { mode: 0o600 })
  // Keep a permanent listener for errors emitted after destroy(). Awaited
  // drain/finish promises still reject on the original stream error, while a
  // late ERR_STREAM_DESTROYED cannot terminate DevKit and hide that error.
  stream.on('error', () => {})
  return stream
}

const PRODUCT = 'org.apache.ofbiz.product.product.Product'
const CATALOG_ENTITIES = [
  'org.apache.ofbiz.product.category.ProductCategory',
  PRODUCT,
  'org.apache.ofbiz.product.product.GoodIdentification',
  'org.apache.ofbiz.product.category.ProductCategoryMember',
  'org.apache.ofbiz.product.price.ProductPrice',
  'org.apache.ofbiz.product.product.ProductAssoc',
]
const INVENTORY_ENTITIES = [
  'moqui.basic.Enumeration',
  'org.apache.ofbiz.product.facility.Facility',
  'org.apache.ofbiz.product.facility.FacilityLocation',
  'org.apache.ofbiz.product.facility.ProductFacility',
  'org.apache.ofbiz.product.inventory.InventoryItem',
  'org.apache.ofbiz.product.inventory.InventoryItemDetail',
]

const ORDER_CUSTOMER_ENTITIES = [
  'org.apache.ofbiz.party.party.Party',
  'org.apache.ofbiz.party.party.Person',
  'org.apache.ofbiz.party.party.PartyGroup',
  'org.apache.ofbiz.party.party.PartyIdentification',
  'org.apache.ofbiz.party.party.PartyRole',
  'org.apache.ofbiz.party.contact.ContactMech',
  'org.apache.ofbiz.party.contact.PostalAddress',
  'org.apache.ofbiz.party.contact.TelecomNumber',
  'org.apache.ofbiz.party.contact.PartyContactMech',
  'org.apache.ofbiz.party.contact.PartyContactMechPurpose',
  'org.apache.ofbiz.shipment.shipment.ShipmentMethodType',
  'org.apache.ofbiz.shipment.shipment.CarrierShipmentMethod',
  'org.apache.ofbiz.shipment.shipment.ShipmentBoxType',
  'org.apache.ofbiz.accounting.payment.PaymentMethodType',
  'org.apache.ofbiz.product.inventory.InventoryItem',
  'org.apache.ofbiz.order.order.OrderHeader',
  'co.hotwax.order.OrderIdentification',
  'org.apache.ofbiz.order.order.OrderItemGroup',
  'org.apache.ofbiz.order.order.OrderItem',
  'org.apache.ofbiz.order.order.OrderItemShipGroup',
  'org.apache.ofbiz.order.order.OrderItemShipGrpInvRes',
  'org.apache.ofbiz.order.order.OrderItemContactMech',
  'org.apache.ofbiz.order.order.OrderRole',
  'org.apache.ofbiz.order.order.OrderContactMech',
  'org.apache.ofbiz.order.order.OrderItemAssoc',
  'org.apache.ofbiz.order.order.OrderAdjustment',
  'org.apache.ofbiz.order.order.OrderPaymentPreference',
  'org.apache.ofbiz.order.order.OrderStatus',
  'org.apache.ofbiz.shipment.shipment.Shipment',
  'org.apache.ofbiz.shipment.shipment.ShipmentItem',
  'org.apache.ofbiz.shipment.shipment.ShipmentPackage',
  'org.apache.ofbiz.shipment.shipment.ShipmentRouteSegment',
  'org.apache.ofbiz.shipment.shipment.ShipmentPackageContent',
  'org.apache.ofbiz.shipment.shipment.ShipmentPackageRouteSeg',
  'org.apache.ofbiz.shipment.shipment.ShipmentContactMech',
  'org.apache.ofbiz.shipment.shipment.ShipmentStatus',
  'org.apache.ofbiz.order.order.OrderShipment',
  'org.apache.ofbiz.shipment.issuance.ItemIssuance',
]

const REMOTE_IMPORT_TARGET_TABLES = [
  'INVENTORY_ITEM_DETAIL',
  'INVENTORY_ITEM',
  'PRODUCT_FACILITY',
  'FACILITY_LOCATION',
  'PRODUCT_ASSOC',
  'PRODUCT_PRICE',
  'PRODUCT_CATEGORY_MEMBER',
  'GOOD_IDENTIFICATION',
  'PRODUCT',
  'FACILITY',
  'PRODUCT_CATEGORY',
]

const ORDER_IMPORT_TARGET_TABLES = [
  'ITEM_ISSUANCE',
  'SHIPMENT_PACKAGE_ROUTE_SEG',
  'SHIPMENT_PACKAGE_CONTENT',
  'SHIPMENT_CONTACT_MECH',
  'SHIPMENT_STATUS',
  'ORDER_SHIPMENT',
  'SHIPMENT_ROUTE_SEGMENT',
  'SHIPMENT_PACKAGE',
  'SHIPMENT_ITEM',
  'SHIPMENT',
  'ORDER_STATUS',
  'ORDER_PAYMENT_PREFERENCE',
  'ORDER_ADJUSTMENT',
  'ORDER_CONTACT_MECH',
  'ORDER_ROLE',
  'ORDER_ITEM_CONTACT_MECH',
  'ORDER_ITEM_SHIP_GRP_INV_RES',
  'ORDER_ITEM_ASSOC',
  'ORDER_ITEM_SHIP_GROUP',
  'ORDER_ITEM',
  'ORDER_ITEM_GROUP',
  'ORDER_IDENTIFICATION',
  'ORDER_HEADER',
]

const SECRET_BEARING_REMOTE_ENTITY = 'moqui.service.message.SystemMessageRemote'

function profile(id, label, description, entities) {
  return Object.freeze({ id, label, description, entities: Object.freeze([...entities]) })
}

export const remoteEntityProfiles = Object.freeze({
  products: profile('products', 'Products', 'Product records only; the smallest proven import.', [PRODUCT]),
  catalog: profile('catalog', 'Catalog', 'Products, identifiers, categories, membership, prices, and associations.', CATALOG_ENTITIES),
  inventory: profile('inventory', 'Inventory', 'Safe enumeration configuration, facilities, product-facility settings, inventory items, and inventory history.', INVENTORY_ENTITIES),
  'catalog-inventory': profile('catalog-inventory', 'Catalog + inventory', 'The recommended non-secret commerce dataset.', [
    'moqui.basic.Enumeration',
    'org.apache.ofbiz.product.category.ProductCategory',
    'org.apache.ofbiz.product.facility.Facility',
    'org.apache.ofbiz.product.facility.FacilityLocation',
    PRODUCT,
    'org.apache.ofbiz.product.product.GoodIdentification',
    'org.apache.ofbiz.product.category.ProductCategoryMember',
    'org.apache.ofbiz.product.price.ProductPrice',
    'org.apache.ofbiz.product.product.ProductAssoc',
    'org.apache.ofbiz.product.facility.ProductFacility',
    'org.apache.ofbiz.product.inventory.InventoryItem',
    'org.apache.ofbiz.product.inventory.InventoryItemDetail',
  ]),
  'orders-customers': profile('orders-customers', 'Orders + scrubbed customers', 'Orders, linked customers, anonymized contact data, and fulfillment records without payment credentials or free-form notes.', ORDER_CUSTOMER_ENTITIES),
})

export function normalizeHotwaxSource(input) {
  const raw = String(input || '').trim()
  if (!raw) throw new Error('A source HotWax instance is required.')
  const url = new URL(raw.includes('://') ? raw : `https://${raw}`)
  if (url.protocol !== 'https:') throw new Error('The source must use HTTPS.')
  if (url.username || url.password) throw new Error('Do not put credentials in the source URL; DevKit uses Keychain.')
  const hostname = url.hostname.toLowerCase()
  if (hostname !== 'hotwax.io' && !hostname.endsWith('.hotwax.io')) throw new Error('The source hostname must be hotwax.io or a hotwax.io subdomain.')
  return `https://${url.host}`
}

export function keychainServiceForSource(source) {
  normalizeHotwaxSource(source)
  return 'hotwax-domain:hotwax.io'
}

export function keychainPasswordArgs(account, source) {
  const username = String(account || '').trim()
  if (!username) throw new Error('A Keychain account is required.')
  return ['find-generic-password', '-a', username, '-s', keychainServiceForSource(source), '-w']
}

export function remoteEntityEndpoints(source) {
  const origin = normalizeHotwaxSource(source)
  return {
    login: `${origin}/rest/s1/admin/login`,
    information: `${origin}/rest/s1/admin/maarg`,
    export: `${origin}/apps/tools/Entity/DataExport/EntityExport`,
  }
}

export function assertRemoteEntityProfileSafe(selectedProfile) {
  for (const entityName of selectedProfile?.entities || []) {
    if (entityName === SECRET_BEARING_REMOTE_ENTITY || entityName.endsWith('.SystemMessageRemote')) {
      throw new Error(`Remote import profiles must never include secret-bearing entity ${entityName}.`)
    }
  }
  return selectedProfile
}

export function getRemoteEntityProfile(id) {
  const selected = remoteEntityProfiles[String(id || '')]
  if (!selected) throw new Error(`Unknown safe entity profile: ${id || '(empty)'}.`)
  return assertRemoteEntityProfileSafe(selected)
}

export function buildEntityExportForm(selectedProfile) {
  const profile = getRemoteEntityProfile(selectedProfile?.id)
  return new URLSearchParams({
    entityNames: profile.entities.join(','),
    dependentLevels: '0',
    fileType: 'XML',
    output: 'browser',
  })
}

export function moquiEntityLoadArgs(home, location) {
  return [
    '-server',
    '-Dmoqui.conf=conf/MoquiDevConf.xml',
    '-Dmoqui.runtime=runtime',
    '-Dscheduled_job_check_time=0',
    '-Dscheduled.mdm.check.time=0',
    '-jar',
    join(home, 'moqui.war'),
    'load',
    `location=${location}`,
    'timeout=1800',
    'no-fk-create',
    'disable-eeca',
    'disable-audit-log',
    'disable-data-feed',
  ]
}

export function remoteEntityResetSql(database, profileId = 'catalog-inventory') {
  if (!/^[A-Za-z0-9_]+$/.test(String(database || ''))) throw new Error('Invalid local database name.')
  const targetTables = profileId === 'orders-customers'
    ? ORDER_IMPORT_TARGET_TABLES
    : ['products', 'catalog', 'inventory', 'catalog-inventory'].includes(profileId) ? REMOTE_IMPORT_TARGET_TABLES : null
  if (!targetTables) throw new Error(`Unknown reset profile: ${profileId || '(empty)'}.`)
  const deletes = targetTables.map((table) => `DELETE FROM \`${database}\`.\`${table}\`;`).join('\n')
  return `START TRANSACTION;\nSET FOREIGN_KEY_CHECKS=0;\n${deletes}\nCOMMIT;\nSET FOREIGN_KEY_CHECKS=1;`
}

function xmlAttribute(line, field) {
  return line.match(new RegExp(`\\s${field}="([^"]+)"`))?.[1]
}

function xmlElementStructure(text) {
  let depth = 0
  let sawElement = false
  let firstTag = null
  let index = 0
  while (index < text.length) {
    const open = text.indexOf('<', index)
    if (open < 0) break
    if (text.startsWith('<!--', open)) {
      const close = text.indexOf('-->', open + 4)
      if (close < 0) return { complete: false, depth, sawElement, firstTag }
      index = close + 3
      continue
    }
    if (text.startsWith('<![CDATA[', open)) {
      const close = text.indexOf(']]>', open + 9)
      if (close < 0) return { complete: false, depth, sawElement, firstTag }
      index = close + 3
      continue
    }
    if (text.startsWith('<?', open)) {
      const close = text.indexOf('?>', open + 2)
      if (close < 0) return { complete: false, depth, sawElement, firstTag }
      index = close + 2
      continue
    }
    let close = open + 1
    let quote = ''
    for (; close < text.length; close++) {
      const char = text[close]
      if (quote) { if (char === quote) quote = ''; continue }
      if (char === '"' || char === "'") { quote = char; continue }
      if (char === '>') break
    }
    if (close >= text.length) return { complete: false, depth, sawElement, firstTag }
    const token = text.slice(open + 1, close).trim()
    const closing = token.startsWith('/')
    const name = token.replace(/^\//, '').match(/^([A-Za-z_][A-Za-z0-9_.:-]*)/)?.[1]
    if (name) {
      if (!firstTag) firstTag = name
      if (closing) depth--
      else {
        sawElement = true
        if (!/\/\s*$/.test(token)) depth++
      }
      if (depth < 0) return { complete: false, depth, sawElement, firstTag }
    }
    index = close + 1
  }
  return { complete: sawElement && depth === 0, depth, sawElement, firstTag }
}

async function* normalizedEntityExportLines(location) {
  const lines = createInterface({ input: createReadStream(location), crlfDelay: Infinity })
  let pending = []
  for await (const line of lines) {
    const trimmed = line.trim()
    if (!pending.length && (!trimmed || trimmed.startsWith('<?xml') || trimmed === '<entity-facade-xml>' || trimmed === '</entity-facade-xml>')) {
      yield line
      continue
    }
    pending.push(trimmed)
    const logicalRecord = pending.join(' ')
    if (xmlElementStructure(logicalRecord).complete) {
      yield `    ${logicalRecord}`
      pending = []
    }
  }
  if (pending.length) throw new Error('Rails export ended inside a multi-line entity record.')
}

function parentFirst(lines, idField, parentField) {
  const records = lines.map((line) => ({ line, id: xmlAttribute(line, idField), parent: xmlAttribute(line, parentField) }))
  const byId = new Map(records.filter(({ id }) => id).map((record) => [record.id, record]))
  const visiting = new Set()
  const visited = new Set()
  const ordered = []
  const visit = (record) => {
    if (!record.id || visited.has(record.id)) return
    if (visiting.has(record.id)) return
    visiting.add(record.id)
    if (record.parent && byId.has(record.parent)) visit(byId.get(record.parent))
    visiting.delete(record.id)
    if (!visited.has(record.id)) { visited.add(record.id); ordered.push(record.line) }
  }
  for (const record of records) visit(record)
  for (const record of records) if (!record.id) ordered.push(record.line)
  return ordered
}

export function inspectMoquiEntityLoadLog(logText, expectedRecords) {
  const text = String(logText || '')
  const matches = [...text.matchAll(/Loaded \[(\d+)\] records in/g)]
  const records = matches.length ? Number(matches.at(-1)[1]) : null
  if (/Skipping to next file after error|Error loading entity data|Error storing entity/i.test(text)) {
    return { ok: false, records, error: 'Moqui loader reported an entity error.' }
  }
  if (records === null) return { ok: false, records, error: 'Moqui loader did not report a processed record count.' }
  if (records !== expectedRecords) {
    return { ok: false, records, error: `Moqui loader processed ${records} of ${expectedRecords} exported records.` }
  }
  return { ok: true, records }
}

export async function sanitizeExcludedEntityReferences(location) {
  const inventoryItemTag = /<org\.apache\.ofbiz\.product\.inventory\.InventoryItem(?:\s|\/?>)/
  const inventoryItemDetailTag = /<org\.apache\.ofbiz\.product\.inventory\.InventoryItemDetail(?:\s|\/?>)/
  const rules = [
    { tag: /<org\.apache\.ofbiz\.product\.facility\.Facility(?:\s|\/?>)/, fields: ['ownerPartyId', 'geoPointId'] },
    { tag: /<org\.apache\.ofbiz\.product\.facility\.FacilityLocation(?:\s|\/?>)/, fields: ['geoPointId'] },
    { tag: /<org\.apache\.ofbiz\.product\.inventory\.InventoryItem(?:\s|\/?>)/, fields: ['partyId', 'ownerPartyId'] },
    { tag: /<org\.apache\.ofbiz\.product\.inventory\.InventoryItemDetail(?:\s|\/?>)/, fields: ['resetItemId'] },
    { tag: /<(?:org\.apache\.ofbiz\.product\.product\.Product|products)(?:\s|\/?>)/, fields: ['originGeoId'] },
    { tag: /<org\.apache\.ofbiz\.product\.price\.ProductPrice(?:\s|\/?>)/, fields: ['taxAuthPartyId', 'taxAuthGeoId'] },
  ]
  const sortable = [
    { tag: /<(?:org\.apache\.ofbiz\.product\.category\.ProductCategory|categories)(?:\s|\/?>)/, id: 'productCategoryId', parent: 'primaryParentCategoryId', lines: [], ordered: [] },
    { tag: /<org\.apache\.ofbiz\.product\.facility\.Facility(?:\s|\/?>)/, id: 'facilityId', parent: 'parentFacilityId', lines: [], ordered: [] },
  ]
  for await (const line of normalizedEntityExportLines(location)) {
    const spec = sortable.find(({ tag }) => tag.test(line))
    if (spec) spec.lines.push(line)
  }
  for (const spec of sortable) spec.ordered = parentFirst(spec.lines, spec.id, spec.parent)

  const sanitizedLocation = `${location}.sanitized`
  const output = createPrivateWriteStream(sanitizedLocation)
  let recordsChanged = 0
  let referencesRemoved = 0
  let recordsRemoved = 0
  const inventoryItemIds = new Set()
  const emittedSortable = new Set()
  const sanitizeLine = (sourceLine) => {
    let line = sourceLine
    const rule = rules.find(({ tag }) => tag.test(line))
    let changed = false
    if (rule) {
      for (const field of rule.fields) {
        const next = line.replace(new RegExp(`\\s${field}="[^"]*"`), '')
        if (next !== line) {
          line = next
          changed = true
          referencesRemoved++
        }
      }
    }
    if (changed) recordsChanged++
    return line
  }
  try {
    for await (let line of normalizedEntityExportLines(location)) {
      const sortableSpec = sortable.find(({ tag }) => tag.test(line))
      if (sortableSpec) {
        if (!emittedSortable.has(sortableSpec.id)) {
          emittedSortable.add(sortableSpec.id)
          for (const orderedLine of sortableSpec.ordered) {
            if (!output.write(`${sanitizeLine(orderedLine)}\n`)) await once(output, 'drain')
          }
        }
        continue
      }
      if (inventoryItemTag.test(line)) {
        const inventoryItemId = xmlAttribute(line, 'inventoryItemId')
        if (inventoryItemId) inventoryItemIds.add(inventoryItemId)
      } else if (inventoryItemDetailTag.test(line)) {
        const inventoryItemId = xmlAttribute(line, 'inventoryItemId')
        if (inventoryItemId && !inventoryItemIds.has(inventoryItemId)) {
          recordsRemoved++
          continue
        }
      }
      line = sanitizeLine(line)
      if (!output.write(`${line}\n`)) await once(output, 'drain')
    }
    output.end()
    await once(output, 'finish')
    await rename(sanitizedLocation, location)
  } catch (error) {
    output.destroy()
    await unlink(sanitizedLocation).catch(() => {})
    throw error
  }
  return { recordsChanged, referencesRemoved, recordsRemoved }
}

function stableToken(value, length = 12) {
  return createHash('sha256').update(String(value || 'missing')).digest('hex').slice(0, length)
}

function xmlEscape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function removeXmlField(record, field) {
  const attributePattern = new RegExp(`\\s${field}=(?:"[^"]*"|'[^']*')`, 'g')
  const childPattern = new RegExp(`\\s*<${field}(?:\\s[^>]*)?>[\\s\\S]*?</${field}>`, 'g')
  const selfClosingChildPattern = new RegExp(`\\s*<${field}(?:\\s[^>]*)?/\\s*>`, 'g')
  const attributes = record.match(attributePattern)?.length || 0
  const children = record.match(childPattern)?.length || 0
  const selfClosingChildren = record.match(selfClosingChildPattern)?.length || 0
  return {
    record: record.replace(attributePattern, '').replace(childPattern, '').replace(selfClosingChildPattern, ''),
    count: attributes + children + selfClosingChildren,
  }
}

function replaceXmlField(record, field, value) {
  const escaped = xmlEscape(value)
  const attributePattern = new RegExp(`(\\s${field}=")[^"]*(")`, 'g')
  const childPattern = new RegExp(`<${field}(\\s[^>]*)?>[\\s\\S]*?</${field}>`, 'g')
  const attributes = record.match(attributePattern)?.length || 0
  const children = record.match(childPattern)?.length || 0
  return {
    record: record
      .replace(attributePattern, `$1${escaped}$2`)
      .replace(childPattern, (_match, attributesText = '') => `<${field}${attributesText}>${escaped}</${field}>`),
    count: attributes + children,
  }
}

function addXmlAttributes(record, fields, target) {
  for (const field of fields) {
    const value = xmlAttribute(record, field)
    if (value) target.add(value)
  }
}

export async function sanitizeOrderCustomerData(location, existingPartyIds = new Set(), existingInventoryItemIds = null) {
  const customerPartyIds = new Set()
  const referencedPartyIds = new Set()
  const selectedContactMechIds = new Set()
  const exportedPartyIds = new Set()
  const exportedInventoryItemIds = new Set()
  const orderItemKeys = new Set()
  const shipGroupKeys = new Set()
  const compositeKey = (...values) => values.every(Boolean) ? values.join('\u0000') : null

  for await (const record of normalizedEntityExportLines(location)) {
    const tag = xmlElementStructure(record.trim()).firstTag
    if (tag === 'org.apache.ofbiz.party.party.Party') {
      const partyId = xmlAttribute(record, 'partyId')
      if (partyId) exportedPartyIds.add(partyId)
    } else if (tag === 'org.apache.ofbiz.product.inventory.InventoryItem') {
      const inventoryItemId = xmlAttribute(record, 'inventoryItemId')
      if (inventoryItemId) exportedInventoryItemIds.add(inventoryItemId)
    } else if (tag === 'org.apache.ofbiz.order.order.OrderItem') {
      const key = compositeKey(xmlAttribute(record, 'orderId'), xmlAttribute(record, 'orderItemSeqId'))
      if (key) orderItemKeys.add(key)
    } else if (tag === 'org.apache.ofbiz.order.order.OrderRole') {
      const partyId = xmlAttribute(record, 'partyId')
      const roleTypeId = xmlAttribute(record, 'roleTypeId') || ''
      if (partyId) referencedPartyIds.add(partyId)
      if (partyId && roleTypeId.includes('CUSTOMER')) customerPartyIds.add(partyId)
    } else if (tag === 'org.apache.ofbiz.order.order.OrderItemShipGroup') {
      const key = compositeKey(xmlAttribute(record, 'orderId'), xmlAttribute(record, 'shipGroupSeqId'))
      if (key) shipGroupKeys.add(key)
      addXmlAttributes(record, ['supplierPartyId', 'vendorPartyId', 'carrierPartyId'], referencedPartyIds)
      addXmlAttributes(record, ['contactMechId', 'telecomContactMechId'], selectedContactMechIds)
    } else if (tag === 'org.apache.ofbiz.order.order.OrderAdjustment') {
      addXmlAttributes(record, ['taxAuthPartyId'], referencedPartyIds)
    } else if (tag === 'org.apache.ofbiz.order.order.OrderContactMech' || tag === 'org.apache.ofbiz.order.order.OrderItemContactMech') {
      addXmlAttributes(record, ['contactMechId'], selectedContactMechIds)
    } else if (tag === 'org.apache.ofbiz.shipment.shipment.Shipment') {
      addXmlAttributes(record, ['partyIdTo', 'partyIdFrom'], referencedPartyIds)
      addXmlAttributes(record, ['originContactMechId', 'originTelecomNumberId', 'destinationContactMechId', 'destinationTelecomNumberId'], selectedContactMechIds)
    } else if (tag === 'org.apache.ofbiz.shipment.shipment.ShipmentRouteSegment') {
      addXmlAttributes(record, ['carrierPartyId'], referencedPartyIds)
      addXmlAttributes(record, ['originContactMechId', 'originTelecomNumberId', 'destContactMechId', 'destTelecomNumberId'], selectedContactMechIds)
    } else if (tag === 'org.apache.ofbiz.shipment.shipment.ShipmentContactMech') {
      addXmlAttributes(record, ['contactMechId'], selectedContactMechIds)
    }
  }

  for await (const record of normalizedEntityExportLines(location)) {
    if (xmlElementStructure(record.trim()).firstTag !== 'org.apache.ofbiz.party.contact.PartyContactMech') continue
    const partyId = xmlAttribute(record, 'partyId')
    const contactMechId = xmlAttribute(record, 'contactMechId')
    if (partyId && contactMechId && customerPartyIds.has(partyId)) selectedContactMechIds.add(contactMechId)
  }

  const partyScopedTags = new Set([
    'org.apache.ofbiz.party.party.Party',
    'org.apache.ofbiz.party.party.Person',
    'org.apache.ofbiz.party.party.PartyGroup',
    'org.apache.ofbiz.party.party.PartyIdentification',
  ])
  const contactScopedTags = new Set([
    'org.apache.ofbiz.party.contact.ContactMech',
    'org.apache.ofbiz.party.contact.PostalAddress',
    'org.apache.ofbiz.party.contact.TelecomNumber',
  ])
  const partyContactTags = new Set([
    'org.apache.ofbiz.party.contact.PartyContactMech',
    'org.apache.ofbiz.party.contact.PartyContactMechPurpose',
  ])
  const sanitizedLocation = `${location}.order-sanitized`
  const output = createPrivateWriteStream(sanitizedLocation)
  let recordsChanged = 0
  let recordsRemoved = 0
  let fieldsRemoved = 0
  let fieldsReplaced = 0
  let existingPartiesExcluded = 0
  const partyAvailable = (partyId) => Boolean(partyId && (existingPartyIds.has(partyId) || exportedPartyIds.has(partyId)))
  const inventoryAvailable = (inventoryItemId) => Boolean(inventoryItemId && ((existingInventoryItemIds instanceof Set && existingInventoryItemIds.has(inventoryItemId)) || exportedInventoryItemIds.has(inventoryItemId)))

  const sanitizeRecord = (source, tag) => {
    let record = source
    const remove = (fields) => {
      for (const field of fields) {
        const result = removeXmlField(record, field)
        record = result.record
        fieldsRemoved += result.count
      }
    }
    const replace = (field, value) => {
      const result = replaceXmlField(record, field, value)
      record = result.record
      fieldsReplaced += result.count
    }
    const partyId = xmlAttribute(record, 'partyId')
    const contactMechId = xmlAttribute(record, 'contactMechId')
    const token = stableToken(partyId || contactMechId || xmlAttribute(record, 'orderId') || xmlAttribute(record, 'shipmentId') || record)

    if (tag === 'org.apache.ofbiz.party.party.Party') {
      // Shared seed parties (for example COMPANY) already exist locally. Moqui
      // treats createdDate as immutable, so never attempt to update it.
      remove(['createdDate'])
      if (customerPartyIds.has(partyId)) {
        replace('externalId', `customer-${token}`)
        remove(['description', 'createdByUserLogin', 'lastModifiedByUserLogin'])
      }
    } else if (tag === 'org.apache.ofbiz.party.party.Person') {
      replace('firstName', 'Test')
      replace('lastName', `Customer-${token}`)
      remove(['salutation', 'middleName', 'personalTitle', 'suffix', 'nickname', 'firstNameLocal', 'middleNameLocal', 'lastNameLocal', 'otherLocal', 'memberId', 'gender', 'birthDate', 'deceasedDate', 'height', 'weight', 'mothersMaidenName', 'maritalStatus', 'socialSecurityNumber', 'passportNumber', 'passportExpireDate', 'totalYearsWorkExperience', 'comments', 'occupation', 'yearsWithEmployer', 'monthsWithEmployer', 'cardId'])
    } else if (tag === 'org.apache.ofbiz.party.party.PartyGroup' && customerPartyIds.has(partyId)) {
      replace('groupName', `Test Group ${token}`)
      replace('groupNameLocal', `Test Group ${token}`)
      remove(['officeSiteName', 'tickerSymbol', 'comments', 'logoImageUrl'])
    } else if (tag === 'org.apache.ofbiz.party.party.PartyIdentification' && customerPartyIds.has(partyId)) {
      replace('idValue', `customer-${stableToken(`${partyId}:${xmlAttribute(record, 'partyIdentificationTypeId')}`, 16)}`)
    } else if (tag === 'org.apache.ofbiz.party.contact.ContactMech') {
      const type = xmlAttribute(record, 'contactMechTypeId') || ''
      replace('externalId', `contact-${token}`)
      if (type === 'EMAIL_ADDRESS') replace('infoString', `test-${token}@example.invalid`)
      else if (type === 'WEB_ADDRESS') replace('infoString', `https://example.invalid/${token}`)
      else if (type === 'IP_ADDRESS') replace('infoString', `192.0.2.${(parseInt(token.slice(0, 2), 16) % 254) + 1}`)
      else replace('infoString', `redacted-${token}`)
    } else if (tag === 'org.apache.ofbiz.party.contact.TelecomNumber') {
      replace('countryCode', '1')
      replace('areaCode', '555')
      replace('contactNumber', String(parseInt(token.slice(0, 8), 16) % 10000000).padStart(7, '0'))
      replace('askForName', 'Test Customer')
    } else if (tag === 'org.apache.ofbiz.party.contact.PostalAddress') {
      replace('toName', `Test Customer ${token}`)
      replace('attnName', 'Test Customer')
      replace('address1', `Test Address ${token}`)
      replace('address2', 'Unit Test')
      replace('houseNumber', '100')
      replace('houseNumberExt', 'T')
      replace('directions', 'Redacted')
      replace('city', 'Test City')
      replace('postalCode', '00000')
      replace('postalCodeExt', '0000')
      remove(['countryGeoId', 'stateProvinceGeoId', 'cityGeoId', 'countyGeoId', 'municipalityGeoId', 'postalCodeGeoId', 'geoPointId', 'latitude', 'longitude'])
    } else if (tag === 'org.apache.ofbiz.party.contact.PartyContactMech') {
      remove(['extension', 'comments', 'yearsWithContactMech', 'monthsWithContactMech'])
    } else if (tag === 'org.apache.ofbiz.order.order.OrderHeader') {
      remove(['visitId', 'createdBy', 'terminalId', 'transactionId', 'internalCode'])
    } else if (tag === 'org.apache.ofbiz.order.order.OrderItem') {
      remove(['comments', 'dontCancelSetUserLogin', 'changeByUserLoginId'])
    } else if (tag === 'org.apache.ofbiz.order.order.OrderItemShipGroup') {
      replace('trackingNumber', `TEST-${token}`)
      remove(['shippingInstructions', 'giftMessage'])
      for (const field of ['supplierPartyId', 'vendorPartyId', 'carrierPartyId']) if (!partyAvailable(xmlAttribute(record, field))) remove([field])
    } else if (tag === 'org.apache.ofbiz.order.order.OrderAdjustment') {
      remove(['description', 'comments', 'customerReferenceId', 'createdByUserLogin', 'lastModifiedByUserLogin'])
      if (!partyAvailable(xmlAttribute(record, 'taxAuthPartyId'))) remove(['taxAuthPartyId'])
    } else if (tag === 'org.apache.ofbiz.order.order.OrderPaymentPreference') {
      remove(['paymentMethodId', 'finAccountId', 'securityCode', 'track2', 'billingPostalCode', 'manualAuthCode', 'manualRefNum', 'cardName', 'requestId', 'parentRefNum', 'applicationIdentifier', 'createdByUserLogin', 'lastModifiedByUserLogin'])
    } else if (tag === 'org.apache.ofbiz.order.order.OrderStatus') {
      remove(['statusUserLogin', 'changeReason'])
    } else if (tag === 'org.apache.ofbiz.shipment.shipment.Shipment') {
      remove(['handlingInstructions', 'addtlShippingChargeDesc', 'primaryReturnId', 'picklistBinId', 'createdByUserLogin', 'lastModifiedByUserLogin'])
      for (const field of ['partyIdTo', 'partyIdFrom']) if (!partyAvailable(xmlAttribute(record, field))) remove([field])
    } else if (tag === 'org.apache.ofbiz.shipment.shipment.ShipmentItem') {
      remove(['shipmentContentDescription'])
    } else if (tag === 'org.apache.ofbiz.shipment.shipment.ShipmentRouteSegment') {
      replace('trackingIdNumber', `TEST-${token}`)
      remove(['deliveryId', 'trackingDigest', 'carrierRestrictionDesc', 'updatedByUserLoginId', 'thirdPartyAccountNumber', 'thirdPartyPostalCode', 'thirdPartyCountryGeoCode', 'upsHighValueReport', 'codReturnLabelImage', 'codReturnLabelHtml', 'carrierAccountNumber', 'referenceNumber', 'trackingUrl', 'labelImage', 'labelImageUrl', 'labelHtml', 'gatewayRateId'])
      if (!partyAvailable(xmlAttribute(record, 'carrierPartyId'))) remove(['carrierPartyId'])
    } else if (tag === 'org.apache.ofbiz.shipment.shipment.ShipmentPackageRouteSeg') {
      replace('trackingCode', `TEST-${token}`)
      remove(['labelImage', 'labelIntlSignImage', 'labelHtml', 'internationalInvoice', 'labelImageUrl', 'internationalInvoiceUrl', 'packagePickupPrn', 'gatewayMessage'])
    } else if (tag === 'org.apache.ofbiz.shipment.issuance.ItemIssuance') {
      remove(['issuedByUserLoginId', 'cancelledByUserLoginId', 'wegsReferenceNumber', 'deliveredToParty'])
    }
    return record
  }

  try {
    for await (let record of normalizedEntityExportLines(location)) {
      const trimmed = record.trim()
      const tag = xmlElementStructure(trimmed).firstTag
      const partyId = xmlAttribute(record, 'partyId')
      const contactMechId = xmlAttribute(record, 'contactMechId')
      if (tag === 'org.apache.ofbiz.order.order.OrderItemShipGrpInvRes') {
        const orderItemKey = compositeKey(xmlAttribute(record, 'orderId'), xmlAttribute(record, 'orderItemSeqId'))
        const shipGroupKey = compositeKey(xmlAttribute(record, 'orderId'), xmlAttribute(record, 'shipGroupSeqId'))
        const inventoryItemId = xmlAttribute(record, 'inventoryItemId')
        if (!orderItemKey || !shipGroupKey || !orderItemKeys.has(orderItemKey) || !shipGroupKeys.has(shipGroupKey)) throw new Error('Order inventory reservation is missing its exported order item or ship group parent; refusing to drop data.')
        if (!inventoryAvailable(inventoryItemId)) throw new Error('Order inventory reservation is missing its InventoryItem parent; refusing to drop data.')
      }
      if (tag === 'org.apache.ofbiz.shipment.issuance.ItemIssuance') {
        const inventoryItemId = xmlAttribute(record, 'inventoryItemId')
        if (inventoryItemId && !inventoryAvailable(inventoryItemId)) throw new Error('ItemIssuance is missing its InventoryItem parent; refusing to drop data.')
      }
      if (partyScopedTags.has(tag) && tag !== 'org.apache.ofbiz.party.party.Party' && partyId && !partyAvailable(partyId)) throw new Error(`${tag} is missing its Party parent; refusing to drop data.`)
      if (tag === 'org.apache.ofbiz.party.party.PartyRole' && partyId && !partyAvailable(partyId)) throw new Error('PartyRole is missing its Party parent; refusing to drop data.')
      if (tag === 'org.apache.ofbiz.party.party.PartyRole' && partyId && !referencedPartyIds.has(partyId)) { recordsRemoved++; continue }
      if (tag === 'org.apache.ofbiz.shipment.shipment.CarrierShipmentMethod' && partyId && !partyAvailable(partyId)) throw new Error('CarrierShipmentMethod is missing its Party parent; refusing to drop data.')
      if (tag === 'org.apache.ofbiz.shipment.shipment.CarrierShipmentMethod' && partyId && !referencedPartyIds.has(partyId)) { recordsRemoved++; continue }
      if (tag === 'org.apache.ofbiz.order.order.OrderRole' && partyId && !partyAvailable(partyId)) throw new Error('OrderRole is missing its Party parent; refusing to drop data.')
      if (partyContactTags.has(tag) && partyId && !partyAvailable(partyId)) throw new Error(`${tag} is missing its Party parent; refusing to drop data.`)
      if (partyScopedTags.has(tag) && partyId && existingPartyIds.has(partyId)) { existingPartiesExcluded++; recordsRemoved++; continue }
      if (partyScopedTags.has(tag) && partyId && !referencedPartyIds.has(partyId)) { recordsRemoved++; continue }
      if (contactScopedTags.has(tag) && contactMechId && !selectedContactMechIds.has(contactMechId)) { recordsRemoved++; continue }
      if (partyContactTags.has(tag) && (!partyId || !contactMechId || !referencedPartyIds.has(partyId) || !selectedContactMechIds.has(contactMechId))) { recordsRemoved++; continue }
      const sanitized = sanitizeRecord(record, tag)
      if (tag === 'org.apache.ofbiz.party.party.Party' && /(?:\\screatedDate\\s*=|<createdDate\\b)/.test(sanitized)) {
        throw new Error('Party immutable createdDate survived the safe import scrubber.')
      }
      if (sanitized !== record) recordsChanged++
      if (!output.write(`${sanitized}\n`)) await once(output, 'drain')
    }
    output.end()
    await once(output, 'finish')
    await rename(sanitizedLocation, location)
  } catch (error) {
    output.destroy()
    await unlink(sanitizedLocation).catch(() => {})
    throw error
  }
  return {
    recordsChanged, recordsRemoved, fieldsRemoved, fieldsReplaced,
    customerParties: customerPartyIds.size, referencedParties: referencedPartyIds.size, contactMechs: selectedContactMechIds.size, existingPartiesExcluded,
  }
}

export function validateEntityExport(contentType, body) {
  if (!String(contentType || '').toLowerCase().includes('xml')) throw new Error('Rails export did not return XML.')
  const xml = Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '')
  if (!/<entity-facade-xml(?:\s|\/?>)/.test(xml)) throw new Error('Rails export is not Moqui entity-facade XML.')

  let depth = 0
  let records = 0
  for (const match of xml.matchAll(/<\s*(\/?)\s*([A-Za-z_][A-Za-z0-9_.:-]*)([^>]*)>/g)) {
    const closing = match[1] === '/'
    const selfClosing = /\/\s*$/.test(match[3])
    if (closing) { depth = Math.max(0, depth - 1); continue }
    if (depth === 1) records++
    if (!selfClosing) depth++
  }
  if (!records) throw new Error('Rails export contained no records.')
  return records
}

export async function saveEntityExportResponse(response, location) {
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.toLowerCase().includes('xml')) throw new Error('Rails export did not return XML.')
  if (!response.body) throw new Error('Rails export returned no response body.')

  const decoder = new TextDecoder()
  let pending = ''
  let depth = 0
  let sawRoot = false
  let records = 0
  let bytes = 0
  const inspect = (text) => {
    pending += text
    while (true) {
      const start = pending.indexOf('<')
      if (start < 0) { pending = ''; return }
      const end = pending.indexOf('>', start + 1)
      if (end < 0) { pending = pending.slice(start); return }
      const token = pending.slice(start + 1, end).trim()
      pending = pending.slice(end + 1)
      if (!token || token.startsWith('?') || token.startsWith('!')) continue
      const closing = token.startsWith('/')
      const selfClosing = token.endsWith('/')
      const name = token.replace(/^\//, '').match(/^([A-Za-z_][A-Za-z0-9_.:-]*)/)?.[1]
      if (!name) continue
      if (closing) { depth = Math.max(0, depth - 1); continue }
      if (depth === 0 && name === 'entity-facade-xml') sawRoot = true
      else if (depth === 1) records++
      if (!selfClosing) depth++
    }
  }

  const file = await open(location, 'w', 0o600)
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk)
      bytes += buffer.length
      inspect(decoder.decode(buffer, { stream: true }))
      await file.write(buffer)
    }
    inspect(decoder.decode())
  } catch (e) {
    await file.close().catch(() => {})
    await unlink(location).catch(() => {})
    throw e
  }
  await file.close()
  if (!sawRoot) { await unlink(location).catch(() => {}); throw new Error('Rails export is not Moqui entity-facade XML.') }
  if (!records) { await unlink(location).catch(() => {}); throw new Error('Rails export contained no records.') }
  return { bytes, records }
}

export async function orderEntityExportByProfile(location, entityNames) {
  const orderedNames = [...entityNames]
  if (!orderedNames.length || new Set(orderedNames).size !== orderedNames.length) throw new Error('Entity dependency order must be a non-empty unique list.')
  const indexByName = new Map(orderedNames.map((name, index) => [name, index]))
  const partsDir = join(dirname(location), `.entity-order-${process.pid}-${Date.now()}`)
  const orderedLocation = `${location}.profile-ordered`
  await mkdir(partsDir, { recursive: false, mode: 0o700 })
  const streams = new Map()
  const partLocation = (index) => join(partsDir, `${String(index).padStart(4, '0')}.xmlpart`)
  const streamFor = (index) => {
    let stream = streams.get(index)
    if (!stream) { stream = createPrivateWriteStream(partLocation(index)); streams.set(index, stream) }
    return stream
  }
  let records = 0
  let output
  try {
    for await (const record of normalizedEntityExportLines(location)) {
      const trimmed = record.trim()
      if (!trimmed || trimmed.startsWith('<?xml') || trimmed === '<entity-facade-xml>' || trimmed === '</entity-facade-xml>') continue
      const tag = xmlElementStructure(trimmed).firstTag
      const index = indexByName.get(tag)
      if (index === undefined) throw new Error(`Safe export contained entity outside its fixed profile: ${tag || '(unknown)'}.`)
      const stream = streamFor(index)
      if (!stream.write(`${record}\n`)) await once(stream, 'drain')
      records++
    }
    const finishPromises = [...streams.values()].map((stream) => once(stream, 'finish'))
    for (const stream of streams.values()) stream.end()
    await Promise.all(finishPromises)

    output = createPrivateWriteStream(orderedLocation)
    if (!output.write('<?xml version="1.0" encoding="UTF-8"?>\n<entity-facade-xml>\n')) await once(output, 'drain')
    for (let index = 0; index < orderedNames.length; index++) {
      if (!streams.has(index)) continue
      for await (const chunk of createReadStream(partLocation(index))) {
        if (!output.write(chunk)) await once(output, 'drain')
      }
    }
    output.end('</entity-facade-xml>\n')
    await once(output, 'finish')
    await rename(orderedLocation, location)
    return { records, entitiesWithRecords: streams.size }
  } catch (error) {
    for (const stream of streams.values()) stream.destroy()
    output?.destroy()
    await unlink(orderedLocation).catch(() => {})
    throw error
  } finally {
    await rm(partsDir, { recursive: true, force: true })
  }
}

export async function splitEntityExportForLoad(location, outputDir, maxRecordsPerFile = 100000) {
  if (!Number.isSafeInteger(maxRecordsPerFile) || maxRecordsPerFile < 1) throw new Error('Load chunk size must be a positive integer.')
  await mkdir(outputDir, { recursive: true, mode: 0o700 })
  const chunks = []
  let records = []
  const flush = async () => {
    if (!records.length) return
    const index = chunks.length + 1
    const chunk = { location: join(outputDir, `chunk-${String(index).padStart(4, '0')}.xml`), records: records.length }
    const content = `<?xml version="1.0" encoding="UTF-8"?>\n<entity-facade-xml>\n${records.join('\n')}\n</entity-facade-xml>\n`
    await writeFile(chunk.location, content, { mode: 0o600 })
    chunks.push(chunk)
    records = []
  }
  for await (const line of normalizedEntityExportLines(location)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('<?xml') || trimmed === '<entity-facade-xml>' || trimmed === '</entity-facade-xml>') continue
    const structure = xmlElementStructure(trimmed)
    if (!structure.complete || structure.firstTag === 'entity-facade-xml') {
      throw new Error(`Rails export contained an incomplete logical entity record that cannot be safely chunked (tag=${structure.firstTag || 'unknown'}, chars=${trimmed.length}, depth=${structure.depth}).`)
    }
    records.push(line)
    if (records.length >= maxRecordsPerFile) await flush()
  }
  await flush()
  if (!chunks.length) throw new Error('Rails export contained no records to load.')
  return chunks
}
