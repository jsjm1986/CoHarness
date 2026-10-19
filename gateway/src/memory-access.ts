/** Administrator-owned shared project memory write qualifications for accounts and projects. */
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'
import { ResourceAccess, resourcePolicyOwner } from './resource-access.ts'
export { ResourceAccessError as MemoryAccessError } from './resource-access.ts'
export type { ResourcePolicyOwner as MemoryPolicyOwner, ResourceAccessPolicy as MemoryAccessPolicy } from './resource-access.ts'

/**
 * Validate account or project coordinates from the administration API.
 * @param kind - user or project owner.
 * @param id - public identifier in the active organization.
 * @returns validated policy coordinates.
 */
export function memoryPolicyOwner(kind: unknown, id: unknown) { return resourcePolicyOwner(kind, id, 'memory') }

/** Versioned shared-memory write decisions; an absent policy denies access. */
export class MemoryAccess extends ResourceAccess {
  constructor(context: PostgresRuntimeContext) { super(context, 'memory') }
}
