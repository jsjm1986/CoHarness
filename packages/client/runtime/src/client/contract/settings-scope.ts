/**
 * The settings-namespace scope contract. The type lives here, in the common
 * dependency of every feature that owns a preference, while the implementation
 * and its Host transport live with the Settings surface
 * (`dsh-client-ui-settings`): a feature service accepts a scope through
 * `attachSettings` without depending on the surface that binds it, which would
 * otherwise close a reference cycle.
 */

/** Why a settings document or namespace cannot accept browser writes. */
export type SettingsWritableReason = 'project' | 'provider' | 'organization' | 'deployment' | 'account'

/** Logical owner shown by settings surfaces. */
export type SettingsOwner = 'account' | 'project' | 'organization' | 'deployment'

/** Persistence source selected by a settings scope. */
export type SettingsScopeSource = 'host' | 'account' | 'account-or-host'

/** State of the most recent settings write attempt. */
export type SettingsWriteState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'blocked'; reason: 'loading' | 'unavailable' | SettingsWritableReason }
  | { status: 'error'; code: string; message: string }

/** Render-facing subset shared by preference rows. */
export interface SettingsControlState {
  /** Namespace synchronization status. */
  status: SettingsScopeSnapshot<unknown>['status']
  /** Whether the Host accepts writes. */
  writable: boolean
  /** Host reason for a read-only document, when known. */
  writableReason: SettingsWritableReason | undefined
  /** Logical owner of the displayed value, when known. */
  owner?: SettingsOwner
  /** Persistence source for the displayed value, when known. */
  mode?: 'host' | 'account' | 'memory'
  /** Latest write state. */
  write: SettingsWriteState
}

/**
 * Project a scope snapshot into the small state a preference control renders.
 * @param snapshot - the current namespace snapshot.
 * @returns the render-facing authority and write state.
 */
export function settingsControlState<T>(snapshot: SettingsScopeSnapshot<T>): SettingsControlState {
  return {
    status: snapshot.status,
    writable: snapshot.writable,
    writableReason: snapshot.writableReason,
    write: snapshot.write,
    ...(snapshot.owner === undefined ? {} : { owner: snapshot.owner }),
    mode: snapshot.mode,
  }
}

/** Client-side sync state of one settings namespace. */
export interface SettingsScopeSnapshot<T> {
  /**
   * `loading` until the first accepted section, `ready` while one stands, and
   * `unavailable` when the namespace is not exposed or the scope is explicitly
   * memory-backed. A Host describe failure remains loading until a view arrives.
   */
  status: 'loading' | 'ready' | 'unavailable'
  /** Last accepted schema-resolved section; undefined before the first acceptance. */
  value: T | undefined
  /**
   * Composition layer the Host resolved {@link value} over, when the owning
   * plugin declared one. What a field reverts to once cleared.
   */
  base: unknown
  /**
   * Raw user layer as stored, when one exists. A field's PRESENCE here is what
   * marks it overridden — an override whose value equals the composition
   * default is still an override, and comparing values could not see it.
   */
  user: unknown
  /** Namespace revision fencing the next write; undefined before the first Host view. */
  revision: number | undefined
  /** Whether the Host document accepts writes; memory mode never does. */
  writable: boolean
  /** Why the Host declined writes, when {@link writable} is false. */
  writableReason: SettingsWritableReason | undefined
  /** State of the most recent write attempt, including blocked and failed writes. */
  write: SettingsWriteState
  /** Persistence source; `memory` is an explicit process-local mode. */
  mode: 'host' | 'account' | 'memory'
  /** Logical owner of the accepted value, when known. */
  owner?: SettingsOwner
}

/** Domain-owned description of one settings namespace consumed by a browser plugin. */
export interface SettingsScopeSpec<T> {
  /** Settings namespace registered by the owning Host plugin. */
  namespace: string
  /** Select account preferences, Host settings, or account with local fallback. */
  source?: SettingsScopeSource
  /**
   * Narrow one wire section; undefined keeps the last accepted value. The
   * default validates the section against the namespace's own serialized wire
   * schema, so domains add a decoder only to narrow beyond that schema.
   */
  decode?: (section: unknown) => T | undefined
}

/**
 * Reactive owner handle over one namespace's durable section — the browser
 * mirror of the Host-side `SettingsScope` owner seam. Domain services read
 * and observe the snapshot and route explicit user choices through `set`.
 */
export interface SettingsScope<T> {
  /** @returns the current sync snapshot (stable reference until the next change). */
  getSnapshot(): SettingsScopeSnapshot<T>
  /**
   * Observe snapshot replacements.
   * @param listener - invoked after each snapshot change.
   * @returns the disposer removing this listener.
   */
  subscribe(listener: () => void): () => void
  /**
   * Queue one field write. Rapid writes preserve mutation order, each carries
   * the latest known namespace revision, and only the latest settlement may
   * publish; a rejected or failed latest write reloads Host state instead.
   * @param field - scalar field inside the namespace section.
   * @param value - JSON-shaped value selected by the user.
   * @returns settlement after the write and any latest-write recovery read.
   */
  set(field: string, value: unknown): Promise<void>
  /**
   * Queue one field clear, so the field re-inherits the composition layer.
   * Shares {@link set}'s ordering, revision, and recovery contract.
   * @param field - scalar field inside the namespace section.
   * @returns settlement after the clear and any latest-write recovery read.
   */
  unset(field: string): Promise<void>
}
