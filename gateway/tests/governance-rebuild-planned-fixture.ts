/** Retained node-owned project data receives a new governance review before the real encrypted planned move. */
import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import type { GatewayConfig } from '../src/config.ts'
import { GovernanceRebuildGateway } from '../src/governance-rebuild-gateway.ts'
import { InstanceManager } from '../src/instances.ts'
import { LocalRuntimeOwnerStore } from '../src/local-runtime-owner.ts'
import { localKernelBootId } from '../src/local-runtime-protocol.ts'
import { nodeControlPaths } from '../src/node-control-paths.ts'
import type { NodeContentStore } from '../src/node-content-store.ts'
import { NodeProjectMetadata } from '../src/node-content-projects.ts'
import type { PeerRecoveryOperation } from '../src/peer-backup-takeover.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import type { PostgresRuntimeContext } from '../src/postgres/runtime-context.ts'

/** Bind real retained project files, inspect the installed profile and approve only new conversations.
 * @param input - already stopped, activated project and its actual content volume.
 * @returns the new immutable source review; no Runtime starts or stops.
 */
export async function prepareGovernancePlannedFixture(input:{primary:PostgresRuntimeContext;source:PostgresRuntimeContext;
  volume:NodeContentStore;cfg:GatewayConfig;op:PeerRecoveryOperation;admin:number;signal:AbortSignal;limits:{maxBytes:number;maxRows:number}}){
  const {primary,source,volume,cfg,op,admin,signal,limits}=input
  const operation=randomUUID(),runtimeOperation=randomUUID(),point=randomUUID()
  const actor=(await primary.pool.query<{id:string}>('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2',[op.organizationId,admin])).rows[0]!.id
  const generation=(await primary.pool.query<{n:string}>('SELECT generation::text n FROM harness.instances WHERE runtime_id=$1',[op.runtimeId])).rows[0]!.n
  await primary.pool.query(`INSERT INTO harness.governance_rebuild_operations(id,organization_id,source_node_id,target_node_id,point_id,manifest_digest,
    schema_digest,source_watermark,source_topology_revision,recovery_epoch,bootstrap_user_id,isolation_method,evidence_reference,unrestored_domains,state,released_at)
    VALUES($1,$2,$3,$4,$5,$6,$6,1,1,1,$7,'power-off','fixture source isolation','[]','released',clock_timestamp())`,
  [operation,op.organizationId,op.sourceNode,primary.nodeId,point,'a'.repeat(64),actor])
  await primary.pool.query(`INSERT INTO harness.governance_rebuild_runtimes(id,operation_id,organization_id,runtime_id,node_id,owner_kind,owner_id,source_generation,writer_epoch,volume_id)
    VALUES($1,$2,$3,$4,$5,'project',$6,$7,$8,$9)`,[runtimeOperation,operation,op.organizationId,op.runtimeId,source.nodeId,op.projectId,generation,op.newEpoch,op.targetVolume])
  await primary.pool.query(`INSERT INTO harness.governance_rebuild_execution_holds(operation_id,organization_id,runtime_id) VALUES($1,$2,$3)`,[runtimeOperation,op.organizationId,op.runtimeId])
  const repository=new PostgresInstanceRepository(source,cfg.instancePortBase,new NodeProjectMetadata(source,volume)),manager=new InstanceManager(repository,cfg)
  const gateway=new GovernanceRebuildGateway({context:source,config:cfg,volume,limits,pageSize:100,
    assertStopped:target=>manager.assertRuntimeQuiescent(target),prepareProfile:target=>manager.prepareRecoveryProfile(target)})
  const authority=new GovernanceRebuildGateway({context:primary,config:cfg,limits,pageSize:100,
    assertStopped:async()=>{throw new Error('Primary cannot inspect foreign files')},prepareProfile:async()=>{throw new Error('Primary cannot project foreign profiles')}})
  repository.resolveLocalPaths=target=>gateway.adapter.localPaths(target)
  const store=new LocalRuntimeOwnerStore(nodeControlPaths(cfg.stateRoot).localRuntime,{node:cfg.computeNodeName,kind:'project',ownerId:op.publicId,
    runtimeKey:'project-'+op.publicId,generation:Number(generation),credentialHash:'c'.repeat(64)})
  const ownership=await store.acquire()
  try{const current=await ownership.create(await localKernelBootId());await ownership.publish({...current,phase:'stopped'})}
  finally{await ownership.close()}
  await authority.adapter.requestBinding(admin,runtimeOperation,{confirm:runtimeOperation})
  await gateway.adapter.bindNext(signal)
  expect((await primary.pool.query('SELECT status,error_code FROM harness.governance_rebuild_binding_requests WHERE runtime_operation_id=$1',[runtimeOperation])).rows[0])
    .toEqual({status:'ready',error_code:null})
  await authority.execution.prepare(admin,runtimeOperation,{confirm:runtimeOperation});await gateway.execution.prepareNext(signal)
  const review=await authority.execution.status(admin,runtimeOperation)
  expect(review,JSON.stringify(review)).toMatchObject({preparationStatus:'ready',blockers:[]})
  await authority.execution.enable(admin,runtimeOperation,{confirm:runtimeOperation,reviewRevision:review.reviewRevision,mode:'new-conversations-only'})
  return {operationId:runtimeOperation,reviewId:review.reviewRevision!}
}
