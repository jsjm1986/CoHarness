/** Organization-wide name reservations. Only the primary signs canonical values; nodes receive opaque equality tags. */
import type { Pool,PoolClient } from 'pg'
import { transaction,type Queryable } from './postgres/database.ts'
import { NodeContentUnavailable } from './node-content-store.ts'

export interface ProjectNamePolicy {
  revision:string
  state:'preparing'|'active'
  activeKeyId:string
  nextKeyId:string|null
  fingerprints:Record<string,string>
}
export interface ProjectNameRequest {
  organizationId:string
  nodeId:string
  projectId:string
  actorUserId?:number
  operation:'create'|'rename'|'reindex'
  name:string
}
export interface ProjectNameProof extends Omit<ProjectNameRequest,'name'> {
  policyRevision:string
  tags:Array<{keyId:string;mac:string}>
}
export interface ProjectNameMacAuthority {identify(input:ProjectNameRequest):Promise<ProjectNameProof>}
const policyFailure=()=>new NodeContentUnavailable('Current organization project name verification is unavailable.')
const keyIdPattern=/^[A-Za-z0-9_.-]{1,64}$/u
const hex=/^[a-f0-9]{64}$/u

/** Resolve a primary name proof without holding an organizational connection or project lock while crossing computers.
 * @param pool - organization database. @param authority - trusted signer bound to the requesting browser, if available.
 * @param change - authorized transaction. Its first request for a signature rolls back before any signature is issued; the complete transaction is then revalidated.
 * @returns the committed change. A stale authority or changed name rejects the transaction.
 */
export async function withProjectNameProof<T>(pool:Pool,authority:ProjectNameMacAuthority|undefined,
  change:(tx:PoolClient,identify:(input:ProjectNameRequest)=>ProjectNameProof)=>Promise<T>):Promise<T>{
  const needsSignature=new Error('Project name authority required.')
  let request:ProjectNameRequest|undefined
  try {
    return await transaction(pool,tx=>change(tx,input=>{request=input;throw needsSignature}))
  }catch(error){
    if(error!==needsSignature || !request)throw error
    if(!authority)throw new NodeContentUnavailable('Project name verification from the primary entry is required.')
    const expected=request,proof=await authority.identify(expected)
    return transaction(pool,async tx=>{
      let used=false
      const result=await change(tx,input=>{
        if(used||input.organizationId!==expected.organizationId||input.projectId!==expected.projectId||input.nodeId!==expected.nodeId||
          input.operation!==expected.operation||input.actorUserId!==expected.actorUserId||input.name!==expected.name) {
          throw new NodeContentUnavailable('The selected project name changed; verify the current name again.')
        }
        used=true
        return proof
      })
      if(!used)throw new NodeContentUnavailable('The project name policy changed; read its current state and retry.')
      return result
    })
  }
}

/** @param db - organization control database. @param organizationId - authorized organization. @returns current and pending blind-index key fingerprints. */
export async function projectNamePolicy(db:Queryable,organizationId:string):Promise<ProjectNamePolicy|undefined>{
  const row=(await db.query<ProjectNamePolicy & {compatible:boolean}>(`SELECT p.revision::text,p.state,p.active_key "activeKeyId",p.next_key "nextKeyId",
      p.normalization IS NOT DISTINCT FROM harness.project_name_normalization() compatible,
      (SELECT jsonb_object_agg(k.key_id,k.fingerprint) FROM harness.project_name_keys k WHERE k.organization_id=p.organization_id
        AND k.key_id IN(p.active_key,p.next_key)) fingerprints FROM harness.project_name_policies p WHERE organization_id=$1`,[organizationId])).rows[0]
  if (row && !row.compatible) throw policyFailure()
  return row
}

/** Return the byte spelling compared by the organization's existing deterministic default-collation citext index.
 * @param tx - primary Gateway's dedicated control transaction.
 * @param name - normalized project display name from the authenticated request.
 * @returns UTF-8 canonical bytes for the primary's keyed MAC; the caller must never log the input or result.
 */
export async function canonicalProjectName(tx:PoolClient,name:string):Promise<Buffer>{
  // These statements contain no project data. A role without permission to suppress bind logging fails before any name is sent.
  const settings=(await tx.query<{name:string;setting:string}>(`SELECT name,setting FROM pg_settings WHERE name IN
    ('log_parameter_max_length','log_parameter_max_length_on_error','pgaudit.log_parameter','auto_explain.log_parameter_max_length')`)).rows
  for (const parameter of settings) {
    const desired=parameter.name==='pgaudit.log_parameter'?'off':'0'
    if (parameter.setting!==desired) await tx.query('SELECT set_config($1,$2,true)',[parameter.name,desired])
  }
  const protectedSettings=await tx.query(`SELECT 1 WHERE current_setting('log_parameter_max_length')='0' AND current_setting('log_parameter_max_length_on_error')='0'
    AND COALESCE(NULLIF(current_setting('pgaudit.log_parameter',true),''),'off') IN ('off','false','0')
    AND COALESCE(NULLIF(current_setting('auto_explain.log_parameter_max_length',true),''),'0')='0'
    AND harness.project_name_normalization() IS NOT NULL`)
  if (protectedSettings.rowCount!==1) throw policyFailure()
  const row=(await tx.query<{canonical:Buffer}>('SELECT convert_to(lower($1::text COLLATE pg_catalog."default"),\'UTF8\') canonical',[name])).rows[0]
  if (!row) throw policyFailure()
  return row.canonical
}

/** Start the initial backfill or enroll a replacement key without retiring the presently enforcing key.
 * @param tx - administrator's primary-entry transaction.
 * @param input - expected policy revision and fingerprint supplied by the private keyring.
 * @returns the new policy.
 */
export async function prepareProjectNameKey(tx:PoolClient,input:{organizationId:string;expectedRevision:string|null;keyId:string;fingerprint:string}):Promise<ProjectNamePolicy>{
  if (!keyIdPattern.test(input.keyId) || !hex.test(input.fingerprint)) throw policyFailure()
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text,1098311))',[input.organizationId])
  const policy=await projectNamePolicy(tx,input.organizationId)
  if ((policy?.revision??null)!==input.expectedRevision || policy && (policy.state!=='active' || policy.nextKeyId || policy.activeKeyId===input.keyId)) throw policyFailure()
  await tx.query('INSERT INTO harness.project_name_keys(organization_id,key_id,fingerprint) VALUES($1,$2,$3)',[input.organizationId,input.keyId,input.fingerprint])
  if (!policy) await tx.query(`INSERT INTO harness.project_name_policies(organization_id,revision,state,active_key,normalization)
    VALUES($1,1,'preparing',$2,harness.project_name_normalization())`,[input.organizationId,input.keyId])
  else await tx.query('UPDATE harness.project_name_policies SET next_key=$2,revision=revision+1 WHERE organization_id=$1',[input.organizationId,input.keyId])
  return (await projectNamePolicy(tx,input.organizationId))!
}

/** Install all required tags in the same control transaction that creates or renames the actual project.
 * @param tx - authorized target transaction holding the project row lock.
 * @param expected - server-owned request coordinates.
 * @param proof - trusted primary response for those coordinates.
 */
export async function reserveProjectName(tx:PoolClient,expected:ProjectNameRequest,proof:ProjectNameProof):Promise<void>{
  await tx.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1::uuid::text,1098311))',[expected.organizationId])
  const policy=await projectNamePolicy(tx,expected.organizationId)
  if (!policy || proof.organizationId!==expected.organizationId || proof.projectId!==expected.projectId || proof.nodeId!==expected.nodeId
    || proof.actorUserId!==expected.actorUserId || proof.operation!==expected.operation || proof.policyRevision!==policy.revision) throw policyFailure()
  const keys=policy.nextKeyId?[policy.activeKeyId,policy.nextKeyId]:[policy.activeKeyId]
  if (proof.tags.length!==keys.length || keys.some(id=>proof.tags.filter(t=>t.keyId===id&&hex.test(t.mac)).length!==1)) throw policyFailure()
  const project=(await tx.query<{revision:string}>(`SELECT p.logical_name_revision::text revision FROM harness.projects p JOIN harness.project_mounts m
    ON m.organization_id=p.organization_id AND m.project_id=p.id WHERE p.organization_id=$1 AND p.id=$2 AND m.node_id=$3 AND p.status='active' FOR UPDATE OF p`,
  [expected.organizationId,expected.projectId,expected.nodeId])).rows[0]
  if (!project) throw policyFailure()
  for (const tag of proof.tags) {
    await tx.query(`INSERT INTO harness.project_name_claims(organization_id,project_id,node_id,key_id,mac,name_revision)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(organization_id,project_id,key_id) DO UPDATE SET mac=excluded.mac,name_revision=excluded.name_revision
      WHERE project_name_claims.node_id=excluded.node_id`,[expected.organizationId,expected.projectId,expected.nodeId,tag.keyId,Buffer.from(tag.mac,'hex'),project.revision])
  }
}

/** Activate the blind index, or finish rotation, only after every live project holds the new current-revision tag.
 * @param tx - administrator's primary-entry transaction.
 * @param organizationId - current organization.
 * @param expectedRevision - revision displayed to the operator.
 * @returns the serving policy.
 */
export async function activateProjectNameKey(tx:PoolClient,organizationId:string,expectedRevision:string):Promise<ProjectNamePolicy>{
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text,1098311))',[organizationId])
  const policy=await projectNamePolicy(tx,organizationId)
  if (!policy || policy.revision!==expectedRevision || policy.state==='active'&&!policy.nextKeyId) throw policyFailure()
  const primary=policy.nextKeyId??policy.activeKeyId
  const missing=await tx.query(`SELECT FROM harness.projects p WHERE p.organization_id=$1 AND p.status='active' AND NOT EXISTS
    (SELECT FROM harness.project_name_claims c WHERE c.organization_id=p.organization_id AND c.project_id=p.id AND c.key_id=$2
      AND c.name_revision=p.logical_name_revision) LIMIT 1`,[organizationId,primary])
  if (missing.rowCount) throw new NodeContentUnavailable('Some project names have not been indexed with the pending organization key.')
  await tx.query("UPDATE harness.project_name_policies SET state='active',active_key=$2,next_key=NULL,revision=revision+1 WHERE organization_id=$1",[organizationId,primary])
  return (await projectNamePolicy(tx,organizationId))!
}
