import test from 'node:test'
import assert from 'node:assert/strict'

import { mergePwaDependencies } from '../pwa-dependency-bridge.mjs'

test('mergePwaDependencies copies missing app dependencies into the root package', () => {
  const result = mergePwaDependencies(
    { dependencies: { vue: 'catalog:' }, devDependencies: { vite: 'catalog:' } },
    [
      { dependencies: { dexie: '^4.4.3', vue: '^3.0.0' }, devDependencies: { '@originjs/vite-plugin-federation': '^1.4.1' } },
      { dependencies: { '@hotwax/app-version-info': '1.0.0' }, devDependencies: { vite: '^5.0.0' } },
    ],
  )

  assert.equal(result.changed, true)
  assert.equal(result.packageJson.dependencies.vue, 'catalog:')
  assert.equal(result.packageJson.dependencies.dexie, '^4.4.3')
  assert.equal(result.packageJson.dependencies['@hotwax/app-version-info'], '1.0.0')
  assert.equal(result.packageJson.devDependencies.vite, 'catalog:')
  assert.equal(result.packageJson.devDependencies['@originjs/vite-plugin-federation'], '^1.4.1')
})

test('mergePwaDependencies reports unchanged when root already contains app dependencies', () => {
  const result = mergePwaDependencies(
    { dependencies: { dexie: '^4.4.3' } },
    [{ dependencies: { dexie: '^4.4.3' } }],
  )

  assert.equal(result.changed, false)
})
