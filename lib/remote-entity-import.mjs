import { join } from 'node:path'
import { open, unlink } from 'node:fs/promises'

const PRODUCT = 'org.apache.ofbiz.product.product.Product'
const CATALOG_ENTITIES = [
  PRODUCT,
  'org.apache.ofbiz.product.product.GoodIdentification',
  'org.apache.ofbiz.product.category.ProductCategory',
  'org.apache.ofbiz.product.category.ProductCategoryMember',
  'org.apache.ofbiz.product.price.ProductPrice',
  'org.apache.ofbiz.product.product.ProductAssoc',
]
const INVENTORY_ENTITIES = [
  'org.apache.ofbiz.product.facility.Facility',
  'org.apache.ofbiz.product.facility.ProductFacility',
  'org.apache.ofbiz.product.inventory.InventoryItem',
  'org.apache.ofbiz.product.inventory.InventoryItemDetail',
]

function profile(id, label, description, entities) {
  return Object.freeze({ id, label, description, entities: Object.freeze([...entities]) })
}

export const remoteEntityProfiles = Object.freeze({
  products: profile('products', 'Products', 'Product records only; the smallest proven import.', [PRODUCT]),
  catalog: profile('catalog', 'Catalog', 'Products, identifiers, categories, membership, prices, and associations.', CATALOG_ENTITIES),
  inventory: profile('inventory', 'Inventory', 'Facilities, product-facility settings, inventory items, and inventory history.', INVENTORY_ENTITIES),
  'catalog-inventory': profile('catalog-inventory', 'Catalog + inventory', 'The recommended non-secret commerce dataset.', [...CATALOG_ENTITIES, ...INVENTORY_ENTITIES]),
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

export function getRemoteEntityProfile(id) {
  const selected = remoteEntityProfiles[String(id || '')]
  if (!selected) throw new Error(`Unknown safe entity profile: ${id || '(empty)'}.`)
  return selected
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
    '-jar',
    join(home, 'moqui.war'),
    'load',
    `location=${location}`,
    'timeout=1800',
    'raw',
  ]
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
