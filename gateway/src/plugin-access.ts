/** Administrator-owned plugin-management qualifications for accounts and projects. */
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'
import { ResourceAccess, resourcePolicyOwner } from './resource-access.ts'
export { ResourceAccessError as PluginAccessError } from './resource-access.ts'
export type { ResourcePolicyOwner as PluginPolicyOwner, ResourceAccessPolicy as PluginAccessPolicy } from './resource-access.ts'

/**
 * Validate account or project coordinates from the administration API.
 * @param kind - user or project owner.
 * @param id - public identifier in the active organization.
 * @returns validated policy coordinates.
 */
export function pluginPolicyOwner(kind: unknown, id: unknown) { return resourcePolicyOwner(kind, id, 'plugin') }

/** Versioned plugin-management decisions; an absent policy denies access. */
export class PluginAccess extends ResourceAccess {
  constructor(context: PostgresRuntimeContext) { super(context, 'plugin') }
}
