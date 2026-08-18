import { readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import type { GatewayConfig } from './config.ts'

const MAX_DIRECTORY_ENTRIES = 1_000
const OMITTED_DIRECTORY_ENTRY_ERRORS = new Set([
  'EACCES',
  'ELOOP',
  'ENOENT',
  'ENOTDIR',
  'EPERM',
  'ESTALE',
])
const PROJECT_PATH_POLICY_ERRORS = new Set([
  'project-path-outside-root',
  'project-path-reserved',
])

/** One navigable directory returned by the administrator host browser. */
export interface ProjectDirectoryEntry {
  name: string
  path: string
  hidden: boolean
}

/** One breadcrumb in the administrator host directory browser. */
export interface ProjectDirectoryCrumb {
  name: string
  path: string | null
}

/** One bounded directory listing visible only through the administrator API. */
export interface ProjectDirectoryListing {
  path: string | null
  scope: 'filesystem' | 'configured-roots'
  crumbs: ProjectDirectoryCrumb[]
  entries: ProjectDirectoryEntry[]
  selectable: boolean
  truncated: boolean
}

function isCodedError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && 'code' in error && typeof (error as { code: unknown }).code === 'string'
}

function containedBy(root: string, candidate: string): boolean {
  const nested = relative(root, candidate)
  return nested === '' || (!nested.startsWith(`..${sep}`) && nested !== '..' && !isAbsolute(nested))
}

function pathsOverlap(left: string, right: string): boolean {
  return containedBy(left, right) || containedBy(right, left)
}

function canonicalIfPresent(path: string): string {
  const absolute = resolve(path)
  try {
    return realpathSync(absolute)
  } catch (error) {
    if (isCodedError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return absolute
    throw error
  }
}

function rethrowDirectoryFailure(error: unknown): never {
  if (isCodedError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
    throw new Error('project-directory-path-not-found', { cause: error })
  }
  if (isCodedError(error) && (error.code === 'EACCES' || error.code === 'EPERM')) {
    throw new Error('project-directory-path-inaccessible', { cause: error })
  }
  throw error
}

function resolveBrowsableDirectory(path: string): string {
  if (!isAbsolute(path)) throw new Error('project-directory-path-not-absolute')
  let canonical: string
  try {
    canonical = realpathSync(path)
  } catch (error) {
    rethrowDirectoryFailure(error)
  }
  try {
    if (!statSync(canonical).isDirectory()) throw new Error('project-directory-path-not-directory')
  } catch (error) {
    if (error instanceof Error && error.message === 'project-directory-path-not-directory') throw error
    rethrowDirectoryFailure(error)
  }
  return canonical
}

function configuredRoots(cfg: GatewayConfig): string[] {
  return cfg.projectPathRoots.map(canonicalIfPresent)
}

function blockedDirectoryRoots(cfg: GatewayConfig): string[] {
  const roots = [
    cfg.usersRoot,
    cfg.projectRuntimesRoot,
    cfg.userProjectsRoot,
    cfg.principalKeyDir,
    cfg.runtimeCredentialDir,
    dirname(cfg.organizationModelCredentialKeyFile),
    cfg.gatewayDir,
    cfg.dshRepoRoot,
    cfg.modelGovernancePackage,
    cfg.guardPatch === '' ? undefined : dirname(cfg.guardPatch),
    cfg.defaultEnvFile === '' ? undefined : dirname(cfg.defaultEnvFile),
  ].filter((path): path is string => path !== undefined)
  return [...new Set(roots.map(canonicalIfPresent))]
}

function blockedForBrowsing(canonical: string, blockedRoots: readonly string[]): boolean {
  return blockedRoots.some(blocked => containedBy(blocked, canonical))
}

function selectableImportPath(
  cfg: GatewayConfig,
  canonical: string,
  blockedPaths: readonly string[],
): boolean {
  try {
    assertProjectImportPathAllowed(cfg, canonical)
  } catch (error) {
    if (error instanceof Error && PROJECT_PATH_POLICY_ERRORS.has(error.message)) return false
    throw error
  }
  return blockedPaths.every(blocked => !pathsOverlap(canonical, blocked))
}

function omittedDirectoryEntryFailure(error: unknown): boolean {
  return isCodedError(error) && OMITTED_DIRECTORY_ENTRY_ERRORS.has(error.code)
}

function localCrumbs(path: string): ProjectDirectoryCrumb[] {
  const root = parse(path).root
  const crumbs: ProjectDirectoryCrumb[] = [{ name: root, path: root }]
  const nested = relative(root, path)
  if (nested === '') return crumbs
  let current = root
  for (const part of nested.split(sep)) {
    current = join(current, part)
    crumbs.push({ name: part, path: current })
  }
  return crumbs
}

function configuredCrumbs(path: string, root: string): ProjectDirectoryCrumb[] {
  const crumbs: ProjectDirectoryCrumb[] = [
    { name: '可用目录', path: null },
    { name: root, path: root },
  ]
  const nested = relative(root, path)
  if (nested === '') return crumbs
  let current = root
  for (const part of nested.split(sep)) {
    current = join(current, part)
    crumbs.push({ name: part, path: current })
  }
  return crumbs
}

function readEntries(
  current: string,
  configuredRoot: string | undefined,
  blockedRoots: readonly string[],
): { entries: ProjectDirectoryEntry[]; truncated: boolean } {
  let names: string[]
  try {
    names = readdirSync(current, { withFileTypes: true }).map(entry => entry.name)
  } catch (error) {
    rethrowDirectoryFailure(error)
  }
  names.sort((left, right) => left.localeCompare(right, 'zh-CN', { numeric: true, sensitivity: 'base' }))

  const entries: ProjectDirectoryEntry[] = []
  const seen = new Set<string>()
  let truncated = false
  for (const name of names) {
    const candidate = join(current, name)
    let canonical: string
    try {
      canonical = realpathSync(candidate)
      if (!statSync(canonical).isDirectory()) continue
    } catch (error) {
      if (omittedDirectoryEntryFailure(error)) continue
      throw error
    }
    if (canonical === current || containedBy(canonical, current)) continue
    if (configuredRoot !== undefined && !containedBy(configuredRoot, canonical)) continue
    if (blockedForBrowsing(canonical, blockedRoots) || seen.has(canonical)) continue
    seen.add(canonical)
    if (entries.length === MAX_DIRECTORY_ENTRIES) {
      truncated = true
      break
    }
    entries.push({ name, path: canonical, hidden: name.startsWith('.') })
  }
  return { entries, truncated }
}

/**
 * Reject an administrator-imported project path that can expose Gateway-owned data.
 * @param cfg - Gateway filesystem and launcher configuration
 * @param canonical - existing canonical directory selected for the project
 * @param options - permits the user-managed allocator inside its dedicated root
 */
export function assertProjectImportPathAllowed(
  cfg: GatewayConfig,
  canonical: string,
  options: { allowUserProjectsRoot?: boolean } = {},
): void {
  if (cfg.launcher === 'systemd' && !configuredRoots(cfg).some(root => {
    return canonical !== root && containedBy(root, canonical)
  })) {
    throw new Error('project-path-outside-root')
  }

  const projectsRoot = canonicalIfPresent(cfg.projectsRoot)
  if (containedBy(canonical, projectsRoot)) throw new Error('project-path-reserved')

  const userProjectsRoot = canonicalIfPresent(cfg.userProjectsRoot)
  const userRootAllowed = options.allowUserProjectsRoot === true
    && canonical !== userProjectsRoot
    && containedBy(userProjectsRoot, canonical)
  if (!userRootAllowed && pathsOverlap(canonical, userProjectsRoot)) {
    throw new Error('project-path-reserved')
  }

  for (const blocked of blockedDirectoryRoots(cfg)) {
    if (blocked === userProjectsRoot) continue
    if (userRootAllowed && containedBy(blocked, userProjectsRoot)) continue
    if (pathsOverlap(canonical, blocked)) throw new Error('project-path-reserved')
  }
}

/**
 * List one host-directory level for the administrator project creation dialog.
 * @param cfg - Gateway filesystem and launcher configuration
 * @param requestedPath - absolute directory path, or omitted for the scope root
 * @param blockedPaths - canonical user homes and registered project directories omitted from navigation
 * @returns bounded, sorted directory entries and breadcrumb state
 */
export function listProjectDirectories(
  cfg: GatewayConfig,
  requestedPath: string | undefined,
  blockedPaths: readonly string[] = [],
): ProjectDirectoryListing {
  const scope = cfg.launcher === 'systemd' ? 'configured-roots' : 'filesystem'
  const roots = [...new Set(configuredRoots(cfg))]
  if (scope === 'configured-roots' && requestedPath === undefined) {
    const entries = roots.map(root => ({
      name: basename(root) || root,
      path: resolveBrowsableDirectory(root),
      hidden: basename(root).startsWith('.'),
    })).sort((left, right) => left.path.localeCompare(right.path))
    return {
      path: null,
      scope,
      crumbs: [{ name: '可用目录', path: null }],
      entries: entries.slice(0, MAX_DIRECTORY_ENTRIES),
      selectable: false,
      truncated: entries.length > MAX_DIRECTORY_ENTRIES,
    }
  }

  const canonicalBlockedPaths = [...new Set(blockedPaths.map(canonicalIfPresent))]
  const browsingBlockedRoots = [
    ...new Set([...blockedDirectoryRoots(cfg), ...canonicalBlockedPaths]),
  ]
  const current = resolveBrowsableDirectory(requestedPath ?? parse(resolve('/')).root)
  const configuredRoot = scope === 'configured-roots'
    ? roots.find(root => containedBy(root, current))
    : undefined
  if (scope === 'configured-roots' && configuredRoot === undefined) {
    throw new Error('project-directory-path-outside-root')
  }
  if (blockedForBrowsing(current, browsingBlockedRoots)) {
    throw new Error('project-directory-path-reserved')
  }
  const { entries, truncated } = readEntries(current, configuredRoot, browsingBlockedRoots)
  return {
    path: current,
    scope,
    crumbs: configuredRoot === undefined ? localCrumbs(current) : configuredCrumbs(current, configuredRoot),
    entries,
    selectable: current !== configuredRoot && selectableImportPath(cfg, current, canonicalBlockedPaths),
    truncated,
  }
}
