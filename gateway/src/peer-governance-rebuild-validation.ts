/** Offline verification of an encrypted governance rebuilding payload; reading a package grants no authority. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat,readFile,realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { z } from 'zod'
import { privateFileState } from './node-private-file.ts'
import { PeerBackupError } from './peer-backup-repository.ts'
import { readProjectNameKeyring,type ProjectNameKeyring } from './project-name-keyring.ts'
import { GOVERNANCE_REBUILD_SCHEMA_VERSION,governanceRebuildInventory,governanceRebuildManifestSchema,
  governanceRebuildSafeColumns,governanceRebuildUnrestoredDomains,
  type GovernanceRebuildLimits,type GovernanceRebuildManifest,type GovernanceRebuildPackage,type GovernanceRebuildRecord,type GovernanceRebuildTable } from './peer-governance-rebuild-manifest.ts'

const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex')
function invalid():never{throw new PeerBackupError(409,'peer-backup/governance-rebuild-invalid')}
const record=z.object({table:z.string(),row:z.record(z.string(),z.unknown())}).strict()
const configurationTables=new Set(['ssh_targets','ssh_target_shares','webhook_endpoints','plugin_states','node_resource_state',
  'project_members','computer_use_permissions','plugin_access_policies','desktop_access_policies','memory_access_policies','ssh_access_policies',
  'terminal_access_policies','steward_access_policies','model_role_access','model_user_access','model_project_access','project_invitations','projects','model_catalog'])
const checksum=z.string().regex(/^[a-f0-9]{64}$/u)
const reviewItem=z.object({
  id:checksum,itemDigest:checksum,kind:z.enum(['plugin','external-connection']),status:z.enum(['suspended','eligible','approved']),
  name:z.string().regex(/^(?:(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?::(?:mcp-[a-f0-9]{12}|SessionStart|UserPromptSubmit|PreToolUse|PostToolUse|Stop|SubagentStart|SubagentStop))?|custom-plugin:[a-f0-9]{12}|cordis:group)$/u),
  artifactSha256:checksum.or(z.literal('')),configurationSha256:checksum,entrySha256:checksum.optional(),dependencyClosure:z.literal(true).optional(),
  reason:z.string().max(512).regex(/^[A-Za-z0-9 _.,:;()'-]+$/u).optional(),
}).strict()
const blocker=z.string().regex(/^(?:(?:peer-backup\/)?[a-z0-9-]{1,100}|Required recovery plugin is unavailable: [a-z0-9-]+)$/u)
function json(text:string):unknown{try{return JSON.parse(text)}catch{return invalid()}}
async function privateMember(directory:string,name:string,maxBytes:number){
  const file=join(directory,name),info=await lstat(file)
  if(await realpath(file)!==file||await privateFileState(file,info,maxBytes)!=='private')invalid()
  return {file,bytes:info.size}
}

/** Validate the row field allowlist independently of SQL defaults and target startup policy.
 * @param raw - one decoded payload row.
 * @param organizationId - organization sealed by the package.
 * @param version - source schema version whose exact fields were reviewed.
 * @returns the known table and its explicitly retained values.
 */
export function parseGovernanceRebuildRecord(raw:unknown,organizationId:string,version=GOVERNANCE_REBUILD_SCHEMA_VERSION):GovernanceRebuildRecord{
  const parsed=record.safeParse(raw)
  const inventory=governanceRebuildInventory(version)
  if(!parsed.success||!inventory||!Object.hasOwn(inventory.tables,parsed.data.table))invalid()
  const table=parsed.data.table as GovernanceRebuildTable,row=parsed.data.row,allowed=governanceRebuildSafeColumns(table,version)
  if(!allowed.length||Object.keys(row).length!==allowed.length||allowed.some(key=>!Object.hasOwn(row,key)))invalid()
  if(allowed.includes('organization_id')&&row.organization_id!==organizationId||table==='organizations'&&row.id!==organizationId)invalid()
  if(table==='desktop_resources'&&(typeof row.resource_key!=='string'||!row.resource_key.startsWith(organizationId+'/')))invalid()
  if((table==='model_usage'||table==='model_registration_events')&&(typeof row.event_id!=='string'||!/^recovered:[a-f0-9]{64}$/u.test(row.event_id)))invalid()
  if(table.endsWith('_execution_reviews')&&!z.array(reviewItem).safeParse(row.items).success)invalid()
  if(Object.hasOwn(row,'blockers')&&!z.array(blocker).safeParse(row.blockers).success)invalid()
  if(Object.hasOwn(row,'suspended_environment_keys')&&!z.array(z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/u)).max(128).safeParse(row.suspended_environment_keys).success)invalid()
  if(configurationTables.has(table))for(const [key,value] of Object.entries(row)){
    if(value===null)continue
    if(['public_id','runtime_public_id','revision','version','project_model_configuration_revision','logical_name_revision'].includes(key)){
      if(typeof value==='number'?!Number.isSafeInteger(value)||value<0:typeof value!=='string'||!/^\d+$/u.test(value))invalid()
    }else if(key==='runtime_kind'){
      if(value!=='user'&&value!=='project')invalid()
    }else if(['enabled','allowed','model_access_default_allowed'].includes(key)){
      if(typeof value!=='boolean')invalid()
    }else if(key==='access_mode'){
      if(value!=='ro'&&value!=='rw')invalid()
    }else if(key==='role'){
      if(value!=='admin'&&value!=='member')invalid()
    }else if(key==='origin'){
      if(value!=='admin'&&value!=='user')invalid()
    }else if(key==='kind'){
      if(value!=='standard'&&value!=='steward')invalid()
    }else if(key==='ui_theme_policy'){
      if(value!=='follow-user'&&value!=='light'&&value!=='dark')invalid()
    }else if(key==='status'){
      if(value!=='active'&&value!=='archived'&&value!=='disabled')invalid()
    }else if(['provider_key','model_key','display_name'].includes(key)&&table==='model_catalog'){
      if(typeof value!=='string'||!value.length||value.length>512||/[\u0000-\u001f\u007f]/u.test(value))invalid()
    }else if(key.endsWith('_at')){
      if(typeof value!=='string'||value.length>40||!Number.isFinite(Date.parse(value)))invalid()
    }else if(!z.uuid().safeParse(value).success)invalid()
  }
  if(table==='governance_rebuild_reconfiguration'){
    if(typeof row.table_name!=='string'||!configurationTables.has(row.table_name))invalid()
    const nested=parseGovernanceRebuildRecord({table:row.table_name,row:row.safe_record},organizationId,version)
    if(row.record_digest!==governanceRebuildRecordDigest(nested.row))invalid()
  }
  return {table,row}
}

/** Digest a retained configuration row using stable field order; only validated primitive management fields are accepted by its caller.
 * @param row - a record already accepted by parseGovernanceRebuildRecord.
 * @returns its canonical SHA-256 for the reconfiguration receipt.
 */
export function governanceRebuildRecordDigest(row:Record<string,unknown>):string{
  return hash(JSON.stringify(Object.fromEntries(Object.keys(row).sort().map(key=>[key,row[key]]))))
}

async function* records(directory:string,manifest:GovernanceRebuildManifest,limits:GovernanceRebuildLimits,signal:AbortSignal):AsyncGenerator<GovernanceRebuildRecord>{
  const member=await privateMember(directory,manifest.records.file,limits.maxBytes)
  if(member.bytes!==manifest.records.bytes||manifest.records.rows>limits.maxRows)invalid()
  const stream=createReadStream(member.file,{signal}),digest=createHash('sha256')
  // The iterator reports read errors; this promise owns descriptor closure during cancellation or early return.
  const closed=finished(stream).then(()=>undefined,()=>undefined)
  let bytes=0,count=0,pending:Buffer=Buffer.alloc(0)
  try{
    for await(const raw of stream){
      const chunk=raw as Buffer;digest.update(chunk);bytes+=chunk.length
      if(bytes>manifest.records.bytes)invalid()
      pending=pending.length?Buffer.concat([pending,chunk]):chunk
      for(let at=pending.indexOf(10);at!==-1;at=pending.indexOf(10)){
        if(at>Math.min(8<<20,limits.maxBytes)||++count>limits.maxRows)invalid()
        const line=pending.subarray(0,at);pending=pending.subarray(at+1)
        yield parseGovernanceRebuildRecord(json(line.toString('utf8')),manifest.organizationId,manifest.schemaMigrations.at(-1)!.version)
      }
      if(pending.length>Math.min(8<<20,limits.maxBytes))invalid()
    }
    if(pending.length||count!==manifest.records.rows||bytes!==manifest.records.bytes||digest.digest('hex')!==manifest.records.sha256)invalid()
  }finally{stream.destroy();await closed}
}

/** Check equality-key material against every retained registered fingerprint; keys are private and confer no runtime or node admission.
 * @param keyring - verified owner-private keyring from this encrypted payload.
 * @param fingerprints - database key identifiers and their registered SHA-256 hexadecimal fingerprints.
 */
export function verifyGovernanceRebuildKeys(keyring:ProjectNameKeyring|undefined,fingerprints:ReadonlyMap<string,string>):void{
  if(!fingerprints.size)return
  if(!keyring)invalid()
  for(const [id,expected] of fingerprints){
    if(!Object.hasOwn(keyring.keys,id)||!(/^[a-f0-9]{64}$/u).test(expected))invalid()
    const key=Buffer.from(keyring.keys[id]!,'base64')
    try{if(key.length!==32||key.toString('base64')!==keyring.keys[id]||hash(key)!==expected)invalid()}finally{key.fill(0)}
  }
}

/** Read a complete governance rebuilding package without applying any account, credential, ownership or process state.
 * @param directory - private payload already decrypted by the approved recovery tool.
 * @param limits - configured total payload bytes and row allowance.
 * @param signal - cancellation of verification and any subsequent row replay.
 * @returns verified metadata, a digest-checked row iterator and private project equality keys, if registered.
 */
export async function readGovernanceRebuildPackage(directory:string,limits:GovernanceRebuildLimits,signal:AbortSignal):Promise<GovernanceRebuildPackage>{
  signal.throwIfAborted()
  if(await realpath(directory)!==directory)invalid()
  const file=await privateMember(directory,'governance-rebuild.json',Math.min(1<<20,limits.maxBytes))
  const parsed=governanceRebuildManifestSchema.safeParse(json(await readFile(file.file,'utf8')))
  if(!parsed.success)invalid()
  const manifest=parsed.data
  const inventory=governanceRebuildInventory(manifest.schemaMigrations.at(-1)!.version)
  if(!inventory||manifest.schemaDigest!==inventory.digest||JSON.stringify(manifest.dispositions)!==JSON.stringify(inventory.dispositions)||
    JSON.stringify(manifest.unrestoredDomains)!==JSON.stringify(governanceRebuildUnrestoredDomains)||
    manifest.schemaMigrations.some((row,index)=>index>0&&row.version<=manifest.schemaMigrations[index-1]!.version)||
    file.bytes+manifest.records.bytes+manifest.files.reduce((sum,row)=>sum+row.bytes,0)>limits.maxBytes)invalid()
  let keyring:ProjectNameKeyring|undefined
  for(const item of manifest.files){
    const member=await privateMember(directory,item.file,item.bytes),bytes=await readFile(member.file)
    try{if(member.bytes!==item.bytes||hash(bytes)!==item.sha256)invalid()}finally{bytes.fill(0)}
    keyring=await readProjectNameKeyring(member.file,manifest.organizationId,manifest.sourceNodeId)
  }
  const fingerprints=new Map<string,string>(),users=new Set<string>(),projects=new Set<string>(),models=new Set<string>(),reviews=new Set<string>(),rebuilds=new Set<string>()
  const references:Array<{table:GovernanceRebuildTable;id:string}>=[]
  let organizations=0,topologies=0
  for await(const {table,row} of records(directory,manifest,limits,signal)){
    if(table==='organizations')organizations++
    if(table==='deployment_topology'){
      topologies++
      if(row.primary_node_id!==manifest.sourceNodeId||row.enabled!==true)invalid()
    }
    if(table==='users')users.add(z.uuid().parse(row.id))
    if(table==='projects')projects.add(z.uuid().parse(row.id))
    if(table==='model_catalog')models.add(z.uuid().parse(row.id))
    if(table==='project_source_retirement_reviews')reviews.add(z.uuid().parse(row.id))
    if(table==='governance_rebuild_operations')rebuilds.add(z.uuid().parse(row.id))
    if(table==='project_name_keys'){
      if(typeof row.key_id!=='string'||typeof row.fingerprint!=='string'||fingerprints.has(row.key_id))invalid()
      fingerprints.set(row.key_id,row.fingerprint)
    }
    if(['password_credentials','user_quotas','model_usage_alerts','project_quotas','project_usage_alerts','model_prices','project_source_retirement_evidence','governance_rebuild_reconfiguration'].includes(table))
      references.push({table,id:z.uuid().parse(row.user_id??row.project_id??row.model_id??row.review_id??row.operation_id)})
  }
  if(organizations!==1||topologies!==1)invalid()
  for(const {table,id} of references){
    const owners=table==='model_prices'?models:table==='project_source_retirement_evidence'?reviews:table==='governance_rebuild_reconfiguration'?rebuilds:table==='project_quotas'||table==='project_usage_alerts'?projects:users
    if(!owners.has(id))invalid()
  }
  verifyGovernanceRebuildKeys(keyring,fingerprints)
  return {manifest,records:()=>records(directory,manifest,limits,signal),...(keyring?{keyring}:{})}
}
