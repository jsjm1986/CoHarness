/** Publication probes from the same service instances that handle live project requests. */
import type {PostgresConversationStore} from './postgres/conversation-repository.ts'
import type {PostgresCollaborationService} from './postgres/collaboration-service.ts'
import type {PostgresProgressService} from './postgres/progress-service.ts'
import type {GatewayExecutionIdentity} from './execution-identity.ts'
import type {PostgresPluginState} from './plugin-state.ts'
import type {NodeProjectFiles} from './node-content-files.ts'
import type {NodeContentDomainChecks} from './node-content-publication.ts'

/** @param owners - actual installed Gateway services. @returns the six verified core domains for the central publication gate. */
export function nodeCorePublicationChecks(owners:{
  conversations:PostgresConversationStore
  collaboration:PostgresCollaborationService
  execution:GatewayExecutionIdentity
  progress:PostgresProgressService
  plugins:PostgresPluginState
  files:NodeProjectFiles
}):NodeContentDomainChecks{
  return {
    sessions:input=>owners.conversations.verifyNodeContent(input),
    collaboration:input=>owners.collaboration.verifyNodeContent(input),
    execution:input=>owners.execution.verifyNodeContent(input),
    progress:input=>owners.progress.verifyNodeContent(input),
    plugins:input=>owners.plugins.verifyNodeContent(input),
    memory:input=>owners.files.publication(input,'memory'),
  }
}
