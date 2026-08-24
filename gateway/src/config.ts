import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, join, posix, resolve } from 'node:path'

export interface GatewayConfig {
  /** Canonical immutable release directory for managed deployments. */
  releaseRoot?: string
  /** Public release identifier derived from the immutable directory name. */
  releaseId?: string
  port: number
  /** PostgreSQL organization selected by this Gateway process. */
  organizationSlug: string
  /** PostgreSQL compute node whose mounts, ports, and instances this process owns. */
  computeNodeName: string
  /** Private loopback port accepting authenticated usage outbox records. */
  intakePort: number
  /** IANA time zone used for natural-month usage accounting. */
  usageTimeZone: string
  publicOrigins: string[]
  usersRoot: string
  /** Host-owned runtime homes for project-scoped Harness processes. */
  projectRuntimesRoot: string
  /** Host directory roots hidden from every systemd unit before authorized project paths are re-bound. */
  projectPathRoots: string[]
  /** Root under which user-created project directories are allocated. */
  userProjectsRoot: string
  /** Root under which name-only admin project creation makes managed directories. */
  projectsRoot: string
  /** Linux account used by project-scoped systemd units. */
  projectRuntimeUser: string
  /** Private directory containing the Gateway's Ed25519 assertion keypair. */
  principalKeyDir: string
  /** Lifetime of one browser-request principal assertion. */
  principalAssertionTtlMs: number
  /** Maximum buffered body bytes accepted by one authenticated runtime API call. */
  runtimeApiBodyLimitBytes: number
  /** Initial delay before retrying a transient PostgreSQL startup failure. */
  databaseStartupRetryInitialMs: number
  /** Maximum delay between transient PostgreSQL startup retries. */
  databaseStartupRetryMaxMs: number
  /** Private host directory used as the source for systemd runtime credentials. */
  runtimeCredentialDir: string
  /** Owner-only AES-GCM master-key file for organization model credentials. */
  organizationModelCredentialKeyFile: string
  dshCommand: string[]
  dshRepoRoot: string
  instancePortBase: number
  idleTimeoutMs: number
  readinessTimeoutMs: number
  sessionTtlMs: number
  sessionAbsoluteTtlMs: number
  secureCookies: boolean
  /** Instance launch backend: `local` child process (dev) or `systemd` (Linux prod). */
  launcher: 'local' | 'systemd'
  /** systemd MemoryMax per instance (systemd launcher only). */
  memoryMax: string
  /** systemd CPUQuota per instance (systemd launcher only). */
  cpuQuota: string
  /** Gateway install/data dir made inaccessible to instances (systemd launcher only). */
  gatewayDir: string
  /** Unit directory the systemd launcher writes per-user unit files into. */
  systemdUnitDir: string
  /**
   * Absolute path of the dsh-directory-guard bundle patch mounted into every
   * instance's home patch layer, or '' to disable (HGW_GUARD_PATCH=off). The
   * plugin package is expected beside the patch file; the instance manager
   * links it into the instance's profile node_modules so the loader can
   * resolve it.
   */
  guardPatch: string
  /** Directory containing the tree-external model-governance plugin. */
  modelGovernancePackage: string
  /**
   * Company default credentials file copied to each instance's
   * `$DSH_HOME/.env` on every start ('' = no seeding). dsh reads it as the
   * user-env layer, which the managed `.credentials.yaml` (a user's personal
   * key set from Settings) outranks — so seeding never clobbers a personal
   * key, while a rotated company key reaches instances on their next start.
  */
  defaultEnvFile: string
  /** Firebase Cloud Messaging project id; absent disables outbound push delivery. */
  fcmProjectId?: string
  /** Owner-only Firebase service-account JSON file used for FCM HTTP v1. */
  fcmServiceAccountFile?: string
  /** JPush application key used by the Gateway REST sender. */
  jpushAppKey?: string
  /** Owner-only JPush master secret used by the Gateway REST sender. */
  jpushMasterSecret?: string
}

const gatewayRoot = resolve(import.meta.dirname, '..')
const SYSTEMD_ACCOUNT_RE = /^[a-z][a-z0-9-]{1,30}$/
export const DEFAULT_RUNTIME_API_BODY_LIMIT_BYTES = 64 * 1024 * 1024
export const DEFAULT_DATABASE_STARTUP_RETRY_INITIAL_MS = 1_000
export const DEFAULT_DATABASE_STARTUP_RETRY_MAX_MS = 30_000

function projectPathRoots(value: string | undefined): string[] {
  if (value === undefined) return []
  const roots = value.split(',').map(path => path.trim()).filter(Boolean).map((path) => {
    if (!posix.isAbsolute(path)) throw new Error(`HGW_PROJECT_PATH_ROOTS must contain absolute Linux paths: ${path}`)
    return posix.normalize(path)
  })
  for (const [index, root] of roots.entries()) {
    if (root === '/') throw new Error('HGW_PROJECT_PATH_ROOTS must not include the filesystem root')
    for (const prior of roots.slice(0, index)) {
      const nested = root === prior || posix.relative(prior, root).split('/')[0] !== '..'
        || posix.relative(root, prior).split('/')[0] !== '..'
      if (nested) throw new Error(`HGW_PROJECT_PATH_ROOTS contains overlapping roots: ${prior}, ${root}`)
    }
  }
  return roots
}

function strictlyNestedPath(root: string, path: string): boolean {
  const normalizedRoot = posix.normalize(root)
  const normalizedPath = posix.normalize(path)
  return normalizedPath !== normalizedRoot
    && posix.relative(normalizedRoot, normalizedPath).split('/')[0] !== '..'
    && !posix.isAbsolute(posix.relative(normalizedRoot, normalizedPath))
}

function normalizedAbsolutePath(path: string): string {
  const normalized = posix.normalize(path)
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
}

function pathsOverlap(left: string, right: string): boolean {
  const nested = (root: string, candidate: string): boolean => {
    const relative = posix.relative(posix.normalize(root), posix.normalize(candidate))
    return relative === '' || (!relative.startsWith('../') && relative !== '..' && !posix.isAbsolute(relative))
  }
  return nested(left, right) || nested(right, left)
}

function canonicalDirectory(path: string, variable: string): string {
  try {
    return realpathSync(path)
  } catch (error) {
    throw new Error(`${variable} does not resolve to an existing path: ${path}`, { cause: error })
  }
}

function positiveSafeInteger(value: string | undefined, fallback: number, variable: string): number {
  const resolved = Number(value ?? fallback)
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`${variable} must be a positive safe integer`)
  }
  return resolved
}

function requireReleasePath(actual: string, expected: string, variable: string): void {
  if (canonicalDirectory(actual, variable) !== canonicalDirectory(expected, 'HGW_RELEASE_ROOT')) {
    throw new Error(`${variable} must resolve inside the configured HGW_RELEASE_ROOT release`)
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const port = Number(env.HGW_PORT ?? 8899)
  const publicOrigins = (env.HGW_PUBLIC_ORIGINS ?? `http://127.0.0.1:${port}`)
    .split(',').map(s => s.trim()).filter(Boolean)
  const configuredReleaseRoot = env.HGW_RELEASE_ROOT?.trim()
  const releaseRoot = configuredReleaseRoot === undefined || configuredReleaseRoot === ''
    ? undefined
    : canonicalDirectory(configuredReleaseRoot, 'HGW_RELEASE_ROOT')
  if (releaseRoot !== undefined) {
    requireReleasePath(gatewayRoot, join(releaseRoot, 'gateway'), 'running Gateway directory')
  }
  const dshRepoRoot = releaseRoot ?? env.HGW_DSH_REPO_ROOT ?? resolve(gatewayRoot, '..')
  if (releaseRoot !== undefined && env.HGW_DSH_REPO_ROOT !== undefined) {
    requireReleasePath(env.HGW_DSH_REPO_ROOT, releaseRoot, 'HGW_DSH_REPO_ROOT')
  }
  const usersRoot = env.HGW_USERS_ROOT ?? join(homedir(), 'harness-users')
  const stateRoot = env.HGW_STATE_ROOT ?? join(homedir(), '.harness-gateway')
  const launcher = env.HGW_LAUNCHER === 'systemd' ? 'systemd' : 'local'
  const configuredProjectPathRoots = projectPathRoots(env.HGW_PROJECT_PATH_ROOTS)
  if (launcher === 'systemd' && configuredProjectPathRoots.length === 0) {
    throw new Error('HGW_PROJECT_PATH_ROOTS is required when HGW_LAUNCHER=systemd')
  }
  const userProjectsRoot = normalizedAbsolutePath(env.HGW_USER_PROJECTS_ROOT
    ?? join(configuredProjectPathRoots[0] ?? stateRoot, 'user-projects'))
  if (!posix.isAbsolute(userProjectsRoot) || userProjectsRoot === '/') {
    throw new Error('HGW_USER_PROJECTS_ROOT must be an absolute path')
  }
  if (launcher === 'systemd' && !configuredProjectPathRoots.some(root => strictlyNestedPath(root, userProjectsRoot))) {
    throw new Error('HGW_USER_PROJECTS_ROOT must be a strict descendant of HGW_PROJECT_PATH_ROOTS when HGW_LAUNCHER=systemd')
  }
  const projectsRoot = normalizedAbsolutePath(env.HGW_PROJECTS_ROOT
    ?? join(configuredProjectPathRoots[0] ?? homedir(), 'harness-projects'))
  if (!posix.isAbsolute(projectsRoot) || projectsRoot === '/') {
    throw new Error('HGW_PROJECTS_ROOT must be an absolute path')
  }
  if (launcher === 'systemd' && !configuredProjectPathRoots.some(root => strictlyNestedPath(root, projectsRoot))) {
    throw new Error('HGW_PROJECTS_ROOT must be a strict descendant of HGW_PROJECT_PATH_ROOTS when HGW_LAUNCHER=systemd')
  }
  const projectRuntimesRoot = env.HGW_PROJECT_RUNTIMES_ROOT ?? join(homedir(), 'harness-project-runtimes')
  const gatewayDir = releaseRoot === undefined ? env.HGW_GATEWAY_DIR ?? gatewayRoot : join(releaseRoot, 'gateway')
  if (releaseRoot !== undefined && env.HGW_GATEWAY_DIR !== undefined) {
    requireReleasePath(env.HGW_GATEWAY_DIR, gatewayDir, 'HGW_GATEWAY_DIR')
  }
  if (pathsOverlap(userProjectsRoot, usersRoot) || pathsOverlap(userProjectsRoot, projectRuntimesRoot)
    || pathsOverlap(userProjectsRoot, gatewayDir)) {
    throw new Error('HGW_USER_PROJECTS_ROOT overlaps a reserved Gateway directory')
  }
  if (pathsOverlap(projectsRoot, usersRoot) || pathsOverlap(projectsRoot, projectRuntimesRoot)
    || pathsOverlap(projectsRoot, gatewayDir) || pathsOverlap(projectsRoot, userProjectsRoot)) {
    throw new Error('HGW_PROJECTS_ROOT overlaps a reserved Gateway directory')
  }
  // The default source-run entry is resolved to ABSOLUTE paths against
  // dshRepoRoot: instances spawn with cwd = user home (outside the repo), so
  // neither a relative `apps/cli/src/bin.ts` nor the bare `tsx/esm` specifier
  // would resolve from there. Production overrides this with HGW_DSH_COMMAND
  // pointing at the pinned npm `dsh` binary and never touches tsx.
  const resolveTsx = (): string => {
    try {
      return createRequire(join(dshRepoRoot, 'package.json')).resolve('tsx/esm')
    } catch {
      // No tsx under dshRepoRoot (tests replace dshCommand; production sets
      // HGW_DSH_COMMAND): keep the bare specifier so a failure surfaces at
      // spawn only if this default command is actually exercised.
      return 'tsx/esm'
    }
  }
  if (releaseRoot !== undefined && env.HGW_DSH_COMMAND !== undefined) {
    throw new Error('HGW_DSH_COMMAND must be unset when HGW_RELEASE_ROOT is configured')
  }
  const dshCommand = releaseRoot === undefined
    ? env.HGW_DSH_COMMAND?.split(' ')
      ?? ['node', '--import', resolveTsx(), join(dshRepoRoot, 'apps/cli/src/bin.ts'), 'web', '--no-open', '--port', '{port}']
    : [process.execPath, join(releaseRoot, 'apps/cli/lib/bin.js'), 'web', '--no-open', '--port', '{port}']
  if (env.HGW_DSH_COMMAND !== undefined && !dshCommand.includes('--no-open')) {
    throw new Error('HGW_DSH_COMMAND must include --no-open because Gateway runtimes are background services')
  }
  const releaseGuardPatch = releaseRoot === undefined
    ? undefined
    : join(releaseRoot, 'plugins/dsh-directory-guard/cordis.patch.yml')
  if (releaseGuardPatch !== undefined && env.HGW_GUARD_PATCH !== undefined && env.HGW_GUARD_PATCH !== 'off') {
    requireReleasePath(env.HGW_GUARD_PATCH, releaseGuardPatch, 'HGW_GUARD_PATCH')
  }
  const guardPatch = env.HGW_GUARD_PATCH === 'off'
    ? ''
    : releaseGuardPatch ?? env.HGW_GUARD_PATCH ?? join(dshRepoRoot, 'plugins/dsh-directory-guard/cordis.patch.yml')
  const releaseModelGovernancePackage = releaseRoot === undefined
    ? undefined
    : join(releaseRoot, 'plugins/dsh-model-governance')
  if (releaseModelGovernancePackage !== undefined && env.HGW_MODEL_GOVERNANCE_PACKAGE !== undefined) {
    requireReleasePath(
      env.HGW_MODEL_GOVERNANCE_PACKAGE,
      releaseModelGovernancePackage,
      'HGW_MODEL_GOVERNANCE_PACKAGE',
    )
  }
  const projectRuntimeUser = env.HGW_PROJECT_RUNTIME_USER ?? 'harness-project'
  if (!SYSTEMD_ACCOUNT_RE.test(projectRuntimeUser) || projectRuntimeUser === 'root') {
    throw new Error(`HGW_PROJECT_RUNTIME_USER is not a valid systemd account: ${projectRuntimeUser}`)
  }
  const runtimeApiBodyLimitBytes = positiveSafeInteger(
    env.HGW_RUNTIME_API_BODY_LIMIT_BYTES,
    DEFAULT_RUNTIME_API_BODY_LIMIT_BYTES,
    'HGW_RUNTIME_API_BODY_LIMIT_BYTES',
  )
  const databaseStartupRetryInitialMs = positiveSafeInteger(
    env.HGW_DATABASE_STARTUP_RETRY_INITIAL_MS,
    DEFAULT_DATABASE_STARTUP_RETRY_INITIAL_MS,
    'HGW_DATABASE_STARTUP_RETRY_INITIAL_MS',
  )
  const databaseStartupRetryMaxMs = positiveSafeInteger(
    env.HGW_DATABASE_STARTUP_RETRY_MAX_MS,
    DEFAULT_DATABASE_STARTUP_RETRY_MAX_MS,
    'HGW_DATABASE_STARTUP_RETRY_MAX_MS',
  )
  if (databaseStartupRetryMaxMs < databaseStartupRetryInitialMs) {
    throw new Error('HGW_DATABASE_STARTUP_RETRY_MAX_MS must be at least HGW_DATABASE_STARTUP_RETRY_INITIAL_MS')
  }
  const instancePortBase = Number(env.HGW_INSTANCE_PORT_BASE ?? 42000)
  if (!Number.isSafeInteger(instancePortBase) || instancePortBase < 1024 || instancePortBase > 65535) {
    throw new Error('HGW_INSTANCE_PORT_BASE must be an integer between 1024 and 65535')
  }
  const jpushAppKey = env.HGW_JPUSH_APP_KEY?.trim() || undefined
  const jpushMasterSecret = env.HGW_JPUSH_MASTER_SECRET?.trim() || undefined
  if ((jpushAppKey === undefined) !== (jpushMasterSecret === undefined)) {
    throw new Error('HGW_JPUSH_APP_KEY and HGW_JPUSH_MASTER_SECRET must be configured together')
  }
  return {
    releaseRoot,
    releaseId: releaseRoot === undefined ? undefined : basename(releaseRoot),
    port,
    organizationSlug: env.HGW_ORGANIZATION_SLUG ?? 'default',
    computeNodeName: env.HGW_COMPUTE_NODE_NAME ?? 'local',
    intakePort: Number(env.HGW_INTAKE_PORT ?? port + 1),
    usageTimeZone: env.HGW_USAGE_TIME_ZONE ?? 'Asia/Shanghai',
    publicOrigins,
    usersRoot,
    projectRuntimesRoot,
    projectPathRoots: configuredProjectPathRoots,
    userProjectsRoot,
    projectsRoot,
    projectRuntimeUser,
    principalKeyDir: env.HGW_PRINCIPAL_KEY_DIR ?? join(stateRoot, 'principal-keys'),
    principalAssertionTtlMs: Number(env.HGW_PRINCIPAL_ASSERTION_TTL_MS ?? 30_000),
    runtimeApiBodyLimitBytes,
    databaseStartupRetryInitialMs,
    databaseStartupRetryMaxMs,
    runtimeCredentialDir: env.HGW_RUNTIME_CREDENTIAL_DIR ?? join(stateRoot, 'runtime-credentials'),
    organizationModelCredentialKeyFile: env.HGW_ORGANIZATION_MODEL_CREDENTIAL_KEY_FILE
      ?? join(stateRoot, 'organization-model-credentials.key'),
    dshCommand,
    dshRepoRoot,
    instancePortBase,
    idleTimeoutMs: Number(env.HGW_IDLE_TIMEOUT_MS ?? 30 * 60 * 1000),
    readinessTimeoutMs: Number(env.HGW_READINESS_TIMEOUT_MS ?? 30 * 1000),
    sessionTtlMs: Number(env.HGW_SESSION_TTL_MS ?? 7 * 24 * 3600 * 1000),
    sessionAbsoluteTtlMs: Number(env.HGW_SESSION_ABS_TTL_MS ?? 30 * 24 * 3600 * 1000),
    secureCookies: publicOrigins.some(o => o.startsWith('https://')),
    launcher,
    memoryMax: env.HGW_MEMORY_MAX ?? '1G',
    cpuQuota: env.HGW_CPU_QUOTA ?? '100%',
    gatewayDir,
    systemdUnitDir: env.HGW_SYSTEMD_UNIT_DIR ?? '/etc/systemd/system',
    guardPatch,
    modelGovernancePackage: releaseModelGovernancePackage
      ?? env.HGW_MODEL_GOVERNANCE_PACKAGE
      ?? join(dshRepoRoot, 'plugins/dsh-model-governance'),
    defaultEnvFile: env.HGW_DEFAULT_ENV_FILE ?? '',
    fcmProjectId: env.HGW_FCM_PROJECT_ID?.trim() || undefined,
    fcmServiceAccountFile: env.HGW_FCM_SERVICE_ACCOUNT_FILE?.trim() || undefined,
    jpushAppKey,
    jpushMasterSecret,
  }
}
