/** Administrator-owned steward-space qualifications for accounts. */
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'
import { ResourceAccess, ResourceAccessError, resourcePolicyOwner } from './resource-access.ts'
export { ResourceAccessError as StewardAccessError } from './resource-access.ts'
export type { ResourcePolicyOwner as StewardPolicyOwner, ResourceAccessPolicy as StewardAccessPolicy } from './resource-access.ts'

/**
 * Validate steward policy coordinates. Steward admission is user-scoped only:
 * the reserved project's membership list stays empty, so a project-scoped row
 * can never describe who may enter.
 * @param kind - owner coordinate; only `user` is accepted.
 * @param id - public user identifier in the active organization.
 * @param lane - resource lane name; must be `steward`.
 * @returns validated policy coordinates.
 */
export function stewardPolicyOwner(kind: unknown, id: unknown, lane?: unknown) {
  if (lane !== undefined && lane !== 'steward') throw new ResourceAccessError(400, 'invalid steward resource lane')
  const owner = resourcePolicyOwner(kind, id, 'steward')
  if (owner.kind !== 'user') throw new ResourceAccessError(400, 'steward policies are user-scoped')
  return owner
}

/** Versioned steward-space decisions; an absent policy denies entry. */
export class StewardAccess extends ResourceAccess {
  constructor(context: PostgresRuntimeContext) { super(context, 'steward') }
}
