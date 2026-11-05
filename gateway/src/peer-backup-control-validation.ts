/** Validate a restored governance inventory entirely offline. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import { PeerBackupError } from './peer-backup-repository.ts'
import type { PeerBackupBinding, PeerCapture } from './peer-backup-restic.ts'

export const projections = {
  organizations: 'id AS organization_id,slug,display_name,status,default_time_zone',
  users: 'organization_id,id,public_id,username,display_name,status,deleted_at',
  memberships: 'organization_id,user_id,role,status',
  compute_nodes: 'organization_id,id,name,status',
  projects: 'organization_id,id,public_id,status,version,created_by,logical_name_id,logical_name_revision',
  project_members: 'organization_id,project_id,user_id,access_mode',
  runtime_environments: 'organization_id,id,owner_kind,owner_id,node_id,retired_at',
  deployment_topology: 'organization_id,enabled,primary_node_id,revision',
  model_catalog: 'organization_id,id,provider_key,model_key,display_name,enabled',
  model_role_access: 'organization_id,role,model_id,allowed',
  model_user_access: 'organization_id,user_id,model_id,allowed',
  project_content_placement: 'organization_id,project_id,node_id,runtime_id,volume_id,writer_epoch',
  personal_directory_placement: 'organization_id,runtime_id,node_id,owner_id',
  project_recovery_operations:
    'organization_id,id,project_id,runtime_id,policy_id,point_id,source_node_id,source_volume_id,source_epoch,target_node_id,target_volume_id,target_epoch,manifest_digest,phase,target_verified_at,old_fenced_at,published_at',
  project_recovery_policy_approvals:
    'organization_id,sequence,operation_id,policy_revision,approved_by,approved_at',
  project_recovery_cleanups:
    'organization_id,operation_id,node_id,volume_id,completed_at',
  project_source_retirement_reviews:
    'organization_id,id,project_id,runtime_id,node_id,volume_id,writer_epoch,job_id,source_revision,node_snapshot_id,policy_digest,owner_coverage_digest,backup_inventory_digest,opened_at',
  project_source_retirement_evidence:
    'organization_id,review_id,domain,inventory_digest,proof_digest,signer_fingerprint,verified_at,observed_resources,recorded_at,recorded_by',
  peer_backup_policies:
    'organization_id,id,scope_kind,scope_id,source_node_id,target_node_id,revision,tier,quota_bytes,enabled',
} as const
export const names = Object.keys(projections) as (keyof typeof projections)[]
const legacyProjections:Record<string,string>=Object.fromEntries(names.filter(name=>name!=='project_recovery_policy_approvals'&&name!=='project_recovery_cleanups')
  .map(name=>[name,name==='projects'?projections.projects.replace('public_id,','public_id,name,'):projections[name]]))
/** Built-in governance inventories omit live secrets and several administrative and plugin domains. */
export const controlCoverageGaps = ['database:remaining-governance-and-audit','files:deployment-state-and-offline-keys','plugin:delegated-policy-stores']
const inventory = z
  .object({
    version: z.union([z.literal(1),z.literal(2)]),
    rows: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    topologyRevision: z.string(),
    watermark: z.string(),
  })
  .strict()
export interface Limits {
  maxBytes: number
  maxRows: number
}

/** Validate a governance inventory in isolation. It grants no login, writer, or node authority. */
export async function validatePeerControl(
  binding: PeerBackupBinding,
  capture: PeerCapture,
  directory: string,
  signal: AbortSignal,
  limits: Limits,
) {
  const manifest = join(directory, 'governance.json')
  if ((await lstat(manifest)).size > 4096) throw new PeerBackupError(409, 'peer-backup/invalid-export')
  const saved = inventory.parse(JSON.parse(await readFile(manifest, 'utf8')))
  const fields:Readonly<Record<string,string>>=saved.version===1?legacyProjections:projections
  if(capture.gaps.length!==controlCoverageGaps.length || !controlCoverageGaps.every(gap=>capture.gaps.includes(gap)) ||
    capture.coveredCount!==Object.keys(fields).length)throw new PeerBackupError(409,'peer-backup/coverage-incomplete')
  if (
    binding.organizationId !== binding.scopeId ||
    saved.topologyRevision !== capture.writerEpoch ||
    saved.watermark !== capture.watermark
  ) {
    throw new PeerBackupError(409, 'peer-backup/invalid-export')
  }
  const file = join(directory, 'governance.jsonl')
  if ((await lstat(file)).size > limits.maxBytes) throw new PeerBackupError(507, 'peer-backup/export-budget')
  const hash = createHash('sha256')
  const stream = createReadStream(file, { signal })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  let count = 0,
    organizations = 0,
    topologies = 0
  try {
    for await (const line of lines) {
      if (++count > limits.maxRows) throw new PeerBackupError(507, 'peer-backup/export-budget')
      const { table, row } = JSON.parse(line) as { table: keyof typeof projections; row: Record<string, unknown> }
      if (!Object.hasOwn(fields, table) || row.organization_id !== binding.organizationId)
        throw new PeerBackupError(409, 'peer-backup/cross-scope-row')
      const expected = fields[table]!.split(',').map((column) => column.replace('id AS ', ''))
      if (Object.keys(row).length !== expected.length || !expected.every((column) => Object.hasOwn(row, column))) {
        throw new PeerBackupError(409, 'peer-backup/invalid-export')
      }
      if (table === 'organizations') organizations++
      if (table === 'deployment_topology') {
        topologies++
        if (
          row.primary_node_id !== binding.sourceNodeId ||
          String(row.revision) !== saved.topologyRevision ||
          row.enabled !== true
        ) {
          throw new PeerBackupError(409, 'peer-backup/space-placement-changed')
        }
      }
      hash.update(line + '\n')
    }
  } finally {
    lines.close()
    stream.destroy()
  }
  if (organizations !== 1 || topologies !== 1 || count !== saved.rows || hash.digest('hex') !== saved.sha256) {
    throw new PeerBackupError(409, 'peer-backup/invalid-export')
  }
}
