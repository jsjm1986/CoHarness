/** Metadata-only Workspace resources isolated by connection target and Session. */
import type { ConnectionRuntimeTarget, IApiClient, SessionId } from '@deepseek-ai/dsh-client-connection/client'

/** Opaque browser address containing only a Session and relative file path. */
export type WorkspaceResourceAddress = string & { readonly __workspaceResourceAddress: unique symbol }
/** The bootstrap connection has its own identity, independent of the focused pane. */
export type WorkspaceResourceTarget = ConnectionRuntimeTarget | { readonly kind: 'base' }
/** Explicit file request retaining the transport that owns its Session. */
export interface WorkspaceResourceOpenRequest {
  readonly runtimeTarget: WorkspaceResourceTarget
  readonly sessionId: SessionId
  readonly path: string
  readonly address: WorkspaceResourceAddress
}
/** Metadata shared by views; file content belongs to the preview that requested it. */
export interface WorkspaceResourceValue {
  readonly sessionId: SessionId
  readonly path: string
  readonly type: 'file' | 'directory'
  readonly bytes?: number
  readonly version: string
  readonly changed: boolean
}
/** Transient failures retain metadata; access failures discard it. */
export type WorkspaceResourceState =
  | { readonly status: 'none'; readonly value?: undefined; readonly error?: undefined }
  | { readonly status: 'loading'; readonly value?: WorkspaceResourceValue; readonly error?: undefined }
  | { readonly status: 'live'; readonly value: WorkspaceResourceValue; readonly error?: undefined }
  | { readonly status: 'failed'; readonly value?: WorkspaceResourceValue; readonly error: Error }
/** A source supports React's external-store subscription without content caching. */
export interface WorkspaceResourceSource {
  /** Read the same snapshot object until the resource changes. */
  get(this: void): WorkspaceResourceState
  /** Retain this resource while observing updates. @param listener - update callback. @returns idempotent release. */
  subscribe(this: void, listener: () => void): () => void
  /** Reload metadata explicitly. @returns completion after the snapshot is published. */
  reload(this: void): Promise<void>
}
/** Provider belonging to exactly one connection, with no implicit current-Session lookup. */
export interface WorkspaceResourceProvider {
  /**
   * Read metadata without recovering an Agent.
   * @param address - relative resource address.
   * @param signal - operation lifetime.
   * @returns current metadata.
   */
  stat(address: WorkspaceResourceAddress, signal: AbortSignal): Promise<WorkspaceResourceValue>
}
/** RPC failure retaining its machine-readable code for access invalidation. */
export class WorkspaceResourceError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}
/**
 * Determine whether retained content is no longer authorized.
 * @param error - provider or transport error.
 * @returns whether to discard metadata and content.
 */
export function isWorkspaceAccessFailure(error: unknown): error is WorkspaceResourceError {
  if (!(error instanceof WorkspaceResourceError)) return false
  return ['collaboration-forbidden', 'session-not-found', 'workspace-file/unknown-session', 'access-revoked'].includes(error.code)
}
/**
 * Bind metadata reads to the supplied API client.
 * @param api - the owning runtime's client.
 * @returns provider with no connection or focus lookup.
 */
export function workspaceResourceProvider(api: IApiClient): WorkspaceResourceProvider {
  return {
    async stat(address, signal) {
      const parsed = parseWorkspaceResourceAddress(address)
      if (parsed === undefined) throw new WorkspaceResourceError('workspace-file/unsupported-address', 'Unsupported Workspace resource address')
      const { result } = await api.workspaceFiles.stat(parsed, signal)
      if (!result.ok) throw new WorkspaceResourceError(result.error.code, result.error.message)
      return { ...result.value, sessionId: parsed.sessionId, changed: false }
    },
  }
}

function validSegment(value: string): boolean {
  return value !== '' && value !== '..' && !/[\\/\0]/u.test(value)
}
/**
 * Decode a canonical relative address without accessing a filesystem.
 * @param address - browser address.
 * @returns Session and relative path, or undefined for invalid syntax.
 */
export function parseWorkspaceResourceAddress(address: string): { sessionId: SessionId; path: string } | undefined {
  const prefix = 'dsh-resource://file/session/'
  if (!address.startsWith(prefix) || address.length > 16_384) return undefined
  try {
    const parts = address.slice(prefix.length).split('/').map(decodeURIComponent)
    const sessionId = parts.shift()
    if (sessionId === undefined || !validSegment(sessionId) || sessionId === '.' || parts.length === 0) return undefined
    if (parts.some(part => !validSegment(part)) || (parts.length > 1 && parts.includes('.'))) return undefined
    const path = parts.join('/')
    if (/^[A-Za-z][\w+.-]*:/u.test(path)) return undefined
    return { sessionId: sessionId as SessionId, path }
  } catch (_malformedEscape: unknown) {
    // decodeURIComponent rejects malformed wire escapes.
    return undefined
  }
}
/**
 * Encode a relative path, including `.` for the Workspace root.
 * @param sessionId - resource owner.
 * @param path - relative path with either platform's separators.
 * @returns canonical address.
 */
export function workspaceResourceAddress(sessionId: SessionId, path: string): WorkspaceResourceAddress {
  if (/^(?:[\\/]|[A-Za-z][\w+.-]*:)/u.test(path)) throw new Error('Workspace resource addresses must be relative')
  const parts = path.replaceAll('\\', '/').split('/').filter(part => part !== '' && part !== '.')
  const normalized = parts.length === 0 ? ['.'] : parts
  const address = `dsh-resource://file/session/${encodeURIComponent(String(sessionId))}/${normalized.map(encodeURIComponent).join('/')}`
  if (parseWorkspaceResourceAddress(address) === undefined) throw new Error('Invalid Workspace resource path')
  return address as WorkspaceResourceAddress
}
/**
 * Convert an authored path without exposing the Host root in the address.
 * @param cwd - owning Session's Workspace.
 * @param path - authored path.
 * @returns relative path; outside paths throw.
 */
export function workspacePathForResource(cwd: string | undefined, path: string): string {
  const normalized = path.replaceAll('\\', '/')
  if (!/^(?:\/|[A-Za-z]:)/u.test(normalized)) {
    const parts = normalized.split('/').filter(part => part !== '' && part !== '.')
    if (parts.some(part => part === '..')) throw new Error('The file is outside the Session workspace')
    return parts.join('/') || '.'
  }
  if (cwd === undefined) throw new Error('Workspace is unavailable for this file')
  const root = cwd.replaceAll('\\', '/').replace(/\/+$/u, '')
  if (normalized === root) return '.'
  if (!normalized.startsWith(`${root}/`)) throw new Error('The file is outside the Session workspace')
  return normalized.slice(root.length + 1)
}

function targetKey(target: WorkspaceResourceTarget): string {
  return target.kind === 'project' ? `project:${String(target.projectId)}` : target.kind
}
const EMPTY: WorkspaceResourceState = { status: 'none' }
const UNAVAILABLE: WorkspaceResourceState = {
  status: 'failed', error: new WorkspaceResourceError('access-revoked', 'Workspace runtime is unavailable'),
}
interface ResourceRecord {
  readonly address: WorkspaceResourceAddress
  readonly source: WorkspaceResourceSource
  readonly subscribers: Set<() => void>
  state: WorkspaceResourceState
  pins: number
  controller?: AbortController | undefined
  pending?: Promise<void> | undefined
  observed?: { version?: string } | undefined
}
interface TargetRecords {
  readonly provider: WorkspaceResourceProvider
  readonly maxRecords: number
  readonly records: Map<WorkspaceResourceAddress, ResourceRecord>
  connected: boolean
}

/** Shared resource registry. Existing Host streams deliver observations; resources open no extra streams. */
export class WorkspaceResourceRegistry {
  private readonly targets = new Map<string, TargetRecords>()

  /**
   * Register a runtime provider.
   * @param target - explicit connection identity.
   * @param provider - metadata reader.
   * @param maxRecords - Host-configured record bound.
   * @returns disposer that aborts reads and clears retained values.
   */
  register(target: WorkspaceResourceTarget, provider: WorkspaceResourceProvider, maxRecords: number): () => void {
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) throw new RangeError('Workspace resource limit must be positive')
    const key = targetKey(target)
    if (this.targets.has(key)) throw new Error('Workspace resource provider already registered')
    const owner: TargetRecords = { provider, maxRecords, records: new Map(), connected: true }
    this.targets.set(key, owner)
    return () => {
      if (this.targets.get(key) !== owner) return
      this.targets.delete(key)
      for (const record of owner.records.values()) {
        this.cancel(record)
        record.state = UNAVAILABLE
        this.notify(record)
      }
      owner.records.clear()
    }
  }

  /** Return whether a Host handshake registered a provider for one runtime target.
   * @param target - explicit bootstrap or project runtime identity.
   * @returns true when Workspace resource RPCs are advertised.
   */
  hasProvider(target: WorkspaceResourceTarget): boolean {
    return this.targets.has(targetKey(target))
  }

  /**
   * Obtain a shared source. Reads allocate only on subscribe, pin, or reload.
   * @param request - owning target, Session, and relative address.
   * @returns handle whose snapshots remain stable across idle eviction.
   */
  source(request: WorkspaceResourceOpenRequest): WorkspaceResourceSource {
    const key = targetKey(request.runtimeTarget)
    const parsed = parseWorkspaceResourceAddress(request.address)
    if (parsed?.sessionId !== request.sessionId || parsed.path !== request.path) throw new Error('Workspace resource identity mismatch')
    const existing = this.targets.get(key)?.records.get(request.address)
    if (existing !== undefined) return existing.source
    const lookup = (): ResourceRecord | undefined => this.targets.get(key)?.records.get(request.address)
    const source: WorkspaceResourceSource = {
      get: () => lookup()?.state ?? (this.targets.has(key) ? EMPTY : UNAVAILABLE),
      subscribe: (listener) => {
        const record = this.retain(key, request.address, source)
        if (record === undefined) return () => {}
        // One registration per subscription, even when two callers pass the same callback.
        const notify = (): void => { listener() }
        record.subscribers.add(notify)
        if (record.state.status === 'none') void this.reload(key, record)
        let released = false
        return () => {
          if (released) return
          released = true
          record.subscribers.delete(notify)
          this.release(record)
        }
      },
      reload: async () => {
        const record = this.retain(key, request.address, source)
        if (record !== undefined) await this.reload(key, record)
      },
    }
    return source
  }

  /**
   * Retain metadata independently of a subscriber.
   * @param request - resource owner.
   * @param signal - optional pin lifetime.
   * @returns idempotent release.
   */
  pin(request: WorkspaceResourceOpenRequest, signal?: AbortSignal): () => void {
    if (signal?.aborted === true) return () => {}
    const source = this.source(request)
    const key = targetKey(request.runtimeTarget)
    const record = this.retain(key, request.address, source)
    if (record === undefined) return () => {}
    record.pins += 1
    if (record.state.status === 'none') void this.reload(key, record)
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      signal?.removeEventListener('abort', release)
      record.pins -= 1
      this.release(record)
    }
    signal?.addEventListener('abort', release, { once: true })
    return release
  }

  /**
   * Consume an observation from its owning Host stream.
   * @param target - stream identity.
   * @param change - observed relative path and optional present version.
   */
  handleChange(target: WorkspaceResourceTarget, change: { sessionId: SessionId; path: string; version?: string }): void {
    const owner = this.targets.get(targetKey(target))
    if (owner?.connected !== true) return
    const address = workspaceResourceAddress(change.sessionId, change.path)
    const record = owner.records.get(address)
    if (record === undefined) return
    record.observed = change.version === undefined ? {} : { version: change.version }
    const value = record.state.value
    if (value === undefined || value.changed || value.version === change.version) return
    record.state = { ...record.state, value: { ...value, changed: true } }
    this.notify(record)
  }

  /**
   * Cancel old-generation reads.
   * @param target - lost connection.
   * @param error - access denial clears metadata; transient loss preserves it.
   */
  disconnect(target: WorkspaceResourceTarget, error: Error = new WorkspaceResourceError('connection-unavailable', 'Workspace connection is reconnecting')): void {
    const owner = this.targets.get(targetKey(target))
    if (owner === undefined) return
    owner.connected = false
    for (const record of owner.records.values()) {
      this.cancel(record)
      const failure = isWorkspaceAccessFailure(record.state.error) ? record.state.error : error
      record.state = { status: 'failed', error: failure, ...(!isWorkspaceAccessFailure(failure) && record.state.value !== undefined ? { value: record.state.value } : {}) }
      this.notify(record)
    }
  }

  /** Revalidate retained resources after the stream handshake.
   * @param target - new connection generation.
   */
  connected(target: WorkspaceResourceTarget): void {
    const key = targetKey(target)
    const owner = this.targets.get(key)
    if (owner === undefined) return
    owner.connected = true
    for (const record of owner.records.values()) {
      if (record.pins > 0 || record.subscribers.size > 0) void this.reload(key, record, true)
    }
  }

  private retain(key: string, address: WorkspaceResourceAddress, source: WorkspaceResourceSource): ResourceRecord | undefined {
    const owner = this.targets.get(key)
    if (owner === undefined) return undefined
    const existing = owner.records.get(address)
    if (existing !== undefined) {
      owner.records.delete(address)
      owner.records.set(address, existing)
      return existing
    }
    while (owner.records.size >= owner.maxRecords) {
      const idle = [...owner.records.values()].find(record => record.pins === 0 && record.subscribers.size === 0)
      if (idle === undefined) throw new Error('Workspace resource limit reached; close a file before opening another')
      this.cancel(idle)
      owner.records.delete(idle.address)
    }
    const record: ResourceRecord = { address, source, state: EMPTY, subscribers: new Set(), pins: 0 }
    owner.records.set(address, record)
    return record
  }

  private async reload(key: string, record: ResourceRecord, revalidate = false): Promise<void> {
    const owner = this.targets.get(key)
    if (owner?.connected !== true) return
    if (record.pending !== undefined) return record.pending
    const controller = new AbortController()
    record.controller = controller
    const previous = record.state.value
    record.observed = undefined
    record.state = { status: 'loading', ...(previous === undefined ? {} : { value: previous }) }
    const work = Promise.resolve().then(async (): Promise<void> => {
      try {
        const value = await owner.provider.stat(record.address, controller.signal)
        if (controller.signal.aborted || this.targets.get(key) !== owner) return
        const observation = record.observed
        const changed = (observation !== undefined && observation.version !== value.version)
          || (revalidate && previous !== undefined && (previous.changed || previous.version !== value.version))
        record.state = { status: 'live', value: { ...value, changed } }
      } catch (error: unknown) {
        if (controller.signal.aborted) return
        const failure = error instanceof Error ? error : new Error(String(error))
        record.state = { status: 'failed', error: failure, ...(!isWorkspaceAccessFailure(failure) && previous !== undefined ? { value: previous } : {}) }
      } finally {
        if (record.controller === controller) {
          record.controller = undefined
          record.pending = undefined
          this.notify(record)
        }
      }
    })
    record.pending = work
    this.notify(record)
    return work
  }

  private cancel(record: ResourceRecord): void {
    record.controller?.abort()
    record.controller = undefined
    record.pending = undefined
  }

  private release(record: ResourceRecord): void {
    if (record.pins > 0 || record.subscribers.size > 0) return
    this.cancel(record)
    if (record.state.status === 'loading') record.state = record.state.value === undefined ? EMPTY : { status: 'live', value: record.state.value }
  }

  private notify(record: ResourceRecord): void {
    for (const listener of [...record.subscribers]) {
      try { listener() } catch (error: unknown) { console.error('[web-runtime] Workspace resource listener failed:', error) }
    }
  }
}
