/** A Gateway starting across data restoration must not publish stale cached dependencies as current. */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type AddressInfo, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { testConfig, testEnvironment } from './test-config.ts'
import { createDeploymentCommands } from '../src/deployment-commands.ts'
import { NodeConfigurationStore } from '../src/node-config-store.ts'
import { loadOrganizationModelCredentialKey } from '../src/organization-model-credentials.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { PostgresDeploymentBackups } from '../src/postgres/deployment-backups.ts'
import { PostgresMaintenanceService } from '../src/postgres/maintenance-service.ts'
import { nodeConfigurationAuthority } from '../src/postgres/node-configuration-authority.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { PostgresUserService } from '../src/postgres/user-service.ts'

const databaseUrl = process.env.HGW_TEST_DATABASE_URL
const execute = promisify(execFile)
const gateway = resolve(import.meta.dirname, '..')

async function reservePort(reservations: Server[]): Promise<number> {
  const server = createServer()
  await new Promise<void>(ready => { server.listen(0, '127.0.0.1', ready) })
  reservations.push(server)
  return (server.address() as AddressInfo).port
}

it.skipIf(databaseUrl === undefined)('rejects a startup whose cached files predate its completed database restore', async () => {
  if (!/(_test|_accept|_acceptance)(\?|$)/u.test(databaseUrl!)) throw new Error('disposable PostgreSQL database required')
  const root = await mkdtemp(join(tmpdir(), 'hgw-startup-generation-'))
  const pool = createPostgresPool(databaseUrl!, { max: 5 })
  const reservations: Server[] = []
  let child: ChildProcess | undefined
  let diagnostics = ''
  try {
    await pool.query('DROP SCHEMA IF EXISTS harness CASCADE')
    await runMigrations(pool, join(gateway, 'deploy/postgres/migrations'))
    const slug = randomUUID(), name = 'startup-generation'
    const organization = (await pool.query<{ id: string }>(
      "INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Startup consistency') RETURNING id", [slug])).rows[0]!.id
    await pool.query('INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,$2)', [organization, name])
    await pool.query('INSERT INTO harness.cluster_control(organization_id) VALUES($1)', [organization])
    // Startup must reject before binding either configured listener.
    const port = await reservePort(reservations)
    const env: NodeJS.ProcessEnv = testEnvironment(root, {
      PATH: process.env.PATH, LANG: 'C.UTF-8', HGW_DATABASE_URL: databaseUrl,
      HGW_ORGANIZATION_SLUG: slug, HGW_COMPUTE_NODE_NAME: name,
      HGW_STATE_ROOT: join(root, 'state'), HGW_USERS_ROOT: join(root, 'users'), HGW_PROJECTS_ROOT: join(root, 'projects'),
      HGW_PROJECT_RUNTIMES_ROOT: join(root, 'project-runtimes'), HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'),
      HGW_PORT: String(port), HGW_INTAKE_PORT: String(await reservePort(reservations)), HGW_PUBLIC_ORIGINS: `http://127.0.0.1:${port}`,
      HGW_DEFAULT_ENV_FILE: '', HGW_LAUNCHER: 'local', HGW_NODE_HEARTBEAT_MS: '100',
      TSX_TSCONFIG_PATH: join(gateway, 'tsconfig.run.json'),
    })
    const cfg = testConfig(root, env), context = await resolvePostgresRuntimeContext(pool, slug, name)
    await new PostgresUserService(context, cfg).create({ username: 'startup-admin', password: 'fixture-password', role: 'admin' })
    const original = loadOrganizationModelCredentialKey(cfg.organizationModelCredentialKeyFile)
    loadOrganizationModelCredentialKey(cfg.webhookSecretKeyFile)
    await new NodeConfigurationStore(context, cfg, env, nodeConfigurationAuthority(context)).initialize()
    const maintenance = new PostgresMaintenanceService(context, cfg.nodeStaleMs)
    await maintenance.enterMaintenance(null, 'Startup consistency fixture')
    const commands = createDeploymentCommands(cfg.pgDumpCommand, cfg.pgRestoreCommand, cfg.psqlCommand)
    const backup = await new PostgresDeploymentBackups(context, cfg, databaseUrl!, commands, env).create(null)
    await writeFile(cfg.organizationModelCredentialKeyFile, randomBytes(32).toString('base64url') + '\n', { mode: 0o600 })

    const preload = join(root, 'startup-barrier.mjs')
    await writeFile(preload, `import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const original = fs.open; let reads = 0;
fs.open = async function(path, ...args) {
  const handle = await original(path, ...args);
  if (String(path) === ${JSON.stringify(cfg.nodeConfigFile)} && ++reads === 2) {
    process.send({ kind: 'dependencies-loaded' });
    await new Promise((resolve, reject) => {
      process.once('message', message => message.kind === 'resume' ? resolve() : reject(new Error('unexpected test message')));
      process.once('SIGTERM', () => reject(new Error('fixture cancelled')));
    });
  }
  return handle;
};
syncBuiltinESMExports();
`, { mode: 0o600 })
    child = spawn(process.execPath, ['--import', import.meta.resolve('tsx/esm'), '--import', preload, join(gateway, 'src/index.ts')], {
      env, cwd: gateway, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    child.stdout!.on('data', (bytes: Buffer) => { diagnostics = (diagnostics + bytes.toString()).slice(-16000) })
    child.stderr!.on('data', (bytes: Buffer) => { diagnostics = (diagnostics + bytes.toString()).slice(-16000) })
    const lifetime = AbortSignal.timeout(20_000)
    expect((await once(child, 'message', { signal: lifetime }))[0]).toEqual({ kind: 'dependencies-loaded' })
    const before = await maintenance.currentWriteEpoch()
    const restored = await execute(process.execPath, ['--import', import.meta.resolve('tsx/esm'),
      join(gateway, 'scripts/deploy-apply.ts'), 'restore', '--backup', backup.id, '--grace-ms', '0'], { env, cwd: gateway, timeout: 30_000 })
    expect(restored.stdout).toContain('restore=ok')
    expect(await maintenance.currentWriteEpoch()).toBeGreaterThan(before)
    expect((await readFile(cfg.organizationModelCredentialKeyFile, 'utf8')).trim()).toBe(original.toString('base64url'))
    await maintenance.exitMaintenance(null)
    const exited = once(child, 'exit', { signal: lifetime })
    child.send!({ kind: 'resume' })
    expect((await exited)[0]).toBe(1)
    expect(child.signalCode).toBeNull()
    expect(diagnostics).toContain('PostgreSQL write epoch advanced past this process')
    expect(diagnostics).not.toContain('EADDRINUSE')
  } finally {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
    await Promise.all(reservations.map(server => new Promise<void>((done, reject) => {
      server.close(error => { if (error) reject(error); else done() })
    })))
    await pool.end()
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
