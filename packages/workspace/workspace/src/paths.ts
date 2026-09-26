/**
 * Path canonicalization for workspace identity.
 * @module @deepseek-ai/dsh-workspace/src/paths
 */

import { FsError } from '@deepseek-ai/dsh-fs'
import type { FileSystem, FsInfo } from '@deepseek-ai/dsh-fs'
import { posix, win32 } from 'node:path'

/**
 * Check whether a path names one fixed Host location without process cwd or
 * current-drive resolution.
 * @param path - Candidate Workspace path.
 * @param platform - Host platform; injectable for deterministic path tests.
 * @returns Whether the path is fully qualified on that platform.
 */
export function fullyQualifiedWorkspacePath(
  path: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32') return posix.isAbsolute(path)
  const root = win32.parse(path).root
  return win32.isAbsolute(path) && root !== '\\' && root !== '/'
}

/**
 * Derive a non-empty default title from a canonical Workspace path.
 * @param path - Canonical Workspace path.
 * @param platform - Host platform; injectable for deterministic path tests.
 * @returns The final segment when present, otherwise the complete root spelling.
 */
export function defaultWorkspaceTitle(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const pathApi = platform === 'win32' ? win32 : posix
  return pathApi.basename(path) || pathApi.parse(path).root
}

/**
 * Resolve an existing path through the execution target's filesystem. The
 * provider owns symlink identity and process-path spelling; opaque target keys
 * never become workspace paths. Missing paths reject without a Host fallback.
 * @param path - Fully qualified path on the execution target.
 * @param filesystem - Filesystem belonging to this registry's runtime.
 * @returns Canonical process path and current metadata on that target.
 */
export async function resolveWorkspacePath(
  path: string,
  filesystem: FileSystem,
): Promise<{ path: string; info: FsInfo }> {
  if (!fullyQualifiedWorkspacePath(path)) {
    throw new TypeError(`Workspace path is not fully qualified: '${path}'`)
  }
  const target = await filesystem.resolve(path)
  const info = await filesystem.stat(target)
  if (info === undefined) throw new FsError(`Workspace path does not exist: '${path}'`, 'FS_NOT_FOUND')
  return { path: filesystem.processPath(target), info }
}
