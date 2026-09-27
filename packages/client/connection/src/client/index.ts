/**
 * Browser wire client. The plugin selects fixture or HTTP transport, provides
 * the shared API client, and lets the runtime object layer start the stream
 * controller with its sinks.
 */
import { createBrowserIdentityFence, type BrowserIdentityFence } from './identity-fence.ts'
import { sessionAddressApi } from './session-api.ts'
export { clientSessionKey, parseClientSessionKey } from '@deepseek-ai/dsh-host-apiproxy/api'
export type { ClientSessionAddress, ClientSessionKey } from '@deepseek-ai/dsh-host-apiproxy/api'

import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRuntimeTarget, HostDescription, IApiClient, SessionId } from './api.ts'
import { ConnectionController, resolveConnectionConfig, type ConnectionConfig, type ConnectionSinks, type ConnectionState } from './connection.ts'
import { FixtureApiClient } from './fixture.ts'
import { WebApiClient } from './web-api-client.ts'
import {
  createBrowserAccountPreferencesTransport,
  type AccountPreferencesTransport,
} from './account-preferences.ts'
import {
  createBrowserProjectModelSettingsTransport,
  type ProjectModelSettingsTransport,
} from './project-models.ts'
import { createWebConnectionRpc, type RpcFetch } from './rpc.ts'
import { isLoopbackHostname } from '../loopback-hostname.ts'
import type { ClientConnectionRpc } from '../rpc.ts'

// ---- Contract re-exports (browser-safe apiproxy channels + core types) ----
export type {
  ApiProxy, SessionsApi, SessionSearchItem, SessionSummary, PromptContentPart, HostApi, EventsApi, MuxFrame, HostFrame,
  ApprovalResponsePayload, QuestionResponsePayload, HistoryDetail, HistoryEntry, HistoryOmittedSpan,
  SessionAssistantStreamBaseline, SessionAssistantStreamFrame,
  SessionHistoryIndex, SessionHistoryIndexItem, ToolEventView,
  DirectoryEntry, DirectoryListing, DesktopConfirmation,
  ToolCallView, ToolResultView, WorkspaceApi, WorkspaceId, WorkspaceView,
  WorkspaceFilesApi, WorkspaceFileByteWindow, WorkspaceOfficePreview, WorkspaceFileEntry, WorkspaceFileStat, WorkspaceFileTextPage,
  SkillsApi, SkillEntry,
  ModelCatalogFailure, ModelCatalogModel, ModelProviderGroup, ModelReasoning,
  MessageId, ModelReasoningEffort, ModelSelection, QueueAction, QueuedInboxItem, SessionModels,
  SubagentsApi, SubagentAddress, SubagentCatalog, SubagentListEntry, SubagentPromptContentPart, SubagentPromptReceipt,
  JobView,
  RpcRequest, RpcResponse, RpcResult, RpcError, RpcErrorCode,
  ClientRequest, ServerResponse, ServerRequest, ClientResponse, RpcMessage, RpcReceipt,
  HostDescription, IApiClient, ConnectionRuntimeTarget, SessionDraftId, SessionId, SessionEvent, ContentBlock, StreamChunk,
  GoalRef,
  SettingsApi, SettingsNamespaceView, SettingsOwner, SettingsPathOpView, SettingsSecretView, SettingsWritableReason,
  CredentialsApi, CredentialView, ConfigurableProviderView, DiscoveredModelView, LlmApi,
} from './api.ts'
export {
  RpcId,
  AbstractApiClient,
  transportError,
} from './api.ts'

// Connection loop types are public through ConnectionHandle.start; the
// controller remains package-internal.
export type { ConnectionFailure } from './connection.ts'
export { ApiTransportError } from './api.ts'
export type { ConnectionConfig, ConnectionSinks, ConnectionState }
export type { ClientConnectionRpc } from '../rpc.ts'
export type { RpcFetch } from './rpc.ts'
export type {
  AccountPreferenceMutation, AccountPreferenceNamespace, AccountPreferencesTransport, AccountPreferencesView,
} from './account-preferences.ts'
export { AccountPreferencesRequestError, createBrowserAccountPreferencesTransport, parseAccountPreferences } from './account-preferences.ts'
export type {
  ProjectModelGroup, ProjectModelProviderView, ProjectModelSettingsTransport, ProjectModelSettingsView,
} from './project-models.ts'
export {
  createBrowserProjectModelSettingsTransport, parseProjectModelSettings, ProjectModelSettingsRequestError,
} from './project-models.ts'

/** Observable Host description published by each completed connection handshake. */
export interface HostDescriptionSource {
  /** Latest connected-generation description; absent before connect and while reconnecting. */
  getSnapshot(): HostDescription | undefined
  /** Subscribe to description replacement and connection loss. */
  subscribe(listener: () => void): () => void
}

/** Observable recovery state for the connection loop. */
export interface ConnectionStateSource {
  /** Current state, or undefined before the first connection outcome. */
  getSnapshot(): ConnectionState | undefined
  /** Subscribe to state changes. */
  subscribe(listener: () => void): () => void
}

/** Required services (none — this is the wire root). */
export const inject: string[] = []

/**
 * Optional carrier override installed before client plugin boot. The ordinary
 * web page leaves it unset and uses HTTP/WebSocket; embedded or worker hosts
 * can provide their own API, RPC, and bundle transports.
 */
export interface ClientTransportHooks {
  /** Build the API carrier, including its downstream event streams. */
  createApiClient(): IApiClient
  /** Transport for generic unary RPC channels. */
  fetch: RpcFetch
  /** Optional account-preference carrier for embedded hosts. */
  createAccountPreferencesTransport?(): AccountPreferencesTransport
  /** Optional project-Provider carrier for embedded hosts. */
  createProjectModelSettingsTransport?(): ProjectModelSettingsTransport
  /** Bundle transport for hosts whose carrier owns plugin bundle bytes. */
  loadBundle?(url: string): Promise<void>
}

interface ClientTransportGlobal {
  __DSH_TRANSPORT__?: ClientTransportHooks
  __DSH_CONNECTION_RECOVERY__?: unknown
}

function targetKey(target: ConnectionRuntimeTarget): string {
  return target.kind === 'personal' ? 'personal' : `project:${String(target.projectId)}`
}

/**
 * Handles derived from one root connection share this state: the session
 * resolver is registered once on the base connection, and target handles are
 * memoized so a consumer resolving an already-opened runtime receives the same
 * started handle the runtime pool drives instead of a second unstarted loop.
 */
interface ConnectionShared {
  readonly identity?: BrowserIdentityFence
  root: ConnectionHandle | undefined
  readonly handles: Map<string, ConnectionHandle>
  sessionTarget?: ((sessionId: SessionId) => ConnectionRuntimeTarget | undefined) | undefined
  originalSession?: ((key: SessionId) => SessionId) | undefined
  mapRemote?: ((endpoint: string, args: Readonly<Record<string, unknown>>, scopeWire?: string) =>
  Readonly<Record<string, unknown>>) | undefined
  baseTarget?: ConnectionRuntimeTarget
  targetListeners?: Set<(target: ConnectionRuntimeTarget) => void>
  remoteSession?: ((endpoint: string, args: Readonly<Record<string, unknown>>) => SessionId | undefined) | undefined
}

/**
 * The ctx.connection service API: the API client plus a one-shot
 * controller starter (the runtime plugin supplies sinks when its object layer
 * is ready — connection stays consumer-agnostic).
 */
export interface ConnectionHandle {
  /** Shared api client (fixture or real, decided at boot from the page URL). */
  readonly api: IApiClient
  /** Raw per-runtime carrier, for owners that already hold original Host IDs. */
  readonly wireApi?: IApiClient
  /** Optional Gateway account-preference transport; absent in fixture-only hosts. */
  readonly accountPreferences?: AccountPreferencesTransport
  /** Gateway project Provider transport shared by project settings surfaces. */
  readonly projectModelSettings?: ProjectModelSettingsTransport
  /** Whether the current page authority is loopback; non-browser contexts default to true. */
  readonly isLoopback: boolean
  /** Generation-scoped Host facts, including the account home and native path-open capability. */
  readonly hostDescription: HostDescriptionSource
  /** Current connection state; undefined before the first outcome or after stop. */
  readonly state: ConnectionStateSource
  /** Generic logical RPC channels over the same Connection transport. */
  readonly rpc: ClientConnectionRpc
  /**
   * Resolve another runtime target's authenticated transport. Target handles
   * are memoized per runtime: callers share the pool-started connection, so
   * `state`, `hostDescription`, and `rpc` observe the live loop.
   */
  readonly forTarget?: (target: ConnectionRuntimeTarget) => ConnectionHandle
  /**
   * Resolve a session-addressed operation through the pooled connection of the
   * runtime that owns the session; falls back to this connection while the
   * session's owner is the base runtime or unresolved.
   */
  readonly forSession?: (sessionId: SessionId) => ConnectionHandle
  /** Register the runtime object's session-to-target resolver. */
  readonly registerSessionTargetResolver?: (
    resolve: (sessionId: SessionId) => ConnectionRuntimeTarget | undefined,
    remoteSession?: (endpoint: string, args: Readonly<Record<string, unknown>>) => SessionId | undefined,
    originalSession?: (key: SessionId) => SessionId,
    mapRemote?: (endpoint: string, args: Readonly<Record<string, unknown>>, scopeWire?: string) => Readonly<Record<string, unknown>>,
  ) => () => void
  /** Read this application's explicitly declared Remote Session address, including JSON request parameters. */
  readonly sessionForRemote?: (endpoint: string, args: Readonly<Record<string, unknown>>) => SessionId | undefined
  /** Translate declared Remote Session addresses to original wire IDs. */
  readonly mapRemoteArguments?: (endpoint: string, args: Readonly<Record<string, unknown>>, scopeWire?: string) =>
  Readonly<Record<string, unknown>>
  /** Bind the bootstrap carrier to its verified account runtime. */
  readonly setBaseTarget?: (target: ConnectionRuntimeTarget) => void
  /** Subscribe to the bootstrap runtime declared by its first HTTP handshake. */
  readonly onRuntimeTarget?: (listener: (target: ConnectionRuntimeTarget) => void) => () => void
  /** Pin an application-generated private download or preview URL to this document’s account. */
  readonly privateResourceUrl?: (value: string) => string
  /** Confirm the authenticated account observed by the page's account service. */
  readonly confirmPrincipal?: (id: number) => void
  /** Withdraw account-owned content and reload after explicit bootstrap authorization loss. */
  readonly invalidatePrincipal?: () => void
  /** Dispose account-owned state before this document reloads after an identity change. */
  readonly onPrincipalChange?: (cleanup: () => void | Promise<void>) => () => void
  /** Request an immediate retry of the current connection generation. */
  reconnect(): void
  /**
   * Start the connect/pump/reconnect loop with the consumer's frame sinks.
   * One consumer owns the streams (the runtime object layer); a second call
   * throws.
   * @param sinks - frame/state callbacks.
   * @param config - reconnect/backoff tunables.
   * @returns stop handle for the loop.
   */
  start(sinks: ConnectionSinks, config?: ConnectionConfig): { stop(): void }
}

/**
 * Client plugin body: pick the api by page mode and provide ctx.connection.
 * @param ctx - client cordis context.
 */
function createConnectionHandle(
  api: IApiClient,
  pageLocation: Location | undefined,
  bootstrapRecovery: Required<ConnectionConfig>,
  rpc: ClientConnectionRpc,
  accountPreferences?: AccountPreferencesTransport,
  projectModelSettings?: ProjectModelSettingsTransport,
  shared?: ConnectionShared,
  target?: ConnectionRuntimeTarget,
): ConnectionHandle {
  const sharedState = shared ?? { root: undefined, handles: new Map<string, ConnectionHandle>() }
  const ownKey = (): string => targetKey(target ?? sharedState.baseTarget ?? { kind: 'personal' })
  let started = false
  let controller: ConnectionController | undefined
  let description: HostDescription | undefined
  let state: ConnectionState | undefined
  const descriptionListeners = new Set<() => void>()
  const stateListeners = new Set<() => void>()
  const publishDescription = (next: HostDescription | undefined): void => {
    if (Object.is(description, next)) return
    description = next
    for (const listener of [...descriptionListeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[web-runtime] host-description listener threw:', error)
      }
    }
  }
  const publishState = (next: ConnectionState | undefined): void => {
    if (Object.is(state, next)) return
    state = next
    for (const listener of [...stateListeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[web-runtime] connection-state listener threw:', error)
      }
    }
  }
  const routedApi = sessionAddressApi(api, (key) => {
    if (sharedState.originalSession === undefined) throw new Error('Session routing is not ready')
    const selected = handle.forSession?.(key) ?? handle
    return { api: selected.wireApi ?? selected.api, sessionId: sharedState.originalSession(key) }
  })
  const handle: ConnectionHandle = {
    wireApi: api,
    get api() { return sharedState.originalSession === undefined ? api : routedApi },
    ...(accountPreferences === undefined ? {} : { accountPreferences }),
    ...(projectModelSettings === undefined ? {} : { projectModelSettings }),
    isLoopback: pageLocation === undefined || isLoopbackHostname(pageLocation.hostname),
    hostDescription: {
      getSnapshot: () => description,
      subscribe: (listener) => {
        descriptionListeners.add(listener)
        return () => { descriptionListeners.delete(listener) }
      },
    },
    state: {
      getSnapshot: () => state,
      subscribe: (listener) => {
        stateListeners.add(listener)
        return () => { stateListeners.delete(listener) }
      },
    },
    rpc,
    forTarget: (next) => {
      const key = targetKey(next)
      if (key === ownKey()) return handle
      if (sharedState.root !== undefined && key === targetKey(sharedState.baseTarget ?? { kind: 'personal' })) return sharedState.root
      const existing = sharedState.handles.get(key)
      if (existing !== undefined) return existing
      const child = createConnectionHandle(
        new WebApiClient(next, undefined, undefined, sharedState.identity?.socketUrl),
        pageLocation,
        bootstrapRecovery,
        createWebConnectionRpc(undefined, next),
        undefined,
        undefined,
        sharedState,
        next,
      )
      sharedState.handles.set(key, child)
      return child
    },
    forSession: (id) => {
      const target = sharedState.sessionTarget?.(id)
      if (target === undefined) return sharedState.root ?? handle
      return handle.forTarget?.(target) ?? sharedState.root ?? handle
    },
    sessionForRemote: (endpoint, args) => sharedState.remoteSession?.(endpoint, args),
    mapRemoteArguments: (endpoint, args, scopeWire) => sharedState.mapRemote?.(endpoint, args, scopeWire) ?? args,
    setBaseTarget: (next) => {
      sharedState.identity?.setRuntimeTarget(next)
      const changed = sharedState.baseTarget === undefined || targetKey(sharedState.baseTarget) !== targetKey(next)
      sharedState.baseTarget = next
      if (changed) for (const listener of sharedState.targetListeners ?? []) listener(next)
    },
    onRuntimeTarget: (listener) => {
      const listeners = sharedState.targetListeners ??= new Set()
      listeners.add(listener)
      if (sharedState.baseTarget !== undefined) listener(sharedState.baseTarget)
      return () => { listeners.delete(listener) }
    },
    registerSessionTargetResolver: (resolve, remoteSession, originalSession, mapRemote) => {
      if (sharedState.sessionTarget !== undefined) throw new Error('connection: session target resolver is already registered')
      sharedState.sessionTarget = resolve
      sharedState.remoteSession = remoteSession
      sharedState.originalSession = originalSession
      sharedState.mapRemote = mapRemote
      return () => {
        if (sharedState.sessionTarget !== resolve) return
        sharedState.sessionTarget = undefined
        sharedState.remoteSession = undefined
        sharedState.originalSession = undefined
        sharedState.mapRemote = undefined
      }
    },
    privateResourceUrl: value => sharedState.identity?.privateUrl(value) ?? value,
    confirmPrincipal: (id) => { sharedState.identity?.confirm(id) },
    invalidatePrincipal: () => { sharedState.identity?.invalidate() },
    onPrincipalChange: cleanup => sharedState.identity?.subscribe(cleanup) ?? (() => {}),
    reconnect() {
      controller?.reconnect()
    },
    start(sinks, config) {
      if (started) throw new Error('connection: the stream loop is already owned by another consumer')
      started = true
      controller = new ConnectionController(api, {
        ...sinks,
        onConnected: (next) => {
          if (target === undefined && next.runtimeTarget !== undefined) handle.setBaseTarget?.(next.runtimeTarget)
          publishDescription(next)
          // A description subscriber may synchronously stop the loop. In that
          // case publishDescription(undefined) has already retracted this
          // generation, so do not leak its stale connected notification to
          // the consumer sink afterward.
          if (!Object.is(description, next)) return
          sinks.onConnected?.(next)
        },
        onStateChange: (state) => {
          if (state === 'reconnecting') publishDescription(undefined)
          publishState(state)
          sinks.onStateChange?.(state)
        },
      }, { ...bootstrapRecovery, ...config })
      controller.start()
      const stopIdentity = sharedState.identity?.subscribe(() => {
        controller?.stop(); publishDescription(undefined); publishState(undefined)
      })
      return {
        stop: () => {
          stopIdentity?.()
          controller?.stop()
          controller = undefined
          if (target !== undefined && sharedState.handles.get(ownKey()) === handle) {
            sharedState.handles.delete(ownKey())
          }
          publishDescription(undefined)
          publishState(undefined)
        },
      }
    },
  }
  if (sharedState.root === undefined) sharedState.root = handle
  return handle
}

export function apply(ctx: Context): void {
  const pageLocation = typeof location === 'undefined' ? undefined : location
  const fixture = pageLocation !== undefined && new URLSearchParams(pageLocation.search).has('fixture')
  const fixtureClient = fixture ? new FixtureApiClient() : undefined
  const transport = (globalThis as ClientTransportGlobal).__DSH_TRANSPORT__
  const nativeFetch = globalThis.fetch
  const identity = fixtureClient === undefined && transport === undefined && pageLocation?.origin !== undefined
    && /^https?:\/\//u.test(pageLocation.origin)
    ? createBrowserIdentityFence(nativeFetch, pageLocation.origin, () => { pageLocation.reload() }) : undefined
  if (identity !== undefined) {
    globalThis.fetch = identity.fetch
    ctx.effect(() => () => {
      identity.dispose()
      if (globalThis.fetch === identity.fetch) globalThis.fetch = nativeFetch
    }, 'connection: authenticated document requests')
  }
  const api: IApiClient = fixtureClient ?? transport?.createApiClient()
    ?? new WebApiClient(undefined, undefined, undefined, identity?.socketUrl, (description) => {
      if (description.executionAuthorityRequired === true && description.runtimeTarget === undefined) {
        throw new Error('Managed Host did not declare its runtime identity')
      }
      if (description.runtimeTarget === undefined) identity?.setRuntimeTarget(undefined)
      else handle.setBaseTarget?.(description.runtimeTarget)
    })
  const accountPreferences = fixtureClient === undefined
    ? transport?.createAccountPreferencesTransport?.() ?? createBrowserAccountPreferencesTransport()
    : undefined
  const projectModelSettings = fixtureClient === undefined
    ? transport?.createProjectModelSettingsTransport?.() ?? createBrowserProjectModelSettingsTransport()
    : undefined
  const bootstrapRecovery = resolveConnectionConfig(
    (globalThis as ClientTransportGlobal).__DSH_CONNECTION_RECOVERY__ as ConnectionConfig | undefined ?? {},
  )
  const rpc = fixtureClient?.rpc ?? createWebConnectionRpc(transport?.fetch)
  const handle: ConnectionHandle = createConnectionHandle(
    api,
    pageLocation,
    bootstrapRecovery,
    rpc,
    accountPreferences,
    projectModelSettings,
    { root: undefined, handles: new Map(), ...(identity === undefined ? {} : { identity }) },
  )
  ctx.provide('connection', handle)
}

export { ConnectionRpcStreamInterrupted } from '../rpc-stream.ts'
