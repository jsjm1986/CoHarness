/** The public configuration applier restarts an isolated real Gateway and confirms its new revision. */
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import { nodeConfigurationAuthority } from '../src/postgres/node-configuration-authority.ts'
import { testConfig, testEnvironment } from './test-config.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { PostgresMaintenanceService } from '../src/postgres/maintenance-service.ts'
import { NodeConfigurationStore, readNodeConfiguration } from '../src/node-config-store.ts'

const databaseUrl = process.env.HGW_TEST_DATABASE_URL
const describePg = databaseUrl === undefined ? describe.skip : describe
const execute = promisify(execFile)
const sourceEntry = resolve(import.meta.dirname, '../src/index.ts')
const configEntry = resolve(import.meta.dirname, '../src/node-config-cli.ts')
let pool: Pool, directory: string, env: NodeJS.ProcessEnv

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolveReady => { server.listen(0, '127.0.0.1', resolveReady) })
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolveClosed, reject) => { server.close(error => { if (error) reject(error); else resolveClosed() }) })
  return port
}

describePg('independent node configuration process', () => {
  beforeAll(async () => {
    if (!/(_test|_accept|_acceptance)(\?|$)/u.test(databaseUrl!)) throw new Error('disposable PostgreSQL database required')
    directory = await mkdtemp(join(tmpdir(), 'hgw-node-process-'))
    pool = createPostgresPool(databaseUrl!, { max: 3 })
    await pool.query('DROP SCHEMA IF EXISTS harness CASCADE')
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
    const slug = randomUUID()
    const organization = (await pool.query<{ id: string }>("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Node settings acceptance') RETURNING id", [slug])).rows[0]!.id
    await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'isolated-node')", [organization])
    await pool.query('INSERT INTO harness.cluster_control(organization_id) VALUES($1)', [organization])
    const secrets = join(directory, 'database-url'), bin = join(directory, 'bin')
    await writeFile(secrets, databaseUrl!, { mode: 0o600 }); await mkdir(bin)
    env = testEnvironment(directory, { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(HGW_|DEEPSEEK_|DSH_GATEWAY_)/u.test(key))),
      HGW_DATABASE_URL_FILE: secrets, HGW_ORGANIZATION_SLUG: slug, HGW_COMPUTE_NODE_NAME: 'isolated-node',
      HGW_PORT: String(await freePort()), HGW_INTAKE_PORT: String(await freePort()),
      HGW_STATE_ROOT: join(directory, 'state'), HGW_USERS_ROOT: join(directory, 'users'),
      HGW_PROJECTS_ROOT: join(directory, 'projects'), HGW_USER_PROJECTS_ROOT: join(directory, 'user-projects'),
      HGW_PROJECT_RUNTIMES_ROOT: join(directory, 'project-runtimes'), HGW_DEFAULT_ENV_FILE: '',
      HGW_NODE_HEARTBEAT_MS: '100', HGW_READINESS_TIMEOUT_MS: '4000',
      TSX_TSCONFIG_PATH: resolve(import.meta.dirname, '../tsconfig.run.json'), PATH: `${bin}:${process.env.PATH ?? ''}` })
    const driver = join(directory, 'service.mjs')
    await writeFile(driver, `import { spawn } from 'node:child_process';
import { readFile, writeFile, open } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const pidFile = ${JSON.stringify(join(directory, 'gateway.pid'))};
let previous;
try { previous = Number(await readFile(pidFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (previous) {
  try { process.kill(previous, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  let alive = true;
  for (let n = 0; n < 100; n++) { try { process.kill(previous, 0); } catch { alive = false; break; } await delay(25); }
  if (alive) { try { process.kill(previous, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
}
if (process.argv.includes('stop-owned-fixture')) process.exit(0);
const log = await open(${JSON.stringify(join(directory, 'gateway.log'))}, 'a', 0o600);
const child = spawn(process.execPath, ['--import', ${JSON.stringify(import.meta.resolve('tsx/esm'))}, ${JSON.stringify(sourceEntry)}],
 { cwd: ${JSON.stringify(resolve(import.meta.dirname, '..'))}, env: process.env, detached: true, stdio: ['ignore', log.fd, log.fd] });
await writeFile(pidFile, String(child.pid), { mode: 0o600 }); child.unref(); await log.close();
`, { mode: 0o600 })
    const wrapper = `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(driver)} "$@"\n`
    // Only this test child's PATH names these shims; the actual host service manager is never called.
    await writeFile(join(bin, 'launchctl'), wrapper, { mode: 0o700 })
    await writeFile(join(bin, 'systemctl'), wrapper, { mode: 0o700 })
    await execute(process.execPath, [driver], { env, timeout: 10_000 })
    await vi.waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${env.HGW_PORT}/healthz`, { signal: AbortSignal.timeout(1000) })
      expect(response.ok).toBe(true)
    }, { timeout: 15_000, interval: 100 }).catch(async (error: unknown) => {
      throw new Error(`Isolated Gateway did not become ready:\n${(await readFile(join(directory, 'gateway.log'), 'utf8')).slice(-12000)}`, { cause: error })
    })
  }, 30_000)

  afterAll(async () => {
    if (directory !== undefined && env !== undefined) {
      await execute(process.execPath, [join(directory, 'service.mjs'), 'stop-owned-fixture'], { env, timeout: 10_000 })
    }
    await pool?.end()
    if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  })

  it('switches the actual listener only after a node-bound request and quiesced maintenance', async () => {
    const cfg = testConfig(directory, env), context = await resolvePostgresRuntimeContext(pool, cfg.organizationSlug, cfg.computeNodeName)
    const maintenance = new PostgresMaintenanceService(context, cfg.nodeStaleMs), store = new NodeConfigurationStore(context, cfg, env, nodeConfigurationAuthority(context))
    const initial = await store.view(), nextPort = await freePort()
    await store.save(context, initial.revision, { ...initial.desired, HGW_PORT: String(nextPort) })
    await store.requestApply(context, 1, 1)
    await maintenance.enterMaintenance(null, 'configuration acceptance')
    await vi.waitFor(async () => { expect((await maintenance.state()).writersQuiesced).toBe(true) }, { timeout: 5000 })
    const policyFile = join(cfg.usersRoot, 'admin', 'dsh', 'model-governance.json')
    const preservedPolicy = `${await readFile(policyFile, 'utf8')}\n`
    await writeFile(policyFile, preservedPolicy)
    const result = await execute(process.execPath, ['--import', import.meta.resolve('tsx/esm'), configEntry, 'apply'], { env, timeout: 20_000 })
    expect(result.stdout).toContain('"status":"completed"')
    const health = await fetch(`http://127.0.0.1:${nextPort}/healthz`, { signal: AbortSignal.timeout(1000) })
    expect(await health.json()).toMatchObject({ ok: true, configurationRevision: 1 })
    expect(await readNodeConfiguration(cfg.nodeConfigFile, env)).toMatchObject({ appliedRevision: 1, previous: { revision: 0 } })
    expect((await maintenance.state()).mode).toBe('maintenance')
    expect(await readFile(policyFile, 'utf8')).toBe(preservedPolicy)
    await expect(fetch(`http://127.0.0.1:${cfg.port}/healthz`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow()
  }, 30_000)

  it('rejects an occupied port before publishing the candidate and leaves the existing Gateway healthy', async () => {
    const cfg = testConfig(directory, env), context = await resolvePostgresRuntimeContext(pool, cfg.organizationSlug, cfg.computeNodeName)
    const store = new NodeConfigurationStore(context, cfg, env, nodeConfigurationAuthority(context)), previous = await store.view()
    const occupied = createServer()
    await new Promise<void>(ready => { occupied.listen(0, '127.0.0.1', ready) })
    const port = (occupied.address() as AddressInfo).port
    try {
      await store.save(context, previous.revision, { ...previous.desired, HGW_PORT: String(port) })
      await store.requestApply(context, previous.revision + 1, 1)
      await expect(execute(process.execPath, ['--import', import.meta.resolve('tsx/esm'), configEntry, 'apply'], { env, timeout: 20_000 }))
        .rejects.toMatchObject({ code: 1, killed: false, stdout: expect.stringContaining('configuration-port-unavailable') })
      const stored = (await readNodeConfiguration(cfg.nodeConfigFile, env))!
      expect(stored.appliedRevision).toBe(1)
      const response = await fetch(`http://127.0.0.1:${stored.applied.HGW_PORT}/healthz`, { signal: AbortSignal.timeout(1000) })
      expect(await response.json()).toMatchObject({ ok: true, configurationRevision: 1 })
    } finally { await new Promise<void>(done => { occupied.close(() => { done() }) }) }
  })
})
