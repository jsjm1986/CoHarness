/** Account-preference backend hidden behind the shared SettingsScope face. */

import type {
  AccountPreferenceMutation, AccountPreferencesTransport, AccountPreferencesView,
  AccountPreferencesRequestError,
} from '@deepseek-ai/dsh-client-connection/client'
import {
  createSnapshotStore, type SettingsScope, type SettingsScopeSnapshot,
  type SettingsScopeSpec, type SettingsWriteState, type SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'

/** One account namespace projected into the common scope vocabulary. */
interface AccountNamespaceView {
  ns: string
  value: unknown
  base: unknown
  user: unknown
  revision: number
  writable: true
  owner: 'account'
}

/** Account mirror state shared by all account-backed scopes. */
export interface AccountPreferencesMirrorSnapshot {
  status: 'idle' | 'loading' | 'ready' | 'unavailable'
  view: AccountPreferencesView | undefined
  error: string | null
  /** True only when the endpoint is not part of this deployment. */
  unsupported: boolean
}

/** A single account preference read/fold source. */
export class AccountPreferencesMirror {
  private readonly store: SnapshotStore<AccountPreferencesMirrorSnapshot>
  private inFlight: Promise<void> | undefined

  constructor(private readonly transport: AccountPreferencesTransport | undefined) {
    this.store = createSnapshotStore({
      status: transport === undefined ? 'unavailable' : 'idle',
      view: undefined,
      error: transport === undefined ? 'account preferences are not available' : null,
      unsupported: transport === undefined,
    })
  }

  /** Read the current account mirror snapshot.
   * @returns the current account mirror snapshot.
   */
  getSnapshot(): AccountPreferencesMirrorSnapshot {
    return this.store.getSnapshot()
  }

  /** Subscribe to account mirror changes.
   * @param listener - called after the mirror changes.
   * @returns disposer removing the listener.
   */
  subscribe(listener: () => void): () => void {
    return this.store.subscribe(listener)
  }

  /** Load account preferences once, coalescing concurrent callers. */
  ensure(): Promise<void> {
    if (this.transport === undefined) return Promise.resolve()
    if (this.inFlight !== undefined) return this.inFlight
    if (this.store.getSnapshot().status === 'ready') return Promise.resolve()
    return this.load()
  }

  /** Refresh account preferences, preserving the last good answer on failure. */
  load(): Promise<void> {
    if (this.transport === undefined) return Promise.resolve()
    if (this.inFlight !== undefined) return this.inFlight
    const run = this.read()
    this.inFlight = run
    return run
  }

  /** Fold a successful mutation response into the held mirror.
   * @param view - validated account preference response.
   */
  accept(view: AccountPreferencesView): void {
    this.store.set({ status: 'ready', view, error: null, unsupported: false })
  }

  /** Project one namespace into the shared Host-like view.
   * @param ns - account namespace to project.
   * @returns the Host-like view, or undefined for an unknown namespace/unloaded mirror.
   */
  namespace(ns: string): AccountNamespaceView | undefined {
    const view = this.store.getSnapshot().view
    if (view === undefined) return undefined
    const base = ns === 'locale'
      ? {}
      : ns === 'ui-theme'
        ? { preference: 'system' }
        : {
          busyEnter: 'queue',
          chatContentWidth: 748,
          chatFullWidth: false,
          chatFontSize: 14,
        }
    const value = ns === 'locale'
      ? view.values.locale
      : ns === 'ui-theme'
        ? view.values['ui-theme']
        : ns === 'ui-conversation'
          ? view.values['ui-conversation']
          : undefined
    const user = ns === 'locale'
      ? view.overrides.locale
      : ns === 'ui-theme'
        ? view.overrides['ui-theme']
        : ns === 'ui-conversation'
          ? view.overrides['ui-conversation']
          : undefined
    if (value === undefined || user === undefined) return undefined
    return { ns, value, base, user, revision: view.revision, writable: true, owner: 'account' }
  }

  private async read(): Promise<void> {
    const transport = this.transport
    try {
      this.store.update((state) => {
        state.status = 'loading'
        state.error = null
        state.unsupported = false
      })
      // `load()` returns early when the optional carrier is absent; optional
      // chaining keeps that invariant local without adding a second state.
      const view = await transport?.describe()
      /* v8 ignore next -- load() returns before read() when the carrier is absent. */
      if (view === undefined) return
      this.accept(view)
    } catch (error: unknown) {
      const unsupported = isUnsupported(error)
      const held = this.store.getSnapshot().view
      this.store.set({
        status: held === undefined ? 'unavailable' : 'ready',
        view: held,
        error: error instanceof Error ? error.message : String(error),
        unsupported,
      })
    } finally {
      this.inFlight = undefined
    }
  }
}

/** Account-backed implementation of the common scope write lifecycle. */
export class AccountSettingsScopeController<T> implements SettingsScope<T> {
  private readonly store: SnapshotStore<SettingsScopeSnapshot<T>>
  private readonly unsubscribe: () => void
  private tail: Promise<void> = Promise.resolve()
  private generation = 0
  /** Revision returned by a completed write that has a queued successor. */
  private pendingRevision: number | undefined
  private disposed = false

  constructor(
    private readonly transport: AccountPreferencesTransport | undefined,
    private readonly spec: SettingsScopeSpec<T>,
    private readonly mirror: AccountPreferencesMirror,
  ) {
    this.store = createSnapshotStore({
      status: transport === undefined ? 'unavailable' : 'loading',
      value: undefined,
      base: undefined,
      user: undefined,
      revision: undefined,
      writable: false,
      writableReason: transport === undefined ? 'account' : undefined,
      write: { status: 'idle' },
      mode: 'account',
      owner: 'account',
    })
    this.unsubscribe = mirror.subscribe(() => { this.derive() })
    this.derive()
  }

  /* jscpd:ignore-start -- parallel SettingsScope implementations share the
   * snapshot/subscribe/set/unset surface by design; it is the protocol
   * contract each scope fulfils while its write payload differs. */
  /** @returns the current scope snapshot. */
  getSnapshot(): SettingsScopeSnapshot<T> {
    return this.store.getSnapshot()
  }

  /** @param listener - called after a snapshot replacement. @returns disposer. */
  subscribe(listener: () => void): () => void {
    return this.store.subscribe(listener)
  }

  /** Queue one account field write. */
  set(field: string, value: unknown): Promise<void> {
    return this.write({ operation: 'set', field, value })
  }

  /** Queue one account field clear. */
  unset(field: string): Promise<void> {
    return this.write({ operation: 'unset', field })
  }
  /* jscpd:ignore-end */

  /** Stop the scope and wait for an in-flight mutation. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.generation += 1
    this.unsubscribe()
    await this.tail
  }

  private write(input: { operation: 'set' | 'unset'; field: string; value?: unknown }): Promise<void> {
    const generation = ++this.generation
    return this.enqueue(async () => {
      const before = this.getSnapshot()
      if (before.status !== 'ready' || !before.writable) {
        this.setWrite({ status: 'blocked', reason: before.writableReason ?? 'account' })
        return
      }
      if (input.field === '' || input.field.includes('.')) {
        this.setWrite({ status: 'error', code: 'invalid-field', message: 'account preference field must be scalar' })
        return
      }
      this.setWrite({ status: 'saving' })
      const mutation: AccountPreferenceMutation = {
        namespace: this.spec.namespace as AccountPreferenceMutation['namespace'],
        field: input.field as AccountPreferenceMutation['field'],
        operation: input.operation,
        ...(input.operation === 'set' ? { value: input.value as string | number } : {}),
      }
      const transport = this.transport
      /* v8 ignore next -- enqueue returns immediately when transport is absent. */
      if (transport === undefined) return
      const attempt = async (): Promise<void> => {
        const revision = this.pendingRevision ?? this.getSnapshot().revision
        const view = await transport.mutate({
          ...mutation,
          /* v8 ignore next -- a ready account namespace always carries the mirror revision. */
          ...(revision === undefined ? {} : { expectedRevision: revision }),
        })
        if (this.disposed) return
        if (generation === this.generation) {
          this.pendingRevision = undefined
          this.mirror.accept(view)
          this.setWrite({ status: 'idle' })
        } else {
          // A queued successor must fence against this response even though
          // the mirror cannot publish it without hiding the successor's
          // still-pending value from the account UI.
          this.pendingRevision = view.revision
        }
      }
      try {
        await attempt()
      } catch (error: unknown) {
        // A stale expectedRevision is only a fence against concurrent
        // writers: reload the mirror and retry once on the fresh revision
        // before reporting a save failure to the row.
        if (errorCode(error) !== 'account-preferences-conflict') {
          await this.failWrite(generation, error)
          return
        }
        if (generation === this.generation) this.pendingRevision = undefined
        await this.mirror.load()
        if (this.disposed || generation !== this.generation) return
        try {
          await attempt()
        } catch (retryError: unknown) {
          await this.failWrite(generation, retryError)
        }
      }
    })
  }

  /**
   * Recover the mirror after a rejected write and publish the error state.
   * @param generation - the write generation that failed; superseded failures publish nothing.
   * @param error - the transport rejection being reported.
   */
  private async failWrite(generation: number, error: unknown): Promise<void> {
    // A failed latest write invalidates the response fence retained for a
    // predecessor; the recovery read below supplies the only current
    // revision. Keeping that predecessor would make the next edit send a
    // stale expectedRevision after recovery.
    if (generation === this.generation) this.pendingRevision = undefined
    await this.mirror.load()
    if (this.disposed || generation !== this.generation) return
    this.setWrite({ status: 'error', code: errorCode(error), message: messageOf(error) })
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    if (this.transport === undefined || this.disposed) return Promise.resolve()
    const task = this.tail.then(operation, operation)
    /* v8 ignore next -- the operation handles expected transport failures; this tail guard is a final containment fence. */
    this.tail = task.catch(() => {})
    return task
  }

  private derive(): void {
    /* v8 ignore next -- mirror listeners are removed before a disposed scope can derive. */
    if (this.disposed) return
    const mirror = this.mirror.getSnapshot()
    const view = this.mirror.namespace(this.spec.namespace)
    if (view === undefined) {
      this.store.update((state) => {
        state.status = mirror.status === 'loading' || mirror.status === 'idle' ? 'loading' : 'unavailable'
        state.writable = false
        state.writableReason = mirror.unsupported ? 'account' : undefined
        state.owner = 'account'
      })
      return
    }
    const decoded = this.decode(view.value)
    this.store.update((state) => {
      state.status = decoded === undefined ? 'unavailable' : 'ready'
      state.value = decoded
      state.base = view.base
      state.user = view.user
      state.revision = view.revision
      state.writable = true
      state.writableReason = undefined
      state.owner = 'account'
      state.mode = 'account'
    })
  }

  private decode(value: unknown): T | undefined {
    if (this.spec.decode !== undefined) return this.spec.decode(value)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as T : undefined
  }

  private setWrite(write: SettingsWriteState): void {
    /* v8 ignore next -- disposal returns before a queued write can publish state. */
    if (!this.disposed) this.store.update((state) => { state.write = write })
  }
}

/**
 * Fields the account preference endpoint accepts per namespace — the routing
 * table of {@link AccountOrHostSettingsScopeController}. Mirrors the wire
 * union on `AccountPreferenceMutation['field']`; client bundle purity forbids
 * sharing the value across plugins.
 */
const ACCOUNT_FIELDS: Record<string, readonly string[]> = {
  locale: ['preference'],
  'ui-theme': ['preference'],
  'ui-conversation': ['busyEnter', 'chatContentWidth', 'chatFullWidth', 'chatFontSize'],
}

/**
 * A source that starts with account storage and falls back only on 404/501.
 * The account endpoint accepts a fixed field whitelist per namespace; fields
 * outside it keep reading and writing Host settings while the account layer
 * stays authoritative for the whitelisted remainder.
 */
export class AccountOrHostSettingsScopeController<T> implements SettingsScope<T> {
  private readonly store: SnapshotStore<SettingsScopeSnapshot<T>>
  private readonly account: AccountSettingsScopeController<T>
  private readonly accountFields: readonly string[]
  private active: SettingsScope<T>
  private accountStop: (() => void) | undefined
  private readonly hostStop: () => void
  private disposed = false

  constructor(
    account: AccountSettingsScopeController<T>,
    private readonly host: SettingsScope<T>,
    private readonly mirror: AccountPreferencesMirror,
    namespace: string,
  ) {
    this.account = account
    this.active = account
    this.accountFields = ACCOUNT_FIELDS[namespace] ?? []
    this.store = createSnapshotStore(this.mergedSnapshot())
    this.accountStop = account.subscribe(() => {
      if (this.mirror.getSnapshot().unsupported) {
        this.switchToHost()
        return
      }
      this.publish()
    })
    // Fields the account endpoint does not own read and write through the Host
    // scope even while the account layer is active, so the Host subscription
    // stays installed rather than arriving with a fallback switch.
    this.hostStop = host.subscribe(() => { this.publish() })
    void this.mirror.ensure().then(() => {
      if (!this.disposed && this.mirror.getSnapshot().unsupported) this.switchToHost()
    })
  }

  /* jscpd:ignore-start -- parallel SettingsScope implementations share the
   * getSnapshot/subscribe/set/unset face by contract while their routing and
   * publication differ. */
  /** @returns the merged or fallback source snapshot. */
  getSnapshot(): SettingsScopeSnapshot<T> { return this.store.getSnapshot() }

  /** @param listener - called after snapshot changes. @returns disposer. */
  subscribe(listener: () => void): () => void { return this.store.subscribe(listener) }

  /** Write through the source owning the field. */
  set(field: string, value: unknown): Promise<void> { return this.route(field).set(field, value) }

  /** Clear through the source owning the field. */
  unset(field: string): Promise<void> { return this.route(field).unset(field) }
  /* jscpd:ignore-end */

  /** Dispose both source scopes. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.accountStop?.()
    this.hostStop()
    await Promise.all([
      disposeScope(this.account),
      disposeScope(this.host),
    ])
  }

  private route(field: string): SettingsScope<T> {
    return this.accountFields.includes(field) ? this.active : this.host
  }

  private switchToHost(): void {
    if (this.active === this.host || this.disposed) return
    this.active = this.host
    this.accountStop?.()
    this.accountStop = undefined
    this.publish()
  }

  private publish(): void {
    /* v8 ignore next -- the composite detaches its listeners during disposal. */
    if (this.disposed) return
    this.store.set(this.active === this.account ? this.mergedSnapshot() : this.host.getSnapshot())
  }

  /**
   * Publish the account snapshot with the layers it does not own refilled
   * from Host storage and the more urgent of the two write states.
   */
  private mergedSnapshot(): SettingsScopeSnapshot<T> {
    const account = this.account.getSnapshot()
    const host = this.host.getSnapshot()
    return {
      ...account,
      value: mergeSectionLayer(host.value, account.value, this.accountFields) as T | undefined,
      base: mergeSectionLayer(host.base, account.base, this.accountFields),
      user: mergeSectionLayer(host.user, account.user, this.accountFields),
      write: mergeWrite(account.write, host.write),
    }
  }
}

/** Overlay the account-owned fields of one section layer onto Host storage. */
function mergeSectionLayer(host: unknown, account: unknown, fields: readonly string[]): unknown {
  if (!isRecord(host) || !isRecord(account)) return account
  const merged: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(host)) {
    if (!fields.includes(key)) merged[key] = value
  }
  for (const field of fields) {
    if (field in account) merged[field] = account[field]
  }
  return merged
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Surface the more urgent of the two source write states to the row. */
function mergeWrite(account: SettingsWriteState, host: SettingsWriteState): SettingsWriteState {
  const rank = { idle: 0, saving: 1, blocked: 2, error: 3 } as const
  return rank[host.status] > rank[account.status] ? host : account
}

async function disposeScope(scope: SettingsScope<unknown>): Promise<void> {
  const candidate = scope as SettingsScope<unknown> & { dispose?: () => void | Promise<void> }
  await candidate.dispose?.()
}

function isUnsupported(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error
    && ((error as AccountPreferencesRequestError).status === 404
      || (error as AccountPreferencesRequestError).status === 501)
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'transport'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
