/** Source-launched PostgreSQL/HTTP fixture for root Loader integration tests. @module */
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import { loadConfig } from '../src/config.ts'
import { DesktopAccess } from '../src/desktop-access.ts'
import { TerminalAccess } from '../src/terminal-access.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { PRINCIPAL_HEADER } from '../src/principal.ts'
import { createExecutionFixture } from './execution-fixture.ts'
import { PostgresModelGovernanceService } from '../src/postgres/model-governance-service.ts'
import { OrganizationModelCredentialCipher } from '../src/organization-model-credentials.ts'
import { createUsageIntakeServer } from '../src/usage-intake.ts'

const url = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
if (url === undefined || process.send === undefined) throw new Error('execution fixture requires a disposable database and IPC parent')
const pool = createPostgresPool(url, { max: 10 })
let prepared: Awaited<ReturnType<typeof createExecutionFixture>> | undefined
let continueStartup!: (allowed: boolean) => void
const continuation = new Promise<boolean>(resolve => { continueStartup = resolve })
const startup = (async () => {
  await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  prepared = await createExecutionFixture(pool, {
    resourceBudget: { ...loadConfig({}).resourceBudget, sampleMs: 20, staleMs: 300_000 },
  })
  reply({ initializing: true })
  if (!process.connected) continueStartup(false)
  if (await continuation) {
    // These peers supply authorization facts without running model work in this fixture.
    for (const runtime of [prepared.other, prepared.personal, prepared.peerPersonal]) {
      assert.equal((await prepared.call('/internal/runtime/resources/register', {}, undefined, runtime)).status, 200)
    }
    await prepared.resourceBudget!.observe({ capturedAt: performance.now(), cpu: 0, memory: 'normal', eventLoopMs: 0, parallelism: 64 })
  }
  return prepared
})()
let stopping: Promise<void> | undefined
let usageServer: ReturnType<typeof createUsageIntakeServer> | undefined
const stop = (): Promise<void> => {
  continueStartup(false)
  return stopping ??= (async () => {
    try { await startup } catch (_startupFailed) {
      // The startup caller reports this failure; cleanup still owns acquired resources.
    }
    try {
      if (usageServer !== undefined) {
        usageServer.closeAllConnections()
        await new Promise<void>(resolve => { usageServer!.close(() => { resolve() }) })
      }
      await prepared?.dispose()
    } finally { await pool.end() }
  })()
}
function reply(message: Record<string, unknown>): void {
  if (!process.connected) return
  process.send?.(message, (error) => {
    if (error === null) return
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EPIPE' && code !== 'ERR_IPC_CHANNEL_CLOSED') process.exitCode = 1
    void stop().catch(() => { process.exitCode = 1 })
  })
}
const bootstrap = (message: unknown): void => {
  if (typeof message === 'object' && message !== null && 'continueStartup' in message && message.continueStartup === true) {
    continueStartup(true)
  }
}
process.on('message', bootstrap)
process.on('disconnect', () => { void stop().catch(() => { process.exitCode = 1 }) })
const fixture = await startup.catch(async (error: unknown) => {
  try { await stop() } catch (cleanupError) {
    throw new AggregateError([error, cleanupError], 'execution fixture startup and cleanup failed')
  }
  throw error
})
process.off('message', bootstrap)
if (!process.connected) await stop()

process.on('message', (message: unknown) => {
  void (async () => {
    if (message === null || typeof message !== 'object' || !('id' in message) || typeof message.id !== 'number'
      || !('action' in message) || typeof message.action !== 'string') throw new Error('invalid execution fixture command')
    let value: unknown
    if (message.action === 'session') {
      const parent = 'parentSessionId' in message ? message.parentSessionId : undefined
      if (parent !== undefined && typeof parent !== 'string') throw new Error('invalid fixture parent Session')
      value = await fixture.session(fixture.project, parent)
    } else if (message.action === 'terminal-enable') {
      const policies = new TerminalAccess(fixture.context)
      await policies.set({ kind: 'project', id: fixture.project.id }, true, '0')
      for (const user of [fixture.admin, fixture.member]) await policies.set({ kind: 'user', id: user.id }, true, '0')
      await fixture.accessMonitor.synchronize()
    } else if (message.action === 'revoke') {
      await pool.query("UPDATE harness.project_members SET access_mode='ro' WHERE project_id=$1 AND user_id=$2", [fixture.project.uuid, fixture.member.uuid])
      await fixture.accessMonitor.synchronize()
    } else if (message.action === 'desktop-enable') {
      const policies = new DesktopAccess(fixture.context)
      await policies.set({ kind: 'project', id: fixture.project.id }, true, '0')
      for (const user of [fixture.admin, fixture.member]) await policies.set({ kind: 'user', id: user.id }, true, '0')
      await fixture.accessMonitor.synchronize()
    } else if (message.action === 'desktop-confirmation') {
      if (!('sessionId' in message) || typeof message.sessionId !== 'string'
        || !('desktop' in message) || typeof message.desktop !== 'string') {
        throw new Error('invalid desktop-confirmation command')
      }
      const user = 'user' in message ? message.user : 'admin'
      if (user !== 'admin' && user !== 'member') throw new Error('invalid desktop-confirmation user')
      value = await fixture.call('desktop-confirmation', { sessionId: message.sessionId, desktop: message.desktop },
        user === 'member' ? fixture.member : fixture.admin)
    } else if (message.action === 'conversation') {
      if (!('sessionId' in message) || typeof message.sessionId !== 'string') throw new Error('invalid conversation command')
      value = (await pool.query(`SELECT c.visibility,u.public_id::text AS creator_public_id FROM harness.conversation_sessions c
        JOIN harness.users u ON u.organization_id=c.organization_id AND u.id=c.creator_user_id
        WHERE c.organization_id=$1 AND c.id=$2`, [fixture.organizationId, message.sessionId])).rows[0] ?? null
    } else if (message.action === 'draft-reservation') {
      if (!('sessionId' in message) || typeof message.sessionId !== 'string') throw new Error('invalid draft-reservation command')
      value = (await pool.query(`SELECT draft_id,visibility,lease_expires_at > now() AS live FROM harness.conversation_draft_reservations
        WHERE organization_id=$1 AND session_id=$2`, [fixture.organizationId, message.sessionId])).rows[0] ?? null
    } else if (message.action === 'expire-draft') {
      if (!('sessionId' in message) || typeof message.sessionId !== 'string') throw new Error('invalid expire-draft command')
      value = (await pool.query(`UPDATE harness.conversation_draft_reservations SET lease_expires_at = now() - interval '1 second'
        WHERE organization_id=$1 AND session_id=$2`, [fixture.organizationId, message.sessionId])).rowCount
    } else if (message.action === 'resource-pause') {
      await pool.query('UPDATE harness.node_resource_state SET credits=0,valid_until=NULL,sampled_at=NULL,sampled_before=NULL WHERE organization_id=$1 AND node_id=$2',
        [fixture.organizationId, fixture.context.nodeId])
    } else if (message.action === 'resource-resume') {
      await fixture.resourceBudget!.observe({ capturedAt: performance.now(), cpu: 0, memory: 'normal', eventLoopMs: 0, parallelism: 64 })
    } else if (message.action === 'model-governance') {
      if (usageServer !== undefined) throw new Error('usage intake already belongs to this fixture')
      const governance = new PostgresModelGovernanceService(fixture.context, new OrganizationModelCredentialCipher(Buffer.alloc(32, 41)))
      usageServer = createUsageIntakeServer(governance)
      await new Promise<void>((resolve, reject) => {
        const intake = usageServer!
        const failed = (error: Error): void => { reject(error) }
        intake.once('error', failed)
        intake.listen(0, '127.0.0.1', () => { intake.removeListener('error', failed); resolve() })
      })
      const address = usageServer.address()
      if (address === null || typeof address === 'string') throw new Error('owned usage intake did not bind')
      value = { intakeUrl: `http://127.0.0.1:${String(address.port)}/usage`,
        intakeToken: await governance.issueIntakeToken({ kind: 'project', id: fixture.project.id }) }
    } else if (message.action === 'model-usage') {
      value = (await pool.query(`SELECT p.public_id::text AS project_id,u.public_id::text AS actor_user_id,
        usage.session_id,usage.provider_key,usage.model_key,usage.purpose,usage.credential_source,usage.credential_class,
        usage.status,usage.input_tokens,usage.output_tokens
        FROM harness.model_usage usage
        JOIN harness.projects p ON p.id=usage.project_id AND p.organization_id=usage.organization_id
        LEFT JOIN harness.users u ON u.id=usage.actor_user_id AND u.organization_id=usage.organization_id
        WHERE usage.organization_id=$1 ORDER BY usage.occurred_at,usage.event_id`, [fixture.organizationId])).rows
    } else if (message.action === 'resource-snapshot') value = await fixture.resourceBudget!.snapshot()
    else if (message.action === 'stop') await stop()
    else throw new Error('unknown execution fixture command')
    reply({ id: message.id, value })
  })().catch((error: unknown) => {
    const id = message !== null && typeof message === 'object' && 'id' in message ? message.id : null
    reply({ id, error: error instanceof Error ? error.message : 'execution fixture command failed' })
  })
})
if (process.connected) reply({ ready: true,
  credential: { version: 1, gatewayUrl: fixture.base, organization: fixture.context.organizationSlug,
    runtime: { kind: 'project', id: fixture.project.id, generation: fixture.project.generation, runtimeId: fixture.project.runtimeId },
    token: fixture.project.token, principalPublicKey: fixture.publicKey },
  admin: fixture.admin.id, member: fixture.member.id,
  principals: { terminalAdmin: fixture.principals.issue({ user: fixture.admin, runtime: { kind: 'project', id: fixture.project.id, generation: fixture.project.generation, runtimeId: fixture.project.runtimeId }, purpose: 'terminal-admin',
      scope: { kind: 'project', projectId: fixture.project.id, projectName: 'fixture', mode: 'ro' } }),
    admin: fixture.headers(fixture.project, fixture.admin)[PRINCIPAL_HEADER],
    member: fixture.headers(fixture.project, fixture.member)[PRINCIPAL_HEADER] },
})
