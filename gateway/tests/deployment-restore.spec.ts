/** Real PostgreSQL restore commits business data and preserves the live maintenance fence atomically. */
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import { testConfig, testEnvironment } from './test-config.ts'
import { NodeConfigurationStore, readNodeConfiguration, writeNodeConfiguration } from '../src/node-config-store.ts'
import { createDeploymentCommands } from '../src/deployment-commands.ts'
import { defaultPgConnectionCommand, nativePgClient } from '../src/pg-client-protocol.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { PostgresMaintenanceService } from '../src/postgres/maintenance-service.ts'
import { PostgresBackupService } from '../src/postgres/backup-service.ts'
import { nodeConfigurationAuthority } from '../src/postgres/node-configuration-authority.ts'
import { acquireDeploymentDataLock } from '../src/postgres/deployment-lock.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { PostgresUserService } from '../src/postgres/user-service.ts'
import { PostgresNodeAccessService } from '../src/postgres/node-access-service.ts'
import { PostgresDeploymentTopology } from '../src/deployment-topology.ts'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = databaseUrl === undefined ? describe.skip : describe
const execute = promisify(execFile)
let pool: Pool
let directory: string
function command(value: string | undefined, executable: string): string[] {
  if (value === undefined) return [executable]
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some(part => typeof part !== 'string')) throw new Error('invalid PostgreSQL test command')
  return parsed as string[]
}

describePg('transactional PostgreSQL backup restore', () => {
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!, { max: 3 })
    await pool.query('DROP SCHEMA IF EXISTS harness CASCADE')
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
    directory = await realpath(await mkdtemp(join(tmpdir(), 'hgw-restore-acceptance-')))
  })
  afterAll(async () => {
    await pool?.end()
    if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  })

  it('restores data without rewinding control, ledger or backup identity and rolls back incompatible restores', async () => {
    const slug = randomUUID()
    const organization = (await pool.query<{ id: string }>(
      "INSERT INTO harness.organizations(slug,display_name) VALUES($1,'at backup') RETURNING id", [slug])).rows[0]!.id
    await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'restore-node')", [organization])
    await pool.query('INSERT INTO harness.cluster_control(organization_id) VALUES($1)', [organization])
    const context = await resolvePostgresRuntimeContext(pool, slug, 'restore-node')
    const maintenance = new PostgresMaintenanceService(context, 60_000)
    const backups = new PostgresBackupService(context)
    const commands = createDeploymentCommands(command(process.env.HGW_TEST_PG_DUMP_COMMAND, 'pg_dump'),
      command(process.env.HGW_TEST_PG_RESTORE_COMMAND, 'pg_restore'))
    await pool.query("UPDATE harness.deployment_topology SET enabled=true,primary_node_id=$2,primary_origin='https://backup-primary.test',revision=3 WHERE organization_id=$1", [organization, context.nodeId])
    const dump = await commands.backup(directory, databaseUrl!, [])
    const record = await backups.record({ path: dump.dumpPath, migrationVersion: 46, writeEpoch: 1n,
      sizeBytes: dump.sizeBytes, sha256: dump.sha256, managedSnapshot: dump.managedSnapshot, actor: null })
    await backups.setVerified(record.id, true)
    await pool.query("UPDATE harness.deployment_topology SET enabled=false,primary_origin='https://current-primary.test',revision=4 WHERE organization_id=$1", [organization])
    await pool.query("UPDATE harness.organizations SET display_name='after backup' WHERE id=$1", [organization])
    await using lease = await acquireDeploymentDataLock(pool)
    await expect(commands.restoreDump(dump.dumpPath, databaseUrl!, lease, dump.sha256)).rejects.toThrow('coordinated restoring window')
    expect((await pool.query('SELECT display_name FROM harness.organizations')).rows).toEqual([{ display_name: 'after backup' }])

    const baseline = await maintenance.currentWriteEpoch()
    await maintenance.enterMaintenance(null, 'restore proof')
    const operation = await maintenance.logOperation('restore', 'running', null, { backupId: record.id })
    await maintenance.beginRestore(null, record.id)
    await commands.restoreDump(dump.dumpPath, databaseUrl!, lease, dump.sha256)
    expect((await pool.query('SELECT display_name FROM harness.organizations')).rows).toEqual([{ display_name: 'at backup' }])
    expect((await pool.query('SELECT enabled,primary_origin,revision::text FROM harness.deployment_topology')).rows).toEqual([{ enabled: false, primary_origin: 'https://current-primary.test', revision: '4' }])
    const state = await maintenance.state()
    expect(state.mode).toBe('restoring')
    expect(BigInt(state.writeEpoch)).toBeGreaterThan(baseline)
    expect((await maintenance.writeGate(baseline)).verdict).toBe('stale-epoch')
    expect((await maintenance.listOperations()).find(row => row.id === operation)?.status).toBe('running')
    expect((await backups.get(record.id)).sha256).toBe(dump.sha256)
    await maintenance.completeRestore(null, record.id, { proof: true })
    expect((await backups.get(record.id)).status).toBe('restored')
    expect((await maintenance.state()).mode).toBe('maintenance')

    // Restore incompatibility is detected after SQL execution and still rolls back the whole transaction.
    await pool.query("UPDATE harness.organizations SET display_name='retained on rollback' WHERE id=$1", [organization])
    await maintenance.beginRestore(null, record.id)
    const incompatible = await commands.backup(directory, databaseUrl!, [])
    await pool.query('DELETE FROM harness.deployment_topology WHERE organization_id=$1', [organization])
    await pool.query('DELETE FROM harness.compute_nodes WHERE organization_id=$1', [organization])
    await pool.query('DELETE FROM harness.organizations WHERE id=$1', [organization])
    const other = (await pool.query<{ id: string }>(
      "INSERT INTO harness.organizations(slug,display_name) VALUES($1,'different destination') RETURNING id", [randomUUID()])).rows[0]!.id
    await pool.query("INSERT INTO harness.cluster_control(organization_id,mode,write_epoch) VALUES($1,'restoring',42)", [other])
    await expect(commands.restoreDump(incompatible.dumpPath, databaseUrl!, lease, incompatible.sha256)).rejects.toThrow('organization identity differs')
    expect((await pool.query('SELECT id,display_name FROM harness.organizations')).rows)
      .toEqual([{ id: other, display_name: 'different destination' }])
    expect((await pool.query('SELECT mode,write_epoch::text FROM harness.cluster_control')).rows)
      .toEqual([{ mode: 'restoring', write_epoch: '42' }])
  }, 30_000)

  it('preserves a current enrollment and its historical issuer when the backup predates that administrator', async () => {
    await pool.query('DROP SCHEMA harness CASCADE')
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
    const slug = randomUUID()
    const organization = (await pool.query<{ id: string }>(
      "INSERT INTO harness.organizations(slug,display_name) VALUES($1,'issuer history') RETURNING id", [slug])).rows[0]!.id
    for (const name of ['issuer-entry', 'prepared-worker']) {
      await pool.query('INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,$2)', [organization, name])
    }
    await pool.query('INSERT INTO harness.cluster_control(organization_id) VALUES($1)', [organization])
    const context = await resolvePostgresRuntimeContext(pool, slug, 'issuer-entry')
    const cfg = testConfig(join(directory, 'issuer-history'))
    const users = new PostgresUserService(context, cfg)
    const original = await users.create({ username: 'original-admin', password: 'test-password', role: 'admin' })
    const topology = new PostgresDeploymentTopology(context, { legacyForwarding: false, refreshAfterMs: 30000,
      pageSize: 10, maxBytes: 65536, allowedOrigins: ['https://issuer.example.test'] })
    await topology.save(original, { revision: '0', enabled: true, primaryOrigin: 'https://issuer.example.test' })
    const commands = createDeploymentCommands(command(process.env.HGW_TEST_PG_DUMP_COMMAND, 'pg_dump'),
      command(process.env.HGW_TEST_PG_RESTORE_COMMAND, 'pg_restore'))
    const dump = await commands.backup(join(directory, 'issuer-backups'), databaseUrl!, [])
    // A pre-migration schema must fail atomically rather than restoring an incompatible history constraint.
    await pool.query(`ALTER TABLE harness.node_agent_enrollments ADD CONSTRAINT node_agent_enrollments_created_by_organization_id_fkey
      FOREIGN KEY(created_by,organization_id) REFERENCES harness.users(id,organization_id)`)
    const incompatible = await commands.backup(join(directory, 'issuer-backups'), databaseUrl!, [])
    await pool.query('ALTER TABLE harness.node_agent_enrollments DROP CONSTRAINT node_agent_enrollments_created_by_organization_id_fkey')
    const later = await users.create({ username: 'later-admin', password: 'test-password', role: 'admin' })
    const nodes = new PostgresNodeAccessService(context, cfg.nodeAccess, cfg.runtimeCatalog)
    const worker = (await pool.query<{ id: string }>("SELECT id FROM harness.compute_nodes WHERE organization_id=$1 AND name='prepared-worker'", [organization])).rows[0]!.id
    const ticket = await nodes.issue(later, { requestId: randomUUID(), nodeId: worker })
    const issued = (await pool.query('SELECT created_by FROM harness.node_agent_enrollments WHERE id=$1', [ticket.enrollmentId])).rows[0].created_by
    const maintenance = new PostgresMaintenanceService(context, 60_000)
    await maintenance.enterMaintenance(null)
    await maintenance.beginRestore(null)
    await using lease = await acquireDeploymentDataLock(pool)
    await expect(commands.restoreDump(incompatible.dumpPath, databaseUrl!, lease, incompatible.sha256)).rejects.toThrow('requires migration 102')
    expect(await users.getById(later.id)).not.toBeNull()
    await commands.restoreDump(dump.dumpPath, databaseUrl!, lease, dump.sha256)
    expect(await users.getById(later.id)).toBeNull()
    expect((await pool.query('SELECT id,node_id,created_by FROM harness.node_agent_enrollments WHERE organization_id=$1', [organization])).rows)
      .toEqual([{ id: ticket.enrollmentId, node_id: worker, created_by: issued }])
    expect(await topology.read()).toMatchObject({ mode: 'multi', revision: '2', primary: { nodeId: context.nodeId } })
    await expect(nodes.mutate(later, worker, { action: 'detach', revision: ticket.revision })).rejects.toMatchObject({ code: 'node-access/forbidden' })
    await expect(nodes.enroll(ticket.token, { protocolVersion: 1, platform: 'linux', architecture: 'x64',
      credential: `dsh_node_${randomBytes(32).toString('base64url')}` })).resolves.toMatchObject({ nodeId: worker })
  }, 30_000)

  it('keeps serving closed after a partial file restore and lets an independent applier finish recovery', async () => {
    await pool.query('DROP SCHEMA harness CASCADE')
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
    const slug = randomUUID()
    const organization = (await pool.query<{ id: string }>(
      "INSERT INTO harness.organizations(slug,display_name) VALUES($1,'file restoration') RETURNING id", [slug])).rows[0]!.id
    await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'file-node')", [organization])
    await pool.query('INSERT INTO harness.cluster_control(organization_id) VALUES($1)', [organization])
    const context = await resolvePostgresRuntimeContext(pool, slug, 'file-node')
    const maintenance = new PostgresMaintenanceService(context, 60_000), backups = new PostgresBackupService(context)
    const keys = join(directory, 'owned-keys'), first = join(keys, 'a.key'), last = join(keys, 'z.key')
    await mkdir(keys)
    await writeFile(first, 'first saved')
    await writeFile(last, 'last saved')
    const pgDump = command(process.env.HGW_TEST_PG_DUMP_COMMAND, 'pg_dump')
    const pgRestore = command(process.env.HGW_TEST_PG_RESTORE_COMMAND, 'pg_restore')
    const urlFile = join(directory, 'database-url')
    await writeFile(urlFile, databaseUrl!, { mode: 0o600 })
    const env = testEnvironment(directory, { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(HGW_|DEEPSEEK_|DSH_GATEWAY_)/u.test(key))), TSX_TSCONFIG_PATH: resolve(import.meta.dirname, '../tsconfig.run.json'), HGW_DATABASE_URL: '', HGW_DATABASE_URL_FILE: urlFile,
      HGW_ORGANIZATION_SLUG: slug, HGW_COMPUTE_NODE_NAME: 'file-node',
      HGW_STATE_ROOT: join(directory, 'state'), HGW_PRINCIPAL_KEY_DIR: keys,
      HGW_BACKUP_DIR: join(directory, 'protection-backups'), HGW_DEFAULT_ENV_FILE: '', HGW_PUBLIC_ORIGINS: 'http://127.0.0.1:8899',
      HGW_USERS_ROOT: join(directory, 'users'), HGW_PROJECTS_ROOT: join(directory, 'projects'),
      HGW_PGDUMP_COMMAND: pgDump.map(arg => JSON.stringify(arg)).join(' '),
      HGW_PGRESTORE_COMMAND: pgRestore.map(arg => JSON.stringify(arg)).join(' ') })
    const cfg = testConfig(directory, env)
    await new NodeConfigurationStore(context, cfg, env, nodeConfigurationAuthority(context)).initialize()
    const initialConfig = (await readNodeConfiguration(cfg.nodeConfigFile, env))!
    const oldConfig = { ...initialConfig, revision: 1, desired: { ...initialConfig.desired, HGW_PORT: '9019' },
      operation: { id: randomUUID(), revision: 1, writeEpoch: String(await maintenance.currentWriteEpoch()),
        actor: null, status: 'pending' as const, requestedAt: new Date().toISOString(), error: null } }
    await writeNodeConfiguration(cfg.nodeConfigFile, oldConfig)
    const dump = await createDeploymentCommands(pgDump, pgRestore).backup(join(directory, 'files-proof'), databaseUrl!, [{ owner: 'gateway-principal', kind: 'directory', path: keys },
      { owner: 'gateway-database-connection', kind: 'file', path: urlFile },
      { owner: 'gateway-node-configuration', kind: 'file', path: cfg.nodeConfigFile }])
    const record = await backups.record({ path: dump.dumpPath, migrationVersion: 46, writeEpoch: 1n,
      sizeBytes: dump.sizeBytes, sha256: dump.sha256, managedSnapshot: dump.managedSnapshot, actor: null })
    await backups.setVerified(record.id, true)
    await writeFile(first, 'first changed')
    await writeFile(last, 'last changed')
    await writeFile(join(keys, 'after-backup.key'), 'newer preserved data')
    const currentConfig = { ...initialConfig, revision: 8, appliedRevision: 8,
      desired: { ...initialConfig.desired, HGW_PORT: '9020' }, applied: { ...initialConfig.applied, HGW_PORT: '9020' } }
    await writeNodeConfiguration(cfg.nodeConfigFile, currentConfig)
    const currentConfigBytes = await readFile(cfg.nodeConfigFile, 'utf8')
    await pool.query("UPDATE harness.organizations SET display_name='current database'")
    const injected = join(directory, 'owned-rename-failure.mjs')
    await writeFile(injected, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module'
      const rename = fs.promises.rename
      fs.promises.rename = async (source, target) => {
        if (target === ${JSON.stringify(last)} && String(source).includes('.hgw-restore-')) {
          throw Object.assign(new Error('owned fixture copy failure'), { code: 'EIO' })
        }
        return rename(source, target)
      }
      syncBuiltinESMExports()
    `)
    const restore = (inject = false, recover = false) => execute(process.execPath, [...(inject ? ['--import', injected] : []), '--import', import.meta.resolve('tsx/esm'),
      resolve(import.meta.dirname, '../scripts/deploy-apply.ts'), 'restore', ...(recover ? [] : ['--backup', record.id]), '--grace-ms', '0'],
    { env, timeout: 20_000, maxBuffer: 64 * 1024 })
    await maintenance.enterMaintenance(null)
    await writeNodeConfiguration(cfg.nodeConfigFile, { ...currentConfig,
      applied: { ...currentConfig.applied, HGW_USERS_ROOT: join(directory, 'unmigrated-users') } })
    await expect(restore()).rejects.toMatchObject({ code: 1, killed: false,
      stderr: expect.stringContaining('backup-data-paths-require-explicit-migration:HGW_USERS_ROOT') })
    expect((await pool.query('SELECT display_name FROM harness.organizations')).rows).toEqual([{ display_name: 'current database' }])
    expect((await maintenance.state()).mode).toBe('maintenance')
    expect(await readFile(first, 'utf8')).toBe('first changed')
    await writeNodeConfiguration(cfg.nodeConfigFile, currentConfig)
    await expect(restore(true)).rejects.toMatchObject({ code: 1, killed: false, stderr: expect.stringContaining('owned fixture copy failure') })
    expect(await readFile(first, 'utf8')).toBe('first saved')
    expect((await maintenance.state()).mode).toBe('restoring')
    expect((await backups.get(record.id)).status).toBe('verified')
    await expect(maintenance.exitMaintenance(null)).rejects.toMatchObject({ message: 'restore-in-progress' })
    expect(await readFile(last, 'utf8')).toBe('last changed')
    const checkpoint = (await maintenance.listOperations()).find(row => (row.detail as { checkpointVersion?: unknown }).checkpointVersion === 1)!
    const protectionId = (checkpoint.detail as { protectionId: string }).protectionId
    const protectedBefore = await backups.get(protectionId)
    const preservedFirst = protectedBefore.managedSnapshot!.files.find(file => file.sourcePath === first)!
    expect(await readFile(join(protectedBefore.path.replace(/\.dump$/u, '.files'), preservedFirst.member), 'utf8')).toBe('first changed')
    await expect(execute(process.execPath, ['--import', import.meta.resolve('tsx/esm'),
      resolve(import.meta.dirname, '../scripts/deploy-apply.ts'), 'restore', '--dump', dump.dumpPath, '--grace-ms', '0'],
    { env, timeout: 20_000, maxBuffer: 64 * 1024 })).rejects.toMatchObject({ code: 1, killed: false,
      stderr: expect.stringContaining('restore-recovery-target-mismatch') })
    expect((await restore(false, true)).stdout).toContain('restore=ok')
    expect(await readFile(last, 'utf8')).toBe('last saved')
    await expect(readFile(join(keys, 'after-backup.key'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(cfg.nodeConfigFile, 'utf8')).toBe(currentConfigBytes)
    const reviewed = (await readNodeConfiguration(cfg.nodeConfigFile, env))!
    expect(reviewed).toMatchObject({ revision: 8, appliedRevision: 8, operation: null, applied: { HGW_PORT: '9020' } })
    expect(await readFile(urlFile, 'utf8')).toBe(databaseUrl)
    expect((await backups.get(protectionId)).sha256).toBe(protectedBefore.sha256)
    expect((await backups.list()).filter(row => row.id !== record.id)).toHaveLength(1)
    expect((await backups.get(record.id)).status).toBe('restored')
    expect((await maintenance.exitMaintenance(null)).mode).toBe('serving')
  }, 30_000)

  it('excludes a new applier while detached restore SQL survives its local command proxy and rolls it back on lease loss', async () => {
    await pool.query('DROP SCHEMA harness CASCADE')
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
    const slug = randomUUID(), marker = `f03-sql-${randomUUID()}`, barrier = `f03-barrier-${randomUUID()}`
    const organization = (await pool.query<{ id: string }>(
      "INSERT INTO harness.organizations(slug,display_name) VALUES($1,'backup data') RETURNING id", [slug])).rows[0]!.id
    await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'proxy-node')", [organization])
    await pool.query('INSERT INTO harness.cluster_control(organization_id) VALUES($1)', [organization])
    const context = await resolvePostgresRuntimeContext(pool, slug, 'proxy-node')
    const maintenance = new PostgresMaintenanceService(context, 60_000)
    const pgDump = command(process.env.HGW_TEST_PG_DUMP_COMMAND, 'pg_dump')
    const pgRestore = command(process.env.HGW_TEST_PG_RESTORE_COMMAND, 'pg_restore')
    const psql = pgRestore.map(part => part.endsWith('pg_restore') ? part.slice(0, -'pg_restore'.length) + 'psql' : part)
    const normal = createDeploymentCommands(pgDump, pgRestore, psql)
    const dump = await normal.backup(join(directory, 'proxy-proof'), databaseUrl!, [])
    await pool.query("UPDATE harness.organizations SET display_name='current data'")
    await maintenance.enterMaintenance(null)
    await maintenance.beginRestore(null)
    const proxy = join(directory, 'detached-psql-proxy.mjs'), pidFile = join(directory, 'detached-psql.pid')
    await writeFile(proxy, `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs'
      const argv = ${JSON.stringify(nativePgClient(psql) ? [...defaultPgConnectionCommand(), ...psql] : psql)}
      const child = spawn(argv[0], [...argv.slice(1), ...process.argv.slice(2)], { stdio: ['pipe', 'pipe', 'pipe'] })
      const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code ?? 1)) })
      writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))
      child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr)
      child.stdin.on('error', () => {})
      const chunks = []; let prefix = Buffer.alloc(0), framed = false
      for await (const chunk of process.stdin) {
        if (framed) { chunks.push(chunk); continue }
        prefix = Buffer.concat([prefix, chunk])
        if (prefix.length < 4 || prefix.length < 4 + prefix.readUInt32BE()) continue
        const size = 4 + prefix.readUInt32BE()
        child.stdin.write(prefix.subarray(0, size)); chunks.push(prefix.subarray(size)); framed = true
      }
      const script = Buffer.concat(chunks).toString('utf8')
      const point = '-- Verify the same coordinating lease before committing.'
      if (!script.includes(point)) throw new Error('SQL barrier insertion point is absent')
      child.stdin.end(${JSON.stringify(`SET application_name='${marker}';\n`)} + script.replace(point,
        ${JSON.stringify(`SELECT pg_advisory_xact_lock(hashtext('${barrier}'));\n`)} + point))
      process.exitCode = await exited
    `)
    const blocker = await pool.connect()
    await blocker.query('SELECT pg_advisory_lock(hashtext($1))', [barrier])
    const lease = await acquireDeploymentDataLock(pool)
    const wrapped = createDeploymentCommands(pgDump, pgRestore, [process.execPath, proxy])
    const restoring = wrapped.restoreDump(dump.dumpPath, databaseUrl!, lease, dump.sha256)
      .then(() => undefined, (error: unknown) => error)
    let backend: number | undefined
    try {
      await vi.waitFor(async () => {
        const result = await pool.query<{ pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [marker])
        backend = result.rows[0]?.pid
        expect(backend).toBeDefined()
      }, { timeout: 10_000, interval: 25 })
      await pool.query('SELECT pg_terminate_backend($1)', [lease.owner.pid])
      await vi.waitFor(() => { expect(lease.signal.aborted).toBe(true) })
      expect(await restoring).toBeInstanceOf(Error)
      expect((await pool.query('SELECT pid FROM pg_stat_activity WHERE pid=$1', [backend])).rowCount).toBe(1)
      await lease[Symbol.asyncDispose]()
      await expect(acquireDeploymentDataLock(pool)).rejects.toMatchObject({ message: 'deployment-sql-operation-still-running' })
      await blocker.query('SELECT pg_advisory_unlock(hashtext($1))', [barrier])
      await vi.waitFor(async () => {
        expect((await pool.query('SELECT pid FROM pg_stat_activity WHERE application_name=$1', [marker])).rowCount).toBe(0)
      }, { timeout: 10_000, interval: 25 })
      const remotePid = Number(await readFile(pidFile, 'utf8'))
      await vi.waitFor(() => { expect(() => process.kill(remotePid, 0)).toThrow() })
      expect((await pool.query('SELECT display_name FROM harness.organizations')).rows).toEqual([{ display_name: 'current data' }])
      expect((await maintenance.state()).mode).toBe('restoring')
      await using retry = await acquireDeploymentDataLock(pool)
      await normal.restoreDump(dump.dumpPath, databaseUrl!, retry, dump.sha256)
      expect((await pool.query('SELECT display_name FROM harness.organizations')).rows).toEqual([{ display_name: 'backup data' }])
    } finally {
      await lease[Symbol.asyncDispose]()
      await blocker.query('SELECT pg_advisory_unlock(hashtext($1))', [barrier])
      blocker.release()
      await pool.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1', [marker])
      await restoring
    }
  }, 30_000)
})
