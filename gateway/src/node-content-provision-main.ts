/** Explicit node-local content database provisioning command. No database secret is accepted in argv. */
import { resolve } from 'node:path'
import { loadConfig } from './config.ts'
import { loadManagedNodeEnvironment } from './node-config-store.ts'
import { readNodeContentDatabaseUrl } from './node-content-credentials.ts'
import { createPostgresPool, databaseUrlFromFile } from './postgres/database.ts'
import { resolvePostgresRuntimeContext } from './postgres/runtime-context.ts'
import { migrateNodeContent } from './node-content-migrations.ts'
import { NodeContentStore } from './node-content-store.ts'

async function main(): Promise<void> {
  const env=await loadManagedNodeEnvironment(process.env),cfg=loadConfig(env)
  if (!cfg.nodeContent) throw new Error('The node content volume is not configured.')
  const control = createPostgresPool(await databaseUrlFromFile(env))
  const application = createPostgresPool(await readNodeContentDatabaseUrl(cfg.nodeContent.databaseUrlFile))
  const migrationFile = env.HGW_NODE_CONTENT_MIGRATION_URL_FILE
  const admin = migrationFile === undefined ? application : createPostgresPool(await readNodeContentDatabaseUrl(migrationFile))
  try {
    const context = await resolvePostgresRuntimeContext(control, cfg.organizationSlug,cfg.computeNodeName)
    const configuration = { organizationId: context.organizationId, nodeId: context.nodeId, volumeId:cfg.nodeContent.volumeId,
      dataDirectory:cfg.nodeContent.dataDirectory,proofTimeoutMs:cfg.runtimeRequestTimeoutMs }
    const role = (await application.query<{ role: string }>('SELECT current_user role')).rows[0]!.role
    const version = await migrateNodeContent({ ...configuration, pool: admin }, resolve(import.meta.dirname,'../deploy/node-content/migrations'), role)
    const store = await NodeContentStore.open({ ...configuration, pool: application })
    await store.registerVolume(control)
    process.stdout.write(JSON.stringify({ version, nodeId: context.nodeId, volumeId: configuration.volumeId, verified: true }) + '\n')
  } finally { await Promise.all([control.end(),application.end(),...admin === application ? [] : [admin.end()]]) }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
  void main().catch(error => { console.error('Node content provisioning failed', { error: error instanceof Error ? error.name : 'unknown' }); process.exitCode = 1 })
}
