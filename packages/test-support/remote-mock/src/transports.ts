/**
 * In-memory account-preference and project-model-setting carriers for the
 * mock Host: `describe`/`mutate` fold the way the Gateway's HTTP transports
 * present them, so plugins binding account or project scopes behave exactly
 * as against a real deployment with no stored values.
 */
import type {
  AccountPreferenceMutation,
  AccountPreferenceNamespace,
  AccountPreferencesTransport,
  AccountPreferencesView,
  ProjectModelSettingsTransport,
  ProjectModelSettingsView,
} from '@deepseek-ai/dsh-client-connection/client'

/** Namespace defaults the Host resolves under user overrides. */
const ACCOUNT_BASE: AccountPreferencesView['values'] = {
  locale: {},
  'ui-theme': { preference: 'system' },
  'ui-conversation': { busyEnter: 'queue', chatContentWidth: 748, chatFullWidth: false, chatFontSize: 14 },
}

/**
 * Stateful account-preference carrier: `describe` reports the merged view,
 * `mutate` applies one field write to the override layer. `expectedRevision`
 * mismatches reject the write like the Gateway's conflict path.
 */
export class MockAccountPreferences implements AccountPreferencesTransport {
  private revision = 0
  private readonly overrides: Record<AccountPreferenceNamespace, Record<string, string | number | boolean>> = {
    locale: {},
    'ui-theme': {},
    'ui-conversation': {},
  }

  /** Current merged view.
   * @returns describe payload: effective values, overrides, and revision.
   */
  describe(): Promise<AccountPreferencesView> {
    return Promise.resolve(this.view())
  }

  /**
   * Apply one account preference write.
   * @param mutation - namespace, field, set/unset operation, optional revision guard.
   * @returns the merged view after the write.
   * @throws {Error} when `expectedRevision` does not match the current revision.
   */
  mutate(mutation: AccountPreferenceMutation): Promise<AccountPreferencesView> {
    if (mutation.expectedRevision !== undefined && mutation.expectedRevision !== this.revision) {
      return Promise.reject(new Error(`remote-mock: account preferences revision ${String(mutation.expectedRevision)} is stale`))
    }
    const fields = this.overrides[mutation.namespace]
    if (mutation.operation === 'set' && mutation.value !== undefined) fields[mutation.field] = mutation.value
    else this.overrides[mutation.namespace] = Object.fromEntries(
      Object.entries(fields).filter(([key]) => key !== mutation.field),
    )
    this.revision += 1
    return Promise.resolve(this.view())
  }

  private view(): AccountPreferencesView {
    const merge = <T extends object>(base: T, overrides: Record<string, unknown>): T => ({ ...base, ...overrides })
    return {
      revision: this.revision,
      values: {
        locale: { ...ACCOUNT_BASE.locale, ...this.overrides.locale },
        'ui-theme': merge(ACCOUNT_BASE['ui-theme'], this.overrides['ui-theme']),
        'ui-conversation': merge(ACCOUNT_BASE['ui-conversation'], this.overrides['ui-conversation']),
      },
      overrides: {
        locale: { ...this.overrides.locale },
        'ui-theme': { ...this.overrides['ui-theme'] },
        'ui-conversation': { ...this.overrides['ui-conversation'] },
      },
      migrated: false,
    }
  }
}

/**
 * Project-model-settings carrier for deployments without project routes:
 * every project reads as an empty writable document; credential and discovery
 * operations answer empty.
 */
export class MockProjectModelSettings implements ProjectModelSettingsTransport {
  private readonly revisions = new Map<number, number>()

  private revision(projectId: number): number {
    return this.revisions.get(projectId) ?? 0
  }

  /** Read one project's Provider settings.
   * @param projectId - project id.
   * @returns the empty writable view.
   */
  get(projectId: number): Promise<ProjectModelSettingsView> {
    return Promise.resolve(this.view(projectId))
  }

  /**
   * Apply namespace path ops; revision bumps like the Gateway's write path.
   * @param projectId - project id.
   * @param body - ops and optional expected revision.
   * @returns the view after the write.
   */
  mutate(projectId: number, body: {
    ops: Array<{ op: 'set' | 'unset'; path: string[]; value?: unknown }>
    expectedRevision?: number
  }): Promise<ProjectModelSettingsView> {
    const current = this.revision(projectId)
    if (body.expectedRevision !== undefined && body.expectedRevision !== current) {
      return Promise.reject(new Error(`remote-mock: project ${String(projectId)} model settings revision ${String(body.expectedRevision)} is stale`))
    }
    this.revisions.set(projectId, current + 1)
    return Promise.resolve(this.view(projectId))
  }

  /** Report no configured project credentials.
   * @returns empty credential map.
   */
  describeCredentials(): Promise<{
    credentials: Record<string, { configured: boolean; source: 'project'; writable: boolean }>
  }> {
    return Promise.resolve({ credentials: {} })
  }

  /** Accept a project credential write; the secret is never stored. */
  setCredential(): Promise<void> {
    return Promise.resolve()
  }

  /** Accept a project credential removal. */
  unsetCredential(): Promise<void> {
    return Promise.resolve()
  }

  /** Report no discoverable models for the project endpoint.
   * @returns empty model list.
   */
  discover(): Promise<{ models: [] }> {
    return Promise.resolve({ models: [] })
  }

  private view(projectId: number): ProjectModelSettingsView {
    return {
      projectId,
      revision: this.revision(projectId),
      writable: true,
      hasDocument: false,
      namespaces: [],
      providers: [],
      models: { groups: [], failures: [] },
    }
  }
}
