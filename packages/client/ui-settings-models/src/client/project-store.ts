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
  private inFlight: Promise<void> | undefined

  constructor(private readonly read: () => Promise<SettingsDescribeView>) {}

  getSnapshot() { return this.store.getSnapshot() }
  subscribe(listener: () => void): () => void { return this.store.subscribe(listener) }
  ensure(): Promise<void> {
    if (this.inFlight !== undefined) return this.inFlight
    return this.getSnapshot().status === 'ready' ? Promise.resolve() : this.load()
  }
  load(): Promise<void> {
    if (this.inFlight !== undefined) return this.inFlight
    this.store.update((snapshot) => { snapshot.status = 'loading' })
    const operation = this.read().then((view) => {
      this.store.set({ status: 'ready', view, error: null })
    }, (error: unknown) => {
      this.store.update((snapshot) => {
        snapshot.status = snapshot.view === undefined ? 'idle' : 'ready'
        snapshot.error = error instanceof Error ? error.message : String(error)
      })
    }).finally(() => { this.inFlight = undefined })
    this.inFlight = operation
    return operation
  }
  acceptView(view: SettingsNamespaceView): void {
    const current = this.getSnapshot()
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
 * protocol. The bridge keeps one in-flight read and updates the shared mirror
 * after every successful mutation, so project and personal cards use the same
 * schema operations and credential write semantics.
 */
export class ProjectModelsBridge {
  /** Settings mirror projected from the project transport. */
  readonly mirror: ProjectSettingsMirror
  /** API face adapted for the shared Provider editor. */
  readonly api: ProjectApi
  private loading: Promise<ProjectModelSettingsView> | undefined

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
    })
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
      update: async (payload: { patch: object; expectedRevision?: number }) => {
        const current = await this.read()
        const namespace = current.namespaces[0]
        if (namespace === undefined) throw new Error('project model settings namespace is unavailable')
        if (payload.expectedRevision !== undefined && payload.expectedRevision !== namespace.revision) {
          return conflict('llm-pi-ai', payload.expectedRevision, namespace.revision)
        }
        const ops: ProjectSettingsOp[] = []
        for (const [key, value] of Object.entries(payload.patch)) appendPatchOps(value, [key], ops)
        if (ops.length === 0) return ok(namespace)
        const result = await this.transport.mutate(this.projectId, {
          ops, expectedRevision: payload.expectedRevision ?? namespace.revision,
        })
        this.publish(result)
        return ok(result.namespaces[0] as SettingsNamespaceView)
      },
      replace: async (payload: { section: object; expectedRevision?: number }) => {
        const current = await this.read()
        const namespace = current.namespaces[0]
        if (namespace === undefined) throw new Error('project model settings namespace is unavailable')
        if (payload.expectedRevision !== undefined && payload.expectedRevision !== namespace.revision) {
          return conflict('llm-pi-ai', payload.expectedRevision, namespace.revision)
        }
        const ops = providerOps(namespace.user, payload.section, true)
        if (ops.length === 0) return ok(namespace)
        const result = await this.transport.mutate(this.projectId, {
          ops, expectedRevision: payload.expectedRevision ?? namespace.revision,
        })
        this.publish(result)
        return ok(result.namespaces[0] as SettingsNamespaceView)
      },
      mutate: async (payload: { ns: string; ops: Array<{ op: 'set' | 'unset'; path: string[]; value?: unknown }>; expectedRevision?: number }) => {
        const next = await this.transport.mutate(this.projectId, payload)
        this.publish(next)
        return ok(next.namespaces[0] as SettingsNamespaceView)
      },
    } as ProjectApi['settings']
    const credentials = {
      describe: async (payload: { refs: string[] }) => {
        const value = await this.transport.describeCredentials(this.projectId, payload.refs)
        return ok(value)
      },
      set: async (payload: { ref: string; value: string }) => {
        await this.transport.setCredential(this.projectId, payload.ref, payload.value)
        await this.mirror.load()
        return ok({})
      },
      unset: async (payload: { ref: string }) => {
        await this.transport.unsetCredential(this.projectId, payload.ref)
        await this.mirror.load()
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
      }) => ok(await this.transport.discover(this.projectId, {
        ...payload.provider === undefined ? {} : { provider: payload.provider },
        ...payload.baseURL === undefined ? {} : { baseURL: payload.baseURL },
        ...payload.api === undefined ? {} : { api: payload.api },
        ...payload.apiKey === undefined ? {} : { apiKey: payload.apiKey },
      })),
    } as ProjectApi['llm']
    this.api = { settings, credentials, llm }
  }

  /** Return the shared settings mirror consumed by ModelsSettingsStore.
   * @returns the project settings describe face.
   */
  describe(): SettingsDescribeFace { return this.mirror }

  /** Refresh after a pushed project policy change. */
  async refresh(): Promise<void> {
    await this.read()
  }

  private async read(): Promise<ProjectModelSettingsView> {
    if (this.loading !== undefined) return this.loading
    const operation = this.transport.get(this.projectId)
      .then((value) => { this.publish(value); return value })
      .finally(() => { this.loading = undefined })
    this.loading = operation
    return operation
  }

  private publish(value: ProjectModelSettingsView): void {
    const namespace = value.namespaces[0]
    if (namespace !== undefined) this.mirror.acceptView(namespace)
  }

}

/** Keep the bridge's public API narrow for package consumers. */
export type ProjectModelsApi = ProjectApi
