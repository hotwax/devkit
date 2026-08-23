function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function escapeXmlAttribute(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
}

function replaceActiveDefaultProperty(xml, name, value) {
  const propertyPattern = new RegExp(
    `(<default-property\\s+name="${escapeRegex(name)}"\\s+value=")[^"]*("\\s*/>)`,
    'g',
  )
  let replaced = false
  const segments = String(xml).split(/(<!--[\s\S]*?-->)/g)
  const configured = segments.map((segment) => {
    if (segment.startsWith('<!--')) return segment
    return segment.replace(propertyPattern, (...args) => {
      replaced = true
      return `${args[1]}${escapeXmlAttribute(value)}${args[2]}`
    })
  }).join('')

  if (replaced) return configured
  if (!configured.includes('</moqui-conf>')) throw new Error('Moqui configuration is missing </moqui-conf>')
  return configured.replace(
    '</moqui-conf>',
    `    <default-property name="${name}" value="${escapeXmlAttribute(value)}"/>\n</moqui-conf>`,
  )
}

export function configureMysqlDatasource(xml, db) {
  const properties = {
    entity_ds_db_conf: db.conf,
    entity_ds_host: db.host,
    entity_ds_port: String(db.port),
    entity_ds_database: db.database,
    entity_ds_user: db.user,
    entity_ds_password: db.password,
  }
  let configured = String(xml)
  for (const [name, value] of Object.entries(properties)) {
    configured = replaceActiveDefaultProperty(configured, name, value)
  }
  return configured
}

export function readActiveDatasourceDefaults(xml) {
  const withoutComments = String(xml).replace(/<!--[\s\S]*?-->/g, '')
  const properties = {
    dbConf: 'entity_ds_db_conf',
    host: 'entity_ds_host',
    port: 'entity_ds_port',
    database: 'entity_ds_database',
    user: 'entity_ds_user',
  }
  const datasource = {}
  for (const [key, name] of Object.entries(properties)) {
    const pattern = new RegExp(`<default-property\\s+name="${escapeRegex(name)}"\\s+value="([^"]*)"`, 'g')
    const values = [...withoutComments.matchAll(pattern)].map((match) => match[1]).filter(Boolean)
    const unique = [...new Set(values)]
    if (unique.length !== 1) return null
    datasource[key] = unique[0]
  }
  return datasource
}
