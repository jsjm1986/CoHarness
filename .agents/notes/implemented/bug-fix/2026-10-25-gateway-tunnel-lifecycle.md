# Agent Note: Gateway tunnel lifecycle and durable provisioning

Status: implemented

English | [中文](2026-10-25-gateway-tunnel-lifecycle.zh.md)

## Problem

A long-running tunnel can block when the Gateway leaves its output pipes unread; retaining quick-tunnel diagnostics after URL discovery also grows memory with process lifetime. Failed allocation emits `error` and `close` without requiring `exit`. Dropping a process handle after failed termination permits overlapping public entries, and an old exit-state write can overwrite a replacement's state. Shutdown can overlap an accepted startup.

Named provisioning expects a run token in the create response, although Cloudflare documents a separate token endpoint. Rejecting that valid response loses the acknowledged tunnel id. Replacement input validation after remote deletion can destroy working configuration for an invalid request.

A live process or printed URL does not prove an edge connection. Stop can wait behind registration, a stale resume read can revive a newer stop, and production writer drainage can block the cancellation needed to finish that writer.

Failed downloads can retain an unread response or an open archive. Staging on another filesystem prevents rename-based installation; publishing before permission changes can expose an incomplete candidate. Cancellation confined to connector registration leaves discovery, installation and Cloudflare preparation blocking the action queue.

## Decision

The [process owner](../../../../gateway/src/tunnel-process.ts) drains both output streams for both modes. Quick discovery retains a DNS-sized prefix per stream, detaches scanning on readiness or failure, and keeps drainage active. Each mode returns a cleanup handle before registration. Its `ready` promise requires the owned child's PID in a new private file; quick mode also requires its URL. The pinned [cloudflared implementation](https://github.com/cloudflare/cloudflared/blob/2026.9.3/cmd/cloudflared/tunnel/cmd.go) writes that file after its connection signal. File reads are bounded and reject special files; disk PID values never select signal targets. Startup and native closure have separate deployment-configured deadlines. Failed closure or private-file cleanup retains retry ownership; the parent-exit observer belongs to the handle and detaches after native closure.

The [controller](../../../../gateway/src/tunnel-access.ts) serializes exit-state writes with administrator actions. Stop and Clear immediately cancel earlier accepted starts, including queued requests; cancelled starts report `409 tunnel-start-cancelled`. An intent version prevents a stale resume read from reviving a newer explicit action. A failed stop retains its cleanup handle and reports `tunnel-stop-unconfirmed`; replacement and remote cleanup wait for confirmed local termination. Shutdown closes admission, cancels registration, drains accepted work and permits cleanup retry without changing restart intent. Production shutdown starts background cancellation before waiting for HTTP writers and awaits all cancellation outcomes.

Cancellation covers binary discovery, version execution and Cloudflare preparation; shutdown also cancels installation and cleanup requests. Native helper commands await their own close event after cancellation. Acknowledged create ids and tokens finish durable publication before cancellation prevents further remote work or process allocation. Custom discovery and installation implementations receive the signal and must honor it while awaiting external work.

Installation stages under the destination binary directory, verifies bytes, extracts and sets executable permissions before atomic publication. The [Node stream pipeline](https://nodejs.org/docs/latest-v22.x/api/stream.html#streampipelinesource-transforms-destination-callback) owns a Node-readable adapter for the response and the archive writer; cancellation reaches the source, and staging removal waits for the writer's native close. Rejected HTTP responses cancel their bodies. Failed download, validation or extraction preserves the installed binary.

Named inputs use canonical DNS names and pass credential/domain checks before destructive work. The selected zone supplies its owning account. Acknowledged create ids are persisted before requesting the [connector token](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/token/methods/get/); retries reuse that id and resume incomplete configuration. Remote result fields and HTTP status are validated. Clear removes retained named resources even when the current execution mode is quick. The [feature decision](../feature/2026-10-18-admin-managed-public-access-tunnel.md) continues to own the UI, encryption and exposure choices.

The selected connector token is supplied through Cloudflare's documented `TUNNEL_TOKEN` environment entry after ambient filtering. It never appears in process arguments. Kernel account isolation still determines who can inspect another process environment; local same-account execution provides no new OS isolation.

## Alternatives considered

**Discard diagnostics without reading the pipes.** The producer still blocks when the kernel pipe fills. Reading and discarding avoids both backpressure and retained output.

**Publish stopped after requesting termination.** A request is not closure evidence; keeping the handle preserves retry and prevents replacement overlap.

**Create another tunnel after token retrieval fails.** Creation already succeeded. Persisting the acknowledged id retains the resource needed for retry and later cleanup.

## Consequences

Tunnel children share the Gateway's deployment-environment filter. Cloudflare provisioning is a sequence of external requests; a lost create response can require provider-side reconciliation, and this change does not establish atomic remote transactions. Forced Gateway death still depends on host service containment. The local fixture validates protocol handling without a Cloudflare account; it does not establish live Cloudflare availability or native service containment.

## Verification

Real local processes reproduce blocked named output and misreported failed quick allocation before repair. Controlled barriers reproduce lost cleanup, shutdown overlap and stale exit writes. API regressions reject malformed replies, accept documented create fields and preserve working configuration on invalid replacement input. The authenticated PostgreSQL/Gateway/Web assembly exercises real tunnel processes against a local HTTP Cloudflare substitute, checks deployment-variable absence, retries token retrieval against the same durable id, holds quick/named launches before registration, and confirms real child socket closure after cancellation, timeout and Gateway shutdown. A regression executes the production shutdown function against a blocked writer; controlled start/stop/resume barriers prove intent ordering.

Real file streams and executable fixtures verify failed-download closure, cancellation, version-probe closure and installed-binary retention. The built Admin transcript exercises an actual installer failure through authenticated HTTP and checks response cancellation. A real pinned release passes download, SHA-256, extraction, permissions, publication and native version detection; it does not establish Cloudflare edge connectivity.
