/** Complete backup, registry request and standalone applier against an owned database. */
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { copyFile, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { createPostgresPool, migrationPlan, runMigrations, verifyReleaseMigrationLedger } from '../src/postgres/database.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { PostgresDeploymentBackups } from '../src/postgres/deployment-backups.ts'
import { PostgresMaintenanceService } from '../src/postgres/maintenance-service.ts'
import { PostgresBackupService, type BackupRecordView } from '../src/postgres/backup-service.ts'
import { createDeploymentCommands } from '../src/deployment-commands.ts'
import { NodeConfigurationStore } from '../src/node-config-store.ts'
import { nodeConfigurationAuthority } from '../src/postgres/node-configuration-authority.ts'
import { testConfig, testEnvironment } from './test-config.ts'

const gateway = resolve(import.meta.dirname, '..')
const projectMigrations = join(gateway, 'deploy/postgres/migrations')
const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const execute = promisify(execFile)
const scenarios = ['same-schema', 'legacy-schema', 'before-takeover', 'before-retirement',
  'previous-version', 'checksum-drift', 'name-drift', 'missing-migration', 'insert-export'] as const

function command(value: string | undefined, fallback: string): string[] {
  if (value === undefined) return [fallback]
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some(arg => typeof arg !== 'string')) {
    throw new Error('Invalid PostgreSQL fixture command')
  }
  return parsed
}

it.skipIf(databaseUrl === undefined).each(scenarios)(
  'restores matching schemas and refuses incompatible archives before changing the fence: %s', async scenario => {
    const root = await mkdtemp(join(tmpdir(), 'hgw-restore-schema-'))
    const database = `hgw_schema_${randomUUID().replaceAll('-', '')}_test`
    const admin = createPostgresPool(databaseUrl!, { max: 1 })
    let pool: ReturnType<typeof createPostgresPool> | undefined, created = false
    try {
      await admin.query(`CREATE DATABASE "${database}"`)
      created = true
      const url = new URL(databaseUrl!)
      url.pathname = `/${database}`
      pool = createPostgresPool(url.href, { max: 4 })
      const currentMigrations = join(root, 'migrations-current'), migrations = join(root, 'migrations-source')
      await mkdir(currentMigrations)
      await mkdir(migrations)
      const files = (await readdir(projectMigrations)).filter(name => /^[0-9]+_.+\.sql$/u.test(name))
        .sort((a, b) => Number(a.split('_')[0]) - Number(b.split('_')[0]))
      const maximum = Number(files.at(-1)!.split('_')[0])
      const sourceMaximum = scenario === 'legacy-schema' ? 107
        : scenario === 'before-takeover' ? 114
          : scenario === 'before-retirement' ? 115
            : scenario === 'previous-version' ? maximum - 1 : maximum
      for (const file of files) {
        await copyFile(join(projectMigrations, file), join(currentMigrations, file))
        if (Number(file.split('_')[0]) <= sourceMaximum) await copyFile(join(projectMigrations, file), join(migrations, file))
      }
      await runMigrations(pool, migrations)
      const slug = `schema-${randomUUID()}`, node = 'schema-node'
      const organization = (await pool.query<{ id: string }>(
        "INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Synthetic restore') RETURNING id", [slug])).rows[0]!.id
      await pool.query('INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,$2)', [organization, node])
      await pool.query('INSERT INTO harness.cluster_control(organization_id) VALUES($1)', [organization])
      const context = await resolvePostgresRuntimeContext(pool, slug, node)
      const env = testEnvironment(root, {
        HGW_ORGANIZATION_SLUG: slug, HGW_COMPUTE_NODE_NAME: node, HGW_DEPLOY_MIGRATIONS_DIR: migrations,
        HGW_DATABASE_URL: url.href, HGW_DEFAULT_ENV_FILE: '', HGW_MANAGED_DATA_APPROVAL_FILE: join(root, 'approved.jsonl'),
      })
      const cfg = testConfig(root, env)
      await mkdir(cfg.stateRoot, { recursive: true, mode: 0o700 })
      await writeFile(cfg.managedDataApprovalFile!, '', { mode: 0o600 })
      await writeFile(cfg.organizationModelCredentialKeyFile, Buffer.alloc(32, 7), { mode: 0o600 })
      await new NodeConfigurationStore(context, cfg, env, nodeConfigurationAuthority(context)).initialize()
      const maintenance = new PostgresMaintenanceService(context, cfg.nodeStaleMs)
      const pgDump = command(process.env.HGW_TEST_PG_DUMP_COMMAND, 'pg_dump')
      const pgRestore = command(process.env.HGW_TEST_PG_RESTORE_COMMAND, 'pg_restore')
      const commands = createDeploymentCommands(scenario === 'insert-export' ? [...pgDump, '--inserts'] : pgDump, pgRestore)
      const backups = new PostgresDeploymentBackups(context, cfg, url.href, commands, env)
      let record: BackupRecordView
      if (sourceMaximum === maximum) {
        await maintenance.enterMaintenance(null)
        record = await backups.create(null)
      } else {
        // Capture the old schema with native PostgreSQL before running the current Gateway.
        const dump = await commands.backup(cfg.backupDir, url.href, [{
          owner: 'gateway', kind: 'file', path: cfg.organizationModelCredentialKeyFile,
        }])
        await commands.verifyDump(dump.dumpPath, undefined, dump.sha256)
        await runMigrations(pool, currentMigrations)
        const state = await maintenance.enterMaintenance(null)
        const registry = new PostgresBackupService(context)
        const registered = await registry.record({
          path: dump.dumpPath, migrationVersion: sourceMaximum, writeEpoch: BigInt(state.writeEpoch),
          sizeBytes: dump.sizeBytes, sha256: dump.sha256, managedSnapshot: dump.managedSnapshot, actor: null,
        })
        record = await registry.setVerified(registered.id, true)
      }
      expect(record.status).toBe('verified')
      expect(record.managedSnapshot!.files.length).toBeGreaterThan(0)
      expect(record.migrationVersion).toBe(sourceMaximum)
      if (scenario === 'checksum-drift') {
        await pool.query("UPDATE harness.schema_migrations SET checksum=repeat('f',64) WHERE version=$1", [maximum])
      }
      if (scenario === 'name-drift') {
        await pool.query("UPDATE harness.schema_migrations SET name=name||'_different' WHERE version=$1", [maximum])
      }
      if (scenario === 'missing-migration') await pool.query('DELETE FROM harness.schema_migrations WHERE version=1')
      const requestError: unknown = await maintenance.requestRestore(null, record.id).then(() => undefined, (error: unknown) => error)
      if (sourceMaximum === maximum) expect(requestError).toBeUndefined()
      else expect(requestError).toMatchObject({ status: 409, message: 'backup-schema-version-mismatch' })
      const fullEnv = {
        ...process.env, ...env, HGW_DEPLOY_MIGRATIONS_DIR: currentMigrations,
        HGW_PGDUMP_COMMAND: pgDump.map(arg => JSON.stringify(arg)).join(' '),
        HGW_PGRESTORE_COMMAND: pgRestore.map(arg => JSON.stringify(arg)).join(' '),
        TSX_TSCONFIG_PATH: join(gateway, 'tsconfig.run.json'),
      }
      async function apply(flags: string[] = []) {
        try {
          const value = await execute(process.execPath, ['--import', import.meta.resolve('tsx/esm'),
            join(gateway, 'scripts/deploy-apply.ts'), 'restore', ...flags, '--grace-ms', '0'],
          { env: fullEnv, timeout: 45000, maxBuffer: 512 * 1024 })
          return { exit: 0, output: value.stdout, error: value.stderr }
        } catch (error) {
          const result = error as { code?: unknown; stdout?: string; stderr?: string }
          return { exit: result.code, output: result.stdout ?? '', error: result.stderr ?? '' }
        }
      }
      const result = await apply(requestError === undefined ? [] : ['--backup', record.id])
      const directDump = scenario === 'same-schema' ? undefined : await apply(['--dump', record.path])
      const state = await maintenance.state()
      const records = await new PostgresBackupService(context).list()
      const protection = records.find(item => item.id !== record.id)
      const expected = (await readFile(new URL('./expected/deployment-schema-preflight.jsonl', import.meta.url), 'utf8'))
        .trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>).find(item => item.scenario === scenario)
      expect({ scenario, requestAccepted: requestError === undefined, restoreCompleted: result.exit === 0,
        backupIdRefused: result.exit !== 0, dumpPathRefused: directDump !== undefined && directDump.exit !== 0,
        mode: state.mode, protectionCreated: protection !== undefined }).toEqual(expected)
      if (scenario === 'same-schema') {
        expect(result.exit).toBe(0)
      } else {
        const code = scenario === 'insert-export' ? 'backup-schema-metadata-unreadable' : 'backup-schema-differs-from-destination'
        expect(result.error).toContain(code)
        expect(directDump?.error).toContain(code)
        expect(await maintenance.listOperations()).not.toContainEqual(expect.objectContaining({ kind: 'restore', status: 'pending' }))
      }
    } finally {
      try { await pool?.end() } finally {
        try { if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`) }
        finally { try { await admin.end() } finally { await rm(root, { recursive: true, force: true }) } }
      }
    }
  }, 120000)

it.skipIf(databaseUrl === undefined).each([130, 131])(
  'upgrades the published push-only ledger through version %s in a quiesced deployment', async legacyVersion => {
    const root = await mkdtemp(join(tmpdir(), 'hgw-push-schema-'))
    const database = `hgw_push_${randomUUID().replaceAll('-', '')}_test`
    const admin = createPostgresPool(databaseUrl!, { max: 1 })
    let pool: ReturnType<typeof createPostgresPool> | undefined, created = false
    try {
      await admin.query(`CREATE DATABASE "${database}"`)
      created = true
      const url = new URL(databaseUrl!)
      url.pathname = `/${database}`
      pool = createPostgresPool(url.href, { max: 4 })
      const legacy = join(root, 'legacy'), candidate = join(root, 'candidate')
      await mkdir(legacy)
      await mkdir(candidate)
      const files = (await readdir(projectMigrations)).filter(name => /^\d{3}_.+\.sql$/u.test(name)).sort()
      for (const file of files) {
        await copyFile(join(projectMigrations, file), join(candidate, file))
        if (Number(file.slice(0, 3)) <= 129) await copyFile(join(projectMigrations, file), join(legacy, file))
      }
      await copyFile(join(candidate, '144_push_delivery_outcomes.sql'), join(legacy, '130_push_delivery_outcomes.sql'))
      if (legacyVersion === 131) {
        await copyFile(join(candidate, '145_unifiedpush_provider.sql'), join(legacy, '131_unifiedpush_provider.sql'))
      }
      await runMigrations(pool, legacy)
      const slug = `push-${randomUUID()}`, node = 'push-node'
      const organization = (await pool.query<{ id: string }>(
        "INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Push upgrade') RETURNING id", [slug],
      )).rows[0]!.id
      await pool.query('INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,$2)', [organization, node])
      await pool.query('INSERT INTO harness.cluster_control(organization_id) VALUES($1)', [organization])
      const account = (await pool.query<{ id: string }>(`INSERT INTO harness.users(organization_id,username,display_name,home_path)
        VALUES($1,'fixture','Fixture','/unused') RETURNING id`, [organization])).rows[0]!.id
      const provider = legacyVersion === 131 ? 'unifiedpush' : 'jpush'
      await pool.query(`INSERT INTO harness.push_devices(organization_id,user_id,token,provider,platform)
        VALUES($1,$2,'fixture-token',$3,'android')`, [organization, account, provider])
      const ledgerSql = 'SELECT version,name,checksum,applied_at FROM harness.schema_migrations WHERE version>=130 ORDER BY version'
      const original = (await pool.query<{ version: number; name: string; checksum: string; applied_at: Date }>(ledgerSql)).rows
      const relocations = original.map(({ version }) => ({ from: version, to: version + 14 }))
      const pending = files.slice(129).filter(file => !relocations.some(({ to }) => to === Number(file.slice(0, 3))))
      expect(await migrationPlan(pool, candidate)).toMatchObject({
        relocations, drifted: [], pending: pending.map(name => ({ version: Number(name.slice(0, 3)), name })),
      })
      expect(await verifyReleaseMigrationLedger(pool, candidate, false)).toBe(false)
      await expect(runMigrations(pool, candidate)).rejects.toThrow('requires coordinated deploy-apply')

      const env = testEnvironment(root, {
        HGW_ORGANIZATION_SLUG: slug, HGW_COMPUTE_NODE_NAME: node, HGW_DEPLOY_MIGRATIONS_DIR: candidate,
        HGW_DATABASE_URL: url.href, TSX_TSCONFIG_PATH: join(gateway, 'tsconfig.run.json'),
      })
      const deploy = (verb: 'status' | 'apply') => execute(process.execPath, [
        '--import', import.meta.resolve('tsx/esm'), join(gateway, 'scripts/deploy-apply.ts'), verb, '--grace-ms', '0',
      ], { env: { PATH: process.env.PATH, ...env }, timeout: 45000 })
      expect((await deploy('status')).stdout).toContain(`migration_relocations=${relocations.map(({ from, to }) => `${from}->${to}`).join(',')}`)
      await expect(deploy('apply')).rejects.toMatchObject({ stderr: expect.stringContaining('push-upgrade-requires-maintenance') })
      await pool.query(`UPDATE harness.cluster_control SET mode='maintenance', maintenance_epoch=1
        WHERE organization_id=$1`, [organization])
      await pool.query(`UPDATE harness.compute_nodes SET last_heartbeat_at=now(), maintenance_applied_epoch=1,inflight_writes=1
        WHERE organization_id=$1`, [organization])
      await expect(deploy('apply')).rejects.toMatchObject({ stderr: expect.stringContaining('writers-not-quiesced') })
      await pool.query(`UPDATE harness.compute_nodes SET inflight_writes=0,last_heartbeat_at=NULL
        WHERE organization_id=$1`, [organization])

      await pool.query("UPDATE harness.schema_migrations SET checksum=repeat('f',64) WHERE version=130")
      expect((await migrationPlan(pool, candidate)).drifted).toContain(130)
      await expect(runMigrations(pool, candidate, { verifyPushUpgrade: async () => {
        throw new Error('Unrecognized ledger was admitted to the push upgrade')
      } })).rejects.toThrow('differs from the applied checksum')
      await pool.query('UPDATE harness.schema_migrations SET checksum=$1 WHERE version=130', [original[0]!.checksum])

      const brokenPath = join(candidate, '143_peer_backup_repository_retirement.sql')
      await writeFile(brokenPath, "DO $$ BEGIN RAISE EXCEPTION 'fixture migration failure'; END $$;\n")
      await expect(deploy('apply')).rejects.toMatchObject({ stderr: expect.stringContaining('fixture migration failure') })
      expect((await pool.query(ledgerSql)).rows).toEqual(original)
      expect((await pool.query("SELECT to_regprocedure('harness.node_physically_isolated(uuid,uuid)') AS routine")).rows)
        .toEqual([{ routine: null }])
      await copyFile(join(projectMigrations, '143_peer_backup_repository_retirement.sql'), brokenPath)

      expect(JSON.parse((await deploy('apply')).stdout)).toEqual({
        applied: pending.map(name => Number(name.slice(0, 3))), current: files.length, relocations,
      })
      expect(await verifyReleaseMigrationLedger(pool, candidate, true)).toBe(true)
      expect(await verifyReleaseMigrationLedger(pool, legacy, true)).toBe(false)
      expect(await runMigrations(pool, candidate)).toEqual({ applied: [], current: files.length })
      expect((await pool.query(ledgerSql)).rows).toEqual(expect.arrayContaining(original.map(row => ({
        ...row, version: row.version + 14, name: `${row.version + 14}${row.name.slice(3)}`,
      }))))
      expect((await pool.query('SELECT user_id,provider,token FROM harness.push_devices WHERE organization_id=$1', [organization])).rows)
        .toEqual([{ user_id: account, provider, token: 'fixture-token' }])
    } finally {
      try { await pool?.end() } finally {
        try { if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`) }
        finally { try { await admin.end() } finally { await rm(root, { recursive: true, force: true }) } }
      }
    }
  }, 120000)
