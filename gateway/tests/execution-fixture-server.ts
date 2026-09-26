/** Source-launched PostgreSQL/HTTP fixture for root Loader integration tests. @module */
import { resolve } from 'node:path'
import { TerminalAccess } from '../src/terminal-access.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { PRINCIPAL_HEADER } from '../src/principal.ts'
import { createExecutionFixture } from './execution-fixture.ts'

const url = process.env.HGW_TEST_DATABASE_URL
if (url === undefined || process.send === undefined) throw new Error('execution fixture requires a disposable database and IPC parent')
const pool = createPostgresPool(url, { max: 10 })
await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
const fixture = await createExecutionFixture(pool)
let stopping: Promise<void> | undefined
const stop = (): Promise<void> => stopping ??= (async () => {
  try { await fixture.dispose() } finally { await pool.end() }
})()

process.on('disconnect', () => { void stop().catch(() => { process.exitCode = 1 }) })
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
    } else if (message.action === 'stop') await stop()
    else throw new Error('unknown execution fixture command')
    process.send?.({ id: message.id, value })
  })().catch((error: unknown) => {
    const id = message !== null && typeof message === 'object' && 'id' in message ? message.id : null
    process.send?.({ id, error: error instanceof Error ? error.message : 'execution fixture command failed' })
  })
})
process.send({ ready: true,
  credential: { version: 1, gatewayUrl: fixture.base, organization: fixture.context.organizationSlug,
    runtime: { kind: 'project', id: fixture.project.id, generation: fixture.project.generation },
    token: fixture.project.token, principalPublicKey: fixture.publicKey },
  admin: fixture.admin.id, member: fixture.member.id,
  principals: { terminalAdmin: fixture.principals.issue({ user: fixture.admin, runtime: { kind: 'project', id: fixture.project.id, generation: fixture.project.generation }, purpose: 'terminal-admin',
      scope: { kind: 'project', projectId: fixture.project.id, projectName: 'fixture', mode: 'ro' } }),
    admin: fixture.headers(fixture.project, fixture.admin)[PRINCIPAL_HEADER],
    member: fixture.headers(fixture.project, fixture.member)[PRINCIPAL_HEADER] },
})
