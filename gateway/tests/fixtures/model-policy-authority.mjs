/** Real account stores and policy projection retain current authorization across role changes. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'

const [mode, backend, artifactRoot] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib'); assert.ok(backend === 'sqlite' || backend === 'postgres')
assert.ok(artifactRoot === undefined || mode === 'lib')
const base = artifactRoot === undefined ? new URL(`../../${mode}/`, import.meta.url) : pathToFileURL(`${resolve(artifactRoot)}/`)
const load = name => import(new URL(`${name}.${mode === 'src' ? 'ts' : 'js'}`, base))
const [{ openDb }, { UserService }, { ModelGovernanceService }, { loadConfig }, { createPostgresPool, runMigrations },
  { resolvePostgresRuntimeContext }, { PostgresUserService }, { PostgresModelGovernanceService },
  { OrganizationModelCredentialCipher }, { writeModelGovernanceFile, ensureModelGovernanceForUser }] = await Promise.all([
  'db', 'users', 'model-governance', 'config', 'postgres/database', 'postgres/runtime-context', 'postgres/user-service',
  'postgres/model-governance-service', 'organization-model-credentials', 'apply-model-governance',
].map(load))
const root = await mkdtemp(join(tmpdir(), 'model-policy-authority-replay-'))
let db, pool
try {
  const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_STATE_ROOT: join(root, 'state'),
    HGW_PROJECTS_ROOT: join(root, 'projects'), HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'),
    HGW_PROJECT_RUNTIMES_ROOT: join(root, 'runtimes'), HGW_SYSTEMD_UNIT_DIR: join(root, 'units'), HGW_DEFAULT_ENV_FILE: '',
    HGW_DSH_REPO_ROOT: fileURLToPath(new URL('../../../', import.meta.url)) })
  let context
  if (backend === 'postgres') {
    const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL); assert.ok(databaseUrl)
    pool = createPostgresPool(databaseUrl, { max: 1 })
    await runMigrations(pool, resolve(import.meta.dirname, '../../deploy/postgres/migrations'))
    const slug = `model-policy-replay-${randomUUID()}`
    const organizationId = (await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Model policy replay') RETURNING id", [slug])).rows[0].id
    await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local')", [organizationId])
    context = await resolvePostgresRuntimeContext(pool, slug, 'local')
  } else db = openDb(join(root, 'gateway.sqlite'))
  const users = context === undefined ? new UserService(db, cfg) : new PostgresUserService(context, cfg)
  const governance = context === undefined ? new ModelGovernanceService(db, 'UTC') : new PostgresModelGovernanceService(context,
    new OrganizationModelCredentialCipher(Buffer.alloc(32, 9)), 'UTC')
  const owner = await users.create({ username: 'policy-owner', password: 'pw-12345678', role: 'admin' })
  await users.create({ username: 'keeper-admin', password: 'pw-12345678', role: 'admin' })
  const provider = backend === 'postgres' ? 'org-policy' : 'p'
  const profile = { provider, displayName: 'Policy', driver: 'pi-ai', protocol: 'openai-completions',
    baseURL: 'https://models.example.test/v1', authMode: 'none' }
  if (backend === 'postgres') await governance.upsertProvider({ ...profile, status: 'draft' })
  await governance.upsertModel({ provider, model: 'chat', displayName: 'Chat', enabled: true, adminAllowed: true, userAllowed: false,
    inputMicrosPerMillion: 0, outputMicrosPerMillion: 0, cacheReadMicrosPerMillion: 0, cacheWriteMicrosPerMillion: 0 })
  if (backend === 'postgres') await governance.upsertProvider({ ...profile, status: 'enabled' })
  const path = await writeModelGovernanceFile(cfg, governance, owner)
  const initial = JSON.parse(await readFile(path, 'utf8')); assert.equal(initial.models[0].allowed, true)
  await users.setRole(owner.id, 'user')
  const demotedPolicy = await governance.policyFor(owner)
  assert.equal(demotedPolicy.version, initial.version); assert.equal(demotedPolicy.models[0].allowed, false)
  await ensureModelGovernanceForUser(cfg, governance, owner)
  const lazy = JSON.parse(await readFile(path, 'utf8')); assert.equal(lazy.models[0].allowed, false)
  await writeModelGovernanceFile(cfg, governance, owner)
  const eager = JSON.parse(await readFile(path, 'utf8')); assert.equal(eager.models[0].allowed, false)
  await users.setRole(owner.id, 'admin')
  await ensureModelGovernanceForUser(cfg, governance, owner)
  const promoted = JSON.parse(await readFile(path, 'utf8')); assert.equal(promoted.models[0].allowed, true)
  assert.equal(promoted.version, initial.version)
  await governance.setUserAccess(owner.id, provider, 'chat', false)
  await ensureModelGovernanceForUser(cfg, governance, owner)
  const denied = JSON.parse(await readFile(path, 'utf8')); assert.equal(denied.models[0].allowed, false)
  const beforeWithdrawal = await readFile(path, 'utf8')
  const readToken = governance.subjectForIntakeToken.bind(governance), issueToken = governance.issueIntakeToken.bind(governance)
  const unavailable = new Error('Stored intake credential lookup unavailable')
  let issued = 0
  governance.subjectForIntakeToken = () => { throw unavailable }
  governance.issueIntakeToken = (...args) => { issued += 1; return issueToken(...args) }
  try { await assert.rejects(writeModelGovernanceFile(cfg, governance, owner), error => error === unavailable) }
  finally { governance.subjectForIntakeToken = readToken; governance.issueIntakeToken = issueToken }
  assert.equal(issued, 0); assert.equal(await readFile(path, 'utf8'), beforeWithdrawal)
  await users.setStatus(owner.id, 'disabled')
  const refusal = await writeModelGovernanceFile(cfg, governance, owner).then(() => null, error => error.code)
  assert.equal(refusal, 'forbidden'); assert.equal(await readFile(path, 'utf8'), beforeWithdrawal)
  assert.ok([lazy, eager, promoted, denied].every(policy => policy.intakeToken === initial.intakeToken))
  console.log(JSON.stringify({ backend, staleAdministratorRead: demotedPolicy.models[0].allowed,
    lazyDemotion: lazy.models[0].allowed, eagerDemotion: eager.models[0].allowed,
    promotion: promoted.models[0].allowed, roleChangePreservesModelVersion: promoted.version === initial.version,
    explicitDeny: denied.models[0].allowed, intakeTokenRetained: true, tokenLookupFailurePreservesProjection: true,
    withdrawal: refusal, withdrawalPreservesProjection: true }))
} finally { db?.close(); await pool?.end(); await rm(root, { recursive: true, force: true }) }
