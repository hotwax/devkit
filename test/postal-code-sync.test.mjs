import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'

import {
  buildPostalCodePageBody,
  createSolrJwt,
  postalCodeEndpoint,
  postalCodeSchemaEnvironment,
  sanitizePostalCodeDocuments,
  transferPostalCodePages,
} from '../lib/postal-code-sync.mjs'

test('buildPostalCodePageBody requests the first page in stable unique-key order', () => {
  assert.deepEqual(buildPostalCodePageBody({ rows: 5000 }), {
    json: {
      query: '*:*',
      fields: [
        'country-code-id', 'city', 'country', 'countryCodeAlpha2', 'countryCodeAlpha3',
        'latitude', 'location', 'longitude', 'postcode', 'province', 'state',
      ],
      params: { rows: 5000, sort: 'country-code-id asc' },
    },
  })
})

test('buildPostalCodePageBody seeks strictly after the last copied id', () => {
  assert.deepEqual(buildPostalCodePageBody({ rows: 100, after: 'A"B\\C-US' }).json.filter, [
    'country-code-id:{"A\\"B\\\\C-US" TO *]',
  ])
})

test('postalCodeEndpoint accepts only HTTPS HotWax sources', () => {
  assert.equal(postalCodeEndpoint('rails-uat.hotwax.io'), 'https://rails-uat.hotwax.io/rest/s1/api/geocode')
  assert.throws(() => postalCodeEndpoint('http://rails-uat.hotwax.io'), /HTTPS/)
  assert.throws(() => postalCodeEndpoint('https://example.com'), /hotwax\.io/)
})

test('postal schema reconciliation is scoped to the postalCode collection', () => {
  assert.deepEqual(postalCodeSchemaEnvironment(), {
    DEVKIT_SOLR_SCHEMA_COLLECTION: 'postalCode',
  })
})

test('sanitizePostalCodeDocuments removes Solr internals and update-chain-derived fields', () => {
  assert.deepEqual(sanitizePostalCodeDocuments([{
    'country-code-id': '001-0000-JP', postcode: '001-0000', country: 'Japan',
    latitude: '42.8863', longitude: '143.4148', location: '42.8863,143.4148',
    _version_: 123, unexpected: 'drop-me',
  }]), [{
    postcode: '001-0000', country: 'Japan', latitude: '42.8863', longitude: '143.4148',
  }])
  assert.throws(() => sanitizePostalCodeDocuments([{ postcode: '001-0000' }]), /country-code-id/)
})

test('transferPostalCodePages copies every page exactly once with seek pagination', async () => {
  const requested = []
  const written = []
  const progress = []
  const pages = new Map([
    ['', { numFound: 3, docs: [{ 'country-code-id': 'A', postcode: '1' }, { 'country-code-id': 'B', postcode: '2' }] }],
    ['B', { numFound: 1, docs: [{ 'country-code-id': 'C', postcode: '3' }] }],
  ])
  const result = await transferPostalCodePages({
    rows: 2,
    fetchPage: async ({ after, rows }) => { requested.push({ after, rows }); return pages.get(after || '') },
    writeBatch: async (docs) => { written.push(docs) },
    onProgress: (state) => progress.push(state),
  })

  assert.deepEqual(requested, [{ after: null, rows: 2 }, { after: 'B', rows: 2 }])
  assert.deepEqual(written, [
    [{ postcode: '1' }, { postcode: '2' }],
    [{ postcode: '3' }],
  ])
  assert.deepEqual(result, { sourceCount: 3, copied: 3, batches: 2, lastId: 'C' })
  assert.deepEqual(progress.at(-1), { sourceCount: 3, copied: 3, batches: 2, lastId: 'C' })
})

test('transferPostalCodePages rejects a page that cannot advance the seek cursor', async () => {
  await assert.rejects(() => transferPostalCodePages({
    rows: 2,
    fetchPage: async ({ after }) => after
      ? { numFound: 1, docs: [{ 'country-code-id': 'B', postcode: 'duplicate' }] }
      : { numFound: 3, docs: [{ 'country-code-id': 'A' }, { 'country-code-id': 'B' }] },
    writeBatch: async () => {},
  }), /did not advance/)
})

test('createSolrJwt emits a deterministic HS512 token without exposing the key', () => {
  const token = createSolrJwt('private-test-key', 1700000000, 300)
  const [encodedHeader, encodedPayload, signature] = token.split('.')
  assert.deepEqual(JSON.parse(Buffer.from(encodedHeader, 'base64url')), { alg: 'HS512', typ: 'JWT' })
  assert.deepEqual(JSON.parse(Buffer.from(encodedPayload, 'base64url')), {
    iat: 1700000000, exp: 1700000300, sub: 'solr', iss: 'moqui',
  })
  assert.equal(signature, createHmac('sha512', 'private-test-key').update(`${encodedHeader}.${encodedPayload}`).digest('base64url'))
})
