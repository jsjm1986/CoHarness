/** Small browser service carrying the active project's UI policy. */
import type { AccountPermissionAvailability } from './contract/permission-availability.ts'

/** Project theme policy accepted by the Gateway. */
export type ProjectThemePolicy = 'follow-user' | 'light' | 'dark'

/** Immutable project UI policy snapshot. */
export interface ProjectUiPolicySnapshot {
  scope: 'personal' | 'project'
  theme: ProjectThemePolicy
  revision: number
  /** Derived current-account choice eligibility; never a Host catalog mutation. */
  accountPermissions: AccountPermissionAvailability
  /** Active project id and management capability, when in project scope. */
  projectId?: number
  canManage?: boolean
}

/** Runtime-owned source consumed by UI features without importing collaboration. */
export class ProjectUiPolicyRuntime {
  private snapshot: ProjectUiPolicySnapshot = Object.freeze({
    scope: 'personal', theme: 'follow-user', revision: 0, accountPermissions: 'unknown',
  })
  private readonly listeners = new Set<() => void>()

  /** Read the current project UI policy snapshot.
   * @returns the current policy snapshot.
   */
  getSnapshot(): ProjectUiPolicySnapshot { return this.snapshot }

  /** Subscribe to policy replacements.
   * @param listener - callback after a policy replacement.
   * @returns disposer removing the listener.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Replace current-account eligibility after context verification or invalidation.
   * @param accountPermissions - derived eligibility for the authenticated account.
   */
  setAccountPermissions(accountPermissions: AccountPermissionAvailability): void {
    if (this.snapshot.accountPermissions === accountPermissions) return
    this.snapshot = Object.freeze({ ...this.snapshot, accountPermissions, revision: this.snapshot.revision + 1 })
    for (const listener of [...this.listeners]) listener()
  }

  /** Replace the active scope policy and notify consumers only when it moves.
   * @param scope - active account or project scope.
   * @param theme - project theme policy.
   * @param details - optional public project id and management flag.
   */
  set(
    scope: 'personal' | 'project',
    theme: ProjectThemePolicy = 'follow-user',
    details: { projectId?: number; canManage?: boolean } = {},
  ): void {
    if (this.snapshot.scope === scope && this.snapshot.theme === theme
      && this.snapshot.projectId === details.projectId && this.snapshot.canManage === details.canManage) return
    this.snapshot = Object.freeze({
      scope, theme, revision: this.snapshot.revision + 1,
      accountPermissions: this.snapshot.accountPermissions,
      ...details.projectId === undefined ? {} : { projectId: details.projectId },
      ...details.canManage === undefined ? {} : { canManage: details.canManage },
    })
    for (const listener of [...this.listeners]) listener()
  }
}
