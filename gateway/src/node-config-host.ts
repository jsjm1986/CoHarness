/** Fixed service actions and environmental checks for the independent node configuration applier. */
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { loadConfig } from './config.ts'
import { NODE_CONFIG_FIELDS } from './node-config-fields.ts'
import { NodeConfigurationError, type NodeConfigurationRecord } from './node-config-store.ts'
import type { NodeConfigurationApplyHost } from './node-config-applier.ts'
import { verifyNodeDataRelocation } from './node-config-relocation.ts'
import { createPostgresPool, databaseUrlFromFile } from './postgres/database.ts'
import { PostgresMaintenanceService } from './postgres/maintenance-service.ts'
import { resolvePostgresRuntimeContext, type PostgresRuntimeContext } from './postgres/runtime-context.ts'

const execute = promisify(execFile)

/** Explicit file selection takes precedence over a bootstrap inline URL without copying that secret. */
export function nodeSettingsEnvironment(environment: NodeJS.ProcessEnv, values: NodeConfigurationRecord['applied']): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = { ...environment, ...values }
  if (values.HGW_DATABASE_URL_FILE !== '') delete selected.HGW_DATABASE_URL
  return selected
}

async function pathInfo(path: string) {
  try { return await lstat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function writableDirectory(path: string): Promise<void> {
  let existing = path
  for (;;) {
    const info = await pathInfo(existing)
    if (info !== undefined) {
      if (!info.isDirectory() || info.isSymbolicLink()) throw new NodeConfigurationError(409, `configuration-directory-unavailable:${path}`)
      await access(existing, constants.R_OK | constants.W_OK | constants.X_OK)
      return
    }
    const parent = dirname(existing)
    if (existing === parent) throw new NodeConfigurationError(409, `configuration-directory-unavailable:${path}`)
    existing = parent
  }
}

async function availablePort(port: number): Promise<void> {
  const server = createServer()
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', () => { reject(new NodeConfigurationError(409, `configuration-port-unavailable:${port}`)) })
    server.listen(port, '127.0.0.1', () => { server.close(error => { if (error !== undefined) reject(error); else resolvePromise() }) })
  })
}

/**
 * Bind only the platform's installed Gateway restart action to the node settings.
 * @param environment - bootstrap deployment environment, never values accepted from a Web form.
 * @param context - confirmed current database node; the caller holds its data-operation lease.
 * @param signal - aborts when the independent applier loses that lease.
 * @returns preflight and health-checked service actions.
 */
export function createNodeConfigurationHost(environment: NodeJS.ProcessEnv, context: PostgresRuntimeContext, signal: AbortSignal): NodeConfigurationApplyHost {
  const maintenance = new PostgresMaintenanceService(context, loadConfig(environment).nodeStaleMs)
  const command = process.platform === 'darwin'
    ? ['launchctl', 'kickstart', '-k', `${environment.HGW_LAUNCHD_DOMAIN ?? `gui/${process.getuid?.() ?? 0}`}/${environment.HGW_LAUNCHD_LABEL ?? 'com.maycran.harness-gateway'}`]
    : process.platform === 'linux' ? ['systemctl', 'restart', environment.HGW_GATEWAY_SERVICE ?? 'harness-gateway.service'] : undefined
  if (command === undefined) throw new NodeConfigurationError(409, 'node-configuration-platform-not-supported')
  if (command.some(part => /[\s\u0000-\u001f]/u.test(part))) throw new NodeConfigurationError(400, 'invalid-gateway-service-action')

  async function healthy(record: NodeConfigurationRecord): Promise<boolean> {
    signal.throwIfAborted()
    const cfg = loadConfig(nodeSettingsEnvironment(environment, record.applied))
    try {
      const response = await fetch(`http://127.0.0.1:${cfg.port}/healthz`, { signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) })
      if (!response.ok) return false
      const body: unknown = await response.json()
      return body !== null && typeof body === 'object' && 'ok' in body && body.ok === true
        && 'configurationRevision' in body && body.configurationRevision === record.appliedRevision
        && (cfg.releaseId === undefined || 'release' in body && body.release === cfg.releaseId)
    } catch { signal.throwIfAborted(); return false }
  }

  return {
    signal,
    async preflight(record) {
      signal.throwIfAborted()
      if (record.nodeId !== context.nodeId || record.organizationId !== context.organizationId) throw new NodeConfigurationError(409, 'node-configuration-identity-mismatch')
      const state = await maintenance.state()
      if (record.operation !== null && record.operation.writeEpoch !== state.writeEpoch) throw new NodeConfigurationError(409, 'node-configuration-request-predates-restored-data')
      if (state.mode !== 'maintenance' || !state.writersQuiesced) throw new NodeConfigurationError(409, 'configuration-requires-quiesced-maintenance')
      const currentEnv = nodeSettingsEnvironment(environment, record.applied), nextEnv = nodeSettingsEnvironment(environment, record.desired)
      const current = loadConfig(currentEnv), next = loadConfig(nextEnv)
      // Moving the credentials file is not permission to select an unrelated database copy.
      const previousUrl = new URL(await databaseUrlFromFile(currentEnv)), candidateUrl = new URL(await databaseUrlFromFile(nextEnv))
      if (previousUrl.host !== candidateUrl.host || previousUrl.pathname !== candidateUrl.pathname
        || previousUrl.search !== candidateUrl.search || previousUrl.protocol !== candidateUrl.protocol) throw new NodeConfigurationError(409, 'database-target-change-requires-coordinated-data-migration')
      const candidatePool = createPostgresPool(candidateUrl.href, { max: 1 })
      try {
        const candidate = await resolvePostgresRuntimeContext(candidatePool, next.organizationSlug, next.computeNodeName)
        if (candidate.organizationId !== context.organizationId || candidate.nodeId !== context.nodeId) throw new NodeConfigurationError(409, 'node-configuration-database-identity-mismatch')
      } catch { throw new NodeConfigurationError(409, 'node-configuration-database-preflight-failed') }
      finally { await candidatePool.end() }
      if (next.port !== current.port) await availablePort(next.port)
      if (next.intakePort !== current.intakePort) await availablePort(next.intakePort)
      const ports = await context.pool.query<{ port: number }>('SELECT port FROM harness.instances WHERE assigned_node_id=$1', [context.nodeId])
      if (ports.rows.some(row => row.port === next.port || row.port === next.intakePort)) throw new NodeConfigurationError(409, 'configuration-port-owned-by-runtime')
      for (const field of NODE_CONFIG_FIELDS) {
        const value = record.desired[field.key]
        if (field.kind === 'directory') await writableDirectory(value)
        if (field.kind === 'file' || field.kind === 'optional-file' && value !== '') {
          const info = await pathInfo(value)
          if (info === undefined || !info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new NodeConfigurationError(409, `configuration-credential-file-unavailable-or-not-private:${field.key}`)
          await access(value, constants.R_OK)
        }
      }
      const storageChanged = ['HGW_USERS_ROOT', 'HGW_PROJECT_RUNTIMES_ROOT', 'HGW_PRINCIPAL_KEY_DIR',
        'HGW_RUNTIME_CREDENTIAL_DIR', 'HGW_ORGANIZATION_MODEL_CREDENTIAL_KEY_FILE', 'HGW_WEBHOOK_SECRET_KEY_FILE']
        .some(key => record.applied[key as keyof typeof record.applied] !== record.desired[key as keyof typeof record.desired])
      if (storageChanged) await verifyNodeDataRelocation(context, current, next, signal)
      signal.throwIfAborted()
    },
    isHealthy: healthy,
    async restartAndVerify(record) {
      signal.throwIfAborted()
      try { await execute(command[0]!, command.slice(1), { signal, timeout: 60_000, maxBuffer: 64 * 1024 }) }
      catch { throw new NodeConfigurationError(409, 'gateway-service-restart-failed') }
      const timeout = loadConfig(nodeSettingsEnvironment(environment, record.applied)).readinessTimeoutMs
      const deadline = Date.now() + timeout
      do {
        if (await healthy(record)) return
        await delay(250, undefined, { signal })
      } while (Date.now() < deadline)
      throw new NodeConfigurationError(409, 'gateway-did-not-confirm-configured-revision')
    },
  }
}
