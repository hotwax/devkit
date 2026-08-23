import test from 'node:test'
import assert from 'node:assert/strict'

import { configureMysqlDatasource } from '../lib/bootstrap-config.mjs'

const MYSQL = {
  conf: 'mysql8',
  host: '127.0.0.1',
  port: 3306,
  database: 'moqui',
  user: 'moqui',
  password: 'moqui',
}

function activeDefaultProperties(xml) {
  const withoutComments = xml.replace(/<!--[\s\S]*?-->/g, '')
  const properties = {}
  for (const match of withoutComments.matchAll(/<default-property\s+name="([^"]+)"\s+value="([^"]*)"\s*\/>/g)) {
    properties[match[1]] = match[2]
  }
  return properties
}

test('activates MySQL properties when the runtime template only contains commented examples', () => {
  const template = `<?xml version="1.0"?>
<moqui-conf>
  <!-- minimal overrides for testing on local mysql8:
  <default-property name="entity_ds_db_conf" value="mysql8"/>
  <default-property name="entity_ds_user" value="moqui"/>
  <default-property name="entity_ds_password" value="moqui"/>
  -->
  <default-property name="instance_purpose" value="dev"/>
</moqui-conf>
`

  const configured = configureMysqlDatasource(template, MYSQL)
  const active = activeDefaultProperties(configured)

  assert.deepEqual(
    Object.fromEntries(Object.entries(active).filter(([name]) => name.startsWith('entity_ds_'))),
    {
      entity_ds_db_conf: 'mysql8',
      entity_ds_host: '127.0.0.1',
      entity_ds_port: '3306',
      entity_ds_database: 'moqui',
      entity_ds_user: 'moqui',
      entity_ds_password: 'moqui',
    },
  )
})

test('replaces existing active datasource properties without creating duplicates', () => {
  const template = `<moqui-conf>
  <default-property name="entity_ds_db_conf" value="h2"/>
  <default-property name="entity_ds_database" value="old"/>
</moqui-conf>`

  const configured = configureMysqlDatasource(template, MYSQL)
  const activeXml = configured.replace(/<!--[\s\S]*?-->/g, '')
  const active = activeDefaultProperties(configured)

  assert.equal(active.entity_ds_db_conf, 'mysql8')
  assert.equal(active.entity_ds_database, 'moqui')
  assert.equal((activeXml.match(/name="entity_ds_db_conf"/g) || []).length, 1)
  assert.equal((activeXml.match(/name="entity_ds_database"/g) || []).length, 1)
})
