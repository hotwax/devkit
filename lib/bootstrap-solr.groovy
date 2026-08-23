import org.moqui.Moqui
import org.moqui.context.ArtifactExecutionInfo

def ec = Moqui.getExecutionContext()
try {
    ec.artifactExecution.disableAuthz()
    ec.artifactExecution.push('devkitSolrBootstrap', ArtifactExecutionInfo.AT_OTHER,
            ArtifactExecutionInfo.AUTHZA_ALL, false)
    ec.artifactExecution.setAnonymousAuthorizedAll()
    ec.user.loginAnonymousIfNoUser()

    Map uploadResult = ec.service.sync()
            .name('co.hotwax.solr.SolrServices.upload#AllSolrConfigsets')
            .parameters([solrVersion: '8.11.2', overwrite: true])
            .call()
    List uploadErrors = (List) (uploadResult.errors ?: [])
    if (ec.message.hasError() || uploadErrors) {
        throw new IllegalStateException("Solr configset upload failed: ${uploadErrors ?: ec.message.errorsString}")
    }
    List uploaded = (List) (uploadResult.uploaded ?: [])
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
    List created = (List) (collectionResult.created ?: [])
    List skipped = (List) (collectionResult.skipped ?: [])
    if (!created && !skipped) throw new IllegalStateException('No Solr collections were discovered or created.')

    println "Solr bootstrap complete: uploaded=${uploaded.size()}, created=${created.size()}, skipped=${skipped.size()}"
} finally {
    Moqui.destroyActiveExecutionContextFactory()
}
