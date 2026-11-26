/** Explicit account and computer review after offline governance rebuilding; Runtime execution remains separately held. */
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { hashPassword } from './password.ts'
import { lockAdministrator } from './postgres/administrator-authority.ts'
import { transaction } from './postgres/database.ts'
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'
import { PeerBackupError } from './peer-backup-repository.ts'
import { lockGovernanceLocalAuthority } from './governance-rebuild-local-authority.ts'
import { verifyProjectNameKeyring } from './project-name-keyring.ts'

const revision=z.string().regex(/^[1-9][0-9]{0,18}$/u)
const accountDecision=z.discriminatedUnion('decision',[
  z.object({confirm:z.uuid(),revision,decision:z.literal('restore'),newPassword:z.string().min(12).max(1024)}).strict(),
  z.object({confirm:z.uuid(),revision,decision:z.literal('keep-disabled')}).strict(),
])
const nodeDecision=z.object({confirm:z.uuid(),revision,decision:z.enum(['restore','keep-disabled'])}).strict()
const releaseConfirmation=z.object({confirm:z.uuid(),revision,acknowledgeUnrestoredDomains:z.array(z.string()).max(100)}).strict()
interface RebuildOperation {id:string;sourceNodeId:string;targetNodeId:string;bootstrapUserId:string;state:'review'|'released';revision:string;unrestoredDomains:string[]}
export interface GovernanceAccountReview {userId:string;publicId:number;username:string;role:'admin'|'member';sourceStatus:string;deleted:boolean;decision:'restore'|'keep-disabled'|null;bootstrap:boolean}
export interface GovernanceNodeReview {nodeId:string;name:string;sourceStatus:string;decision:'restore'|'keep-disabled'|null;quarantined:boolean}
export interface GovernanceRuntimeReview {id:string;runtimeId:string;nodeId:string;ownerKind:'user'|'project';ownerPublicId:number;observedState:string;generation:string;sourceGeneration:string;executionReviewRequired:true;dataBinding:'unbound'|'queued'|'verified'|'failed';bindingErrorCode:string|null}
export interface GovernanceRebuildStatus {
  operationId:string;state:'review'|'released';revision:string;sourceNodeId:string;targetNodeId:string;unrestoredDomains:string[]
  accounts:GovernanceAccountReview[];nodes:GovernanceNodeReview[];runtimes:GovernanceRuntimeReview[]
  unreconfiguredItems:Array<{table:string;recordDigest:string;identity:Record<string,unknown>}>
  continuation:{accounts:string|null;nodes:string|null;runtimes:string|null;configuration:string|null}
}
function deny(code:string):never{throw new PeerBackupError(409,'peer-backup/governance-'+code)}

/** Review on the replacement entry never starts, stops or reassigns a Runtime. */
export class GovernanceRebuildReview {
  constructor(private readonly context:PostgresRuntimeContext,private readonly options:{pageSize:number;projectNameKeyFile?:string}){}

  private async authority(tx:PoolClient,actor:number,id?:string):Promise<RebuildOperation>{
    await lockAdministrator(tx,this.context,actor)
    const op=(await tx.query<RebuildOperation>(`SELECT id,source_node_id "sourceNodeId",target_node_id "targetNodeId",bootstrap_user_id "bootstrapUserId",
      state,review_revision::text revision,unrestored_domains "unrestoredDomains" FROM harness.governance_rebuild_operations
      WHERE organization_id=$1 ORDER BY recovery_epoch DESC LIMIT 1 FOR UPDATE`,[this.context.organizationId])).rows[0]
    if(!op||id!==undefined&&op.id!==id)deny('review-changed')
    if(op.targetNodeId!==this.context.nodeId)deny('replacement-entry-required')
    return op
  }

  private async decision(tx:PoolClient,op:RebuildOperation,actor:number,kind:'account'|'node',subject:string,decision:'restore'|'keep-disabled'){
    const result=(await tx.query<{revision:string}>(`UPDATE harness.governance_rebuild_operations SET review_revision=review_revision+1
      WHERE id=$1 RETURNING review_revision::text revision`,[op.id])).rows[0]!
    await tx.query(`INSERT INTO harness.governance_rebuild_decisions(id,operation_id,organization_id,revision,subject_kind,subject_id,decision,approved_by)
      SELECT $1,$2,$3,$4,$5,$6,$7,u.id FROM harness.users u WHERE u.organization_id=$3 AND u.public_id=$8`,
    [randomUUID(),op.id,this.context.organizationId,result.revision,kind,subject,decision,actor])
    await tx.query(`INSERT INTO harness.audit_events(organization_id,actor_user_id,action,resource_type,resource_id,detail)
      SELECT $1,id,$3,'governance-rebuild',$4,jsonb_build_object('decision',$5::text,'subject',$6::text)
      FROM harness.users WHERE organization_id=$1 AND public_id=$2`,[this.context.organizationId,actor,'admin.governance-rebuild.review-'+kind,op.id,decision,subject])
    return {revision:result.revision}
  }

  private async runtimeRows(tx:PoolClient,operation:string,after:string|undefined,limit:number,node?:string):Promise<GovernanceRuntimeReview[]>{
    return (await tx.query<GovernanceRuntimeReview>(`SELECT r.id,r.runtime_id "runtimeId",r.node_id "nodeId",r.owner_kind "ownerKind",
        coalesce(u.public_id,p.public_id)::float8 "ownerPublicId",i.observed_state "observedState",i.generation::text generation,
        r.source_generation::text "sourceGeneration",true "executionReviewRequired",
        CASE WHEN b.binding_id IS NOT NULL THEN 'verified' ELSE coalesce(q.status,'unbound') END "dataBinding",q.error_code "bindingErrorCode"
        FROM harness.governance_rebuild_runtimes r
        JOIN harness.instances i ON i.organization_id=r.organization_id AND i.runtime_id=r.runtime_id
        LEFT JOIN harness.governance_rebuild_data_bindings b ON b.runtime_operation_id=r.id
        LEFT JOIN harness.governance_rebuild_binding_requests q ON q.runtime_operation_id=r.id
        LEFT JOIN harness.users u ON r.owner_kind='user' AND u.id=r.owner_id LEFT JOIN harness.projects p ON r.owner_kind='project' AND p.id=r.owner_id
        WHERE r.operation_id=$1 AND ($2::uuid IS NULL OR r.id>$2)
          AND ($4::uuid IS NULL OR r.node_id=$4 AND i.assigned_node_id=$4
            AND harness.governance_rebuild_execution_route(r.organization_id,r.runtime_id,$4)='governance') ORDER BY r.id LIMIT $3`,[operation,after??null,limit,node??null])).rows
  }

  /** Read only this admitted computer's retained Runtime identities after organization review is released.
   * @param actor - current local administrator with computer-use permission. @param after - previous Runtime review ID.
   * @returns local binding and execution-review coordinates without account, remote-node or grant inventories.
   */
  async localStatus(actor:number,after?:string){
    if(after!==undefined)z.uuid().parse(after)
    return transaction(this.context.pool,async tx=>{
      await lockGovernanceLocalAuthority(tx,this.context,actor)
      const op=(await tx.query<RebuildOperation>(`SELECT id,source_node_id "sourceNodeId",target_node_id "targetNodeId",state,
        review_revision::text revision FROM harness.governance_rebuild_operations WHERE organization_id=$1 ORDER BY recovery_epoch DESC LIMIT 1 FOR SHARE`,
      [this.context.organizationId])).rows[0]
      if(!op||op.state!=='released')deny('review-required')
      const rows=await this.runtimeRows(tx,op.id,after,this.options.pageSize+1,this.context.nodeId)
      return {localOnly:true as const,operationId:op.id,state:'released' as const,revision:op.revision,sourceNodeId:op.sourceNodeId,
        targetNodeId:op.targetNodeId,localNodeId:this.context.nodeId,runtimes:rows.slice(0,this.options.pageSize),
        continuation:{runtimes:rows.length>this.options.pageSize?rows[this.options.pageSize-1]!.id:null}}
    })
  }

  /** Read bounded management identities; cursors never select a different recovery operation.
   * @param actor - authenticated administrator. @param cursors - independent last IDs per section, omitted on the first page.
   * @returns the latest recovery and sanitized review rows, or null when this organization was not rebuilt.
   */
  async status(actor:number,cursors:{accounts?:string;nodes?:string;runtimes?:string;configuration?:string}={}):Promise<GovernanceRebuildStatus|null>{
    for(const [kind,value] of Object.entries(cursors))if(value!==undefined)(kind==='configuration'?z.string().regex(/^[a-f0-9]{64}$/u):z.uuid()).parse(value)
    return transaction(this.context.pool,async tx=>{
      await lockAdministrator(tx,this.context,actor)
      if(!(await tx.query('SELECT FROM harness.governance_rebuild_operations WHERE organization_id=$1 LIMIT 1',[this.context.organizationId])).rowCount)return null
      const op=await this.authority(tx,actor),limit=this.options.pageSize+1
      const accounts=(await tx.query<GovernanceAccountReview>(`SELECT a.user_id "userId",u.public_id::float8 "publicId",u.username::text username,
        a.source_role role,a.source_user_status "sourceStatus",a.source_deleted_at IS NOT NULL deleted,d.decision,a.user_id=$4 bootstrap
        FROM harness.governance_rebuild_accounts a JOIN harness.users u ON u.id=a.user_id AND u.organization_id=a.organization_id
        LEFT JOIN LATERAL(SELECT decision FROM harness.governance_rebuild_decisions WHERE operation_id=a.operation_id AND subject_kind='account'
          AND subject_id=a.user_id ORDER BY revision DESC LIMIT 1)d ON true
        WHERE a.operation_id=$1 AND ($2::uuid IS NULL OR a.user_id>$2) ORDER BY a.user_id LIMIT $3`,[op.id,cursors.accounts??null,limit,op.bootstrapUserId])).rows
      const nodes=(await tx.query<GovernanceNodeReview>(`SELECT a.node_id "nodeId",n.name::text name,a.source_status "sourceStatus",d.decision,
        EXISTS(SELECT FROM harness.node_recovery_quarantines q WHERE q.organization_id=a.organization_id AND q.node_id=a.node_id) quarantined
        FROM harness.governance_rebuild_nodes a JOIN harness.compute_nodes n ON n.id=a.node_id AND n.organization_id=a.organization_id
        LEFT JOIN LATERAL(SELECT decision FROM harness.governance_rebuild_decisions WHERE operation_id=a.operation_id AND subject_kind='node'
          AND subject_id=a.node_id ORDER BY revision DESC LIMIT 1)d ON true
        WHERE a.operation_id=$1 AND ($2::uuid IS NULL OR a.node_id>$2) ORDER BY a.node_id LIMIT $3`,[op.id,cursors.nodes??null,limit])).rows
      const runtimes=await this.runtimeRows(tx,op.id,cursors.runtimes,limit)
      const configuration=(await tx.query<{table:string;recordDigest:string;identity:Record<string,unknown>}>(`SELECT table_name "table",record_digest "recordDigest",safe_record identity
        FROM harness.governance_rebuild_reconfiguration WHERE operation_id=$1 AND ($2::text IS NULL OR record_digest>$2)
        ORDER BY record_digest LIMIT $3`,[op.id,cursors.configuration??null,limit])).rows
      const size=this.options.pageSize
      return {operationId:op.id,state:op.state,revision:op.revision,sourceNodeId:op.sourceNodeId,targetNodeId:op.targetNodeId,unrestoredDomains:op.unrestoredDomains,
        accounts:accounts.slice(0,size),nodes:nodes.slice(0,size),runtimes:runtimes.slice(0,size),unreconfiguredItems:configuration.slice(0,size),
        continuation:{accounts:accounts.length>size?accounts[size-1]!.userId:null,nodes:nodes.length>size?nodes[size-1]!.nodeId:null,
          runtimes:runtimes.length>size?runtimes[size-1]!.id:null,configuration:configuration.length>size?configuration[size-1]!.recordDigest:null}}
    })
  }

  /** Review an original account; restoring requires a new password and never enables it before release.
   * @param actor - current administrator. @param id - rebuilding operation. @param userId - preserved account UUID.
   * @param input - exact revision and restore/new-password or keep-disabled decision.
   * @returns the new monotonically increasing review revision.
   */
  async reviewAccount(actor:number,id:string,userId:string,input:unknown){
    const body=accountDecision.parse(input);z.uuid().parse(userId)
    if(body.confirm!==id)deny('review-changed')
    const password=body.decision==='restore'?await hashPassword(body.newPassword):undefined
    return transaction(this.context.pool,async tx=>{
      const op=await this.authority(tx,actor,id)
      if(op.state!=='review'||op.revision!==body.revision)deny('review-changed')
      if(userId===op.bootstrapUserId)deny('bootstrap-account-retained')
      const account=(await tx.query<{source_user_status:string;source_member_status:string;source_deleted_at:Date|null}>(`SELECT * FROM harness.governance_rebuild_accounts
        WHERE operation_id=$1 AND user_id=$2`,[id,userId])).rows[0]
      if(!account)deny('account-not-found')
      if(body.decision==='restore'&&(account.source_deleted_at!==null||account.source_user_status!=='active'||account.source_member_status!=='active'))deny('account-not-eligible')
      if(password!==undefined)await tx.query(`INSERT INTO harness.password_credentials(user_id,password_hash,password_version,must_change_password) VALUES($1,$2,1,false)
        ON CONFLICT(user_id) DO UPDATE SET password_hash=EXCLUDED.password_hash,password_version=harness.password_credentials.password_version+1,must_change_password=false,
          changed_at=clock_timestamp()`,[userId,password])
      await tx.query("UPDATE harness.users SET status='disabled' WHERE id=$1",[userId])
      await tx.query("UPDATE harness.memberships SET status='disabled' WHERE organization_id=$1 AND user_id=$2",[this.context.organizationId,userId])
      return this.decision(tx,op,actor,'account',userId,body.decision)
    })
  }

  /** Record eligibility to reconnect a computer with newly issued credentials after release.
   * @param actor - current administrator. @param id - rebuilding operation. @param nodeId - preserved computer UUID.
   * @param input - exact review revision and decision; physical isolation cannot be undone.
   * @returns the new review revision without issuing credentials or enabling execution.
   */
  async reviewNode(actor:number,id:string,nodeId:string,input:unknown){
    const body=nodeDecision.parse(input);z.uuid().parse(nodeId)
    if(body.confirm!==id)deny('review-changed')
    return transaction(this.context.pool,async tx=>{
      const op=await this.authority(tx,actor,id)
      if(op.state!=='review'||op.revision!==body.revision)deny('review-changed')
      const node=(await tx.query<{quarantined:boolean}>(`SELECT EXISTS(SELECT FROM harness.node_recovery_quarantines q
        WHERE q.organization_id=n.organization_id AND q.node_id=n.node_id) quarantined FROM harness.governance_rebuild_nodes n
        WHERE n.operation_id=$1 AND n.node_id=$2`,[id,nodeId])).rows[0]
      if(!node)deny('node-not-found')
      if(body.decision==='restore'&&node.quarantined)deny('source-quarantined')
      return this.decision(tx,op,actor,'node',nodeId,body.decision)
    })
  }

  /** Open reviewed accounts and ordinary configuration while retaining every unreviewed Runtime hold.
   * @param actor - current administrator. @param id - latest rebuilding operation.
   * @param input - exact revision and acknowledgement of every domain that requires fresh configuration or separate content recovery.
   * @returns released state; nodes still require enrollment and Runtime-local inspection.
   */
  async release(actor:number,id:string,input:unknown){
    const body=releaseConfirmation.parse(input)
    if(body.confirm!==id)deny('review-changed')
    return transaction(this.context.pool,async tx=>{
      const op=await this.authority(tx,actor,id)
      if(op.state!=='review'||op.revision!==body.revision)deny('review-changed')
      if(JSON.stringify([...new Set(body.acknowledgeUnrestoredDomains)].sort())!==JSON.stringify([...op.unrestoredDomains].sort()))deny('unrestored-domains-unacknowledged')
      const keys=(await tx.query<{key_id:string;fingerprint:string}>('SELECT key_id,fingerprint FROM harness.project_name_keys WHERE organization_id=$1',[this.context.organizationId])).rows
      if(keys.length){
        if(!this.options.projectNameKeyFile)deny('name-keys-required')
        try{await verifyProjectNameKeyring(this.options.projectNameKeyFile,this.context.organizationId,this.context.nodeId,Object.fromEntries(keys.map(row=>[row.key_id,row.fingerprint])))}
        catch{deny('keyring-proof-required')}
      }
      await tx.query(`UPDATE harness.users u SET status='active' FROM harness.governance_rebuild_accounts a
        WHERE a.operation_id=$1 AND u.id=a.user_id AND a.source_deleted_at IS NULL AND a.source_user_status='active' AND a.source_member_status='active'
          AND (SELECT decision FROM harness.governance_rebuild_decisions WHERE operation_id=$1 AND subject_kind='account' AND subject_id=u.id ORDER BY revision DESC LIMIT 1)='restore'`,[id])
      await tx.query(`UPDATE harness.memberships m SET status='active' FROM harness.users u
        WHERE m.organization_id=$1 AND m.user_id=u.id AND u.status='active'`,[this.context.organizationId])
      await tx.query(`UPDATE harness.governance_rebuild_operations SET state='released',review_revision=review_revision+1,released_at=clock_timestamp() WHERE id=$1`,[id])
      await tx.query(`UPDATE harness.cluster_control SET mode='serving',reason='Governance review released',updated_at=clock_timestamp()
        WHERE organization_id=$1 AND mode='restoring'`,[this.context.organizationId])
      await tx.query(`INSERT INTO harness.audit_events(organization_id,actor_user_id,action,resource_type,resource_id,detail)
        SELECT $1,id,'admin.governance-rebuild.release','governance-rebuild',$3,'{}' FROM harness.users WHERE organization_id=$1 AND public_id=$2`,
      [this.context.organizationId,actor,id])
      return {state:'released' as const,revision:(BigInt(op.revision)+1n).toString()}
    })
  }
}
