/** Real PostgreSQL backup admission and provider-owned data selection. */
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readManagedDataPaths, registerManagedDataPath } from '@deepseek-ai/dsh-managed-data'
import { testConfig, testEnvironment } from './test-config.ts'
import { NodeConfigurationStore, readNodeConfiguration } from '../src/node-config-store.ts'
import { createNodeConfigurationHost, nodeSettingsEnvironment } from '../src/node-config-host.ts'
import { createDeploymentCommands } from '../src/deployment-commands.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { PostgresBackupService } from '../src/postgres/backup-service.ts'
import { backupFilesDirectory, PostgresDeploymentBackups } from '../src/postgres/deployment-backups.ts'
import { adoptDeploymentInventory, collectDeploymentData } from '../src/postgres/deployment-data.ts'
import { replaceCandidateDeploymentInventory } from '../src/postgres/deployment-inventory.ts'
import { acquireDeploymentDataLock } from '../src/postgres/deployment-lock.ts'
import { PostgresMaintenanceService } from '../src/postgres/maintenance-service.ts'
import { nodeConfigurationAuthority } from '../src/postgres/node-configuration-authority.ts'
import { PostgresUserService } from '../src/postgres/user-service.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'

const databaseUrl = process.env.HGW_TEST_DATABASE_URL
const describePg = databaseUrl === undefined ? describe.skip : describe
let pool: Pool
let directory: string
function command(value: string | undefined, executable: string): string[] {
  if (value === undefined) return [executable]
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some(part => typeof part !== 'string')) throw new Error('invalid PostgreSQL test command')
  return parsed as string[]
}

describePg('deployment backup completeness', () => {
  beforeAll(() => { pool = createPostgresPool(databaseUrl!, { max: 4 }) })
  beforeEach(async () => {
    await pool.query('DROP SCHEMA IF EXISTS harness CASCADE')
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
    directory = await realpath(await mkdtemp(join(tmpdir(), 'hgw-backup-complete-')))
  })
  afterEach(async () => { await rm(directory, { recursive: true, force: true }) })
  afterAll(async () => { await pool.end() })

  async function fixture() {
    const slug = randomUUID(), node = 'backup-node'
    const environment = testEnvironment(directory, { HGW_STATE_ROOT: join(directory, 'state'), HGW_USERS_ROOT: join(directory, 'users'),
      HGW_PROJECTS_ROOT: join(directory, 'projects'), HGW_PROJECT_RUNTIMES_ROOT: join(directory, 'project-runtimes'),
      HGW_DEFAULT_ENV_FILE: '', HGW_MANAGED_DATA_APPROVAL_FILE: join(directory, 'approved.jsonl'),
      HGW_ORGANIZATION_SLUG: slug, HGW_COMPUTE_NODE_NAME: node, HGW_PUBLIC_ORIGINS: 'http://127.0.0.1:8899' })
    const cfg = testConfig(directory, environment)
    const organization = (await pool.query<{ id: string }>(
      "INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Backup fixture') RETURNING id", [slug])).rows[0]!.id
    await pool.query('INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,$2)', [organization, node])
    await pool.query('INSERT INTO harness.cluster_control(organization_id) VALUES($1)', [organization])
    const context = await resolvePostgresRuntimeContext(pool, slug, node)
    const home = join(directory, 'workspace'), dsh = join(cfg.usersRoot, 'alice', 'dsh')
    await mkdir(home)
    await writeFile(join(home, 'source.ts'), 'project source is not managed data')
    const user = (await pool.query<{ id: string; public_id: string }>(
      "INSERT INTO harness.users(organization_id,username,display_name,home_path) VALUES($1,'alice','Alice',$2) RETURNING id,public_id",
      [organization, home])).rows[0]!
    await pool.query(`INSERT INTO harness.instances(organization_id,user_id,assigned_node_id,port,generation)
      VALUES($1,$2,$3,49101,1)`, [organization, user.id, context.nodeId])
    await writeFile(cfg.managedDataApprovalFile!, '', { mode: 0o600 })
    const maintenance = new PostgresMaintenanceService(context, cfg.nodeStaleMs)
    const commands = createDeploymentCommands(command(process.env.HGW_TEST_PG_DUMP_COMMAND, 'pg_dump'),
      command(process.env.HGW_TEST_PG_RESTORE_COMMAND, 'pg_restore'))
    const backups = new PostgresDeploymentBackups(context, cfg, databaseUrl!, commands, environment)
    const claim = (owner: string, kind: 'file' | 'directory', path: string) => registerManagedDataPath({ owner, kind, path }, join(dsh, 'managed-data.jsonl'))
    const approve = async (rows: Array<{ owner: string; kind: 'file' | 'directory'; path: string }>) => {
      await writeFile(cfg.managedDataApprovalFile!, rows.map(row => JSON.stringify({ version: 1,
        ...row, owner: `user:${user.public_id}/${row.owner}` })).join('\n') + '\n', { mode: 0o600 })
    }
    return { cfg, context, maintenance, backups, dsh, home, user, claim, approve, environment, commands }
  }

  async function relocationFixture() {
    const f = await fixture()
    const environment = { ...f.environment, HGW_DATABASE_URL: databaseUrl!, HGW_LAUNCHER: 'local' }
    const cfg = testConfig(directory, environment), runtime = `user:${f.user.public_id}`
    f.claim('@deepseek-ai/dsh-session-persistence-jsonl', 'directory', join(f.dsh, 'sessions'))
    f.claim('@deepseek-ai/dsh-userdoc-local', 'directory', join(f.home, 'documents'))
    await mkdir(join(f.dsh, 'sessions')); await mkdir(join(f.home, 'documents'))
    await writeFile(join(f.dsh, 'sessions', 'session.jsonl'), 'durable Session data')
    await writeFile(join(f.home, 'documents', 'document.txt'), 'database-owned HOME stays here')
    await writeFile(join(f.dsh, '.env'), 'MODEL_NAME=deepseek-chat\n', { mode: 0o600 })
    for (const path of [cfg.organizationModelCredentialKeyFile, cfg.webhookSecretKeyFile]) {
      await mkdir(dirname(path), { recursive: true }); await writeFile(path, 'isolated test key', { mode: 0o600 })
    }
    const store = new NodeConfigurationStore(f.context, cfg, environment, nodeConfigurationAuthority(f.context))
    await store.initialize()
    const current = await store.view(), nextUsers = join(directory, 'next-users'), nextDsh = join(nextUsers, 'alice', 'dsh')
    await store.save(f.context, current.revision, { ...current.desired, HGW_USERS_ROOT: nextUsers })
    await cp(f.dsh, nextDsh, { recursive: true })
    await f.approve([
      { owner: '@deepseek-ai/dsh-session-persistence-jsonl', kind: 'directory', path: join(nextDsh, 'sessions') },
      { owner: '@deepseek-ai/dsh-userdoc-local', kind: 'directory', path: join(f.home, 'documents') },
    ])
    await f.maintenance.enterMaintenance(null)
    const record = (await readNodeConfiguration(cfg.nodeConfigFile, environment))!
    return { ...f, cfg, environment, runtime, store, record, nextDsh }
  }

  it('rejects a copied old inventory before publishing paths and accepts its complete reviewed replacement', async () => {
    const f = await relocationFixture(), sourceInventory = await readFile(join(f.dsh, 'managed-data.jsonl'))
    const configuration = await readFile(f.cfg.nodeConfigFile)
    await using lease = await acquireDeploymentDataLock(pool)
    const host = createNodeConfigurationHost(f.environment, f.context, lease.signal)
    await expect(host.preflight(f.record)).rejects.toThrow('candidate-inventory-requires-reviewed-data-migration')
    expect(await readFile(f.cfg.nodeConfigFile)).toEqual(configuration)
    const prepared = await replaceCandidateDeploymentInventory(f.context, f.cfg, f.environment, f.runtime, 1, lease.signal)
    expect(await readFile(prepared.evidence)).toEqual(sourceInventory)
    expect(await readFile(join(f.dsh, 'managed-data.jsonl'))).toEqual(sourceInventory)
    await host.preflight(f.record)
    const candidateRoots = await collectDeploymentData(f.context, testConfig(directory, nodeSettingsEnvironment(f.environment, f.record.desired)))
    expect(candidateRoots.some(root => root.path === join(f.nextDsh, 'sessions'))).toBe(true)
    expect(candidateRoots.some(root => root.path === join(f.home, 'documents'))).toBe(true)
    expect(candidateRoots.some(root => root.path === join(f.nextDsh, '..', 'home', 'documents'))).toBe(false)
    expect(await readFile(f.cfg.nodeConfigFile)).toEqual(configuration)
  })

  it('rejects incomplete reviewed lists, missing data and unproven absolute configuration paths', async () => {
    const f = await relocationFixture(), before = await readFile(join(f.nextDsh, 'managed-data.jsonl'))
    await using lease = await acquireDeploymentDataLock(pool)
    const host = createNodeConfigurationHost(f.environment, f.context, lease.signal)
    await f.approve([{ owner: '@deepseek-ai/dsh-session-persistence-jsonl', kind: 'directory', path: join(f.nextDsh, 'sessions') }])
    await expect(replaceCandidateDeploymentInventory(f.context, f.cfg, f.environment, f.runtime, 1, lease.signal)).rejects.toThrow('cover-all-relocated-and-retained-roots')
    expect(await readFile(join(f.nextDsh, 'managed-data.jsonl'))).toEqual(before)
    await f.approve([
      { owner: '@deepseek-ai/dsh-session-persistence-jsonl', kind: 'directory', path: join(f.nextDsh, 'sessions') },
      { owner: '@deepseek-ai/dsh-userdoc-local', kind: 'directory', path: join(f.home, 'documents') },
    ])
    registerManagedDataPath({ owner: '@deepseek-ai/dsh-storage-json', kind: 'directory', path: join(f.nextDsh, 'unexpected') }, join(f.nextDsh, 'managed-data.jsonl'))
    await expect(replaceCandidateDeploymentInventory(f.context, f.cfg, f.environment, f.runtime, 1, lease.signal)).rejects.toThrow('copied-inventory-does-not-match')
    await writeFile(join(f.nextDsh, 'managed-data.jsonl'), before)
    await replaceCandidateDeploymentInventory(f.context, f.cfg, f.environment, f.runtime, 1, lease.signal)
    await rm(join(f.nextDsh, 'sessions', 'session.jsonl'))
    await expect(host.preflight(f.record)).rejects.toThrow('relocated-managed-data-does-not-match')
    await cp(join(f.dsh, 'sessions'), join(f.nextDsh, 'sessions'), { recursive: true })
    for (const home of [f.dsh, f.nextDsh]) await writeFile(join(home, '.env'), `SESSION_ROOT=${join(f.dsh, 'sessions')}\n`, { mode: 0o600 })
    await expect(host.preflight(f.record)).rejects.toThrow('runtime-configuration-requires-reviewed-data-migration')
    for (const home of [f.dsh, f.nextDsh]) await writeFile(join(home, '.env'), 'MODEL_NAME=deepseek-chat\n', { mode: 0o600 })
    const defaultEnv = join(directory, 'default-environment')
    await writeFile(defaultEnv, `DATA_ROOT=${f.cfg.usersRoot}\n`, { mode: 0o600 })
    await expect(host.preflight({ ...f.record, desired: { ...f.record.desired, HGW_DEFAULT_ENV_FILE: defaultEnv } }))
      .rejects.toThrow('runtime-configuration-requires-reviewed-data-migration')
    for (const home of [f.dsh, f.nextDsh]) await writeFile(join(home, 'directory-grants.json'), JSON.stringify([{ path: f.dsh }]).replaceAll('/', '\\u002f'))
    await expect(host.preflight(f.record)).rejects.toThrow('runtime-configuration-requires-reviewed-data-migration')
    for (const home of [f.dsh, f.nextDsh]) await writeFile(join(home, 'directory-grants.json'), JSON.stringify([{ path: f.home }]))
    await host.preflight(f.record)
    for (const home of [f.dsh, f.nextDsh]) await writeFile(join(home, 'cordis.patch.yml'), '- id: storage\n  config:\n    directory: !!js process.env.CUSTOM_DATA\n')
    await expect(host.preflight(f.record)).rejects.toThrow('runtime-configuration-requires-reviewed-data-migration')
  })

  it('keeps custom provider roots in place and rejects a systemd HOME outside the candidate users root', async () => {
    const f = await relocationFixture(), custom = join(f.dsh, 'custom-storages')
    await mkdir(custom); await writeFile(join(custom, 'state.json'), '{}')
    f.claim('@deepseek-ai/dsh-storage-json', 'directory', custom)
    await cp(join(f.dsh, 'managed-data.jsonl'), join(f.nextDsh, 'managed-data.jsonl'))
    await f.approve([
      { owner: '@deepseek-ai/dsh-session-persistence-jsonl', kind: 'directory', path: join(f.nextDsh, 'sessions') },
      { owner: '@deepseek-ai/dsh-userdoc-local', kind: 'directory', path: join(f.home, 'documents') },
      { owner: '@deepseek-ai/dsh-storage-json', kind: 'directory', path: custom },
    ])
    await using lease = await acquireDeploymentDataLock(pool)
    await replaceCandidateDeploymentInventory(f.context, f.cfg, f.environment, f.runtime, 1, lease.signal)
    await createNodeConfigurationHost(f.environment, f.context, lease.signal).preflight(f.record)
    const next = testConfig(directory, nodeSettingsEnvironment(f.environment, f.record.desired))
    expect((await collectDeploymentData(f.context, next)).some(root => root.path === custom)).toBe(true)
    await expect(createNodeConfigurationHost({ ...f.environment, HGW_LAUNCHER: 'systemd', HGW_PROJECT_PATH_ROOTS: directory }, f.context, lease.signal).preflight(f.record))
      .rejects.toThrow('systemd-user-home-relocation-requires-coordinated-data-migration')
  })

  it('checks candidate revision and node identity before inventory writes through the deployment CLI', async () => {
    const f = await relocationFixture(), inventory = join(f.nextDsh, 'managed-data.jsonl'), before = await readFile(inventory)
    const entry = resolve(import.meta.dirname, '../scripts/deploy-apply.ts')
    const environment = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(HGW_|DSH_)/u.test(key))), ...f.environment,
      TSX_TSCONFIG_PATH: resolve(import.meta.dirname, '../tsconfig.run.json') }
    const args = ['--import', import.meta.resolve('tsx/esm'), entry, 'inventory', 'adopt', '--runtime', f.runtime, '--replace-reviewed', '--configuration-revision']
    await expect(promisify(execFile)(process.execPath, [...args, '2'], { env: environment, timeout: 10_000 }))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('configuration-revision-conflict') })
    expect(await readFile(inventory)).toEqual(before)
    const config = await readFile(f.cfg.nodeConfigFile, 'utf8')
    await writeFile(f.cfg.nodeConfigFile, JSON.stringify({ ...JSON.parse(config), nodeId: randomUUID() }), { mode: 0o600 })
    await expect(promisify(execFile)(process.execPath, [...args, '1'], { env: environment, timeout: 10_000 }))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('node-identity-mismatch') })
    expect(await readFile(inventory)).toEqual(before)
    await writeFile(f.cfg.nodeConfigFile, config, { mode: 0o600 })
    const result = await promisify(execFile)(process.execPath, [...args, '1'], { env: environment, timeout: 10_000 })
    expect(result.stdout).toContain('preserved_inventory=')
    expect((await readNodeConfiguration(f.cfg.nodeConfigFile, environment))!.appliedRevision).toBe(0)
    expect(await readFile(inventory)).not.toEqual(before)
  })

  it('requires stopped writers and the exclusive lease before copying nested provider data', async () => {
    const f = await fixture(), sessions = join(f.dsh, 'sessions'), reviews = join(f.dsh, 'workspace-reviews')
    f.claim('@deepseek-ai/dsh-session-persistence-jsonl', 'directory', sessions)
    f.claim('@deepseek-ai/dsh-workspace-changes', 'directory', reviews)
    await mkdir(join(sessions, '6'), { recursive: true })
    await mkdir(reviews)
    await writeFile(join(sessions, '6', 'session.jsonl'), 'original Session bytes')
    await writeFile(join(reviews, 'review.json'), 'historical diff')
    await mkdir(join(f.dsh, 'model-governance-outbox'))
    await writeFile(join(f.dsh, 'model-governance-outbox', 'pending.json'), 'pending durable usage')
    await expect(f.backups.create(null)).rejects.toMatchObject({ message: 'backup-requires-maintenance' })
    await f.maintenance.enterMaintenance(null)
    await pool.query("UPDATE harness.instances SET desired_state='running',observed_state='ready'")
    await expect(f.backups.create(null)).rejects.toMatchObject({ message: 'writers-not-quiesced' })
    await pool.query("UPDATE harness.instances SET desired_state='stopped',observed_state='stopped'")
    const lease = await acquireDeploymentDataLock(pool)
    try { await expect(f.backups.create(null)).rejects.toMatchObject({ message: 'deployment-data-operation-already-running' }) }
    finally { await lease[Symbol.asyncDispose]() }
    const copy = f.commands.backup
    f.commands.backup = async (...args) => {
      await expect(acquireDeploymentDataLock(pool)).rejects.toMatchObject({ message: 'deployment-data-operation-already-running' })
      await expect(f.maintenance.exitMaintenance(null)).rejects.toMatchObject({ message: 'maintenance-exit-conflict' })
      return copy(...args)
    }
    const result = await f.backups.create(null, relative(process.cwd(), f.cfg.backupDir))
    expect(result.status).toBe('verified')
    expect(result.path.startsWith(f.cfg.backupDir + '/')).toBe(true)
    expect(result.managedSnapshot!.files.map(file => file.sourcePath)).toContain(join(sessions, '6', 'session.jsonl'))
    expect(result.managedSnapshot!.files.map(file => file.sourcePath)).not.toContain(join(f.home, 'source.ts'))
    expect(result.managedSnapshot!.files.map(file => file.sourcePath)).toContain(join(f.dsh, 'model-governance-outbox', 'pending.json'))
    const review = result.managedSnapshot!.files.find(file => file.sourcePath === join(reviews, 'review.json'))!
    expect(await readFile(join(backupFilesDirectory(result.path), review.member), 'utf8')).toBe('historical diff')
    await writeFile(join(backupFilesDirectory(result.path), review.member), 'corrupt')
    await expect(f.backups.verify(result.id)).rejects.toThrow('digest mismatch')
    expect((await new PostgresBackupService(f.context).get(result.id)).status).toBe('failed')
  })

  it('requires explicit reviewed adoption for a historical runtime and retains custom retired roots', async () => {
    const f = await fixture(), old = join(directory, 'retired-custom-sessions')
    await mkdir(old)
    await writeFile(join(old, 'legacy.jsonl'), 'preserve even if malformed')
    await expect(collectDeploymentData(f.context, f.cfg)).rejects.toMatchObject({ message: `managed-data-inventory-missing:user:${f.user.public_id}` })
    await expect(adoptDeploymentInventory(f.context, f.cfg, `user:${f.user.public_id}`)).rejects.toThrow('quiesced-maintenance')
    await f.maintenance.enterMaintenance(null)
    await expect(adoptDeploymentInventory(f.context, f.cfg, `user:${f.user.public_id}`)).rejects.toThrow('reviewed-roots')
    await f.approve([{ owner: '@deepseek-ai/dsh-session-persistence-jsonl', kind: 'directory', path: old }])
    await adoptDeploymentInventory(f.context, f.cfg, `user:${f.user.public_id}`)
    f.claim('@deepseek-ai/dsh-session-persistence-jsonl', 'directory', join(f.dsh, 'sessions'))
    const roots = await collectDeploymentData(f.context, f.cfg)
    expect(roots.map(root => root.path)).toEqual(expect.arrayContaining([old, join(f.dsh, 'sessions')]))
    const result = await f.backups.create(null)
    expect(result.managedSnapshot!.files.some(file => file.sourcePath === join(old, 'legacy.jsonl'))).toBe(true)
  })

  it('refuses unapproved roots, broad workspace claims and user-writable approval files', async () => {
    const f = await fixture(), unrelated = join(directory, 'unrelated')
    await mkdir(unrelated)
    f.claim('@deepseek-ai/dsh-storage-json', 'directory', unrelated)
    await expect(collectDeploymentData(f.context, f.cfg)).rejects.toThrow('root-needs-approval')
    await f.approve([{ owner: '@deepseek-ai/dsh-storage-json', kind: 'directory', path: unrelated }])
    await chmod(f.cfg.managedDataApprovalFile!, 0o666)
    await expect(collectDeploymentData(f.context, f.cfg)).rejects.toThrow('node-admin-owned')
    await chmod(f.cfg.managedDataApprovalFile!, 0o600)
    f.claim('@deepseek-ai/dsh-storage-json', 'directory', f.home)
    await f.approve([{ owner: '@deepseek-ai/dsh-storage-json', kind: 'directory', path: unrelated },
      { owner: '@deepseek-ai/dsh-storage-json', kind: 'directory', path: f.home }])
    await expect(collectDeploymentData(f.context, f.cfg)).rejects.toThrow('root-includes-unowned-workspace')
  })

  it('does not interpret a symbolic ancestor as permission to capture its external target', async () => {
    const f = await fixture(), outside = join(directory, 'outside')
    await mkdir(join(outside, 'v1'), { recursive: true })
    f.claim('@deepseek-ai/dsh-attachment-local', 'directory', join(f.dsh, 'attachments', 'v1'))
    await symlink(outside, join(f.dsh, 'attachments'))
    await expect(collectDeploymentData(f.context, f.cfg)).rejects.toThrow('root-needs-approval')
  })

  it('refuses to describe one node bundle as a complete multi-node database backup', async () => {
    const f = await fixture()
    await pool.query("INSERT INTO harness.compute_nodes(organization_id,name,status) VALUES($1,'other-node','offline')", [f.context.organizationId])
    await f.maintenance.enterMaintenance(null)
    await expect(f.backups.create(null)).rejects.toMatchObject({ message: 'backup-requires-data-bundles-from-every-database-node' })
  })

  it('retains deleted owners after their instance row is removed and refuses ambiguous node assignment', async () => {
    const f = await fixture(), documents = join(f.home, 'documents'), sessions = join(f.dsh, 'sessions')
    await mkdir(documents); await mkdir(sessions, { recursive: true })
    await writeFile(join(documents, 'retained.txt'), 'retained user document')
    await writeFile(join(sessions, 'historical.jsonl'), 'retained Session generation')
    await pool.query('DELETE FROM harness.instances WHERE user_id=$1', [f.user.id])
    await pool.query("UPDATE harness.users SET status='disabled',deleted_at=now() WHERE id=$1", [f.user.id])
    await expect(collectDeploymentData(f.context, f.cfg)).rejects.toThrow('managed-data-inventory-missing')
    await f.approve([
      { owner: '@deepseek-ai/dsh-userdoc-local', kind: 'directory', path: documents },
      { owner: '@deepseek-ai/dsh-session-persistence-jsonl', kind: 'directory', path: sessions },
    ])
    await f.maintenance.enterMaintenance(null)
    {
      await using lease = await acquireDeploymentDataLock(pool)
      lease.signal.throwIfAborted()
      await adoptDeploymentInventory(f.context, f.cfg, `user:${f.user.public_id}`)
    }
    const backup = await f.backups.create(null)
    expect(backup.managedSnapshot!.files.map(file => file.sourcePath)).toEqual(expect.arrayContaining([
      join(documents, 'retained.txt'), join(sessions, 'historical.jsonl'),
    ]))
    await pool.query("INSERT INTO harness.compute_nodes(organization_id,name,status) VALUES($1,'unresolved-owner-node','offline')", [f.context.organizationId])
    await expect(collectDeploymentData(f.context, f.cfg)).rejects.toThrow('backup-requires-data-bundles-from-every-database-node')
    await expect(adoptDeploymentInventory(f.context, f.cfg, `user:${f.user.public_id}`)).rejects.toThrow('backup-requires-data-bundles-from-every-database-node')
  })

  it('backs up a never-started new account and leaves failed creation evidence outside other users inventories', async () => {
    const f = await fixture(), users = new PostgresUserService(f.context, f.cfg)
    f.claim('@deepseek-ai/dsh-session-persistence-jsonl', 'directory', join(f.dsh, 'sessions'))
    const created = await users.create({ username: 'not-started', password: 'pw-123456' })
    const inventory = join(f.cfg.usersRoot, created.username, 'dsh', 'managed-data.jsonl')
    expect(readManagedDataPaths(inventory)).toEqual([
      { owner: '@deepseek-ai/dsh-userdoc-local', kind: 'directory', path: join(created.homePath, 'documents') },
    ])
    const before = await readFile(inventory)
    await expect(users.create({ username: created.username, password: 'pw-123456' })).rejects.toThrow('duplicate username')
    expect(await readFile(inventory)).toEqual(before)
    await pool.query(`CREATE FUNCTION harness.reject_test_user_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.username='commit-rejected' THEN RAISE EXCEPTION 'test user commit rejected'; END IF; RETURN NEW; END $$`)
    await pool.query(`CREATE CONSTRAINT TRIGGER reject_test_user_commit AFTER INSERT ON harness.users
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION harness.reject_test_user_commit()`)
    await expect(users.create({ username: 'commit-rejected', password: 'pw-123456' })).rejects.toThrow('test user commit rejected')
    expect((await pool.query("SELECT id FROM harness.users WHERE username='commit-rejected'")).rows).toEqual([])
    const orphanInventory = join(f.cfg.usersRoot, 'commit-rejected', 'dsh', 'managed-data.jsonl')
    expect(readManagedDataPaths(orphanInventory)[0]!.path).toBe(join(f.cfg.usersRoot, 'commit-rejected', 'home', 'documents'))
    expect(await readFile(inventory)).toEqual(before)
    await f.maintenance.enterMaintenance(null)
    const backup = await f.backups.create(null)
    expect(backup.managedSnapshot!.directories.some(row => row.path === join(created.homePath, 'documents'))).toBe(true)
    expect(backup.managedSnapshot!.roots.some(row => row.path.includes('commit-rejected'))).toBe(false)
  })

  it('keeps shallow legacy rows readable but ineligible for complete restoration', async () => {
    const f = await fixture()
    const result = await pool.query<{ id: string }>(`INSERT INTO harness.backup_records(organization_id,path,migration_version,write_epoch,managed_files,status)
      VALUES($1,'/legacy.dump',41,1,'[]','verified') RETURNING id`, [f.context.organizationId])
    const id = result.rows[0]!.id
    expect((await new PostgresBackupService(f.context).get(id)).managedSnapshot).toBeNull()
    await expect(f.backups.verify(id)).rejects.toThrow('lacks-complete-managed-data-manifest')
  })

  it('previews only verified applied node settings and keeps pending operations out of the result', async () => {
    const f = await fixture()
    f.claim('@deepseek-ai/dsh-session-persistence-jsonl', 'directory', join(f.dsh, 'sessions'))
    await new NodeConfigurationStore(f.context, f.cfg, f.environment, nodeConfigurationAuthority(f.context)).initialize()
    await f.maintenance.enterMaintenance(null)
    const record = await f.backups.create(null)
    const preview = await f.backups.previewNodeConfiguration(record.id)
    expect(preview).toEqual({ backupId: record.id, configFile: f.cfg.nodeConfigFile,
      appliedRevision: 0, values: expect.objectContaining({ HGW_USERS_ROOT: f.cfg.usersRoot }), incompatibleFields: [] })
    expect(Object.keys(preview)).not.toContain('operation')
    expect(Object.keys(preview.values!)).not.toContain('HGW_DATABASE_URL')
    const member = record.managedSnapshot!.files.find(file => file.sourcePath === f.cfg.nodeConfigFile)!
    await writeFile(join(backupFilesDirectory(record.path), member.member), '{}')
    await expect(f.backups.previewNodeConfiguration(record.id)).rejects.toThrow('digest mismatch')
  })

  it('excludes configuration mutations while a backup owns the data lease and allows readonly restart initialization', async () => {
    const f = await fixture(), store = new NodeConfigurationStore(f.context, f.cfg, f.environment, nodeConfigurationAuthority(f.context))
    await store.initialize()
    const before = await readFile(f.cfg.nodeConfigFile, 'utf8'), view = await store.view()
    const lease = await acquireDeploymentDataLock(pool)
    try {
      await store.initialize()
      await expect(store.save(f.context, view.revision, { ...view.desired, HGW_PORT: '9020' }))
        .rejects.toMatchObject({ message: 'deployment-data-operation-already-running' })
      expect(await readFile(f.cfg.nodeConfigFile, 'utf8')).toBe(before)
    } finally { await lease[Symbol.asyncDispose]() }
    expect((await store.save(f.context, view.revision, { ...view.desired, HGW_PORT: '9020' })).revision).toBe(view.revision + 1)
  })
})
