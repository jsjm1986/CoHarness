/** Keyless Host fetch carrier, SQLite search and PostgreSQL Gateway authorization. */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import GatewayCollaboration from '@deepseek-ai/dsh-collaboration-gateway'
import GatewayRuntime from '@deepseek-ai/dsh-gateway-runtime'
import { createApiProxy, toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SqliteSessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import { createPostgresPool, runMigrations } from '../../src/postgres/database.ts'
import { PostgresCollaborationService } from '../../src/postgres/collaboration-service.ts'
import { createExecutionFixture } from '../execution-fixture.ts'
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'
import { removeFixtureOrganization } from './postgres-fixture-cleanup.mjs'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
assert.ok(databaseUrl)
const directory = await mkdtemp(join(tmpdir(), 'dsh-host-search-'))
const cleanup = [() => rm(directory, { recursive: true, force: true })]

try {
  const pool = createPostgresPool(databaseUrl, { max: 6 })
  cleanup.push(() => pool.end())
  await runMigrations(pool, resolve(import.meta.dirname, '../../deploy/postgres/migrations'))
  const f = await createExecutionFixture(pool)
  cleanup.push(() => removeFixtureOrganization(pool, f.organizationId), f.dispose)
  const credential = join(directory, 'runtime.json')
  await writeFile(credential, JSON.stringify({
    version: 1, gatewayUrl: f.base, organization: f.context.organizationSlug, token: f.project.token,
    runtime: { kind: f.project.kind, id: f.project.id, generation: f.project.generation, runtimeId: f.project.runtimeId },
    principalPublicKey: f.publicKey,
  }), { mode: 0o600 })
  process.env.DSH_GATEWAY_CREDENTIAL_FILE = credential
  delete process.env.DSH_GATEWAY_CREDENTIAL_FD

  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  ctx.provide('connection', {})
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestions)
  await ctx.plugin(GatewayRuntime)
  await ctx.plugin(GatewayCollaboration)
  const queryFiber = ctx.plugin(SqliteSessionQuery, { path: ':memory:' })
  await queryFiber.await()
  const labels = new Map()
  const shared = await f.session()
  const restricted = await f.session()
  for (const [id, label, text] of [
    [shared, 'shared', 'Windmill shared status'],
    [restricted, 'restricted', 'Windmill restricted plan'],
  ]) {
    const session = ctx.sessions.create(SessionId(id), { meta: { createdAt: 100, cwd: directory } })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    labels.set(id, label)
  }

  const { fetch: handle } = toFetchHandler(createApiProxy(ctx, {
    cwd: directory, defaultModelSelection: () => ({ provider: 'fixture', model: 'keyless' }),
  }))
  const call = async (method, payload, person = f.member) => {
    const pathname = '/api/' + method
    const headers = f.headers(f.project, person)
    let response
    await ctx.waterfall('connection/request', { kind: 'http', method: 'POST', pathname, headers }, async () => {
      response = await handle(new Request(f.base + pathname, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', method, rpcId: 'windmill-' + method, payload }),
      }))
    })
    const { result } = await response.json()
    return result
  }
  const search = async (person) => {
    const result = await call('session.search', { query: 'windmill' }, person)
    if (!result.ok) return { error: result.error }
    return {
      items: result.value.items.map(item => {
        assert.ok(labels.has(item.sessionId))
        return { session: labels.get(item.sessionId), snippet: item.snippet }
      }).sort((a, b) => a.session.localeCompare(b.session)),
      hasMore: result.value.hasMore,
    }
  }
  const record = (step, result) => { process.stdout.write(JSON.stringify({ step, result }) + '\n') }
  const index = ctx.sessionQuery
  const searchIndex = index.searchSessions
  const withdrawAfterIndex = (withdraw) => {
    index.searchSessions = async (request, execution) => {
      index.searchSessions = searchIndex
      const page = await searchIndex.call(index, request, execution)
      assert.equal(page.items.length, 2)
      await withdraw()
      return page
    }
  }
  const baseline = await search()
  assert.equal(baseline.items?.length, 2)
  record('shared', baseline)
  const collaboration = new PostgresCollaborationService(f.context)
  const visibility = mode => collaboration.setVisibility(f.admin.id, f.project.runtimeId, restricted, mode)
  withdrawAfterIndex(() => visibility('private'))
  record('private-during-search', await search())
  record('creator', await search(f.admin))
  await visibility('project')

  const remote = (await pool.query(`INSERT INTO harness.compute_nodes(organization_id,name)
    VALUES($1,'Other search computer') RETURNING id`, [f.organizationId])).rows[0].id
  await pool.query(`INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled)
    VALUES($1,$2,$3,true)`, [f.organizationId, remote, f.member.uuid])
  const localComputer = enabled => pool.query(`UPDATE harness.computer_use_permissions SET enabled=$4
    WHERE organization_id=$1 AND node_id=$2 AND user_id=$3`, [f.organizationId, f.context.nodeId, f.member.uuid, enabled])
  withdrawAfterIndex(() => localComputer(false))
  record('local-computer-withdrawn-during-search', await search())
  await localComputer(true)

  const runtime = ctx.gatewayRuntime
  const requestGateway = runtime.request
  runtime.request = async (pathname, init) => {
    const response = await requestGateway.call(runtime, pathname, init)
    if (pathname === '/internal/runtime/collaboration/readable' && response.ok) {
      runtime.request = requestGateway
      await visibility('private')
    }
    return response
  }
  const listed = await call('session.list', {})
  assert.equal(listed.ok, true)
  record('private-during-list', listed.value.items.map(item => labels.get(item.sessionId)).sort())

  await queryFiber.dispose()
  const blocked = join(directory, 'private-index-parent')
  await writeFile(blocked, '')
  await ctx.plugin(SqliteSessionQuery, { path: join(blocked, 'index.sqlite'), openAt: 'first-search' })
  const fault = await search()
  assert.equal(fault.error?.code, 'internal')
  assert.doesNotMatch(fault.error.message, /private-index-parent/u)
  record('index-unavailable', fault)
} finally {
  const failures = []
  for (const close of cleanup.reverse()) {
    try { await close() } catch (error) { failures.push(error) }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Host search fixture cleanup failed')
}
