import { join } from 'node:path'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, rename, unlink, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { once } from 'node:events'

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
    'raw',
  ]
}

export function remoteEntityResetSql(database) {
  if (!/^[A-Za-z0-9_]+$/.test(String(database || ''))) throw new Error('Invalid local database name.')
  const deletes = REMOTE_IMPORT_TARGET_TABLES.map((table) => `DELETE FROM \`${database}\`.\`${table}\`;`).join('\n')
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
  const output = createWriteStream(sanitizedLocation, { mode: 0o600 })
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
