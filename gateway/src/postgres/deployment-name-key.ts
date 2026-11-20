/** Maintain the entry's project-name equality keys with its existing governance fingerprints. */
import { join, resolve } from 'node:path'
import type { ManagedDataPath } from '@deepseek-ai/dsh-managed-data'
import type { GatewayConfig } from '../config.ts'
import { normalizeManagedRoots, type ManagedSnapshot } from '../managed-files.ts'
import { projectNamePolicy } from '../node-content-project-names.ts'
import { verifyProjectNameKeyring } from '../project-name-keyring.ts'
import { MaintenanceError } from './maintenance-service.ts'
import type { PostgresRuntimeContext } from './runtime-context.ts'

const owner='gateway-project-name-key'
async function required(context:PostgresRuntimeContext,cfg:GatewayConfig):Promise<Record<string,string>>{
  const policy=await projectNamePolicy(context.pool,context.organizationId)
  if(policy && !cfg.projectNameKeyFile) throw new MaintenanceError(409,'project-name-key-not-configured')
  return policy?.fingerprints ?? {}
}
async function verify(file:string,context:PostgresRuntimeContext,fingerprints:Record<string,string>):Promise<void>{
  try {await verifyProjectNameKeyring(file,context.organizationId,context.nodeId,fingerprints)}
  catch(error){throw new MaintenanceError(409,'project-name-key-identity-mismatch',{cause:error})}
}

/** Select configured private key bytes only after checking current and pending name-key identities.
 * @param context - current organization and entry. @param cfg - effective node configuration.
 * @returns one separately owned file, or no file when name governance has never been configured.
 */
export async function deploymentProjectNameKey(context:PostgresRuntimeContext,cfg:GatewayConfig):Promise<ManagedDataPath[]>{
  const fingerprints=await required(context,cfg)
  if(!cfg.projectNameKeyFile)return []
  await verify(cfg.projectNameKeyFile,context,fingerprints)
  return [{owner,kind:'file',path:cfg.projectNameKeyFile}]
}

/** Validate copied key bytes before backup registration or restoring any database row.
 * @param snapshot - authenticated backup membership. @param filesDir - directory of verified snapshot members.
 * @param context - unchanged current governance identity. @param cfg - current configured key location.
 * @returns an incompatible configuration field when the source location differs; identity failures reject.
 */
export async function verifyDeploymentProjectNameKey(snapshot:ManagedSnapshot,filesDir:string,
  context:PostgresRuntimeContext,cfg:GatewayConfig):Promise<string[]>{
  const fingerprints=await required(context,cfg),roots=snapshot.roots.filter(root=>root.owner===owner)
  if(roots.length>1 || roots.some(root=>root.kind!=='file'))throw new MaintenanceError(409,'backup-project-name-key-identity-ambiguous')
  if(!cfg.projectNameKeyFile) return roots.length?['HGW_PROJECT_NAME_KEY_FILE']:[]
  if(roots.length!==1)throw new MaintenanceError(409,'backup-project-name-key-evidence-missing')
  const root=roots[0]!,members=snapshot.files.filter(file=>file.sourcePath===root.path)
  if(members.length!==1)throw new MaintenanceError(409,'backup-project-name-key-evidence-missing')
  await verify(join(filesDir,members[0]!.member),context,fingerprints)
  const current=(await normalizeManagedRoots([{owner,kind:'file',path:resolve(cfg.projectNameKeyFile)}]))[0]!.path
  return root.path===current?[]:['HGW_PROJECT_NAME_KEY_FILE']
}
