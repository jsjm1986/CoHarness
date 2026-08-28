/**
 * Process-local dynamic Plugin registry and its opaque identity mints.
 * @module @deepseek-ai/dsh-cordis-host-runner/registry
 */

import type { Fiber } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  ApprovalRequestId, CordisDynamicPackageId, CordisDynamicPluginId, CordisDynamicPluginRunId,
  CordisDynamicRunMode, DynamicCordisRenderFailure, DynamicCordisRunAttempt,
} from './types.ts'

/** Admission limits for process-local dynamic definitions and approvals. */
export interface DynamicCordisRegistryConfig {
  /** Maximum number of live Plugins in the process. */
  readonly maxPlugins: number
  /** Maximum number of Plugins owned by one Session. */
  readonly maxPluginsPerSession: number
  /** Maximum immutable Packages retained by one Plugin. */
  readonly maxPackagesPerPlugin: number
  /** Maximum UTF-8 source bytes retained across all definitions. */
  readonly maxSourceBytes: number
  /** Maximum UTF-8 source bytes retained by one Session. */
  readonly maxSourceBytesPerSession: number
  /** Maximum pending run requests in the process. */
  readonly maxPendingApprovals: number
  /** Maximum pending run requests owned by one Session. */
  readonly maxPendingApprovalsPerSession: number
}

/** One Host method exposed to this package's Client half. */
export type DynamicCordisHandler = (args: unknown) => Promise<unknown>

/** One live activation and everything its teardown owns. */
export interface DynamicCordisRun {
  /** Exact activation identity. */
  pluginRunId: CordisDynamicPluginRunId
  /** Immutable package version being run. */
  packageId: CordisDynamicPackageId
  /** Host-half Fiber, absent for Client-only packages. */
  fiber?: Fiber
  /** Active Host methods. */
  handlers: Map<string, DynamicCordisHandler>
  /** Method registration cleanup. */
  handlerDisposers: (() => void)[]
  /** Runtime failures already sent to the owning Agent during this activation. */
  reportedRuntimeErrors: Set<string>
  /** Last render failure observed for this version's current run. */
  renderFailure?: DynamicCordisRenderFailure
  /** Approval whose transition started this run, when model-driven. */
  startedForRequest?: ApprovalRequestId
}

/** One immutable package version. */
export interface DynamicCordisDefinition {
  /** Package identity. */
  packageId: CordisDynamicPackageId
  /** Package label. */
  name: string
  /** User-facing purpose. */
  purpose: string
  /** Host source. */
  hostCode?: string
  /** Client source. */
  clientCode?: string
}

/** Stable plugin instance containing immutable package versions. */
export interface DynamicCordisPlugin {
  /** Stable identity. */
  pluginId: CordisDynamicPluginId
  /** Owning session. */
  sessionId: SessionId
  /** Versions in define order. */
  packages: Map<CordisDynamicPackageId, DynamicCordisDefinition>
  /** Client-bearing Packages individually authorized by the user. */
  approvedClientPackages: Set<CordisDynamicPackageId>
  /** Whether one user decision authorized future Package versions of this Plugin. */
  clientVersionUpdatesApproved: boolean
  /** Last successfully activated version. */
  currentPackageId?: CordisDynamicPackageId
  /** Failed or in-progress target version. */
  nextPackageId?: CordisDynamicPackageId
  /** Current activation. */
  run?: DynamicCordisRun
  /** Latest activation attempt, including approval and asynchronous failure state. */
  latestRun?: DynamicCordisRunAttempt
}

/** One suspended model-driven activation. */
export interface DynamicCordisPendingRequest {
  /** Session whose model requested this activation. */
  agentId: SessionId
  pluginId: CordisDynamicPluginId
  packageId: CordisDynamicPackageId
  pluginRunId: CordisDynamicPluginRunId
  mode: CordisDynamicRunMode
  /** Whether this request must wait for an explicit user decision. */
  requiresApproval: boolean
}

const sourceEncoder = new TextEncoder()

function definitionSourceBytes(definition: Pick<DynamicCordisDefinition, 'hostCode' | 'clientCode'>): number {
  return (definition.hostCode === undefined ? 0 : sourceEncoder.encode(definition.hostCode).byteLength)
    + (definition.clientCode === undefined ? 0 : sourceEncoder.encode(definition.clientCode).byteLength)
}

/** Request accepted by `define`; it never crosses the Remote transport. */
export interface DynamicCordisDefineRequest {
  /** Session that owns the plugin. */
  sessionId: SessionId
  /** Create a plugin or append to an existing one. */
  plugin:
    | { kind: 'new'; idPrefix: string }
    | { kind: 'existing'; pluginId: CordisDynamicPluginId }
  /** Package label. */
  name: string
  /** User-facing purpose. */
  purpose: string
  /** At least one source half. */
  code: { host?: string; client?: string }
}

/** Successful `define` result. */
export interface DynamicCordisDefineReceipt {
  pluginId: CordisDynamicPluginId
  packageId: CordisDynamicPackageId
  name: string
  purpose: string
  hasHostHalf: boolean
  hasClientHalf: boolean
}

/** Source-free modification context for an explicit `@pluginId` reference. */
export interface DynamicCordisReference {
  pluginId: CordisDynamicPluginId
  packageId: CordisDynamicPackageId
  name: string
  purpose: string
  currentPackageId?: CordisDynamicPackageId
  nextPackageId?: CordisDynamicPackageId
  activeRun?: { pluginRunId: CordisDynamicPluginRunId; packageId: CordisDynamicPackageId }
  latestRun?: DynamicCordisRunAttempt
}

/** Source-free Plugin summary returned by layered self inspection. */
export interface DynamicCordisPluginInspection extends DynamicCordisReference {
  /** Immutable Package summaries in define order. */
  packages: Array<{
    packageId: CordisDynamicPackageId
    name: string
    purpose: string
    hasHostHalf: boolean
    hasClientHalf: boolean
  }>
}

/** Exact immutable Package metadata and source returned by explicit inspection. */
export interface DynamicCordisPackageInspection extends DynamicCordisReference {
  /** Host and Client function bodies stored for this Package. */
  code: { host?: string; client?: string }
}

/** Registry, identity mints, and pending approval index. */
export class DynamicCordisRegistry {
  private readonly config: DynamicCordisRegistryConfig
  private readonly plugins = new Map<CordisDynamicPluginId, DynamicCordisPlugin>()
  private readonly pendingRequests = new Map<ApprovalRequestId, DynamicCordisPendingRequest>()
  private readonly pendingBySession = new Map<SessionId, number>()
  private readonly pluginsBySession = new Map<SessionId, number>()
  private readonly sourceBytesBySession = new Map<SessionId, number>()
  private sourceBytes = 0
  private nextPlugin = 1
  private nextPackage = 1
  private nextRun = 1
  private nextApproval = 1

  /** Create an empty registry with explicit admission limits. */
  constructor(config: DynamicCordisRegistryConfig) {
    this.config = config
  }

  /**
   * Mint a semantic plugin ID without reusing a prior suffix.
   * @param prefix - validated lowercase semantic prefix proposed by the model.
   * @returns a process-unique Plugin ID.
   */
  mintPluginId(prefix: string): string {
    let id: CordisDynamicPluginId
    do id = `${prefix}-${this.nextPlugin++}` as CordisDynamicPluginId
    while (this.plugins.has(id))
    return id
  }

  /**
   * Mint an immutable package ID.
   * @returns a process-unique Package ID.
   */
  mintPackageId(): string {
    return `pkg-${this.nextPackage++}`
  }

  /**
   * Mint an activation ID.
   * @returns a process-unique Plugin Run ID.
   */
  mintPluginRunId(): string {
    return `run-${this.nextRun++}`
  }

  /**
   * Mint an approval ID.
   * @returns a process-unique approval request ID.
   */
  mintApprovalRequestId(): string {
    return `approval-${this.nextApproval++}`
  }

  /**
   * Add one stable plugin.
   * @param plugin - Plugin record to retain under its stable ID.
   */
  add(plugin: DynamicCordisPlugin): void {
    if (this.plugins.has(plugin.pluginId)) throw new Error(`dynamic plugin "${plugin.pluginId}" already exists`)
    this.plugins.set(plugin.pluginId, plugin)
    this.pluginsBySession.set(plugin.sessionId, (this.pluginsBySession.get(plugin.sessionId) ?? 0) + 1)
    const bytes = [...plugin.packages.values()].reduce((sum, definition) => sum + definitionSourceBytes(definition), 0)
    this.sourceBytes += bytes
    this.sourceBytesBySession.set(plugin.sessionId, (this.sourceBytesBySession.get(plugin.sessionId) ?? 0) + bytes)
  }

  /**
   * Check whether a new definition fits every configured registry budget.
   * @param sessionId - owning Session id.
   * @param plugin - existing Plugin for a package update, or undefined for a new Plugin.
   * @param code - Host and Client source whose retained bytes are checked.
   */
  assertDefinitionCapacity(
    sessionId: SessionId,
    plugin: DynamicCordisPlugin | undefined,
    code: Pick<DynamicCordisDefinition, 'hostCode' | 'clientCode'>,
  ): void {
    if (plugin === undefined) {
      if (this.plugins.size >= this.config.maxPlugins) {
        throw new Error(`dynamic Plugin limit reached (limit: ${this.config.maxPlugins})`)
      }
      if ((this.pluginsBySession.get(sessionId) ?? 0) >= this.config.maxPluginsPerSession) {
        throw new Error(`dynamic Plugin limit for Session reached (limit: ${this.config.maxPluginsPerSession})`)
      }
    } else if (plugin.packages.size >= this.config.maxPackagesPerPlugin) {
      throw new Error(`dynamic Package limit for Plugin reached (limit: ${this.config.maxPackagesPerPlugin})`)
    }
    const bytes = definitionSourceBytes(code)
    if (this.sourceBytes + bytes > this.config.maxSourceBytes) {
      throw new Error(`dynamic source-byte limit reached (limit: ${this.config.maxSourceBytes})`)
    }
    if ((this.sourceBytesBySession.get(sessionId) ?? 0) + bytes > this.config.maxSourceBytesPerSession) {
      throw new Error(`dynamic source-byte limit for Session reached (limit: ${this.config.maxSourceBytesPerSession})`)
    }
  }

  /**
   * Retain one immutable Package after its admission check succeeds.
   * @param plugin - Plugin that owns the package.
   * @param definition - immutable package definition to retain.
   */
  addPackage(plugin: DynamicCordisPlugin, definition: DynamicCordisDefinition): void {
    if (plugin.packages.has(definition.packageId)) throw new Error(`dynamic package "${definition.packageId}" already exists`)
    this.assertDefinitionCapacity(plugin.sessionId, plugin, definition)
    plugin.packages.set(definition.packageId, definition)
    const bytes = definitionSourceBytes(definition)
    this.sourceBytes += bytes
    this.sourceBytesBySession.set(plugin.sessionId, (this.sourceBytesBySession.get(plugin.sessionId) ?? 0) + bytes)
  }

  /**
   * Read one plugin.
   * @param id - stable Plugin ID.
   * @returns the Plugin record, or `undefined` when absent.
   */
  get(id: CordisDynamicPluginId): DynamicCordisPlugin | undefined {
    return this.plugins.get(id)
  }

  /**
   * Delete one plugin and all package versions.
   * @param id - stable Plugin ID to remove.
   * @returns whether a Plugin record was removed.
   */
  delete(id: CordisDynamicPluginId): boolean {
    const plugin = this.plugins.get(id)
    if (plugin === undefined) return false
    this.plugins.delete(id)
    const pluginCount = (this.pluginsBySession.get(plugin.sessionId) ?? 1) - 1
    if (pluginCount <= 0) this.pluginsBySession.delete(plugin.sessionId)
    else this.pluginsBySession.set(plugin.sessionId, pluginCount)
    const bytes = [...plugin.packages.values()].reduce((sum, definition) => sum + definitionSourceBytes(definition), 0)
    this.sourceBytes -= bytes
    const sessionBytes = (this.sourceBytesBySession.get(plugin.sessionId) ?? bytes) - bytes
    if (sessionBytes <= 0) this.sourceBytesBySession.delete(plugin.sessionId)
    else this.sourceBytesBySession.set(plugin.sessionId, sessionBytes)
    for (const [requestId, request] of this.pendingRequests) {
      if (request.pluginId === id) this.removePendingRequest(requestId)
    }
    return true
  }

  /**
   * Read all plugins in creation order.
   * @returns a snapshot of every Plugin record.
   */
  all(): DynamicCordisPlugin[] {
    return [...this.plugins.values()]
  }

  /**
   * Read one session's plugins in creation order.
   * @param sessionId - owning session to filter by.
   * @returns a snapshot of matching Plugin records.
   */
  ofSession(sessionId: SessionId): DynamicCordisPlugin[] {
    return this.all().filter(plugin => plugin.sessionId === sessionId)
  }

  /**
   * Publish one pending approval.
   * @param id - approval request ID.
   * @param pending - resolver and Plugin metadata retained until settlement.
   */
  armRequest(id: ApprovalRequestId, pending: DynamicCordisPendingRequest): void {
    if (this.pendingRequests.has(id)) throw new Error(`dynamic approval "${id}" already exists`)
    if (this.pendingRequests.size >= this.config.maxPendingApprovals) {
      throw new Error(`dynamic pending-approval limit reached (limit: ${this.config.maxPendingApprovals})`)
    }
    const pendingForSession = this.pendingBySession.get(pending.agentId) ?? 0
    if (pendingForSession >= this.config.maxPendingApprovalsPerSession) {
      throw new Error(`dynamic pending-approval limit for Session reached (limit: ${this.config.maxPendingApprovalsPerSession})`)
    }
    this.pendingRequests.set(id, pending)
    this.pendingBySession.set(pending.agentId, pendingForSession + 1)
  }

  /**
   * Read one pending approval without claiming it.
   * @param id - approval request ID.
   * @returns the pending request, or `undefined` when absent.
   */
  peekRequest(id: ApprovalRequestId): DynamicCordisPendingRequest | undefined {
    return this.pendingRequests.get(id)
  }

  /**
   * Claim one pending approval; first answer wins.
   * @param id - approval request ID.
   * @returns the claimed request, or `undefined` when already settled.
   */
  claimRequest(id: ApprovalRequestId): DynamicCordisPendingRequest | undefined {
    const pending = this.pendingRequests.get(id)
    if (pending !== undefined) this.removePendingRequest(id)
    return pending
  }

  /**
   * Cancel one pending approval.
   * @param id - approval request ID to remove.
   */
  disarmRequest(id: ApprovalRequestId): void {
    this.removePendingRequest(id)
  }

  /**
   * Find a pending approval for one Plugin.
   * @param pluginId - stable Plugin ID.
   * @returns its approval request ID, or `undefined` when none is pending.
   */
  pendingRequestFor(pluginId: CordisDynamicPluginId): ApprovalRequestId | undefined {
    for (const [requestId, request] of this.pendingRequests) {
      if (request.pluginId === pluginId) return requestId
    }
    return undefined
  }

  private removePendingRequest(id: ApprovalRequestId): void {
    const pending = this.pendingRequests.get(id)
    if (pending === undefined) return
    this.pendingRequests.delete(id)
    const count = (this.pendingBySession.get(pending.agentId) ?? 1) - 1
    if (count <= 0) this.pendingBySession.delete(pending.agentId)
    else this.pendingBySession.set(pending.agentId, count)
  }

  /**
   * Reject a new pending run before the caller mutates its latest attempt.
   * @param sessionId - Session that would own the pending request.
   */
  assertPendingRequestCapacity(sessionId: SessionId): void {
    if (this.pendingRequests.size >= this.config.maxPendingApprovals) {
      throw new Error(`dynamic pending-approval limit reached (limit: ${this.config.maxPendingApprovals})`)
    }
    if ((this.pendingBySession.get(sessionId) ?? 0) >= this.config.maxPendingApprovalsPerSession) {
      throw new Error(`dynamic pending-approval limit for Session reached (limit: ${this.config.maxPendingApprovalsPerSession})`)
    }
  }
}
