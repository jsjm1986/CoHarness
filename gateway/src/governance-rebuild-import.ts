/** Offline governance reconstruction into an empty, checksummed database. Imported evidence never restores execution credentials. */
import { createHash, randomBytes } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { hashPassword } from './password.ts'
import { transaction } from './postgres/database.ts'
import { PeerBackupError } from './peer-backup-repository.ts'
import { verifyGovernanceRebuildSchema } from './peer-governance-rebuild-export.ts'
import { GOVERNANCE_REBUILD_SCHEMA_VERSION, governanceRebuildTables, type GovernanceRebuildPackage, type GovernanceRebuildRecord, type GovernanceRebuildTable } from './peer-governance-rebuild-manifest.ts'
import { governanceRebuildRecordDigest } from './peer-governance-rebuild-validation.ts'

const requestSchema=z.object({operationId:z.uuid(),pointId:z.uuid(),targetNodeId:z.uuid(),targetNodeName:z.string().trim().min(1).max(128),
  bootstrapUserId:z.uuid(),bootstrapPassword:z.string().min(12).max(1024),
  isolationMethod:z.enum(['power-off','network-isolation']),evidenceReference:z.string().trim().min(1).max(512)
    .refine(value=>!/[\u0000-\u001f\u007f]/u.test(value)&&!/:\/\/[^/\s]*@/u.test(value)),acknowledgeDataLoss:z.literal(true)}).strict()
export type GovernanceRebuildImportRequest=z.infer<typeof requestSchema>
const tableNames=Object.keys(governanceRebuildTables) as GovernanceRebuildTable[]
const deferredConfiguration=new Set<GovernanceRebuildTable>(['ssh_targets','ssh_target_shares','webhook_endpoints','plugin_states','node_resource_state','project_members'])
const reviewedGrants=new Set<GovernanceRebuildTable>(['computer_use_permissions','plugin_access_policies','desktop_access_policies','memory_access_policies',
  'ssh_access_policies','terminal_access_policies','steward_access_policies','model_role_access','model_user_access','model_project_access','project_invitations','projects','model_catalog'])
const sha=(value:string)=>createHash('sha256').update(value).digest('hex')
function fail(code:string):never{throw new PeerBackupError(409,'peer-backup/governance-'+code)}
function identifier(value:string):string{return '"'+value.replaceAll('"','""')+'"'}

interface ForeignKey {table_name:string;name:string;deferrable:boolean;deferred:boolean}
interface Trigger {table_name:string;name:string;enabled:string;definition:string}

/** Reset only authority or fields explicitly omitted by the package; immutable business identities stay unchanged.
 * @param record - validated safe projection from the package.
 * @param ports - node-local port reservations for disabled instances.
 * @param sourceVersion - reviewed schema of the original immutable package.
 * @returns fixed restoration fields, independent of browser or backup-supplied SQL.
 */
export function governanceRebuildDefaults(record:GovernanceRebuildRecord,ports:Map<string,number>,sourceVersion=GOVERNANCE_REBUILD_SCHEMA_VERSION):Record<string,unknown>{
  const row=record.row
  switch(record.table){
    case 'organizations':return {status:'disabled'}
    case 'users':return {status:'disabled',home_path:'governance-recovery-unbound:'+String(row.id)}
    case 'memberships':return {status:'disabled',role:'member'}
    case 'password_credentials':return {password_hash:'governance-recovery-disabled',must_change_password:true}
    case 'compute_nodes':return {status:'offline',principal_public_key:null,access_applied_revision:0,maintenance_applied_epoch:0,inflight_writes:0}
    case 'node_agents':return {credential_hash:null,revoked_at:new Date().toISOString(),connection_id:null,lease_expires_at:null,last_seen_at:null,
      revision:String(BigInt(String(row.revision))+1n),connection_epoch:String(BigInt(String(row.connection_epoch))+1n),attachment_state:'detached',execution_ready:false}
    case 'node_user_accounts':return {home_path:'governance-recovery-unbound:'+String(row.user_id)}
    case 'projects':return {name:'hgw-project-'+String(row.id),model_access_default_allowed:false}
    case 'model_catalog':return {enabled:false}
    case 'computer_use_permissions':case 'plugin_access_policies':case 'desktop_access_policies':case 'memory_access_policies':
    case 'ssh_access_policies':case 'terminal_access_policies':case 'steward_access_policies':return {enabled:false}
    case 'model_role_access':case 'model_user_access':case 'model_project_access':return {allowed:false}
    case 'project_mounts':return {local_path:'governance-recovery-unbound:'+String(row.project_id),canonical_path:'governance-recovery-unbound:'+String(row.project_id),status:'missing'}
    case 'instances':{
      const node=String(row.assigned_node_id),port=(ports.get(node)??1023)+1
      if(port>65535)fail('instance-capacity')
      ports.set(node,port)
      return {desired_state:'stopped',port,allocation_state:'unknown',provisioning_state:'ready',applied_policy_revision:0,
        runtime_token_hash:null,runtime_token_issued_at:null,node_connection_id:null,node_connection_epoch:null,launch_stamp:null}
    }
    case 'cluster_control':return {mode:'restoring',reason:'Governance disaster review',write_epoch:String(BigInt(String(row.write_epoch))+1n),
      maintenance_epoch:String(BigInt(String(row.maintenance_epoch))+1n)}
    case 'deployment_topology':return {enabled:false,primary_node_id:null,primary_origin:null,legacy_initialization_required:false,
      revision:String(BigInt(String(row.revision))+1n)}
    case 'model_providers':return {status:row.status==='archived'?'archived':'disabled',base_url:null,profile:null,auth_mode:'none',credential_ref:null}
    case 'model_usage':return {purpose:'governance-rebuild',session_id:null,credential_source:'unconfigured'}
    case 'model_registration_events':return {provider_key:'governance-rebuild',model_key:null}
    case 'desktop_resources':return {state:'unavailable',state_note:'Governance disaster review',updated_at:Date.now()}
    case 'peer_backup_policies':return {enabled:false,append_hash:randomBytes(32).toString('hex'),recovery_hash:randomBytes(32).toString('hex')}
    case 'project_recovery_operations':case 'personal_recovery_operations':return sourceVersion===135?{
      repository_node_id:row.target_node_id,
      ...(record.table==='project_recovery_operations'&&row.recovery_mode==='disaster'&&row.phase==='prepared'&&row.target_verified_at===null
        ?{phase:'preparing'}:{}),
    }:{}
    case 'backup_records':return {path:'governance-recovery-unavailable:'+String(row.id),managed_files:[],status:'failed',error:'Source maintenance files were not restored'}
    case 'project_invitations':return {status:'revoked'}
    case 'personal_recovery_execution_requests':case 'project_recovery_execution_requests':case 'governance_rebuild_execution_requests':case 'governance_rebuild_binding_requests':
      return {status:'failed',error_code:'peer-backup/governance-review-required'}
    default:return {}
  }
}

async function schemaEvidence(tx:PoolClient,packageData:GovernanceRebuildPackage,migrationsDirectory:string){
  await verifyGovernanceRebuildSchema(tx)
  const migrations=(await tx.query<{version:number;name:string;checksum:string}>('SELECT version,name,checksum FROM harness.schema_migrations ORDER BY version')).rows
  const source=packageData.manifest.schemaMigrations
  if(migrations.at(-1)?.version!==GOVERNANCE_REBUILD_SCHEMA_VERSION||source.length>migrations.length||source.some((row,index)=>
    row.version!==migrations[index]!.version||row.checksum!==migrations[index]!.checksum))fail('schema-mismatch')
  const files=await readdir(migrationsDirectory),definitions:string[]=[]
  for(const migration of migrations){
    if(!files.includes(migration.name)||!/^\d+_[a-z0-9_]+\.sql$/u.test(migration.name))fail('schema-mismatch')
    const sql=await readFile(join(migrationsDirectory,migration.name),'utf8')
    if(sha(sql)!==migration.checksum)fail('schema-mismatch')
    definitions.push(sql)
  }
  const triggers=(await tx.query<Trigger>(`SELECT c.relname table_name,t.tgname name,t.tgenabled enabled,pg_get_triggerdef(t.oid) definition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='harness' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`)).rows
  const known=definitions.join('\n')
  for(const trigger of triggers){
    if(!Object.hasOwn(governanceRebuildTables,trigger.table_name)||!['O','D'].includes(trigger.enabled))fail('schema-unreviewed')
    // Dynamically generated immutable triggers use a fixed suffix list in this owned migration.
    const literal=new RegExp('CREATE\\s+(?:CONSTRAINT\\s+)?TRIGGER\\s+'+trigger.name+'\\b','iu').test(known)
    if(!literal&&!/^immutable_governance_rebuild_(?:accounts|nodes|runtimes|decisions|reconfiguration|data_bindings|execution_holds|execution_reviews|execution_approvals|execution_item_approvals)$/u.test(trigger.name))fail('schema-unreviewed')
  }
  const foreignKeys=(await tx.query<ForeignKey>(`SELECT c.relname table_name,k.conname name,k.condeferrable deferrable,k.condeferred deferred
    FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='harness' AND k.contype='f' ORDER BY c.relname,k.conname`)).rows
  for(const key of foreignKeys)if(!Object.hasOwn(governanceRebuildTables,key.table_name))fail('schema-unreviewed')
  return {triggers,foreignKeys}
}

async function insertRow(tx:PoolClient,table:GovernanceRebuildTable,row:Record<string,unknown>):Promise<void>{
  const names=Object.keys(row).sort()
  if(names.some(name=>!governanceRebuildTables[table].some(column=>column.name===name)))fail('schema-unreviewed')
  await tx.query(`INSERT INTO harness.${identifier(table)}(${names.map(identifier).join(',')}) OVERRIDING SYSTEM VALUE
    SELECT ${names.map(name=>'r.'+identifier(name)).join(',')} FROM jsonb_populate_record(NULL::harness.${identifier(table)},$1::jsonb) r`,[JSON.stringify(row)])
}

/** Offline-only importer. The caller owns a fresh database, private output directory and the verified encrypted point.
 * @param pool - unseeded database containing only packaged migrations.
 * @param packageData - fully verified rebuilding package; its replay is validated again inside the transaction.
 * @param input - new administrator credential and explicit physical isolation acknowledgement.
 * @param migrationsDirectory - installed immutable SQL migration directory.
 * @param signal - cancellation aborts the database transaction before admission can open.
 * @returns immutable operation identity; every non-bootstrap account, node and Runtime remains disabled.
 */
export async function importGovernanceRebuild(pool:Pool,packageData:GovernanceRebuildPackage,input:unknown,migrationsDirectory:string,signal:AbortSignal){
  const request=requestSchema.parse(input),manifest=packageData.manifest
  if(request.targetNodeId===manifest.sourceNodeId)fail('target-identity-required')
  const password=await hashPassword(request.bootstrapPassword)
  return transaction(pool,async tx=>{
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('governance-fresh-rebuild',0))")
    const schema=await schemaEvidence(tx,packageData,migrationsDirectory)
    for(const table of tableNames){
      if(table==='schema_migrations')continue
      await tx.query(`LOCK TABLE harness.${identifier(table)} IN ACCESS EXCLUSIVE MODE`)
      if((await tx.query(`SELECT FROM harness.${identifier(table)} LIMIT 1`)).rowCount)fail('database-not-empty')
    }
    for(const key of schema.foreignKeys)await tx.query(`ALTER TABLE harness.${identifier(key.table_name)} ALTER CONSTRAINT ${identifier(key.name)} DEFERRABLE INITIALLY DEFERRED`)
    await tx.query('SET CONSTRAINTS ALL DEFERRED')
    for(const trigger of schema.triggers)if(trigger.enabled==='O')await tx.query(`ALTER TABLE harness.${identifier(trigger.table_name)} DISABLE TRIGGER ${identifier(trigger.name)}`)
    const ports=new Map<string,number>(),configuration:GovernanceRebuildRecord[]=[]
    const accounts=new Map<string,Record<string,unknown>>(),memberships=new Map<string,Record<string,unknown>>(),nodes:Record<string,unknown>[]=[],passwords=new Set<string>()
    let sourceRevision:string|undefined,epoch=1n
    for await(const record of packageData.records()){
      signal.throwIfAborted()
      if(record.table==='users')accounts.set(String(record.row.id),record.row)
      if(record.table==='memberships')memberships.set(String(record.row.user_id),record.row)
      if(record.table==='password_credentials')passwords.add(String(record.row.user_id))
      if(record.table==='compute_nodes')nodes.push(record.row)
      if(record.table==='deployment_topology')sourceRevision=String(record.row.revision)
      if(record.table==='governance_rebuild_operations')epoch=BigInt(String(record.row.recovery_epoch))>=epoch?BigInt(String(record.row.recovery_epoch))+1n:epoch
      if(deferredConfiguration.has(record.table)){configuration.push(record);continue}
      if(reviewedGrants.has(record.table))configuration.push(record)
      await insertRow(tx,record.table,{...record.row,...governanceRebuildDefaults(record,ports,manifest.schemaMigrations.at(-1)!.version)})
    }
    const admin=accounts.get(request.bootstrapUserId),membership=memberships.get(request.bootstrapUserId)
    if(!admin||admin.deleted_at!==null||admin.status!=='active'||membership?.role!=='admin'||membership.status!=='active'||!sourceRevision)fail('bootstrap-admin-required')
    if(nodes.some(node=>node.id===request.targetNodeId))fail('target-identity-required')
    const org=manifest.organizationId,operation=request.operationId
    // A source that has never entered maintenance can omit its control row.
    await tx.query(`INSERT INTO harness.cluster_control(organization_id,mode,maintenance_epoch,write_epoch,reason,actor_user_id,entered_at)
      VALUES($1,'restoring',1,2,'Governance disaster review',$2,clock_timestamp()) ON CONFLICT (organization_id) DO NOTHING`,
    [org,request.bootstrapUserId])
    await tx.query(`INSERT INTO harness.compute_nodes(id,organization_id,name,status) VALUES($1,$2,$3,'active')`,[request.targetNodeId,org,request.targetNodeName])
    await tx.query(`INSERT INTO harness.governance_rebuild_operations(id,organization_id,source_node_id,target_node_id,point_id,manifest_digest,schema_digest,
      source_watermark,source_topology_revision,recovery_epoch,bootstrap_user_id,isolation_method,evidence_reference,unrestored_domains)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[operation,org,manifest.sourceNodeId,request.targetNodeId,request.pointId,
      sha(JSON.stringify(manifest)),manifest.schemaDigest,manifest.watermark,sourceRevision,epoch.toString(),request.bootstrapUserId,
      request.isolationMethod,request.evidenceReference,JSON.stringify(manifest.unrestoredDomains)])
    for(const [id,user] of accounts){
      const member=memberships.get(id)
      if(!member)fail('account-membership-missing')
      await tx.query(`INSERT INTO harness.governance_rebuild_accounts(operation_id,organization_id,user_id,source_role,source_user_status,
        source_member_status,source_deleted_at,source_password_available) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [operation,org,id,member.role,user.status,member.status,user.deleted_at,passwords.has(id)])
    }
    for(const node of nodes)await tx.query(`INSERT INTO harness.governance_rebuild_nodes(operation_id,organization_id,node_id,source_status) VALUES($1,$2,$3,$4)`,
      [operation,org,node.id,node.status])
    for(const record of configuration){
      await tx.query(`INSERT INTO harness.governance_rebuild_reconfiguration(operation_id,table_name,record_digest,safe_record) VALUES($1,$2,$3,$4)`,
      [operation,record.table,governanceRebuildRecordDigest(record.row),JSON.stringify(record.row)])
    }
    await tx.query(`INSERT INTO harness.governance_rebuild_runtimes(id,operation_id,organization_id,runtime_id,node_id,owner_kind,owner_id,source_generation,writer_epoch,volume_id)
      SELECT gen_random_uuid(),$1,e.organization_id,e.id,e.node_id,e.owner_kind,e.owner_id,i.generation,
        CASE WHEN e.owner_kind='project' THEN p.writer_epoch ELSE i.generation END,p.volume_id
      FROM harness.runtime_environments e JOIN harness.instances i ON i.runtime_id=e.id AND i.organization_id=e.organization_id
      LEFT JOIN harness.project_content_placement p ON p.organization_id=e.organization_id AND p.runtime_id=e.id
      WHERE e.organization_id=$2 AND e.retired_at IS NULL`,[operation,org])
    await tx.query(`INSERT INTO harness.governance_rebuild_execution_holds(operation_id,organization_id,runtime_id)
      SELECT id,organization_id,runtime_id FROM harness.governance_rebuild_runtimes WHERE operation_id=$1`,[operation])
    await tx.query(`INSERT INTO harness.recovery_source_isolations(operation_id,organization_id,scope_kind,scope_id,runtime_id,source_node_id,source_generation,
      source_epoch,point_id,policy_revision,method,evidence_reference,confirmed_by,confirmed_at,acknowledge_data_loss)
      SELECT id,organization_id,'governance',organization_id,NULL,source_node_id,NULL,NULL,point_id,source_topology_revision,isolation_method,
        evidence_reference,bootstrap_user_id,created_at,true FROM harness.governance_rebuild_operations WHERE id=$1`,[operation])
    await tx.query(`INSERT INTO harness.node_recovery_quarantines(organization_id,node_id,operation_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[org,manifest.sourceNodeId,operation])
    await tx.query(`UPDATE harness.users SET status='active' WHERE id=$1;`,[request.bootstrapUserId])
    await tx.query(`UPDATE harness.memberships SET status='active',role='admin' WHERE organization_id=$1 AND user_id=$2`,[org,request.bootstrapUserId])
    await tx.query(`INSERT INTO harness.password_credentials(user_id,password_hash,password_version,must_change_password) VALUES($1,$2,1,false)
      ON CONFLICT(user_id) DO UPDATE SET password_hash=EXCLUDED.password_hash,password_version=harness.password_credentials.password_version+1,
        must_change_password=false,changed_at=clock_timestamp()`,[request.bootstrapUserId,password])
    await tx.query(`UPDATE harness.organizations SET status='active',access_revision=access_revision+1 WHERE id=$1`,[org])
    // Old streams and credentials cannot survive rebuilding. This closed
    // projection is the new baseline; omitted ephemeral invalidations must not
    // be replayed before the restricted administrator can reconnect nodes.
    await tx.query(`UPDATE harness.compute_nodes n SET access_applied_revision=o.access_revision FROM harness.organizations o
      WHERE n.organization_id=o.id AND o.id=$1`,[org])
    await tx.query(`UPDATE harness.deployment_topology SET primary_node_id=$2 WHERE organization_id=$1`,[org,request.targetNodeId])
    await tx.query('SET CONSTRAINTS ALL IMMEDIATE')
    const identities=(await tx.query<{table_name:string;column_name:string;sequence:string}>(`SELECT c.table_name,c.column_name,
      pg_get_serial_sequence(format('%I.%I',c.table_schema,c.table_name),c.column_name) sequence FROM information_schema.columns c
      WHERE c.table_schema='harness' AND c.is_identity='YES'`)).rows
    for(const column of identities){
      if(!Object.hasOwn(governanceRebuildTables,column.table_name))fail('schema-unreviewed')
      await tx.query(`SELECT setval($1::regclass,coalesce(max(${identifier(column.column_name)}),1),max(${identifier(column.column_name)}) IS NOT NULL)
        FROM harness.${identifier(column.table_name)}`,[column.sequence])
    }
    for(const key of schema.foreignKeys)await tx.query(`ALTER TABLE harness.${identifier(key.table_name)} ALTER CONSTRAINT ${identifier(key.name)} ${key.deferrable?'DEFERRABLE':'NOT DEFERRABLE'} INITIALLY ${key.deferred?'DEFERRED':'IMMEDIATE'}`)
    for(const trigger of schema.triggers)if(trigger.enabled==='O')await tx.query(`ALTER TABLE harness.${identifier(trigger.table_name)} ENABLE TRIGGER ${identifier(trigger.name)}`)
    return {operationId:operation,organizationId:org,targetNodeId:request.targetNodeId,state:'review' as const,revision:'1',unrestoredDomains:manifest.unrestoredDomains}
  },signal)
}
