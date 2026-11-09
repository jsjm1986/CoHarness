/** Production usage intake and execution providers for three personal Runtimes on two computers. */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'

const [mode, artifactRoot] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib'); assert.ok(artifactRoot === undefined || mode === 'lib')
const base = artifactRoot === undefined ? new URL(`../../${mode}/`, import.meta.url) : pathToFileURL(`${resolve(artifactRoot)}/`)
const [{ createPostgresPool, runMigrations }, { resolvePostgresRuntimeContext }, { PostgresUserService }, { PostgresInstanceRepository },
  { loadConfig }, { PostgresRuntimeManagement }, { PostgresModelGovernanceService }, { OrganizationModelCredentialCipher },
  { GatewayExecutionIdentity }, { GatewayPrincipalSigner }, { createUsageIntakeServer }] = await Promise.all([
  'postgres/database', 'postgres/runtime-context', 'postgres/user-service', 'postgres/instance-repository', 'config', 'runtime-management',
  'postgres/model-governance-service', 'organization-model-credentials', 'execution-identity', 'principal', 'usage-intake',
].map(name => import(new URL(`${name}.${mode === 'src' ? 'ts' : 'js'}`, base))))
const url = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL); assert.ok(url)
const pool = createPostgresPool(url, { max: 4, application_name: `runtime-usage-${randomUUID()}` })
const root = await mkdtemp(join(tmpdir(), 'runtime-usage-')), servers = [], choices = []
let organizationId, primaryError

try {
  await runMigrations(pool, process.env.DSH_AUDIT_RUNTIME_USAGE_MIGRATIONS ?? fileURLToPath(new URL('../../deploy/postgres/migrations', import.meta.url)))
  const slug = `runtime-usage-${randomUUID()}`
  organizationId = (await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Runtime usage') RETURNING id", [slug])).rows[0].id
  for (const name of ['computer-a', 'computer-b']) await pool.query('INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,$2)', [organizationId, name])
  const a = await resolvePostgresRuntimeContext(pool, slug, 'computer-a'), b = await resolvePostgresRuntimeContext(pool, slug, 'computer-b')
  const configuration = name => loadConfig({ HGW_USERS_ROOT: join(root, name, 'users'), HGW_STATE_ROOT: join(root, name, 'state'),
    HGW_PROJECTS_ROOT: join(root, name, 'projects'), HGW_USER_PROJECTS_ROOT: join(root, name, 'user-projects'),
    HGW_PROJECT_RUNTIMES_ROOT: join(root, name, 'runtimes'), HGW_SYSTEMD_UNIT_DIR: join(root, name, 'units'), HGW_DEFAULT_ENV_FILE: '',
    HGW_ORGANIZATION_SLUG: slug, HGW_COMPUTE_NODE_NAME: name,
    HGW_DSH_REPO_ROOT: fileURLToPath(new URL('../../../', import.meta.url)) })
  const cfgA = configuration('computer-a'), cfgB = configuration('computer-b')
  const users = new PostgresUserService(a, cfgA)
  const administrator = await users.create({ username: 'administrator', password: 'pw-12345678', role: 'admin' })
  await users.changeOwnPassword(administrator.id, 'pw-12345678')
  const user = await users.create({ username: 'executor', password: 'pw-12345678' })
  const userUuid = (await pool.query('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2', [organizationId, user.id])).rows[0].id
  const repositoryA = new PostgresInstanceRepository(a, cfgA.instancePortBase), repositoryB = new PostgresInstanceRepository(b, cfgB.instancePortBase)
  const primary = (await repositoryA.targetsForOwner({ kind: 'user', id: user.id }))[0]; assert.ok(primary?.runtimeId)
  const second = await new PostgresRuntimeManagement(a, cfgA).allocate(administrator, user.id, { requestId: randomUUID() })
  await pool.query('INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,true)', [organizationId, b.nodeId, userUuid])
  const remote = await new PostgresRuntimeManagement(b, cfgB).allocate(administrator, user.id, { requestId: randomUUID() })
  const cipher = new OrganizationModelCredentialCipher(Buffer.alloc(32, 17)), governanceA = new PostgresModelGovernanceService(a, cipher), governanceB = new PostgresModelGovernanceService(b, cipher)
  const keys = generateKeyPairSync('ed25519'), principals = new GatewayPrincipalSigner(keys.privateKey, slug, 60_000)
  for (const governance of [governanceA, governanceB]) {
    const server = createUsageIntakeServer(governance); servers.push(server)
    await new Promise((ready, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ready) })
  }
  choices.push(
    { label: 'local-primary', runtimeId: primary.runtimeId, context: a, governance: governanceA, repository: repositoryA, server: servers[0] },
    { label: 'local-secondary', runtimeId: second.runtimeId, context: a, governance: governanceA, repository: repositoryA, server: servers[0] },
    { label: 'remote', runtimeId: remote.runtimeId, context: b, governance: governanceB, repository: repositoryB, server: servers[1] },
  )
  for (const choice of choices) {
    const target = { kind: 'user', id: user.id, runtimeId: choice.runtimeId }
    const generation = await choice.repository.beginStart(target, Date.now(), createHash('sha256').update(randomUUID()).digest())
    choice.subject = { organizationId, target, generation, userInternalId: userUuid }
    await choice.repository.markReady(target, generation)
    const execution = new GatewayExecutionIdentity(pool, choice.context.nodeId), sessionId = 'same-host-session', messageId = 'same-human-message'
    const contentHash = createHash('sha256').update(messageId).digest('hex')
    await execution.register(choice.subject, { sessionId })
    const principal = principals.verify(principals.issue({ user, runtime: { ...target, generation }, scope: { kind: 'personal' } }))
    const receipt = await execution.input(choice.subject, principal, { sessionId, messageId, contentHash, kind: 'message' })
    choice.state = await execution.enter(choice.subject, { sessionId, messageId, contentHash, inputId: receipt.inputId, currentScopeId: null })
    choice.sessionId = sessionId
    choice.token = await choice.governance.issueIntakeToken({ kind: 'user', id: user.id, runtimeId: choice.runtimeId })
  }
  assert.equal(new Set(choices.map(choice => choice.token)).size, 3)
  const rows = async () => (await pool.query('SELECT count(*)::integer count FROM harness.model_usage WHERE organization_id=$1', [organizationId])).rows[0].count
  async function report(label, reporter, execution, changes = {}, server = reporter.server) {
    const eventId = randomUUID(), before = await rows()
    const event = { eventId, occurredAt: Date.now(), provider: 'fixture', model: 'reply', purpose: 'chat',
      sessionId: execution?.sessionId, executionInputIds: execution?.state.inputs, actorUserId: execution === undefined ? undefined : user.id,
      credentialSource: 'organization', credentialClass: 'company', status: 'succeeded', usage: { inputTokens: 1, outputTokens: 2 }, ...changes }
    const response = await fetch(`http://127.0.0.1:${server.address().port}/usage`, { method: 'POST',
      headers: { authorization: `Bearer ${reporter.token}`, 'content-type': 'application/json' }, body: JSON.stringify(event) })
    const text = await response.text(), value = text === '' ? {} : JSON.parse(text)
    console.log(JSON.stringify({ label, status: response.status, inserted: value.inserted ?? false,
      foreignRuntimeRefused: response.status === 400 && String(value.error).includes('another runtime'), addedUsageRows: await rows() - before }))
  }
  for (const choice of choices) await report(`own-${choice.label}`, choice, choice)
  await report('same-computer-borrows-primary', choices[1], choices[0])
  await report('same-computer-borrows-secondary', choices[0], choices[1])
  await report('remote-borrows-local', choices[2], choices[0])
  await report('forged-body-runtime', choices[1], choices[0], { runtimeId: choices[0].runtimeId })
  await report('wrong-computer-token', choices[0], choices[0], {}, choices[2].server)
  await report('non-session-owner-usage', choices[1], undefined)
  await pool.query('UPDATE harness.computer_use_permissions SET enabled=false WHERE organization_id=$1 AND user_id=$2 AND node_id=$3', [organizationId, userUuid, a.nodeId])
  await pool.query("UPDATE harness.users SET status='disabled' WHERE id=$1", [userUuid])
  await report('own-delayed-after-revocation', choices[0], choices[0])
  await report('foreign-delayed-after-revocation', choices[1], choices[0])
  const billing = (await pool.query(`SELECT count(*)::integer calls,sum(input_tokens+output_tokens)::integer tokens,
    bool_and(user_id=$2 AND project_id IS NULL AND actor_user_id IS NULL) same_owner FROM harness.model_usage WHERE organization_id=$1`, [organizationId, userUuid])).rows[0]
  console.log(JSON.stringify({ label: 'shared-account-billing', calls: billing.calls, tokens: billing.tokens, sameOwner: billing.same_owner }))
} catch (error) { primaryError = error; throw error }
finally {
  const errors = [], close = async fn => { try { await fn() } catch (error) { errors.push(error) } }
  for (const server of servers.reverse()) if (server.listening) await close(() => new Promise((ready, fail) => { server.closeAllConnections(); server.close(error => error ? fail(error) : ready()) }))
  for (const choice of choices) if (choice.subject !== undefined) await close(() => choice.repository.markStopped(choice.subject.target, choice.subject.generation))
  // Immutable execution receipts belong to the disposable database's owner; this fixture retires only its own organization.
  if (organizationId !== undefined) await close(() => pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [organizationId]))
  await close(() => pool.end()); await close(() => rm(root, { recursive: true, force: true }))
  if (errors.length > 0) throw new AggregateError(primaryError === undefined ? errors : [primaryError, ...errors], 'Runtime usage fixture cleanup failed')
}
