/**
 * Instance launch drivers behind one seam. `LocalLauncher` (macOS dev) spawns
 * independently recoverable POSIX process groups; `SystemdLauncher` (Linux
 * production) renders one per-user confinement unit per start — grants become
 * kernel mount-namespace binds — and drives it through systemctl. A start
 * returns an {@link InstanceProc} handle; readiness stays the
 * InstanceManager's HTTP poll. systemctl runs through the injectable `run`
 * option so the driver's command sequence is unit-tested off a Linux host.
 * System accounts are deployment provisioning concerns (deploy/provision-user.sh).
 * InstanceManager prepares assigned Linux project-profile ownership before invoking the driver.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { GatewayConfig } from './config.ts'
import { scrubbedGatewayChildEnv } from './child-environment.ts'
import { runGatewayChildCommand } from './child-command.ts'
import { LocalRuntimeControl } from './local-runtime-control.ts'
import { LocalRuntimeOwnerStore } from './local-runtime-owner.ts'
import { probeLocalLinuxScope } from './local-runtime-linux.ts'
import { LOCAL_BOOTSTRAP_BYTES, localBootstrapSchema, localKernelBootId } from './local-runtime-protocol.ts'
import { nodeControlPaths } from './node-control-paths.ts'
import { RuntimeCapacityError } from './runtime-capacity.ts'
import { renderUserUnit, unitName, type GrantEntry, type SystemdOptions } from './systemd.ts'

/** Stable process identity and filesystem facts for one runtime. */
export interface RuntimeProcessIdentity {
  /** Runtime owner category. */
  kind: 'user' | 'project'
  /** Public numeric id of the runtime owner. */
  ownerId: number
  username: string
  /** Stable process/unit key. */
  runtimeKey: string
  /** Exact Linux account for systemd. */
  systemUser: string
  /** Whether the runtime receives administrator filesystem policy. */
  privileged?: boolean
  /** Whether the supervisor must keep this runtime alive (Restart=always). */
  resident?: boolean
  port: number
  /** Absolute writable home (also the instance cwd / workspace root). */
  homePath: string
  /** Absolute `$DSH_HOME` for this instance. */
  dshHome: string
}

/** Non-secret runtime facts available to policy projection. */
export interface RuntimePolicyIdentity extends RuntimeProcessIdentity {
  /** Monotonic instance generation assigned to this start. */
  generation: number
}

/** Supervisor identity remains distinct when a database restore reuses a generation number. */
export interface RuntimeSupervisorIdentity extends RuntimePolicyIdentity {
  /** SHA-256 of the issued bearer; null denotes a stopped or pre-credential legacy assignment. */
  credentialHash: string | null
}

/** Launch-only facts, including the credential delivered through a private channel. */
export interface LaunchRuntime extends RuntimeSupervisorIdentity {
  credentialHash: string
  gatewayCredential: string
  /** Await node admission immediately before process allocation; absent in independent compositions. */
  beforeAllocation?: () => Promise<void>
  /** Cancellation remains live through asynchronous preparation and supervisor handoff. */
  signal?: AbortSignal
}

/** Handle over one launched instance. */
export interface InstanceProc {
  /** Resolve after the generation's complete process range stops and any delayed allocation is fenced; escalate after `graceMs`. */
  terminate(graceMs: number): Promise<void>
  /**
   * Whether the underlying process is known to have exited. A systemd unit is
   * not tracked through this handle (systemd supervises it), so callers should
   * prefer {@link isAlive} when the launcher supplies one.
   */
  hasExited(): boolean
  /** Process-owner exit notification; callers still await termination of any remaining descendants. */
  exited?: Promise<void>
  /** Optional supervisor-backed liveness probe for processes not owned directly. */
  isAlive?(): Promise<boolean>
}

/** A failed launch whose process termination still needs confirmation by the lifecycle owner. */
export class RuntimeLaunchCleanupError extends Error {
  /**
   * @param process - handle retained until its termination succeeds.
   * @param cause - launch or cleanup failure.
   */
  constructor(readonly process: InstanceProc, cause: unknown) {
    super('Runtime launch cleanup could not be confirmed', { cause })
  }
}

/** One instance launch driver. */
export interface Launcher {
  /** Launch one instance. Rejection confirms cleanup, or carries a RuntimeLaunchCleanupError retaining the handle. */
  start(runtime: LaunchRuntime): Promise<InstanceProc>
  /**
   * Re-attach to an exact generation this gateway process did not start (present
   * after a Gateway failure). Recovery support is independent of graceful
   * shutdown retention.
   */
  attach?(runtime: RuntimeSupervisorIdentity): InstanceProc
  /** Whether graceful Gateway shutdown retains supervisor-owned instances for later reattachment. */
  readonly instancesOutliveGateway: boolean
}

/** Local POSIX driver with independently recoverable generation ownership. */
export class LocalLauncher implements Launcher {
  readonly instancesOutliveGateway = false
  private readonly homes = new Map<string, LocalRuntimeControl>()

  constructor(private readonly cfg: GatewayConfig) {}

  attach(runtime: RuntimeSupervisorIdentity): InstanceProc {
    return this.control(runtime)
  }

  private control(runtime: RuntimeSupervisorIdentity): LocalRuntimeControl {
    if (runtime.credentialHash === null) throw new Error('Legacy local runtime ownership cannot be recovered automatically')
    return new LocalRuntimeControl(new LocalRuntimeOwnerStore(nodeControlPaths(this.cfg.stateRoot).localRuntime, {
      node: this.cfg.computeNodeName, kind: runtime.kind, ownerId: runtime.ownerId, runtimeKey: runtime.runtimeKey,
      generation: runtime.generation, credentialHash: runtime.credentialHash,
    }), this.cfg.readinessTimeoutMs)
  }

  async start(runtime: LaunchRuntime): Promise<InstanceProc> {
    if (runtime.signal?.aborted) throw new RuntimeCapacityError('cancelled')
    const previous = this.homes.get(runtime.dshHome)
    if (previous !== undefined) { await previous.terminate(0); this.homes.delete(runtime.dshHome) }
    const bootId = await localKernelBootId(runtime.signal).catch((error: unknown) => {
      if (runtime.signal?.aborted) throw new RuntimeCapacityError('cancelled')
      throw error
    })
    const control = this.control(runtime)
    const lease = await control.store.acquire()
    let allocationAttempted = false
    let supervisor: ChildProcess | undefined
    try {
      const linuxScopeMode = await probeLocalLinuxScope(this.cfg.upstreamTimeoutMs, runtime.signal)
      const record = await lease.create(bootId, linuxScopeMode === undefined ? undefined : 'linux-slice')
      const spec = localBootstrapSchema.parse({
        kind: 'start', directory: control.store.directory, identity: control.store.identity, record,
        ...linuxScopeMode === undefined ? {} : { linuxScopeMode },
        command: this.cfg.dshCommand.map(a => a.replaceAll('{port}', String(runtime.port))),
        cwd: runtime.homePath, dshHome: runtime.dshHome, credential: runtime.gatewayCredential,
        logCapBytes: this.cfg.runtimeLogCapBytes, controlTimeoutMs: this.cfg.upstreamTimeoutMs,
        env: {
          ...scrubbedGatewayChildEnv(), HOME: runtime.homePath, DSH_HOME: runtime.dshHome,
          DSH_DIRECTORY_GRANTS: join(runtime.dshHome, 'directory-grants.json'),
          DSH_MANAGED_DATA_MANIFEST: join(runtime.dshHome, 'managed-data.jsonl'), DSH_GATEWAY_CREDENTIAL_FD: '3',
          TSX_TSCONFIG_PATH: join(this.cfg.dshRepoRoot, 'tsconfig.base.json'),
        },
      })
      if (Buffer.byteLength(JSON.stringify(spec)) > LOCAL_BOOTSTRAP_BYTES) throw new Error('Local runtime bootstrap exceeds its byte limit')
      const source = import.meta.url.endsWith('.ts')
      const entry = fileURLToPath(new URL(`./local-runtime-supervisor.${source ? 'ts' : 'js'}`, import.meta.url))
      await runtime.beforeAllocation?.()
      if (await control.store.cancelled() || runtime.signal?.aborted) throw new RuntimeCapacityError('cancelled')
      allocationAttempted = true
      // Windows cannot inherit the lease descriptor: the supervisor claims the
      // named-pipe lease itself, so no fd slot is passed and the launcher
      // releases its pipe as soon as the bootstrap is delivered.
      const stdio: ('ignore' | 'ipc' | number)[] = ['ignore', 'ignore', 'ignore', 'ipc']
      if (process.platform !== 'win32') stdio.push(lease.fd)
      const child = supervisor = spawn(process.execPath, [...(source ? ['--import', import.meta.resolve('tsx/esm')] : []), entry, String(this.cfg.readinessTimeoutMs)], {
        cwd: this.cfg.dshRepoRoot, detached: true, stdio,
        env: { ...scrubbedGatewayChildEnv(), TSX_TSCONFIG_PATH: fileURLToPath(new URL('../tsconfig.run.json', import.meta.url)) },
      })
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
      await new Promise<void>((resolve, reject) => {
        const aborted = () => failed(new RuntimeCapacityError('cancelled'))
        const settled = () => { clearTimeout(timer); runtime.signal?.removeEventListener('abort', aborted) }
        const failed = (error: unknown) => { settled(); reject(error) }
        const timer = setTimeout(() => failed(new Error('Local runtime supervisor startup timed out')), this.cfg.readinessTimeoutMs)
        child.once('error', failed)
        child.once('exit', () => failed(new Error('Local runtime supervisor exited during startup')))
        child.on('message', (message: unknown) => {
          if (typeof message === 'object' && message !== null && 'kind' in message && message.kind === 'ready'
            && 'nonce' in message && message.nonce === record.nonce) { settled(); resolve() }
        })
        runtime.signal?.addEventListener('abort', aborted, { once: true })
        if (runtime.signal?.aborted) aborted()
        else child.send(spec, error => {
          if (error !== null) failed(error)
          else if (process.platform === 'win32') void lease.close()
        })
      })
      if (runtime.signal?.aborted) throw new RuntimeCapacityError('cancelled')
      child.unref()
      await lease.close()
      this.homes.set(runtime.dshHome, control)
      return Object.assign(control, { exited })
    } catch (error) {
      const failures: unknown[] = [error]
      try { if (supervisor?.connected) supervisor.disconnect() } catch (failure) { failures.push(failure) }
      try { await lease.close() } catch (failure) { if (failure !== error) failures.push(failure) }
      if (allocationAttempted) {
        try { await control.terminate(0) } catch (cleanupError) {
          throw new RuntimeLaunchCleanupError(control, new AggregateError([...failures, cleanupError], 'Local runtime startup and cleanup failed'))
        }
      }
      if (failures.length > 1) throw new AggregateError(failures, 'Local runtime startup and descriptor cleanup failed')
      throw error
    }
  }
}

/** Safe provisioning diagnostics for a Runtime that has not allocated a process. */
export class RuntimeAccountError extends Error {
  readonly code: 'RUNTIME_ACCOUNT_NOT_PROVISIONED' | 'RUNTIME_ACCOUNT_VERIFICATION_UNAVAILABLE'
  readonly status: 409 | 503

  constructor(account: string, reason: 'missing' | 'unavailable', options?: ErrorOptions) {
    super(reason === 'missing'
      ? `Linux runtime account "${account}" is not provisioned on this computer. Complete the configured runtime-account provisioning before starting this Runtime.`
      : `Linux runtime account "${account}" could not be verified. Check this computer's runtime-account provisioning.`, options)
    this.name = 'RuntimeAccountError'
    this.code = reason === 'missing' ? 'RUNTIME_ACCOUNT_NOT_PROVISIONED' : 'RUNTIME_ACCOUNT_VERIFICATION_UNAVAILABLE'
    this.status = reason === 'missing' ? 409 : 503
  }
}

/** Construction options for {@link SystemdLauncher}. */
export interface SystemdLauncherOptions {
  /** Unit-rendering facts shared by every user (see systemd.ts). */
  systemd: SystemdOptions
  /** Current effective grants for a username, rendered into mount binds. */
  grantsProvider: (runtime: RuntimePolicyIdentity) => GrantEntry[] | Promise<GrantEntry[]>
  /** Private host directory used as the source for systemd credentials. */
  credentialDir: string
  /** Unit directory the per-user unit files are written into. */
  unitDir?: string
  /** Validated deadline for each native systemctl client. */
  commandTimeoutMs: number
  /** Override systemctl execution; cancellation must join owned command closure. */
  run?: (args: string[], signal?: AbortSignal) => Promise<void>
  /** Verify the configured system account before writing credentials or allocating a process. */
  verifySystemUser?: (account: string, signal?: AbortSignal) => Promise<void>
}

/**
 * Linux production driver: render the user's confinement unit from the
 * current grants and drives its generation-specific unit. Stopped generations
 * retain an empty unit file, which systemd treats as masked, so delayed launch
 * commands cannot reactivate a process whose termination was confirmed.
 * Private credential sources remain available for service restarts until the
 * exact generation has confirmed stopped.
 */
export class SystemdLauncher implements Launcher {
  readonly instancesOutliveGateway = true
  private readonly unitDir: string
  private readonly run: (args: string[], signal?: AbortSignal) => Promise<void>
  private readonly verifySystemUser: (account: string, signal?: AbortSignal) => Promise<void>

  constructor(private readonly options: SystemdLauncherOptions) {
    this.unitDir = options.unitDir ?? '/etc/systemd/system'
    this.run = options.run ?? (async (args, signal) => {
      await runGatewayChildCommand('systemctl', ['--no-ask-password', '--no-pager', ...args], options.commandTimeoutMs, signal)
    })
    this.verifySystemUser = options.verifySystemUser ?? (async (account, signal) => {
      try { await runGatewayChildCommand('id', ['-u', '--', account], options.commandTimeoutMs, signal, 1024) }
      catch (error) {
        if (signal?.aborted) throw new RuntimeCapacityError('cancelled')
        const missing = error instanceof Error && 'code' in error && error.code === 1
        throw new RuntimeAccountError(account, missing ? 'missing' : 'unavailable', { cause: error })
      }
    })
  }

  async start(user: LaunchRuntime): Promise<InstanceProc> {
    if (user.signal?.aborted) throw new RuntimeCapacityError('cancelled')
    await this.verifySystemUser(user.systemUser, user.signal)
    if (user.signal?.aborted) throw new RuntimeCapacityError('cancelled')
    // $DSH_HOME sits under the TemporaryFileSystem mask like the home, so it
    // must be re-bound writable too (session logs, settings, grants file);
    // the renderer itself only auto-binds the home.
    const { gatewayCredential, credentialHash, beforeAllocation, signal, ...policyIdentity } = user
    const grants: GrantEntry[] = [
      { path: user.dshHome, mode: 'rw' },
      ...await this.options.grantsProvider(policyIdentity),
    ]
    if (signal?.aborted) throw new RuntimeCapacityError('cancelled')
    mkdirSync(this.options.credentialDir, { recursive: true, mode: 0o700 })
    const credentialPath = this.credentialPath(user)
    writeFileSync(credentialPath, gatewayCredential, { mode: 0o600, flag: 'wx' })
    let restartAttempted = false
    try {
      writeFileSync(
        join(this.unitDir, unitName(user.runtimeKey, user.generation, credentialHash)),
        renderUserUnit(user, grants, this.options.systemd, credentialPath),
        { flag: 'wx' },
      )
      await this.run(['daemon-reload'], signal)
      await beforeAllocation?.()
      if (signal?.aborted) throw new RuntimeCapacityError('cancelled')
      restartAttempted = true
      await this.run(['restart', unitName(user.runtimeKey, user.generation, credentialHash)], signal)
    } catch (error: unknown) {
      if (restartAttempted) throw new RuntimeLaunchCleanupError(this.attach(user), error)
      try { rmSync(credentialPath, { force: true }) } catch (cleanupError: unknown) {
        throw new AggregateError([error, cleanupError], 'Systemd preparation and credential cleanup failed')
      }
      throw error
    }
    return this.attach(user)
  }

  private credentialPath(user: RuntimeSupervisorIdentity & { credentialHash: string }): string {
    unitName(user.runtimeKey, user.generation, user.credentialHash)
    return join(this.options.credentialDir, `${user.runtimeKey}.${String(user.generation)}.${user.credentialHash}.credential`)
  }

  attach(user: RuntimeSupervisorIdentity): InstanceProc {
    const unit = user.credentialHash === null ? unitName(user.runtimeKey) : unitName(user.runtimeKey, user.generation, user.credentialHash)
    const legacy = unitName(user.runtimeKey)
    const units = [...new Set([unit, legacy])]
    return {
      hasExited: () => false,
      isAlive: async () => {
        if (await this.unitIsActive(unit)) return true
        return existsSync(join(this.unitDir, legacy)) && await this.unitIsActive(legacy)
      },
      terminate: async () => {
        // Legacy units are never launched by this driver.
        for (const name of units) this.maskGeneration(name)
        await this.run(['daemon-reload'])
        await this.run(['stop', ...units])
        if (user.credentialHash !== null) rmSync(this.credentialPath({ ...user, credentialHash: user.credentialHash }), { force: true })
      },
    }
  }

  private async unitIsActive(unit: string): Promise<boolean> {
    try { await this.run(['is-active', '--quiet', unit]); return true } catch (error) {
      // systemctl reserves 3 for an inactive unit and 4 for a missing unit.
      const code = (error as { code?: unknown }).code
      if (code === 3 || code === 4) return false
      throw error
    }
  }

  private maskGeneration(unit: string): void {
    const temporary = join(this.unitDir, `.${unit}.${randomUUID()}.tmp`)
    writeFileSync(temporary, '', { flag: 'wx' })
    try { renameSync(temporary, join(this.unitDir, unit)) } finally { rmSync(temporary, { force: true }) }
  }
}

/**
 * Construct the launcher the config selects; the systemd options factory is
 * evaluated only when the systemd driver is actually chosen.
 * @param cfg - gateway config (`launcher` field).
 * @param systemdOptions - lazily builds the systemd driver's options.
 * @returns the driver behind the shared seam.
 */
export function selectLauncher(cfg: GatewayConfig, systemdOptions: () => SystemdLauncherOptions): Launcher {
  return cfg.launcher === 'systemd'
    ? new SystemdLauncher(systemdOptions())
    : new LocalLauncher(cfg)
}
