/** Gateway-entry policy, shared by browser features without borrowing a selected Runtime's identity. @module */
import { createSnapshotStore } from './contract/store.ts'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ProjectUiPolicyRuntime } from './project-policy.ts'
import type { SessionRuntimeTarget } from './contract/sessions.ts'
import { readApiResponseJson } from '@deepseek-ai/dsh-host-apiproxy/client'

type NodeId = NonNullable<SessionRuntimeTarget['nodeId']>
/** Authenticated origin-wide deployment facts; no browser preference can change them. */
export interface ClientDeploymentContext {
  mode: 'single' | 'multi'
  revision: string
  entry: { nodeId: NodeId; name: string }
  primary: { nodeId: NodeId; name: string; origin: string } | null
  scope: 'local' | 'organization'
  role: 'standalone' | 'primary' | 'computer'
  refreshAfterMs: number
  legacyMigrationRequired: boolean
}
/** Stable presentation state; current views survive transient policy-read failures. */
export interface DeploymentContextSnapshot {
  phase: 'unknown' | 'ready' | 'error'
  context?: ClientDeploymentContext
  /** Last verified origin mode keeps location labels stable while account proof refreshes. */
  showComputer: boolean
  aggregateComputers: boolean
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid deployment context')
  return value as Record<string, unknown>
}
function node(value: unknown): ClientDeploymentContext['entry'] {
  const row = object(value)
  if (typeof row.nodeId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(row.nodeId)
    || typeof row.name !== 'string') throw new Error('Invalid deployment entry')
  return { nodeId: row.nodeId as NodeId, name: row.name }
}
function parse(value: unknown): ClientDeploymentContext {
  const row = object(value)
  if (row.mode !== 'single' && row.mode !== 'multi' || typeof row.revision !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(row.revision)
    || row.scope !== 'local' && row.scope !== 'organization' || !['standalone', 'primary', 'computer'].includes(String(row.role))
    || typeof row.refreshAfterMs !== 'number' || !Number.isSafeInteger(row.refreshAfterMs) || row.refreshAfterMs < 1 || row.refreshAfterMs > 2_147_483_647
    || typeof row.legacyMigrationRequired !== 'boolean') throw new Error('Invalid deployment policy')
  const primary = row.primary === null ? null : { ...node(row.primary), origin: object(row.primary).origin }
  if (primary !== null && typeof primary.origin !== 'string') throw new Error('Invalid primary origin')
  if (row.mode === 'multi' && primary === null || row.role === 'primary' && row.scope !== 'organization'
    || row.scope === 'organization' && (row.mode !== 'multi' || row.role !== 'primary' || primary?.nodeId !== node(row.entry).nodeId)) {
    throw new Error('Invalid deployment aggregation scope')
  }
  return { mode: row.mode, revision: row.revision, entry: node(row.entry),
    primary: primary === null ? null : { ...primary, origin: primary.origin as string }, scope: row.scope,
    role: row.role as ClientDeploymentContext['role'], refreshAfterMs: row.refreshAfterMs,
    legacyMigrationRequired: row.legacyMigrationRequired }
}

/** One account-scoped policy reader per browser document; cross-tab messages only invalidate its cached revision. */
export class DeploymentContextRuntime {
  private readonly store = createSnapshotStore<DeploymentContextSnapshot>({ phase: 'unknown', showComputer: false, aggregateComputers: false })
  /** Read the stable, account-scoped entry policy. */
  readonly getSnapshot = this.store.getSnapshot
  /** Observe entry policy changes without observing or replacing the current Runtime. */
  readonly subscribe = this.store.subscribe
  private flight: Promise<void> | undefined
  private followUp: Promise<void> | undefined
  private invalidated = false
  private readonly pending = new Set<Promise<void>>()
  private request: AbortController | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private account: number | undefined
  private managed = false
  private disposed = false

  constructor(private readonly timing: ConnectionHandle['metadataTiming']) {}

  private schedule(): void {
    clearTimeout(this.timer)
    if (this.disposed || !this.managed || this.account === undefined || globalThis.document?.visibilityState === 'hidden') return
    const interval = this.store.getSnapshot().context?.refreshAfterMs ?? this.timing.retryAfterMs
    this.timer = setTimeout(() => { void this.refresh() }, interval)
  }

  /** Read current entry policy; metadata requests never connect to other Runtimes. */
  refresh = (): Promise<void> => {
    if (this.disposed || this.flight !== undefined || !this.managed || this.account === undefined) return this.flight ?? Promise.resolve()
    const account = this.account, request = new AbortController()
    this.request = request
    let expired = false
    const deadline = setTimeout(() => { expired = true; request.abort() }, this.timing.requestTimeoutMs)
    const flight = (async () => {
      const response = await fetch('/account/api/deployment/context', { credentials: 'same-origin', cache: 'no-store',
        signal: request.signal, headers: { accept: 'application/json', 'x-dsh-expected-principal-id': String(account) } })
      if (!response.ok) throw new Error(`Deployment context returned HTTP ${response.status}`)
      const context = parse(await readApiResponseJson(response))
      if (request.signal.aborted || account !== this.account) return
      const previous = this.store.getSnapshot()
      if (previous.phase !== 'ready' || JSON.stringify(previous.context) !== JSON.stringify(context)) {
        this.store.set({ phase: 'ready', context, showComputer: context.mode === 'multi',
          aggregateComputers: context.mode === 'multi' && context.scope === 'organization' })
      }
    })().catch((error: unknown) => {
      if (this.request === request && (!request.signal.aborted || expired)) {
        this.store.set({ ...this.store.getSnapshot(), phase: 'error' })
        console.error('[deployment-context] Could not verify deployment settings:', error)
      }
    }).finally(() => {
      clearTimeout(deadline)
      this.pending.delete(flight)
      if (this.request !== request) return
      this.request = undefined; this.flight = undefined
      this.schedule()
    })
    this.flight = flight; this.pending.add(flight)
    return flight
  }

  /** Reread after an in-flight snapshot when a mode change invalidates it; repeated invalidations coalesce. */
  invalidate = (): Promise<void> => {
    if (this.flight === undefined) return this.refresh()
    this.invalidated = true
    if (this.followUp !== undefined) return this.followUp
    const account = this.account
    const work = this.flight.then(async () => {
      while (this.invalidated && !this.disposed && account === this.account) {
        this.invalidated = false
        await this.refresh()
      }
    }).finally(() => { this.pending.delete(work); if (this.followUp === work) this.followUp = undefined })
    this.followUp = work; this.pending.add(work)
    return work
  }

  /**
   * Follow verified account and Host ownership until this runtime is disposed.
   * @param connection - bootstrap Host metadata, independent of selected conversation transport.
   * @param policy - existing verified-account lifetime owner.
   * @returns async disposer joining the final metadata request.
   */
  start(connection: ConnectionHandle, policy: ProjectUiPolicyRuntime): () => Promise<void> {
    const changed = (): void => {
      const next = policy.getSnapshot().verifiedAccountId
      if (next !== this.account) {
        this.account = next; this.request?.abort(); this.request = undefined; this.flight = undefined; this.followUp = undefined
        this.invalidated = false
        clearTimeout(this.timer)
        this.store.set({ phase: 'unknown', showComputer: this.store.getSnapshot().showComputer, aggregateComputers: false })
      }
      const description = connection.hostDescription.getSnapshot()
      this.managed = description?.executionAuthorityRequired === true
      if (description !== undefined && !this.managed) {
        this.request?.abort(); this.request = undefined; this.flight = undefined; this.followUp = undefined; clearTimeout(this.timer)
        this.invalidated = false
        if (this.store.getSnapshot().phase !== 'ready' || this.store.getSnapshot().context !== undefined) {
          this.store.set({ phase: 'ready', showComputer: false, aggregateComputers: false })
        }
      }
      void this.refresh()
    }
    const focus = (): void => { if (globalThis.document?.visibilityState !== 'hidden') void this.invalidate(); else clearTimeout(this.timer) }
    const stopAccount = policy.subscribe(changed), stopHost = connection.hostDescription.subscribe(changed)
    const channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel('hgw-deployment-policy')
    if (channel !== undefined) channel.onmessage = (event) => {
      if (typeof event.data === 'object' && event.data !== null && typeof event.data.revision === 'string') void this.invalidate()
    }
    globalThis.addEventListener?.('focus', focus)
    globalThis.document?.addEventListener('visibilitychange', focus)
    changed()
    return async () => {
      this.disposed = true; clearTimeout(this.timer); this.request?.abort(); channel?.close()
      stopAccount(); stopHost(); globalThis.removeEventListener?.('focus', focus)
      globalThis.document?.removeEventListener('visibilitychange', focus)
      await Promise.all([...this.pending])
    }
  }
}
