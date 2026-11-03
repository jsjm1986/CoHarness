import { closeSync, constants, fchmodSync, fchownSync, lstatSync, mkdirSync, openSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { GatewayConfig } from './config.ts'
import type { EffectiveGrant } from './projects.ts'
import { runtimeDirectoryGrants } from './runtime-directory-grants.ts'
import type { GatewayDeps } from './server.ts'

/**
 * Write pretty-printed grants to `$DSH_HOME/directory-grants.json`, creating the directory.
 * @param cfg - gateway config (`usersRoot`)
 * @param username - instance owner
 * @param grants - effective grants including home
 * @returns absolute path of the written file
 */
export function writeGrantsFile(cfg: GatewayConfig, username: string, grants: EffectiveGrant[]): string {
  return writeRuntimeGrantsFile(join(cfg.usersRoot, username, 'dsh'), grants, cfg.usersRoot)
}

/** Write one runtime's complete directory grant projection. */
export function writeRuntimeGrantsFile(dshHome: string, grants: EffectiveGrant[], containmentRoot?: string): string {
  const resolvedHome = resolve(dshHome)
  if (containmentRoot !== undefined) ensureManagedDirectoryTree(resolve(containmentRoot), resolvedHome)
  else mkdirSync(dshHome, { recursive: true })
  const homeEntry = lstatSync(resolvedHome, { throwIfNoEntry: false })
  if (homeEntry === undefined || !homeEntry.isDirectory()) {
    throw new Error(`runtime dsh home is not a directory: ${resolvedHome}`)
  }
  if (homeEntry.isSymbolicLink()) throw new Error(`runtime dsh home must not be a symbolic link: ${resolvedHome}`)
  if (containmentRoot !== undefined) {
    const canonicalRoot = resolve(realpathSync(containmentRoot))
    const canonicalHome = resolve(realpathSync(resolvedHome))
    const nested = relative(canonicalRoot, canonicalHome)
    if (nested === '' || nested.startsWith('../') || nested === '..' || isAbsolute(nested)) {
      throw new Error(`runtime dsh home is outside its managed root: ${resolvedHome}`)
    }
  }
  const path = join(dshHome, 'directory-grants.json')
  const entry = lstatSync(path, { throwIfNoEntry: false })
  if (entry?.isSymbolicLink()) throw new Error(`runtime grants file must not be a symbolic link: ${path}`)
  if (entry !== undefined && !entry.isFile()) throw new Error(`runtime grants path is not a file: ${path}`)
  const noFollow = constants.O_NOFOLLOW ?? 0
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | noFollow, 0o600)
  try {
    writeFileSync(fd, JSON.stringify(grants, null, 2), { encoding: 'utf8' })
    if (process.platform !== 'win32') { fchownSync(fd, homeEntry.uid, homeEntry.gid); fchmodSync(fd, 0o600) }
  } finally {
    closeSync(fd)
  }
  return path
}

/** Create a managed directory tree one component at a time without following links. */
function ensureManagedDirectoryTree(root: string, target: string): void {
  const nested = relative(root, target)
  if (nested === '' || nested.startsWith(`..${sep}`) || nested === '..' || isAbsolute(nested)) {
    throw new Error(`runtime dsh home is outside its managed root: ${target}`)
  }
  // The managed root itself may be absent, but its parent must be a real
  // directory before creation begins; never let recursive mkdir follow it.
  const parts = nested.split(sep).filter(Boolean)
  let current = root
  try {
    const rootEntry = lstatSync(current)
    if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) throw new Error(`managed root is not a directory: ${root}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    mkdirSync(current, { recursive: true, mode: 0o700 })
    const rootEntry = lstatSync(current)
    if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) throw new Error(`managed root is not a directory: ${root}`)
  }
  for (const part of parts) {
    current = join(current, part)
    const entry = lstatSync(current, { throwIfNoEntry: false })
    if (entry?.isSymbolicLink()) throw new Error(`managed runtime directory must not contain a symbolic link: ${current}`)
    if (entry !== undefined && !entry.isDirectory()) throw new Error(`managed runtime directory is not a directory: ${current}`)
    if (entry === undefined) mkdirSync(current, { mode: 0o700 })
  }
}

/**
 * A committed grants write whose runtime restart failed after the
 * `admin.instances.restart-failed` audit row was recorded. Admin callers may
 * treat only this classification as an audited partial success; every other
 * failure keeps its original identity.
 */
export class GrantRestartError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'GrantRestartError'
  }
}

/**
 * Recompute a user's grants file; restart an active owner's instance when it is `ready` or `starting`; disabled owners stop without restarting.
 * Restart failure writes `admin.instances.restart-failed` (actor as `userId`) then rethrows
 * as {@link GrantRestartError}; an audit-write failure replaces the restart error instead.
 * @param deps - cfg, projects, users, instances, audit
 * @param userId - user whose grants changed
 * @param actorId - admin who triggered the change
 * @returns `'restarted'` after stop+start, `'written'` for a stopped instance or disabled owner after stop, or `'deleted'` after a confirmed concurrent account deletion.
 */
export async function applyGrantsToUser(
  deps: Pick<GatewayDeps, 'cfg' | 'projects' | 'users' | 'instances' | 'audit'>,
  userId: number,
  actorId: number,
): Promise<'restarted' | 'written' | 'deleted'> {
  const user = await deps.users.getById(userId)
  if (user === null) {
    if (await confirmedDeleted(deps.users, userId)) return 'deleted'
    throw new Error(`no user ${userId}`)
  }
  const targets = deps.instances.targetsForOwner === undefined ? [{ kind: 'user' as const, id: userId }]
    : await deps.instances.targetsForOwner(userId)
  let restarted = false
  const projectionFailures: unknown[] = []
  const restartFailures: unknown[] = []
  for (const target of targets) {
    try {
      const storage = await deps.instances.storageOf?.(target)
      if (storage?.provisioning === 'preparing') continue
      const subject = { ...user, ...storage, runtimeId: target.runtimeId }
      writeRuntimeGrantsFile(storage?.dshHome ?? join(deps.cfg.usersRoot, user.username, 'dsh'),
        await runtimeDirectoryGrants(subject, deps.projects), deps.cfg.usersRoot)
      const address = target.runtimeId === undefined ? userId : target
      const state = await deps.instances.stateOf(address)
      if (state !== 'ready' && state !== 'starting') continue
      try {
        await deps.instances.stop(address, 'access-change')
        if (user.status !== 'active') continue
        await deps.instances.ensureRunning(subject)
        restarted = true
      } catch (error) {
        if (await confirmedDeleted(deps.users, userId, { error })) return 'deleted'
        await deps.audit.write({ userId: actorId, action: 'admin.instances.restart-failed',
          detail: JSON.stringify({ userId, runtimeId: target.runtimeId, error: String(error) }) })
        restartFailures.push(error)
      }
    } catch (error) {
      if (await confirmedDeleted(deps.users, userId, { error })) return 'deleted'
      projectionFailures.push(error)
    }
  }
  if (projectionFailures.length > 0) {
    const failures = [...projectionFailures, ...restartFailures]
    throw failures.length === 1 ? failures[0] : new AggregateError(failures, 'Personal Runtime grant application failed')
  }
  if (restartFailures.length > 0) {
    const cause = restartFailures.length === 1 ? restartFailures[0] : new AggregateError(restartFailures, 'Personal Runtime restart failed')
    throw new GrantRestartError(cause instanceof Error ? cause.message : String(cause), { cause })
  }
  if (await confirmedDeleted(deps.users, userId)) return 'deleted'
  return restarted ? 'restarted' : 'written'
}

/** Only an authoritative tombstone classifies deletion; failed verification preserves both failures. */
async function confirmedDeleted(users: GatewayDeps['users'], userId: number, failed?: { error: unknown }): Promise<boolean> {
  try { return await users.isDeleted?.(userId) === true } catch (error) {
    if (failed === undefined) throw error
    throw new AggregateError([failed.error, error], 'Grant application failed and account deletion could not be verified')
  }
}
