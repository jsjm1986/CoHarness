/** Read sealed node-local locations without provisioning data or requiring a running Gateway. */
import type { RuntimeTarget } from './instances.ts'
import type { RuntimeId } from './runtime-catalog.ts'
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'
import type { GovernanceRebuildLocalData } from './governance-rebuild-local-data.ts'
import { PeerBackupError } from './peer-backup-repository.ts'

function deny(code: string): never { throw new PeerBackupError(409, 'peer-backup/governance-' + code) }

/** Shared account data may be retained while a newly allocated Runtime keeps its ordinary independent storage. */
export interface GovernanceLocalPaths {
  homePath: string
  /** Present only for the exact retained Runtime; omission preserves the new Runtime's configured layout. */
  dshHome?: string
}

/** Resolve a current governance recovery's exact assignment and immutable local data proof.
 * @param context - the original node's organization and database identity.
 * @param data - node-owned verifier; never a remote path provider.
 * @param target - exact Runtime or an unambiguous local user/project assignment.
 * @returns verified account/workspace home and an optional retained Runtime home. Ordinary accounts and newer scope-owned recoveries return undefined; required absent evidence rejects.
 */
export async function resolveGovernanceLocalPaths(context: Pick<PostgresRuntimeContext, 'pool' | 'organizationId' | 'nodeId'>,
  data: Pick<GovernanceRebuildLocalData, 'paths' | 'accountHomes'>, target: RuntimeTarget): Promise<GovernanceLocalPaths | undefined> {
  const rows = (await context.pool.query<{ runtimeId: RuntimeId }>(`SELECT i.runtime_id "runtimeId" FROM harness.instances i
    JOIN harness.${target.kind === 'user' ? 'users' : 'projects'} o ON o.organization_id=i.organization_id AND o.id=i.${target.kind === 'user' ? 'user_id' : 'project_id'}
    WHERE i.organization_id=$1 AND i.assigned_node_id=$2 AND o.public_id=$3 AND ($4::uuid IS NULL OR i.runtime_id=$4) LIMIT 2`,
  [context.organizationId, context.nodeId, target.id, target.runtimeId ?? null])).rows
  if (rows.length !== 1) deny('local-identity-mismatch')
  const runtimeId = rows[0]!.runtimeId
  const route = (await context.pool.query<{ route: string }>('SELECT harness.governance_rebuild_execution_route($1,$2,$3) route',
    [context.organizationId, runtimeId, context.nodeId])).rows[0]!.route
  if (route === 'scope') return undefined
  if (route === 'ordinary') {
    if (target.kind !== 'user') return undefined
    const homePath = (await data.accountHomes([target.id])).get(target.id)
    if (homePath === null) deny('local-binding-required')
    return homePath === undefined ? undefined : { homePath }
  }
  if (route === 'blocked') deny('review-required')
  const current = (await context.pool.query<{ id: string; ownerKind: string; publicId: number; nodeId: string; bindingId: string | null; evidenceDigest: string | null }>(
    `SELECT r.id,r.owner_kind "ownerKind",coalesce(u.public_id,p.public_id)::float8 "publicId",r.node_id "nodeId",
      b.binding_id "bindingId",b.evidence_digest "evidenceDigest"
    FROM harness.governance_rebuild_runtimes r JOIN harness.governance_rebuild_operations o ON o.id=r.operation_id
    LEFT JOIN harness.users u ON r.owner_kind='user' AND u.id=r.owner_id AND u.organization_id=r.organization_id
    LEFT JOIN harness.projects p ON r.owner_kind='project' AND p.id=r.owner_id AND p.organization_id=r.organization_id
    LEFT JOIN harness.governance_rebuild_data_bindings b ON (b.runtime_operation_id,b.organization_id,b.runtime_id,b.node_id,b.source_generation)=
      (r.id,r.organization_id,r.runtime_id,r.node_id,r.source_generation)
    WHERE r.organization_id=$1 AND r.runtime_id=$2
      AND o.recovery_epoch=(SELECT max(recovery_epoch) FROM harness.governance_rebuild_operations WHERE organization_id=$1)`,
    [context.organizationId, runtimeId])).rows[0]
  if (!current) deny('review-changed')
  if (current.ownerKind !== target.kind || current.publicId !== target.id || current.nodeId !== context.nodeId) deny('local-identity-mismatch')
  if (!current.bindingId || !current.evidenceDigest) deny('local-binding-required')
  const paths = await data.paths(current.id, { bindingId: current.bindingId, evidenceDigest: current.evidenceDigest })
  return { homePath: paths.homePath, dshHome: paths.home }
}
