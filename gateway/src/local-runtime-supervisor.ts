/** Independent POSIX group owner; private IPC bootstraps authenticated loopback recovery. */
import { spawn, type ChildProcess } from 'node:child_process'
import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Writable } from 'node:stream'
import { LocalRuntimeOwnerLease, LocalRuntimeOwnerStore } from './local-runtime-owner.ts'
import { LOCAL_BOOTSTRAP_BYTES, localBootstrapSchema, localKernelBootId } from './local-runtime-protocol.ts'
import { RuntimeLog } from './runtime-log.ts'
import { localLinuxRuntimeCommand, stopLocalLinuxRuntime } from './local-runtime-linux.ts'

const CONTROL_BYTES = 4096
let started = false
const bootstrapTimeoutMs = Number(process.argv[2])
if (!Number.isSafeInteger(bootstrapTimeoutMs) || bootstrapTimeoutMs < 1 || bootstrapTimeoutMs > 2_147_483_647) {
  throw new Error('Local runtime owner requires its configured startup deadline')
}
const noBootstrap = setTimeout(() => process.exit(1), bootstrapTimeoutMs)
process.once('disconnect', () => { if (!started) process.exit(1) })
process.once('message', (input: unknown) => {
  started = true
  clearTimeout(noBootstrap)
  void supervise(input).catch(() => {
    // The journal and kernel lease retain uncertain occupancy after an owner failure.
    process.exit(1)
  })
})

async function supervise(input: unknown): Promise<void> {
  if (Buffer.byteLength(JSON.stringify(input)) > LOCAL_BOOTSTRAP_BYTES) throw new Error('Local runtime bootstrap exceeds its byte limit')
  const spec = localBootstrapSchema.parse(input)
  const store = new LocalRuntimeOwnerStore(spec.directory, spec.identity)
  const lease = await LocalRuntimeOwnerLease.inherit(store, 4, spec.record)
  let record = (await store.read())!
  if (record.bootId !== await localKernelBootId()) throw new Error('Local runtime reservation belongs to another kernel boot')
  if ((record.nativeRange === 'linux-slice') !== (spec.linuxScopeMode !== undefined)) {
    throw new Error('Local runtime native ownership does not match its reservation')
  }
  let child: ChildProcess | undefined
  let runtimeAlive = false
  let stopping = false
  let stopWork: Promise<void> | undefined
  let finishStartup!: () => void
  const startupFinished = new Promise<void>(resolve => { finishStartup = resolve })
  const log = new RuntimeLog(join(spec.dshHome, 'logs', 'runtime.log'), spec.logCapBytes)
  const server = createServer((request, response) => { void control(request, response).catch(() => response.destroy()) })
  server.requestTimeout = spec.controlTimeoutMs
  server.headersTimeout = spec.controlTimeoutMs
  server.keepAliveTimeout = Math.min(spec.controlTimeoutMs, 1000)
  server.maxConnections = 16

  let forceWork: Promise<void> | undefined
  function killOwnedGroup(): void {
    forceWork ??= (async () => {
      if (record.nativeRange === 'linux-slice') await stopLocalLinuxRuntime(record, spec.controlTimeoutMs)
      // This process is the live group leader, so this PID cannot refer to a reused group.
      process.kill(-process.pid, 'SIGKILL')
      throw new Error('Local runtime group kill returned')
    })()
    void forceWork.catch(() => process.exit(1))
  }
  function stop(graceMs: number): void {
    if (stopWork !== undefined) return
    stopping = true
    stopWork = (async () => {
      await store.cancel()
      await startupFinished
      record = (await store.read())!
      if (record.phase === 'starting' || record.phase === 'running' || record.phase === 'uncertain') {
        record = await lease.publish({ ...record, phase: 'stopping' })
      }
      process.kill(-process.pid, 'SIGTERM')
      setTimeout(killOwnedGroup, graceMs)
      if (child === undefined) { await log.close(); killOwnedGroup() }
    })()
    void stopWork.catch(() => process.exit(1))
  }
  process.on('SIGTERM', () => { stop(0) })
  process.on('SIGINT', () => { stop(0) })

  async function control(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const supplied = Buffer.from(request.headers.authorization ?? '')
    const expected = Buffer.from(`Bearer ${record.token}`)
    if (request.method !== 'POST' || request.url !== '/' || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      response.writeHead(403, { connection: 'close' }).end(); request.resume(); return
    }
    let bytes = 0
    const chunks: Buffer[] = []
    for await (const chunk of request) {
      bytes += Buffer.byteLength(chunk as Buffer)
      if (bytes > CONTROL_BYTES) { response.writeHead(413, { connection: 'close' }).end(); request.destroy(); return }
      chunks.push(Buffer.from(chunk as Buffer))
    }
    let parsed: unknown
    try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { response.writeHead(400).end(); return }
    if (parsed === null || typeof parsed !== 'object') { response.writeHead(400).end(); return }
    const message = parsed as { nonce?: unknown; operation?: unknown; graceMs?: unknown }
    if (message.nonce !== record.nonce || !['status', 'stop'].includes(String(message.operation))
      || message.operation === 'stop' && (!Number.isSafeInteger(message.graceMs) || Number(message.graceMs) < 0 || Number(message.graceMs) > 86_400_000)) {
      response.writeHead(400).end(); return
    }
    response.writeHead(200, { 'content-type': 'application/json', connection: 'close' }).end(JSON.stringify({
      nonce: record.nonce, phase: record.phase, runtimeAlive,
    }))
    if (message.operation === 'stop') stop(Number(message.graceMs))
  }

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Local runtime owner endpoint is unavailable')
    record = await lease.publish({ ...record, phase: 'starting', groupPid: process.pid, url: `http://127.0.0.1:${address.port}/` })
    if (stopping || await store.cancelled()) throw new Error('Local runtime startup is cancelled')
    const command = spec.linuxScopeMode === undefined ? spec.command : localLinuxRuntimeCommand(record, spec.linuxScopeMode, spec.command)
    child = spawn(command[0]!, command.slice(1), {
      cwd: spec.cwd, env: spec.env, detached: false,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', lease.fd],
    })
    child.stdout!.pipe(log, { end: false }); child.stderr!.pipe(log, { end: false })
    child.once('exit', () => { runtimeAlive = false; stop(0) })
    child.once('close', () => { void log.close().then(killOwnedGroup, killOwnedGroup) })
    const spawnReady = new Promise<void>((resolve, reject) => { child!.once('spawn', resolve); child!.once('error', reject) })
    const credential = child.stdio[3] as Writable
    const delivered = new Promise<void>((resolve, reject) => {
      credential.once('error', reject); credential.end(spec.credential, resolve)
    })
    await Promise.all([spawnReady, delivered])
    runtimeAlive = child.exitCode === null && child.signalCode === null
    if (stopping || await store.cancelled() || !runtimeAlive) throw new Error('Local runtime stopped during startup')
    record = await lease.publish({ ...record, phase: 'running' })
    if (process.connected) process.send?.({ kind: 'ready', nonce: record.nonce })
    if (process.connected) process.disconnect?.()
  } catch {
    stop(0)
  } finally { finishStartup() }
}
