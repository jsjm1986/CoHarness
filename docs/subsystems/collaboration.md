# Project Collaboration

English | [中文](collaboration.zh.md)

The project collaboration subsystem binds each browser operation to one authenticated participant, authorizes every shared-conversation action against the root conversation, and keeps project sessions in one Gateway-backed runtime and persistence domain. The [project collaborative conversations Agent Note](../../.agents/notes/implemented/feature/2026-08-15-project-collaborative-conversations.md) owns the security and storage decisions; this page records the public types and Cordis services from [`dsh-client-connection`](../../packages/client/connection), [`dsh-gateway-runtime`](../../packages/context/gateway-runtime), and [`dsh-collaboration`](../../packages/context/collaboration).

## Runtime identity

The Gateway allocates personal runtimes by user and shared runtimes by project. A runtime identity includes a monotonic generation so a principal issued for an earlier process cannot authorize a replacement process.

```ts type-equiv
/** Runtime identity bound into both the launch credential and every principal. */
interface GatewayRuntimeIdentity {
  readonly kind: 'user' | 'project'
  readonly id: number
  readonly generation: number
}
```

The selected browser scope carries the current effective project mode. Organization administrators receive `rw` for every active project even without a project-membership row. The mode is signed into each principal rather than read from mutable process-global account state.

```ts type-equiv
/** Scope selected by the authenticated browser request. */
type GatewayPrincipalScope =
  | { kind: 'personal' }
  | { kind: 'project'; projectId: number; projectName: string; mode: 'ro' | 'rw'; canManage?: boolean }
```

```ts type-equiv
/** Validated Gateway assertion claims available for one request. */
interface GatewayPrincipalClaims {
  version: 1
  issuer: 'harness-gateway'
  audience: 'dsh-runtime'
  organization: string
  user: {
    id: number
    username: string
    displayName: string
    role: 'admin' | 'user'
  }
  scope: GatewayPrincipalScope
  runtime: GatewayRuntimeIdentity
  issuedAt: number
  expiresAt: number
  nonce: string
  /** Optional capability purpose used by loopback-only runtime integrations. */
  purpose?: 'archive-read' | 'document-admin'
}
```

Each root-conversation authorization and readable-session filter queries the Gateway against the current PostgreSQL organization role and project membership. Removing a member, changing `rw` to `ro`, or removing administrator authority therefore affects the next Session ACL check. An operation without a Session ACL uses the scope mode captured in its principal; that mode cannot outlive `expiresAt`. The Gateway default is 30 seconds, proxied HTTP requests receive a new principal, and long-lived Host and Typert streams close at expiry before reconnecting.

## Private runtime channel

The Gateway launches a runtime with one private credential delivered through an inherited file descriptor or a systemd credential file. The bearer token authenticates loopback internal API calls, while the public key verifies browser principals; neither value belongs in browser configuration.

The Connection carrier wraps every accepted `/api` HTTP dispatch and event-stream WebSocket opening in the `connection/request` waterfall after its browser-trust check and before any RPC or stream handler runs. Authentication and request-context listeners inspect the immutable-at-entry headers and must call `next()` to preserve later listeners and dispatch.

```ts type-equiv
/** One accepted HTTP request or WebSocket opening entering the Connection carrier. */
interface ConnectionRequestBoundary {
  kind: 'http' | 'upgrade'
  headers: IncomingHttpHeaders
  /** HTTP method when the carrier has one (upgrade requests use the opening method). */
  method?: string
  /** URL pathname before any RPC dispatch. */
  pathname?: string
}
```

```ts type-equiv
/** Private launch credential delivered through an inherited FD or systemd credential file. */
interface GatewayRuntimeCredential {
  version: 1
  gatewayUrl: string
  organization: string
  runtime: GatewayRuntimeIdentity
  token: string
  principalPublicKey: string
}
```

After signature, lifetime, organization, scope, runtime identity, and generation validation, `dsh-gateway-runtime` exposes the assertion and claims only inside the current HTTP or WebSocket dispatch.

```ts type-equiv
/** Request-local assertion and its verified claims. */
interface GatewayRequestPrincipal {
  assertion: string
  claims: GatewayPrincipalClaims
}
```

Internal callers opt into principal forwarding. Omitting `principal` sends only the runtime bearer token, `true` forwards the current request principal, and an explicit principal forwards an authority captured earlier in the same request or stream lifetime.

```ts type-equiv
/** Options for one authenticated call to the Gateway's internal runtime API. */
interface GatewayRuntimeRequestInit extends RequestInit {
  /** Forward the current browser principal when this operation needs user authority. */
  principal?: boolean | GatewayRequestPrincipal
}
```

## Root conversation ACL

Authorization distinguishes reads, writes, creator-or-administrator management, and human-interaction responses. Approval and question ids use separate namespaces and are committed through an atomic Gateway claim.

```ts type-equiv
/** Authorization verbs applied to a root conversation ACL. */
type CollaborationAction = 'read' | 'write' | 'manage' | 'approve'
```

```ts type-equiv
/** Human interaction classes that accept exactly one committed response. */
type CollaborationInteractionKind = 'approval' | 'question'
```

A project root conversation is readable by every current project member when `project`, or only by its creator and current organization administrators when `private`. Administrators have `rw` read, write, management, and interaction authority over every active project without a project-membership row. Descendants inherit the root project, creator, and visibility; they do not carry independent ACLs.

```ts type-equiv
/** Visibility of one root conversation inside a project runtime. */
type CollaborationVisibility = 'project' | 'private'
```

The participant snapshot is request-authenticated data. `dsh-collaboration-context` stores project participant metadata with each admitted human message and renders the durable model-visible attribution described in its [package README](../../packages/context/collaboration-context/README.md). The Web Chat transcript labels each human bubble from that source and omits the notice from the flow ([sender attribution](../../.agents/notes/implemented/feature/2026-08-17-web-chat-sender-attribution.md)).

```ts type-equiv
/** Authenticated human participant attached to one request. */
interface CollaborationParticipant {
  readonly userId: number
  readonly username: string
  readonly displayName: string
  readonly role: 'admin' | 'user'
  readonly scope:
    | { readonly kind: 'personal' }
    | {
      readonly kind: 'project'
      readonly projectId: number
      readonly projectName: string
      readonly mode: 'ro' | 'rw'
      readonly canManage?: boolean
    }
}
```

Successful authorization returns root-resolved facts. Personal sessions omit project fields; project sessions report the stored root visibility and creator together with the caller's current membership mode.

```ts type-equiv
/** Root-inherited access facts returned after authorization succeeds. */
interface CollaborationAccess {
  readonly sessionId: SessionId
  readonly rootSessionId: SessionId
  readonly mode: 'ro' | 'rw'
  readonly canRead: true
  readonly canWrite: boolean
  readonly canManage: boolean
  readonly projectId?: number
  readonly visibility?: CollaborationVisibility
  readonly creatorUserId?: number
}
```

Host Consumers classify every project-scoped operation before dispatch. Session reads and writes use `authorize()`, listings and publications use `readableSessionIds()`, and project-scoped Typert Remotes accept only the session-addressed allowlist: `commands/list`, `fileReferences/list`, and `sessionReferenceResolver/candidates` require `read`; `commands/execute`, `goals/*`, `messageFeedback/put`, and `messageFeedback/delete` require `write`; `messageFeedback/list` requires `read`. An unclassified or process-wide Remote is denied.

New project roots carry one explicit visibility through the asynchronous creation operation. The PostgreSQL persistence provider materializes that choice with the authenticated creator; child registration copies the root ACL.

```ts type-equiv
/** Request-scoped metadata for a new root conversation. */
interface CollaborationSessionCreation {
  readonly visibility: CollaborationVisibility
}
```

## Captured authority

Consumers capture authority while an authenticated request is current, then retain that immutable participant and provider lifetime for the operation. Authorization and readable-session filtering consult the Gateway; `signal` aborts when the issuing provider unloads. `claimInteraction()` returns `true` only for the first transaction that commits one approval or question outcome.

```ts type-equiv
/** Principal-bound collaboration operations safe to retain for one request or stream lifetime. */
interface CollaborationAuthority {
  readonly participant: CollaborationParticipant
  /** Assertion expiry; long-lived streams reconnect no later than this instant. */
  readonly expiresAt: number
  /** Aborts when the provider that issued this authority unloads. */
  readonly signal: AbortSignal

  /**
   * Authorize one operation against the session's root ACL.
   * @param sessionId - requested root or descendant session.
   * @param action - operation class to authorize.
   * @returns root-inherited access facts.
   */
  authorize(sessionId: SessionId, action: CollaborationAction): Promise<CollaborationAccess>

  /**
   * Filter a batch to sessions this participant may read.
   * @param sessionIds - candidate root or descendant session ids.
   * @returns the readable subset.
   */
  readableSessionIds(sessionIds: readonly SessionId[]): Promise<ReadonlySet<SessionId>>

  /**
   * Atomically claim one pending human response for a shared conversation.
   * @param sessionId - session that emitted the approval request.
   * @param kind - interaction class whose ids occupy an independent namespace.
   * @param interactionId - stable approval or question request id.
   * @param outcome - exact response payload being committed.
   * @returns true for the first accepted responder; false after another responder won.
   */
  claimInteraction(
    sessionId: SessionId,
    kind: CollaborationInteractionKind,
    interactionId: string,
    outcome: unknown,
  ): Promise<boolean>
}
```

Consumers preserve stable denial codes across HTTP and RPC transports. `gateway-unavailable` is fail-closed: a malformed response or unreachable authorization backend never becomes implicit permission.

```ts type-equiv
/** Stable failure codes shared by Gateway-backed Consumers. */
type CollaborationErrorCode =
  | 'not-member'
  | 'conversation-not-found'
  | 'forbidden'
  | 'visibility-locked'
  | 'gateway-unavailable'
```

Project runtimes persist shared session headers and events through [`dsh-session-persistence-gateway`](../../packages/session/session-persistence-gateway); personal runtimes retain their configured local provider. The common persistence lifecycle and crash-repair behavior remain owned by [persistence.md](persistence.md).

Deleting a project stops its shared runtime while the Gateway retains that runtime's serialized operation slot, then removes the project row. PostgreSQL cascades the runtime, memberships, mounts, conversation trees and events, participant and interaction rows, project model usage and quota data, intake token, alerts, and content-file metadata. The filesystem project directory is retained.

## Execution participants

Managed execution retains verified human input references across queued edits, answers, forks, and delegation. The Gateway checks every retained participant before privileged execution; a display participant or approval response does not grant authority. Input without verified attribution prevents privileged execution. See the [execution identity service](../../packages/context/execution-authority/README.md) for consumer ownership and the [Gateway provider](../../packages/context/gateway-execution/README.md) for invalidation and recovery.

```ts type-equiv
/** Host RPC identity of the pending human question claimed by the Gateway. */
type ExecutionQuestionId = Branded<'rpc-id'>
```

```ts type-equiv
/** Privilege checked against every current execution participant. */
type ExecutionCapability = 'execute' | 'plugin-management' | 'auto-review'
```

```ts type-equiv
/** Gateway-confirmed participant set, with bounded identity witnesses. */
interface ExecutionState {
  readonly revision: string
  readonly inputs: readonly ExecutionInputId[]
  readonly actors: readonly { readonly userId: number }[]
  readonly primaryActorUserId?: number
  readonly unverifiedHistory: boolean
}
```

```ts type-equiv
/** A delegation captures its parent before awaiting child creation. */
interface ExecutionInheritance {
  readonly parentSessionId: SessionId
  readonly inputs: readonly ExecutionInputId[]
  readonly unverifiedHistory: boolean
  readonly primaryActorUserId?: number
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcollaboration--collaboration-abstract-seam"></a>

### `ctx.collaboration` — `Collaboration` (abstract seam)

Project collaboration Service Definition consumed by host APIs and persistence providers.

```ts cordis-catalog
/**
 * Capture the authenticated principal for one request or event stream.
 * @returns an authority with participant identity and collaboration operations.
 */
abstract capture(): CollaborationAuthority

/**
 * Return new-session metadata visible during the wrapped creation operation.
 * @returns the active creation metadata, or undefined outside a wrapped operation.
 */
abstract currentCreation(): CollaborationSessionCreation | undefined

/**
 * Run session creation under an authenticated visibility choice.
 * @param creation - requested root-conversation visibility.
 * @param operation - creation work that synchronously reaches persistence registration.
 * @returns the operation result.
 */
abstract withSessionCreation<T>( creation: CollaborationSessionCreation, operation: () => Promise<T>, ): Promise<T>
```

Source: [`packages/context/collaboration/src/index.ts`](../../packages/context/collaboration/src/index.ts)

<a id="ctxexecutionauthority--executionauthority-abstract-seam"></a>

### `ctx.executionAuthority` — `ExecutionAuthority` (abstract seam)

Authority operations shared by input transports, delegated work, and privilege consumers.

```ts cordis-catalog
/**
 * Attest the live caller and exact human input, retaining all earlier editors.
 * @param session - Session which owns the input.
 * @param message - content and display metadata accepted by the input transport.
 * @returns immutable input with verified origin reference.
 */
abstract stamp(session: Session, message: UserMessage): Promise<UserMessage>

/**
 * Claim a verified human answer and include its responder before delivery.
 * @param session - Session owning the live question.
 * @param questionId - exact pending question identity verified by the transport.
 * @param answer - parser-validated answer.
 * @returns whether the caller owns this answer, including an identical retry.
 */
abstract answer(session: Session, questionId: string, answer: unknown): Promise<boolean>

/**
 * Capture the current participants before awaiting delegated work.
 * @param agent - exact live parent Agent.
 * @returns immutable inheritance for the new or continued child.
 */
abstract capture(agent: Agent): ExecutionInheritance

/**
 * Capture the complete authority of a cold or live source for an explicit fork.
 * @param sessionId - source already authorized by the fork transport.
 * @returns current participant references, independently of the selected history cut.
 */
abstract captureSession(sessionId: SessionId): Promise<ExecutionInheritance>

/**
 * Persist captured restrictions in the child's own log.
 * @param session - child Session, including the unpublished setup window.
 * @param scope - participants captured from its actual parent.
 */
abstract inherit(session: Session, scope: ExecutionInheritance): void

/**
 * Include an adjacent sender's restrictions before admitting its durable delivery.
 * @param session - actual recipient, including a Team's routing host.
 * @param scope - sender facts captured before asynchronous delivery.
 * @param messageId - stable delivery identity for retry deduplication.
 * @param signal - delivery cancellation.
 * @returns recipient restrictions for an onward delegation of this delivery.
 */
abstract relay(session: Session, scope: ExecutionInheritance, messageId: MessageId, signal?: AbortSignal): Promise<ExecutionInheritance>

/**
 * Recheck every participant against current permissions.
 * @param capability - required privilege; identity alone grants none.
 * @param agent - actual executing Agent.
 * @param signal - operation-owned cancellation.
 * @returns verified participants for attribution; one call incurs one charge.
 */
abstract authorize(capability: ExecutionCapability, agent: Agent, signal?: AbortSignal): Promise<ExecutionState>

/**
 * Authorize an explicit preset selection before its synchronous commit.
 * @param agent - target Agent.
 * @param preset - requested preset name.
 */
abstract authorizeSelection(agent: Agent, preset: string): Promise<void>
```

Types: [Agent](core.md) · [MessageId](llm-streaming.md) · [Session](session.md) · [SessionId](core.md) · [UserMessage](session.md)

Source: [`packages/context/execution-authority/src/index.ts`](../../packages/context/execution-authority/src/index.ts)

<a id="ctxgatewayruntime--gatewayruntime"></a>

### `ctx.gatewayRuntime` — `GatewayRuntime`

Authenticated Gateway context for one launched Harness runtime.

```ts cordis-catalog
/**
 * Return the principal bound to the current HTTP or WebSocket operation.
 * @returns the verified principal, or undefined outside an authenticated operation.
 */
current(): GatewayRequestPrincipal | undefined

/**
 * Read the live HTTP caller; detached work cannot keep interactive authority.
 * @returns the caller while the HTTP operation remains active, otherwise undefined.
 */
interactive(): GatewayRequestPrincipal | undefined

/**
 * Return the current principal or reject an operation outside an authenticated request.
 * @returns the verified principal bound to the current operation.
 */
requireCurrent(): GatewayRequestPrincipal

/**
 * Publish one pending lazy-creation capability for other Gateway Consumers.
 * @param sessionId - project root whose first append will materialize it.
 * @param authorization - in-flight or resolved Gateway capability.
 * @returns an exact-registration disposer.
 */
registerSessionCreation( sessionId: SessionId, authorization: Promise<GatewaySessionCreationAuthorization>, ): () => void

/**
 * Read the pending lazy-creation capability for one project root.
 * @param sessionId - candidate project root.
 * @returns the capability promise, or undefined after materialization or rollback.
 */
sessionCreation(sessionId: SessionId): Promise<GatewaySessionCreationAuthorization> | undefined

/**
 * Call the authenticated loopback API without exposing its bearer token to other plugins.
 * @param path - absolute internal runtime API path.
 * @param options - fetch options and optional current-principal forwarding.
 * @returns the Gateway HTTP response.
 */
request(path: string, options: GatewayRuntimeRequestInit = {}): Promise<Response>
```

Types: [SessionId](core.md)

Source: [`packages/context/gateway-runtime/src/index.ts`](../../packages/context/gateway-runtime/src/index.ts)

<a id="typert-gateway-events"></a>

### `typert-gateway/*` events

<a id="typert-gatewayauthorize--serial"></a>

#### `typert-gateway/authorize` — serial

Authorize a validated Remote request before Context or lookup resolution.

```ts cordis-catalog
/**
 * Authorize a validated Remote request before Context or lookup resolution.
 * @param payload - decoded endpoint, service, method, arguments, and signal.
 * @mode serial
 */
'typert-gateway/authorize'(payload: TypertGatewayAuthorizationRequest): Promise<void> | void
```

Source: [`packages/typert/protocol/src/types.ts`](../../packages/typert/protocol/src/types.ts)

<a id="workspace-files-events"></a>

### `workspace-files/*` events

<a id="workspace-filesauthorize--serial"></a>

#### `workspace-files/authorize` — serial

Authorize a canonical provider path before Workspace metadata or content is read.

```ts cordis-catalog
/** Authorize a canonical provider path before Workspace metadata or content is read.
 * @mode serial
 * @param sessionId - Session whose Workspace bounds the request.
 * @param path - internal provider path; never emitted on the wire.
 */
'workspace-files/authorize'(sessionId: SessionId, path: string): void | Promise<void>
```

Types: [SessionId](core.md)

Source: [`packages/host/apiproxy/src/workspace-files.ts`](../../packages/host/apiproxy/src/workspace-files.ts)
<!-- END GENERATED cordis-surface -->
