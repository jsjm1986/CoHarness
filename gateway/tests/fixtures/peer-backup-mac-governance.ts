/** Seed and capture governance in a new Mac-only PostgreSQL Unix socket cluster. Never accepts a network database URL. */
import { randomBytes, randomUUID } from 'node:crypto'
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { userInfo } from 'node:os'
import { Pool } from 'pg'
import { z } from 'zod'
import { runMigrations } from '../../src/postgres/database.ts'
import { PeerControlExporter } from '../../src/peer-backup-control-export.ts'
import { PeerBackupRestic } from '../../src/peer-backup-restic.ts'

const configPath = process.argv[2]
if (process.platform !== 'darwin' || !configPath) throw new Error('isolated Mac fixture required')
const directory = await realpath(dirname(resolve(configPath)))
if (!directory.startsWith('/private/tmp/hgw-peer-test-')) throw new Error('private synthetic workspace required')
const config = z
  .object({
    restic: z.string(),
    origin: z.string(),
    organizationId: z.uuid(),
    sourceNodeId: z.uuid(),
    targetNodeId: z.uuid(),
    policyId: z.uuid(),
  })
  .strict()
  .parse(JSON.parse(await readFile(configPath, 'utf8')))
const socket = join(directory, 'socket'),
  database = 'hgw_peer_governance_test'
const socketEntry = await lstat(socket)
if (!socketEntry.isDirectory() || socketEntry.isSymbolicLink() || (socketEntry.mode & 0o077) !== 0)
  throw new Error('private Unix socket required')
const pool = new Pool({
  host: socket,
  port: 5432,
  database,
  user: userInfo().username,
  max: 3,
  connectionTimeoutMillis: 3000,
})
try {
  const check = (
    await pool.query("SELECT current_database() db,inet_server_addr() address,current_setting('data_directory') path")
  ).rows[0]
  if (check.db !== database || check.address !== null || (await realpath(check.path)) !== join(directory, 'pgdata'))
    throw new Error('wrong synthetic database')
  await runMigrations(pool, resolve(import.meta.dirname, '../../deploy/postgres/migrations'))
  const org = config.organizationId
  await pool.query("INSERT INTO harness.organizations(id,slug,display_name) VALUES($1,$2,'Synthetic governance proof')", [
    org,
    'synthetic-' + org,
  ])
  await pool.query("INSERT INTO harness.compute_nodes(id,organization_id,name) VALUES($1,$3,'source'),($2,$3,'receiver')", [
    config.sourceNodeId,
    config.targetNodeId,
    org,
  ])
  await pool.query(
    "UPDATE harness.deployment_topology SET enabled=true,revision=1,primary_node_id=$2,primary_origin='https://synthetic.invalid' WHERE organization_id=$1",
    [org, config.sourceNodeId],
  )
  const uid = (
    await pool.query(
      "INSERT INTO harness.users(organization_id,username,display_name,home_path) VALUES($1,'operator','Synthetic operator','/synthetic/owner') RETURNING id",
      [org],
    )
  ).rows[0].id
  await pool.query("INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,'admin')", [org, uid])
  const forbidden = [
    'synthetic-password-' + randomBytes(16).toString('hex'),
    'synthetic-namekey-' + randomBytes(16).toString('hex'),
    'synthetic-master-' + randomBytes(16).toString('hex'),
  ]
  await pool.query('INSERT INTO harness.password_credentials(user_id,password_hash) VALUES($1,$2)', [uid, forbidden[0]])
  await writeFile(join(directory, 'name-index.key'), forbidden[1]!, { mode: 0o600, flag: 'wx' })
  await writeFile(join(directory, 'gateway-master.key'), forbidden[2]!, { mode: 0o600, flag: 'wx' })
  const provider = (
    await pool.query(
      "INSERT INTO harness.model_providers(organization_id,provider_key,display_name,auth_mode) VALUES($1,'org-synthetic','Synthetic provider','none') RETURNING id",
      [org],
    )
  ).rows[0].id
  const model = (
    await pool.query(
      "INSERT INTO harness.model_catalog(organization_id,provider_key,provider_id,model_key,display_name) VALUES($1,'org-synthetic',$2,'small','Synthetic model') RETURNING id",
      [org, provider],
    )
  ).rows[0].id
  await pool.query('INSERT INTO harness.model_user_access(organization_id,user_id,model_id,allowed) VALUES($1,$2,$3,true)', [
    org,
    uid,
    model,
  ])
  const binding = {
    organizationId: org,
    sourceNodeId: config.sourceNodeId,
    targetNodeId: config.targetNodeId,
    scopeId: org,
    policyId: config.policyId,
    revision: 1,
  }
  const token = (await readFile(join(directory, 'append.token'), 'utf8')).trim()
  const engine = new PeerBackupRestic({
    executable: config.restic,
    stagingDirectory: join(directory, 'stage'),
    uploadKiBps: 8192,
    downloadKiBps: 8192,
    timeoutMs: 120000,
    maxRestoreBytes: 8 << 20,
    reserveBytes: 16 << 20,
  })
  const exporter = new PeerControlExporter(pool, { maxBytes: 6 << 20, maxRows: 1000 })
  const start = Date.now()
  const point = await engine.backup(
    binding,
    { origin: config.origin, user: config.sourceNodeId, token, passwordFile: join(directory, 'repository.key') },
    exporter,
    randomUUID(),
    AbortSignal.timeout(120000),
  )
  await writeFile(join(directory, 'oracle.json'), JSON.stringify(forbidden), { mode: 0o600, flag: 'wx' })
  process.stdout.write(
    JSON.stringify({
      os: process.platform,
      pointId: point.pointId,
      protectedThrough: point.capturedAt,
      coverageGaps: point.gapCount,
      bytes: point.repositoryBytes,
      sourceMs: Date.now() - start,
      database: basename(database),
    }) + '\n',
  )
} finally {
  await pool.end()
}
