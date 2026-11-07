import { DeploymentContextRuntime } from './deployment-context.ts'
import { GatewayEntryRequests } from './entry-requests.ts'
import { ConversationIntents } from './conversation-intents.ts'
export type { ClientDeploymentContext, DeploymentContextSnapshot } from './deployment-context.ts'
/** Browser runtime services for slots, sessions, workspaces, and connection-stream delivery. */
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: the ctx.remote merge. Deliberately the gateway's Client half rather
// than api-remotes': that face imports a Host-tsdown-generated artifact, and this
// project sits in the Host build graph.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { TypertContext } from '@deepseek-ai/dsh-typert-protocol'
import { typertOwnedValue } from '@deepseek-ai/dsh-typert-protocol'
import type { MaybeSnapshotSelectorHook, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from './slots.ts'
import { SessionRuntime } from './sessions/service.ts'
import { SessionRuntimePool } from './sessions/pool.ts'
import type { SessionListState } from './sessions/service.ts'
import { WorkspaceRuntime } from './workspaces/service.ts'
import { installPersonalDirectory } from './personal-directory.ts'
import { createRuntimeEnvironments } from './runtime-environments.ts'
import type { ConversationSnapshot } from './sessions/conversation.ts'
import type { SessionBlankReuseRequest, SessionCreateOptions } from './contract/session-create.ts'
import type { UseProjection } from './sessions/projection-store.ts'
import { ConversationEventRegistry } from './conversation/event-registry.ts'
import { ConversationViewRegistry } from './conversation/view-registry.ts'
import { ProjectUiPolicyRuntime } from './project-policy.ts'
import { PermissionCatalogDirectory } from './permission-catalog.ts'
import { WorkspaceResourceRegistry } from './workspace-resources.ts'

export { isAppendSurfaceEvent, isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session/surface'

export { clientSessionKey, parseClientSessionKey, runtimeTargetKey, addressRuntimeUrl } from '@deepseek-ai/dsh-host-apiproxy/api'
export type { ClientSessionAddress, ClientSessionKey } from '@deepseek-ai/dsh-host-apiproxy/api'
export type { ClientRuntimeTarget } from '@deepseek-ai/dsh-host-apiproxy/api'
export type { RuntimeEnvironment,RuntimeEnvironments } from './runtime-environments.ts'

export { NavigationController, commitSessionNavigation } from './navigation.ts'
export { SlotRegistry } from './slots.ts'
export { ConversationEventRegistry } from './conversation/event-registry.ts'
export { ConversationViewRegistry } from './conversation/view-registry.ts'
export { ConversationNodeAssembler } from './sessions/conversation-assembler.ts'
export { ConversationLocationIndex } from './sessions/conversation-location-index.ts'
export { conversationContextKey } from './contract/conversation.ts'
export type {
  AssistantLiveChunkEvent,
  ChatConversationViewNode, ConversationContextReader, ConversationEventInput,
  ConversationLocationData, ConversationLocationDataScope, ConversationLocationDataSource,
  ConversationLocationDataStore, ConversationStepDataMap,
  ConversationLocation, ConversationMatch, ConversationMatchResult,
  ConversationNodeContext, ConversationNodeDefinition, ConversationPreviousContext,
  ConversationPublication, ConversationTimelineSnapshot, ConversationTurnDataMap, ConversationViewBuilder,
  ConversationViewDefinition, ConversationViewNode, ConversationViewSnapshotMap,
  ConversationViewSnapshotStore, SessionEventLike, StepLocation, TurnLocation,
} from './contract/conversation.ts'
export type { ConversationRuntime } from './sessions/conversation-assembler.ts'
export type { RootOwnerProps } from './slots.ts'
export { SessionCreateError, SessionRuntime, scopeOf, workspaceTitleOf } from './sessions/service.ts'
export { SessionRuntimePool } from './sessions/pool.ts'
export { indexSubagentDescendants } from './sessions/subagent-lineage.ts'
export type { SubagentDescendantSummary } from './sessions/subagent-lineage.ts'
// The provide channel is shared with the client test runtime (one
// materialization/projection implementation; no test-side mirror to drift).
export { SessionProvideChannel } from './sessions/provide.ts'
export type { SessionProvideChannelHost } from './sessions/provide.ts'
export { createScope, scopeIdentityOf } from './scope.ts'
export type { AgentScopeHandle } from './scope.ts'
export { DirectoryBrowseError, WorkspaceArchiveError, WorkspaceCreateError, WorkspaceRuntime } from './workspaces/service.ts'
export { abbreviateHomePath, isAbsoluteWorkspacePath, resolveWorkspacePath } from './workspaces/path.ts'
// Contract only: the scope implementation and its Host transport belong to
// dsh-client-ui-settings (see that package's settings-scope.ts).
export type {
  SettingsControlState, SettingsOwner, SettingsScope, SettingsScopeSnapshot, SettingsScopeSource, SettingsScopeSpec,
  SettingsWritableReason, SettingsWriteState,
} from './contract/settings-scope.ts'
export { settingsControlState, settingsFieldControlState } from './contract/settings-scope.ts'
export { onSettingsNavigation, requestSettingsSection } from './contract/settings-navigation.ts'
export type { SettingsNavigationRequest } from './contract/settings-navigation.ts'
export type { ConversationIntent, ConversationIntentsSnapshot } from './conversation-intents.ts'
export { NodeDraft, type NodeDraftOwner } from './node-draft.ts'
export type { OwnerProjectDisplay, ProjectOwnerRef } from './project-metadata.ts'
export { sessionPersistenceKey } from './session-persistence.ts'
export { PermissionCatalogDirectory, PermissionCatalogMirror } from './permission-catalog.ts'
export type { SessionPermissionCatalog } from './permission-catalog.ts'
export { ProjectUiPolicyRuntime } from './project-policy.ts'
export type { ProjectThemePolicy, ProjectUiPolicySnapshot } from './project-policy.ts'
export {
  WorkspaceResourceRegistry,
  parseWorkspaceResourceAddress,
  workspaceResourceProvider,
  WorkspaceResourceError,
  isWorkspaceAccessFailure,
  workspaceResourceAddress,
  workspacePathForResource,
} from './workspace-resources.ts'
export type {
  WorkspaceResourceAddress,
  WorkspaceResourceProvider,
  WorkspaceResourceOpenRequest,
  WorkspaceResourceTarget,
  WorkspaceResourceSource,
  WorkspaceResourceState,
  WorkspaceResourceValue,
} from './workspace-resources.ts'
export type { Session } from './sessions/session.ts'
export type {
  BeginSubmissionInput,
  ISession,
  PendingSubmissionRetirement,
  ProjectionsFace,
  SessionFace,
  SubmissionHandle,
} from './contract/session.ts'
export type { AgentContext, ISessions, SessionRuntimeTarget, SessionTarget, SessionReference, SessionRetainOptions, SessionRetainInfo } from './contract/sessions.ts'
export type { IWorkspaces, StartSessionOptions } from './contract/workspaces.ts'
export type { SessionBlankReuseRequest, SessionCreateOptions } from './contract/session-create.ts'
export type {
  SessionBinding, SessionListState, SessionProvideContribution, SessionProvideDescriptor, SessionSummary,
} from './sessions/service.ts'
export { MutableSessionEventSource, sessionEventLikeEntry } from './contract/events.ts'
export type {
  SessionAssistantSettlementEntry, SessionEventChange, SessionEventLikeEntry,
  SessionEventSource, SessionEventWindow, SessionLiveEventEntry, SessionTransientEventEntry,
} from './contract/events.ts'
export type { SessionListPhase, SessionSearchResultItem, SubagentCatalogSnapshot } from './sessions/manager.ts'
export type { SubagentAddress, JobView, JobOutputChunk, JobOutputCoords, JobOutputValue } from '@deepseek-ai/dsh-client-connection/client'
export type { ObservedJob } from './sessions/manager.ts'
export type { WorkspaceListPhase } from './workspaces/manager.ts'
export type { WorkspaceListState } from './workspaces/service.ts'
export type {
  DirectoryEntry, DirectoryListing, WorkspaceId, WorkspaceView,
} from '@deepseek-ai/dsh-client-connection/client'
// Runtime owns the snapshot store; ui-renderer only binds it to React.
export { createSnapshotStore, defineStore, shallowEqual } from './contract/store.ts'
export type {
  EngineStoreHandle, EngineStoreInstance, ObservableSnapshot, SnapshotStore,
} from './contract/store.ts'
// Account/document UI consumers share the Host carrier's byte-budgeted JSON
// reader so a direct same-origin response cannot bypass the transport limit.
export {
  ApiResponseTooLargeError,
  DEFAULT_UNARY_RESPONSE_MAX_BYTES,
  readApiResponseJson,
  readApiResponseText,
} from '@deepseek-ai/dsh-host-apiproxy/client'
export type {
  AssistantBlock, AssistantMessageNode, AssistantProviderMetadataView, AssistantRequestConfig,
  AssistantTiming, ChatFlowEntry, ChatGroupMember, ChatGroupSnapshot, ChatGroupStore,
  ChatLocationNodeIndex, ChatNodeStore, ChatSnapshot, ChatTurnNavigationIndex, TurnNavigationItem,
  CommandNode, CompactionSummaryNode, ComposerPhase,
  ContextMessageNode, ConversationNode, ConversationSnapshot, HistoryDetailState, HistoryNavigationItem, HistoryNavigationSnapshot,
  HistoryNavigationState, HistoryWindowMode,
  ModelRetryNode, PendingSubmission, PendingSubmissionImage, PendingSubmissionPlacement, QueuedMessage,
  LegacyConversationSlice, PartialAssistant, PreparingToolCall, RunningToolCall, StartedToolCall,
  SteeringMessageNode, TodoItem, ToolCallBlock, ToolResultNode, TurnErrorNode, TurnMaxTokensNode,
  UnknownSurfaceNode, UserMessageNode,
} from './sessions/conversation.ts'
export {
  EMPTY_CHAT_SNAPSHOT, EMPTY_CONVERSATION_VIEWS, sanitizeAssistantText, toAssistantBlock, toAssistantBlocks,
} from './sessions/conversation.ts'
export { emptyAssistantBlock, IncrementalAssistantBlocks } from './sessions/partial.ts'
export { assistantStreamFirstTokenTime, isTokenDelta } from './sessions/assistant-timing.ts'
export { contextForm, contextProducer, sessionRecallLabels, skillInvocationName } from './sessions/context-producer.ts'
export { displayFailureMessage, isSessionPersistenceFailureMessage } from './sessions/failure-display.ts'
export type {
  ConversationContext, ConversationContextOriginKind,
} from './sessions/conversation-context.ts'
export type {
  ContextProducerView, ContextRole, KnownContextForm,
} from './sessions/context-producer.ts'
export type {
  ConversationPromptSnapshot, RequestInspectionSnapshot, RequestPromptChange, RequestView,
} from './sessions/request-inspection.ts'
export { PendingWait } from './sessions/pending.ts'
export type {
  PendingInteraction, PendingInteractionStatus, PendingKind, PendingPayloads,
  SessionPendingEntry, SessionPublishedInteraction,
} from './sessions/pending.ts'
// Projection value store (push model; see the session-projection subsystem
// page, docs/subsystems/session-projection.md): host-computed
// whole values per key; domains ship projection support with zero client code.
export type {
  ProjectionsBaseline, ProjectionValueStore, SessionProjectionMap, UseProjection,
} from './sessions/projection-store.ts'
export type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
export { permissionAvailabilityFor, permissionAvailabilitySource, permissionUnavailableReason } from './contract/permission-availability.ts'
export type { AccountPermissionAvailability, PermissionAvailability, PermissionUnavailableReason } from './contract/permission-availability.ts'
export type {
  AddPaneResult, ConversationViewport, ConversationViewportMode, ConversationViewportSnapshot,
} from './contract/conversation-viewport.ts'

/** Client-side Cordis context after declaration merging. */
export type ClientContext = Context

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertContextMap {
    /** Client Agent scope identity; the agent and session share one wire id. */
    agent: TypertContext<SessionId>
  }
}

/** The conversation-snapshot selector hook supplied to session-scoped UI entries. */
export type UseConversationSession = SnapshotSelectorHook<ConversationSnapshot>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  /**
   * Session standard kit, real members (ui-slots declares the empty seat;
   * the runtime — where the subjects live — merges the concrete types):
   * every session-scope slot component receives these from the framework.
   */
  interface SessionStandardProps {
    useSession: SnapshotSelectorHook<ConversationSnapshot>
    /** The framework-resolved session id (owners never pass it). */
    sessionId: SessionId
    /** The fifth framework hook seat: key-addressed projection reader (undefined = capability absent). */
    useProjection: UseProjection
  }
  /** Standard kit for slots that remain mounted while current session changes. */
  interface SessionMaybeStandardProps {
    useSession: MaybeSnapshotSelectorHook<ConversationSnapshot>
    /** Current session id; absent in the no-session state. */
    sessionId: SessionId | undefined
    /** Key-addressed projection reader; every key reads absent while no session is current. */
    useProjection: UseProjection
  }
  /** Props injected into every global slot component. */
  interface GlobalStandardProps {
    useSessions: SnapshotSelectorHook<SessionListState>
    /** Selector hook over real Workspaces and their independent baseline lifecycle. */
    useWorkspaces: SnapshotSelectorHook<import('./workspaces/service.ts').WorkspaceListState>
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Transform a root-session create request before it reaches the Host.
     * Listeners must call `next()` so independent request contributors compose;
     * the returned options are authoritative for the wire request.
     * @param options - caller-selected workspace, directory, and optional id.
     * @mode waterfall
     */
    'sessions/prepare-create'(
      options: SessionCreateOptions,
      next: () => Promise<SessionCreateOptions>,
    ): Promise<SessionCreateOptions>
    /**
     * Confirm that one blank root session satisfies every plugin-owned field
     * in the prepared create request. Listeners must call `next()` and may
     * veto reuse by returning false; the Host create path runs when every
     * candidate is rejected.
     * @param request - blank candidate and authoritative prepared options.
     * @mode waterfall
     */
    'sessions/confirm-blank-reuse'(
      request: SessionBlankReuseRequest,
      next: () => Promise<boolean>,
    ): Promise<boolean>
    /**
     * An ordinary Slot's definition or entry registration set changed. Factory
     * definitions publish through `subscribeFactory()` instead.
     * @mode emit
     * @param key - the mutated SlotMap key.
     */
    'slots/changed'(key: string): void
    /**
     * A ready connection generation is about to publish its Host description.
     * Listeners synchronously withdraw prior-generation client state before description consumers run.
     * @mode emit
     * @param initialConnection - true only before this runtime's first connected callback.
     */
    'connection/will-reset'(initialConnection: boolean): void
    /**
     * A connection generation was (re-)established. Wire-derived caches must
     * treat their state as stale and repull (commands directory; the queue
     * mirrors reset themselves through the session resync path).
     * @mode emit
     * @param initialConnection - true only for this runtime's first handshake; omitted resets require revalidation.
     */
    'connection/reset'(initialConnection?: boolean): void
    /**
     * Open one Session-relative Workspace file in the browser.
     * @param request - owning Session and relative resource address.
     * @mode bail
     * @returns true when a preview consumer accepts the resource.
     */
    'workspace/resource-open'(request: import('./workspace-resources.ts').WorkspaceResourceOpenRequest): true | undefined
    /**
     * Open a webpage beside the explicitly named Session.
     * @param request - owning Session and sanitized absolute HTTP(S) URL.
     * @mode bail
     * @returns true when a Browser consumer accepts the link; absent handlers retain external navigation.
     */
    'web/browser-open'(request: { sessionId: import('@deepseek-ai/dsh-session/types').SessionId; url: string }): true | undefined
    /** Resolve saved input before augmenting an existing conversation.
     * @mode bail
     * @param sessionId - exact authorized Session.
     * @returns whether the source draft was read.
     */
    'conversation/prepare-input'(sessionId: import('@deepseek-ai/dsh-session/types').SessionId): Promise<boolean> | undefined
    /** Append text typed during authorization to the exact Session's existing composer.
     * @mode bail
     * @param payload - verified Session and new unsent text.
     * @returns true when the existing draft adopted the text.
     */
    'conversation/append-input'(payload: { sessionId: import('@deepseek-ai/dsh-session/types').SessionId; text: string }): true | undefined
    /** Begin the immediate composer for a verified fresh-conversation destination.
     * @mode bail
     * @param choice - exact selected Runtime and optional projected Workspace.
     * @returns true when the client shell accepts the navigation.
     */
    'workspaces/start-prepared'(choice: { target: import('./contract/sessions.ts').SessionRuntimeTarget; workspaceId?: import('@deepseek-ai/dsh-api-remotes/client').WorkspaceId }): true | undefined
    /**
     * Initialize one Session's composer draft after a New Session navigation
     * commits. A prefill only — listeners mutate the unsent draft and never
     * send, execute, or log anything.
     * @param payload - target Session, prompt text, and the clear flag.
     * @mode emit
     */
    'conversation/draft-initialize'(
      payload: {
        sessionId: import('@deepseek-ai/dsh-session/types').SessionId
        prompt?: string
        clearPreviousDraft?: boolean
      },
    ): void
  }
  interface Context {
    slots: import('./slots.ts').SlotRegistry
    /** Event-to-business-Context Definition registry. */
    conversationEvents: import('./conversation/event-registry.ts').ConversationEventRegistry
    /** Per-target Conversation snapshot builder registry. */
    conversationViews: import('./conversation/view-registry.ts').ConversationViewRegistry
    /** The outward face only; the concrete service stays inside the runtime. */
    sessions: import('./contract/sessions.ts').ISessions
    /** The outward face only; the concrete service stays inside the runtime. */
    workspaces: import('./contract/workspaces.ts').IWorkspaces
    /** Active project UI policy shared by theme and project settings surfaces. */
    projectUiPolicy: import('./project-policy.ts').ProjectUiPolicyRuntime
    /** Browser-ingress deployment policy; independent of the selected Runtime. */
    deploymentContext: DeploymentContextRuntime
    /** In-flight Gateway operations scoped to this authenticated browser document. */
    gatewayEntryRequests: GatewayEntryRequests
    /** Unsent input for this document’s explicit conversation navigation. */
    conversationIntents: ConversationIntents
    /** Per-runtime permission preset catalog directory; one mirror per pooled connection. */
    permissionCatalog: import('./permission-catalog.ts').PermissionCatalogDirectory
    /** Passive authorized management destinations; subscribing never starts a Runtime. */
    runtimeEnvironments: import('@deepseek-ai/dsh-client-ui-slots').HostObservable<import('./runtime-environments.ts').RuntimeEnvironments>
    /** Metadata-only Workspace resource registry; providers bind one runtime target. */
    workspaceResources: WorkspaceResourceRegistry
    /** Optional provider for the multi-session conversation viewport. */
    conversationViewport?: import('./contract/conversation-viewport.ts').ConversationViewport
  }
}

/** Required services: the wire handle and Client Typert registry. */
export const inject = ['connection', 'typert', 'remote', 'remote.commands', 'remote.subagents']

/** Mounts the browser runtime services and connection stream.
 * @param ctx - Client Cordis context.
 */
export function apply(ctx: Context): void {
  ctx.plugin(SlotRegistry)
  ctx.provide('projectUiPolicy', new ProjectUiPolicyRuntime())
  const workspaceResources = new WorkspaceResourceRegistry()
  ctx.provide('workspaceResources', workspaceResources)
  const connection = ctx.get('connection') as ConnectionHandle
  const deploymentContext = new DeploymentContextRuntime(connection.metadataTiming)
  ctx.provide('deploymentContext', deploymentContext)
  ctx.effect(() => deploymentContext.start(connection, ctx.projectUiPolicy), 'runtime: entry deployment context')
  const principal = () => ctx.projectUiPolicy.getSnapshot().verifiedAccountId
  const intents = new ConversationIntents()
  ctx.provide('conversationIntents', intents)
  ctx.effect(() => {
    let account = principal()
    const stop = ctx.projectUiPolicy.subscribe(() => {
      if (account === principal()) return
      account = principal()
      intents.clear()
    })
    const beforeUnload = (event: BeforeUnloadEvent): void => {
      if (intents.hasUnsavedDrafts()) event.preventDefault()
    }
    const windowEvents = globalThis as {
      addEventListener?: typeof window.addEventListener
      removeEventListener?: typeof window.removeEventListener
    }
    windowEvents.addEventListener?.('beforeunload', beforeUnload)
    return () => { stop(); windowEvents.removeEventListener?.('beforeunload', beforeUnload); intents.clear() }
  }, 'runtime: pending conversation drafts')
  const entryRequests = new GatewayEntryRequests(connection, principal, () => deploymentContext.getSnapshot().context?.mode === 'multi', {
    ready: () => {
      const host = connection.hostDescription.getSnapshot()
      return host !== undefined && (host.executionAuthorityRequired !== true
        || (principal() !== undefined && deploymentContext.getSnapshot().context !== undefined))
    },
    subscribe: (listener) => {
      const stops = [connection.hostDescription.subscribe(listener),
        ctx.projectUiPolicy.subscribe(listener), deploymentContext.subscribe(listener)]
      return () => { for (const stop of stops) stop() }
    },
  })
  ctx.provide('gatewayEntryRequests', entryRequests)
  ctx.effect(() => {
    let account = principal()
    const stopAccount = ctx.projectUiPolicy.subscribe(() => {
      if (account === principal()) return
      account = principal(); entryRequests.invalidate()
    })
    let revision = deploymentContext.getSnapshot().context?.revision
    const stopPolicy = deploymentContext.subscribe(() => {
      const next = deploymentContext.getSnapshot().context?.revision
      if (next !== revision) { revision = next; entryRequests.invalidate() }
    })
    return async () => { stopAccount(); stopPolicy(); await entryRequests.dispose() }
  }, 'runtime: document entry requests')
  const conversation = {
    events: new ConversationEventRegistry(ctx),
    views: new ConversationViewRegistry(ctx),
  }
  const identity = connection.documentIdentity
  const selectionPersistenceKey = identity === undefined ? undefined
    : `dsh.sessions.current.v2.${String(identity.principalId)}.${identity.runtimeTarget.kind === 'personal'
      ? 'personal' : `project-${String(identity.runtimeTarget.projectId)}`}`
  const baseSessions = new SessionRuntime(ctx, connection.wireApi ?? connection.api, ctx.remote, conversation, {
    provideService: false,
    hostDescription: connection.hostDescription,
    ...(selectionPersistenceKey === undefined ? {} : { selectionPersistenceKey }),
  })
  const sessions = new SessionRuntimePool(ctx, baseSessions, connection, ctx.remote, conversation)
  ctx.effect(() => {
    const stopAccount = ctx.projectUiPolicy.subscribe(() => {
      const id = ctx.projectUiPolicy.getSnapshot().verifiedAccountId
      if (id !== undefined) connection.confirmPrincipal?.(id)
    })
    const stopIdentity = connection.onPrincipalChange?.(async () => {
      try { ctx.projectUiPolicy.setVerifiedAccountId(undefined) }
      finally { sessions.invalidateAccount() }
      await ctx.fiber.dispose()
    })
    return () => { stopAccount(); stopIdentity?.() }
  }, 'runtime: authenticated account lifetime')
  // One catalog mirror per pooled runtime connection; sinks attribute each
  // catalog-changed forward to the connection that delivered it, and each
  // mirror's own hostDescription subscription covers generation resets.
  const permissionCatalog = new PermissionCatalogDirectory(connection, sessions.list)
  ctx.provide('permissionCatalog', permissionCatalog)
  ctx.effect(() => () => { permissionCatalog.dispose() }, 'runtime: permission catalog directory')
  ctx.typert.contexts.registerClient('agent', {
    identity: candidate => sessions.sessionOf(candidate)?.sessionId,
    resolve: (sessionId) => {
      const reference = sessions.retainAgentScope(sessionId)
      return typertOwnedValue(reference.binding.ctx, () => { reference.release() })
    },
  })
  const workspaces = new WorkspaceRuntime(ctx, connection.api, sessions)
  const personalDirectory = installPersonalDirectory(ctx, connection, sessions, workspaces)
  ctx.provide('runtimeEnvironments', createRuntimeEnvironments(ctx, connection, sessions, workspaces, deploymentContext, personalDirectory))
  ctx.effect(
    () => workspaces.startInitialSelection(),
    'runtime: initial Workspace selection',
  )
  let initialConnection = true
  const loop = connection.start({
    onMuxEnvelope: (envelope) => {
      sessions.handleMuxEnvelope(envelope)
    },
    onHostEnvelope: (envelope) => {
      sessions.handleHostEnvelope(envelope)
      workspaces.handleHostEnvelope(envelope)
      // Forwarded-event bridge: the session layer ignores registry frames (no
      // session routing). This plugin owns the frame sink, so it hands the
      // decoded frame straight to the Remote service, which fans it out to
      // `ctx.remote.$on` subscribers; no consumer reads a frame.
      const frame = envelope.payload
      if (frame.type === 'host/remote-event') {
        sessions.dispatchRemoteEvent(frame.event, frame.args)
        if (frame.event === 'permission-presets/catalog-changed') permissionCatalog.invalidateFor(connection)
      }
    },
    onBeforeConnected: () => { ctx.emit('connection/will-reset', initialConnection) },
    onConnected: (description) => {
      // Authority withdrawal can cancel pending navigation, including an
      // unshown saved-history window. Finish it before preparing fresh reads.
      const initial = initialConnection
      initialConnection = false
      ctx.emit('connection/reset', initial)
      const workspaceBaseline = workspaces.handleConnected()
      sessions.handleConnected(description, workspaceBaseline)
    },
    onFailure: (failure) => { sessions.handleConnectionFailure(failure) },
    onStateChange: (state) => {
      // Generation death fires before the next generation's business frames
      // are released: ConnectionController buffers stream replay until after
      // onConnected, so this is the safe moment to drop generation-scoped
      // interaction state.
      if (state === 'reconnecting') {
        workspaces.handleDisconnected()
        sessions.handleDisconnected()
      }
    },
  })
  ctx.effect(() => () => { workspaces.handleDisconnected(); loop.stop() }, 'runtime: connection stream loop')
}

/** Local Session owners; plugins extend this map for independent consumers. */
export interface SessionReferenceSourceMap {
  controllerOperation: true
  conversation: true
  workbench: true
  gateway: true
}

/** Registered source of a local Session reference. */
export type SessionReferenceSource = keyof SessionReferenceSourceMap
