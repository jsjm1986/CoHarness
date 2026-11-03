/** Isolated filesystem tests own all their writes without a running deployment database. */
import type { NodeConfigurationMutationAuthority } from '../src/node-config-store.ts'

export const isolatedNodeConfigurationAuthority: NodeConfigurationMutationAuthority = {
  authorize: (_actorUserId, operation) => operation({ query: () => Promise.reject(new Error('The isolated file fixture has no database')) }),
  run: (_actorUserId, operation) => operation(new AbortController().signal, async () => '1', { query: () => Promise.reject(new Error('The isolated file fixture has no database')) }),
}
