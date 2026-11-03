/** Node-local execution evidence must survive application-data replacement. */
import { join, resolve } from 'node:path'

/**
 * Resolve independent process-control directories kept outside deployment data snapshots.
 * @param stateRoot - this node's private Gateway state root.
 * @returns fixed local-runtime and Gateway-model ownership locations.
 */
export function nodeControlPaths(stateRoot: string): { localRuntime: string; gatewayModels: string } {
  const root = resolve(stateRoot)
  return { localRuntime: join(root, 'local-runtime-supervisors'), gatewayModels: join(root, 'gateway-model-locks') }
}
