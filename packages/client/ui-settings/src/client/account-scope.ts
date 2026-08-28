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
        : { busyEnter: 'queue' }
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
      const revision = this.pendingRevision ?? this.getSnapshot().revision
      const mutation: AccountPreferenceMutation = {
        namespace: this.spec.namespace as AccountPreferenceMutation['namespace'],
        field: input.field as AccountPreferenceMutation['field'],
        operation: input.operation,
        ...(input.operation === 'set' ? { value: String(input.value) } : {}),
        /* v8 ignore next -- a ready account namespace always carries the mirror revision. */
        ...(revision === undefined ? {} : { expectedRevision: revision }),
      }
      try {
        const transport = this.transport
        /* v8 ignore next -- enqueue returns immediately when transport is absent. */
        if (transport === undefined) return
        const view = await transport.mutate(mutation)
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
      } catch (error: unknown) {
        // A failed latest write invalidates the response fence retained for a
        // predecessor; the recovery read below supplies the only current
        // revision. Keeping that predecessor would make the next edit send a
        // stale expectedRevision after recovery.
        if (generation === this.generation) this.pendingRevision = undefined
        await this.mirror.load()
        if (this.disposed || generation !== this.generation) return
        this.setWrite({ status: 'error', code: errorCode(error), message: messageOf(error) })
      }
    })
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

/** A source that starts with account storage and falls back only on 404/501. */
export class AccountOrHostSettingsScopeController<T> implements SettingsScope<T> {
  private readonly store: SnapshotStore<SettingsScopeSnapshot<T>>
  private readonly account: AccountSettingsScopeController<T>
  private active: SettingsScope<T>
  private accountStop: (() => void) | undefined
  private hostStop: (() => void) | undefined
  private disposed = false

  constructor(
    account: AccountSettingsScopeController<T>,
    private readonly host: SettingsScope<T>,
    private readonly mirror: AccountPreferencesMirror,
  ) {
    this.account = account
    this.active = account
    this.store = createSnapshotStore(account.getSnapshot())
    this.accountStop = account.subscribe(() => {
      const state = account.getSnapshot()
      if (this.mirror.getSnapshot().unsupported) {
        this.switchToHost()
        return
      }
      this.publish(state)
    })
    void this.mirror.ensure().then(() => {
      if (!this.disposed && this.mirror.getSnapshot().unsupported) this.switchToHost()
    })
  }

  /** @returns the active source snapshot. */
  getSnapshot(): SettingsScopeSnapshot<T> { return this.store.getSnapshot() }

  /** @param listener - called after active-source changes. @returns disposer. */
  subscribe(listener: () => void): () => void { return this.store.subscribe(listener) }

  /** Write through the currently authoritative source. */
  set(field: string, value: unknown): Promise<void> { return this.active.set(field, value) }

  /** Clear through the currently authoritative source. */
  unset(field: string): Promise<void> { return this.active.unset(field) }

  /** Dispose both source scopes. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.accountStop?.()
    this.hostStop?.()
    await Promise.all([
      disposeScope(this.account),
      disposeScope(this.host),
    ])
  }

  private switchToHost(): void {
    if (this.active === this.host || this.disposed) return
    this.active = this.host
    this.accountStop?.()
    this.accountStop = undefined
    this.hostStop = this.host.subscribe(() => { this.publish(this.host.getSnapshot()) })
    this.publish(this.host.getSnapshot())
  }

  private publish(snapshot: SettingsScopeSnapshot<T>): void {
    /* v8 ignore next -- the composite detaches its host listener during disposal. */
    if (!this.disposed) this.store.set(snapshot)
  }
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
