/**
 * cloudflared binary resolution, pinned installation, and process supervision
 * for the public-access tunnel. The tunnel child is a direct subprocess of the
 * Gateway. Normal shutdown awaits child closure; host service containment owns
 * forced Gateway termination. Each process handle owns its exit observer until
 * native child closure.
 */
import { createHash } from 'node:crypto'
import { chmodSync, createReadStream, createWriteStream, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { pipeline } from 'node:stream/promises'
import { runGatewayChildCommand as runCommand } from './child-command.ts'
import { spawnTunnelProcess, TunnelSupervisorError, type TunnelLaunchOptions, type TunnelProc } from './tunnel-process.ts'
export { TunnelSupervisorError } from './tunnel-process.ts'
export type { TunnelLaunchOptions, TunnelProc } from './tunnel-process.ts'

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

const DOWNLOAD_TIMEOUT_MS = 120_000

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
  /** Lookup on PATH; defaults to `which`/`where`; external work honors cancellation. */
  which?: (name: string, signal?: AbortSignal) => Promise<string | null>
  /** Read the selected version; external work honors cancellation. */
  versionOf?: (path: string, signal?: AbortSignal) => Promise<string | null>
  /** Cancellation for native discovery/version probes and selection. */
  signal?: AbortSignal
}

async function defaultWhich(name: string, signal?: AbortSignal): Promise<string | null> {
  const command = process.platform === 'win32' ? 'where' : 'which'
  try {
    const { stdout } = await runCommand(command, [name], 10_000, signal)
    const first = stdout.split('\n').map(line => line.trim()).find(line => line.length > 0)
    return first ?? null
  } catch {
    signal?.throwIfAborted()
    return null
  }
}

async function defaultVersionOf(path: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const { stdout } = await runCommand(path, ['--version'], 10_000, signal)
    const match = /cloudflared version (\S+)/u.exec(stdout)
    return match?.[1] ?? null
  } catch {
    signal?.throwIfAborted()
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
 * @param deps - selected paths, cancellation and optional discovery implementations.
 * @returns selected installed binary, or null when no candidate exists.
 */
export async function resolveCloudflared(deps: CloudflaredResolverDeps): Promise<CloudflaredBinary | null> {
  deps.signal?.throwIfAborted()
  const which = deps.which ?? defaultWhich
  const versionOf = deps.versionOf ?? defaultVersionOf
  const managedName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
  const candidates: Array<{ path: string; source: CloudflaredBinary['source'] }> = []
  if (deps.envPath !== undefined && deps.envPath !== '') candidates.push({ path: deps.envPath, source: 'env' })
  candidates.push({ path: join(deps.stateDir, 'bin', managedName), source: 'state-dir' })
  const onPath = await which('cloudflared', deps.signal)
  deps.signal?.throwIfAborted()
  if (onPath !== null) candidates.push({ path: onPath, source: 'path' })
  if (process.platform === 'darwin') {
    candidates.push({ path: '/opt/homebrew/bin/cloudflared', source: 'well-known' })
    candidates.push({ path: '/usr/local/bin/cloudflared', source: 'well-known' })
  }
  if (process.platform === 'linux') candidates.push({ path: '/usr/local/bin/cloudflared', source: 'well-known' })
  for (const candidate of candidates) {
    if (!isExecutableFile(candidate.path)) continue
    const version = await versionOf(candidate.path, deps.signal)
    deps.signal?.throwIfAborted()
    return { path: candidate.path, version, source: candidate.source }
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
 * executable before atomic replacement on the destination filesystem. Failed downloads
 * close both streams; checksum and extraction failures preserve an existing install.
 * @param stateDir - private tunnel installation directory.
 * @param fetchImpl - download transport with cancellation support.
 * @param signal - optional cancellation of download, extraction and publication.
 * @returns binary descriptor after validated publication.
 */
export async function installCloudflared(
  stateDir: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<CloudflaredBinary> {
  signal?.throwIfAborted()
  const pin = assetPin()
  const binDir = join(stateDir, 'bin')
  const name = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
  const target = join(binDir, name)
  mkdirSync(binDir, { recursive: true, mode: 0o700 })
  const staging = mkdtempSync(join(binDir, '.cloudflared-'))
  const archive = join(staging, pin.asset)
  try {
    const url = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_PINNED_VERSION}/${pin.asset}`
    const lifetime = AbortSignal.any([AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), ...(signal === undefined ? [] : [signal])])
    const response = await fetchImpl(url, { signal: lifetime, redirect: 'follow' })
    if (!response.ok || response.body === null) {
      await response.body?.cancel()
      throw new TunnelSupervisorError('download-failed', `cloudflared download failed with HTTP ${response.status}`)
    }
    // Node fetch supplies this stream; DOM and Node declarations differ for BYOB readers.
    const source = Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>, { signal: lifetime })
    const sink = createWriteStream(archive, { mode: 0o600 })
    const closed = new Promise<void>(resolve => sink.once('close', resolve))
    // A failed Web source can settle pipeline while a file open is still pending.
    try { await pipeline(source, sink, { signal: lifetime }) } finally { sink.destroy(); await closed }
    const digest = await sha256File(archive)
    if (digest !== pin.sha256) {
      throw new TunnelSupervisorError('checksum-mismatch', `cloudflared ${pin.asset} sha256 ${digest} does not match the pinned release`)
    }
    signal?.throwIfAborted()
    if (pin.tgz) {
      await runCommand('tar', ['-xzf', archive, '-C', staging], DOWNLOAD_TIMEOUT_MS, signal)
    }
    signal?.throwIfAborted()
    const candidate = pin.tgz ? join(staging, 'cloudflared') : archive
    if (process.platform !== 'win32') chmodSync(candidate, 0o700)
    renameSync(candidate, target)
    return { path: target, version: CLOUDFLARED_PINNED_VERSION, source: 'state-dir' }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/**
 * Allocate a quick connector; readiness requires its URL and owned registration witness.
 * @param bin - selected cloudflared executable.
 * @param target - loopback Gateway target.
 * @param options - validated startup and closure timing, with optional startup cancellation.
 * @returns immediate cleanup owner with an awaited readiness promise.
 */
export function spawnQuickTunnel(bin: string, target: string, options: TunnelLaunchOptions): TunnelProc {
  return spawnTunnelProcess(bin, { kind: 'quick', target }, options)
}

/**
 * Allocate a named connector using its explicit token environment, outside process arguments.
 * @param bin - selected cloudflared executable.
 * @param runToken - selected connector credential.
 * @param options - validated startup and closure timing, with optional startup cancellation.
 * @returns immediate cleanup owner with an awaited registration promise.
 */
export function spawnNamedTunnel(bin: string, runToken: string, options: TunnelLaunchOptions): TunnelProc {
  return spawnTunnelProcess(bin, { kind: 'named', token: runToken }, options)
}
