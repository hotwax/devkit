import { createHmac } from 'node:crypto'

import { normalizeHotwaxSource } from './remote-entity-import.mjs'

export const POSTAL_CODE_FIELDS = Object.freeze([
  'country-code-id', 'city', 'country', 'countryCodeAlpha2', 'countryCodeAlpha3',
  'latitude', 'location', 'longitude', 'postcode', 'province', 'state',
])
const POSTAL_CODE_UPDATE_CHAIN_FIELDS = new Set(['country-code-id', 'location'])

function escapeSolrQuoted(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

export function postalCodeEndpoint(source) {
  return `${normalizeHotwaxSource(source)}/rest/s1/api/geocode`
}

export function postalCodeSchemaEnvironment() {
  return { DEVKIT_SOLR_SCHEMA_COLLECTION: 'postalCode' }
}

export function buildPostalCodePageBody({ rows = 5000, after = null } = {}) {
  const pageSize = Number(rows)
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 20000) {
    throw new Error('Postal-code page size must be an integer between 1 and 20000.')
  }
  const json = {
    query: '*:*',
    fields: [...POSTAL_CODE_FIELDS],
    params: { rows: pageSize, sort: 'country-code-id asc' },
  }
  if (after) json.filter = [`country-code-id:{"${escapeSolrQuoted(after)}" TO *]`]
  return { json }
}

export function sanitizePostalCodeDocuments(documents) {
  if (!Array.isArray(documents)) throw new Error('Postal-code response docs must be an array.')
  return documents.map((document, index) => {
    const id = document && document['country-code-id']
    if (typeof id !== 'string' || !id) throw new Error(`Postal-code document ${index + 1} is missing country-code-id.`)
    const clean = {}
    for (const field of POSTAL_CODE_FIELDS) {
      if (POSTAL_CODE_UPDATE_CHAIN_FIELDS.has(field)) continue
      const value = document[field]
      if (value !== undefined && value !== null) clean[field] = value
    }
    return clean
  })
}

export async function transferPostalCodePages({ rows = 5000, fetchPage, writeBatch, onProgress = () => {} }) {
  if (typeof fetchPage !== 'function') throw new Error('fetchPage is required.')
  if (typeof writeBatch !== 'function') throw new Error('writeBatch is required.')

  let sourceCount = null
  let copied = 0
  let batches = 0
  let lastId = null

  while (sourceCount === null || copied < sourceCount) {
    const page = await fetchPage({ after: lastId, rows })
    if (!page || !Array.isArray(page.docs) || !Number.isFinite(Number(page.numFound))) {
      throw new Error('Postal-code source returned an invalid Solr response.')
    }
    if (sourceCount === null) sourceCount = Number(page.numFound)
    const sourceIds = page.docs.map((document) => document && document['country-code-id'])
    const documents = sanitizePostalCodeDocuments(page.docs)
    if (!documents.length) {
      if (copied === sourceCount) break
      throw new Error(`Postal-code source ended after ${copied} of ${sourceCount} documents.`)
    }

    let previous = lastId
    for (const id of sourceIds) {
      if (previous !== null && id <= previous) {
        throw new Error(`Postal-code page did not advance after ${previous}.`)
      }
      previous = id
    }

    await writeBatch(documents)
    copied += documents.length
    batches++
    lastId = previous
    if (copied > sourceCount) throw new Error(`Postal-code source exceeded its reported count of ${sourceCount}.`)
    const state = { sourceCount, copied, batches, lastId }
    await onProgress(state)
    if (documents.length < rows && copied !== sourceCount) {
      throw new Error(`Postal-code source ended after ${copied} of ${sourceCount} documents.`)
    }
  }

  return { sourceCount: sourceCount ?? 0, copied, batches, lastId }
}

export function createSolrJwt(key, nowSeconds = Math.floor(Date.now() / 1000), ttlSeconds = 300) {
  if (!String(key || '').trim()) throw new Error('A local Solr JWT key is required.')
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const header = encode({ alg: 'HS512', typ: 'JWT' })
  const payload = encode({ iat: nowSeconds, exp: nowSeconds + ttlSeconds, sub: 'solr', iss: 'moqui' })
  const unsigned = `${header}.${payload}`
  return `${unsigned}.${createHmac('sha512', String(key).trim()).update(unsigned).digest('base64url')}`
}
