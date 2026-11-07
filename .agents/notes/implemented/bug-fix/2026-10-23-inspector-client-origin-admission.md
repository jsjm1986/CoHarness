# Agent Note: Admit Inspector Client work before acquiring browser resources

Status: implemented

English | [中文](2026-10-23-inspector-client-origin-admission.zh.md)

## Problem

An opt-in Inspector Host can serve local and public-origin browser pages. Client ingest connects directly to the Worker's loopback address. A browser on another machine interprets that address as its own computer; a public document origin also fails the Worker's default origin policy when the browser happens to run on the Host machine. Treating this mismatch as a transient transport failure sustains reconnects and Cordis collection for a Client that the Worker cannot admit.

Sharing bootstrap and DevTools selectors through one runtime module lets the Client bundler extract a synchronous shared chunk used by both the entry and asynchronous panel. The page module system loads package-local chunks only through asynchronous imports; that shared chunk is unavailable when the entry factory executes, preventing the entire workbench from mounting.

## Decision

The Host conveys its additional allowed origins in the Client bootstrap. Client startup and Worker ingest share the same origin predicate, so browser admission precedes source identity, transport, and collector acquisition. A connection reset reevaluates admission before retaining an existing source. Origin admission selects an available capability; Worker binding and token authorization retain their independent ownership. The [package reference](../../../../packages/experimental/inspector/README.md#runtime-layout) owns configuration and lifecycle details, and the [upgrade guide](../../../../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/inspector-client-origin/guide.md) owns custom-bootstrap compatibility.

An ineligible page retains the existing authenticated, same-origin Host debugging relay. Its bottom panel sends an explicit Host-only selection rather than representing Host-only inspection as an absent Client. One shared selection predicate excludes Clients from the source catalog, realm sessions, Cordis query tree, and DOM projection. This display scope does not grant or revoke debugging authority.

Client startup imports `shared/client-bootstrap.ts`, while the asynchronous panel imports `shared/source-selection.ts`. The Host/Worker `shared/web.ts` barrel preserves existing exports without joining the two Client runtime dependencies. Source separation keeps the panel asynchronous and requires no new synchronous chunk-loading protocol.

The [Inspector port decision](../feature/2026-10-18-experimental-inspector-port.md) continues to own optional composition and the fork's Session and wire dependencies. Origin admission constrains browser work without removing the developer-tools bundle or introducing remote Client-ingest transport.

## Alternatives considered

**Widen the Worker bind address or admit the public domain automatically.** Changing an origin policy cannot make a browser's loopback address point to the server. Widening the bind also exposes the direct CDP endpoint, whose loopback binding is its access control and whose evaluation can execute Host code. The authenticated same-origin Host relay already supports the retained Host feature without this expansion.

**Infer eligibility from a generic loopback-connection flag.** An explicitly configured local development hostname can be admitted by the Worker without being a loopback hostname. Reusing the actual Host policy preserves that supported configuration.

**Limit retries or hide the Inspector panel.** A retry budget still acquires a source and collector before a known origin rejection, while hiding the panel removes working Host inspection. Admission removes the unsupported Client work and preserves the existing Host feature.

**Omit the Client selector or invent an unavailable Client id.** Omission includes all Clients, exposing unrelated Client contexts in a panel presented as Host-only. A made-up id is still a valid source identity that a Client can claim. An explicit Host-only scope excludes every Client regardless of its name or id; existing unfiltered and selected-Client modes retain their meanings.

**Inline the entire panel or add synchronous chunk loading.** Inlining brings panel dependencies into the initial factory. A new chunk protocol expands the module loader's responsibilities. Separate runtime modules preserve asynchronous panel loading with the existing protocol.

## Verification

The [Client regression](../../../../packages/experimental/inspector/tests/plugin.client.spec.ts) runs the production plugin with refused fake sockets, the default 250/5000 ms backoff bounds, fixed randomness, and 15 seconds of fake time. The unsupported-origin baseline acquires one source, constructs eight sockets, collects three snapshots, and retains one reconnect timer; admission makes all four counts zero. Localhost, IPv6 loopback, and explicit-allowlist controls retain those counts, and disposal clears the timer. These are bounded work counts, not elapsed-time, retained-memory, or public-network measurements.

[Worker integration](../../../../packages/experimental/inspector/tests/integration.host.spec.ts), [relay coverage](../../../../packages/experimental/inspector/tests/plugin-routes.host.spec.ts), and the [bottom-panel regression](../../../../packages/experimental/inspector/tests/bottom.client.spec.tsx) exercise Host-only inspection while another Client is present, including a Client named Host with source id `host`. Origin-policy coverage also checks real Worker acceptance and rejection independently of the token. These checks establish admission and selection behavior; browser input latency, resource use, and successful Host-only interaction through a deployed public tunnel require separate measurements of the matched built Host, Client, and DevTools assets.

The [assembled Web regression](../../../../apps/web/tests/inspector-boot.e2e.ts) boots the opt-in profile with built Client bundles, a real Worker and authenticated Host routes, then opens the panel under loopback and non-admitted synthetic origins. It also creates and flushes a real Session; on POSIX a plain-Node second process reaches the shipped native `flock` entry and is excluded by the live write lease. The combined-module negative control fails before the workspace chooser with a synchronous `require("./client.web.js")` miss, despite successful `host.describe`. These isolated checks do not exercise Gateway authorization or a deployed tunnel.

## Consequences

Origins that the Worker rejects provide no Client observation service and acquire no Client source, ingest socket, collector, or transport retry timer. Admitted local development retains its source and recovery behavior. Host-only inspection remains available through the existing relay, while Host collectors, fetch capture, and Worker retention keep their own configured costs. Removing unsupported Client work is not a claim that the entire Inspector is free or that public-page latency has been measured.
