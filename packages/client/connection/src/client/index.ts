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
  SessionHistoryIndex, SessionHistoryIndexItem, ToolEventView,
  DirectoryEntry, DirectoryListing,
  ToolCallView, ToolResultView, WorkspaceApi, WorkspaceId, WorkspaceView,
  SkillsApi, SkillEntry,
  ModelCatalogFailure, ModelCatalogModel, ModelProviderGroup, ModelReasoning,
  MessageId, ModelReasoningEffort, ModelSelection, QueueAction, QueuedInboxItem, SessionModels,
  SubagentsApi, SubagentAddress, SubagentCatalog, SubagentListEntry, SubagentPromptContentPart, SubagentPromptReceipt,
  JobView,
  RpcRequest, RpcResponse, RpcResult, RpcError, RpcErrorCode,
  ClientRequest, ServerResponse, ServerRequest, ClientResponse, RpcMessage, RpcReceipt,
  HostDescription, IApiClient, ConnectionRuntimeTarget, SessionDraftId, SessionId, SessionEvent, ContentBlock, StreamChunk,
  GoalsApi, GoalRef,
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
  /** Create an independent authenticated transport for another runtime target. */
  readonly forTarget?: (target: ConnectionRuntimeTarget) => ConnectionHandle
  /** Resolve a session-addressed operation through its owning runtime transport. */
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
): ConnectionHandle {
  let started = false
  let controller: ConnectionController | undefined
  let description: HostDescription | undefined
  let state: ConnectionState | undefined
  let sessionTarget: ((sessionId: SessionId) => ConnectionRuntimeTarget | undefined) | undefined
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
    forTarget: next => createConnectionHandle(
      new WebApiClient(next),
      pageLocation,
      bootstrapRecovery,
      createWebConnectionRpc(undefined, next),
      undefined,
      undefined,
    ),
    forSession: (id) => {
      const target = sessionTarget?.(id)
      return target === undefined ? handle : handle.forTarget?.(target) ?? handle
    },
    registerSessionTargetResolver: (resolve) => {
      if (sessionTarget !== undefined) throw new Error('connection: session target resolver is already registered')
      sessionTarget = resolve
      return () => { if (sessionTarget === resolve) sessionTarget = undefined }
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
          publishDescription(undefined)
          publishState(undefined)
        },
      }
    },
  }
  return handle
}

export function apply(ctx: Context): void {
  const pageLocation = typeof location === 'undefined' ? undefined : location
  const fixture = pageLocation !== undefined && new URLSearchParams(pageLocation.search).has('fixture')
  const fixtureClient = fixture ? new FixtureApiClient() : undefined
  const transport = (globalThis as ClientTransportGlobal).__DSH_TRANSPORT__
  const api: IApiClient = fixtureClient ?? transport?.createApiClient() ?? new WebApiClient()
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
  const handle = createConnectionHandle(
    api,
    pageLocation,
    bootstrapRecovery,
    rpc,
    accountPreferences,
    projectModelSettings,
  )
  ctx.provide('connection', handle)
}
