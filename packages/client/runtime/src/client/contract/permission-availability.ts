/** Current-account permission choices combined with the owning connection's deployment fact. */
import type { ObservableSnapshot } from './store.ts'

/** Verified account qualifications; unknown never grants a privileged choice. */
export type AccountPermissionAvailability = 'unknown' | 'standard' | 'auto' | 'full' | 'full-and-auto'
/** Standalone local deployments retain their configured choices. */
export type PermissionAvailability = AccountPermissionAvailability | 'local'
/** User-facing reason an account cannot select one privileged mode. */
export type PermissionUnavailableReason = 'unverified' | 'admin-required' | 'auto-ineligible'

/**
 * Combine account qualifications with the exact target connection's description.
 * @param account - verified account qualification, or unknown while refreshing.
 * @param managed - the owning Host's explicit deployment marker; absence is unknown.
 * @returns current selection availability without changing the Host catalog.
 */
export function permissionAvailabilityFor(account: AccountPermissionAvailability, managed: boolean | undefined): PermissionAvailability {
  return managed === false ? 'local' : managed === true ? account : 'unknown'
}

/**
 * Explain why a preset cannot be selected by the current account.
 * @param preset - Host catalog option value.
 * @param availability - live account and target-connection qualification.
 * @returns the refusal reason, or undefined for an available option.
 */
export function permissionUnavailableReason(preset: string, availability: PermissionAvailability): PermissionUnavailableReason | undefined {
  if (preset !== 'danger-full-access' && preset !== 'auto') return undefined
  if (availability === 'local') return undefined
  if (availability === 'unknown') return 'unverified'
  if (preset === 'danger-full-access') return availability === 'full' || availability === 'full-and-auto' ? undefined : 'admin-required'
  return availability === 'auto' || availability === 'full-and-auto' ? undefined : 'auto-ineligible'
}

/**
 * Observe existing account and connection sources without retaining another permission cache.
 * @param account - runtime-owned account UI projection.
 * @param host - this Session's owning connection description.
 * @returns a derived source whose value is stable between source changes.
 */
export function permissionAvailabilitySource(
  account: ObservableSnapshot<{ accountPermissions: AccountPermissionAvailability }> | undefined,
  host: ObservableSnapshot<{ executionAuthorityRequired?: boolean } | undefined> | undefined,
): ObservableSnapshot<PermissionAvailability> {
  const getSnapshot = (): PermissionAvailability => permissionAvailabilityFor(
    account?.getSnapshot().accountPermissions ?? 'unknown', host?.getSnapshot()?.executionAuthorityRequired,
  )
  return {
    getSnapshot,
    subscribe: (listener) => {
      let previous = getSnapshot()
      const changed = (): void => {
        const next = getSnapshot()
        if (next === previous) return
        previous = next
        listener()
      }
      const releaseAccount = account?.subscribe(changed)
      const releaseHost = host?.subscribe(changed)
      return () => { releaseAccount?.(); releaseHost?.() }
    },
  }
}
