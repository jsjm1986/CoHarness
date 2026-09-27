/** Account eligibility never borrows a different runtime target's deployment fact. */
import { describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '../src/client/contract/store.ts'
import { permissionAvailabilityFor, permissionAvailabilitySource, permissionUnavailableReason } from '../src/client/contract/permission-availability.ts'
import { ProjectUiPolicyRuntime } from '../src/client/project-policy.ts'

describe('permission availability', () => {
  it('requires an explicit standalone description and preserves ordinary choices during uncertainty', () => {
    expect(permissionAvailabilityFor('full-and-auto', undefined)).toBe('unknown')
    expect(permissionAvailabilityFor('unknown', true)).toBe('unknown')
    expect(permissionAvailabilityFor('unknown', false)).toBe('local')
    expect(permissionUnavailableReason('workspace-write', 'unknown')).toBeUndefined()
    expect(permissionUnavailableReason('auto', 'unknown')).toBe('unverified')
    expect(permissionUnavailableReason('danger-full-access', 'auto')).toBe('admin-required')
    expect(permissionUnavailableReason('auto', 'full')).toBe('auto-ineligible')
  })

  it('observes only eligibility changes and the owning connection generation', () => {
    const account = new ProjectUiPolicyRuntime()
    account.setAccountPermissions('full-and-auto')
    const managedHost = createSnapshotStore<{ executionAuthorityRequired?: boolean } | undefined>({ executionAuthorityRequired: true })
    const localHost = createSnapshotStore<{ executionAuthorityRequired?: boolean } | undefined>({ executionAuthorityRequired: false })
    const managed = permissionAvailabilitySource(account, managedHost)
    const local = permissionAvailabilitySource(account, localHost)
    const changed = vi.fn()
    const localChanged = vi.fn()
    const stop = managed.subscribe(changed)
    const stopLocal = local.subscribe(localChanged)
    account.set('project', 'dark', { projectId: 1 })
    expect(changed).not.toHaveBeenCalled()
    managedHost.set(undefined)
    expect(managed.getSnapshot()).toBe('unknown')
    expect(local.getSnapshot()).toBe('local')
    expect(changed).toHaveBeenCalledOnce()
    expect(localChanged).not.toHaveBeenCalled()
    stop(); stopLocal()
  })
})
