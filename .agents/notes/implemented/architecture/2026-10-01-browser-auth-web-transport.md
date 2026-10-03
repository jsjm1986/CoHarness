# Agent Note: Browser-session authentication for the Web Connection carrier

Status: implemented

English | [中文](2026-10-01-browser-auth-web-transport.zh.md)

## Problem

`dsh web` serves its index and every `/api` channel over an HTTP listener that is loopback-only by default and becomes LAN-reachable under `--trusted-host`. Admission was only the Host/Origin DNS-rebinding fence in `api-request-trust.ts`, which its own comment described as explicitly not authentication: any process that could reach the port could drive sessions, workspace files, and gateway operations. Upstream `dsh-v0.2.0-rc.1` carries `packages/client/connection/src/browser-auth.ts`; the local fork had no equivalent.

## Decision

[BrowserAuth](../../../../packages/client/connection/src/browser-auth.ts) authenticates the browser-facing carrier with a launch-token exchange and persistent signed cookies.

`Connection.authenticatedUrl(base)` is the direct-browser entry: `web-app` prints it as the startup URL, embedding a per-process random launch token held in a `WeakMap`. The index owner — `frontend-static` for the shipped composition, or `connection.authorizeIndex` for compositions without it — exchanges `?token` for a `303` that sets `dsh-auth-<sha256(authority)>` with a `{version, authority, issuedAt, expiresAt}` payload HMAC-signed by a secret persisted through the credentials service (`client-connection/browser-session`, versioned grant record). The cookie is `HttpOnly; SameSite=Strict`, named per canonical request authority, so one listener can serve multiple authorities without cross-authority replay.

`HostConnectionService.requestRejection` is subtree-aware. Registrations and interceptor endpoints declared `authority: 'loopback'` keep the loopback fence as their complete admission — machine callers such as webhooks and the archive gateway cannot perform a browser token exchange. Absent a provider answer, every other `/api` subtree, generic RPC channel, and upgrade request requires a valid cookie (`401`), and the trust fence still runs first (`403`).

Between the fence and the cookie check sits one generic admission point: `connection/authenticate(request)`, a synchronous event declared `@mode bail` and resolved through `ctx.bail` — the first defined answer wins and deferral is `undefined`. The decision vocabulary is the literal pair `'allow'`/`'deny'` rather than a boolean because Cordis bail cannot carry `false`: `'allow'` admits without minting a cookie, `'deny'` refuses even a minted cookie or a live launch token. `connection.authorizeIndex` consults it identically, and a provider admit still passes the Host/Origin fence. A provider must verify identity itself — observing a header is never an admission — and its registration stays effect-scoped, disposing with the provider's fiber. GatewayRuntime mounts the shipped provider: its signed `x-dsh-gateway-principal` assertion admits the index, `/api` subtrees, generic channels, and event streams without a browser cookie, while any purpose-bound assertion is confined to its declared HTTP operations and never serves the index or opens a stream. Principal re-verification, purpose restrictions, and AsyncLocalStorage propagation stay in the `connection/request` waterfall — the provider only decides admission.

`apply` is asynchronous because `BrowserAuth.create` awaits the credential record. Web-server registration moved inside `ctx.inject(['webServer'], ...)`, so non-Web compositions keep RPC registration without paying for an HTTP surface. Test and scaffold helpers mint the cookie in-process through `authorizeIndex`; Node-side `hostFetch` attaches it explicitly.

## Alternatives considered

**Keep the trust fence as the sole admission.** The fence blocks DNS rebinding but not a LAN peer or a local process outside the trust list from calling `/api` once `--trusted-host` opens the listener. Session and filesystem authority require a real credential, not reachability.

**Exempt loopback entirely.** Upstream requires the cookie for every `/api` request, loopback included, because another local process can otherwise mint requests the browser then authorizes. Local loopback callers that are not browsers instead reach only `authority: 'loopback'` subtrees, which keep their own fence; ordinary `/api` stays authenticated on every interface.

**Persist the launch token or accept a stored password.** A WeakMap launch token never survives the process, so a leaked URL expires at shutdown and no user-managed credential exists to rotate. The persisted signing secret is randomly generated, never operator-supplied.

**Authenticate only `/api`, not the index.** Serving the shell unauthenticated would still require the cookie before any productive call, so the index authenticates identically and the single exchange covers both.

**Special-case the Gateway principal header inside Connection.** A header-name branch would couple the generic carrier to one deployment and tempt "saw the header" into standing in for verification. The three-state provider event keeps Connection deployment-neutral while the runtime proves signature, expiry, scope, and target itself — including the `'deny'` answer that overrides a valid cookie.

## Consequences

Every browser e2e and profile test now performs the token exchange or attaches the minted cookie; unauthenticated `/api` consumers must either declare `authority: 'loopback'` or obtain a cookie through `authorizeIndex`. Rotating the credential record invalidates outstanding cookies. The launch token is not in the log or on disk, so copying a printed URL into another browser after restart fails closed. Under a mounted GatewayRuntime the provider answers `'deny'` for every request without a valid assertion, so a launch-token URL or minted cookie alone receives 401 — the proxy's signed principal is the only browser credential that runtime accepts, and disposing the provider restores the direct-browser flow.

## Testing

`packages/client/connection/tests/browser-auth.host.spec.ts` pins token exchange, cookie scoping, expiry, secret persistence, and rejection paths, plus provider admit/deny precedence over both; `node-half.host.spec.ts` exercises cookie-bearing transport and the provider event's fence ordering and disposal. Web profile tests perform the exchange against real startup and assert the printed URL carries the token. Real-composition tests without `frontend-static` mint the cookie in-process. `packages/context/gateway-runtime/tests/gateway-admission.host.spec.ts` boots the deployed composition — real Connection, Web server, frontend-static, and GatewayRuntime — and proves index, `/api`, generic-channel, and WebSocket admission under a signed principal alongside every denial path.
