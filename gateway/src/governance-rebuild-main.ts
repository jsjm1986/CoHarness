/** Offline governance rebuilding from a verified encrypted-point export; no Gateway or Runtime is launched. */
import { lstat,readFile,realpath } from 'node:fs/promises'
import { isAbsolute,join,resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { createPostgresPool,runMigrations } from './postgres/database.ts'
import { privateFileState } from './node-private-file.ts'
import { PeerBackupError } from './peer-backup-repository.ts'
import { peerCaptureSchema } from './peer-backup-restic.ts'
import { validateGovernanceBackup } from './peer-governance-backup.ts'
import { readGovernanceRebuildPackage } from './peer-governance-rebuild-validation.ts'
import { governanceRebuildTables } from './peer-governance-rebuild-manifest.ts'
import { importGovernanceRebuild } from './governance-rebuild-import.ts'
import { installGovernanceRebuildKeyring } from './governance-rebuild-keyring.ts'

const path=z.string().refine(isAbsolute)
const configuration=z.object({version:z.literal(1),action:z.enum(['import','install-name-keyring']),databaseUrlFile:path,packageDirectory:path,bootstrapPasswordFile:path.optional(),
  projectNameKeyFile:path.optional(),operationId:z.uuid(),targetNodeId:z.uuid(),targetNodeName:z.string().trim().min(1).max(128),
  bootstrapUserId:z.uuid(),isolationMethod:z.enum(['power-off','network-isolation']),evidenceReference:z.string().trim().min(1).max(512),
  acknowledgeDataLoss:z.literal(true),maxBytes:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maxRows:z.number().int().positive().max(100000000),timeoutMs:z.number().int().min(1000).max(86400000)}).strict().superRefine((value,ctx)=>{
  if(value.action==='import'&&!value.bootstrapPasswordFile)ctx.addIssue({code:'custom',message:'Import requires a private new-password file',path:['bootstrapPasswordFile']})
  if(value.action==='install-name-keyring'&&!value.projectNameKeyFile)ctx.addIssue({code:'custom',message:'Key installation requires an explicit destination',path:['projectNameKeyFile']})
})
const checkpointSchema=z.object({version:z.literal(1),pointId:z.uuid(),binding:z.object({organizationId:z.uuid(),scopeId:z.uuid(),
  sourceNodeId:z.uuid(),targetNodeId:z.uuid(),policyId:z.uuid(),revision:z.number().int().positive()}).strict(),capture:peerCaptureSchema}).strict()
async function privateText(file:string,maxBytes:number,signal:AbortSignal):Promise<string>{
  if(resolve(file)!==file||await realpath(file)!==file||await privateFileState(file,await lstat(file),maxBytes,signal)!=='private')
    throw new PeerBackupError(403,'peer-backup/private-configuration-required')
  signal.throwIfAborted();return readFile(file,'utf8')
}

/** Import one private verified point into an empty database and install unchanged name-key material.
 * @param configFile - canonical owner-private configuration; passwords and database URLs are read from separate private files.
 * @param signal - operator lifetime. Failure after import retains a closed review receipt and never enables services.
 * @returns opaque replacement identities suitable for configuring the restricted Admin entry.
 */
export async function rebuildGovernanceOffline(configFile:string,signal:AbortSignal){
  const cfg=configuration.parse(JSON.parse(await privateText(resolve(configFile),16384,signal)))
  const lifetime=AbortSignal.any([signal,AbortSignal.timeout(cfg.timeoutMs)]),limits={maxBytes:cfg.maxBytes,maxRows:cfg.maxRows}
  const checkpoint=checkpointSchema.parse(JSON.parse(await privateText(join(cfg.packageDirectory,'checkpoint.json'),cfg.maxBytes,lifetime)))
  await validateGovernanceBackup(checkpoint.binding,checkpoint.capture,cfg.packageDirectory,lifetime,limits)
  const data=await readGovernanceRebuildPackage(cfg.packageDirectory,limits,lifetime)
  if(data.keyring&&!cfg.projectNameKeyFile)throw new PeerBackupError(409,'peer-backup/governance-name-keys-required')
  const databaseUrl=(await privateText(cfg.databaseUrlFile,16384,lifetime)).trim()
  const password=cfg.action==='import'?(await privateText(cfg.bootstrapPasswordFile!,4096,lifetime)).replace(/\r?\n$/u,''):undefined
  const pool=createPostgresPool(databaseUrl,{max:1}),migrations=resolve(import.meta.dirname,'../deploy/postgres/migrations')
  try{
    if(cfg.action==='install-name-keyring'){
      const receipt=(await pool.query(`SELECT FROM harness.governance_rebuild_operations WHERE id=$1 AND organization_id=$2 AND target_node_id=$3
        AND bootstrap_user_id=$4 AND point_id=$5 AND state='review'`,[cfg.operationId,data.manifest.organizationId,cfg.targetNodeId,cfg.bootstrapUserId,checkpoint.pointId])).rowCount
      if(receipt!==1)throw new PeerBackupError(409,'peer-backup/governance-keyring-proof-required')
      await installGovernanceRebuildKeyring(pool,data,cfg.operationId,cfg.projectNameKeyFile!)
      return {operationId:cfg.operationId,organizationId:data.manifest.organizationId,targetNodeId:cfg.targetNodeId,state:'review' as const,keyring:'installed' as const}
    }
    const tables=(await pool.query<{schema:string;name:string}>(`SELECT n.nspname schema,c.relname name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relkind IN('r','p') AND n.nspname NOT IN('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' ORDER BY n.nspname,c.relname`)).rows
    for(const table of tables){
      if(table.schema!=='harness'||!Object.hasOwn(governanceRebuildTables,table.name)&&table.name!=='schema_migrations')
        throw new PeerBackupError(409,'peer-backup/governance-database-not-empty')
      if(table.name!=='schema_migrations'&&(await pool.query('SELECT FROM harness."'+table.name+'" LIMIT 1')).rowCount)
        throw new PeerBackupError(409,'peer-backup/governance-database-not-empty')
    }
    await runMigrations(pool,migrations)
    const result=await importGovernanceRebuild(pool,data,{operationId:cfg.operationId,pointId:checkpoint.pointId,targetNodeId:cfg.targetNodeId,
      targetNodeName:cfg.targetNodeName,bootstrapUserId:cfg.bootstrapUserId,bootstrapPassword:password,isolationMethod:cfg.isolationMethod,
      evidenceReference:cfg.evidenceReference,acknowledgeDataLoss:cfg.acknowledgeDataLoss},migrations,lifetime)
    if(cfg.projectNameKeyFile)await installGovernanceRebuildKeyring(pool,data,result.operationId,cfg.projectNameKeyFile)
    return result
  }finally{await pool.end()}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    if(process.argv.length!==3||!process.argv[2])throw new PeerBackupError(400,'peer-backup/configuration-file-required')
    process.stdout.write(JSON.stringify(await rebuildGovernanceOffline(process.argv[2],new AbortController().signal))+'\n')
  }catch(error){
    process.stderr.write(JSON.stringify({error:error instanceof PeerBackupError?error.code:error instanceof z.ZodError?'peer-backup/invalid-request':'peer-backup/governance-operation-failed'})+'\n')
    process.exitCode=1
  }
}
