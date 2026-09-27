/** OpenSSH connection owner for one version-matched POSIX helper and its independent forwarded streams. */

import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createConnection, type Socket } from 'node:net'
import { Context, Service } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import { z } from 'zod'
import { SshRpcPeer, SSH_PROTOCOL_VERSION } from './protocol.ts'
import { helloSchema, type SshStreamEndpoint } from './schemas.ts'
import { authenticateStream } from './stream-security.ts'

type Hello = z.infer<typeof helloSchema>

/** Deployment-owned SSH identity and installed helper; no model argument selects these values. */
export interface Config {
  /** OpenSSH host alias, including its existing user, key and known-host configuration. */
  host: string
  /** Absolute remote Node executable. */
  node: string
  /** Absolute path to the installed, bundled helper entry. */
  helper: string
  /** SHA-256 of that bundled helper; mismatches refuse the connection. */
  helperHash: string
  /** Absolute remote default workspace. */
  workspace: string
  /** Optional preinstalled built PTC entry, paired with its expected digest. */
  bootstrapPath?: string
  /** SHA-256 of bootstrapPath; both fields must be supplied together. */
  bootstrapHash?: string
  /** Connection and administrative-request deadline, at most 2,147,483,647 milliseconds. */
  requestTimeoutMs?: number
  /** Maximum JSON payload bytes per helper request or response. */
  maxFrameBytes?: number
  /** Maximum ordinary requests; heartbeat and bounded resource cleanup have reserved capacity. */
  maxPending?: number
  /** Remote helper lease; loss of heartbeats starts remote managed cleanup. */
  leaseMs?: number
  /**
   * Credential reference supplying the account password. When set, OpenSSH
   * reads the secret through `SSH_ASKPASS` instead of `BatchMode`; the value
   * is resolved per connection and never enters argv, the process
   * environment, session data, or logs.
   */
  passwordRef?: string
}

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

/** One non-reconnecting SSH session; loss invalidates all active operations. */
export class SshConnection extends Service {
  static Config: schema<Config> = schema.object({
    host: schema.string().required(), node: schema.string().required(), helper: schema.string().required(),
    helperHash: schema.string().required(), workspace: schema.string().required(),
    bootstrapPath: schema.string(), bootstrapHash: schema.string(),
    requestTimeoutMs: schema.number().default(SSH_CONNECTION_DEFAULTS.requestTimeoutMs),
    maxFrameBytes: schema.number().default(SSH_CONNECTION_DEFAULTS.maxFrameBytes),
    maxPending: schema.number().default(SSH_CONNECTION_DEFAULTS.maxPending),
    leaseMs: schema.number().default(SSH_CONNECTION_DEFAULTS.leaseMs),
    passwordRef: schema.string(),
  })

  /** Verified remote helper coordinates; callers must await this before launch. */
  readonly ready: Promise<Hello>
  private rpc: SshRpcPeer | undefined
  private child: ChildProcessWithoutNullStreams | undefined
  private childClosed: Promise<void> | undefined
  private directory: string | undefined
  private heartbeat: NodeJS.Timeout | undefined
  private closed = false
  private readonly lifetime = new AbortController()
  private readonly operations = new Set<Promise<unknown>>()
  private disposal: Promise<void> | undefined
  private failure: Error | undefined
  private sockets = new Set<Socket>()
  private nextSocket = 0
  private readonly config: Required<Omit<Config, 'bootstrapPath' | 'bootstrapHash' | 'passwordRef'>>
    & Pick<Config, 'bootstrapPath' | 'bootstrapHash' | 'passwordRef'>
  private remote: Hello | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx, 'ssh')
    if (process.platform !== 'linux' && process.platform !== 'darwin') throw new Error('SSH runtime requires a POSIX client')
    // Direct construction bypasses the static Config schema, so the runtime
    // parser carries the same defaults: a managed target row that stores no
    // tuning still constructs with the documented values.
    this.config = z.object({
      host: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/),
      node: z.string().startsWith('/'), helper: z.string().startsWith('/'), helperHash: z.string().regex(/^[0-9a-f]{64}$/),
      workspace: z.string().startsWith('/'),
      requestTimeoutMs: z.number().int().positive().max(2_147_483_647).default(SSH_CONNECTION_DEFAULTS.requestTimeoutMs),
      bootstrapPath: z.string().startsWith('/').optional(), bootstrapHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
      maxFrameBytes: z.number().int().positive().max(64 * 1024 * 1024).default(SSH_CONNECTION_DEFAULTS.maxFrameBytes),
      maxPending: z.number().int().positive().max(128).default(SSH_CONNECTION_DEFAULTS.maxPending),
      leaseMs: z.number().int().min(3000).max(600_000).default(SSH_CONNECTION_DEFAULTS.leaseMs),
      passwordRef: z.string().refine(isCredentialRefName, 'passwordRef must be a credential reference').optional(),
    }).refine(value => (value.bootstrapPath === undefined) === (value.bootstrapHash === undefined), 'bootstrapPath and bootstrapHash must be paired')
      .parse(config) as typeof this.config
    this.ready = this.start()
    // Startup uses Node I/O, local validation, and Error-valued RPC failures.
    void this.ready.catch((error: unknown) => { this.fail(error as Error) })
    ctx.effect(() => () => this.dispose())
  }

  /** Hold plugin readiness until the remote identity and helper digest are verified. */
  async [Service.init](): Promise<void> { await this.ready }

  /** Verified remote Node executable for the paired PTC runtime. */
  get nodeExecutable(): string {
    if (this.remote === undefined) throw new Error('SSH helper is not ready')
    return this.remote.node
  }

  /** Verified preinstalled PTC entry; unconfigured runtimes fail before program execution. */
  get bootstrapPath(): string {
    if (this.remote === undefined || this.config.bootstrapPath === undefined) throw new Error('SSH PTC requires a verified bootstrapPath and bootstrapHash')
    return this.config.bootstrapPath
  }

  /**
   * Send a helper operation; cancellation never replays an ambiguous mutation.
   * @param method - the private helper operation.
   * @param params - JSON request fields validated by the helper.
   * @param result - response validation before returning provider-visible data.
   * @param signal - cancellation, which does not undo completed remote effects.
   * @param wait - allow a process observation to outlast the administrative deadline.
   * @returns the validated remote result.
   */
  async request<T>(method: string, params: unknown, result: z.ZodType<T>, signal?: AbortSignal, wait: boolean = false): Promise<T> {
    this.assertOpen()
    await this.ready
    this.assertOpen()
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
      // An unavailable master already removed its forwarding listeners.
      if (!this.closed) await this.controlCommand(['-O', 'cancel', '-L', forward]).catch(() => {})
      await rm(local, { force: true })
    }
    try {
      await this.controlCommand(['-O', 'forward', '-o', 'ExitOnForwardFailure=yes', '-L', forward], signal)
    } catch (error) { await cancelForward(); throw error }
    signal.throwIfAborted()
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

  /** Tear down the helper's remote managed ranges before releasing the SSH master when reachable. */
  dispose(): Promise<void> {
    this.disposal ??= this.disposeOnce()
    return this.disposal
  }

  private async disposeOnce(): Promise<void> {
    this.closed = true
    this.lifetime.abort(new Error('SSH connection is closing'))
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    try {
      await this.ready.catch(() => {})
      if (this.failure === undefined) await this.rpc?.request('close', {}, z.null(), AbortSignal.timeout(this.config.requestTimeoutMs))
    } finally {
      this.rpc?.close()
      // TLS wrappers release their reads before their underlying sockets close.
      const socketClosures = [...this.sockets].reverse().map(socket => new Promise<void>((resolve) => {
        if (socket.closed) resolve()
        else { socket.once('close', () => { resolve() }); socket.destroy() }
      }))
      this.child?.kill('SIGTERM')
      const force = setTimeout(() => { this.child?.kill('SIGKILL') }, this.config.requestTimeoutMs)
      try { await this.childClosed } finally { clearTimeout(force) }
      await Promise.all(socketClosures)
      while (this.operations.size > 0) await Promise.allSettled([...this.operations])
      if (this.directory !== undefined) await rm(this.directory, { recursive: true, force: true })
    }
  }

  private controlPath(): string { return join(this.directory as string, 'master') }

  private assertOpen(): void {
    if (this.closed) throw new Error('SSH connection is closed')
    if (this.failure !== undefined) throw this.failure
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation)
    void operation.finally(() => { this.operations.delete(operation) }).catch(() => {})
    return operation
  }

  private async controlCommand(args: string[], signal?: AbortSignal): Promise<void> {
    const signals = [this.lifetime.signal, AbortSignal.timeout(this.config.requestTimeoutMs)]
    if (signal !== undefined) signals.push(signal)
    const combined = AbortSignal.any(signals)
    combined.throwIfAborted()
    const result = Promise.withResolvers<undefined>()
    const command = execFile('ssh', ['-S', this.controlPath(), ...args, this.config.host], {
      signal: combined, maxBuffer: 64 * 1024,
    }, (error) => { if (error === null) result.resolve(undefined); else result.reject(error) })
    const closed = new Promise<void>((resolve) => { command.once('close', () => { resolve() }) })
    let force: NodeJS.Timeout | undefined
    const escalate = (): void => {
      force = setTimeout(() => { command.kill('SIGKILL') }, this.config.requestTimeoutMs)
      force.unref()
    }
    combined.addEventListener('abort', escalate, { once: true })
    try { await result.promise }
    finally {
      await closed
      combined.removeEventListener('abort', escalate)
      if (force !== undefined) clearTimeout(force)
    }
  }

  private fail(error: Error): void {
    if (this.failure !== undefined) return
    this.failure = error
    this.lifetime.abort(error)
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    this.rpc?.close(error)
    for (const socket of [...this.sockets].reverse()) socket.destroy(error)
    this.child?.kill('SIGTERM')
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
    this.directory = await mkdtemp('/tmp/dsh-ssh-')
    if (this.closed) throw new Error('SSH connection closed before startup')
    const releaseAskpass = await this.prepareAskpass()
    const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
    const command = [this.config.node, '--disable-sigusr1', this.config.helper].map(quote).join(' ')
    const child = spawn('ssh', [
      '-T', '-M', '-S', this.controlPath(), '-o', 'ControlPersist=no',
      '-o', `BatchMode=${releaseAskpass === undefined ? 'yes' : 'no'}`,
      ...(releaseAskpass === undefined ? [] : ['-o', 'NumberOfPasswordPrompts=1']),
      '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
      '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3', this.config.host, command,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(releaseAskpass === undefined ? {} : {
        env: {
          ...process.env,
          SSH_ASKPASS: join(this.directory, 'askpass'),
          SSH_ASKPASS_REQUIRE: 'force',
          // OpenSSH releases predating SSH_ASKPASS_REQUIRE still consult
          // askpass only when DISPLAY is set without a controlling tty.
          DISPLAY: 'dsh-ssh:0',
        },
      }),
    })
    this.child = child
    this.childClosed = new Promise((resolve) => { child.once('close', () => { resolve() }) })
    child.stderr.resume() // SSH diagnostics can contain configured paths; operation errors remain structured.
    child.once('error', (error) => { this.fail(error) })
    child.once('close', () => { this.fail(new Error('SSH helper disconnected; remote outcomes and cleanup are unknown')) })
    const rpc = new SshRpcPeer(child.stdout, child.stdin, this.config.maxFrameBytes, this.config.maxPending)
    this.rpc = rpc
    rpc.once('closed', (error) => { this.fail(error as Error) })
    let hello: Hello
    try {
      hello = await rpc.request('hello', {
        protocol: SSH_PROTOCOL_VERSION, workspace: this.config.workspace, leaseMs: this.config.leaseMs,
        ...(this.config.bootstrapPath === undefined ? {} : { bootstrapPath: this.config.bootstrapPath }),
      }, helloSchema, AbortSignal.timeout(this.config.requestTimeoutMs))
    } finally {
      // Authentication has concluded one way or the other: the master refuses
      // re-authentication under ControlPersist=no, so the password material
      // leaves the filesystem here rather than at connection disposal.
      await releaseAskpass?.()
    }
    if (hello.hash !== this.config.helperHash) throw new Error('SSH helper digest differs from the configured artifact')
    if (hello.bootstrapHash !== this.config.bootstrapHash) throw new Error('SSH PTC bootstrap digest differs from the configured artifact')
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
