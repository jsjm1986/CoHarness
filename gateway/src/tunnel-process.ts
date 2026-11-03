/** Private connector registration evidence and bounded ownership of one cloudflared child. */
import { spawn, type ChildProcess } from 'node:child_process'
import { constants, closeSync, fstatSync, lstatSync, mkdtempSync, openSync, readSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { scrubbedGatewayChildEnv } from './child-environment.ts'

const QUICK_URL = /https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com/u
const URL_PREFIX_CHARS = 253 + 'https://'.length
const PID_BYTES = 32

function assertNever(_command: never): never { throw new Error('Unsupported tunnel command') }

/** A tunnel lookup, installation or lifecycle operation failed. */
export class TunnelSupervisorError extends Error {
  constructor(readonly code: 'not-installed' | 'unsupported-platform' | 'checksum-mismatch' | 'download-failed'
    | 'start-failed' | 'startup-timeout' | 'stop-unconfirmed', message: string, cause?: unknown) {
    super(message, { cause })
  }
}

/** Validated deployment timing and optional startup cancellation for one connector. */
export interface TunnelLaunchOptions {
  startupTimeoutMs: number
  closeTimeoutMs: number
  probeIntervalMs: number
  /** Aborts pending registration; absent keeps startup independent of a caller lifetime. */
  signal?: AbortSignal
}

/** Handle retaining a connector before registration and through confirmed closure. */
export interface TunnelProc {
  publicUrl: string | null
  /** Resolves after the owned child confirms an edge connection; quick mode also requires its URL. */
  ready: Promise<void>
  /** Whether the native child and its stdio have closed; failed metadata cleanup can still need retry. */
  hasExited(): boolean
  /** Force after graceMs, then await closure within the configured close deadline; failure retains ownership for retry. */
  terminate(graceMs: number): Promise<void>
  /** Resolves after native closure and private-file cleanup; rejects on cleanup failure. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

/** Exact cloudflared invocation; connector credentials never enter argv. */
export type TunnelCommand = { kind: 'quick'; target: string } | { kind: 'named'; token: string }

/**
 * Allocate a connector with a new private registration file and immediate cleanup ownership.
 * @param bin - selected cloudflared executable.
 * @param command - quick target or explicit named credential.
 * @param options - validated startup/closure timing and optional registration cancellation.
 * @returns handle whose ready promise does not substitute for process closure.
 */
export function spawnTunnelProcess(bin: string, command: TunnelCommand, options: TunnelLaunchOptions): TunnelProc {
  options.signal?.throwIfAborted()
  const directory = mkdtempSync(join(tmpdir(), 'hgw-tunnel-start-'))
  const pidFile = join(directory, 'registered.pid')
  const args = ['tunnel', '--no-autoupdate', '--pidfile', pidFile]
  const env: Record<string, string> = { ...scrubbedGatewayChildEnv(), HOME: homedir() }
  switch (command.kind) {
    case 'quick': args.push('--url', command.target); break
    case 'named': args.push('run'); env.TUNNEL_TOKEN = command.token; break
    default: assertNever(command)
  }
  let child: ChildProcess
  try {
    child = spawn(bin, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    })
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error }
  let closed = false, settled = false, registered = false
  let stopping: Promise<void> | undefined
  let resolveReady!: () => void, rejectReady!: (error: unknown) => void
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  // Closure-only owners still retain the original rejecting readiness promise.
  void ready.catch((_startupFailure: unknown) => {})
  let resolveExit!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void
  const nativeExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => { resolveExit = resolve })
  const cleanup = (): void => { rmSync(directory, { recursive: true, force: true }) }
  const exited = nativeExit.then(value => { cleanup(); return value })
  // The handle retains cleanup retry even when its first exit observer fails.
  void exited.catch((_cleanupFailure: unknown) => {})
  const proc: TunnelProc = {
    publicUrl: null, ready, exited, hasExited: () => closed,
    terminate: graceMs => stopping ??= stop(graceMs).catch(error => { stopping = undefined; throw error }),
  }
  const clearStartup = (): void => {
    clearTimeout(deadline); clearInterval(poll)
    child.stdout?.off('data', scanOut); child.stderr?.off('data', scanError)
    options.signal?.removeEventListener('abort', abort)
  }
  const fail = (error: unknown): void => {
    if (settled) return
    settled = true; clearStartup(); rejectReady(error)
  }
  const confirm = (): void => {
    if (settled || !registered || (command.kind === 'quick' && proc.publicUrl === null)) return
    if (child.exitCode !== null || child.signalCode !== null || closed) { fail(new TunnelSupervisorError('start-failed', 'cloudflared exited before registration was confirmed')); return }
    settled = true; clearStartup(); resolveReady()
  }
  const scanner = (): ((chunk: Buffer) => void) => {
    let prefix = ''
    return chunk => {
      const text = prefix + chunk.toString('utf8'), match = QUICK_URL.exec(text)
      if (match !== null) { proc.publicUrl = match[0]; confirm() }
      prefix = text.slice(-URL_PREFIX_CHARS)
    }
  }
  const scanOut = scanner(), scanError = scanner()
  const probe = (): void => {
    if (settled || registered) return
    try {
      if (!lstatSync(pidFile).isFile()) throw new Error('Connector registration is not a regular file')
      const flags = process.platform === 'win32' ? constants.O_RDONLY
        : constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
      const descriptor = openSync(pidFile, flags)
      try {
        const metadata = fstatSync(descriptor)
        if (!metadata.isFile() || metadata.size > PID_BYTES) throw new Error('Invalid connector registration file')
        const bytes = Buffer.alloc(PID_BYTES + 1), count = readSync(descriptor, bytes, 0, bytes.length, 0)
        if (count > PID_BYTES) throw new Error('Connector registration file exceeds its byte limit')
        // This file proves registration only; it never supplies a signalling target.
        registered = child.pid !== undefined && bytes.subarray(0, count).toString('utf8') === String(child.pid)
      } finally { closeSync(descriptor) }
      confirm()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail(new TunnelSupervisorError('start-failed', 'cloudflared registration could not be read', error))
    }
  }
  const abort = (): void => { fail(options.signal?.reason ?? new Error('Tunnel startup cancelled')) }
  const deadline = setTimeout(() => {
    probe()
    fail(new TunnelSupervisorError('startup-timeout', 'cloudflared did not confirm connector registration in time'))
  }, options.startupTimeoutMs)
  const poll = setInterval(probe, options.probeIntervalMs)
  if (command.kind === 'quick') { child.stdout?.on('data', scanOut); child.stderr?.on('data', scanError) }
  child.stdout?.resume(); child.stderr?.resume()
  const parentExit = (): void => {
    try { signal('SIGKILL') } catch (_exitSignalFailure) {
      // Process-exit hooks cannot retry; forced Gateway death requires host service containment.
    }
  }
  process.once('exit', parentExit)
  child.on('error', (_error: Error) => { fail(new TunnelSupervisorError('start-failed', 'cloudflared could not start')) })
  child.once('close', (code, exitSignal) => {
    closed = true; process.off('exit', parentExit)
    fail(new TunnelSupervisorError('start-failed', `cloudflared closed before registration (code ${String(code)}, signal ${String(exitSignal)})`))
    resolveExit({ code, signal: exitSignal })
  })
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  return proc

  function signal(value: NodeJS.Signals): void {
    if (closed || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
    if (process.platform !== 'win32') {
      try { process.kill(-child.pid, value); return } catch (_groupUnavailable) {
        // The direct native handle remains available when its group cannot be signalled.
      }
    }
    child.kill(value)
  }

  async function stop(graceMs: number): Promise<void> {
    fail(new TunnelSupervisorError('start-failed', 'cloudflared startup was stopped'))
    if (!closed) await new Promise<void>((resolve, reject) => {
      let force: NodeJS.Timeout | undefined, timeout: NodeJS.Timeout | undefined
      let finished = false
      const finish = (error?: unknown): void => {
        if (finished) return
        finished = true
        clearTimeout(force); clearTimeout(timeout); child.off('close', onClose)
        if (error === undefined) resolve(); else reject(new TunnelSupervisorError('stop-unconfirmed', 'cloudflared closure could not be confirmed', error))
      }
      const onClose = (): void => { finish() }
      child.once('close', onClose)
      try {
        signal('SIGTERM')
        if (finished) return
        force = setTimeout(() => {
          try { signal('SIGKILL') } catch (error) { finish(error); return }
          if (finished) return
          timeout = setTimeout(() => { finish(new Error('Connector close deadline exceeded')) }, options.closeTimeoutMs)
        }, graceMs)
      } catch (error) { finish(error) }
    })
    try { cleanup() } catch (error) { throw new TunnelSupervisorError('stop-unconfirmed', 'cloudflared private-file cleanup could not be confirmed', error) }
  }
}
