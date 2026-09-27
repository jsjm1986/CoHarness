/** Isolated filesystem tests own all their writes without a running deployment database. */
import type { NodeConfigurationMutationAuthority } from '../src/node-config-store.ts'

export const isolatedNodeConfigurationAuthority: NodeConfigurationMutationAuthority = {
  run: operation => operation(new AbortController().signal),
  writeEpoch: async () => '1',
}
