/** Real maintenance backups retain the entry's private project-name equality keys. */
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { createDeploymentCommands } from '../src/deployment-commands.ts'
import { activateProjectNameKey, prepareProjectNameKey } from '../src/node-content-project-names.ts'
import { createProjectNameKeyring, readProjectNameKeyring } from '../src/project-name-keyring.ts'
import { createPostgresPool, runMigrations, transaction } from '../src/postgres/database.ts'
import { backupFilesDirectory, PostgresDeploymentBackups } from '../src/postgres/deployment-backups.ts'
import { collectDeploymentData } from '../src/postgres/deployment-data.ts'
import { acquireDeploymentDataLock } from '../src/postgres/deployment-lock.ts'
import { verifyDeploymentProjectNameKey } from '../src/postgres/deployment-name-key.ts'
import { PostgresMaintenanceService } from '../src/postgres/maintenance-service.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { testConfig } from './test-config.ts'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
function command(value: string | undefined, executable: string): string[] {
  if (value === undefined) return [executable]
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed) || !parsed.length || parsed.some(arg => typeof arg !== 'string'))
    throw new Error('Invalid fixture PostgreSQL client command')
  return parsed as string[]
}

it.skipIf(databaseUrl === undefined)('copies and restores active and pending name keys without replacing fingerprints or granting authority', async () => {
  const database = `hgw_name_key_${randomUUID().replaceAll('-', '')}_test`
  const admin = createPostgresPool(databaseUrl!, { max: 1 })
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hgw-name-key-')))
  let created = false, pool: ReturnType<typeof createPostgresPool> | undefined
  try {
    await admin.query(`CREATE DATABASE "${database}"`); created = true
    const url = new URL(databaseUrl!); url.pathname = `/${database}`
    pool = createPostgresPool(url.href, { max: 4 })
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
    const slug = randomUUID(), node = 'name-key-node'
    const org = (await pool.query<{ id: string }>(
      "INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Name key backup') RETURNING id", [slug])).rows[0]!.id
    await pool.query('INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,$2)', [org, node])
    await pool.query('INSERT INTO harness.cluster_control(organization_id) VALUES($1)', [org])
    const context = await resolvePostgresRuntimeContext(pool, slug, node)
    const first = join(root, 'names-first.json'), file = join(root, 'names-current.json')
    await createProjectNameKeyring({ organizationId: org, nodeId: context.nodeId, keyId: 'first', file: first })
    await createProjectNameKeyring({ organizationId: org, nodeId: context.nodeId, keyId: 'next', file, previous: first })
    const ring = await readProjectNameKeyring(file, org, context.nodeId)
    const fingerprint = (id: string) => createHash('sha256').update(Buffer.from(ring.keys[id]!, 'base64')).digest('hex')
    const policy = await transaction(pool, async tx => {
      const prepared = await prepareProjectNameKey(tx, { organizationId: org, expectedRevision: null,
        keyId: 'first', fingerprint: fingerprint('first') })
      return activateProjectNameKey(tx, org, prepared.revision)
    })
    await transaction(pool, tx => prepareProjectNameKey(tx, { organizationId: org, expectedRevision: policy.revision,
      keyId: 'next', fingerprint: fingerprint('next') }))
    const cfg = testConfig(root, { HGW_PROJECT_NAME_KEY_FILE: file, HGW_ORGANIZATION_SLUG: slug, HGW_COMPUTE_NODE_NAME: node })
    const maintenance = new PostgresMaintenanceService(context, cfg.nodeStaleMs)
    await maintenance.enterMaintenance(null)
    const commands = createDeploymentCommands(command(process.env.HGW_TEST_PG_DUMP_COMMAND, 'pg_dump'),
      command(process.env.HGW_TEST_PG_RESTORE_COMMAND, 'pg_restore'))
    const backups = new PostgresDeploymentBackups(context, cfg, url.href, commands, {})
    const authority = async () => (await pool!.query(`SELECT 'keys' kind,to_jsonb(k) data FROM harness.project_name_keys k
      UNION ALL SELECT 'policy',to_jsonb(p) FROM harness.project_name_policies p
      UNION ALL SELECT 'claims',to_jsonb(c) FROM harness.project_name_claims c
      UNION ALL SELECT 'users',to_jsonb(u) FROM harness.users u
      UNION ALL SELECT 'instances',to_jsonb(i) FROM harness.instances i ORDER BY kind,data`)).rows
    const beforeAuthority = await authority(), bytes = await readFile(file)
    const beforeMac = createHmac('sha256', Buffer.from(ring.keys.first!, 'base64')).update('existing project').digest('hex')
    const record = await backups.create(null)
    expect(record.verifiedAt).not.toBeNull()
    expect(record.managedSnapshot!.roots).toContainEqual({ owner: 'gateway-project-name-key', kind: 'file', path: file })
    const files = backupFilesDirectory(record.path)
    expect(await verifyDeploymentProjectNameKey(record.managedSnapshot!, files, context, cfg)).toEqual([])
    expect((await backups.previewNodeConfiguration(record.id)).incompatibleFields).toEqual([])
    const allowed = await collectDeploymentData(context, cfg)
    await writeFile(file, await readFile(first), { mode: 0o600 })
    await expect(backups.create(null)).rejects.toMatchObject({ message: 'project-name-key-identity-mismatch' })
    expect(await authority()).toEqual(beforeAuthority)
    await commands.restoreManagedFiles(files, record.managedSnapshot!, allowed)
    expect(await readFile(file)).toEqual(bytes)
    const restored = await readProjectNameKeyring(file, org, context.nodeId)
    expect(createHmac('sha256', Buffer.from(restored.keys.first!, 'base64')).update('existing project').digest('hex')).toBe(beforeMac)
    expect(await authority()).toEqual(beforeAuthority)
    await expect(verifyDeploymentProjectNameKey({ ...record.managedSnapshot!,
      roots: record.managedSnapshot!.roots.filter(row => row.owner !== 'gateway-project-name-key') }, files, context, cfg))
      .rejects.toMatchObject({ message: 'backup-project-name-key-evidence-missing' })
    await expect(verifyDeploymentProjectNameKey(record.managedSnapshot!, files, { ...context, nodeId: randomUUID() }, cfg))
      .rejects.toMatchObject({ message: 'project-name-key-identity-mismatch' })
    await rm(file)
    await expect(backups.create(null)).rejects.toMatchObject({ message: 'project-name-key-identity-mismatch' })
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await authority()).toEqual(beforeAuthority)
    await commands.restoreManagedFiles(files, record.managedSnapshot!, allowed)
    await maintenance.beginRestore(null)
    await using lease = await acquireDeploymentDataLock(pool)
    await commands.restoreDump(record.path, url.href, lease, record.sha256!)
    await commands.restoreManagedFiles(files, record.managedSnapshot!, allowed, lease.signal)
    expect(await readFile(file)).toEqual(bytes)
    expect(await authority()).toEqual(beforeAuthority)
  } finally {
    await pool?.end()
    try { if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`) }
    finally { await admin.end(); await rm(root, { recursive: true, force: true }) }
  }
})
