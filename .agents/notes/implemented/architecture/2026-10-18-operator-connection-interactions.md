# Agent Note: Operator connections declare an interaction mode scoped per request

Status: implemented

English | [中文](2026-10-18-operator-connection-interactions.zh.md)

## Problem

Upstream rc.2 gave non-page/programmatic clients a way to connect to a running Host: a launch-token exchange that mints a `Peer` carrying an `interactions` mode (`'none'` or `'answer'`), where `'none'` Peers never open the `$events` loop and cannot answer interactions. The fork owns the same product need — an operator process (CI, scripts, ACP-style automation) must reach a live Host without a browser cookie — but none of the machinery: there is no `Peer`, no operator cookie minting, and no `$events` stream. The fork authenticates every request independently through `rejectionFor`, multiplexes interaction frames with ordinary frames on one mux downlink, and already claims interactions atomically through `CollaborationAuthority.claimInteraction`.

## Decision

**The interaction mode is declared per request, not bound to a minted credential.** `ConnectionInteractions = 'none' | 'answer'` lives in `packages/host/apiproxy/src/api/interactions.ts` — a dependency-free contract file carrying the type, the `x-dsh-interactions` header / `?interactions=` query names, a strict parser, and `interactionsUnavailableError()`. Every client URL declares the resolved mode; `ConnectionRequestBoundary` gained `url` so the declaration is visible on headerless carriers (the WebSocket constructor takes no headers).

**The launch token doubles as the operator credential through the existing fallback.** `rejectionFor` still runs the trust fence and the `connection/authenticate` provider bail first; when the provider returns `undefined`, `browserAuth.operatorInteractions(url)` reads `Authorization: Bearer <token>` or `?token=` and the declared mode. A present-and-valid credential with a valid mode admits; a present-but-invalid token or malformed mode denies with 401 — an operator credential never launders through the cookie fallback. The browser cookie path behind it is untouched. Keeping this inside `BrowserAuth`'s fallback — rather than a `connection/authenticate` listener — preserves the provider's precedence: a composition listener that answered `'allow'` before `gateway-runtime`'s would bypass the mandatory gateway-principal policy.

**Admission binds the mode into AsyncLocalStorage request scope.** The connection plugin registers a `connection/request` waterfall listener (the same seam `gateway-runtime` uses to bind the per-request principal) that calls `bindRequestInteractions`. Resolution order: a valid declared mode wins; otherwise a token-admitted operator defaults to `'none'`; otherwise `'answer'`. Unbound scopes — in-process dispatch, internal calls — read `'answer'`, so nothing historical deprivileges itself.

**Server-side gating withholds interaction traffic, not the connection.** `events.mux` captures the scope at subscribe time: the publish loop drops `approval/requested`/`approval/resolved`/`question/requested`/`question/resolved` frames and the initial replay skips pending approvals/questions for `'none'`. `events.host` never registers the `API_REMOTE_FORWARDED_EVENTS` listeners, so no `host/remote-event` frame is produced for a `'none'` subscriber. `respond` returns `{ accepted: false, reason: 'not-pending' }` for `'none'` before registry lookup — the honest receipt from a requester that was never shown the interaction. Ordinary session, queue, jobs, and workspace frames keep flowing on the same socket: `'none'` is an observation deprivilege, not a disconnect.

**Client helpers fail fast on the resolved mode.** `installConnection` resolves `options.interactions ?? (location === undefined ? 'none' : 'answer')` — identical to upstream's rule — and exposes it on `ConnectionHandle.interactions`; `ClientTransportHooks.createApiClient` receives it so transports honor one source. `AbstractApiClient.respond` throws the stable `interaction participation is unavailable on a 'none' connection` error before any wire call, covering `PendingWait.respond` and hand-rolled callers. `ClientRemoteService.$on` throws the same error before subscribing. `$stream` stays ungated: it supervises Remote read streams, which `'none'` must keep. Session frame handling additionally skips minting approval/question `PendingWait`s when the API client is bound `'none'`, so a stale or filtered frame can never arm an answer path.

**`createOperatorTransport(baseUrl, token)` is the programmatic entry.** It returns `ClientTransportHooks` whose API client, socket factory, and generic-RPC fetcher rebase every request onto `baseUrl` with `token` and `interactions` query parameters. `installConnection(ctx, { transport: createOperatorTransport(...) })` on a non-page context defaults to `'none'`; passing `interactions: 'answer'` grants full participation under the same atomic claim path — `claimInteraction` still decides a race, and the second claimant receives `not-pending`.

## Alternatives considered

**Port upstream's `/connect` exchange + Peer cookie.** Rejected: minting a session credential duplicates what per-request authentication already does, adds lifecycle state the fork does not otherwise hold, and the browser-auth Agent Note already constrains cookie minting to the index exchange.

**A `connection/authenticate` provider that allows on launch token.** Rejected: the bail's first defined answer replaces browser auth wholesale and listener order is composition-dependent; an early `'allow'` would let a launch token past gateway-principal policy. Embedding the check in the existing fallback keeps every provider's `'deny'` denying.

**Refuse `'none'` downlinks entirely, like upstream's missing `$events`.** Rejected: the fork's mux carries unary-RPC-adjacent session traffic an operator legitimately watches; withholding only interaction frames preserves observable operation while honoring the contract.

## Consequences

Page installs are byte-identical except api URLs carry `?interactions=answer` — admission binds the declared mode and behavior is unchanged. A `'none'` connection keeps unary RPC, raw streams, mux, and host downlinks minus interaction frames; it cannot observe or answer approvals, questions, or forwarded interaction events, and its client helpers throw before reaching the wire. Bad launch tokens and malformed mode declarations return 401 at admission.

Regression coverage lives in `packages/client/connection/tests/interactions.client.spec.ts` (defaults, operator URL decoration, fixture parity), `packages/host/apiproxy/tests/api-proxy-interactions.spec.ts` (mux/replay/remote-event filtering, respond refusal, atomic two-claimant race, unbound fallback), `packages/api/gateway/tests/gateway.client.spec.ts` (`$on` gating, unary preserved), and `packages/client/connection/tests/node-half.host.spec.ts` (operator admission and 401 cases). Design mapping: upstream `interactions` mode maps to the connection's declared mode, upstream `claimInteraction` maps to the same-named atomic claim on `collaboration.authorize`, and upstream `/connect` token exchange maps to launch-token admission on the fork's own authenticate seam.
