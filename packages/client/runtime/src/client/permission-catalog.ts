import type { PermissionCatalog } from '@deepseek-ai/dsh-permission-presets/client'
import type {
  ConnectionHandle,
  HostDescription,
  HostDescriptionSource,
  SessionId,
} from '@deepseek-ai/dsh-client-connection/client'
import type { ObservableSnapshot } from './contract/store.ts'

/** The catalog endpoint's settle shape; Remote and raw channel results both qualify. */
type CatalogResult =
  | { readonly ok: true; readonly value: PermissionCatalog }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/**
 * One runtime connection's permission preset catalog. Reactive consumers
 * subscribe (the first subscriber kicks the lazy pull); imperative flows call
 * {@link read}, which awaits an in-flight refresh rather than serving a
 * superseded value. Every pull stamps an epoch, so a response that predates
 * the latest invalidation is discarded instead of installed. The host's
 * `permission-presets/catalog-changed` forward repulls in place through
 * {@link invalidate}; the owning connection's generation boundary — observed
 * as a `hostDescription` retraction or replacement — clears first because the
 * new generation may be a different host whose catalog is unrelated.
 */
export class PermissionCatalogMirror implements ObservableSnapshot<PermissionCatalog | undefined> {
  private value: PermissionCatalog | undefined
  private epoch = 0
  private pending: Promise<void> | undefined
  private failure: Error = new Error('permission catalog has no complete value')
  private readonly listeners = new Set<() => void>()
  private readonly invalidationListeners = new Set<() => void>()
  private disposed = false
  private lastDescription: HostDescription | undefined
  private readonly stopGeneration: () => void

  /**
   * @param catalog - one catalog transport over the owning connection's `/api` channel.
   *   A host composition without the namespace fails like an absent capability: the
   *   reactive mirror stays undefined and {@link read} rejects.
   * @param hostDescription - owning connection's description source; each identity
   *   change is a generation boundary that withdraws the previous host's catalog.
   */
  constructor(
    private readonly catalog: () => Promise<CatalogResult>,
    hostDescription: HostDescriptionSource,
  ) {
    this.lastDescription = hostDescription.getSnapshot()
    this.stopGeneration = hostDescription.subscribe(() => {
      this.syncGeneration(hostDescription.getSnapshot())
    })
  }

  /** Last installed catalog; undefined until the first successful pull. */
  getSnapshot: () => PermissionCatalog | undefined = () => this.value

  /**
   * Subscribe to catalog publications. The first subscriber kicks the lazy
   * pull; subscribing to a failed mirror retries the read.
   * @param listener - notified once per newly installed catalog value.
   * @returns unsubscribe disposer.
   */
  subscribe: (listener: () => void) => (() => void) = (listener) => {
    this.listeners.add(listener)
    if (this.value === undefined && this.pending === undefined) this.pull()
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Subscribe to invalidations rather than values. One tick per catalog
   * notification or generation boundary, published before the replacement
   * read settles; consumers holding displayed options drop them here.
   * @param listener - notified once per invalidation.
   * @returns unsubscribe disposer.
   */
  subscribeInvalidations: (listener: () => void) => (() => void) = (listener) => {
    this.invalidationListeners.add(listener)
    return () => { this.invalidationListeners.delete(listener) }
  }

  /**
   * Imperative read for settings and picker flows. A read never resolves with
   * a superseded response: it shares the in-flight pull, and an invalidation
   * raised while it waits makes it settle on the replacement instead.
   * @returns the current generation's catalog.
   * @throws the last read failure when no catalog is installed.
   */
  async read(): Promise<PermissionCatalog> {
    if (this.pending === undefined && this.value === undefined) this.pull()
    while (!this.disposed) {
      const pending = this.pending
      if (pending !== undefined) {
        await pending
        continue
      }
      if (this.value !== undefined) return this.value
      throw this.failure
    }
    throw new Error('permission catalog mirror is disposed')
  }

  /**
   * Repull after a host-side catalog change on this mirror's connection. The
   * last value keeps serving until the fresh one lands; any in-flight
   * response predating this call is discarded instead of installed.
   */
  invalidate(): void {
    if (this.disposed) return
    this.notifyInvalidations()
    this.pull()
  }

  /** Scope teardown: late settlements lose write access to the mirror. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    ++this.epoch
    this.pending = undefined
    this.stopGeneration()
    this.listeners.clear()
    this.invalidationListeners.clear()
  }

  /**
   * A `hostDescription` republish marks a connection generation boundary —
   * retraction while reconnecting, replacement on each handshake. The
   * previous host's catalog is untrusted, so the mirror clears before
   * repulling once a new generation describes itself.
   */
  private syncGeneration(description: HostDescription | undefined): void {
    if (this.disposed || Object.is(description, this.lastDescription)) return
    this.lastDescription = description
    this.notifyInvalidations()
    ++this.epoch
    this.pending = undefined
    this.failure = new Error('permission catalog has no complete value')
    this.install(undefined)
    if (description !== undefined) this.pull()
  }

  private pull(): void {
    if (this.disposed) return
    const epoch = ++this.epoch
    this.failure = new Error('permission catalog has no complete value')
    // The transport call itself stays synchronous so a same-tick invalidation
    // observes the in-flight operation instead of double-fetching.
    let result: Promise<CatalogResult>
    try {
      result = Promise.resolve(this.catalog())
    } catch (error) {
      result = Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
    const operation = result
      .then((settled) => {
        if (this.disposed || epoch !== this.epoch) return
        if (!settled.ok) {
          // A refused read withdraws the last catalog: serving it after the
          // host denied the refresh would keep revoked options selectable.
          this.failure = new Error(`permission catalog read failed: ${settled.error.code}: ${settled.error.message}`)
          this.install(undefined)
          return
        }
        this.install(settled.value)
      }, (error: unknown) => {
        if (this.disposed || epoch !== this.epoch) return
        this.failure = error instanceof Error ? error : new Error(String(error))
        this.install(undefined)
      })
      .finally(() => { if (this.pending === operation) this.pending = undefined })
    this.pending = operation
  }

  private install(value: PermissionCatalog | undefined): void {
    if (this.value === value) return
    this.value = value
    for (const listener of [...this.listeners]) listener()
  }

  private notifyInvalidations(): void {
    for (const listener of [...this.invalidationListeners]) listener()
  }
}

/**
 * One Session's catalog face: value snapshot, invalidation ticks, and the
 * imperative read all resolve through the runtime that currently owns the
 * Session. The face rebinds when session ownership republishes, so a Session
 * indexed after its consumers subscribed still lands on its own runtime's
 * catalog; a move withdraws the previous runtime's options through the
 * invalidation channel.
 */
export interface SessionPermissionCatalog extends ObservableSnapshot<PermissionCatalog | undefined> {
  /**
   * Subscribe to invalidations of the owning runtime's catalog.
   * @param listener - notified once per invalidation, before the refresh settles.
   * @returns unsubscribe disposer.
   */
  subscribeInvalidations(listener: () => void): () => void
  /**
   * Read the owning runtime's current catalog, awaiting an in-flight refresh.
   * @returns the current generation's catalog.
   */
  read(): Promise<PermissionCatalog>
}

/**
 * Session-scoped delegation over the directory's per-connection mirrors. The
 * face attaches to the resolved mirror only while it has listeners, so an
 * idle face neither pulls nor holds subscriptions.
 */
class SessionCatalogFace implements SessionPermissionCatalog {
  private mirror: PermissionCatalogMirror | undefined
  private unsubscribeMirror: (() => void) | undefined
  private unsubscribeMirrorInvalidations: (() => void) | undefined
  private stopOwnership: (() => void) | undefined
  private readonly listeners = new Set<() => void>()
  private readonly invalidationListeners = new Set<() => void>()

  constructor(
    private readonly directory: PermissionCatalogDirectory,
    private readonly sessionId: SessionId | undefined,
  ) {}

  getSnapshot: () => PermissionCatalog | undefined = () =>
    this.directory.mirrorFor(this.sessionId).getSnapshot()

  subscribe: (listener: () => void) => (() => void) = (listener) => {
    this.listeners.add(listener)
    this.attach()
    if (this.unsubscribeMirror === undefined && this.mirror !== undefined) {
      const mirror = this.mirror
      this.unsubscribeMirror = mirror.subscribe(() => {
        for (const current of [...this.listeners]) current()
      })
    }
    return () => { this.listeners.delete(listener); this.release() }
  }

  subscribeInvalidations: (listener: () => void) => (() => void) = (listener) => {
    this.invalidationListeners.add(listener)
    this.attach()
    if (this.unsubscribeMirrorInvalidations === undefined && this.mirror !== undefined) {
      const mirror = this.mirror
      this.unsubscribeMirrorInvalidations = mirror.subscribeInvalidations(() => {
        for (const current of [...this.invalidationListeners]) current()
      })
    }
    return () => { this.invalidationListeners.delete(listener); this.release() }
  }

  read(): Promise<PermissionCatalog> {
    return this.directory.mirrorFor(this.sessionId).read()
  }

  private attach(): void {
    if (this.stopOwnership !== undefined) return
    this.stopOwnership = this.directory.ownership.subscribe(() => { this.rebind() })
    this.rebind()
  }

  private release(): void {
    if (this.listeners.size !== 0 || this.invalidationListeners.size !== 0) return
    this.stopOwnership?.()
    this.stopOwnership = undefined
    this.unsubscribeMirror?.()
    this.unsubscribeMirror = undefined
    this.unsubscribeMirrorInvalidations?.()
    this.unsubscribeMirrorInvalidations = undefined
    this.mirror = undefined
    this.directory.releaseFace(this.sessionId, this)
  }

  private rebind(): void {
    const previous = this.mirror?.getSnapshot()
    const next = this.directory.mirrorFor(this.sessionId)
    if (next === this.mirror) return
    const moved = this.mirror !== undefined
    this.unsubscribeMirror?.()
    this.unsubscribeMirrorInvalidations?.()
    this.mirror = next
    this.unsubscribeMirror = this.listeners.size === 0
      ? undefined
      : next.subscribe(() => { for (const current of [...this.listeners]) current() })
    this.unsubscribeMirrorInvalidations = this.invalidationListeners.size === 0
      ? undefined
      : next.subscribeInvalidations(() => { for (const current of [...this.invalidationListeners]) current() })
    // Ownership moved runtimes: the displayed options belong to the previous
    // runtime's catalog, so withdraw them even though no host notified.
    if (moved) for (const current of [...this.invalidationListeners]) current()
    // A different mirror can already hold a different catalog; value
    // subscribers' snapshots changed under them without a host publish.
    if (moved && next.getSnapshot() !== previous) {
      for (const current of [...this.listeners]) current()
    }
  }
}

/**
 * One catalog mirror per pooled runtime connection. `forSession` resolves
 * the Session's owning transport through `connection.forSession`, so a
 * project runtime's picker reads that runtime's host rather than the root
 * connection's. `catalog-changed` forwards arrive per connection; the
 * dispatching sink attributes them through {@link invalidateFor} instead of
 * repulling every runtime's mirror.
 */
export class PermissionCatalogDirectory {
  /** Session-list publications re-key session→runtime ownership; faces rebind on each. */
  readonly ownership: ObservableSnapshot<unknown>
  private readonly mirrors = new Map<ConnectionHandle, PermissionCatalogMirror>()
  private readonly faces = new Map<SessionId | '', SessionCatalogFace>()
  private disposed = false
  private deadMirror: PermissionCatalogMirror | undefined

  /**
   * @param connection - root connection handle; `forSession` carries the
   *   session→runtime resolver the pool registers.
   * @param ownership - session-list publication that re-keys session→runtime ownership.
   */
  constructor(
    private readonly connection: ConnectionHandle,
    ownership: ObservableSnapshot<unknown>,
  ) {
    this.ownership = ownership
  }

  /**
   * The catalog face for one Session. Base-owned and unresolved ids ride the
   * root connection's mirror; pooled ids ride their runtime's.
   * @param id - Session identity, or undefined for the session-less surface.
   * @returns the session-scoped catalog face; stable per Session id.
   */
  forSession(id: SessionId | undefined): SessionPermissionCatalog {
    const key = id ?? ''
    let face = this.faces.get(key)
    if (face === undefined) {
      face = new SessionCatalogFace(this, id)
      this.faces.set(key, face)
    }
    return face
  }

  /**
   * Invalidate only the mirror of the connection that delivered a
   * `permission-presets/catalog-changed` forward; absent mirrors have no
   * cached value to withdraw.
   * @param connection - the connection whose host reported a catalog change.
   */
  invalidateFor(connection: ConnectionHandle): void {
    this.mirrors.get(connection)?.invalidate()
  }

  /** Scope teardown: every mirror loses its subscriptions and write access. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const mirror of this.mirrors.values()) mirror.dispose()
    this.mirrors.clear()
    this.faces.clear()
  }

  /**
   * Resolve the mirror keyed by the Session's owning connection; creates it
   * lazily. A stopped connection's replacement handle maps to a fresh mirror.
   * After disposal every lookup shares one inert mirror: subscriptions attach
   * but it never pulls, so a late subscriber cannot resurrect catalog traffic
   * on a dead connection.
   * @param id - Session identity, or undefined for the root connection.
   * @returns the owning runtime's catalog mirror.
   */
  mirrorFor(id: SessionId | undefined): PermissionCatalogMirror {
    if (this.disposed) {
      this.deadMirror ??= (() => {
        const mirror = new PermissionCatalogMirror(
          () => Promise.reject(new Error('permission catalog directory is disposed')),
          this.connection.hostDescription,
        )
        mirror.dispose()
        return mirror
      })()
      return this.deadMirror
    }
    const handle = (id === undefined ? undefined : this.connection.forSession?.(id)) ?? this.connection
    let mirror = this.mirrors.get(handle)
    if (mirror === undefined) {
      const catalog = async (): Promise<CatalogResult> => {
        const result = await handle.rpc.call('/api', 'permissionPresets/catalog', { args: {} })
        return result.ok
          ? { ok: true, value: result.value as PermissionCatalog }
          : { ok: false, error: result.error }
      }
      mirror = new PermissionCatalogMirror(catalog, handle.hostDescription)
      this.mirrors.set(handle, mirror)
    }
    return mirror
  }

  /**
   * Face teardown hook: a listener-less face leaves the session map so closed
   * Sessions do not accumulate directory entries.
   * @param id - Session identity the face served.
   * @param face - the released face; stale-map guards keep a rebound face live.
   */
  releaseFace(id: SessionId | undefined, face: SessionCatalogFace): void {
    if (this.faces.get(id ?? '') === face) this.faces.delete(id ?? '')
  }
}
