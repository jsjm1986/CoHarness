/** Stopped, node-owned data bindings and fresh artifact reviews after governance reconstruction. */
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import type { GatewayConfig } from './config.ts'
import type { RuntimeTarget } from './instances.ts'
import type { GovernanceExecutionOperation,GovernanceRecoveryExecutionAdapter } from './governance-rebuild-execution-protocol.ts'
import type { GovernanceRebuildLocalData,GovernanceLocalDataSelection,GovernanceLocalDataReference } from './governance-rebuild-local-data.ts'
import { lockAdministrator } from './postgres/administrator-authority.ts'
import { transaction } from './postgres/database.ts'
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'
import { PeerBackupError } from './peer-backup-repository.ts'
import { PeerProjectFileGate } from './peer-backup-file-gate.ts'
import { lockRecoveryTarget } from './peer-backup-governance.ts'
import { lockGovernanceLocalAuthority } from './governance-rebuild-local-authority.ts'
import { resolveGovernanceLocalPaths, type GovernanceLocalPaths } from './governance-rebuild-local-paths.ts'

function deny(code:string):never{throw new PeerBackupError(409,'peer-backup/governance-'+code)}
const confirmation=z.object({confirm:z.uuid()}).strict()
const manualInspection='peer-backup/governance-local-manual-inspection-required'
interface Options {
  config:Pick<GatewayConfig,'usersRoot'|'projectRuntimesRoot'>
  files:GovernanceRebuildLocalData
  /** Prove no node-local process or supervisor can still write; never stop a process to obtain proof. */
  assertStopped:(target:RuntimeTarget)=>Promise<void>
}

/** The governance adapter supplies authority and data proofs to the existing recovery execution engine. */
export class GovernanceRebuildExecution implements GovernanceRecoveryExecutionAdapter {
  constructor(private readonly context:PostgresRuntimeContext,private readonly options:Options){}

  async get(id:string):Promise<GovernanceExecutionOperation>{
    z.uuid().parse(id)
    const row=(await this.context.pool.query<GovernanceExecutionOperation>(`SELECT 'governance' "recoveryScope",r.id,r.operation_id "governanceOperationId",
      r.organization_id "organizationId",r.runtime_id "runtimeId",r.owner_kind "ownerKind",r.owner_id "ownerId",coalesce(u.public_id,p.public_id)::float8 "publicId",
      r.node_id "targetNode",r.volume_id "targetVolume",r.writer_epoch::text "newEpoch",r.source_generation::text "sourceGeneration",
      o.point_id "pointId",o.state phase,'[]'::jsonb "suspendedEnvironmentKeys" FROM harness.governance_rebuild_runtimes r
      JOIN harness.governance_rebuild_operations o ON o.id=r.operation_id
      LEFT JOIN harness.users u ON r.owner_kind='user' AND u.id=r.owner_id AND u.organization_id=r.organization_id
      LEFT JOIN harness.projects p ON r.owner_kind='project' AND p.id=r.owner_id AND p.organization_id=r.organization_id
      WHERE r.id=$1 AND r.organization_id=$2 AND o.recovery_epoch=(SELECT max(recovery_epoch) FROM harness.governance_rebuild_operations WHERE organization_id=$2)`,
    [id,this.context.organizationId])).rows[0]
    if(!row)deny('review-changed')
    return row
  }

  async authorize<T>(actor:number,work:(tx:PoolClient)=>Promise<T>,op?:GovernanceExecutionOperation):Promise<T>{
    return transaction(this.context.pool,async tx=>{
      await lockAdministrator(tx,this.context,actor)
      const entry=(await tx.query<{id:string;target:string;state:string;enabled:boolean}>(`SELECT o.id,o.target_node_id target,o.state,t.enabled
        FROM harness.governance_rebuild_operations o JOIN harness.deployment_topology t USING(organization_id)
        WHERE o.organization_id=$1 ORDER BY o.recovery_epoch DESC LIMIT 1 FOR SHARE OF o,t`,[this.context.organizationId])).rows[0]
      if(!entry||op&&entry.id!==op.governanceOperationId)deny('review-changed')
      if(this.context.nodeId!==entry.target){
        if(entry.state!=='released'||this.context.nodeId!==op?.targetNode)deny('replacement-entry-required')
        await lockGovernanceLocalAuthority(tx,this.context,actor)
      }
      return work(tx)
    })
  }

  private async identity(tx:PoolClient,op:GovernanceExecutionOperation,stopped:boolean,requireBinding:boolean){
    const row=(await tx.query<{stopped:boolean;closed:boolean;generation:string}>(`SELECT i.observed_state='stopped' AND i.desired_state='stopped' AND i.runtime_token_hash IS NULL stopped,
      i.desired_state='stopped' AND i.runtime_token_hash IS NULL closed,
      i.generation::text generation FROM harness.governance_rebuild_runtimes r JOIN harness.governance_rebuild_operations o ON o.id=r.operation_id
      JOIN harness.runtime_environments e ON (e.organization_id,e.id,e.node_id,e.owner_kind,e.owner_id)=(r.organization_id,r.runtime_id,r.node_id,r.owner_kind,r.owner_id)
      JOIN harness.instances i ON (i.organization_id,i.runtime_id,i.assigned_node_id)=(r.organization_id,r.runtime_id,r.node_id)
      WHERE r.id=$1 AND r.organization_id=$2 AND r.node_id=$3 AND r.writer_epoch=$4 AND o.id=$5 AND o.state='released' AND e.retired_at IS NULL
        AND o.recovery_epoch=(SELECT max(recovery_epoch) FROM harness.governance_rebuild_operations WHERE organization_id=$2)
        AND NOT EXISTS(SELECT FROM harness.node_recovery_quarantines q WHERE q.organization_id=r.organization_id AND q.node_id=r.node_id)
        AND (r.owner_kind='project' AND EXISTS(SELECT FROM harness.project_content_placement p WHERE p.organization_id=r.organization_id
          AND p.project_id=r.owner_id AND p.runtime_id=r.runtime_id AND p.node_id=r.node_id AND p.volume_id=r.volume_id AND p.writer_epoch=r.writer_epoch)
          OR r.owner_kind='user' AND EXISTS(SELECT FROM harness.personal_directory_placement p WHERE p.organization_id=r.organization_id
            AND p.runtime_id=r.runtime_id AND p.owner_id=r.owner_id AND p.node_id=r.node_id)) FOR UPDATE OF r,i,e,o`,
    [op.id,op.organizationId,op.targetNode,op.newEpoch,op.governanceOperationId])).rows[0]
    if(!row)deny('local-identity-mismatch')
    if(BigInt(row.generation)<BigInt(op.sourceGeneration))deny('local-generation-changed')
    if(stopped&&!row.stopped||!requireBinding&&!row.closed)deny('local-runtime-not-stopped')
    if(requireBinding)await this.reference(tx,op)
    return row
  }

  async lock(tx:PoolClient,op:GovernanceExecutionOperation,stopped:boolean):Promise<void>{await this.identity(tx,op,stopped,true)}

  async nodeReady(tx:PoolClient,op:GovernanceExecutionOperation):Promise<void>{
    if(op.targetNode!==this.context.nodeId)deny('local-target-required')
    const entry=(await tx.query<{enabled:boolean}>(`SELECT t.enabled FROM harness.deployment_topology t
      JOIN harness.cluster_control c USING(organization_id) JOIN harness.compute_nodes n ON n.organization_id=t.organization_id AND n.id=$2
      WHERE t.organization_id=$1 AND c.mode='serving' AND n.status='active' AND NOT EXISTS(SELECT FROM harness.node_recovery_quarantines q
        WHERE q.organization_id=t.organization_id AND q.node_id=n.id) FOR SHARE OF t,c,n`,[this.context.organizationId,this.context.nodeId])).rows[0]
    if(!entry)deny('local-node-not-admitted')
    if(entry.enabled)await lockRecoveryTarget(tx,this.context.organizationId,this.context.nodeId)
  }

  private async reference(tx:Pick<PoolClient,'query'>,op:GovernanceExecutionOperation):Promise<GovernanceLocalDataReference>{
    const row=(await tx.query<GovernanceLocalDataReference>(`SELECT binding_id "bindingId",evidence_digest "evidenceDigest" FROM harness.governance_rebuild_data_bindings
      WHERE runtime_operation_id=$1 AND organization_id=$2 AND runtime_id=$3 AND node_id=$4 AND source_generation=$5`,
    [op.id,op.organizationId,op.runtimeId,op.targetNode,op.sourceGeneration])).rows[0]
    if(!row)deny('local-binding-required')
    return row
  }

  async paths(op:GovernanceExecutionOperation){return this.options.files.paths(op.id,await this.reference(this.context.pool,op))}
  async oldSessions(op:GovernanceExecutionOperation){return this.options.files.oldSessionIds(op.id,await this.reference(this.context.pool,op))}

  async selectHold(runtimeId:string):Promise<string|undefined>{
    const route=(await this.context.pool.query<{route:string}>('SELECT harness.governance_rebuild_execution_route($1,$2,$3) route',
      [this.context.organizationId,runtimeId,this.context.nodeId])).rows[0]!.route
    if(route==='ordinary'||route==='scope')return undefined
    if(route==='blocked')deny('review-required')
    const row=(await this.context.pool.query<{id:string}>(`SELECT r.id FROM harness.governance_rebuild_runtimes r
      JOIN harness.governance_rebuild_operations o ON o.id=r.operation_id WHERE r.organization_id=$1 AND r.runtime_id=$2
      ORDER BY o.recovery_epoch DESC LIMIT 1`,[this.context.organizationId,runtimeId])).rows[0]
    if(!row)deny('review-required')
    return row.id
  }

  /** Resolve only the current governance scope's sealed node-local paths; required absent evidence never falls back.
   * @param target - exact or unambiguous node-local assignment supplied by the repository.
   * @returns verified account/workspace and optional retained Runtime homes; ordinary accounts and newer scope-owned recoveries return undefined.
   */
  async localPaths(target:RuntimeTarget):Promise<GovernanceLocalPaths|undefined>{
    return resolveGovernanceLocalPaths(this.context,this.options.files,target)
  }

  /** Queue standard-path inspection on the data owner; no path passes through the center.
   * @param actor - authenticated administrator. @param id - per-Runtime rebuilding review.
   * @param input - exact review confirmation.
   */
  async requestBinding(actor:number,id:string,input:unknown):Promise<void>{
    if(confirmation.parse(input).confirm!==id)deny('review-changed')
    const op=await this.get(id)
    await this.authorize(actor,async tx=>{
      const identity=await this.identity(tx,op,false,false)
      if(identity.generation!==op.sourceGeneration)deny('local-generation-changed')
      if((await tx.query('SELECT FROM harness.governance_rebuild_data_bindings WHERE runtime_operation_id=$1',[id])).rowCount)return
      await tx.query(`INSERT INTO harness.governance_rebuild_binding_requests(runtime_operation_id,organization_id,request_id,requested_by,status)
        SELECT $1,$2,$3,id,'queued' FROM harness.users WHERE organization_id=$2 AND public_id=$4
        ON CONFLICT(runtime_operation_id) DO UPDATE SET request_id=EXCLUDED.request_id,requested_by=EXCLUDED.requested_by,
          requested_at=clock_timestamp(),status='queued',error_code=NULL`,[id,op.organizationId,randomUUID(),actor])
    },op)
  }

  /** Inspect administrator-selected paths only on the browser's directly accessed data owner.
   * @param actor - administrator authenticated by this node. @param id - exact Runtime rebuilding review.
   * @param input - exact review and local-only directory selection; failures require explicit resubmission and never queue standard-path inspection.
   * @param signal - request lifetime; cancellation leaves admission closed.
   */
  async bindLocal(actor:number,id:string,input:unknown,signal:AbortSignal):Promise<void>{
    const body=z.object({confirm:z.uuid(),selection:z.object({homePath:z.string().min(1).max(4096),runtimeHome:z.string().min(1).max(4096).optional()}).strict()}).strict().parse(input)
    if(body.confirm!==id)deny('review-changed')
    const op=await this.get(id)
    if(op.targetNode!==this.context.nodeId)deny('local-target-required')
    const requestId=randomUUID()
    await transaction(this.context.pool,async tx=>{
      await lockGovernanceLocalAuthority(tx,this.context,actor)
      const current=await this.identity(tx,op,false,false);await this.nodeReady(tx,op)
      if(current.generation!==op.sourceGeneration)deny('local-generation-changed')
      if((await tx.query('SELECT FROM harness.governance_rebuild_data_bindings WHERE runtime_operation_id=$1',[id])).rowCount)deny('local-binding-already-recorded')
      // Local paths are never persisted in the organization queue. An interrupted
      // manual inspection requires the administrator to submit those paths again.
      await tx.query(`INSERT INTO harness.governance_rebuild_binding_requests(runtime_operation_id,organization_id,request_id,requested_by,status,error_code)
        SELECT $1,$2,$3,id,'failed',$5 FROM harness.users WHERE organization_id=$2 AND public_id=$4
        ON CONFLICT(runtime_operation_id) DO UPDATE SET request_id=EXCLUDED.request_id,requested_by=EXCLUDED.requested_by,
          requested_at=clock_timestamp(),status='failed',error_code=EXCLUDED.error_code`,[id,op.organizationId,requestId,actor,manualInspection])
    },signal)
    try{await this.bindOne(op,requestId,body.selection,signal)}catch(error){
      const code=error instanceof PeerBackupError?error.code:'peer-backup/governance-local-binding-failed'
      try{
        await this.context.pool.query(`UPDATE harness.governance_rebuild_binding_requests SET error_code=$3
          WHERE runtime_operation_id=$1 AND request_id=$2 AND status='failed' AND error_code=$4`,[id,requestId,code,manualInspection])
      }catch(recordingError){throw new AggregateError([error,recordingError],'Manual data inspection failed and its failure could not be recorded')}
      throw error
    }
  }

  private async bindOne(op:GovernanceExecutionOperation,requestId:string,selection:GovernanceLocalDataSelection|undefined,signal:AbortSignal){
    const gate=new PeerProjectFileGate(op.ownerKind==='user'?this.options.config.usersRoot:this.options.config.projectRuntimesRoot,'peer-project-recovery-work')
    await gate.exclusive(op.publicId,async()=>{
      const accepted=await transaction(this.context.pool,async tx=>{
        const identity=await this.identity(tx,op,false,false);await this.nodeReady(tx,op)
        if(identity.generation!==op.sourceGeneration)deny('local-generation-changed')
        return (await tx.query(`SELECT FROM harness.governance_rebuild_binding_requests WHERE runtime_operation_id=$1
          AND request_id=$2 AND ((NOT $3 AND status='queued' AND error_code IS NULL)
            OR ($3 AND status='failed' AND error_code=$4))`,[op.id,requestId,selection!==undefined,manualInspection])).rowCount===1
      },signal)
      if(!accepted){if(selection!==undefined)deny('review-changed');return}
      await this.options.assertStopped({kind:op.ownerKind,id:op.publicId,runtimeId:op.runtimeId})
      const proof=await this.options.files.bind(op.id,selection,signal)
      await this.options.assertStopped({kind:op.ownerKind,id:op.publicId,runtimeId:op.runtimeId})
      await transaction(this.context.pool,async tx=>{
        const identity=await this.identity(tx,op,false,false);await this.nodeReady(tx,op)
        if(identity.generation!==proof.sourceGeneration||proof.sourceGeneration!==op.sourceGeneration)deny('local-generation-changed')
        if(!(await tx.query(`SELECT FROM harness.governance_rebuild_binding_requests WHERE runtime_operation_id=$1
          AND request_id=$2 AND ((NOT $3 AND status='queued' AND error_code IS NULL)
            OR ($3 AND status='failed' AND error_code=$4)) FOR UPDATE`,[op.id,requestId,selection!==undefined,manualInspection])).rowCount)deny('review-changed')
        await tx.query(`UPDATE harness.instances SET observed_state='stopped',updated_at=clock_timestamp()
          WHERE organization_id=$1 AND runtime_id=$2 AND assigned_node_id=$3 AND generation=$4 AND desired_state='stopped' AND runtime_token_hash IS NULL`,
        [op.organizationId,op.runtimeId,op.targetNode,proof.sourceGeneration])
        await tx.query(`INSERT INTO harness.governance_rebuild_data_bindings(runtime_operation_id,organization_id,runtime_id,node_id,binding_id,
          evidence_digest,old_session_count,source_generation) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [op.id,op.organizationId,op.runtimeId,op.targetNode,proof.bindingId,proof.evidenceDigest,proof.oldSessionCount,proof.sourceGeneration])
        await tx.query(`UPDATE harness.governance_rebuild_binding_requests SET status='ready',error_code=NULL WHERE runtime_operation_id=$1 AND request_id=$2`,[op.id,requestId])
      },signal)
    })
  }

  /** Inspect one queued local Runtime. A slow node does not prevent other nodes from processing their own queues.
   * @param signal - worker lifetime, including cancellation of file inspection.
   */
  async bindNext(signal:AbortSignal):Promise<void>{
    const next=(await this.context.pool.query<{id:string;requestId:string}>(`SELECT q.runtime_operation_id id,q.request_id "requestId"
      FROM harness.governance_rebuild_binding_requests q JOIN harness.governance_rebuild_runtimes r ON r.id=q.runtime_operation_id
      WHERE q.organization_id=$1 AND r.node_id=$2 AND q.status='queued' ORDER BY q.requested_at LIMIT 1`,[this.context.organizationId,this.context.nodeId])).rows[0]
    if(!next)return
    try{await this.bindOne(await this.get(next.id),next.requestId,undefined,signal)}catch(error){
      if(signal.aborted)throw error
      if(error instanceof PeerBackupError&&error.code==='peer-backup/project-files-busy')return
      const code=error instanceof PeerBackupError?error.code:'peer-backup/governance-local-binding-failed'
      await this.context.pool.query(`UPDATE harness.governance_rebuild_binding_requests SET status='failed',error_code=$3
        WHERE runtime_operation_id=$1 AND request_id=$2 AND status='queued'`,[next.id,next.requestId,code])
      if(!(error instanceof PeerBackupError))console.error('[gateway] governance data inspection failed:',error)
    }
  }
}
