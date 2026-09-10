/** Constants and helpers for the changed-package (scoped) coverage lane. */

/** Marker that suppresses global per-file thresholds inside a scoped coverage process. */
export const COVERAGE_SCOPED_MODE_ENV = 'DSH_COVERAGE_SCOPED_MODE'

/** Comma- or JSON-separated changed package paths (`group/pkg`) for the scoped lane. */
export const SCOPED_PACKAGES_ENV = 'DSH_SCOPED_PACKAGES'

/** Pull-request base ref that owns the changed-file set for incremental coverage. */
export const SCOPED_BASE_ENV = 'DSH_INCREMENTAL_BASE'

/**
 * Resolve the vitest test-directory filters for the scoped coverage lane.
 * @param raw - Comma- or JSON-separated changed package paths.
 * @returns Repository-relative test directories, one per listed package.
 */
export function scopedPackageTestDirs(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') {
    throw new Error(`${SCOPED_PACKAGES_ENV} must list the changed packages for the scoped coverage lane.`)
  }
  let packages: string[]
  try {
    const parsed: unknown = JSON.parse(raw)
    packages = Array.isArray(parsed) ? parsed.map(value => String(value)) : raw.split(',').map(value => value.trim()).filter(Boolean)
  } catch {
    packages = raw.split(',').map(value => value.trim()).filter(Boolean)
  }
  const dirs = packages.map(pkg => `packages/${pkg}/tests`)
  if (dirs.length === 0) {
    throw new Error(`${SCOPED_PACKAGES_ENV} must list at least one changed package.`)
  }
  return dirs
}
