/**
 * Instance launch drivers behind one seam. `LocalLauncher` (macOS dev) spawns
 * plain subprocesses that die with the gateway; `SystemdLauncher` (Linux
 * production) renders one per-user confinement unit per start — grants become
 * kernel mount-namespace binds — and drives it through systemctl. A start
 * returns an {@link InstanceProc} handle; readiness stays the
 * InstanceManager's HTTP poll. systemctl runs through the injectable `run`
 * option so the driver's command sequence is unit-tested off a Linux host.
 * Per-user system accounts and directory ownership are provisioning concerns
 * (deploy/provision-user.sh), not launch-time work.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { execFile } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Writable } from 'node:stream'
import { promisify } from 'node:util'
import type { GatewayConfig } from './config.ts'
import { renderUserUnit, unitName, type GrantEntry, type SystemdOptions } from './systemd.ts'

const localChildren = new Set<ChildProcess>()
let localChildCleanupInstalled = false
const SENSITIVE_ENV = /KEY|PASSWORD|SECRET|TOKEN/i
const PROCESS_TREE_POLL_MS = 25
const PROCESS_TREE_HARD_TIMEOUT_MS = 10_000

/** Copy the parent environment without ambient credentials or stale DSH state. */
function scrubbedParentEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name, value]) =>
    value !== undefined && !SENSITIVE_ENV.test(name) && !name.startsWith('DSH_')))
}

function installLocalChildCleanup(): void {
  if (localChildCleanupInstalled) return
  localChildCleanupInstalled = true
  process.once('exit', () => {
    // `exit` is synchronous; kill every tracked local runtime before launchd
    // can start a replacement Gateway with the same runtime ports.
    for (const child of localChildren) {
      if (child.pid !== undefined && process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
      } else if (child.pid !== undefined && process.platform === 'win32') {
        // Node does not keep asynchronous child processes alive during the
        // synchronous `exit` event. Use the blocking taskkill invocation so a
        // detached descendant tree receives the final signal before the
        // Gateway process disappears.
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } else {
        child.kill('SIGKILL')
      }
    }
  })
}

function processExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

/** Wait for the direct child and every process in its detached POSIX group. */
async function waitForPosixGroupExit(child: ChildProcess, deadline: number): Promise<void> {
  const exited = new Promise<void>(resolve => {
    if (processExited(child)) resolve()
    else child.once('exit', () => resolve())
  })
  await exited
  const pid = child.pid
  if (pid === undefined) return
  for (;;) {
    try {
      process.kill(-pid, 0)
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'ESRCH') return
      // EPERM means the group still exists but is not probeable by this user.
      if ((error as { code?: unknown } | null)?.code !== 'EPERM') return
    }
    if (Date.now() >= deadline) throw new Error(`process group ${String(pid)} did not exit before the termination deadline`)
    await new Promise(resolve => setTimeout(resolve, PROCESS_TREE_POLL_MS))
  }
}

/** Ask Windows to terminate a process tree and wait for its root exit event. */
async function terminateWindowsTree(child: ChildProcess, force: boolean): Promise<void> {
  const pid = child.pid
  if (pid === undefined) {
    if (!processExited(child)) child.kill(force ? 'SIGKILL' : 'SIGTERM')
    return
  }
  await new Promise<void>((resolve) => {
    execFile(
      'taskkill',
      ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])],
      { windowsHide: true },
      () => resolve(),
    )
  })
}

/** Terminate one local runtime and wait until its whole process tree is gone. */
async function terminateLocalTree(child: ChildProcess, graceMs: number): Promise<void> {
  const deadline = Date.now() + Math.max(0, graceMs) + PROCESS_TREE_HARD_TIMEOUT_MS
  if (process.platform === 'win32') {
    const exited = new Promise<void>(resolve => {
      if (processExited(child)) resolve()
      else child.once('exit', () => resolve())
    })
    await terminateWindowsTree(child, false)
    const forceTimer = setTimeout(() => {
      void terminateWindowsTree(child, true)
    }, Math.max(0, graceMs))
    try {
      await exited
    } finally {
      clearTimeout(forceTimer)
    }
    return
  }

  const pid = child.pid
  if (pid === undefined) {
    if (!processExited(child)) child.kill('SIGTERM')
    return
  }
  try { process.kill(-pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
  const forceTimer = setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
  }, Math.max(0, graceMs))
  try {
    await waitForPosixGroupExit(child, deadline)
  } finally {
    clearTimeout(forceTimer)
  }
}

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
  /** Whether the personal runtime receives administrator filesystem policy. */
  privileged?: boolean
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

/** Launch-only facts, including the credential delivered through a private channel. */
export interface LaunchRuntime extends RuntimePolicyIdentity {
  gatewayCredential: string
}

/** Handle over one launched instance. */
export interface InstanceProc {
  /** Ask the instance to stop; escalate after `graceMs`. Resolves when the request completed. */
  terminate(graceMs: number): Promise<void>
  /**
   * Whether the underlying process is known to have exited. A systemd unit is
   * not tracked through this handle (systemd supervises it), so callers should
   * prefer {@link isAlive} when the launcher supplies one.
   */
  hasExited(): boolean
  /** Optional supervisor-backed liveness probe for processes not owned directly. */
  isAlive?(): Promise<boolean>
}

/** One instance launch driver. */
export interface Launcher {
  /** Launch (or restart) one instance and return its handle. */
  start(runtime: LaunchRuntime): Promise<InstanceProc>
  /**
   * Re-attach to an instance this gateway process did not start (present
   * after a gateway restart under systemd). Absent on drivers whose
   * instances cannot outlive the gateway.
   */
  attach?(runtime: RuntimeProcessIdentity): InstanceProc
  /** Whether instances survive a gateway shutdown (systemd) or must be stopped with it (local). */
  readonly instancesOutliveGateway: boolean
}

/** macOS dev driver: plain subprocesses tracked by their ChildProcess. */
export class LocalLauncher implements Launcher {
  readonly instancesOutliveGateway = false

  constructor(private readonly cfg: GatewayConfig) {}

  async start(runtime: LaunchRuntime): Promise<InstanceProc> {
    const argv = this.cfg.dshCommand.map(a => a.replaceAll('{port}', String(runtime.port)))
    const child = spawn(argv[0] ?? 'node', argv.slice(1), {
      cwd: runtime.homePath,
      env: {
        ...scrubbedParentEnv(),
        HOME: runtime.homePath,
        DSH_HOME: runtime.dshHome,
        DSH_GATEWAY_CREDENTIAL_FD: '3',
        // Source-run instances load TypeScript through tsx, which resolves
        // the workspace `paths` map from tsconfig — discovered from cwd,
        // which is the user home, OUTSIDE the repo. Point tsx at the repo
        // tsconfig explicitly; the pinned-npm production command has no tsx
        // and ignores the variable.
        TSX_TSCONFIG_PATH: join(this.cfg.dshRepoRoot, 'tsconfig.base.json'),
      },
      stdio: ['ignore', 'ignore', 'inherit', 'pipe'],
      detached: process.platform !== 'win32',
    })
    installLocalChildCleanup()
    localChildren.add(child)
    // Keep the handle until the entire detached group is gone. The direct
    // child can exit while a grandchild still owns the runtime port.
    child.once('exit', () => {
      if (process.platform === 'win32' || child.pid === undefined) {
        localChildren.delete(child)
        return
      }
      void waitForPosixGroupExit(child, Date.now() + PROCESS_TREE_HARD_TIMEOUT_MS)
        .catch(() => {})
        .finally(() => { localChildren.delete(child) })
    })
    const credentialPipe = child.stdio[3] as Writable | null | undefined
    if (credentialPipe === null || credentialPipe === undefined) {
      child.kill('SIGKILL')
      throw new Error(`runtime credential pipe unavailable for ${runtime.runtimeKey}`)
    }
    try {
      await new Promise<void>((resolve, reject) => {
        credentialPipe.once('error', reject)
        credentialPipe.end(runtime.gatewayCredential, resolve)
      })
    } catch (error) {
      await terminateLocalTree(child, 0).catch(() => {})
      throw new Error(`runtime credential delivery failed for ${runtime.runtimeKey}: ${String(error)}`)
    }
    return {
      hasExited: () => child.exitCode !== null || child.signalCode !== null,
      terminate: async (graceMs: number) => {
        await terminateLocalTree(child, graceMs)
      },
    }
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
  /** systemctl arguments runner; injectable for tests. */
  run?: (args: string[]) => Promise<void>
}

const runSystemctl = async (args: string[]): Promise<void> => {
  await promisify(execFile)('systemctl', args)
}

/**
 * Linux production driver: render the user's confinement unit from the
 * current grants, write it, `daemon-reload`, and `restart`. Restarting is
 * required because every launch rotates the runtime generation and credential.
 */
export class SystemdLauncher implements Launcher {
  readonly instancesOutliveGateway = true
  private readonly unitDir: string
  private readonly run: (args: string[]) => Promise<void>

  constructor(private readonly options: SystemdLauncherOptions) {
    this.unitDir = options.unitDir ?? '/etc/systemd/system'
    this.run = options.run ?? runSystemctl
  }

  async start(user: LaunchRuntime): Promise<InstanceProc> {
    // $DSH_HOME sits under the TemporaryFileSystem mask like the home, so it
    // must be re-bound writable too (session logs, settings, grants file);
    // the renderer itself only auto-binds the home.
    const { gatewayCredential, ...policyIdentity } = user
    const grants: GrantEntry[] = [
      { path: user.dshHome, mode: 'rw' },
      ...await this.options.grantsProvider(policyIdentity),
    ]
    mkdirSync(this.options.credentialDir, { recursive: true, mode: 0o700 })
    const credentialPath = join(
      this.options.credentialDir,
      `${user.runtimeKey}.${String(user.generation)}.${String(process.pid)}.credential`,
    )
    writeFileSync(credentialPath, gatewayCredential, { mode: 0o600, flag: 'wx' })
    try {
      writeFileSync(
        join(this.unitDir, unitName(user.runtimeKey)),
        renderUserUnit(user, grants, this.options.systemd, credentialPath),
      )
      await this.run(['daemon-reload'])
      await this.run(['restart', unitName(user.runtimeKey)])
    } finally {
      rmSync(credentialPath, { force: true })
    }
    return this.attach(user)
  }

  attach(user: RuntimeProcessIdentity): InstanceProc {
    return {
      hasExited: () => false,
      isAlive: async () => {
        try {
          await this.run(['is-active', '--quiet', unitName(user.runtimeKey)])
          return true
        } catch {
          return false
        }
      },
      terminate: async () => { await this.run(['stop', unitName(user.runtimeKey)]) },
    }
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
