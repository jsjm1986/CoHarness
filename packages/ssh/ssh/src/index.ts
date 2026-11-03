/** OpenSSH connection owner for one version-matched POSIX helper and its independent forwarded streams. */

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createConnection, type Socket } from 'node:net'
import { Context, Service } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { SshRpcPeer, SSH_PROTOCOL_VERSION } from './protocol.ts'
import { helloSchema, type SshStreamEndpoint } from './schemas.ts'
import { authenticateStream } from './stream-security.ts'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessHandle, SubprocessOutputReader, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

type Hello = z.infer<typeof helloSchema>

/** Installed helper invocation; script deployments may also install a PTC bootstrap. */
export type HelperLaunch = {
  /** Run the installed script with a separately installed Node executable. */
  kind: 'node-script'
  /** Absolute remote Node executable. */
  node: string
  /** Absolute remote PTC bootstrap; requires bootstrapHash. */
  bootstrapPath?: string
  /** Lowercase SHA-256 of bootstrapPath; requires that path. */
  bootstrapHash?: string
} | {
  /** Run the helper executable with its embedded Node and PTC worker. */
  kind: 'executable'
}

/** Deployment-owned SSH identity and installed helper; no model argument selects these values. */
export interface Config {
  /** OpenSSH host alias, including its existing user, key and known-host configuration. */
  host: string
  /** Explicit script or self-contained executable invocation. */
  launch: HelperLaunch
  /** Absolute path to the installed, bundled helper entry. */
  helper: string
  /** SHA-256 of that bundled helper; mismatches refuse the connection. */
  helperHash: string
  /** Absolute remote default workspace. */
  workspace: string
  /**
   * Credential reference supplying the account password. When set, OpenSSH
   * reads the secret through `SSH_ASKPASS` instead of `BatchMode`; the value
   * is resolved per connection and never enters argv, the process
   * environment, session data, or logs.
   */
  passwordRef?: string
  /** Connection and administrative-request deadline, at most 2,147,483,647 milliseconds. */
  requestTimeoutMs?: number
  /** Maximum JSON payload bytes per helper request or response. */
  maxFrameBytes?: number
  /** Maximum ordinary requests; heartbeat and bounded resource cleanup have reserved capacity. */
  maxPending?: number
  /** Remote helper lease; loss of heartbeats starts remote managed cleanup. */
  leaseMs?: number
}

type ResolvedConfig = Required<Omit<Config, 'passwordRef'>> & Pick<Config, 'passwordRef'>

declare module '@deepseek-ai/cordis' {
  interface Context {
    ssh: SshConnection
    /** Managed deployments provide target authorization; absent in standalone compositions. */
    sshAuthorization?: SshAuthorization
  }
}


declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The interactive caller has no current SSH qualification or project share. */
    'ssh/forbidden': Record<string, never>
  }
}

/** Access subject narrowed by a Gateway revocation; empty means every mounted connection. */
export interface SshInvalidationSubject {
  readonly userId?: number
  readonly projectId?: number
}

/** One authorized resolution of an administrator-registered SSH target. */
export interface SshResolvedTarget {
  /** Server-confirmed interactive account; connection owners attribute mounts to it. */
  readonly userId: number
  /** Connection coordinates released to this runtime scope. */
  readonly config: Config
  /** Aborts when the resolution's authority is revoked; mount owners tie connection teardown to it. */
  readonly signal: AbortSignal
  /**
   * Release a resolution the caller never mounted. Mount owners tie the
   * connection's lifetime to {@link signal} and never call this; callers that
   * only checked admission release the tracked grant so a read-heavy caller
   * does not accumulate one record per check.
   */
  release?(): void
}

/**
 * Managed-deployment authorization for registered SSH targets. Managed runtimes
 * resolve connection coordinates only through this service; standalone
 * compositions keep static provider configuration instead.
 */
export interface SshAuthorization {
  /**
   * Resolve one registered target's connection configuration for the interactive caller.
   * @param targetId - administrator-registered target's public id.
   * @param signal - caller cancellation.
   * @returns the caller identity and connection configuration.
   */
  resolve(targetId: number, signal?: AbortSignal): Promise<SshResolvedTarget>
  /**
   * Subscribe to access revocation; mounted-connection owners dispose affected connections.
   * @param listener - receives the narrowed subject; an empty subject revokes everything.
   * @returns unsubscription.
   */
  onInvalidated(listener: (subject: SshInvalidationSubject) => void): Disposable
}

/** Runtime defaults shared by the plugin Config schema and the direct-construction parser. */
const SSH_CONNECTION_DEFAULTS = {
  requestTimeoutMs: 30_000, maxFrameBytes: 64 * 1024 * 1024, maxPending: 128, leaseMs: 30_000,
} as const

/** Remote loopback listener owned by one local service and this SSH connection. */
export interface SshLoopbackForward {
  /** Dynamically allocated TCP port on the remote loopback interface. */
  readonly port: number
  /**
   * Drain the local consumer, cancel the remote listener and confirm cancellation through the helper.
   * @returns after consumer cleanup and forwarding removal; failure invalidates the connection.
   */
  close(): Promise<void>
}

/** One non-reconnecting SSH session; loss invalidates all active operations. */
export class SshConnection extends Service {
  static Config: schema<Config> = schema.object({
    host: schema.string().required(), helper: schema.string().required(),
    launch: schema.union([
      schema.object({ kind: schema.const('node-script').required(), node: schema.string().required(), bootstrapPath: schema.string(), bootstrapHash: schema.string() }),
      schema.object({ kind: schema.const('executable').required() }),
    ]).required(),
    helperHash: schema.string().required(), workspace: schema.string().required(),
    requestTimeoutMs: schema.number().default(SSH_CONNECTION_DEFAULTS.requestTimeoutMs),
    maxFrameBytes: schema.number().default(SSH_CONNECTION_DEFAULTS.maxFrameBytes),
    maxPending: schema.number().default(SSH_CONNECTION_DEFAULTS.maxPending),
    leaseMs: schema.number().default(SSH_CONNECTION_DEFAULTS.leaseMs),
    passwordRef: schema.string(),
  })

  /** Verified remote helper coordinates; callers must await this before launch. */
  readonly ready: Promise<Hello>
  private rpc: SshRpcPeer | undefined
  private child: SubprocessHandle | undefined
  private childClosed: Promise<void> | undefined
  private readonly local: Promise<SubprocessRuntime>
  private starting = true
  private directory: string | undefined
  private heartbeat: NodeJS.Timeout | undefined
  private closed = false
  private readonly lifetime = new AbortController()
  private readonly processLifetime = new AbortController()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly consumers = new Set<() => Promise<void>>()
  private disposal: Promise<void> | undefined
  private failure: Error | undefined
  private sockets = new Set<Socket>()
  private nextSocket = 0
  private readonly loopbackPorts = new Set<number>()
  private readonly config: ResolvedConfig
  private remote: Hello | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx, 'ssh')
    if (process.platform !== 'linux' && process.platform !== 'darwin') throw new Error('SSH runtime requires a POSIX client')
    // Direct construction bypasses the static Config schema, so the runtime
    // parser carries the same defaults: a managed target row that stores no
    // tuning still constructs with the documented values.
    this.config = z.object({
      host: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/),
      launch: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('node-script'), node: z.string().startsWith('/'),
          bootstrapPath: z.string().startsWith('/').optional(), bootstrapHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
        }).strict().refine(value => (value.bootstrapPath === undefined) === (value.bootstrapHash === undefined), 'bootstrapPath and bootstrapHash must be paired'),
        z.object({ kind: z.literal('executable') }).strict(),
      ]),
      helper: z.string().startsWith('/'), helperHash: z.string().regex(/^[0-9a-f]{64}$/),
      workspace: z.string().startsWith('/'), requestTimeoutMs: z.number().int().positive().max(2_147_483_647).default(SSH_CONNECTION_DEFAULTS.requestTimeoutMs),
      maxFrameBytes: z.number().int().positive().max(64 * 1024 * 1024).default(SSH_CONNECTION_DEFAULTS.maxFrameBytes),
      maxPending: z.number().int().positive().max(128).default(SSH_CONNECTION_DEFAULTS.maxPending),
      leaseMs: z.number().int().min(3000).max(600_000).default(SSH_CONNECTION_DEFAULTS.leaseMs),
      passwordRef: z.string().refine(isCredentialRefName, 'passwordRef must be a credential reference').optional(),
    }).strict().parse(config) as ResolvedConfig
    const local = ctx.isolate('subprocess').plugin(LocalSubprocessRuntime)
    this.local = Promise.resolve(local).then(() => local.ctx.subprocess)
    ctx.effect(() => [local.dispose, async () => {
      try { await this.dispose() } finally { await local.dispose() }
    }], 'ssh.local-process-owner')
    ctx.on('internal/plugin', (fiber) => {
      if (this.starting && fiber === ctx.fiber && fiber.uid === null) {
        this.processLifetime.abort(new Error('SSH connection closed during startup'))
      }
    })
    this.ready = this.start()
    // Startup uses Node I/O, local validation, and Error-valued RPC failures.
    void this.ready.then(() => { this.starting = false }, (error: unknown) => { this.starting = false; this.fail(error as Error) })
  }

  /** Hold plugin readiness until the remote identity and helper digest are verified. */
  async [Service.init](): Promise<void> { await this.ready }

  /**
   * Keep admitted resource cleanup owned until it settles, including consumer-only disposal.
   * @param cleanup - stop allocation and drain resources before the SSH transport closes.
   * @returns the shared cleanup disposer; failed cleanup remains retained by the connection.
   */
  retainConsumer(cleanup: () => Promise<void>): () => Promise<void> {
    this.assertOpen()
    let closing: Promise<void> | undefined
    const close = (): Promise<void> => closing ??= Promise.resolve().then(cleanup).then(() => { this.consumers.delete(close) })
    this.consumers.add(close)
    return close
  }

  /** Verified remote PTC launch configuration; script deployments require a verified bootstrap. */
  get ptcLaunch(): { kind: 'embedded'; executable: string } | { kind: 'node-script'; executable: string; bootstrapPath: string } {
    if (this.remote === undefined) throw new Error('SSH helper is not ready')
    const launch = this.config.launch
    switch (launch.kind) {
      case 'executable': return { kind: 'embedded', executable: this.remote.executable }
      case 'node-script':
        if (launch.bootstrapPath === undefined) throw new Error('SSH PTC requires a verified bootstrapPath and bootstrapHash')
        return { kind: 'node-script', executable: this.remote.executable, bootstrapPath: launch.bootstrapPath }
      /* v8 ignore next -- Config parsing admits only these two launch kinds. */
      default: return assertNever(launch)
    }
  }

  /**
   * Send a helper operation; admitted process termination and wait remain usable while closing.
   * Cancellation never replays an ambiguous mutation.
   * @param method - the private helper operation.
   * @param params - JSON request fields validated by the helper.
   * @param result - response validation before returning provider-visible data.
   * @param signal - cancellation, which does not undo completed remote effects.
   * @param wait - allow a process observation to outlast the administrative deadline.
   * @returns the validated remote result.
   */
  async request<T>(method: string, params: unknown, result: z.ZodType<T>, signal?: AbortSignal, wait: boolean = false): Promise<T> {
    const cleanup = method === 'process.terminate' || method === 'process.wait'
    this.assertOpen(cleanup)
    await this.ready
    this.assertOpen(cleanup)
    const bounded = wait ? signal : signal === undefined
      ? AbortSignal.timeout(this.config.requestTimeoutMs)
      : AbortSignal.any([signal, AbortSignal.timeout(this.config.requestTimeoutMs)])
    return (this.rpc as SshRpcPeer).request(method, params, result, bounded)
  }

  /**
   * Forward one authenticated stream through an independent SSH channel.
   * @param endpoint - private coordinates issued by this connection's helper.
   * @param signal - cancellation of allocation and the resulting socket.
   * @returns a paused socket; attach a consumer before resuming it.
   * @throws Failed forwarding rollback invalidates the connection and joins its native process observation.
   */
  async connectStream(endpoint: SshStreamEndpoint, signal?: AbortSignal): Promise<Socket> {
    return this.track(this.establishStream(endpoint, signal))
  }

  private async establishStream(endpoint: SshStreamEndpoint, signal?: AbortSignal): Promise<Socket> {
    const hello = await this.ready
    this.assertOpen()
    signal = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
    const remote = endpoint.path
    if (!remote.startsWith(`${hello.root}/`) || /[:\r\n\0]/u.test(remote)) throw new Error('SSH helper returned an invalid stream path')
    signal.throwIfAborted()
    const local = join(this.directory as string, `s${this.nextSocket++}`)
    const forward = `${local}:${remote}`
    const cancelForward = async (): Promise<void> => {
      try {
        if (!this.closed && this.failure === undefined) {
          await this.controlCommand(['-O', 'cancel', '-L', forward], undefined, true)
        }
        if (this.failure !== undefined) await this.childClosed
        await rm(local, { force: true })
      } catch (error) {
        const failure = new Error('SSH stream forwarding cleanup could not be confirmed', { cause: error })
        this.fail(failure)
        try { await this.childClosed } catch (observationError) {
          throw new AggregateError([failure, observationError], 'SSH stream forwarding cleanup and process observation failed')
        }
        throw failure
      }
    }
    try {
      await this.controlCommand(['-O', 'forward', '-o', 'ExitOnForwardFailure=yes', '-L', forward], signal)
      signal.throwIfAborted()
    } catch (error) {
      try { await cancelForward() } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'SSH stream allocation and forwarding cleanup failed')
      }
      throw error
    }
    const socket = createConnection({ path: local, allowHalfOpen: true })
    this.sockets.add(socket)
    socket.once('close', () => {
      this.sockets.delete(socket)
      void this.track(cancelForward()).catch(() => {})
    })
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        signal.removeEventListener('abort', aborted)
        socket.off('connect', connected)
        socket.off('error', failed)
        socket.off('close', closed)
      }
      const connected = (): void => { cleanup(); resolve() }
      const failed = (error: Error): void => { cleanup(); reject(error) }
      const closed = (): void => { failed(new Error('SSH connection closed before stream establishment')) }
      const aborted = (): void => { socket.destroy(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason))) }
      socket.once('connect', connected)
      socket.once('error', failed)
      socket.once('close', closed)
      signal.addEventListener('abort', aborted, { once: true })
    })
    const authenticated = await authenticateStream(socket, endpoint.capability, this.config.requestTimeoutMs, signal)
    this.sockets.add(authenticated)
    authenticated.on('error', () => { authenticated.destroy() })
    authenticated.once('close', () => { this.sockets.delete(authenticated) })
    return authenticated
  }

  /**
   * Expose one local service exclusively through a remote loopback listener.
   * @param localPort - TCP port of the caller-owned service on local 127.0.0.1.
   * @param beforeClose - abort and join that service before its SSH transport is released.
   * @param signal - optional cancellation; omission keeps the forward until explicit or connection cleanup.
   * An allocation already sent to OpenSSH settles before cancellation rolls it back.
   * @returns the requested remote loopback port and its idempotent, retained cleanup owner.
   */
  forwardLoopback(localPort: number, beforeClose: () => Promise<void>, signal?: AbortSignal): Promise<SshLoopbackForward> {
    return this.track(this.establishLoopback(localPort, beforeClose, signal))
  }

  private async establishLoopback(localPort: number, beforeClose: () => Promise<void>, signal?: AbortSignal): Promise<SshLoopbackForward> {
    await this.ready
    this.assertOpen()
    signal?.throwIfAborted()
    if (this.loopbackPorts.has(localPort)) throw new Error('SSH local loopback service already has a forwarding owner')
    this.loopbackPorts.add(localPort)
    const ownedSignal = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
    const forwarding = `127.0.0.1:0:127.0.0.1:${localPort}`
    let allocatedPort: number | undefined
    const close = this.retainConsumer(async () => {
      ownedSignal.removeEventListener('abort', aborted)
      await opening.catch(() => {})
      const failures: unknown[] = []
      try { await beforeClose() } catch (error) { failures.push(error) }
      if (allocatedPort !== undefined) {
        try {
          // OpenSSH identifies a dynamic forward by its original zero-port request.
          await this.controlCommand(['-O', 'cancel', '-R', forwarding], undefined, true)
          // The mux acknowledgement queues cancellation; this later round trip
          // confirms that the remote transport has processed it.
          await (this.rpc as SshRpcPeer).request('heartbeat', {}, z.null(), AbortSignal.timeout(this.config.requestTimeoutMs))
        } catch (error) { failures.push(error) }
      }
      if (allocatedPort === undefined || failures.length > 0) {
        this.fail(new Error('SSH reverse forwarding cleanup could not be confirmed'))
        try { await this.childClosed } catch (error) { failures.push(error) }
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'SSH loopback forwarding cleanup failed')
      this.loopbackPorts.delete(localPort)
    })
    const aborted = (): void => { void this.track(close()).catch(() => {}) }
    // Once sent, allocation must return its port before caller cancellation can
    // remove it. The connection's administrative deadline still bounds this wait.
    const opening = this.controlCommand(['-O', 'forward', '-o', 'ExitOnForwardFailure=yes', '-R', forwarding], undefined, true).then((output) => {
      const port = output.trim()
      if (!/^[1-9][0-9]{0,4}$/u.test(port) || Number(port) > 65535) throw new Error('SSH returned an invalid allocated port')
      allocatedPort = Number(port)
      return allocatedPort
    })
    ownedSignal.addEventListener('abort', aborted, { once: true })
    try {
      const port = await opening
      ownedSignal.throwIfAborted()
      this.assertOpen()
      return { port, close }
    } catch (error) {
      try { await close() } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'SSH loopback forwarding allocation and cleanup failed')
      }
      throw error
    }
  }

  /** Drain retained consumers and the reachable helper before awaiting the local SSH process range. */
  dispose(): Promise<void> {
    this.disposal ??= this.disposeOnce()
    return this.disposal
  }

  private async disposeOnce(): Promise<void> {
    this.closed = true
    this.lifetime.abort(new Error('SSH connection is closing'))
    if (this.starting) this.processLifetime.abort(new Error('SSH connection closed before startup'))
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    const failures: unknown[] = []
    try {
      await this.ready.catch(() => {})
      const consumers = await Promise.allSettled([...this.consumers].map(close => close()))
      for (const outcome of consumers) if (outcome.status === 'rejected') failures.push(outcome.reason)
      if (this.failure === undefined) {
        try { await this.rpc?.request('close', {}, z.null(), AbortSignal.timeout(this.config.requestTimeoutMs)) }
        catch (error) { failures.push(error) }
      }
    } finally {
      this.rpc?.close()
      // TLS wrappers release their reads before their underlying sockets close.
      const socketClosures = [...this.sockets].reverse().map(socket => new Promise<void>((resolve) => {
        if (socket.closed) resolve()
        else { socket.once('close', () => { resolve() }); socket.destroy() }
      }))
      this.child?.terminate()
      this.processLifetime.abort(new Error('SSH transport is closing'))
      const stopped = await Promise.allSettled([this.childClosed, ...socketClosures])
      for (const outcome of stopped) if (outcome.status === 'rejected') failures.push(outcome.reason)
      while (this.operations.size > 0) await Promise.allSettled([...this.operations])
      if (this.directory !== undefined && stopped[0].status === 'fulfilled') {
        try { await rm(this.directory, { recursive: true, force: true }) } catch (error) { failures.push(error) }
      }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'SSH resource cleanup failed')
  }

  private controlPath(): string { return join(this.directory as string, 'master') }

  private assertOpen(cleanup = false): void {
    if (this.closed && !cleanup) throw new Error('SSH connection is closed')
    if (this.failure !== undefined) throw this.failure
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation)
    void operation.finally(() => { this.operations.delete(operation) }).catch(() => {})
    return operation
  }

  private async controlCommand(args: string[], signal?: AbortSignal, cleanup = false): Promise<string> {
    const signals = [cleanup ? this.processLifetime.signal : this.lifetime.signal, AbortSignal.timeout(this.config.requestTimeoutMs)]
    if (signal !== undefined) signals.push(signal)
    const combined = AbortSignal.any(signals)
    combined.throwIfAborted()
    const local = await this.local
    const command = await local.spawn({
      argv: ['ssh', '-S', this.controlPath(), '-o', 'LogLevel=ERROR', ...args, this.config.host],
      cwd: this.directory as string, resourceOrigin: 'infrastructure', signal: combined,
      graceMs: this.config.requestTimeoutMs,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 64 * 1024 }, stderr: { maxBytes: 64 * 1024 } },
    })
    try {
      const result = await command.done
      const stdout = (command.collected.stdout as SubprocessOutputReader).readFrom(0)
      const stderr = (command.collected.stderr as SubprocessOutputReader).readFrom(0)
      // Some OpenSSH mux failures report exit zero with an error on stderr.
      if (result.exitCode !== 0 || stdout.lossy || stderr.lossy || stderr.text.trim() !== '') {
        throw new Error('SSH forwarding control command failed')
      }
      return stdout.text
    } finally {
      command.terminate()
      if (!await command.waitForExit(AbortSignal.timeout(this.config.requestTimeoutMs))) {
        throw new Error('SSH forwarding control command cleanup could not be confirmed')
      }
    }
  }

  private fail(error: Error): void {
    if (this.failure !== undefined) return
    this.failure = error
    this.lifetime.abort(error)
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    this.rpc?.close(error)
    for (const socket of [...this.sockets].reverse()) socket.destroy(error)
    this.child?.terminate()
  }

  /**
   * Resolve `passwordRef` once and stage the OpenSSH askpass pair under the
   * connection's private directory. The password lands only in a 0600 file
   * that `rm` removes; the returned disposer runs once authentication has
   * concluded, success or failure.
   * @returns the material's cleanup, or undefined for key-only connections.
   */
  private async prepareAskpass(): Promise<(() => Promise<void>) | undefined> {
    const ref = this.config.passwordRef
    if (ref === undefined) return undefined
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) throw new Error('SSH passwordRef requires the credentials service')
    const hit = await credentials.resolve(credentialRef(ref))
    if (hit === undefined || hit.value === '') {
      throw new Error(`SSH password credential "${ref}" is not configured`)
    }
    const directory = this.directory as string
    const passwordPath = join(directory, 'password')
    const askpassPath = join(directory, 'askpass')
    await writeFile(passwordPath, hit.value, { mode: 0o600 })
    // The helper derives its sibling path so the script text carries no secret.
    await writeFile(askpassPath, '#!/bin/sh\nexec cat "$(dirname "$0")/password"\n', { mode: 0o700 })
    await chmod(passwordPath, 0o600)
    return async () => {
      await rm(passwordPath, { force: true })
      await rm(askpassPath, { force: true })
    }
  }

  private async start(): Promise<Hello> {
    const local = await this.local
    this.processLifetime.signal.throwIfAborted()
    this.directory = await mkdtemp('/tmp/dsh-ssh-')
    const releaseAskpass = await this.prepareAskpass()
    if (this.closed) throw new Error('SSH connection closed before startup')
    const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
    const launch = this.config.launch
    let command: string
    let bootstrapPath: string | undefined
    let bootstrapHash: string | undefined
    switch (launch.kind) {
      case 'node-script':
        command = [launch.node, '--disable-sigusr1', this.config.helper].map(quote).join(' ')
        bootstrapPath = launch.bootstrapPath
        bootstrapHash = launch.bootstrapHash
        break
      case 'executable':
        command = `NODE_OPTIONS='--disable-sigusr1' ${quote(this.config.helper)}`
        break
      /* v8 ignore next -- Config parsing admits only these two launch kinds. */
      default: return assertNever(launch)
    }
    const child = await local.spawn({ argv: ['ssh',
      '-T', '-M', '-S', this.controlPath(), '-o', 'ControlPersist=no',
      '-o', `BatchMode=${releaseAskpass === undefined ? 'yes' : 'no'}`,
      ...(releaseAskpass === undefined ? [] : ['-o', 'NumberOfPasswordPrompts=1']),
      '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
      '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3', this.config.host, command,
    ], cwd: this.directory, resourceOrigin: 'infrastructure', signal: this.processLifetime.signal,
    graceMs: this.config.requestTimeoutMs,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    ...(releaseAskpass === undefined ? {} : {
      env: {
        SSH_ASKPASS: join(this.directory, 'askpass'),
        SSH_ASKPASS_REQUIRE: 'force',
        // OpenSSH releases predating SSH_ASKPASS_REQUIRE still consult
        // askpass only when DISPLAY is set without a controlling tty.
        DISPLAY: 'dsh-ssh:0',
      },
    }),
    })
    this.child = child
    this.childClosed = child.waitForExit().then((exited) => {
      if (!exited) throw new Error('SSH transport cleanup could not be confirmed')
    })
    void this.childClosed.catch(() => {})
    const disconnected = (cause?: unknown): void => {
      this.fail(new Error('SSH helper disconnected; remote outcomes and cleanup are unknown', { cause }))
    }
    void child.done.then(() => { disconnected() }, (error: unknown) => {
      this.fail(error instanceof Error ? error : new Error('SSH transport failed', { cause: error }))
    })
    const { stdout, stdin, stderr } = child
    if (stdout === undefined || stdin === undefined || stderr === undefined) throw new Error('SSH transport requires piped standard streams')
    stderr.resume() // SSH diagnostics can contain configured paths; operation errors remain structured.
    const rpc = new SshRpcPeer(stdout, stdin, this.config.maxFrameBytes, this.config.maxPending)
    this.rpc = rpc
    rpc.once('closed', (error) => { this.fail(error as Error) })
    let hello: Hello
    try {
      hello = await rpc.request('hello', {
        protocol: SSH_PROTOCOL_VERSION, workspace: this.config.workspace, leaseMs: this.config.leaseMs,
        ...(bootstrapPath === undefined ? {} : { bootstrapPath }),
      }, helloSchema, AbortSignal.timeout(this.config.requestTimeoutMs))
    } finally {
      // Authentication has concluded one way or the other: the master refuses
      // re-authentication under ControlPersist=no, so the password material
      // leaves the filesystem here rather than at connection disposal.
      await releaseAskpass?.()
    }
    if (hello.hash !== this.config.helperHash) throw new Error('SSH helper digest differs from the configured artifact')
    if (hello.kind !== launch.kind) throw new Error('SSH helper runtime differs from the configured launch kind')
    if (hello.bootstrapHash !== bootstrapHash) throw new Error('SSH PTC bootstrap digest differs from the configured artifact')
    this.remote = hello
    let heartbeatPending: Promise<unknown> | undefined
    this.heartbeat = setInterval(() => {
      heartbeatPending ??= rpc.request('heartbeat', {}, z.null(), AbortSignal.timeout(this.config.leaseMs / 2))
        .catch((error: unknown) => { this.fail(error as Error) })
        .finally(() => { heartbeatPending = undefined })
    }, Math.floor(this.config.leaseMs / 3))
    this.heartbeat.unref()
    return hello
  }
}

export default SshConnection
