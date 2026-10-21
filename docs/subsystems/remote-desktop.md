# Remote Desktop

English | [中文](remote-desktop.zh.md)

The [remote-desktop package group](../../packages/remote-desktop/README.md) gives an authenticated human view and control of a remote node's desktop through one capability seam. The Service Definition (`ctx.remoteDesktop`, in [`packages/remote-desktop/remote-desktop`](../../packages/remote-desktop/remote-desktop/README.md)) owns the grant vocabulary, the enforced attach contract, and the audit taxonomy; [`remote-desktop-vnc`](../../packages/remote-desktop/remote-desktop-vnc/README.md) provides it over RFB, [`remote-desktop-stream`](../../packages/remote-desktop/remote-desktop-stream/README.md) mounts the WebSocket transport, and [`remote-desktop-controller`](../../packages/api/remote-desktop-controller/README.md) exposes the `remoteDesktop/*` BFF namespace to the browser. The capability is human-facing: nothing here enters a model request.

Sources: [`packages/remote-desktop/remote-desktop/src/types.ts`](../../packages/remote-desktop/remote-desktop/src/types.ts)

## Grant model

Access never defaults open: every attach resolves against administrator-issued grants. A grant binds a principal to a `RemoteDesktopTarget` at a `RemoteDesktopLevel` under a `RemoteDesktopGrantScope` — durable `machine` access, or a bounded `session` scope that always carries an expiry. Administrators issue, re-level, and revoke grants through `ctx.remoteDesktop`; every mutation commits to the audit log and emits `remote-desktop/grants-changed` only after the write commits.

```ts type-equiv
/** A remote node's desktop endpoint. `nodeId` names the machine per project routing. */
interface RemoteDesktopTarget {
  /** The remote node that owns the desktop. */
  readonly nodeId: string
  /** Desktop identity on the node; omitted selects the primary desktop. */
  readonly desktop?: string
}
```

```ts type-equiv
/** Access level an attachment may use; `control` strictly exceeds `view`. */
type RemoteDesktopLevel = 'view' | 'control'
```

```ts type-equiv
/** Grant lifetime scope: durable machine access or a bounded session grant. */
type RemoteDesktopGrantScope =
  | { readonly kind: 'machine' }
  | { readonly kind: 'session'; readonly sessionId: SessionId; readonly expiresAt: number }
```

```ts type-equiv
/** One administrator-issued access grant to a desktop. */
interface RemoteDesktopGrant {
  readonly id: RemoteDesktopGrantId
  readonly target: RemoteDesktopTarget
  /** Opaque authorized principal (user or account identity). */
  readonly principal: string
  readonly level: RemoteDesktopLevel
  readonly scope: RemoteDesktopGrantScope
  /** Whether attachments under this grant require screen recording. */
  readonly recording: boolean
  readonly grantedBy: string
  readonly createdAt: number
  readonly revokedAt?: number
}
```

## Resolve, consent, attach

`resolve` is the enforced decision point: it matches live grants for the request's principal, computes the effective level (never exceeding the grants), and throws `REMOTE_DESKTOP_FORBIDDEN` rather than silently widening or narrowing. `confirm` records the caller's explicit consent against the resolved grant set; `attach` requires a consent covering the resolved grants at the requested level (`REMOTE_DESKTOP_CONSENT_REQUIRED` otherwise) and returns a `RemoteDesktopSession` carrying a one-time stream token. Failures carry a `RemoteDesktopErrorCode` so API and audit surfaces stay machine-readable.

```ts type-equiv
/** Caller request for `RemoteDesktop.resolve` and `RemoteDesktop.attach`. */
interface RemoteDesktopAttachRequest {
  /** Authenticated principal requesting access, supplied by the API layer. */
  readonly principal: string
  readonly target: RemoteDesktopTarget
  /** Session address for session-scoped grant matching; omit for machine-only. */
  readonly sessionId?: SessionId
  /** Requested level; resolution fails rather than widening past granted level. */
  readonly level: RemoteDesktopLevel
}
```

```ts type-equiv
/** Explicit resolve outcome — the enforced attachment contract. */
interface RemoteDesktopSpec {
  readonly target: RemoteDesktopTarget
  /** Effective level: never exceeds the matching grants. */
  readonly level: RemoteDesktopLevel
  /** The grant(s) authorizing this spec. */
  readonly grants: readonly RemoteDesktopGrant[]
  /** Whether screen recording applies to this attachment. */
  readonly recording: boolean
}
```

```ts type-equiv
/** Stream endpoint the browser client opens for one attachment. */
interface RemoteDesktopStream {
  /** RFB-over-WebSocket path served by the provider. */
  readonly path: string
  /** One-time attach token; validated at the stream handshake. */
  readonly token: RemoteDesktopToken
}
```

```ts type-equiv
/** One live attachment; `detach` releases the desktop and its stream. */
interface RemoteDesktopSession {
  readonly id: RemoteDesktopSessionId
  readonly spec: RemoteDesktopSpec
  readonly stream: RemoteDesktopStream
  detach(signal?: AbortSignal): Promise<void>
}
```

## Audit taxonomy

Every state change records a `RemoteDesktopAuditEvent` attributed to a `RemoteDesktopActor`: consent receipts, grant lifecycle (`grant`, `revoke`, `set-level`), attachment lifecycle (`attach`, `detach`), and in-flight `level-escalate`. `remote-desktop/attached` emits after each attach or detach commits so live views refresh without polling.

```ts type-equiv
/** Live remote state of one desktop endpoint plus the caller's authorization summary. */
interface RemoteDesktopTargetStatus {
  readonly target: RemoteDesktopTarget
  /** The node's desktop transport is reachable. */
  readonly available: boolean
  /** Current attachments on this desktop. */
  readonly attachments: number
  /** Highest level the caller's live grants authorize. */
  readonly level: RemoteDesktopLevel
  /** Any matching grant requires screen recording. */
  readonly recording: boolean
  /** A recorded consent already covers the caller's current grant set at `level`. */
  readonly consented: boolean
}
```

```ts type-equiv
/** Admin filters for grant listing; omitted fields match all. */
interface RemoteDesktopGrantFilter {
  readonly target?: RemoteDesktopTarget
  readonly principal?: string
  readonly includeRevoked?: boolean
  /** Caller Session address for session-scoped matching; only `attachable` consumes it. */
  readonly sessionId?: SessionId
  /**
   * Restrict results to grants the caller may attach under right now: the
   * caller's own principal, unrevoked, a live scope for `sessionId`, and a
   * configured endpoint for the target.
   */
  readonly attachable?: boolean
}
```

```ts type-equiv
/** Fields an administrator supplies when issuing a grant. */
type RemoteDesktopGrantInput = Omit<RemoteDesktopGrant, 'id' | 'createdAt' | 'revokedAt'>
```

```ts type-equiv
/** The authenticated human or administrator an action is attributed to. */
interface RemoteDesktopActor {
  readonly principal: string
  readonly admin: boolean
}
```

```ts type-equiv
/** Stable machine-readable failure codes for API and audit surfaces. */
type RemoteDesktopErrorCode =
  | 'REMOTE_DESKTOP_FORBIDDEN'
  | 'REMOTE_DESKTOP_TARGET_UNAVAILABLE'
  | 'REMOTE_DESKTOP_GRANT_NOT_FOUND'
  | 'REMOTE_DESKTOP_GRANT_EXPIRED'
  | 'REMOTE_DESKTOP_STALE_TARGET'
  | 'REMOTE_DESKTOP_TRANSPORT'
  | 'REMOTE_DESKTOP_CONSENT_REQUIRED'
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxremotedesktop--remotedesktop-abstract-seam"></a>

### `ctx.remoteDesktop` — `RemoteDesktop` (abstract seam)

Remote-desktop capability. `resolve` is the enforced decision point: it computes the effective spec from matching grants and throws `REMOTE_DESKTOP_FORBIDDEN` rather than silently widening or narrowing. `attach` runs the resolved spec; grant and audit operations attribute actions to an explicit RemoteDesktopActor.

```ts cordis-catalog
/**
 * Resolve an attach request into an enforced spec: match live grants,
 * compute the effective level (never exceeding grants), and decide the
 * recording flag. Throws {@link RemoteDesktopError} with
 * `REMOTE_DESKTOP_FORBIDDEN` when no live grant authorizes the request.
 * @param request - the attach request: target, principal, optional Session, requested level.
 * @param signal - request cancellation.
 * @returns the enforced spec, including effective level and recording flag.
 */
abstract resolve(request: RemoteDesktopAttachRequest, signal?: AbortSignal): Promise<RemoteDesktopSpec>

/**
 * Record the caller's explicit consent for a resolved spec. Implementations
 * resolve the request first (rejecting unauthorized targets), persist the
 * consent against the resolved grant set and requested level, record a
 * `consent` audit event, and return the spec so the caller learns the
 * effective level and recording flag it acknowledged.
 * @param request - the attach request being consented to.
 * @param signal - request cancellation.
 * @returns the resolved spec the consent was recorded against.
 */
abstract confirm(request: RemoteDesktopAttachRequest, signal?: AbortSignal): Promise<RemoteDesktopSpec>

/**
 * Open one attachment. Implementations resolve first — and require a
 * consent recorded by {@link confirm} that covers the resolved grant set
 * at the requested level, throwing `REMOTE_DESKTOP_CONSENT_REQUIRED`
 * otherwise — then establish the transport and stream endpoint; the
 * returned session owns detach.
 * @param request - the attach request to open.
 * @param signal - request cancellation.
 * @returns the live session carrying the one-time stream token.
 */
abstract attach(request: RemoteDesktopAttachRequest, signal?: AbortSignal): Promise<RemoteDesktopSession>

/**
 * Serve one upgraded stream connection for a token minted by `attach`.
 * The transport layer calls this after its handshake; the implementation
 * consumes the token exactly once, resolves the pending spec, and pumps
 * the desktop protocol with the effective level enforced inside the pump.
 * @param token - the one-time stream token minted by `attach`.
 * @param socket - the upgraded client socket to pump.
 * @param signal - request cancellation.
 */
abstract serveStream(token: RemoteDesktopToken, socket: Duplex, signal?: AbortSignal): Promise<void>

/**
 * Read the live remote state of one desktop endpoint.
 * Requires at least one live grant for `actor.principal` on the target;
 * `options.sessionId` admits session-scoped grants into the summary.
 * @param actor - the caller whose grants authorize the read.
 * @param target - the desktop endpoint to probe.
 * @param options - optional Session address for session-scoped grants.
 * @param signal - request cancellation.
 * @returns availability, attachment count, and the caller's grant summary.
 */
abstract status( actor: RemoteDesktopActor, target: RemoteDesktopTarget, options?: { sessionId?: SessionId }, signal?: AbortSignal, ): Promise<RemoteDesktopTargetStatus>

/**
 * List grants, optionally filtered; revoked rows need `includeRevoked`.
 * Non-admin actors are restricted to their own principal.
 * @param actor - the caller; non-admin principals see only their own rows.
 * @param filter - optional target/principal/revocation/attachable filters.
 * @param signal - request cancellation.
 * @returns matching grant rows.
 */
abstract listGrants(actor: RemoteDesktopActor, filter?: RemoteDesktopGrantFilter, signal?: AbortSignal): Promise<RemoteDesktopGrant[]>

/**
 * Issue a grant. `actor.admin === true` is required; implementations
 * publish `remote-desktop/grants-changed` only after the write commits.
 * @param input - the grant to issue.
 * @param actor - the administrator issuing it.
 * @returns the committed grant row.
 */
abstract grant(input: RemoteDesktopGrantInput, actor: RemoteDesktopActor): Promise<RemoteDesktopGrant>

/**
 * Change a grant's access level; `actor.admin === true` required.
 * @param id - the grant to change.
 * @param level - the new access level.
 * @param actor - the administrator making the change.
 * @returns the updated grant row.
 */
abstract setLevel(id: RemoteDesktopGrantId, level: RemoteDesktopLevel, actor: RemoteDesktopActor): Promise<RemoteDesktopGrant>

/**
 * Revoke a grant by id; `actor.admin === true` required.
 * @param id - the grant to revoke.
 * @param actor - the administrator revoking it.
 * @returns the revoked grant row.
 */
abstract revoke(id: RemoteDesktopGrantId, actor: RemoteDesktopActor): Promise<RemoteDesktopGrant>

/**
 * Query audit events owned by this capability, newest first.
 * Non-admin actors are restricted to their own principal.
 * @param actor - the caller; non-admin actors see only their own events.
 * @param filter - optional target and principal restrictions.
 * @param signal - request cancellation.
 * @returns recorded events; providers may cap the result window.
 */
abstract audit( actor: RemoteDesktopActor, filter?: { target?: RemoteDesktopTarget; principal?: string }, signal?: AbortSignal, ): Promise<RemoteDesktopAuditEvent[]>
```

Types: [SessionId](core.md)

Source: [`packages/remote-desktop/remote-desktop/src/index.ts`](../../packages/remote-desktop/remote-desktop/src/index.ts)

<a id="ctxremotedesktopcontroller--remotedesktopcontroller"></a>

### `ctx.remoteDesktopController` — `RemoteDesktopController`

`remoteDesktop/*` Remote namespace. Every call resolves the caller's actor from the request's verified principal, then delegates enforcement to `ctx.remoteDesktop` (grant matching, level caps, administrator checks). The browser-visible principal is always the verified user, never caller input.

```ts cordis-catalog
/**
 * Live state of one desktop endpoint for the caller.
 * @param agent - caller's Session owner; also the session-grant address.
 * @param request - the desktop to probe.
 * @param signal - request cancellation.
 * @returns endpoint availability and attachment count.
 */
@Remote async status(agent: Agent, request: RemoteDesktopTargetView, signal: AbortSignal): Promise<RemoteDesktopStatusView>

/**
 * Record the caller's explicit consent for a resolved spec; the returned
 * summary is what the operator acknowledged (level plus recording flag).
 * @param agent - caller's Session owner; session-scoped grants match its id.
 * @param request - target plus the level being consented to.
 * @param signal - request cancellation.
 * @returns the resolved spec the consent now covers.
 */
@Remote async confirm( agent: Agent, request: RemoteDesktopTargetView & { level: RemoteDesktopLevelView }, signal: AbortSignal, ): Promise<RemoteDesktopSpecView>

/**
 * Open one attachment under the caller's grants.
 * @param agent - caller's Session owner; session-scoped grants match its id.
 * @param request - target plus requested level.
 * @param signal - request cancellation.
 * @returns the attachment id and one-time stream endpoint.
 */
@Remote async attach( agent: Agent, request: RemoteDesktopTargetView & { level: RemoteDesktopLevelView }, signal: AbortSignal, ): Promise<RemoteDesktopAttachView>

/**
 * Grants visible to the caller: administrators see all; others see only
 * rows for their own principal (the service enforces the same scoping).
 * `attachable` restricts to grants the caller may attach under now, matched
 * against the caller's Session for session-scoped rows.
 * @param agent - caller's Session address; supplies session-scope matching.
 * @param request - optional principal, revoked-row, and attachable filters.
 * @param signal - request cancellation.
 * @returns matching grants, newest administration first.
 */
@Remote async listGrants( agent: Agent, request: { principal?: string; includeRevoked?: boolean; attachable?: boolean }, signal: AbortSignal, ): Promise<RemoteDesktopGrantView[]>

/**
 * Issue a grant; administrator authority required.
 * @param agent - administrator's Session address bound for routing.
 * @param request - grant fields; `grantedBy` is the verified caller.
 * @param signal - request cancellation.
 * @returns the stored grant row.
 */
@Remote async grant(agent: Agent, request: RemoteDesktopGrantInputView, signal: AbortSignal): Promise<RemoteDesktopGrantView>

/**
 * Change a grant's level; administrator authority required.
 * @param agent - administrator's Session address bound for routing.
 * @param request - grant id and new level.
 * @param signal - request cancellation.
 * @returns the updated grant row.
 */
@Remote async setLevel( agent: Agent, request: { grantId: string; level: RemoteDesktopLevelView }, signal: AbortSignal, ): Promise<RemoteDesktopGrantView>

/**
 * Revoke a grant; administrator authority required.
 * @param agent - administrator's Session address bound for routing.
 * @param request - grant id.
 * @param signal - request cancellation.
 * @returns the revoked grant row.
 */
@Remote async revoke(agent: Agent, request: { grantId: string }, signal: AbortSignal): Promise<RemoteDesktopGrantView>

/**
 * Audit events visible to the caller, newest first; non-administrators are
 * restricted to events touching their own principal.
 * @param agent - caller's Session address bound for routing.
 * @param request - optional target and principal filters.
 * @param signal - request cancellation.
 * @returns matching audit events.
 */
@Remote async audit( agent: Agent, request: { principal?: string; target?: RemoteDesktopTargetView }, signal: AbortSignal, ): Promise<RemoteDesktopAuditEventView[]>
```

Types: [Agent](core.md)

Source: [`packages/api/remote-desktop-controller/src/index.ts`](../../packages/api/remote-desktop-controller/src/index.ts)

<a id="remote-desktop-events"></a>

### `remote-desktop/*` events

<a id="remote-desktopattached--emit"></a>

#### `remote-desktop/attached` — emit

Emitted after an attachment opens or closes.

```ts cordis-catalog
/**
 * Emitted after an attachment opens or closes.
 * @param session - the attachment whose lifecycle event committed.
 * @param attached - true after attach commits; false after detach commits.
 * @mode emit
 */
'remote-desktop/attached'(session: RemoteDesktopSession, attached: boolean): void
```

Source: [`packages/remote-desktop/remote-desktop/src/index.ts`](../../packages/remote-desktop/remote-desktop/src/index.ts)

<a id="remote-desktopgrants-changed--emit"></a>

#### `remote-desktop/grants-changed` — emit

Emitted after the grant set changes (grant/revoke committed). Listeners refresh admin views and cached authorizations.

```ts cordis-catalog
/**
 * Emitted after the grant set changes (grant/revoke committed).
 * Listeners refresh admin views and cached authorizations.
 * @mode emit
 */
'remote-desktop/grants-changed'(): void
```

Source: [`packages/remote-desktop/remote-desktop/src/index.ts`](../../packages/remote-desktop/remote-desktop/src/index.ts)
<!-- END GENERATED cordis-surface -->
