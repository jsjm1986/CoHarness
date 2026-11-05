/** One browser document's in-flight entry requests for the authenticated account. */
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { runtimeTargetKey } from '@deepseek-ai/dsh-host-apiproxy/api'
import { readApiResponseJson } from '@deepseek-ai/dsh-host-apiproxy/client'
import type { SessionRuntimeTarget } from './contract/sessions.ts'
import { readOwnerProjects, type ProjectOwnerRef, type OwnerProjectDisplay } from './project-metadata.ts'
import { EntryDirectory, type DirectoryPageSelection } from './entry-directory.ts'
import { PreparedSessionApi, prepareGatewayRuntime } from './prepare-runtime.ts'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
type SessionApi = IApiClient['sessions']

interface Flight<T> {
  readonly controller: AbortController
  readonly result: Promise<T>
  waiters: number
}

/** Share a pending operation. Each consumer may cancel independently. */
class PendingRequests<T> {
  private readonly active = new Map<string, Flight<T>>()
  private readonly draining = new Set<Promise<T>>()
  private readonly scheduled = new Set<Promise<T>>()

  constructor(private readonly limit: number) {}

  async run(key: string, signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    signal?.throwIfAborted()
    let flight = this.active.get(key)
    if (flight === undefined) {
      if (this.scheduled.size >= this.limit * 2) throw new Error('Computer requests are busy. Try again.')
      const controller = new AbortController()
      const start = async (): Promise<T> => {
        while (this.draining.size >= this.limit) {
          controller.signal.throwIfAborted()
          let cancel: (() => void) | undefined
          const aborted = new Promise<never>((_resolve, reject) => {
            cancel = () => { reject(controller.signal.reason instanceof Error ? controller.signal.reason : new DOMException('Aborted', 'AbortError')) }
            controller.signal.addEventListener('abort', cancel, { once: true })
          })
          try { await Promise.race([aborted, ...[...this.draining].map(p => p.then(() => {}, () => {}))]) }
          finally { if (cancel !== undefined) controller.signal.removeEventListener('abort', cancel) }
        }
        controller.signal.throwIfAborted()
        const active = operation(controller.signal)
        this.draining.add(active)
        try { return await active } finally { this.draining.delete(active) }
      }
      const result = start()
      const created: Flight<T> = { controller, result, waiters: 0 }
      this.active.set(key, created)
      this.scheduled.add(result)
      const retire = (): void => {
        this.scheduled.delete(result)
        if (this.active.get(key) === created) this.active.delete(key)
      }
      void result.then(retire, retire)
      flight = created
    }
    flight.waiters++
    const waiter = signal === undefined ? flight.controller.signal : AbortSignal.any([signal, flight.controller.signal])
    let stop: (() => void) | undefined
    try {
      waiter.throwIfAborted()
      const abandoned = new Promise<never>((_resolve, reject) => {
        stop = () => { reject(waiter.reason instanceof Error ? waiter.reason : new DOMException('Aborted', 'AbortError')) }
        waiter.addEventListener('abort', stop, { once: true })
      })
      return await Promise.race([flight.result, abandoned])
    } finally {
      if (stop !== undefined) waiter.removeEventListener('abort', stop)
      flight.waiters--
      if (flight.waiters === 0 && this.active.get(key) === flight) {
        this.active.delete(key)
        flight.controller.abort()
      }
    }
  }

  invalidate(): void {
    for (const flight of this.active.values()) flight.controller.abort()
    this.active.clear()
  }

  async dispose(): Promise<void> { this.invalidate(); await Promise.allSettled(this.scheduled) }
}

/** Per-entry catalog reads and explicit target preparation. Settled responses are not retained. */
export class GatewayEntryRequests {
  private readonly catalogs: PendingRequests<unknown>
  private readonly directory: EntryDirectory
  private readonly separatePersonalPages = new Set<string>()
  private readonly targets: PendingRequests<void>
  private readonly histories: PendingRequests<Awaited<ReturnType<SessionApi['history']>>>
  private readonly creates: PendingRequests<Awaited<ReturnType<SessionApi['create']>>>
  private closed = false
  private readonly lifetime = new AbortController()

  /** @param connection - document-owned transport and request limits. @param principal - current verified account. */
  constructor(private readonly connection: ConnectionHandle,
    private readonly principal: () => number | undefined, private readonly multi: () => boolean = () => false,
    private readonly ownership?: { ready: () => boolean; subscribe: (listener: () => void) => () => void }) {
    const limit = connection.entryRequestLimit ?? 16
    this.catalogs = new PendingRequests(limit)
    this.histories = new PendingRequests(limit)
    this.creates = new PendingRequests(limit)
    this.directory = new EntryDirectory((url, signal) => this.read(url, signal))
    this.targets = new PendingRequests(limit)
  }

  private async waitForOwner(signal?: AbortSignal): Promise<void> {
    this.lifetime.signal.throwIfAborted()
    const source = this.ownership
    if (source === undefined || source.ready()) return
    const deadline = new AbortController()
    const timer = setTimeout(() => { deadline.abort(new Error('Computer directory owner could not be verified')) }, this.connection.metadataTiming.requestTimeoutMs)
    const active = AbortSignal.any([this.lifetime.signal, deadline.signal, ...(signal === undefined ? [] : [signal])])
    let unsubscribe: (() => void) | undefined, aborted: (() => void) | undefined
    try {
      active.throwIfAborted()
      await new Promise<void>((resolve, reject) => {
        const check = (): void => { if (source.ready()) resolve() }
        aborted = () => { reject(active.reason instanceof Error ? active.reason : new DOMException('Aborted', 'AbortError')) }
        active.addEventListener('abort', aborted, { once: true })
        unsubscribe = source.subscribe(check)
        check()
      })
    } finally { clearTimeout(timer); unsubscribe?.(); if (aborted !== undefined) active.removeEventListener('abort', aborted) }
  }

  /** Read the account directory for the current entry and tab selection.
   * @param signal - consumer cancellation.
   * @param visible - open selector, query and page limit for this document.
   * @returns wire metadata, or undefined on an unsupported entry.
   */
  async catalog(signal?: AbortSignal, visible?: DirectoryPageSelection): Promise<unknown> {
    await this.waitForOwner(signal)
    signal?.throwIfAborted()
    if (this.multi()) {
      const account = this.principal(), bootstrap = this.connection.hostDescription.getSnapshot()?.runtimeTarget
      if (this.closed || account === undefined || bootstrap?.runtimeId === undefined) throw new Error('Computer directory owner is unavailable')
      if (!this.directory.ready) await this.directory.manifest(account, bootstrap, signal)
      this.directory.prewarm()
      if (visible === undefined || visible.scope === undefined) return this.directory.snapshot()
      const scope = visible.scope
      if (scope === '' && visible.q) return this.directory.snapshot({ ...visible, scope })
      const target = await this.directory.selection(scope, account, signal)
      if (target === undefined) return this.directory.snapshot({ ...visible, scope })
      const page = await this.directory.rows(target, { kind: 'conversations', ...visible }, signal)
      return this.directory.snapshot({ ...visible, scope, page })
    }
    if (this.closed) return Promise.reject(new Error('Computer directory is closed'))
    const query = new URLSearchParams((globalThis as { location?: Location }).location?.search)
    const selection = new URLSearchParams()
    for (const key of ['dshRuntime', 'dshTarget']) {
      const value = query.get(key)
      if (value !== null) selection.set(key, value)
    }
    const url = `/account/api/workbench/catalog${selection.size === 0 ? '' : `?${selection}`}`
    return this.read(url, signal)
  }

  /** Revision of the verified grants backing this browser document's catalog. */
  get catalogAuthority() { return this.directory.authority }

  /** Refresh the organization's grants without accepting rows from a superseded directory generation. */
  refreshDirectory(): void { this.directory.clear(); this.catalogs.invalidate() }

  /** Resolve the picker selection's optional label separately from its conversation rows.
   * @param scope - verified selection in the visible directory.
   * @param signal - picker lifetime.
   * @returns the display if it was still unresolved on this computer.
   */
  async selectedProjectDisplay(scope: string, signal: AbortSignal): Promise<OwnerProjectDisplay | undefined> {
    const target = this.directory.target(scope)
    const ref = target && this.directory.projectRef(target)
    if (!ref) return undefined
    const [display] = await this.projectMetadata(ref.nodeId, [ref], signal)
    if (!display) throw new Error('Project name is unavailable')
    this.directory.receiveProject(display, ref.version)
    return display
  }

  /** Read one bounded group of project names and paths from its exact owner without starting a Runtime.
   * @param nodeId - explicitly selected computer.
   * @param projects - already-authorized project identities.
   * @param signal - reader lifetime.
   * @returns authorized local display fields.
   */
  async projectMetadata(nodeId: string, projects: readonly ProjectOwnerRef[], signal?: AbortSignal): Promise<OwnerProjectDisplay[]> {
    const account = this.principal()
    if (this.closed || account === undefined || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(nodeId)
      || projects.length < 1 || projects.length > 32
      || !projects.every(row => Number.isSafeInteger(row.projectId) && row.projectId > 0)) throw new Error('Invalid project selection')
    const ids = [...new Set(projects.map(row => row.projectId))].sort((a, b) => a - b)
    if (ids.length !== projects.length) throw new Error('Duplicate project selection')
    const query = new URLSearchParams({ dshNode: nodeId, ids: ids.join(',') })
    const value = await this.read(`/account/api/project-metadata?${query}`, signal)
    signal?.throwIfAborted()
    if (this.principal() !== account) throw new Error('Project viewer changed')
    return readOwnerProjects(value, nodeId, projects)
  }

  /** Fetch the next central Runtime page on an explicit user action.
   * @param signal - consumer lifetime.
   */
  async moreComputers(signal?: AbortSignal): Promise<void> {
    const account = this.principal(), bootstrap = this.connection.hostDescription.getSnapshot()?.runtimeTarget
    if (!this.multi() || this.closed || account === undefined || bootstrap?.runtimeId === undefined) throw new Error('Computer directory is unavailable')
    await this.directory.manifest(account, bootstrap, signal, true)
  }

  /** Fetch Workspace and conversation pages only for the personally expanded Runtime.
   * @param target - exact selected personal allocation.
   * @param options - continuation cursors; omitted reads the first pages.
   * @param signal - view scope.
   */
  async personalRows(target: SessionRuntimeTarget,
    options?: { workspaces?: string; conversations?: string }, signal?: AbortSignal): Promise<void> {
    if (this.closed || !this.multi()) throw new Error('Paged computer directory is unavailable')
    const owner = JSON.stringify([target.nodeId, runtimeTargetKey(target)])
    if (options === undefined && !this.separatePersonalPages.has(owner)) {
      const page = await this.directory.rows(target, { kind: 'workspaces', includeConversations: true }, signal)
      if (!page.combined) {
        this.separatePersonalPages.add(owner)
        await this.directory.rows(target, { kind: 'conversations' }, signal)
      }
      return
    }
    await Promise.all((['workspaces', 'conversations'] as const).filter(kind => options === undefined || options[kind] !== undefined)
      .map(kind => this.directory.rows(target, { kind, ...(options?.[kind] === undefined ? {} : { cursor: options[kind] }) }, signal)))
  }

  private read(url: string, signal?: AbortSignal): Promise<unknown> {
    const account = this.principal()
    return this.catalogs.run(JSON.stringify([account, url]), signal, async (active) => {
      const deadline = new AbortController()
      const timer = setTimeout(() => { deadline.abort(new Error('Directory request timed out')) }, this.connection.metadataTiming.requestTimeoutMs)
      try {
        const response = await fetch(url, { signal: AbortSignal.any([active, deadline.signal]), credentials: 'same-origin', cache: 'no-store',
          headers: { accept: 'application/json', ...(account === undefined ? {} : { 'x-dsh-expected-principal-id': String(account) }) } })
        if (response.status === 404 || response.status === 501) { await response.body?.cancel(); return undefined }
        if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error(`Computer directory returned HTTP ${response.status}`), { status: response.status }) }
        return await readApiResponseJson(response)
      } finally { clearTimeout(timer) }
    })
  }

  private source(target: SessionRuntimeTarget, account: number | undefined): PreparedSessionApi {
    if (this.closed || !this.multi() || account === undefined) throw new Error('Target Runtime is unavailable')
    return new PreparedSessionApi(this.connection, target, account)
  }

  /** Verify and read one active Session tail with independent waiter cancellation.
   * @param target - exact allocation.
   * @param input - authorized history window.
   * @param signal - caller lifetime.
   * @returns the captured source's verified response.
   */
  history(target: SessionRuntimeTarget, input: Parameters<SessionApi['history']>[0], signal: AbortSignal): ReturnType<SessionApi['history']> {
    const account = this.principal()
    return this.histories.run(JSON.stringify([account, target.nodeId, runtimeTargetKey(target), input]), signal,
      active => this.source(target, account).sessions.history(input, active))
  }

  /** Share only the same explicitly identified Session creation intent.
   * @param target - exact allocation.
   * @param input - native request with stable Session/reservation identities.
   * @param signal - caller lifetime.
   * @returns the native Session and Workspace receipt.
   */
  create(target: SessionRuntimeTarget, input: Parameters<SessionApi['create']>[0], signal: AbortSignal): ReturnType<SessionApi['create']> {
    const account = this.principal()
    if (!input.sessionId || !input.draftId) throw new Error('Cannot prepare an unidentified Session intent')
    return this.creates.run(JSON.stringify([account, target.nodeId, runtimeTargetKey(target), input]), signal,
      active => this.source(target, account).sessions.create(input, active))
  }

  /** Prepare one exact Runtime before an explicit operation.
   * @param target - selected allocation.
   * @param signal - consumer cancellation.
   * @returns when the entry confirms the target.
   */
  prepare(target: SessionRuntimeTarget, signal?: AbortSignal): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Computer requests are closed'))
    return this.targets.run(JSON.stringify([this.principal(), target.nodeId, runtimeTargetKey(target)]), signal,
      active => prepareGatewayRuntime(this.connection, target, active))
  }

  /** Withdraw results belonging to a previous verified identity or deployment revision. */
  invalidate(): void {
    this.separatePersonalPages.clear()
    this.catalogs.invalidate()
    this.targets.invalidate()
    this.histories.invalidate()
    this.creates.invalidate()
    this.directory.clear()
  }

  /** Stop admission and join outstanding request cleanup. @returns after owned requests settle. */
  async dispose(): Promise<void> {
    this.closed = true
    this.lifetime.abort()
    this.directory.clear()
    await Promise.all([this.catalogs.dispose(), this.targets.dispose(), this.histories.dispose(), this.creates.dispose()])
  }
}
