/** Execute the production shutdown function without booting unrelated deployment services. */
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { generateKeyPairSync } from 'node:crypto'
import { createServer } from 'node:http'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { afterEach, expect, it, vi } from 'vitest'
import { GatewayTunnelAccess } from '../src/tunnel-access.ts'
import type { TunnelAccessRow } from '../src/postgres/tunnel-access-service.ts'
import { LocalDocumentBroker } from '../src/documents-local.ts'
import { GatewayPrincipalSigner } from '../src/principal.ts'
import { testConfig } from './test-config.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { errors.push(error) }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Shutdown fixture cleanup failed')
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function shutdownScript(realListeners = false): string {
  const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
  if (mode !== 'src' && mode !== 'lib') throw new Error('DSH_EXAMPLE_MODE must be src or lib')
  const file = `../${mode}/index.${mode === 'src' ? 'ts' : 'js'}`
  const source = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  const declarations = source.statements.filter(ts.isFunctionDeclaration).filter(node => node.name?.text === 'shutdown')
  expect(declarations).toHaveLength(1)
  const listener = realListeners
    ? source.statements.filter(ts.isFunctionDeclaration).find(node => node.name?.text === 'closeListeningServer')!.getText(source)
    : ''
  return ts.transpileModule(`${listener}\n${declarations[0]!.getText(source)}\nshutdown`, { compilerOptions: { target: ts.ScriptTarget.ES2023 } }).outputText
}

function loadShutdown(sandbox: Record<string, unknown>, realListeners = false): (signal: NodeJS.Signals) => Promise<void> {
  return runInNewContext(shutdownScript(realListeners), sandbox) as (signal: NodeJS.Signals) => Promise<void>
}

function fixture(failing: readonly string[]) {
  const calls: string[] = []
  const causes = new Map(failing.map(name => [name, new Error(`${name} failed`)]))
  const operation = (name: string) => () => {
    calls.push(name)
    const failure = causes.get(name)
    if (failure !== undefined) throw failure
  }
  const asynchronous = (name: string) => async () => { operation(name)() }
  const server = {}, intake = {}, timer = { unref: () => {} }
  const exit = vi.fn(), report = vi.fn(), clearTimeout = vi.fn()
  const sandbox = {
    nodeServiceProxy: undefined, nodeChannels: { close: asynchronous('channels') }, nodeServices: { close: asynchronous('services') },
    shuttingDown: false, stoppingWriters: false, console: { error: report },
    heartbeatTimer: 1, reaper: 2, archiveRetentionSweep: 3, documentRetentionSweep: 4, desktopSweep: 5, progressSweep: 6,
    SHUTDOWN_TIMEOUT_MS: 10000, setTimeout: () => timer, clearTimeout, clearInterval: () => {}, process: { exit },
    instances: { beginShutdown: () => {} }, stewardPreparation: { abort: () => {} },
    peerBackups: { close: asynchronous('peer-backups') }, peerBackupRelay: { close: asynchronous('relay') },
    progress: { close: asynchronous('progress') }, gatewayModelBudget: { close: asynchronous('model-budget') },
    resourcePressure: { dispose: asynchronous('pressure') }, tunnelAccess: { shutdown: asynchronous('tunnel') },
    reaperTask: { wait: asynchronous('reaper') }, archiveRetentionTask: { wait: asynchronous('archives') },
    documentRetentionTask: { wait: asynchronous('retention') }, desktopSweepTask: { wait: asynchronous('desktop') },
    progressSweepTask: { wait: asynchronous('progress-sweep') }, proxyHandlers: { close: operation('proxy') },
    localDocuments: { dispose: asynchronous('documents') }, accessMonitor: { close: asynchronous('access') },
    server, intake, closeListeningServer: async (listener: unknown) => { operation(listener === server ? 'server' : 'intake')() },
    waitForWriters: asynchronous('writers'), heartbeatInFlight: Promise.resolve(),
    localDrafts: { close: asynchronous('drafts') }, personalIndex: { close: asynchronous('index') },
    deps: { instances: { stopAll: asynchronous('instances') } }, pool: { end: asynchronous('pool') },
    contentVolume: { close: asynchronous('volume') },
    performanceObserver: { dispose: operation('performance') },
  }
  return { sandbox, shutdown: loadShutdown(sandbox), calls, causes, exit, report, clearTimeout, timer }
}

const CLEANUP_ORDER = ['peer-backups', 'relay', 'progress', 'model-budget', 'pressure', 'tunnel', 'channels', 'services',
  'reaper', 'archives', 'retention', 'desktop', 'progress-sweep', 'proxy', 'documents', 'access', 'server', 'intake',
  'writers', 'drafts', 'index', 'instances', 'pool', 'volume', 'performance']

it.each(['peer-backups', 'relay', 'progress', 'reaper', 'channels', 'services', 'proxy', 'documents', 'access', 'server',
  'drafts', 'index', 'instances', 'pool', 'volume', 'performance'])(
  'continues later shutdown stages after %s fails', async (failing) => {
    const f = fixture([failing])
    await f.shutdown('SIGTERM')
    expect(f.calls).toEqual(CLEANUP_ORDER)
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(1)
    expect(f.report).toHaveBeenCalledOnce()
    expect(f.report.mock.calls[0]?.[1]).toMatchObject({ errors: [f.causes.get(failing)] })
    expect(f.clearTimeout).toHaveBeenCalledExactlyOnceWith(f.timer)
  },
)

it('preserves failures from independent shutdown stages', async () => {
  const failures = ['progress', 'documents', 'server', 'instances', 'pool', 'performance']
  const f = fixture(failures)
  await f.shutdown('SIGTERM')
  expect(f.calls).toEqual(CLEANUP_ORDER)
  expect(f.exit).toHaveBeenCalledExactlyOnceWith(1)
  expect(f.report.mock.calls[0]?.[1]).toMatchObject({ errors: failures.map(name => f.causes.get(name)) })
})

it('keeps its forced-shutdown deadline alive while a cleanup owner remains pending', async () => {
  const source = `
const close = async () => {};
let shuttingDown = false, stoppingWriters = false;
const instances = { beginShutdown() {} }, stewardPreparation = { abort() {} };
const heartbeatTimer = undefined, reaper = undefined, archiveRetentionSweep = undefined;
const documentRetentionSweep = undefined, desktopSweep = undefined, progressSweep = undefined;
const SHUTDOWN_TIMEOUT_MS = 20;
const peerBackups = { close }, peerBackupRelay = { close }, nodeServiceProxy = undefined;
const nodeChannels = { close }, nodeServices = { close };
const progress = { close }, gatewayModelBudget = { close }, resourcePressure = { dispose: close };
const tunnelAccess = { shutdown: close };
const reaperTask = { wait: close }, archiveRetentionTask = { wait: close }, documentRetentionTask = { wait: close };
const desktopSweepTask = { wait: close }, progressSweepTask = { wait: close };
const proxyHandlers = { close }, localDocuments = { dispose: close }, accessMonitor = { close };
const server = {}, intake = {}, closeListeningServer = close;
const waitForWriters = close, heartbeatInFlight = Promise.resolve();
const localDrafts = { close }, personalIndex = { close };
const deps = { instances: { stopAll: close } }, pool = { end: () => new Promise(() => {}) };
const contentVolume = { close };
const performanceObserver = { dispose() {} };
${shutdownScript()}
void shutdown('SIGTERM');
`
  await expect(promisify(execFile)(process.execPath, ['--input-type=commonjs', '-e', source], {
    timeout: 15000, killSignal: 'SIGKILL', env: { PATH: process.env.PATH },
  })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('forced shutdown after 20ms (SIGTERM)') })
}, 20000)

it('closes real listeners and an owned runtime after document cleanup reports a failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-shutdown-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const user = { id: 7, username: 'shutdown-owner', displayName: 'Shutdown owner', role: 'user' as const,
    status: 'active' as const, homePath: join(root, 'home'), mustChangePassword: false, autoReviewEligible: false }
  const cfg = testConfig(root)
  await Promise.all([mkdir(user.homePath, { recursive: true, mode: 0o700 }), mkdir(cfg.stateRoot, { recursive: true, mode: 0o700 })])
  const broker = new LocalDocumentBroker({
    cfg, organizationId: 'fixture',
    users: { getById: async () => user }, projects: { getById: async () => null }, collaboration: { projectForUser: async () => null },
  })
  cleanups.push(() => broker.dispose())
  expect((await broker.listDirectories(user, { kind: 'personal' }, undefined)).status).toBe(200)
  const listeners = [createServer(), createServer()]
  for (const listener of listeners) {
    cleanups.push(async () => {
      listener.closeAllConnections()
      if (listener.listening) await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))
    })
    const listening = once(listener, 'listening')
    listener.listen(0, '127.0.0.1')
    await listening
  }
  const child = spawn(process.execPath, ['-e', "process.send('ready'); setInterval(() => {}, 60000)"], {
    cwd: root, env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], timeout: 30000, killSignal: 'SIGKILL',
  })
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('close', (code, signal) => { resolve({ code, signal }) })
  })
  cleanups.push(async () => {
    child.removeAllListeners('message')
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
  })
  await Promise.race([once(child, 'message'), closed.then(() => { throw new Error('Fixture runtime exited before readiness') })])
  const f = fixture([]), failure = new Error('document cleanup reported a failure')
  const stopAll = vi.fn(async () => { child.kill('SIGTERM'); await closed })
  const shutdown = loadShutdown({
    ...f.sandbox, server: listeners[0], intake: listeners[1],
    setTimeout, clearTimeout, clearInterval, CONNECTION_DRAIN_MS: 1000,
    localDocuments: { dispose: async () => { await broker.dispose(); throw failure } },
    deps: { instances: { stopAll } },
  }, true)
  await shutdown('SIGTERM')
  expect(listeners.map(listener => listener.listening)).toEqual([false, false])
  expect(stopAll).toHaveBeenCalledOnce()
  expect(await closed).toEqual({ code: null, signal: 'SIGTERM' })
  expect(f.exit).toHaveBeenCalledExactlyOnceWith(1)
  expect(f.report.mock.calls[0]?.[1]).toMatchObject({ errors: [failure] })
}, 45000)

it('cancels accepted tunnel startup before waiting for its HTTP writer to drain', async () => {
  const allocated = deferred(), cancelled = deferred(), waiting = deferred(), writers = deferred()
  const terminate = vi.fn(async () => {})
  let row: TunnelAccessRow = {
    mode: 'named', desired: 'running', state: 'stopped', publicUrl: null, hostname: 'fixture.example.com', domain: 'example.com',
    zoneId: 'zone', accountId: 'account', tunnelId: 'tunnel', apiTokenCipher: null, runTokenCipher: Buffer.from('synthetic'),
    lastError: null, revision: 1, startedAt: null, updatedAt: 'fixture',
  }
  const tunnelAccess = new GatewayTunnelAccess({
    store: { get: async () => row, update: async patch => { row = { ...row, ...patch }; return row } },
    cipher: { decrypt: () => 'synthetic', encrypt: () => Buffer.from('synthetic') }, organizationId: 'fixture', nodeId: 'node',
    target: 'http://127.0.0.1:1', stateDir: '/unused', startupTimeoutMs: 30000, closeTimeoutMs: 5000, probeIntervalMs: 25,
    resolveBinary: async () => ({ path: '/fixture/cloudflared', version: 'fixture', source: 'env' }),
    spawnNamed: (_bin, _token, options) => {
      const ready = new Promise<void>((_resolve, reject) => {
        options.signal!.addEventListener('abort', () => { cancelled.resolve(); reject(options.signal!.reason) }, { once: true })
      })
      allocated.resolve()
      return { publicUrl: null, ready, terminate, hasExited: () => false, exited: new Promise(() => {}) }
    },
  })
  const starting = tunnelAccess.startNamed({ hostname: 'fixture.example.com' }).then(() => { writers.resolve() }, () => { writers.resolve() })
  await allocated.promise
  const exit = vi.fn(), close = async () => {}, timer = { unref: () => {} }
  const sandbox = {
    nodeServiceProxy: undefined, nodeChannels: { close }, nodeServices: { close },
    shuttingDown: false, stoppingWriters: false, console,
    instances: { beginShutdown: () => {} }, stewardPreparation: { abort: () => {} },
    peerBackups: { close }, peerBackupRelay: { close },
    heartbeatTimer: 1, reaper: 2, archiveRetentionSweep: 3, documentRetentionSweep: 4, desktopSweep: 5, progressSweep: 6,
    SHUTDOWN_TIMEOUT_MS: 10000, setTimeout: () => timer, clearTimeout: () => {}, clearInterval: () => {},
    process: { exit }, progress: { close }, gatewayModelBudget: { close }, resourcePressure: { dispose: close },
    reaperTask: { wait: close }, archiveRetentionTask: { wait: close }, documentRetentionTask: { wait: close },
    desktopSweepTask: { wait: close }, progressSweepTask: { wait: close }, proxyHandlers: { close }, localDocuments: { dispose: close },
    accessMonitor: { close }, server: {}, intake: {}, closeListeningServer: close,
    waitForWriters: () => { waiting.resolve(); return writers.promise }, heartbeatInFlight: Promise.resolve(), tunnelAccess,
    localDrafts: { close }, personalIndex: { close },
    deps: { instances: { stopAll: close } }, pool: { end: close }, contentVolume: { close },
    performanceObserver: { dispose: () => {} },
  }
  const shutdown = loadShutdown(sandbox)
  const draining = shutdown('SIGTERM')
  try {
    const first = await Promise.race([cancelled.promise.then(() => 'cancelled'), waiting.promise.then(() => 'waiting')])
    expect(first).toBe('cancelled')
  } finally { await tunnelAccess.shutdown(); await starting; await draining }
  expect(terminate).toHaveBeenCalledOnce()
  expect(exit).toHaveBeenCalledExactlyOnceWith(0)
})
