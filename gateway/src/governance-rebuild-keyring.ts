/** Rebind unchanged project-name equality keys only after an immutable governance-loss isolation receipt exists. */
import { createHash,randomUUID } from 'node:crypto'
import { link,lstat,open,realpath,rm } from 'node:fs/promises'
import { dirname,isAbsolute,join } from 'node:path'
import type { Queryable } from './postgres/database.ts'
import type { GovernanceRebuildPackage } from './peer-governance-rebuild-manifest.ts'
import { verifyGovernanceRebuildKeys } from './peer-governance-rebuild-validation.ts'
import { PeerBackupError } from './peer-backup-repository.ts'
import { privateDirectoryState,privateFileState,syncStateDirectory } from './node-private-file.ts'
import { readProjectNameKeyring } from './project-name-keyring.ts'

/** Publish one private file with the original key material and the explicitly approved replacement identity.
 * @param database - already imported, still-closed governance database.
 * @param packageData - verified original package and its private key material.
 * @param operationId - immutable rebuilding receipt created by the offline importer.
 * @param file - canonical destination supplied by the local administrator, never by an HTTP request.
 */
export async function installGovernanceRebuildKeyring(database:Queryable,packageData:GovernanceRebuildPackage,operationId:string,file:string):Promise<void>{
  const manifest=packageData.manifest
  const operation=(await database.query<{target:string}>(`SELECT target_node_id target FROM harness.governance_rebuild_operations
    WHERE id=$1 AND organization_id=$2 AND source_node_id=$3 AND manifest_digest=$4 AND state='review'
      AND harness.node_physically_isolated(organization_id,source_node_id)`,[operationId,manifest.organizationId,manifest.sourceNodeId,
    createHash('sha256').update(JSON.stringify(manifest)).digest('hex')])).rows[0]
  if(!operation)throw new PeerBackupError(409,'peer-backup/governance-keyring-proof-required')
  const fingerprints=new Map((await database.query<{key_id:string;fingerprint:string}>(
    'SELECT key_id,fingerprint FROM harness.project_name_keys WHERE organization_id=$1',[manifest.organizationId])).rows.map(row=>[row.key_id,row.fingerprint]))
  verifyGovernanceRebuildKeys(packageData.keyring,fingerprints)
  if(!packageData.keyring){if(fingerprints.size)throw new PeerBackupError(409,'peer-backup/governance-name-keys-required');return}
  const parent=dirname(file)
  if(!isAbsolute(file)||await realpath(parent)!==parent||await privateDirectoryState(parent,await lstat(parent))!=='private')
    throw new PeerBackupError(409,'peer-backup/governance-keyring-private-path-required')
  const rebound={...packageData.keyring,ownerNodeId:operation.target},bytes=Buffer.from(JSON.stringify(rebound)+'\n'),temporary=join(parent,'.governance-keyring-'+randomUUID())
  try{
    const handle=await open(temporary,'wx',0o600)
    try{
      if(await privateFileState(temporary,await handle.stat(),16384)!=='private')throw new PeerBackupError(409,'peer-backup/governance-keyring-private-path-required')
      await handle.writeFile(bytes);await handle.sync()
    }finally{await handle.close()}
    try{await link(temporary,file)}catch(error){
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error
      const existing=await readProjectNameKeyring(file,manifest.organizationId,operation.target)
      if(JSON.stringify(existing)!==JSON.stringify(rebound))throw new PeerBackupError(409,'peer-backup/governance-keyring-destination-occupied')
    }
    await syncStateDirectory(parent)
  }finally{bytes.fill(0);await rm(temporary,{force:true})}
}
