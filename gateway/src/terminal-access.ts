/** Administrator-owned terminal qualifications for accounts and projects. */
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'
import { ResourceAccess, resourcePolicyOwner } from './resource-access.ts'
export { ResourceAccessError as TerminalAccessError } from './resource-access.ts'
export type { ResourcePolicyOwner as TerminalPolicyOwner, ResourceAccessPolicy as TerminalAccessPolicy } from './resource-access.ts'

/**
 * Validate account or project coordinates from the administration API.
 * @param kind - user or project owner.
 * @param id - public identifier in the active organization.
 * @returns validated policy coordinates.
 */
export function terminalPolicyOwner(kind: unknown, id: unknown) { return resourcePolicyOwner(kind, id, 'terminal') }

/** Versioned terminal decisions; an absent policy denies access. */
export class TerminalAccess extends ResourceAccess {
  constructor(context: PostgresRuntimeContext) { super(context, 'terminal') }
}
