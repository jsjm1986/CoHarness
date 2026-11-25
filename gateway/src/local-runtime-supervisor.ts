/** Independent process-group owner; private IPC bootstraps authenticated loopback recovery. */
import { spawn, type ChildProcess } from 'node:child_process'
import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { Writable } from 'node:stream'
import { runGatewayChildCommand } from './child-command.ts'
import { LocalRuntimeOwnerLease, LocalRuntimeOwnerStore } from './local-runtime-owner.ts'
import {
  LOCAL_BOOTSTRAP_BYTES, localBootstrapByteLength, localBootstrapSchema, localKernelBootId, type LocalSupervisorStages,
} from './local-runtime-protocol.ts'
import { RuntimeLog } from './runtime-log.ts'
import { localLinuxRuntimeCommand, stopLocalLinuxRuntime } from './local-runtime-linux.ts'
import { assignRuntimeKillJob, win32CurrentProcessCreationMs, type Win32RuntimeJob } from './local-runtime-win32-job.ts'
import { runtimeCheckpointOutcome, signalShutdownOutcome, type RuntimeCheckpointOutcome } from './runtime-shutdown.ts'

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
  if (localBootstrapByteLength(input) > LOCAL_BOOTSTRAP_BYTES) throw new Error('Local runtime bootstrap exceeds its byte limit')
  const spec = localBootstrapSchema.parse(input)
  const timing: { start: number; stages: Partial<LocalSupervisorStages> } | undefined = spec.reportTiming === true
    ? { start: performance.now(), stages: {} } : undefined
  function mark(stage: keyof LocalSupervisorStages): void {
    if (timing !== undefined) timing.stages[stage] = Math.round((performance.now() - timing.start) * 100) / 100
  }
  const store = new LocalRuntimeOwnerStore(spec.directory, spec.identity)
  // Windows has no descriptor inheritance: the supervisor claims the
  // generation's named-pipe lease itself, waiting out the launcher's release.
  const lease = process.platform === 'win32'
    ? await LocalRuntimeOwnerLease.adopt(store, spec.record, bootstrapTimeoutMs)
    : await LocalRuntimeOwnerLease.inherit(store, 4, spec.record)
  mark('ownerLeaseAdopted')
  let record = (await store.read())!
  mark('bootIdStarted')
  if (record.bootId !== await localKernelBootId()) throw new Error('Local runtime reservation belongs to another kernel boot')
  mark('bootIdVerified')
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
  let killJob: Win32RuntimeJob | undefined
  let checkpointReady = false
  let checkpointRequested: 'ipc' | 'signal' | undefined
  let checkpoint: RuntimeCheckpointOutcome | undefined

  function exitedRuntimeCheckpoint(): RuntimeCheckpointOutcome | undefined {
    const code = child?.exitCode
    if (code === null || code === undefined) return undefined
    if (checkpointRequested === 'signal' && checkpointReady) return signalShutdownOutcome(code)
    if (checkpointRequested === 'ipc') {
      if (code === 83) return 'forced'
      if (checkpoint !== 'confirmed' || code === 0) return checkpoint
    }
    return undefined
  }

  function killOwnedGroup(fallback?: RuntimeCheckpointOutcome): void {
    forceWork ??= (async () => {
      const outcome = exitedRuntimeCheckpoint() ?? fallback
      if (outcome !== undefined && record.phase === 'stopping') {
        try { await lease.recordShutdownOutcome(outcome) } catch (error) {
          console.error('[gateway] local Runtime shutdown receipt unavailable', { generation: record.identity.generation, error })
        }
      }
      if (record.nativeRange === 'linux-slice') await stopLocalLinuxRuntime(record, spec.controlTimeoutMs)
      if (process.platform === 'win32') {
        // The kill-on-close Job ends the whole tree atomically; taskkill /T
        // remains only for a child spawned before Job assignment finished.
        if (killJob !== undefined) killJob.terminate(1)
        else if (child?.pid !== undefined) {
          await runGatewayChildCommand('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], spec.controlTimeoutMs).catch(() => {})
        }
        process.exit(0)
      }
      // This process is the live group leader, so this PID cannot refer to a reused group.
      process.kill(-process.pid, 'SIGKILL')
      throw new Error('Local runtime group kill returned')
    })()
    void forceWork.catch(() => process.exit(1))
  }

  function signalRuntime(runtime: ChildProcess): void {
    if (process.platform !== 'win32' && runtime.exitCode === null && runtime.signalCode === null && runtime.kill('SIGTERM')) {
      checkpointRequested = 'signal'
    }
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
      const runtime = child
      if (runtime === undefined) { await log.close(); killOwnedGroup(); return }
      if (runtime.exitCode !== null || runtime.signalCode !== null) {
        setTimeout(() => killOwnedGroup(), graceMs)
        return
      }
      if (graceMs === 0) {
        killOwnedGroup('forced')
        return
      }
      if (checkpointReady && runtime.connected) {
        checkpointRequested = 'ipc'
        runtime.send({ kind: 'dsh-runtime-stop', graceMs }, error => { if (error !== null) signalRuntime(runtime) })
      } else signalRuntime(runtime)
      setTimeout(() => killOwnedGroup(runtime.exitCode === null && runtime.signalCode === null
        ? checkpointRequested === undefined ? 'forced' : 'timeout' : undefined), graceMs)
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
      nonce: record.nonce, phase: record.phase, runtimeAlive, checkpointReady,
    }))
    if (message.operation === 'stop') stop(Number(message.graceMs))
  }

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    mark('controlListening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Local runtime owner endpoint is unavailable')
    record = await lease.publish({
      ...record, phase: 'starting', groupPid: process.pid, url: `http://127.0.0.1:${address.port}/`,
      // The recorded creation instant fences later kill paths against PID reuse;
      // records without it keep the documented boot-identity fallback.
      ...(process.platform === 'win32'
        ? (() => { try { return { groupStartedAt: win32CurrentProcessCreationMs() } } catch { return {} } })()
        : {}),
    })
    mark('startingRecordWritten')
    if (stopping || await store.cancelled()) throw new Error('Local runtime startup is cancelled')
    const command = spec.linuxScopeMode === undefined ? spec.command : localLinuxRuntimeCommand(record, spec.linuxScopeMode, spec.command)
    mark('runtimeSpawnStarted')
    child = spawn(command[0]!, command.slice(1), {
      cwd: spec.cwd, env: spec.env, detached: false,
      stdio: process.platform === 'win32'
        ? ['ignore', 'pipe', 'pipe', 'pipe', 'ipc']
        : ['ignore', 'pipe', 'pipe', 'pipe', lease.fd, 'ipc'],
    })
    child.stdout!.pipe(log, { end: false }); child.stderr!.pipe(log, { end: false })
    child.on('message', (message: unknown) => {
      if (message === null || typeof message !== 'object' || !('kind' in message)) return
      if (message.kind === 'dsh-runtime-stop-ready') checkpointReady = true
      if (message.kind === 'dsh-runtime-stopped' && checkpointRequested === 'ipc' && checkpoint === undefined && 'outcome' in message) {
        checkpoint = runtimeCheckpointOutcome(message.outcome)
      }
    })
    child.once('exit', () => { runtimeAlive = false; stop(0) })
    child.once('close', () => {
      void Promise.resolve(stopWork).then(() => log.close()).finally(() => killOwnedGroup()).catch(() => {
        // The owner still kills its process range when closing the log or recording stop intent fails.
      })
    })
    const spawned = child
    const spawnReady = new Promise<void>((resolve, reject) => { spawned.once('spawn', resolve); spawned.once('error', reject) })
      .then(() => {
        mark('runtimeSpawned')
        if (process.platform === 'win32') {
          if (spawned.pid === undefined) throw new Error('Local runtime child spawned without a process id')
          // A supervisor running inside an outer Job (Task Scheduler services
          // run under one) cannot nest the child; the Job then degrades to the
          // same taskkill /T + creation-fenced sweep that owns the tree anyway.
          try { killJob = assignRuntimeKillJob(spawned.pid) } catch { killJob = undefined }
          mark('jobAssignmentFinished')
        }
      })
    const credential = child.stdio[3] as Writable
    const delivered = new Promise<void>((resolve, reject) => {
      credential.once('error', reject)
      mark('credentialDeliveryStarted')
      credential.end(spec.credential, timing === undefined ? resolve : () => { mark('credentialDelivered'); resolve() })
    })
    await Promise.all([spawnReady, delivered])
    runtimeAlive = child.exitCode === null && child.signalCode === null
    if (stopping || await store.cancelled() || !runtimeAlive) throw new Error('Local runtime stopped during startup')
    mark('runningRecordWriteStarted')
    record = await lease.publish({ ...record, phase: 'running' })
    mark('runningRecordWritten')
    if (process.connected) {
      mark('ready')
      process.send?.({ kind: 'ready', nonce: record.nonce,
        ...timing === undefined ? {} : { localSupervisorStagesMs: timing.stages } })
    }
    if (process.connected) process.disconnect?.()
  } catch {
    stop(0)
  } finally { finishStartup() }
}
