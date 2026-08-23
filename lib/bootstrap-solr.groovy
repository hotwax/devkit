import org.moqui.Moqui
import org.moqui.context.ArtifactExecutionInfo

def ec = Moqui.getExecutionContext()
int exitCode = 0
try {
    ec.artifactExecution.disableAuthz()
    ec.artifactExecution.push('devkitSolrBootstrap', ArtifactExecutionInfo.AT_OTHER,
            ArtifactExecutionInfo.AUTHZA_ALL, false)
    ec.artifactExecution.setAnonymousAuthorizedAll()
    ec.user.loginAnonymousIfNoUser()

    String schemaCollection = System.getenv('DEVKIT_SOLR_SCHEMA_COLLECTION')?.trim()
    List uploaded = []
    List created = []
    List skipped = []
    if (!schemaCollection) {
        Map uploadResult = ec.service.sync()
                .name('co.hotwax.solr.SolrServices.upload#AllSolrConfigsets')
                .parameters([solrVersion: '8.11.2', overwrite: true])
                .call()
        List uploadErrors = (List) (uploadResult.errors ?: [])
        if (ec.message.hasError() || uploadErrors) {
            throw new IllegalStateException("Solr configset upload failed: ${uploadErrors ?: ec.message.errorsString}")
        }
        uploaded = (List) (uploadResult.uploaded ?: [])
        if (!uploaded) throw new IllegalStateException('No Solr configsets were discovered or uploaded.')

        ec.message.clearAll()
        Map collectionResult = ec.service.sync()
                .name('co.hotwax.solr.SolrServices.create#AllSolrCollections')
                .parameters([solrVersion: '8.11.2', numShards: '1', replicationFactor: '1', overwrite: false])
                .call()
        List collectionErrors = (List) (collectionResult.errors ?: [])
        if (ec.message.hasError() || collectionErrors) {
            throw new IllegalStateException("Solr collection creation failed: ${collectionErrors ?: ec.message.errorsString}")
        }
        created = (List) (collectionResult.created ?: [])
        skipped = (List) (collectionResult.skipped ?: [])
        if (!created && !skipped) throw new IllegalStateException('No Solr collections were discovered or created.')
    }

    ec.message.clearAll()
    Set<String> schemaCollections = new LinkedHashSet<>()
    ec.factory.getComponentBaseLocations().each { String componentName, String componentBase ->
        File baseDir = componentBase.startsWith('file:') ? new File(new URI(componentBase)) : new File(componentBase)
        File schemaFile = new File(baseDir, 'solr/8.11.2/schema.json')
        if (!schemaFile.exists()) return
        Map schema = (Map) new groovy.json.JsonSlurper().parse(schemaFile)
        ((List<Map>) (schema.collections ?: [])).each { Map collection ->
            String name = collection.name?.toString()
            if (name) schemaCollections.add(name)
        }
    }
    if (!schemaCollections) throw new IllegalStateException('No declared Solr collection schemas were discovered.')
    if (schemaCollection) {
        if (!schemaCollections.contains(schemaCollection)) {
            throw new IllegalStateException("No declared Solr schema was found for ${schemaCollection}.")
        }
        schemaCollections = new LinkedHashSet<String>([schemaCollection])
    }

    int fieldsAdded = 0
    for (String collection in schemaCollections) {
        ec.message.clearAll()
        Map schemaResult = ec.service.sync()
                .name('co.hotwax.solr.SolrSchemaServices.add#MissingFields')
                .parameters([collection: collection, scanComponents: true, solrVersion: '8.11.2'])
                .call()
        List schemaErrors = (List) (schemaResult.errors ?: [])
        if (ec.message.hasError() || schemaErrors) {
            throw new IllegalStateException("Solr schema reconciliation failed for ${collection}: ${schemaErrors ?: ec.message.errorsString}")
        }
        fieldsAdded += ((List) (schemaResult.added ?: [])).size()
    }

    println "Solr bootstrap complete: mode=${schemaCollection ? 'schema-only' : 'full'}, uploaded=${uploaded.size()}, created=${created.size()}, skipped=${skipped.size()}, schemas=${schemaCollections.size()}, fieldsAdded=${fieldsAdded}"
} catch (Throwable t) {
    t.printStackTrace(System.err)
    exitCode = 1
} finally {
    Moqui.destroyActiveExecutionContextFactory()
}
// MCache currently leaves its eviction thread non-daemon after framework shutdown. This runner is
// a bounded build step, so terminate explicitly after all Moqui cleanup has completed.
System.exit(exitCode)
