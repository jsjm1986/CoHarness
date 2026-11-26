/** Page-owned Loader entries; transport-independent reconciliation, retries and code replacement. */
import type { FiberState } from '@deepseek-ai/cordis'
import type { Entry, Loader } from '@deepseek-ai/cordis-plugin-loader'
import { atRevision, parseBootManifest, readRelease } from './manifest.ts'
import type { BootManifest, BootModuleRow, ClientModuleLoader } from './manifest.ts'
import { removeOwnedStyles, tearDownEntryFiber } from './entry-lifecycle.ts'
import { ReleaseChangeGate, type ClientReleaseChange } from './release-change.ts'
import { notifySubscribers } from './notify.ts'

/** Page-local failures do not change the Host's bundle enablement. */
export interface ClientEntryState {
  /** True while a snapshot, retry or code replacement is being applied. */
  readonly syncing: boolean
  /** Package ids and errors from the latest reconciliation. */
  readonly failures: readonly { readonly id: string; readonly message: string }[]
}

/** Module-table capabilities used within serialized entry operations. */
interface ModuleIndex {
  update(manifest: BootManifest, managed: Iterable<string>): void
  invalidateForReplacement(id: string, rev: string): void
  prune(roots: Iterable<string>): void
}

/** Numeric values mirror Cordis's const enum, which bundle loaders cannot import as a runtime object. */
const ACTIVE = 2 as FiberState.ACTIVE
const FAILED = 3 as FiberState.FAILED
const OPTIONAL_ARRIVAL_TIMEOUT_MS = 30_000

/** Revisions and requests identify desired code; URLs only select its immutable delivery resource. */
function entryTargets(manifest: BootManifest): string {
  return JSON.stringify(manifest.modules.map(row => [row.id, row.rev, row.inject, row.external, row.optional]))
}

/** Manages only entries created from the Host manifest; other Loader contributors retain ownership. */
export class ClientEntries {
  /** Stable observable consumed by page diagnostics through the renderer's injected hook. */
  readonly state: {
    readonly getSnapshot: () => ClientEntryState
    readonly subscribe: (listener: () => void) => () => void
  } = {
    getSnapshot: () => this.snapshot,
    subscribe: (listener: () => void) => {
      this.listeners.add(listener)
      return () => { this.listeners.delete(listener) }
    },
  }
  // The modules bootstrap factory cannot request platform libraries before the shell supplies its seed.
  private snapshot: ClientEntryState = { syncing: false, failures: [] }
  private readonly listeners = new Set<() => void>()
  /** Admits only Host graphs of the page's boot release. */
  private readonly release: ReleaseChangeGate
  private readonly managed = new Map<string, Entry>()
  private readonly revisions = new Map<string, string>()
  private loader: Loader | undefined
  private queue: Promise<void> = Promise.resolve()
  private desired: BootManifest
  private generation = 0
  private optionalLifetime = new AbortController()
  private readonly optionalLoads = new Map<string, Promise<void>>()
  private stopped = false
  private optionalStarted = false

  /**
   * Construct the page controller before Cordis boot.
   * @param modules - Module arrival and materialization owner.
   * @param index - Private descriptor replacement and unused-module cleanup.
   */
  constructor(private readonly modules: ClientModuleLoader, private readonly index: ModuleIndex) {
    this.desired = modules.manifest
    this.release = new ReleaseChangeGate(modules.manifest.release)
  }

  /** Host release change to announce; undefined while the Host serves the page's boot release or a dismissed one. */
  get releaseChange(): {
    readonly getSnapshot: () => ClientReleaseChange | undefined
    readonly subscribe: (listener: () => void) => () => void
  } {
    return this.release.change
  }

  /** Stop announcing the connected Host's release; updates stay paused until the Host returns to the boot release or the page reloads. */
  dismissRelease(): void {
    this.release.dismiss()
  }

  /**
   * Create the required roster and retain its entry identities for subsequent reconciliation.
   * @param loader - Page Loader, already configured with the module system.
   * @param manifest - Initial roster audited by the boot caller.
   * @returns after required entries and their activation settle; boot owns its activation audit.
   */
  start(loader: Loader, manifest: BootManifest): Promise<void> {
    if (this.loader !== undefined) throw new Error('client-modules: entries already started')
    this.loader = loader
    this.desired = manifest
    loader.ctx.effect(() => () => {
      this.stopped = true
      this.optionalLifetime.abort()
      return this.queue
    }, 'client-modules: entry reconciliation')
    return this.enqueue(async () => {
      await Promise.all(this.desired.plugins.filter(row => row.optional !== true).map(async ({ id }) => {
        await this.create(loader, id)
      }))
      await loader.await()
      for (const row of this.modules.manifest.modules) this.revisions.set(row.id, row.rev)
    })
  }

  /**
   * Release optional entries after application mount. Failed entries remain in page diagnostics and can be retried.
   * @returns after the released operations settle, including any per-entry failure reporting.
   */
  startOptional(): Promise<void> {
    if (this.optionalStarted || this.stopped) return this.queue.then(() => this.awaitOptional())
    this.optionalStarted = true
    if (!this.desired.plugins.some(row => row.optional === true)) return this.queue
    return this.enqueue(() => this.reconcile(this.generation)).then(() => this.awaitOptional())
  }

  /**
   * Validate and apply the latest full Host graph. Changed targets cancel obsolete mounts; identical targets share pending loads.
   * The release is compared before the rest of the graph is validated: a graph of another release, including one whose
   * format this page cannot read, is not applied and {@link releaseChange} announces it.
   * @param graph - JSON-decoded graph received from the Host.
   * @returns after required reconciliation and dispatch of optional loads, or at once for another release.
   */
  sync(graph: unknown): Promise<void> {
    if (!this.release.observe(readRelease(graph))) return Promise.resolve()
    const manifest = parseBootManifest(graph)
    if (entryTargets(manifest) !== entryTargets(this.desired)) this.advanceGeneration()
    this.desired = manifest
    const generation = this.generation
    return this.enqueue(() => this.reconcile(generation))
  }

  /**
   * Retry failed entries against the latest graph, including an unchanged revision.
   * @returns after retry settlement, with remaining errors in {@link state}.
   */
  retry(): Promise<void> {
    const generation = this.advanceGeneration()
    return this.enqueue(() => this.reconcile(generation)).then(() => this.awaitOptional())
  }

  /**
   * Replace one entry's code in the same queue as graph updates; duplicate revisions are ignored.
   * Ignored while the connected Host serves another release than the page's boot release.
   * Entries missing after a failed import are reconciled; bootstrap replacement fails before teardown.
   * @param id - Package id from a rebuilt frame.
   * @param rev - Opaque revision selecting the rebuilt artifact.
   * @returns after queued work; replacement errors reject, while per-package reconciliation errors remain in {@link state}.
   */
  reload(id: string, rev: string): Promise<void> {
    if (!this.release.matches) return Promise.resolve()
    const previous = this.desired.modules.find(row => row.id === id)
    this.desired = {
      ...this.desired,
      modules: this.desired.modules.map((row) => {
        if (row.id !== id || row.rev === rev) return row
        const { chunks: _chunks, ...owner } = row
        return { ...owner, rev, url: atRevision(owner.url, rev) }
      }),
    }
    if (previous?.optional === true) {
      if (previous.rev === rev) return this.queue
      const generation = this.advanceGeneration()
      return this.enqueue(() => this.reconcile(generation))
    }
    return this.enqueue(async () => {
      const desired = this.desired.modules.find(row => row.id === id)
      if (this.stopped || desired === undefined) return
      const entry = this.managed.get(id)
      if (entry === undefined) {
        this.modules.invalidate(id, desired.rev)
        removeOwnedStyles(id)
        await this.reconcile(this.generation)
        return
      }
      if (this.revisions.get(id) === rev) return
      this.publish({ syncing: true, failures: this.snapshot.failures.filter(failure => failure.id !== id) })
      await this.replace(entry, id, rev, this.generation)
      this.publish({ syncing: false, failures: this.snapshot.failures })
    }, id)
  }

  private publish(snapshot: ClientEntryState): void {
    this.snapshot = snapshot
    notifySubscribers(this.listeners, 'synchronization')
  }

  private enqueue(task: () => Promise<void>, subject = 'graph'): Promise<void> {
    const run = this.queue.then(task)
    // Each operation reports its own failure; later operations must still run.
    this.queue = run.then(() => undefined, (error: unknown) => {
      this.publish({ syncing: false, failures: [
        ...this.snapshot.failures.filter(failure => failure.id !== subject),
        { id: subject, message: String(error) },
      ] })
    })
    return run
  }

  private current(generation: number): boolean {
    return !this.stopped && generation === this.generation
  }

  private advanceGeneration(): number {
    this.optionalLifetime.abort()
    this.optionalLifetime = new AbortController()
    this.optionalLoads.clear()
    return ++this.generation
  }

  private async awaitOptional(): Promise<void> {
    if (!this.stopped) await Promise.all(this.optionalLoads.values())
  }

  /** Keep ownership even when Loader rejects a module's plugin exports after inserting its entry. */
  private async create(loader: Loader, id: string): Promise<void> {
    const options = { name: id }
    const entryId = loader.ensureId(options)
    try {
      await loader.create(options)
    } finally {
      this.managed.set(id, loader.resolve(entryId))
    }
  }

  private async replace(entry: Entry, id: string, rev: string, generation: number): Promise<void> {
    this.index.invalidateForReplacement(id, rev)
    await this.modules.prefetch(id)
    await this.applyReplacement(entry, id, rev, generation, true)
  }

  private async applyReplacement(entry: Entry, id: string, rev: string, generation: number, waitForActivation: boolean): Promise<void> {
    if (!this.current(generation)) return
    await tearDownEntryFiber(entry)
    removeOwnedStyles(id)
    if (!this.current(generation)) return
    await this.modules.import(id, '', {})
    if (!this.current(generation)) return
    await entry.refresh()
    if (entry.fiber === undefined) throw new Error(`client-modules: ${id} import failed (see console)`)
    if (waitForActivation) await entry.fiber.await()
    this.revisions.set(id, rev)
  }

  private async applyRow(loader: Loader, row: BootModuleRow, generation: number, prepared: boolean): Promise<void> {
    if (!this.current(generation)) return
    const { id, rev } = row
    const entry = this.managed.get(id)
    if (entry === undefined) {
      if (!prepared) await this.modules.prefetch(id)
      if (!this.current(generation)) return
      await this.modules.import(id, '', {})
      if (!this.current(generation)) return
      await this.create(loader, id)
      this.revisions.set(id, rev)
    } else if (this.revisions.get(id) !== rev || entry.fiber === undefined) {
      if (prepared) await this.applyReplacement(entry, id, rev, generation, false)
      else await this.replace(entry, id, rev, generation)
    } else if (entry.fiber.state === FAILED) {
      // A retry with unchanged config is not a configuration change to persist.
      entry.fiber.update(entry.options.config, true)
    }
  }

  private async requireActive(id: string, entry: Entry | undefined): Promise<void> {
    const fiber = entry?.fiber
    if (fiber === undefined) throw new Error(`client-modules: ${id} import failed (see console)`)
    await fiber.await()
    if (fiber.state !== ACTIVE) throw new Error(`client-modules: ${id} is waiting for activation`)
  }

  /** Prepare transport outside the queue. Only work with registered factories enters the Loader. */
  private startOptionalRow(loader: Loader, row: BootModuleRow, generation: number): void {
    const { id, rev } = row
    if (this.optionalLoads.has(id)) return
    const entry = this.managed.get(id)
    const replacing = entry !== undefined && (this.revisions.get(id) !== rev || entry.fiber === undefined)
    if (!replacing && entry?.fiber?.state === ACTIVE) return
    const lifetime = this.optionalLifetime.signal
    const task = (async () => {
      let failure: { id: string; message: string } | undefined
      try {
        if (entry === undefined || replacing) {
          if (replacing) this.index.invalidateForReplacement(id, rev)
          const signal = AbortSignal.any([lifetime, AbortSignal.timeout(OPTIONAL_ARRIVAL_TIMEOUT_MS)])
          await this.modules.prefetch(id, signal)
        }
        if (!this.current(generation)) return
        await this.enqueue(() => this.applyRow(loader, row, generation, true), id)
        await loader.await()
        if (!this.current(generation)) return
        await this.requireActive(id, this.managed.get(id))
      } catch (error) {
        failure = { id, message: String(error) }
      }
      if (this.current(generation)) {
        const failures = this.snapshot.failures.filter(entry => entry.id !== id)
        if (failure !== undefined) failures.push(failure)
        this.publish({ ...this.snapshot, failures })
      }
    })().finally(() => {
      if (this.optionalLoads.get(id) === task) this.optionalLoads.delete(id)
    })
    this.optionalLoads.set(id, task)
  }

  private async reconcile(generation: number): Promise<void> {
    if (!this.current(generation)) return
    const loader = this.loader
    if (loader === undefined) throw new Error('client-modules: entries have not started')
    const manifest = this.desired
    const optional = new Set(manifest.modules.filter(row => row.optional === true).map(row => row.id))
    this.publish({ syncing: true, failures: this.snapshot.failures.filter(failure => optional.has(failure.id)) })
    const failures: { id: string; message: string }[] = []
    if (manifest !== this.modules.manifest) this.index.update(manifest, this.managed.keys())
    const rows = this.optionalStarted ? manifest.modules : manifest.modules.filter(row => row.optional !== true)
    const wanted = new Set(rows.map(row => row.id))
    for (const [id, entry] of this.managed) {
      if (wanted.has(id)) continue
      const fiber = entry.fiber
      loader.remove(entry.id)
      this.managed.delete(id)
      this.revisions.delete(id)
      // Removed fibers no longer appear in Loader.getTasks().
      while (fiber?.inertia !== undefined) await fiber.inertia
    }
    for (const row of rows) {
      if (row.optional === true) continue
      try { await this.applyRow(loader, row, generation, false) }
      catch (error) { failures.push({ id: row.id, message: String(error) }) }
    }
    for (const [id, entry] of this.managed) {
      if (optional.has(id) || failures.some(failure => failure.id === id)) continue
      try { await this.requireActive(id, entry) }
      catch (error) { failures.push({ id, message: String(error) }) }
    }
    this.index.prune([...loader.entries()].map(entry => entry.options.name))
    if (!this.current(generation)) return
    failures.push(...this.snapshot.failures.filter(failure => optional.has(failure.id)))
    this.publish({ syncing: false, failures })
    for (const row of rows) {
      if (row.optional === true) this.startOptionalRow(loader, row, generation)
    }
  }
}
