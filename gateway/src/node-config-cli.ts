/** Independent node-configuration application and local recovery; also the installed applier service entry. */
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { loadConfig } from './config.ts'
import { applyNodeConfiguration, recoverNodeConfiguration } from './node-config-applier.ts'
import { createNodeConfigurationHost, nodeSettingsEnvironment } from './node-config-host.ts'
import { loadManagedNodeEnvironment, nodeConfigurationFile, readNodeConfiguration } from './node-config-store.ts'
import { createPostgresPool, databaseUrlFromFile } from './postgres/database.ts'
import { acquireDeploymentDataLock } from './postgres/deployment-lock.ts'
import { resolvePostgresRuntimeContext } from './postgres/runtime-context.ts'

/**
 * Run only declared settings/recovery actions with the launcher's environment.
 * @param args - status, port, apply, recover, or watch; no executable or destination path arguments.
 * @param environment - stable host configuration inherited from the installed service.
 * @returns after one operation; watch remains alive until signalled.
 */
export async function runNodeConfigurationCommand(args: string[], environment: NodeJS.ProcessEnv): Promise<void> {
  if (args.length !== 1 || !['status', 'port', 'apply', 'recover', 'watch'].includes(args[0]!)) throw new Error('usage: node-config <status|port|apply|recover|watch>')
  const verb = args[0]!, file = nodeConfigurationFile(environment)
  if (verb === 'port') {
    console.log(loadConfig(await loadManagedNodeEnvironment(environment)).port)
    return
  }
  if (verb === 'status') {
    const record = await readNodeConfiguration(file, environment)
    console.log(JSON.stringify(record === undefined ? { status: 'not-initialized', file }
      : { nodeId: record.nodeId, organizationId: record.organizationId, revision: record.revision,
        appliedRevision: record.appliedRevision, operation: record.operation, file }))
    return
  }
  async function perform(): Promise<void> {
    const record = await readNodeConfiguration(file, environment)
    if (verb !== 'recover' && record?.operation?.status !== 'pending' && record?.operation?.status !== 'applying') return
    const effective = verb === 'recover' && record?.previous !== null && record?.previous !== undefined
      ? nodeSettingsEnvironment(environment, record.previous.values) : await loadManagedNodeEnvironment(environment)
    const cfg = loadConfig(effective), pool = createPostgresPool(await databaseUrlFromFile(effective), { max: 3 })
    try {
      const context = await resolvePostgresRuntimeContext(pool, cfg.organizationSlug, cfg.computeNodeName)
      await using lease = await acquireDeploymentDataLock(pool)
      const host = createNodeConfigurationHost(environment, context, lease.signal)
      const run = () => verb === 'recover' ? recoverNodeConfiguration(file, environment, host)
        : applyNodeConfiguration(file, environment, host)
      // The macOS release controller creates the same .activation.lock path exclusively.
      const result = cfg.releaseRoot === undefined ? await run()
        : await withFileLock(join(dirname(cfg.releaseRoot), '.activation'), run, { waitMs: 0 })
      if (result !== undefined) {
        console.log(JSON.stringify({ nodeId: result.nodeId, appliedRevision: result.appliedRevision, operation: result.operation }))
        if (verb !== 'watch' && result.operation?.status === 'failed') process.exitCode = 1
      }
    } finally { await pool.end() }
  }
  if (verb !== 'watch') { await perform(); return }
  const milliseconds = Number(environment.HGW_CONFIG_APPLIER_POLL_MS ?? '5000')
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1000 || milliseconds > 60_000) throw new Error('HGW_CONFIG_APPLIER_POLL_MS must be 1000–60000')
  const lifetime = new AbortController()
  const stop = () => { lifetime.abort() }
  process.once('SIGTERM', stop); process.once('SIGINT', stop)
  try {
    while (!lifetime.signal.aborted) {
      try { await perform() } catch (error) {
        // No connection strings, process argv or external stderr are included in watcher diagnostics.
        console.error(`[node-config] operation unavailable (${error instanceof Error ? error.name : 'Error'}); inspect node-config status and the local service`)
      }
      await delay(milliseconds, undefined, { signal: lifetime.signal }).catch((error: unknown) => { if (!lifetime.signal.aborted) throw error })
    }
  } finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop) }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runNodeConfigurationCommand(process.argv.slice(2), process.env).catch(error => {
    console.error(error instanceof Error ? error.message : 'node-configuration-command-failed')
    process.exitCode = 1
  })
}
