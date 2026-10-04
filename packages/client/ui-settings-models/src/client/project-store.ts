/** Adapter that presents Gateway project model settings through the shared Models UI. */

import type {
  ConfigurableProviderView,
  IApiClient,
  ModelProviderGroup,
  RpcResponse,
  SettingsNamespaceView,
} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { SettingsDescribeFace, SettingsDescribeView } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {
  ProjectModelSettingsTransport,
  ProjectModelSettingsView,
} from '@deepseek-ai/dsh-client-connection/client'

type ProjectApi = Pick<IApiClient, 'settings' | 'credentials' | 'llm'>

function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: 'project-model-settings' as RpcResponse<T>['rpcId'], result: { ok: true, value } }
}

/** Return the same conflict envelope as the Host settings API for a stale no-op. */
function conflict<T>(ns: string, expected: number, actual: number): RpcResponse<T> {
  return {
    rpcId: 'project-model-settings' as RpcResponse<T>['rpcId'],
    result: {
      ok: false,
      error: {
        code: 'settings-conflict',
        message: 'project model settings revision conflict',
        details: { ns, expected, actual },
      },
    },
  }
}

/** Small settings mirror local to this project-owned API adapter. */
class ProjectSettingsMirror implements SettingsDescribeFace {
  private readonly store: SnapshotStore<{
    status: 'idle' | 'loading' | 'ready'
    view: SettingsDescribeView | undefined
    error: string | null
  }> = createSnapshotStore({ status: 'idle', view: undefined, error: null })
  /** Document revision of the held full view, for stale-echo rejection. */
  private heldRevision: number | undefined

  /**
   * @param read - the bridge's single shared read; the mirror is a projection
   * and owns no read slot of its own.
   * @param isLive - whether the owning bridge still permits publication.
   */
  constructor(
    private readonly read: () => Promise<SettingsDescribeView>,
    private readonly isLive: () => boolean,
  ) {}

  getSnapshot() { return this.store.getSnapshot() }
  subscribe(listener: () => void): () => void { return this.store.subscribe(listener) }
  ensure(): Promise<void> {
    if (!this.isLive() || this.getSnapshot().status === 'ready') return Promise.resolve()
    this.store.update((snapshot) => { snapshot.status = 'loading' })
    return this.read().then(() => {}, (error: unknown) => {
      if (!this.isLive()) return
      // A successful read landing between the loading mark and this failure
      // keeps its publication; a stale failure only reports while still loading.
      this.store.update((snapshot) => {
        if (snapshot.status !== 'loading') return
        snapshot.status = snapshot.view === undefined ? 'idle' : 'ready'
        snapshot.error = error instanceof Error ? error.message : String(error)
      })
    })
  }

  /**
   * Publish one full validated project view (GET or accepted mutation
   * response). Reads accept an equal revision — policy metadata such as
   * `writable` can move without a document revision bump — while a mutation
   * echo never replaces an equal or newer held view.
   * @param view - the transport's validated full view.
   * @param allowEqual - whether an equal document revision may republish.
   * @returns whether the view was accepted as current.
   */
  acceptFull(view: ProjectModelSettingsView, allowEqual: boolean): boolean {
    if (!this.isLive()) return false
    if (this.heldRevision !== undefined
      && (view.revision < this.heldRevision
        || (!allowEqual && view.revision === this.heldRevision))) return false
    this.heldRevision = view.revision
    this.store.set({
      status: 'ready',
      error: null,
      view: {
        namespaces: view.namespaces,
        writable: view.writable,
        ...(view.writable ? {} : { writableReason: 'project' as const }),
        hasDocument: false,
      },
    })
    return true
  }

  acceptView(view: SettingsNamespaceView): void {
    if (!this.isLive()) return
    const current = this.getSnapshot()
    // A partial namespace echo carrying an equal or older revision than the
    // held row cannot replace it; it must not resurrect stale metadata such
    // as writable state the newer full view already revoked.
    const held = current.view?.namespaces.find(row => row.ns === view.ns)
    if (held !== undefined && view.revision <= held.revision) return
    if (current.view === undefined) {
      this.store.set({
        status: 'ready',
        error: null,
        view: {
          namespaces: [view],
          writable: view.writable ?? true,
          hasDocument: false,
        },
      })
      return
    }
    this.store.set({
      status: 'ready',
      error: null,
      view: {
        ...current.view,
        namespaces: current.view.namespaces.some(row => row.ns === view.ns)
          ? current.view.namespaces.map(row => row.ns === view.ns ? view : row)
          : [...current.view.namespaces, view],
      },
    })
  }
}

function providerViews(view: ProjectModelSettingsView): ConfigurableProviderView[] {
  return view.providers.filter(provider => provider.status !== 'archived').map(provider => ({
    provider: provider.provider,
    displayName: provider.displayName,
    settingsNs: 'llm-pi-ai',
    settingsPath: ['providers', provider.provider],
    active: provider.status === 'enabled',
    management: 'project' as const,
    declared: true,
  }))
}

function modelGroups(view: ProjectModelSettingsView): ModelProviderGroup[] {
  return view.models.groups.map(group => ({
    id: group.id,
    name: group.name,
    models: group.models.map(model => ({
      id: model.id,
      name: model.name,
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
      ...model.inputModalities === undefined ? {} : { inputModalities: [...model.inputModalities] },
    })),
  }))
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

type ProjectSettingsOp = { op: 'set' | 'unset'; path: string[]; value?: unknown }

/** Whether a value is a JSON object rather than an array or scalar. */
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Append merge-style path ops while preserving redacted Provider headers. */
function appendPatchOps(value: unknown, path: string[], ops: ProjectSettingsOp[]): void {
  if (!isObject(value)) {
    ops.push({ op: 'set', path, value })
    return
  }
  // Project responses mask every header value. A marker is not a real value,
  // so omit it instead of replacing the secret held by the Gateway.
  if (path.at(-1) === 'headers') {
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== '[redacted]') ops.push({ op: 'set', path: [...path, key], value: entry })
    }
    return
  }
  for (const [key, entry] of Object.entries(value)) appendPatchOps(entry, [...path, key], ops)
}

/** Diff one profile for replace semantics without writing redacted headers. */
function appendReplaceOps(before: unknown, after: unknown, path: string[], ops: ProjectSettingsOp[]): void {
  if (!isObject(after)) {
    if (JSON.stringify(before) !== JSON.stringify(after)) ops.push({ op: 'set', path, value: after })
    return
  }
  if (path.at(-1) === 'headers') {
    const oldHeaders = isObject(before) ? before : {}
    for (const [key, entry] of Object.entries(after)) {
      if (entry === '[redacted]') continue
      if (JSON.stringify(oldHeaders[key]) !== JSON.stringify(entry)) {
        ops.push({ op: 'set', path: [...path, key], value: entry })
      }
    }
    for (const key of Object.keys(oldHeaders)) {
      if (!Object.hasOwn(after, key)) ops.push({ op: 'unset', path: [...path, key] })
    }
    return
  }
  const oldObject = isObject(before) ? before : {}
  for (const [key, entry] of Object.entries(after)) {
    appendReplaceOps(oldObject[key], entry, [...path, key], ops)
  }
  for (const key of Object.keys(oldObject)) {
    if (!Object.hasOwn(after, key)) ops.push({ op: 'unset', path: [...path, key] })
  }
}

/** Build provider-level path edits for update/replace compatibility calls. */
function providerOps(before: unknown, after: unknown, replace = false): ProjectSettingsOp[] {
  const oldProviders = objectOrEmpty(objectOrEmpty(before).providers)
  const nextProviders = objectOrEmpty(objectOrEmpty(after).providers)
  const ops: ProjectSettingsOp[] = []
  for (const [provider, value] of Object.entries(nextProviders)) {
    const path = ['providers', provider]
    if (replace) appendReplaceOps(oldProviders[provider], value, path, ops)
    else if (JSON.stringify(oldProviders[provider]) !== JSON.stringify(value)) appendPatchOps(value, path, ops)
  }
  for (const provider of Object.keys(oldProviders)) {
    if (!Object.hasOwn(nextProviders, provider)) ops.push({ op: 'unset', path: ['providers', provider] })
  }
  return ops
}

/**
 * Bridge the project-owned HTTP API to the existing settings/Models editor
 * protocol. The current read owns publication; every read and admitted
 * transport operation stays retained until settlement. Disposal stops new
 * admission and publication without cancelling writes that may have committed.
 */
export class ProjectModelsBridge {
  /** Settings mirror projected from the project transport. */
  readonly mirror: ProjectSettingsMirror
  /** API face adapted for the shared Provider editor. */
  readonly api: ProjectApi
  private readonly lifetime = new AbortController()
  private readSlot: { controller: AbortController; promise: Promise<ProjectModelSettingsView> } | undefined
  /** Settlement ownership is independent of the current read's publication eligibility. */
  private readonly pendingOperations = new Set<Promise<unknown>>()
  /** Retired callers use this full view only when no successor read is pending. */
  private held: ProjectModelSettingsView | undefined

  constructor(
    private readonly projectId: number,
    private readonly transport: ProjectModelSettingsTransport,
  ) {
    this.mirror = new ProjectSettingsMirror(async () => {
      const view = await this.read()
      return {
        namespaces: view.namespaces,
        writable: view.writable,
        ...(view.writable ? {} : { writableReason: 'project' as const }),
        hasDocument: view.hasDocument,
      }
    }, () => !this.lifetime.signal.aborted)
    const mutateNamespace = async (
      payload: { expectedRevision?: number },
      opsFor: (namespace: SettingsNamespaceView) => ProjectSettingsOp[],
    ): Promise<RpcResponse<SettingsNamespaceView>> => {
      const current = await this.read()
      this.requireLive()
      const namespace = current.namespaces[0]
      if (namespace === undefined) throw new Error('project model settings namespace is unavailable')
      if (payload.expectedRevision !== undefined && payload.expectedRevision !== namespace.revision) {
        return conflict('llm-pi-ai', payload.expectedRevision, namespace.revision)
      }
      const ops = opsFor(namespace)
      if (ops.length === 0) return ok(namespace)
      const result = await this.ownOperation(() => this.transport.mutate(this.projectId, {
        ops, expectedRevision: payload.expectedRevision ?? namespace.revision,
      }))
      this.publish(result)
      return ok(result.namespaces[0] as SettingsNamespaceView)
    }
    const settings = {
      describe: async () => {
        const view = await this.read()
        return ok({
          namespaces: view.namespaces,
          writable: view.writable,
          ...(view.writable ? {} : { writableReason: 'project' as const }),
          hasDocument: view.hasDocument,
        })
      },
      openDocument: () => Promise.resolve(ok({ opened: true as const })),
      update: async (payload: { patch: object; expectedRevision?: number }) => mutateNamespace(payload, () => {
        const ops: ProjectSettingsOp[] = []
        for (const [key, value] of Object.entries(payload.patch)) appendPatchOps(value, [key], ops)
        return ops
      }),
      replace: async (payload: { section: object; expectedRevision?: number }) => mutateNamespace(
        payload,
        namespace => providerOps(namespace.user, payload.section, true),
      ),
      mutate: async (payload: { ns: string; ops: Array<{ op: 'set' | 'unset'; path: string[]; value?: unknown }>; expectedRevision?: number }) => {
        const next = await this.ownOperation(() => this.transport.mutate(this.projectId, payload))
        this.publish(next)
        return ok(next.namespaces[0] as SettingsNamespaceView)
      },
    } as ProjectApi['settings']
    const credentials = {
      describe: async (payload: { refs: string[] }) => {
        const value = await this.ownOperation(() =>
          this.transport.describeCredentials(this.projectId, payload.refs, this.lifetime.signal))
        return ok(value)
      },
      set: async (payload: { ref: string; value: string }) => {
        await this.ownOperation(() => this.transport.setCredential(this.projectId, payload.ref, payload.value))
        if (!this.lifetime.signal.aborted) await this.refresh()
        return ok({})
      },
      unset: async (payload: { ref: string }) => {
        await this.ownOperation(() => this.transport.unsetCredential(this.projectId, payload.ref))
        if (!this.lifetime.signal.aborted) await this.refresh()
        return ok({})
      },
    } as ProjectApi['credentials']
    const llm = {
      providers: async () => ok({ providers: providerViews(await this.read()) }),
      models: async () => {
        const view = await this.read()
        return ok({ groups: modelGroups(view), failures: view.models.failures })
      },
      discoverModels: async (payload: {
        provider?: string
        baseURL?: string
        api?: string
        apiKey?: string
        settingsNs: string
      }) => {
        return ok(await this.ownOperation(() => this.transport.discover(this.projectId, {
          ...payload.provider === undefined ? {} : { provider: payload.provider },
          ...payload.baseURL === undefined ? {} : { baseURL: payload.baseURL },
          ...payload.api === undefined ? {} : { api: payload.api },
          ...payload.apiKey === undefined ? {} : { apiKey: payload.apiKey },
        }, this.lifetime.signal)))
      },
    } as ProjectApi['llm']
    this.api = { settings, credentials, llm }
  }

  /** Return the shared settings mirror consumed by ModelsSettingsStore.
   * @returns the project settings describe face.
   */
  describe(): SettingsDescribeFace { return this.mirror }

  /** Force a fresh read after a pushed project policy change, retiring the pending one.
   * @returns settlement of the refresh, or immediate completion after disposal.
   */
  async refresh(): Promise<void> {
    if (this.lifetime.signal.aborted) return
    await this.read(true)
  }

  /**
   * Stop admission and publication, abort eligible reads, and await every
   * retained operation. Admitted writes keep their real acknowledgement.
   * @returns settlement after all retained work, including on repeated calls.
   */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    const slot = this.readSlot
    this.readSlot = undefined
    slot?.controller.abort()
    await Promise.allSettled([...this.pendingOperations])
  }

  private requireLive(): void {
    if (this.lifetime.signal.aborted) throw new Error('project model settings bridge is disposed')
  }

  /** Retain one deferred transport operation and check lifetime immediately before admission. */
  private ownOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.requireLive()
    const promise = Promise.resolve().then(() => {
      this.requireLive()
      return operation()
    }).finally(() => {
      this.pendingOperations.delete(promise)
    })
    this.pendingOperations.add(promise)
    return promise
  }

  private read(force = false): Promise<ProjectModelSettingsView> {
    this.requireLive()
    const current = this.readSlot
    if (current !== undefined && !force) return current.promise
    const controller = new AbortController()
    const promise = Promise.resolve().then(() => this.readOnce(controller)).finally(() => {
      if (this.readSlot?.controller === controller) this.readSlot = undefined
      this.pendingOperations.delete(promise)
    })
    this.readSlot = { controller, promise }
    this.pendingOperations.add(promise)
    current?.controller.abort()
    return promise
  }

  private owns(controller: AbortController): boolean {
    return this.readSlot?.controller === controller
      && !controller.signal.aborted
      && !this.lifetime.signal.aborted
  }

  private async readOnce(controller: AbortController): Promise<ProjectModelSettingsView> {
    if (!this.owns(controller)) return this.retiredRead(controller)
    let view: ProjectModelSettingsView
    try {
      view = await this.transport.get(this.projectId, controller.signal)
    } catch (cause: unknown) {
      if (!this.owns(controller)) return await this.retiredRead(controller)
      throw cause
    }
    if (!this.owns(controller)) return this.retiredRead(controller)
    // A current GET is authoritative at equal revision: policy metadata can
    // move without a document revision bump.
    if (this.mirror.acceptFull(view, true)) this.held = view
    return this.held ?? view
  }

  /** A retired read joins its successor, uses held data, or rejects without admitting another GET. */
  private retiredRead(controller: AbortController): Promise<ProjectModelSettingsView> {
    const successor = this.readSlot
    if (successor !== undefined && successor.controller !== controller) return successor.promise
    if (this.held !== undefined) return Promise.resolve(this.held)
    return Promise.reject(new Error(this.lifetime.signal.aborted
      ? 'project model settings bridge is disposed'
      : 'project model settings read is retired'))
  }

  private publish(value: ProjectModelSettingsView): void {
    if (this.lifetime.signal.aborted) return
    // A mutation echo never replaces an equal or newer held view.
    if (this.mirror.acceptFull(value, false)) this.held = value
  }

}

/** Keep the bridge's public API narrow for package consumers. */
export type ProjectModelsApi = ProjectApi
