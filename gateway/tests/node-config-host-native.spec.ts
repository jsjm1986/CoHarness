/** Native node-configuration control clients own closure, deadline and private inheritance. */
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNodeConfigurationHost } from '../src/node-config-host.ts'
import { NodeConfigurationStore, readNodeConfiguration } from '../src/node-config-store.ts'
import { testEnvironment, testConfig } from './test-config.ts'
import { isolatedNodeConfigurationAuthority } from './node-config-fixture.ts'
import { NODE_SERVICE_TARGET_HEADER } from '../src/node-service-stream.ts'

const nativeFetch = globalThis.fetch
const fixtures: Array<{ root: string; pool: Pool; lifetime: AbortController; pending: Promise<unknown>[] }> = []
interface Marker { url: string; token: string }
async function endpoint(marker: Marker, release = false): Promise<string | undefined> {
  try { return await (await nativeFetch(`${marker.url}/${release ? 'release/' : ''}${marker.token}`, { headers: { connection: 'close' } })).text() }
  catch (error) {
    if (error instanceof TypeError && error.cause instanceof Error && 'code' in error.cause
      && ['ECONNREFUSED', 'ECONNRESET'].includes(String(error.cause.code))) return undefined
    throw error
  }
}
async function bounded<T>(pending: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try { return await Promise.race([pending, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Owned native control did not settle')), timeoutMs) })]) }
  finally { clearTimeout(timer) }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const f of fixtures.splice(0)) {
    f.lifetime.abort(new Error('owned fixture cleanup'))
    let marker: Marker | undefined
    try { marker = JSON.parse(await readFile(join(f.root, 'ready.json'), 'utf8')) as Marker } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (marker !== undefined) await endpoint(marker, true)
    await Promise.allSettled(f.pending)
    if (marker !== undefined) await expect.poll(() => endpoint(marker!), { timeout: 10_000 }).toBeUndefined()
    await f.pool.end()
    await rm(f.root, { recursive: true, force: true })
  }
  vi.unstubAllEnvs(); vi.unstubAllGlobals()
})

async function fixture(hold = true, timeoutMs = 5000, readinessMs = 100, overrides: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hgw-node-native-'))
  const pool = new Pool({ connectionString: 'postgres://synthetic.invalid/never-connected' })
  const lifetime = new AbortController(), pending: Promise<unknown>[] = []
  fixtures.push({ root, pool, lifetime, pending })
  const operation = process.platform === 'darwin' ? 'kickstart' : 'restart'
  await writeFile(join(root, 'fixture.json'), JSON.stringify({ hold: hold ? operation : 'none', ignoreTerm: true }))
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n')
  const binary = join(root, process.platform === 'darwin' ? 'launchctl' : 'systemctl')
  await writeFile(binary, `#!${process.execPath}\n${await readFile(new URL('./fixtures/systemctl-client.mjs', import.meta.url), 'utf8')}`)
  await chmod(binary, 0o700)
  vi.stubEnv('PATH', `${root}:${process.env.PATH ?? ''}`)
  vi.stubEnv('HGW_DATABASE_URL', 'postgres://synthetic.invalid/not-a-credential')
  const env = testEnvironment(root, { HGW_SYSTEMD_COMMAND_TIMEOUT_MS: String(timeoutMs), HGW_READINESS_TIMEOUT_MS: String(readinessMs), ...overrides })
  const cfg = testConfig(root, env), context = { pool, organizationId: 'org', organizationSlug: 'org', nodeId: 'node', nodeName: 'node' }
  const store = new NodeConfigurationStore(context, cfg, env, isolatedNodeConfigurationAuthority)
  await store.initialize()
  const record = (await readNodeConfiguration(cfg.nodeConfigFile, env))!
  const host = createNodeConfigurationHost(env, context, lifetime.signal)
  const start = () => {
    const request = host.restartAndVerify(record).then(() => undefined, (error: unknown) => error)
    pending.push(request); return request
  }
  const witness = async (): Promise<Marker> => {
    let marker: Marker | undefined
    await expect.poll(async () => {
      try { marker = JSON.parse(await readFile(join(root, 'ready.json'), 'utf8')) as Marker; return true }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
    }, { timeout: 20_000 }).toBe(true)
    expect(await endpoint(marker!)).toBe(marker!.token)
    return marker!
  }
  return { root, record, host, lifetime, start, witness }
}

describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('native node configuration service actions', () => {
  it('closes a SIGTERM-ignoring service client before reporting lease cancellation', async () => {
    const f = await fixture(), request = f.start(), marker = await f.witness()
    f.lifetime.abort(new Error('maintenance lease lost'))
    expect(await bounded(request, 2000)).toMatchObject({ message: 'gateway-service-restart-failed' })
    expect(await endpoint(marker)).toBeUndefined()
  })

  it('uses the configured control deadline and closes an uncooperative client', async () => {
    const f = await fixture(), request = f.start(), marker = await f.witness()
    expect(await bounded(request, 7000)).toMatchObject({ message: 'gateway-service-restart-failed' })
    expect(await endpoint(marker)).toBeUndefined()
  })

  it('excludes deployment credentials from the actual native client', async () => {
    const f = await fixture(false)
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ok: true, configurationRevision: f.record.appliedRevision }),
      { headers: { [NODE_SERVICE_TARGET_HEADER]: f.record.nodeId } }))
    expect(await f.start()).toBeUndefined()
    const rows = (await readFile(join(f.root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { databasePresent: boolean })
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every(row => !row.databasePresent)).toBe(true)
  })

  it('ends readiness waiting when the wall clock stops advancing', async () => {
    const f = await fixture(false)
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 503 }))
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    expect(await bounded(f.start(), 2000)).toMatchObject({ message: 'gateway-did-not-confirm-configured-revision' })
  })

  it('bounds an in-flight health response by the remaining readiness deadline', async () => {
    const f = await fixture(false)
    vi.stubGlobal('fetch', (_url: unknown, options: { signal: AbortSignal }) => new Promise((_, reject) => {
      if (options.signal.aborted) reject(options.signal.reason)
      else options.signal.addEventListener('abort', () => { reject(options.signal.reason) }, { once: true })
    }))
    expect(await bounded(f.start(), 1000)).toMatchObject({ message: 'gateway-did-not-confirm-configured-revision' })
  })

  it('does not accept a health response without the expected computer identity', async () => {
    const f = await fixture(false)
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ok: true, configurationRevision: f.record.appliedRevision })))
    expect(await f.host.isHealthy(f.record)).toBe(false)
  })

  it('rejects a health response that exceeds the configured response byte budget', async () => {
    const f = await fixture(false, 5000, 100, { HGW_UPSTREAM_RESPONSE_LIMIT_BYTES: '128' })
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ok: true, configurationRevision: f.record.appliedRevision, padding: 'x'.repeat(256) }),
      { headers: { [NODE_SERVICE_TARGET_HEADER]: f.record.nodeId } }))
    expect(await f.host.isHealthy(f.record)).toBe(false)
  })
})
