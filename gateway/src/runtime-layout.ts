/** Node-local storage and supervisor names for personal Runtime assignments. */
import { join } from 'node:path'
import type { GatewayConfig } from './config.ts'
import type { RuntimeId } from './runtime-catalog.ts'

/** Existing assignments retain their directory; additional assignments own a UUID directory. */
export type PersonalRuntimeStorageLayout = 'legacy' | 'isolated'

/** Persisted storage selection; standalone account-owned Runtimes use the legacy layout. */
export interface PersonalRuntimeStorage {
  runtimeId?: RuntimeId
  storageLayout?: PersonalRuntimeStorageLayout
  /** Preparing assignments reserve quota but cannot receive file projections or start. */
  provisioning?: 'preparing' | 'ready'
}

/**
 * Resolve the process name and private data directory before touching local storage.
 * @param cfg - paths owned by this node's deployment.
 * @param owner - current account name and persisted Runtime storage selection.
 * @returns stable supervisor name and absolute DSH_HOME for this assignment.
 */
export function personalRuntimeLayout(
  cfg: Pick<GatewayConfig, 'usersRoot'>,
  owner: PersonalRuntimeStorage & { username: string },
): { runtimeKey: string; dshHome: string } {
  if (owner.storageLayout === 'isolated') {
    if (owner.runtimeId === undefined) throw new Error('An isolated personal Runtime requires its persisted identity')
    // The underscore separates generated keys from valid account names; base36 retains every UUID bit.
    const runtimeKey = `rt_${BigInt(`0x${owner.runtimeId.replaceAll('-', '')}`).toString(36)}`
    return { runtimeKey, dshHome: join(cfg.usersRoot, owner.username, 'runtimes', owner.runtimeId, 'dsh') }
  }
  return { runtimeKey: owner.username, dshHome: join(cfg.usersRoot, owner.username, 'dsh') }
}
