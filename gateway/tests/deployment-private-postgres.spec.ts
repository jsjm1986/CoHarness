/** Real maintenance transactions authenticate with passwords that a pgpass line cannot represent. */
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer, type AddressInfo, type Socket } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { createDeploymentCommands } from '../src/deployment-commands.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { acquireDeploymentDataLock } from '../src/postgres/deployment-lock.ts'
import { PostgresMaintenanceService } from '../src/postgres/maintenance-service.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { defaultPgConnectionCommand, pgConnectionFrame, pgConnectionMarker, pgConnectionNonce } from '../src/pg-client-protocol.ts'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const command = (value: string | undefined, executable: string): string[] => value === undefined ? [executable] : JSON.parse(value)

it.skipIf(databaseUrl === undefined)('refuses malformed native private input without emitting credentials or resolved metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hgw-native-frame-'))
  const sockets = new Set<Socket>()
  const server = createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket))
    socket.on('error', () => { /* Refused native probes can reset this private connection. */ })
    socket.resume()
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const base = `postgresql://fixture:synthetic-private-password@127.0.0.1:${(server.address() as AddressInfo).port}/fixture?sslmode=disable`
  const oversized = Buffer.alloc(4); oversized.writeUInt32BE(1024 * 1024 + 1)
  const inputs = [pgConnectionFrame(`${base}&service=missing`), pgConnectionFrame(`${base}&sslpassword=synthetic-private-password`),
    pgConnectionFrame(base.replace('disable', 'invalid')),
    pgConnectionFrame(`${base}&nonexistent_option=value`), pgConnectionFrame('postgresql://fixture@%'),
    Buffer.from([0, 0, 0, 8, 65]), Buffer.from([0, 0, 0, 3, 65, 0, 66]), Buffer.alloc(4), oversized]
  try {
    for (const input of inputs) {
      for (const mode of process.platform === 'win32' ? ['resolve'] : ['resolve', 'exec']) {
        const nonce = pgConnectionNonce(), args = mode === 'resolve' ? ['--resolve-stdin-v1', nonce]
          : [process.execPath, '-e', 'process.stdout.write("target executed")', '--', pgConnectionMarker(nonce)]
        const child = spawn(defaultPgConnectionCommand()[0]!, args, { stdio: ['pipe', 'pipe', 'pipe'],
          env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, PGSERVICEFILE: join(root, 'missing'), PGSYSCONFDIR: root } })
        const out: Buffer[] = [], err: Buffer[] = []
        child.stdout.on('data', (chunk: Buffer) => out.push(chunk)); child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
        const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
          child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }))
        })
        // Refused frames may close the input before the complete fixture write.
        child.stdin.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'EPIPE') throw error })
        const deadline = setTimeout(() => { child.kill('SIGKILL') }, 10000)
        try {
          child.stdin.end(input)
          const result = await exited
          expect(result.signal).toBeNull()
          expect(result.code).not.toBe(0)
          expect(Buffer.concat(out).length).toBe(0)
          expect(Buffer.concat(err).toString()).not.toContain('synthetic-private-password')
        } finally {
          clearTimeout(deadline)
          if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited }
        }
      }
    }
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()) })
    await rm(root, { recursive: true, force: true })
  }
})

it.skipIf(databaseUrl === undefined)('backs up and restores through the configured clients with an exact multiline password', async () => {
  const token = randomUUID().replaceAll('-', ''), database = `hgw_private_${token}_test`, role = `hgw_private_${token}`
  const password = "synthetic:'\\密码\nsecond\rline\n", admin = createPostgresPool(databaseUrl!, { max: 1 })
  const root = await mkdtemp(join(tmpdir(), 'hgw-private-postgres-'))
  let databaseCreated = false, roleCreated = false
  let pool: ReturnType<typeof createPostgresPool> | undefined
  try {
    const createRole = await admin.query<{ sql: string }>('SELECT format(\'CREATE ROLE %I LOGIN SUPERUSER PASSWORD %L\',$1::text,$2::text) sql', [role, password])
    await admin.query(createRole.rows[0]!.sql); roleCreated = true
    await admin.query(`CREATE DATABASE "${database}"`); databaseCreated = true
    const target = new URL(databaseUrl!); target.pathname = `/${database}`
    pool = createPostgresPool(target.href, { max: 3 })
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
    const slug = `private-${token}`
    const organization = (await pool.query<{ id: string }>(
      "INSERT INTO harness.organizations(slug,display_name) VALUES($1,'backup data') RETURNING id", [slug])).rows[0]!.id
    await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'private-connection')", [organization])
    await pool.query('INSERT INTO harness.cluster_control(organization_id) VALUES($1)', [organization])
    const context = await resolvePostgresRuntimeContext(pool, slug, 'private-connection')
    const maintenance = new PostgresMaintenanceService(context, 60000)
    const commands = createDeploymentCommands(command(process.env.HGW_TEST_PG_DUMP_COMMAND, 'pg_dump'),
      command(process.env.HGW_TEST_PG_RESTORE_COMMAND, 'pg_restore'))
    target.username = role; target.password = password
    const backup = await commands.backup(root, target.href, [])
    expect(await commands.verifyDump(backup.dumpPath, undefined, backup.sha256)).toBe(backup.sha256)
    expect((await readFile(backup.dumpPath)).subarray(0, 5).toString()).toBe('PGDMP')
    await pool.query("UPDATE harness.organizations SET display_name='current data'")
    await maintenance.enterMaintenance(null)
    await maintenance.beginRestore(null)
    await using lease = await acquireDeploymentDataLock(pool)
    await commands.restoreDump(backup.dumpPath, target.href, lease, backup.sha256)
    expect((await pool.query('SELECT display_name FROM harness.organizations')).rows).toEqual([{ display_name: 'backup data' }])
    expect((await maintenance.state()).mode).toBe('restoring')
  } finally {
    await pool?.end()
    try {
      if (databaseCreated) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`)
      if (roleCreated) await admin.query(`DROP ROLE "${role}"`)
    } finally { await admin.end(); await rm(root, { recursive: true, force: true }) }
  }
})
