/** Database references that prevent removal of a computer from the organization registry. */
import { escapeIdentifier } from 'pg'
import type { NodeRemovalBlocker } from '../node-access.ts'
import type { RuntimeNodeId } from '../runtime-catalog.ts'
import type { Queryable } from './database.ts'

const projects = new Set(['projects', 'project_mounts', 'project_content_placement', 'project_content_copy_jobs',
  'project_name_claims', 'project_name_handoffs', 'project_journal_requests', 'node_journal_deliveries'])
const runtimes = new Set(['instances', 'runtime_environments', 'runtime_allocation_receipts', 'runtime_owner_generations',
  'model_runtime_intake_tokens', 'node_resource_state'])
const backups = /^(?:peer_|governance_rebuild_|(?:personal|project)_recovery_|recovery_source_|project_source_retirement_)/u

interface Reference {
  schema_name: string
  table_name: string
  node_column: string | null
  organization_column: string | null
}

function category(table: string): NodeRemovalBlocker {
  if (projects.has(table)) return 'node-access/removal-projects'
  if (runtimes.has(table)) return 'node-access/removal-runtimes'
  if (backups.test(table)) return 'node-access/removal-backups'
  return 'node-access/removal-other-bindings'
}

// These ledgers carry a node UUID without a foreign key to a node or its volume.
const ledgerReferences = [
  ['document_scope_writers', 'node_id'],
  ['node_journal_deliveries', 'node_id'],
  ['personal_recovery_document_receipts', 'source_node_id'],
  ['personal_recovery_document_receipts', 'target_node_id'],
  ['project_name_handoffs', 'node_id'],
  ['project_source_retirement_reviews', 'node_id'],
  ['runtime_environments', 'node_id'],
] as const

/**
 * Find durable bindings without cascading through domain records.
 * @param tx - current organization transaction.
 * @param organizationId - owner of the registry entry.
 * @param nodeId - computer whose references are being inspected.
 * @param nodeName - existing name used by operator jobs and desktop resources.
 * @param lockLedgers - acquire write-conflicting locks on ledgers without a node foreign key before final verification.
 * @returns stable blocker codes for the domains that retain the node.
 */
export async function nodeRemovalBindings(
  tx: Queryable, organizationId: string, nodeId: RuntimeNodeId, nodeName: string, lockLedgers: boolean,
): Promise<NodeRemovalBlocker[]> {
  if (lockLedgers) {
    const names = new Set([...ledgerReferences.map(([table]) => table), 'deployment_operations', 'desktop_resources'])
    const tables = [...names].sort().map(table => `harness.${escapeIdentifier(table)}`)
    await tx.query(`LOCK TABLE ${tables.join(', ')} IN SHARE MODE NOWAIT`)
  }
  const { rows } = await tx.query<Reference>(`SELECT ns.nspname AS schema_name, child.relname AS table_name,
    max(field.attname::text) FILTER (WHERE target.attname IN ('id','node_id')) AS node_column,
    max(field.attname::text) FILTER (WHERE target.attname='organization_id') AS organization_column
    FROM pg_catalog.pg_constraint fk
    JOIN pg_catalog.pg_class child ON child.oid=fk.conrelid
    JOIN pg_catalog.pg_namespace ns ON ns.oid=child.relnamespace
    CROSS JOIN LATERAL unnest(fk.conkey,fk.confkey) AS keys(child_attnum,target_attnum)
    JOIN pg_catalog.pg_attribute field ON field.attrelid=fk.conrelid AND field.attnum=keys.child_attnum
    JOIN pg_catalog.pg_attribute target ON target.attrelid=fk.confrelid AND target.attnum=keys.target_attnum
    WHERE fk.contype='f' AND fk.confrelid IN ('harness.compute_nodes'::regclass,'harness.node_agents'::regclass)
      AND fk.conrelid NOT IN ('harness.node_agents'::regclass,'harness.node_agent_enrollments'::regclass)
    GROUP BY fk.oid,ns.nspname,child.relname ORDER BY ns.nspname,child.relname,fk.oid`)
  const references = [...rows, ...ledgerReferences.map(([table, nodeColumn]) => ({
    schema_name: 'harness', table_name: table, node_column: nodeColumn, organization_column: 'organization_id',
  }))]
  const clauses = new Map<NodeRemovalBlocker, string[]>([
    ['node-access/removal-in-use', [`EXISTS (SELECT FROM harness.deployment_operations WHERE organization_id=$1::uuid
      AND status IN ('pending','running') AND lower(node_name)=lower($3))`]],
    ['node-access/removal-other-bindings', [`EXISTS (SELECT FROM harness.desktop_resources
      WHERE starts_with(resource_key,$1::uuid::text||'/') AND (node=$2::uuid::text OR lower(node)=lower($3)))`]],
  ])
  for (const reference of references) {
    const { schema_name: schema, table_name: table, node_column: nodeColumn, organization_column: organizationColumn } = reference
    if (nodeColumn === null) throw new Error('A compute node reference has no node identity column')
    const relation = `${escapeIdentifier(schema)}.${escapeIdentifier(table)}`
    const organization = organizationColumn === null ? '' : ` AND ${escapeIdentifier(organizationColumn)}=$1::uuid`
    const exists = `EXISTS (SELECT FROM ${relation} WHERE ${escapeIdentifier(nodeColumn)}=$2::uuid${organization})`
    const code = category(table)
    const group = clauses.get(code)
    if (group === undefined) clauses.set(code, [exists])
    else group.push(exists)
  }
  const values: string[] = [organizationId, nodeId, nodeName]
  const checks = Array.from(clauses, ([code, group]) => {
    values.push(code)
    return `SELECT $${values.length}::text AS blocker WHERE ${group.join(' OR ')}`
  })
  return (await tx.query<{ blocker: NodeRemovalBlocker }>(checks.join(' UNION ALL '), values)).rows.map(row => row.blocker)
}
