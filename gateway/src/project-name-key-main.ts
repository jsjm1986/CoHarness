/** Provision a private keyring generation on the current authoritative entry. */
import { createPostgresPool, databaseUrlFromFile } from './postgres/database.ts'
import { createProjectNameKeyring } from './project-name-keyring.ts'
import { resolvePostgresRuntimeContext } from './postgres/runtime-context.ts'
import { loadManagedNodeEnvironment } from './node-config-store.ts'
import { loadConfig } from './config.ts'
import { PostgresDeploymentTopology } from './deployment-topology.ts'
import { resolve } from 'node:path'

async function main():Promise<void>{
  const [keyId,file,previous,...extra]=process.argv.slice(2)
  if (!keyId || !file || extra.length) throw new Error('Expected a public key ID, new output path, and optional preceding keyring path.')
  const env=await loadManagedNodeEnvironment(process.env),cfg=loadConfig(env)
  const pool=createPostgresPool(await databaseUrlFromFile(env))
  try {
    const ctx=await resolvePostgresRuntimeContext(pool,cfg.organizationSlug,cfg.computeNodeName)
    const topology=await new PostgresDeploymentTopology(ctx,{legacyForwarding:cfg.nodeService.forwarding,
      refreshAfterMs:cfg.deploymentContextRefreshMs,pageSize:cfg.runtimeCatalog.pageSize,maxBytes:cfg.runtimeCatalog.maxBytes,allowedOrigins:cfg.publicOrigins}).read()
    if (topology.legacyMigrationRequired || topology.role==='computer' || topology.entry.nodeId!==ctx.nodeId || topology.mode==='multi' && topology.primary?.nodeId!==ctx.nodeId) throw new Error('This is not the authoritative entry.')
    await createProjectNameKeyring({organizationId:ctx.organizationId,nodeId:ctx.nodeId,keyId,file,...(previous?{previous}:{})})
    process.stdout.write(JSON.stringify({organizationId:ctx.organizationId,nodeId:ctx.nodeId,keyId,created:true})+'\n')
  } finally { await pool.end() }
}
if (process.argv[1] && resolve(process.argv[1])===import.meta.filename) {
  void main().catch(()=>{ console.error('Keyring creation failed. Check the entry, private directory, key identifier and unused output path.'); process.exitCode=1 })
}
