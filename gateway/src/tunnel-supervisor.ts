/**
 * cloudflared binary resolution, pinned installation, and process supervision
 * for the public-access tunnel. The tunnel child is a direct subprocess of the
 * Gateway: it dies with the Gateway under both launchd and systemd cgroup
 * teardown, so a stopped Gateway never leaves a public entry orphaned. Children
 * are additionally tracked here and killed on this process's `exit` event.
 */
import { createHash, randomBytes } from 'node:crypto'
import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, createReadStream, createWriteStream, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** cloudflared release pinned for in-product installation (hashes verified below). */
export const CLOUDFLARED_PINNED_VERSION = '2026.9.3'

interface AssetPin {
  readonly asset: string
  readonly sha256: string
  /** Asset is a gzipped tar containing `cloudflared` rather than the raw binary. */
  readonly tgz: boolean
}

const ASSET_PINS: Record<string, AssetPin> = {
  'darwin-arm64': { asset: 'cloudflared-darwin-arm64.tgz', sha256: '587c2cfb1c230fe36c7fa7727da78be459dae028cabe8c001291999350f07095', tgz: true },
  'darwin-x64': { asset: 'cloudflared-darwin-amd64.tgz', sha256: 'd1155d0837487f261183b15c1eab6c4ebcad9dc49b94675f1524c3564cea3977', tgz: true },
  'linux-x64': { asset: 'cloudflared-linux-amd64', sha256: '77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2', tgz: false },
  'linux-arm64': { asset: 'cloudflared-linux-arm64', sha256: 'aaeb2d7d0da3614634c7e03ab13487a1522c2e79165ed2929cfe23d5e95b326d', tgz: false },
  'win32-x64': { asset: 'cloudflared-windows-amd64.exe', sha256: 'f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2', tgz: false },
}

const QUICK_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/u
const QUICK_URL_WAIT_MS = 30_000
const DOWNLOAD_TIMEOUT_MS = 120_000
const SENSITIVE_ENV = /KEY|PASSWORD|SECRET|TOKEN/i

const tunnelChildren = new Set<ChildProcess>()
let tunnelChildCleanupInstalled = false

function installTunnelChildCleanup(): void {
  if (tunnelChildCleanupInstalled) return
  tunnelChildCleanupInstalled = true
  process.once('exit', () => {
    // Synchronous exit path: kill every tracked tunnel so a fresh Gateway start
    // cannot inherit an orphaned public entry.
    for (const child of tunnelChildren) {
      if (child.pid !== undefined && process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
      } else if (child.pid !== undefined && process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } else {
        child.kill('SIGKILL')
      }
    }
  })
}

/** Environment for the tunnel child: parent env minus ambient credentials and DSH state. */
function scrubbedEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name, value]) =>
    value !== undefined && !SENSITIVE_ENV.test(name) && !name.startsWith('DSH_')))
}

/** A tunnel binary lookup or lifecycle request failed in an explainable way. */
export class TunnelSupervisorError extends Error {
  constructor(readonly code: 'not-installed' | 'unsupported-platform' | 'checksum-mismatch' | 'download-failed' | 'start-failed' | 'url-timeout', message: string) {
    super(message)
  }
}

/** Where the cloudflared binary was found, for administrator visibility. */
export interface CloudflaredBinary {
  path: string
  version: string | null
  source: 'env' | 'state-dir' | 'path' | 'well-known'
}

/** `resolveCloudflared` dependencies, injectable for tests. */
export interface CloudflaredResolverDeps {
  envPath?: string
  stateDir: string
  /** Lookup on PATH; defaults to `which`/`where`. */
  which?: (name: string) => Promise<string | null>
  versionOf?: (path: string) => Promise<string | null>
}

async function defaultWhich(name: string): Promise<string | null> {
  const command = process.platform === 'win32' ? 'where' : 'which'
  try {
    const { stdout } = await execFileAsync(command, [name])
    const first = stdout.split('\n').map(line => line.trim()).find(line => line.length > 0)
    return first ?? null
  } catch {
    return null
  }
}

async function defaultVersionOf(path: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(path, ['--version'], { timeout: 10_000 })
    const match = /cloudflared version (\S+)/u.exec(stdout)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

function isExecutableFile(path: string): boolean {
  try {
    const stat = statSync(path)
    return stat.isFile()
  } catch {
    return false
  }
}

/**
 * Resolve the cloudflared binary: explicit `HGW_CLOUDFLARED`, then the managed
 * install under the state directory, then PATH, then well-known brew/system
 * locations. Returns null when nothing is installed.
 */
export async function resolveCloudflared(deps: CloudflaredResolverDeps): Promise<CloudflaredBinary | null> {
  const which = deps.which ?? defaultWhich
  const versionOf = deps.versionOf ?? defaultVersionOf
  const managedName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
  const candidates: Array<{ path: string; source: CloudflaredBinary['source'] }> = []
  if (deps.envPath !== undefined && deps.envPath !== '') candidates.push({ path: deps.envPath, source: 'env' })
  candidates.push({ path: join(deps.stateDir, 'bin', managedName), source: 'state-dir' })
  const onPath = await which('cloudflared')
  if (onPath !== null) candidates.push({ path: onPath, source: 'path' })
  if (process.platform === 'darwin') {
    candidates.push({ path: '/opt/homebrew/bin/cloudflared', source: 'well-known' })
    candidates.push({ path: '/usr/local/bin/cloudflared', source: 'well-known' })
  }
  if (process.platform === 'linux') candidates.push({ path: '/usr/local/bin/cloudflared', source: 'well-known' })
  for (const candidate of candidates) {
    if (!isExecutableFile(candidate.path)) continue
    return { path: candidate.path, version: await versionOf(candidate.path), source: candidate.source }
  }
  return null
}

function assetPin(): AssetPin {
  const pin = ASSET_PINS[`${process.platform}-${process.arch}`]
  if (pin === undefined) {
    throw new TunnelSupervisorError('unsupported-platform', `no pinned cloudflared release for ${process.platform}-${process.arch}`)
  }
  return pin
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('data', chunk => hash.update(chunk))
    stream.once('end', resolve)
    stream.once('error', reject)
  })
  return hash.digest('hex')
}

/**
 * Download the pinned cloudflared release for this platform into
 * `${stateDir}/bin`, verify its SHA-256 against the pin, and mark it
 * executable. Partial downloads and checksum mismatches leave no binary behind.
 */
export async function installCloudflared(
  stateDir: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CloudflaredBinary> {
  const pin = assetPin()
  const binDir = join(stateDir, 'bin')
  const name = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
  const target = join(binDir, name)
  mkdirSync(binDir, { recursive: true, mode: 0o700 })
  const staging = join(tmpdir(), `dsh-cloudflared-${randomBytes(6).toString('hex')}`)
  mkdirSync(staging, { recursive: true, mode: 0o700 })
  const archive = join(staging, pin.asset)
  try {
    const url = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_PINNED_VERSION}/${pin.asset}`
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: 'follow' })
    if (!response.ok || response.body === null) {
      throw new TunnelSupervisorError('download-failed', `cloudflared download failed with HTTP ${response.status}`)
    }
    await new Promise<void>((resolve, reject) => {
      const sink = createWriteStream(archive, { mode: 0o600 })
      sink.once('error', reject)
      sink.once('finish', resolve)
      const reader = response.body!.getReader()
      const pump = async (): Promise<void> => {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) { sink.end(); return }
          if (!sink.write(value)) await new Promise<void>(r => sink.once('drain', r))
        }
      }
      pump().catch(reject)
    })
    const digest = await sha256File(archive)
    if (digest !== pin.sha256) {
      throw new TunnelSupervisorError('checksum-mismatch', `cloudflared ${pin.asset} sha256 ${digest} does not match the pinned release`)
    }
    if (pin.tgz) {
      await execFileAsync('tar', ['-xzf', archive, '-C', staging])
      renameSync(join(staging, 'cloudflared'), target)
    } else {
      renameSync(archive, target)
    }
    if (process.platform !== 'win32') chmodSync(target, 0o700)
    return { path: target, version: CLOUDFLARED_PINNED_VERSION, source: 'state-dir' }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/** Handle over one running tunnel child. */
export interface TunnelProc {
  /** The hostname the tunnel is serving once known. */
  publicUrl: string | null
  /** Whether the underlying child has exited. */
  hasExited(): boolean
  /** Stop the child and its process group. */
  terminate(graceMs: number): Promise<void>
  /** Resolves when the child exits, with its exit description. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

function trackChild(child: ChildProcess): void {
  installTunnelChildCleanup()
  tunnelChildren.add(child)
  child.once('exit', () => { tunnelChildren.delete(child) })
}

function makeProc(child: ChildProcess): TunnelProc {
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  return {
    publicUrl: null,
    hasExited: () => child.exitCode !== null || child.signalCode !== null,
    exited,
    terminate: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      if (child.pid !== undefined && process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
      } else {
        child.kill('SIGTERM')
      }
      const force = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          if (child.pid !== undefined && process.platform !== 'win32') {
            try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
          } else {
            child.kill('SIGKILL')
          }
        }
      }, 5_000)
      try { await exited } finally { clearTimeout(force) }
    },
  }
}

function spawnCloudflared(bin: string, args: string[]): ChildProcess {
  const child = spawn(bin, args, {
    env: { ...scrubbedEnv(), HOME: homedir() },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  trackChild(child)
  return child
}

/**
 * Start a quick tunnel (`--url`): no Cloudflare account, no DNS, and a random
 * `*.trycloudflare.com` hostname that changes on every start. Resolves once the
 * hostname appears in cloudflared's log output.
 */
export async function spawnQuickTunnel(bin: string, target: string): Promise<TunnelProc> {
  const child = spawnCloudflared(bin, ['tunnel', '--no-autoupdate', '--url', target])
  let url: string | null = null
  let buffered = ''
  const urlFound = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TunnelSupervisorError('url-timeout', 'cloudflared did not report a quick-tunnel URL in time'))
    }, QUICK_URL_WAIT_MS)
    const scan = (chunk: Buffer): void => {
      buffered += chunk.toString('utf8')
      const match = QUICK_URL.exec(buffered)
      if (match !== null) {
        clearTimeout(timer)
        resolve(match[0])
      }
    }
    child.stdout?.on('data', scan)
    child.stderr?.on('data', scan)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      reject(new TunnelSupervisorError('start-failed',
        `cloudflared exited before reporting a URL (code ${String(code)}, signal ${String(signal)})`))
    })
  })
  const proc = makeProc(child)
  try {
    url = await urlFound
  } catch (error) {
    await proc.terminate(0).catch(() => {})
    throw error
  }
  proc.publicUrl = url
  return proc
}

/**
 * Start a named tunnel with its remotely-fetched run token
 * (`cloudflared tunnel run --token`). The hostname is the one configured
 * through the Cloudflare API before the run.
 */
export function spawnNamedTunnel(bin: string, runToken: string): TunnelProc {
  const child = spawnCloudflared(bin, ['tunnel', '--no-autoupdate', 'run', '--token', runToken])
  return makeProc(child)
}
