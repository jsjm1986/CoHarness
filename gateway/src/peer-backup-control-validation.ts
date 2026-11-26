/** Validate a restored governance inventory entirely offline. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import { PeerBackupError } from './peer-backup-repository.ts'
import type { PeerBackupBinding, PeerCapture } from './peer-backup-restic.ts'

const v2Projections = {
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
const v3Projections = {...v2Projections,
  project_recovery_operations: v2Projections.project_recovery_operations+',recovery_mode',
  project_recovery_isolations: 'organization_id,operation_id,source_node_id,source_generation,source_epoch,point_id,policy_revision,method,evidence_reference,confirmed_by,confirmed_at,acknowledge_data_loss',
  node_recovery_quarantines: 'organization_id,node_id,operation_id',
  project_recovery_execution_holds: 'organization_id,operation_id,runtime_id,blockers',
} as const
const v4Projections = {...v3Projections,
  project_recovery_execution_requests: 'organization_id,operation_id,request_id,requested_by,requested_at,status,review_id,error_code',
  project_recovery_execution_reviews: 'organization_id,id,operation_id,runtime_id,target_node_id,target_epoch,point_id,policy_digest,composition_digest,old_session_count,items,blockers,created_at',
  project_recovery_execution_approvals: 'organization_id,review_id,approved_by,approved_at,mode',
  project_recovery_execution_item_approvals: 'organization_id,review_id,item_digest,approved_by,evidence_reference,approved_at',
} as const
const v5Projections = {...v4Projections,
  project_recovery_execution_transfers: 'organization_id,operation_id,runtime_id,source_review_id,created_at',
  recovery_source_isolations: 'organization_id,operation_id,scope_kind,scope_id,runtime_id,source_node_id,source_generation,source_epoch,point_id,policy_revision,method,evidence_reference,confirmed_by,confirmed_at,acknowledge_data_loss,project_isolation_id',
} as const
/** Governance-only fields; paths, plugin payloads, credentials and executable queues remain node-owned or excluded. */
const v6Projections = {...v5Projections,
  project_recovery_operations: v5Projections.project_recovery_operations+',suspended_environment_keys',
  computer_use_permissions: 'organization_id,node_id,user_id,enabled,revision,updated_at',
  desktop_access_policies: 'organization_id,node_id,user_id,project_id,enabled,revision',
  memory_access_policies: 'organization_id,node_id,user_id,project_id,enabled,revision',
  plugin_access_policies: 'organization_id,node_id,user_id,project_id,enabled,revision',
  ssh_access_policies: 'organization_id,node_id,user_id,project_id,enabled,revision',
  steward_access_policies: 'organization_id,node_id,user_id,project_id,enabled,revision',
  terminal_access_policies: 'organization_id,node_id,user_id,project_id,enabled,revision',
  runtime_allocation_policies: 'organization_id,id,user_id,max_total,max_per_node,revision,override_enabled',
  runtime_allocation_receipts: 'organization_id,request_id,runtime_id,node_id,user_id,actor_user_id,created_at',
  node_user_accounts: 'organization_id,node_id,user_id,created_at',
  instances: 'organization_id,id,user_id,project_id,assigned_node_id,runtime_id,generation,policy_revision,storage_layout,allocation_state,provisioning_state',
  runtime_owner_generations: 'organization_id,node_id,owner_kind,owner_id,last_generation',
  node_content_volumes: 'organization_id,node_id,volume_id,cluster_id,database_oid',
  document_scope_placement: 'organization_id,node_id,scope_kind,scope_id,root_id,volume_id,writer_epoch,publication_revision,project_runtime_id',
  project_name_keys: 'organization_id,key_id,fingerprint',
  project_name_policies: 'organization_id,revision,state,active_key,next_key,normalization',
  project_name_claims: 'organization_id,project_id,node_id,key_id,mac,name_revision',
  project_invitations: 'organization_id,id,project_id,invitee_user_id,inviter_user_id,access_mode,status,expires_at,created_at,responded_at',
  role_quotas: 'organization_id,role,token_limit,company_cost_limit',
  user_quotas: 'organization_id,user_id,token_mode,token_limit,company_cost_mode,company_cost_limit',
  project_quotas: 'organization_id,project_id,token_limit,company_cost_limit',
  model_project_access: 'organization_id,project_id,model_id,allowed,created_at,updated_at',
  model_prices: 'organization_id,id,model_id,effective_at,currency,input_per_million,output_per_million,cache_read_per_million,cache_write_per_million,created_at',
  audit_events: 'organization_id,id,occurred_at,actor_user_id,action,request_id,outcome,status_code',
  peer_backup_points: 'organization_id,id,policy_id,revision,writer_epoch,watermark,snapshot_id,manifest_digest,covered_count,gap_count,repository_bytes,available_bytes,protected_through,confirmed_at',
  personal_recovery_operations: 'organization_id,id,user_id,runtime_id,policy_id,policy_revision,point_id,approved_by,source_node_id,source_generation,source_epoch,target_node_id,target_epoch,source_document_root,source_volume_id,source_document_epoch,target_volume_id,target_document_epoch,manifest_digest,point_revision,phase,target_files_digest,target_evidence_digest,target_document_digest,document_receipt_operation_id,target_verified_at,target_activated_at,activation_approved_by,activation_approved_at,old_session_count,suspended_environment_keys,created_at,published_at',
  personal_recovery_policy_approvals: 'organization_id,id,operation_id,policy_revision,phase,approved_by,approved_at',
  personal_recovery_document_receipts: 'organization_id,operation_id,user_id,source_node_id,root_id,source_volume_id,source_epoch,target_node_id,target_volume_id,target_epoch,document_digest,created_at',
  personal_recovery_execution_holds: 'organization_id,operation_id,runtime_id',
  personal_recovery_execution_requests: v4Projections.project_recovery_execution_requests,
  personal_recovery_execution_reviews: v4Projections.project_recovery_execution_reviews,
  personal_recovery_execution_approvals: v4Projections.project_recovery_execution_approvals,
  personal_recovery_execution_item_approvals: v4Projections.project_recovery_execution_item_approvals,
} as const
/** Receiver identity is retained independently of the replacement writer; online read credentials are excluded. */
export const projections = {...v6Projections,
  project_recovery_operations:v6Projections.project_recovery_operations+',repository_node_id',
  personal_recovery_operations:v6Projections.personal_recovery_operations+',repository_node_id',
} as const
export const names = Object.keys(projections) as (keyof typeof projections)[]
const legacyProjections:Record<string,string>=Object.fromEntries(Object.keys(v2Projections).filter(name=>name!=='project_recovery_policy_approvals'&&name!=='project_recovery_cleanups')
  .map(name=>[name,name==='projects'?v2Projections.projects.replace('public_id,','public_id,name,'):v2Projections[name as keyof typeof v2Projections]]))
/** Built-in governance inventories omit live secrets and several administrative and plugin domains. */
export const controlCoverageGaps = ['database:remaining-governance-and-audit','files:deployment-state-and-offline-keys','plugin:delegated-policy-stores']
const inventory = z
  .object({
    version: z.union([z.literal(1),z.literal(2),z.literal(3),z.literal(4),z.literal(5),z.literal(6),z.literal(7)]),
    rows: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    topologyRevision: z.string(),
    watermark: z.string(),
  })
  .strict()
const inventoryRecord = z.object({table: z.string(), row: z.record(z.string(),z.unknown())}).strict()
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
  const fields:Readonly<Record<string,string>>=saved.version===1?legacyProjections:saved.version===2?v2Projections:saved.version===3?v3Projections:saved.version===4?v4Projections:saved.version===5?v5Projections:saved.version===6?v6Projections:projections
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
      const parsed=inventoryRecord.safeParse(JSON.parse(line))
      if(!parsed.success)throw new PeerBackupError(409,'peer-backup/invalid-export')
      const { table, row } = parsed.data
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
