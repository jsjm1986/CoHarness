/**
 * Per-generation Runtime launch identity. A launch stamp digests the complete
 * code closure and every Gateway-side startup input a Runtime was booted
 * with, so a survivor may be re-attached only when the recorded stamp still
 * matches what this Gateway would mint today — deployment paths and rebuilds
 * that change nothing observable produce identical stamps.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { GatewayConfig } from './config.ts'

const LAUNCH_STAMP_FORMAT = 1
/** Workspace source roots whose emitted code reaches the Runtime import graph. */
const CLOSURE_ROOTS = ['apps', 'packages', 'vendor', 'plugins']
/** Dependency-resolution files hashed as the third-party code proxy. */
const LOCK_FILES = ['pnpm-lock.yaml', 'pnpm-workspace.yaml']
/** Administrator-guard patch living beside the member patch inside the guard package. */
export const ADMIN_GUARD_PATCH_FILENAME = 'cordis.admin.patch.yml'

/** Reserved project-runtime overlay: collaboration plugins replace per-user persistence. */
const PROJECT_RUNTIME_PATCH = `- id: session-persistence-jsonl
  disabled: true
- insert:
    - id: collaboration-gateway
      name: '@deepseek-ai/dsh-collaboration-gateway'
    - id: collaboration-context
      name: '@deepseek-ai/dsh-collaboration-context'
    - id: session-persistence-gateway
      name: '@deepseek-ai/dsh-session-persistence-gateway'
- id: permission
  config:
    presets:
      read-only:
        sandbox: read-only
        approval: ask
      workspace-write:
        sandbox: workspace-write
        approval: ask
      danger-full-access:
        sandbox: danger-full-access
        approval: never
- id: memory
  config:
    space: project
`

/**
 * Managed-desktop patch stanza appended when the node declares an interactive
 * desktop identifier: the runtime mounts the computer-use service and the
 * provisioned Cua Driver provider, and `gateway-execution` starts publishing
 * the managed desktop authorization policy for that identifier.
 */
function managedDesktopPatch(cfg: GatewayConfig, desktop: string): string {
  const driverConfig: string[] = []
  if (cfg.desktopDriverCommand !== undefined) driverConfig.push(`        command: ${JSON.stringify(cfg.desktopDriverCommand)}`)
  if (cfg.desktopDriverArgs !== undefined) driverConfig.push(`        args: ${JSON.stringify(cfg.desktopDriverArgs)}`)
  const config = driverConfig.length === 0 ? '' : `\n      config:\n${driverConfig.join('\n')}`
  return `- id: gateway-execution
  config:
    desktop: ${JSON.stringify(desktop)}
- insert:
    - id: computer-use
      name: '@deepseek-ai/dsh-computer-use'
    - id: computer-use-cua-driver-mcp
      name: '@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp'
      inject: [resourceBudget]${config}
`
}

/** The role axes that change a Runtime's boot inputs; steward only exists for project runtimes. */
export interface LaunchVariant {
  readonly admin: boolean
  readonly kind: 'user' | 'project'
  readonly steward: boolean
}

/** Every variant this build can mint: membership decides whether a recorded stamp is still compatible. */
const LAUNCH_VARIANTS: readonly LaunchVariant[] = [
  { admin: false, kind: 'user', steward: false },
  { admin: true, kind: 'user', steward: false },
  { admin: false, kind: 'project', steward: false },
  { admin: true, kind: 'project', steward: false },
  { admin: false, kind: 'project', steward: true },
  { admin: true, kind: 'project', steward: true },
]

const variantKey = (variant: LaunchVariant): string =>
  `${variant.admin ? 'admin' : 'member'}:${variant.kind}:${variant.steward ? 'steward' : 'standard'}`

const hashFile = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

/** Digest a directory tree as `relative-path\0content` entries in sorted order; missing roots contribute nothing. */
function directoryDigest(root: string, hash: ReturnType<typeof createHash>, prefix = ''): void {
  let entries
  try { entries = readdirSync(root, { withFileTypes: true }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    const path = join(root, entry.name)
    const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.name === 'node_modules' || entry.isSymbolicLink()) continue
    if (entry.isDirectory()) { directoryDigest(path, hash, name); continue }
    if (!entry.isFile()) continue
    hash.update(name); hash.update('\0'); hash.update(readFileSync(path)); hash.update('\0')
  }
}

/** Digest one file, or the literal marker when absent. */
function fileDigest(path: string): string {
  try { return hashFile(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '<absent>'
    throw error
  }
}

/** The supervisor module this build's launcher spawns, resolved like the launcher does. */
function supervisorDigest(): string {
  for (const name of ['local-runtime-supervisor.js', 'local-runtime-supervisor.ts']) {
    const path = fileURLToPath(new URL(`./${name}`, import.meta.url))
    if (existsSync(path)) return fileDigest(path)
  }
  return '<absent>'
}

/**
 * Normalize `dshCommand` into a path-independent signature: the node binary is
 * represented by `process.version`, the entry script (`argv[1]`) by its content
 * digest, and every later element by its literal argv text. Arguments after the
 * entry script are launch data, not code — hashing them by content would make
 * the stamp depend on files a Runtime creates or removes during its own
 * lifetime.
 */
function commandSignature(dshCommand: string[]): string[] {
  return dshCommand.map((element, index) =>
    element === process.execPath ? `node:${process.version}`
      : index === 1 && existsSync(element) && statSync(element).isFile() ? `sha256:${fileDigest(element)}` : element)
}

/**
 * The policy patch text materialized into every Runtime profile: governance
 * package patch, Gateway-injected config lines, role overlays, and node
 * integration stanzas.
 * @param cfg - resolved Gateway configuration.
 * @param variant - role axes resolved from the launch descriptor.
 * @returns exact text `mountPolicyBundles` writes for the variant.
 */
export function policyPatchText(cfg: GatewayConfig, variant: LaunchVariant): string {
  const governanceDir = cfg.modelGovernancePackage
  const governancePatch = join(governanceDir, 'cordis.patch.yml')
  if (!existsSync(join(governanceDir, 'package.json')) || !existsSync(governancePatch)) {
    throw new Error(`model-governance package is incomplete: ${governanceDir}`)
  }
  let patchText = readFileSync(governancePatch, 'utf8').trimEnd() + '\n'
  const readinessPlugins = ['model-governance', 'gateway-execution', 'desktop-availability', ...(cfg.guardPatch === '' ? [] : ['directory-guard'])]
  patchText += `- id: gateway-runtime\n  config:\n    requiredPlugins: ${JSON.stringify(readinessPlugins)}\n`
  patchText += `- id: gateway-resource-budget\n  config:\n    requestTimeoutMs: ${String(cfg.runtimeRequestTimeoutMs)}\n    cleanupTimeoutMs: ${String(cfg.runtimeCleanupTimeoutMs)}\n`
  patchText += `- id: connection\n  config:\n    rpcTimeoutMs: ${String(cfg.runtimeBrowserRpcTimeoutMs)}\n    recovery:\n      streamOpenTimeoutMs: ${String(cfg.runtimeBrowserStreamTimeoutMs)}\n      generationReadyTimeoutMs: ${String(cfg.runtimeBrowserReadyTimeoutMs)}\n`
  const guardPatch = cfg.guardPatch
  if (guardPatch !== '') {
    if (!existsSync(guardPatch)) {
      throw new Error(`directory-guard patch not found: ${guardPatch} (set HGW_GUARD_PATCH=off to disable)`)
    }
    patchText += readFileSync(guardPatch, 'utf8').trimEnd() + '\n'
    if (variant.admin) {
      const adminPatch = join(dirname(guardPatch), ADMIN_GUARD_PATCH_FILENAME)
      if (!existsSync(adminPatch)) throw new Error(`directory-guard admin patch not found: ${adminPatch}`)
      patchText += readFileSync(adminPatch, 'utf8').trimEnd() + '\n'
    }
  }
  if (variant.kind === 'project') patchText += PROJECT_RUNTIME_PATCH
  if (variant.steward) {
    const stewardPackage = cfg.steward.toolsPackage
    const stewardPatch = join(stewardPackage, 'cordis.patch.yml')
    if (!existsSync(join(stewardPackage, 'package.json')) || !existsSync(stewardPatch)) {
      throw new Error(`steward tools package is incomplete: ${stewardPackage}`)
    }
    patchText += readFileSync(stewardPatch, 'utf8').trimEnd() + '\n'
  }
  patchText += '- id: plugin-manager\n  inject: [pluginManagementAuthorization]\n  config:\n    authorization: required\n'
  patchText += '- id: api-gateway\n  inject: [executionAuthority]\n'
  patchText += `- id: connection\n  config:\n    serverTiming: ${String(cfg.performanceEnabled)}\n`
  if (cfg.officeFontMetadataCacheDirectory !== undefined) {
    patchText += `- id: office-to-pdf\n  config:\n    fontMetadataCacheDirectory: ${JSON.stringify(cfg.officeFontMetadataCacheDirectory)}\n`
  }
  patchText += "- insert:\n    - id: desktop-availability\n      name: '@deepseek-ai/dsh-gateway-execution/desktop-availability'\n"
  // Remote-desktop providers share the gateway's administration files so
  // grants and endpoints managed in /admin take effect in every runtime.
  patchText += `- id: remote-desktop-vnc
  config:
    endpointsFile: ${JSON.stringify(join(cfg.remoteDesktopDir, 'endpoints.json'))}
    grantsFile: ${JSON.stringify(join(cfg.remoteDesktopDir, 'grants.jsonl'))}
    auditFile: ${JSON.stringify(join(cfg.remoteDesktopDir, 'audit.jsonl'))}
    recordingDir: ${JSON.stringify(join(cfg.remoteDesktopDir, 'recordings'))}
`
  if (cfg.desktopId !== undefined) patchText += managedDesktopPatch(cfg, cfg.desktopId)
  return patchText
}

/** Package content copied by `mountPolicyBundles`: manifest plus the shipped `lib` tree. */
function policyPackageDigest(packageDir: string): { manifest: string; lib: string } {
  const lib = createHash('sha256')
  directoryDigest(join(packageDir, 'lib'), lib)
  return { manifest: fileDigest(join(packageDir, 'package.json')), lib: lib.digest('hex') }
}

/** The launch stamps one build mints: the compatible set plus per-variant recording. */
export interface LaunchStampSet {
  /** Every stamp this build can still mint; a survivor's recorded stamp must be a member to re-attach. */
  readonly stamps: ReadonlySet<string>
  /**
   * @param variant - role axes resolved from a start descriptor.
   * @returns the stamp `beginStart` records for the launch.
   * @throws the captured policy error when the variant cannot be minted on this build.
   */
  stampFor(variant: LaunchVariant): string
}

/**
 * Mint the launch stamp set for this build. A variant whose policy inputs are
 * missing contributes no stamp — its rows retire and its starts fail loud —
 * and when no variant can be minted at all the computation itself fails so
 * misconfiguration never silently retires healthy survivors.
 * @param cfg - resolved Gateway configuration.
 * @param principalPublicKey - principal public key shipped in the Runtime credential.
 * @param profile - runtime profile directory name.
 * @returns the compatible set plus the per-variant recorder.
 */
export function computeLaunchStamps(
  cfg: GatewayConfig, principalPublicKey: string, profile: string,
): LaunchStampSet {
  const code = createHash('sha256')
  for (const root of CLOSURE_ROOTS) directoryDigest(join(cfg.dshRepoRoot, root), code)
  for (const file of LOCK_FILES) code.update(fileDigest(join(cfg.dshRepoRoot, file)))
  const guardPatch = cfg.guardPatch
  const inputs = {
    format: LAUNCH_STAMP_FORMAT,
    code: code.digest('hex'),
    supervisor: supervisorDigest(),
    command: commandSignature(cfg.dshCommand),
    launcher: cfg.launcher,
    execPath: process.execPath,
    node: process.version,
    profile,
    credential: {
      version: 1,
      principalPublicKey,
      streamPrincipalRenewal: cfg.streamPrincipalRenewal,
    },
    defaultEnv: cfg.defaultEnvFile === '' ? '' : fileDigest(cfg.defaultEnvFile),
    governancePackage: policyPackageDigest(cfg.modelGovernancePackage),
    guardPackage: guardPatch === '' ? '<off>' : policyPackageDigest(dirname(guardPatch)),
    stewardPackage: policyPackageDigest(cfg.steward.toolsPackage),
    desktopDriverPackage: cfg.desktopId === undefined ? '<none>' : policyPackageDigest(cfg.desktopDriverPackage),
  }
  const base = createHash('sha256').update(JSON.stringify(inputs)).digest('hex')
  const stamps = new Set<string>()
  const stamped = new Map<string, string>()
  const failures = new Map<string, unknown>()
  for (const variant of LAUNCH_VARIANTS) {
    const key = variantKey(variant)
    try {
      const stamp = createHash('sha256').update(base).update('\0').update(JSON.stringify(variant))
        .update('\0').update(policyPatchText(cfg, variant)).digest('hex')
      stamps.add(stamp)
      stamped.set(key, stamp)
    } catch (error) { failures.set(key, error) }
  }
  if (stamps.size === 0) {
    const first = failures.values().next().value
    throw first instanceof Error ? first : new Error(String(first))
  }
  return {
    stamps,
    stampFor: (variant: LaunchVariant) => {
      const key = variantKey(variant)
      const stamp = stamped.get(key)
      if (stamp !== undefined) return stamp
      const failure = failures.get(key)
      throw failure instanceof Error ? failure : new Error(`runtime launch variant ${key} is unavailable: ${String(failure)}`)
    },
  }
}
