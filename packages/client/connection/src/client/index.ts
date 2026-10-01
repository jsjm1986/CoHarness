/**
 * Browser wire client. The plugin selects fixture or HTTP transport, provides
 * the shared API client, and lets the runtime object layer start the stream
 * controller with its sinks.
 */
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
  JobView, JobsApi, JobChannel, JobKillValue, JobOutputChunk, JobOutputCoords, JobOutputValue,
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
export type { ClientConnectionRpc, ConnectionRpcResult } from '../rpc.ts'
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
  /**
   * Build the API carrier, including its downstream event streams; unused in
   * fixture mode. Absent members fall back to the browser HTTP carrier.
   */
  createApiClient?(): IApiClient
  /**
   * Already decoded logical RPC carrier. When present it replaces the HTTP
   * caller outright: no envelopes and no `fetch` (an in-process Host such as
   * a test mock plugs in here).
   */
  rpc?: ClientConnectionRpc
  /** Transport for generic unary RPC channels; unused when `rpc` is present. */
  fetch?: RpcFetch
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

/** Browser location fields used to classify loopback authority and detect fixture mode. */
export interface ConnectionLocation {
  readonly hostname: string
  /** Page query; `?fixture` selects the in-page fixture carrier. */
  readonly search?: string
}

/** Instance-local inputs for installing a Connection service. */
export interface ConnectionInstallOptions {
  /** Explicit physical carrier; omit for the browser HTTP carrier. */
  readonly transport?: ClientTransportHooks
  /** Reconnect timing overrides; omitted fields use controller defaults. */
  readonly recovery?: ConnectionConfig
  /** Page location; omit for a non-browser composition. */
  readonly location?: ConnectionLocation
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
  root: ConnectionHandle | undefined
  readonly handles: Map<string, ConnectionHandle>
  sessionTarget?: ((sessionId: SessionId) => ConnectionRuntimeTarget | undefined) | undefined
}

/**
 * The ctx.connection service API: the API client plus a one-shot
 * controller starter (the runtime plugin supplies sinks when its object layer
 * is ready — connection stays consumer-agnostic).
 */
export interface ConnectionHandle {
  /** Shared api client (fixture or real, decided at boot from the page URL). */
  readonly api: IApiClient
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
  readonly registerSessionTargetResolver?: (resolve: (sessionId: SessionId) => ConnectionRuntimeTarget | undefined) => () => void
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
 * The carriers one page composition uses for the root handle and every pooled
 * target handle derived from it: an explicit transport (or the fixture)
 * supplies the api and RPC faces; an unset composition uses the browser HTTP
 * carrier per target.
 */
interface ConnectionCarrier {
  readonly api: IApiClient
  readonly rpc: ClientConnectionRpc
  readonly transport: ClientTransportHooks | undefined
  readonly fixture: FixtureApiClient | undefined
}

/**
 * Resolve the carrier of one runtime target under the page's composition.
 * @param target - runtime target the handle will serve.
 * @returns api and RPC faces for that target.
 */
function carrierOf(carrier: ConnectionCarrier, target: ConnectionRuntimeTarget | undefined): Pick<ConnectionCarrier, 'api' | 'rpc'> {
  if (carrier.fixture !== undefined) return { api: carrier.fixture, rpc: carrier.fixture.rpc }
  const transport = carrier.transport
  if (transport !== undefined) {
    return {
      // A transport without its own api builder (fetch/rpc only) still gets the
      // per-target browser carrier; one with an in-process api shares it.
      api: transport.createApiClient?.() ?? new WebApiClient(target),
      rpc: transport.rpc ?? createWebConnectionRpc(transport.fetch, target),
    }
  }
  return {
    api: new WebApiClient(target),
    rpc: createWebConnectionRpc(undefined, target),
  }
}

/**
 * Build the handle body shared by the root connection and pooled target handles.
 * @param api - target's API carrier.
 * @param pageLocation - page location used for loopback classification.
 * @param bootstrapRecovery - page-level recovery timings.
 * @param rpc - target's logical RPC carrier.
 * @param accountPreferences - account-preference transport when the carrier supplies one.
 * @param projectModelSettings - project-Provider transport when the carrier supplies one.
 * @param shared - pool state shared across derived handles.
 * @param target - the handle's runtime target (absent for the personal root).
 * @param carrier - the page composition used for derived target handles.
 * @returns the provided connection service.
 */
function createConnectionHandle(
  api: IApiClient,
  pageLocation: ConnectionLocation | undefined,
  bootstrapRecovery: Required<ConnectionConfig>,
  rpc: ClientConnectionRpc,
  accountPreferences?: AccountPreferencesTransport,
  projectModelSettings?: ProjectModelSettingsTransport,
  shared?: ConnectionShared,
  target?: ConnectionRuntimeTarget,
  carrier?: ConnectionCarrier,
): ConnectionHandle {
  const sharedState = shared ?? { root: undefined, handles: new Map<string, ConnectionHandle>() }
  const ownKey = target === undefined ? 'personal' : targetKey(target)
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
  const handle: ConnectionHandle = {
    api,
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
      if (key === ownKey) return handle
      if (key === 'personal') return sharedState.root ?? handle
      const existing = sharedState.handles.get(key)
      if (existing !== undefined) return existing
      const composition = carrier ?? { api, rpc, transport: undefined, fixture: undefined }
      const faces = carrierOf(composition, next)
      const child = createConnectionHandle(
        faces.api,
        pageLocation,
        bootstrapRecovery,
        faces.rpc,
        undefined,
        undefined,
        sharedState,
        next,
        composition,
      )
      sharedState.handles.set(key, child)
      return child
    },
    forSession: (id) => {
      const target = sharedState.sessionTarget?.(id)
      if (target === undefined) return sharedState.root ?? handle
      return handle.forTarget?.(target) ?? sharedState.root ?? handle
    },
    registerSessionTargetResolver: (resolve) => {
      if (sharedState.sessionTarget !== undefined) throw new Error('connection: session target resolver is already registered')
      sharedState.sessionTarget = resolve
      return () => { if (sharedState.sessionTarget === resolve) sharedState.sessionTarget = undefined }
    },
    reconnect() {
      controller?.reconnect()
    },
    start(sinks, config) {
      if (started) throw new Error('connection: the stream loop is already owned by another consumer')
      started = true
      controller = new ConnectionController(api, {
        ...sinks,
        onConnected: (next) => {
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
      return {
        stop: () => {
          controller?.stop()
          controller = undefined
          if (target !== undefined && sharedState.handles.get(ownKey) === handle) {
            sharedState.handles.delete(ownKey)
          }
          publishDescription(undefined)
          publishState(undefined)
        },
      }
    },
  }
  if (shared === undefined) sharedState.root = handle
  return handle
}

/**
 * Install one Context-owned Connection service from explicit composition
 * inputs: the page `?fixture` query picks the in-page fixture, an explicit
 * transport supplies the api/RPC carriers (each member falling back to the
 * browser HTTP carrier), and the recovery override becomes the bootstrap
 * timing every later `start` merges over.
 * @param ctx - client Cordis context.
 * @param options - physical carrier, reconnect timing, and page location.
 */
export function installConnection(ctx: Context, options: ConnectionInstallOptions = {}): void {
  const pageLocation = options.location
  const transport = options.transport
  const fixture = pageLocation?.search !== undefined && new URLSearchParams(pageLocation.search).has('fixture')
  const fixtureClient = fixture ? new FixtureApiClient() : undefined
  const api: IApiClient = fixtureClient ?? transport?.createApiClient?.() ?? new WebApiClient()
  const accountPreferences = fixtureClient === undefined
    ? transport?.createAccountPreferencesTransport?.() ?? createBrowserAccountPreferencesTransport()
    : undefined
  const projectModelSettings = fixtureClient === undefined
    ? transport?.createProjectModelSettingsTransport?.() ?? createBrowserProjectModelSettingsTransport()
    : undefined
  const bootstrapRecovery = resolveConnectionConfig(options.recovery ?? {})
  const rpc = fixtureClient?.rpc ?? transport?.rpc ?? createWebConnectionRpc(transport?.fetch)
  const carrier: ConnectionCarrier = { api, rpc, transport, fixture: fixtureClient }
  const handle = createConnectionHandle(
    api,
    pageLocation,
    bootstrapRecovery,
    rpc,
    accountPreferences,
    projectModelSettings,
    undefined,
    undefined,
    carrier,
  )
  ctx.provide('connection', handle)
}

/**
 * Client plugin body: read the page composition and install its Connection service.
 * @param ctx - client Cordis context.
 */
export function apply(ctx: Context): void {
  const globals = globalThis as ClientTransportGlobal
  const pageLocation = typeof location === 'undefined' ? undefined : location
  const transport = globals.__DSH_TRANSPORT__
  const recovery = globals.__DSH_CONNECTION_RECOVERY__ as ConnectionConfig | undefined
  installConnection(ctx, {
    ...(transport === undefined ? {} : { transport }),
    ...(recovery === undefined ? {} : { recovery }),
    ...(pageLocation === undefined ? {} : { location: pageLocation }),
  })
}

export { ConnectionRpcStreamInterrupted } from '../rpc-stream.ts'
