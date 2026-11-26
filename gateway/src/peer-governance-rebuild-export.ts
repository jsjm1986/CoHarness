/** Source-owned, bounded governance rebuilding export. Business fields and obsolete admission credentials never enter this payload. */
import { createHash } from 'node:crypto'
import { mkdir,open } from 'node:fs/promises'
import { join } from 'node:path'
import type { Pool } from 'pg'
import { transaction,type Queryable } from './postgres/database.ts'
import { readProjectNameKeyring } from './project-name-keyring.ts'
import { PeerBackupError } from './peer-backup-repository.ts'
import type { PeerBackupBinding,PeerBackupExporter,PeerCapture } from './peer-backup-restic.ts'
import { GOVERNANCE_REBUILD_SCHEMA_VERSION,governanceRebuildDispositions,governanceRebuildManifestSchema,governanceRebuildSafeColumns,
  governanceRebuildSchemaDigest,governanceRebuildTables,governanceRebuildUnrestoredDomains,
  type GovernanceRebuildLimits,type GovernanceRebuildManifest,type GovernanceRebuildTable } from './peer-governance-rebuild-manifest.ts'
import { parseGovernanceRebuildRecord,readGovernanceRebuildPackage,verifyGovernanceRebuildKeys } from './peer-governance-rebuild-validation.ts'
import { writePeerSourceFile, type PeerSourceWrites } from './peer-backup-source-space.ts'

const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex')
const tables=Object.keys(governanceRebuildTables) as GovernanceRebuildTable[]
function invalid():never{throw new PeerBackupError(409,'peer-backup/governance-schema-unreviewed')}
function budget():never{throw new PeerBackupError(507,'peer-backup/export-budget')}

/** Prove every persisted table and column has a reviewed disposition before copying any source data.
 * @param db - source read-only repeatable-read transaction.
 * @returns actual PostgreSQL types for explicit precision-preserving value projection.
 */
export async function verifyGovernanceRebuildSchema(db:Queryable):Promise<Map<string,string>>{
  const actual=(await db.query<{table_name:string;column_name:string;udt_name:string}>(`SELECT c.table_name,c.column_name,c.udt_name FROM information_schema.columns c
    JOIN information_schema.tables t USING(table_catalog,table_schema,table_name)
    WHERE c.table_schema='harness' AND t.table_type='BASE TABLE' ORDER BY c.table_name,c.column_name`)).rows
  actual.sort((a,b)=>(a.table_name+'.'+a.column_name)<(b.table_name+'.'+b.column_name)?-1:(a.table_name+'.'+a.column_name)>(b.table_name+'.'+b.column_name)?1:0)
  const expected=governanceRebuildDispositions.flatMap(row=>row.columns.map(column=>row.table+'.'+column.name)).sort()
  if(actual.length!==expected.length||actual.some((row,index)=>row.table_name+'.'+row.column_name!==expected[index]))invalid()
  return new Map(actual.map(row=>[row.table_name+'.'+row.column_name,row.udt_name]))
}

function scope(table:GovernanceRebuildTable):{join:string;where:string}{
  if(table==='organizations')return {join:'',where:'t.id=$1'}
  if(table==='desktop_resources')return {join:'',where:"left(t.resource_key,length($1::text)+1)=$1::text||'/'"}
  const owner=table==='password_credentials'||table==='user_quotas'||table==='model_usage_alerts'?['users','user_id']:
    table==='project_quotas'||table==='project_usage_alerts'?['projects','project_id']:
    table==='model_prices'?['model_catalog','model_id']:
    table==='project_source_retirement_evidence'?['project_source_retirement_reviews','review_id']:
    table==='governance_rebuild_reconfiguration'?['governance_rebuild_operations','operation_id']:undefined
  return owner?{join:` JOIN harness.${owner[0]} owner ON owner.id=t.${owner[1]}`,where:'owner.organization_id=$1'}:{join:'',where:'t.organization_id=$1'}
}
function projection(table:GovernanceRebuildTable,column:string,type:string|undefined):string{
  if((table==='model_usage'||table==='model_registration_events')&&column==='event_id')
    return `('recovered:'||encode(sha256(convert_to(t.event_id,'UTF8')),'hex')) AS event_id`
  return `t.${column}${type==='int8'||type==='numeric'||type==='bytea'?'::text':''} AS ${column}`
}

/** A complete rebuilding package restores management identities and evidence; its importer separately closes all account and execution admission. */
export class PeerGovernanceRebuildExporter implements PeerBackupExporter {
  constructor(private readonly control:Pool,private readonly limits:GovernanceRebuildLimits,private readonly projectNameKeyFile?:string){}
  async capture(binding:PeerBackupBinding,directory:string,signal:AbortSignal,space?:PeerSourceWrites):Promise<PeerCapture>{
    if(binding.scopeId!==binding.organizationId)throw new PeerBackupError(409,'peer-backup/cross-scope-row')
    return transaction(this.control,async db=>{
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const types=await verifyGovernanceRebuildSchema(db)
      const migrations=(await db.query<{version:number;checksum:string}>('SELECT version,checksum FROM harness.schema_migrations ORDER BY version')).rows
      if(migrations.at(-1)?.version!==GOVERNANCE_REBUILD_SCHEMA_VERSION)invalid()
      const coordinate=(await db.query<{revision:string;watermark:string;time:Date}>(`SELECT t.revision::text,
        pg_snapshot_xmax(pg_current_snapshot())::text watermark,transaction_timestamp() time FROM harness.deployment_topology t
        JOIN harness.organizations o ON o.id=t.organization_id WHERE t.organization_id=$1 AND t.primary_node_id=$2 AND t.enabled AND t.revision>0 AND o.status='active'`,
      [binding.organizationId,binding.sourceNodeId])).rows[0]
      if(!coordinate)throw new PeerBackupError(409,'peer-backup/space-placement-changed')
      const create=()=>open(join(directory,'governance-rebuild.jsonl'),'wx',0o600)
      const output=space?await space.write(directory,0,create):await create(),digest=createHash('sha256'),fingerprints=new Map<string,string>()
      let rows=0,bytes=0
      try{
        for(const table of tables){
          const columns=governanceRebuildSafeColumns(table)
          if(!columns.length)continue
          const owned=scope(table),select=columns.map(column=>projection(table,column,types.get(table+'.'+column))).join(',')
          await db.query(`DECLARE governance_rebuild NO SCROLL CURSOR FOR SELECT CASE WHEN octet_length(row_to_json(r)::text)<=$2
            THEN row_to_json(r)::text END AS body FROM (SELECT ${select} FROM harness.${table} t${owned.join} WHERE ${owned.where} ORDER BY t.ctid) r`,
          [binding.organizationId,Math.min(8<<20,this.limits.maxBytes)])
          for(;;){
            signal.throwIfAborted()
            const result=await db.query<{body:string|null}>('FETCH FORWARD 8 FROM governance_rebuild')
            if(!result.rowCount)break
            for(const {body} of result.rows){
              if(body===null)budget()
              const parsed=parseGovernanceRebuildRecord({table,row:JSON.parse(body)},binding.organizationId)
              if(table==='project_name_keys')fingerprints.set(String(parsed.row.key_id),String(parsed.row.fingerprint))
              const line=JSON.stringify(parsed)+'\n'
              bytes+=Buffer.byteLength(line)
              if(++rows>this.limits.maxRows||bytes>this.limits.maxBytes)budget()
              if(space)await space.write(directory,Buffer.byteLength(line),()=>output.writeFile(line))
              else await output.writeFile(line)
              digest.update(line)
            }
          }
          await db.query('CLOSE governance_rebuild')
        }
        await output.sync()
      }finally{await output.close()}
      const files:GovernanceRebuildManifest['files']=[]
      if(fingerprints.size){
        if(!this.projectNameKeyFile)throw new PeerBackupError(409,'peer-backup/governance-name-keys-required')
        const ring=await readProjectNameKeyring(this.projectNameKeyFile,binding.organizationId,binding.sourceNodeId)
        verifyGovernanceRebuildKeys(ring,fingerprints)
        const encoded=Buffer.from(JSON.stringify(ring)+'\n')
        try{
          if(encoded.length>16384||bytes+encoded.length>this.limits.maxBytes)budget()
          const create=()=>mkdir(join(directory,'governance-private'),{mode:0o700})
          if(space)await space.write(directory,0,create);else await create()
          const file='governance-private/project-name-keyring.json'
          await writePeerSourceFile(join(directory,file),encoded,space)
          files.push({role:'project-name-keyring',file,sha256:hash(encoded),bytes:encoded.length})
        }finally{encoded.fill(0)}
      }
      const manifest=governanceRebuildManifestSchema.parse({format:'governance-rebuild-v1',version:1,organizationId:binding.organizationId,sourceNodeId:binding.sourceNodeId,
        schemaMigrations:migrations,schemaDigest:governanceRebuildSchemaDigest,watermark:coordinate.watermark,capturedAt:coordinate.time.toISOString(),
        records:{file:'governance-rebuild.jsonl',sha256:digest.digest('hex'),rows,bytes},files,
        dispositions:governanceRebuildDispositions,unrestoredDomains:governanceRebuildUnrestoredDomains})
      const text=JSON.stringify(manifest)+'\n'
      if(Buffer.byteLength(text)>1<<20||bytes+Buffer.byteLength(text)+files.reduce((sum,file)=>sum+file.bytes,0)>this.limits.maxBytes)budget()
      await writePeerSourceFile(join(directory,'governance-rebuild.json'),text,space)
      return {version:1,organizationId:binding.organizationId,sourceNodeId:binding.sourceNodeId,scopeId:binding.scopeId,
        writerEpoch:coordinate.revision,watermark:coordinate.watermark,capturedAt:coordinate.time.toISOString(),coveredCount:tables.length,gaps:[]}
    },signal)
  }
  async validate(binding:PeerBackupBinding,capture:PeerCapture,directory:string,signal:AbortSignal):Promise<void>{
    return validateGovernanceRebuild(binding,capture,directory,signal,this.limits)
  }
}

/** Validate an isolated decrypted rebuilding point without requiring a live governance database.
 * @param binding - authenticated source and organization. @param capture - signed capture metadata.
 * @param directory - private restored payload. @param signal - inspection cancellation. @param limits - configured read budgets.
 */
export async function validateGovernanceRebuild(binding:PeerBackupBinding,capture:PeerCapture,directory:string,signal:AbortSignal,limits:GovernanceRebuildLimits):Promise<void>{
    const {manifest,records}=await readGovernanceRebuildPackage(directory,limits,signal)
    if(binding.scopeId!==binding.organizationId||manifest.organizationId!==binding.organizationId||manifest.sourceNodeId!==binding.sourceNodeId||
      capture.scopeId!==binding.scopeId||capture.organizationId!==binding.organizationId||capture.sourceNodeId!==binding.sourceNodeId||
      manifest.watermark!==capture.watermark||manifest.capturedAt!==capture.capturedAt||capture.coveredCount!==manifest.dispositions.length||capture.gaps.length)
      throw new PeerBackupError(409,'peer-backup/governance-rebuild-invalid')
    for await(const row of records())if(row.table==='deployment_topology'&&String(row.row.revision)!==capture.writerEpoch)
      throw new PeerBackupError(409,'peer-backup/governance-rebuild-invalid')
}
