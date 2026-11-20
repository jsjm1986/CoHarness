/** Preserve an actual schema-135 isolated operation without inventing target preparation evidence. */
import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Pool } from 'pg'
import { runMigrations, transaction } from '../src/postgres/database.ts'

/** Install only the committed prefix in an owned empty test database.
 * @param pool - isolated governance test database. @param root - disposable fixture directory.
 */
export async function installLegacyRecoverySchema(pool:Pool,root:string):Promise<void>{
  const source=resolve(import.meta.dirname,'../deploy/postgres/migrations'),prefix=join(root,'schema-135')
  await mkdir(prefix,{mode:0o700})
  for(const name of await readdir(source))if(/^\d+.*\.sql$/u.test(name)&&Number(name.split('_')[0])<=135)
    await copyFile(join(source,name),join(prefix,name))
  await runMigrations(pool,prefix)
}

/** Record the older release's approved-isolation sequence using its unmodified SQL guards, then upgrade.
 * @param pool - database currently at schema 135. @param actor - fixture administrator.
 * @param intent - independently captured and drilled point with its original receiver as replacement.
 */
export async function upgradeLegacyIsolatedRecovery(pool:Pool,actor:number,intent:{requestId:string;policyId:string;pointId:string;targetNode:string;targetVolume:string}):Promise<void>{
  await transaction(pool,async tx=>{
    await tx.query(`INSERT INTO harness.project_recovery_operations(id,organization_id,project_id,runtime_id,policy_id,
      point_id,policy_revision,approved_by,source_node_id,source_volume_id,source_epoch,target_node_id,target_volume_id,
      target_epoch,manifest_digest,point_revision,phase,recovery_mode)
      SELECT $1,p.organization_id,p.scope_id,b.runtime_id,p.id,q.id,p.revision,u.id,b.node_id,b.volume_id,b.writer_epoch,
        $4,$5,b.writer_epoch+1,q.manifest_digest,q.watermark,'prepared','disaster'
      FROM harness.peer_backup_policies p JOIN harness.peer_backup_points q ON q.policy_id=p.id AND q.id=$3
      JOIN harness.project_content_placement b ON b.organization_id=p.organization_id AND b.project_id=p.scope_id
      JOIN harness.users u ON u.organization_id=p.organization_id AND u.public_id=$6
      WHERE p.id=$2 AND p.target_node_id=$4`,[intent.requestId,intent.policyId,intent.pointId,intent.targetNode,intent.targetVolume,actor])
    await tx.query(`INSERT INTO harness.project_recovery_isolations(operation_id,organization_id,source_node_id,source_generation,source_epoch,
      point_id,policy_revision,method,evidence_reference,confirmed_by,acknowledge_data_loss)
      SELECT r.id,r.organization_id,r.source_node_id,i.generation,r.source_epoch,r.point_id,r.policy_revision,
        'power-off','fixture/schema-135-isolated',r.approved_by,true FROM harness.project_recovery_operations r
      JOIN harness.instances i ON i.runtime_id=r.runtime_id WHERE r.id=$1`,[intent.requestId])
    await tx.query(`INSERT INTO harness.node_recovery_quarantines(organization_id,node_id,operation_id)
      SELECT organization_id,source_node_id,id FROM harness.project_recovery_operations WHERE id=$1`,[intent.requestId])
    await tx.query(`INSERT INTO harness.project_recovery_execution_holds(operation_id,organization_id,runtime_id)
      SELECT id,organization_id,runtime_id FROM harness.project_recovery_operations WHERE id=$1`,[intent.requestId])
    await tx.query(`UPDATE harness.instances i SET desired_state='stopped',runtime_token_hash=NULL,stop_reason='access-change'
      FROM harness.project_recovery_operations r WHERE r.id=$1 AND i.organization_id=r.organization_id AND i.assigned_node_id=r.source_node_id`,[intent.requestId])
    await tx.query(`UPDATE harness.node_agents a SET credential_hash=NULL,revoked_at=clock_timestamp(),connection_id=NULL,
      lease_expires_at=NULL,connection_epoch=connection_epoch+1,revision=revision+1 FROM harness.project_recovery_operations r
      WHERE r.id=$1 AND a.organization_id=r.organization_id AND a.node_id=r.source_node_id`,[intent.requestId])
    await tx.query(`UPDATE harness.node_agent_enrollments e SET consumed_at=coalesce(consumed_at,clock_timestamp())
      FROM harness.project_recovery_operations r WHERE r.id=$1 AND e.organization_id=r.organization_id AND e.node_id=r.source_node_id`,[intent.requestId])
    await tx.query(`UPDATE harness.compute_nodes n SET status='offline' FROM harness.project_recovery_operations r
      WHERE r.id=$1 AND n.organization_id=r.organization_id AND n.id=r.source_node_id`,[intent.requestId])
    await tx.query("UPDATE harness.project_recovery_operations SET phase='externally-fenced' WHERE id=$1",[intent.requestId])
  })
  await runMigrations(pool,resolve(import.meta.dirname,'../deploy/postgres/migrations'))
}
