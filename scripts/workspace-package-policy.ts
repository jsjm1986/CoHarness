/** Shared workspace package classification used by publication and quality gates. */

const PRIVATE_WORKSPACE_DIRECTORIES = new Set(['apps/android-shell'])

function normalizeDirectory(directory: string): string {
  return directory.replaceAll('\\', '/').replace(/\/+$/, '')
}

/**
 * Return whether a workspace directory is a repository-local application that
 * is intentionally outside the npm release families.
 *
 * @param directory - Repository-relative workspace directory.
 * @returns `true` when the directory remains private and must not be packed.
 */
export function isPrivateWorkspaceDirectory(directory: string): boolean {
  return PRIVATE_WORKSPACE_DIRECTORIES.has(normalizeDirectory(directory))
}

/**
 * Return whether a workspace directory participates in npm publication.
 *
 * @param directory - Repository-relative workspace directory.
 * @returns `true` when release discovery may include the directory.
 */
export function isPublishableWorkspaceDirectory(directory: string): boolean {
  return !isPrivateWorkspaceDirectory(directory)
}
