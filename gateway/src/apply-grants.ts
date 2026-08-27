import { closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync, realpathSync, writeFileSync } from 'node:fs'
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
  const noFollow = constants.O_NOFOLLOW ?? 0
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | noFollow, 0o600)
  try {
    writeFileSync(fd, JSON.stringify(grants, null, 2), { encoding: 'utf8' })
    fchmodSync(fd, 0o600)
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
 * Recompute a user's grants file; restart the instance only when it is `ready` or `starting`.
 * Restart failure writes `admin.instances.restart-failed` (actor as `userId`) then rethrows.
 * @param deps - cfg, projects, users, instances, audit
 * @param userId - user whose grants changed
 * @param actorId - admin who triggered the change
 * @returns `'restarted'` after stop+start; `'written'` when the instance was already stopped
 */
export async function applyGrantsToUser(
  deps: Pick<GatewayDeps, 'cfg' | 'projects' | 'users' | 'instances' | 'audit'>,
  userId: number,
  actorId: number,
): Promise<'restarted' | 'written'> {
  const user = await deps.users.getById(userId)
  if (user === null) throw new Error(`no user ${userId}`)
  writeGrantsFile(deps.cfg, user.username, await runtimeDirectoryGrants(user, deps.projects))
  const state = await deps.instances.stateOf(userId)
  if (state !== 'ready' && state !== 'starting') return 'written'
  try {
    await deps.instances.stop(userId)
    await deps.instances.ensureRunning(user)
    return 'restarted'
  } catch (error) {
    await deps.audit.write({
      userId: actorId,
      action: 'admin.instances.restart-failed',
      detail: JSON.stringify({ userId, error: String(error) }),
    })
    throw error
  }
}
