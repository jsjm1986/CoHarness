/** Administrator-owned desktop qualifications for accounts and projects. */
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'
import { ResourceAccess, resourcePolicyOwner } from './resource-access.ts'
export { ResourceAccessError as DesktopAccessError } from './resource-access.ts'
export type { ResourcePolicyOwner as DesktopPolicyOwner, ResourceAccessPolicy as DesktopAccessPolicy } from './resource-access.ts'

/**
 * Validate account or project coordinates from the administration API.
 * @param kind - user or project owner.
 * @param id - public identifier in the active organization.
 * @returns validated policy coordinates.
 */
export function desktopPolicyOwner(kind: unknown, id: unknown) { return resourcePolicyOwner(kind, id, 'desktop') }

/** Versioned desktop decisions; an absent policy denies access. */
export class DesktopAccess extends ResourceAccess {
  constructor(context: PostgresRuntimeContext) { super(context, 'desktop') }
}
