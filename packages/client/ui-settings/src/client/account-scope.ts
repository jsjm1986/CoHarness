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
  private readonly lifetime = new AbortController()
  private readSlot: { controller: AbortController; promise: Promise<void> } | undefined
  /** Reads remain owned through transport settlement, even after losing the slot. */
  private readonly pendingReads = new Set<Promise<void>>()

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

  /** Load account preferences once, coalescing current readers.
   * @returns readiness without waiting for a read retired by an accepted view.
   */
  ensure(): Promise<void> {
    if (this.transport === undefined || this.lifetime.signal.aborted) return Promise.resolve()
    if (this.readSlot !== undefined) return this.readSlot.promise
    if (this.store.getSnapshot().status === 'ready') return Promise.resolve()
    return this.load()
  }

  /**
   * Refresh account preferences, preserving the last good answer on failure.
   * A force refresh invalidates the pending read: a caller that needs a
   * post-mutation answer must not join a request issued before that mutation.
   * @param force - supersede and abort any in-flight read instead of joining it.
   * @returns settlement of the current or newly owned read.
   */
  load(force = false): Promise<void> {
    const transport = this.transport
    if (transport === undefined || this.lifetime.signal.aborted) return Promise.resolve()
    const current = this.readSlot
    if (current !== undefined && !force) return current.promise
    const controller = new AbortController()
    const promise = Promise.resolve().then(() => this.read(controller, transport)).finally(() => {
      this.pendingReads.delete(promise)
    })
    // Publication eligibility and settlement ownership precede deferred wire admission.
    this.readSlot = { controller, promise }
    this.pendingReads.add(promise)
    current?.controller.abort()
    return promise
  }

  /** Fold an equal or newer successful mutation response and retire the current read.
   * @param view - validated account preference response.
   */
  accept(view: AccountPreferencesView): void {
    if (this.lifetime.signal.aborted) return
    const held = this.store.getSnapshot().view
    if (held !== undefined && view.revision < held.revision) return
    const current = this.readSlot
    this.readSlot = undefined
    this.store.set({ status: 'ready', view, error: null, unsupported: false })
    current?.controller.abort()
  }

  /** Stop publication and wait for every retained read, including on repeated calls.
   * @returns settlement after all owned transports settle, even when they ignore abort.
   */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    const slot = this.readSlot
    this.readSlot = undefined
    slot?.controller.abort()
    await Promise.allSettled([...this.pendingReads])
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

  private async read(controller: AbortController, transport: AccountPreferencesTransport): Promise<void> {
    const owns = (): boolean =>
      this.readSlot?.controller === controller
      && !controller.signal.aborted
      && !this.lifetime.signal.aborted
    try {
      if (!owns()) return
      this.store.update((state) => {
        state.status = 'loading'
        state.error = null
        state.unsupported = false
      })
      if (!owns()) return
      const view = await transport.describe(controller.signal)
      if (!owns()) return
      const held = this.store.getSnapshot().view
      this.store.set({
        status: 'ready',
        view: held !== undefined && view.revision < held.revision ? held : view,
        error: null,
        unsupported: false,
      })
    } catch (error: unknown) {
      if (!owns()) return
      const unsupported = isUnsupported(error)
      const held = this.store.getSnapshot().view
      this.store.set({
        status: held === undefined ? 'unavailable' : 'ready',
        view: held,
        error: error instanceof Error ? error.message : String(error),
        unsupported,
      })
    } finally {
      if (this.readSlot?.controller === controller) this.readSlot = undefined
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
        await this.mirror.load(true)
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
    await this.mirror.load(true)
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
  private accountStop: (() => void) | undefined
  private readonly hostStop: () => void
  private disposed = false
  /** Per-source sequence of the latest write-state replacement, for merging by recency. */
  private writeRecency = { account: { state: { status: 'idle' } as SettingsWriteState, seq: 0 }, host: { state: { status: 'idle' } as SettingsWriteState, seq: 0 }, next: 0 }

  constructor(
    account: AccountSettingsScopeController<T>,
    private readonly host: SettingsScope<T>,
    private readonly mirror: AccountPreferencesMirror,
    namespace: string,
  ) {
    this.account = account
    this.accountFields = ACCOUNT_FIELDS[namespace] ?? []
    this.store = createSnapshotStore(this.mergedSnapshot())
    this.accountStop = account.subscribe(() => { this.publish() })
    // Fields the account endpoint does not own read and write through the Host
    // scope even while the account layer is active, so the Host subscription
    // stays installed rather than arriving with a fallback switch.
    this.hostStop = host.subscribe(() => { this.publish() })
    void this.mirror.ensure().then(() => { this.publish() })
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

  /**
   * The authoritative source for account-owned fields: Host while the mirror
   * marks the endpoint unsupported, the account scope otherwise. Deriving it
   * per publication lets a recovered endpoint resume account persistence
   * instead of pinning the session to the first transient failure.
   */
  private get active(): SettingsScope<T> {
    return this.mirror.getSnapshot().unsupported ? this.host : this.account
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
      write: this.mergedWrite(account.write, host.write),
    }
  }

  /**
   * Publish the write state most recently replaced on either source. Recency
   * lets a later write clear an earlier terminal error instead of pinning
   * the worst state forever on the merged row.
   */
  private mergedWrite(account: SettingsWriteState, host: SettingsWriteState): SettingsWriteState {
    const recency = this.writeRecency
    if (!Object.is(account, recency.account.state)) recency.account = { state: account, seq: ++recency.next }
    if (!Object.is(host, recency.host.state)) recency.host = { state: host, seq: ++recency.next }
    return recency.host.seq > recency.account.seq ? recency.host.state : recency.account.state
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
