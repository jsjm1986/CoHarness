---
description: "Node enrollment, credential recovery and outbound connections to existing Gateway services."
---

# Node-agent access reference

English | [中文](README.zh.md)

## Summary

Register macOS, Linux and Windows x64 or arm64 computers and connect their existing Gateway services through an outbound agent. The agent needs no PostgreSQL credential or inbound listener. Enrollment reports `executionReady: false` and grants no runtime authority. Computer use and capability qualifications have separate per-computer policies. The organization’s [deployment mode](../deployment-topology/README.md) controls aggregation; browser and Admin workflows retain explicit computer and Runtime identities. Each collaborative project belongs to its selected computer.

## Contents

- [Run an agent](#run-an-agent)
- [Administrator API](#administrator-api)
- [Computer permissions](#computer-permissions)
- [Existing Gateway services](#existing-gateway-services)
- [Runtime isolation](#runtime-isolation)
- [Configuration](#configuration)
- [Recovery](#recovery)
- [Verification](#verification)

<a id="run-an-agent"></a>

## Run an agent

Use the same built workspace release as the center. From `gateway/`, `npm run node:agent` runs the source entry; `node lib/node-agent-main.js` runs the compiled entry after `npm run build`. Set the center URL, state file and first-run enrollment token using the variables below. HTTPS is required except for loopback HTTP during local verification; redirects and credential-bearing URLs are refused.

The agent flushes a generated credential to its private file before exchanging the ticket, then removes the saved ticket after successful enrollment. Later starts use the saved credential at the same center origin. `SIGINT` and `SIGTERM` cancel network requests and retry waits, then attempt release within the request timeout. Logs contain public identities, connection state and actionable failure codes, excluding credentials.

The control socket sends WebSocket Ping frames at the authenticated lease’s heartbeat interval. These frames keep an idle network connection active; they renew neither the database lease nor Runtime execution authority.

Transport authorization shares the node row across concurrent readers. Enrollment, credential changes and lease updates retain exclusive row locks; a reader waiting for a mutation rechecks the committed credential and expiry. Shared locks permit concurrent browser requests when the Gateway database is reached over a slower network, without caching authorization.

<a id="administrator-api"></a>

## Administrator API

The Admin deployment page provides a separate computer-access section with registration, explicit reissuance and revocation, and bounded metadata pages. Reads are cancelable and single-flight, retain the displayed page on transient failure, and clear cached rows and codes after authority loss. One-time codes remain masked until revealed, are copied only by an explicit action, and leave component memory when closed; the page never stores them in browser persistence. Mutation failures with an unknown outcome block repeat submission and direct the administrator to inspect refreshed metadata.

These endpoints require an administrator session and the existing browser-origin checks. Each operation rechecks current account, membership and organization authority. `requestId` is a caller-generated UUID for each issuance; `revision` comes from the directory.

| Method and path | Request | Result |
|---|---|---|
| `POST /admin/api/deployment/nodes/enrollments` | `{ "requestId": "<UUID>", "name": "computer-a" }` | 201: node ID, enrollment ID, revision, one-time token and expiry |
| `GET /admin/api/deployment/nodes/access` | Optional `limit` and `cursor` query fields | Bounded `items` and `nextCursor`; statuses `pending`, `connected`, `disconnected`, `revoked`, `detached` |
| `POST /admin/api/deployment/nodes/access/<node UUID>` | `{ "action": "issue-enrollment", "revision": 1, "requestId": "<new UUID>" }` | Replace ticket and invalidate previous credential/lease, preserving node ID |
| `POST /admin/api/deployment/nodes/access/<node UUID>` | `{ "action": "revoke", "revision": 1 }` | Invalidate credential, tickets and lease; retain instance records |
| `POST /admin/api/deployment/nodes/access/<node UUID>/probe` | No payload | Confirmed platform/architecture/uptime observation bound to the replying connection and epoch; no runtime launch |

Tokens are returned once. Reusing a committed issuance UUID returns 409; a lost response requires directory inspection and explicit reissuance. Stale revisions return 409. Existing Gateway nodes cannot be adopted. Separate node bearer credentials authenticate `/internal/nodes/{enroll,connect,heartbeat,disconnect}` and cannot authenticate browser or runtime APIs. The center stores SHA-256 digests and omits secrets from audit details.

Issued tickets and node credentials belong to the organization. Consuming a ticket rechecks organization, node revision, expiry and its original candidate credential; it does not recheck the original issuer’s current administrator role. Revoke node access to invalidate previously issued capabilities.

Issuance reserves an offline compute-node record immediately. The existing complete backup/restore restriction counts these records even while enrollment is pending; revocation retains the record. The Admin registration dialog displays this effect before submission.

<a id="computer-permissions"></a>

## Computer permissions

Organization administrators configure computer use through the center, independently of the computer's connection. These endpoints use the existing browser session and origin checks; writes recheck administrator authority inside the transaction, retain optimistic revisions, and commit their audit record with the decision.

| Endpoint | Input | Result |
| --- | --- | --- |
| `GET /account/api/computers` | Optional `cursor` node UUID and `limit` | One bounded page of the caller's granted computers |
| `GET /admin/api/users/<user ID>/computers` | Optional `cursor` and `limit` | One bounded page including saved and unconfigured decisions |
| `PUT /admin/api/users/<user ID>/computers/<node UUID>` | `{ "enabled": true, "revision": "0" }` | Committed decision and decimal revision; stale revision returns409 |

Creating an account preserves the existing first-personal-space allocation and grants use of that space's computer. Existing personal assignments receive the same grant through migration079. Another computer requires an explicit decision. A grant creates neither a personal Runtime nor project membership, and project membership cannot replace the hosting computer's permission. Runtime directories, project entry, personal startup, captured execution participants and ordinary Runtime request assertions recheck computer use. Purpose-limited Admin management retains its existing authority.

Desktop, terminal, SSH, plugin, memory and steward qualification policies and revisions are stored per computer through migration080. Existing policy endpoints configure the handling Gateway's computer; an explicit Admin `dshNode` routes that operation to the selected computer. Computer use, capability qualification, Session confirmation and physical-resource occupancy remain separate. Node-specific changes cancel affected traffic and execution on that computer; they do not invalidate another computer's policy or stop a shared project for unrelated participants. Revocation does not certify process exit, and resource-finish authentication remains available for owned cleanup. Follow the [upgrade guide](../../../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/computer-permissions/guide.md) for unplaced legacy qualifications.

On enrolled computers, migration081 binds each started Runtime generation to its node connection UUID and epoch. Startup, reuse of a ready process and ordinary Runtime credentials require that exact live connection. Reconnection cannot authorize an old generation. Execution watches recheck credentials before heartbeats and close on refusal, monitor loss or an authority read exceeding `HGW_UPSTREAM_TIMEOUT_MS`; checks never overlap. Existing runtime plugins cancel affected execution when their watch closes. Cleanup credentials remain usable for the owned generation, and connection loss changes neither its stopped state nor resource ownership. Gateways without an agent registration retain their existing local execution rules.

<a id="existing-gateway-services"></a>

## Existing Gateway services

Deploy the same built project on the managed computer. Its existing Gateway uses the same organization database and credential-encryption keys, with its own compute-node registration, local paths, instance manager, launchers, supervisors and plugin profiles. Configure each local Gateway to accept the center's browser origin. The local Gateway retains its normal deployment credentials; the separate node-agent process receives only its enrollment credential and a fixed loopback Gateway origin. This bridge does not import an independent deployment or synchronize its users and files.

With multi-computer mode enabled at the primary and `HGW_NODE_LOCAL_GATEWAY_URL` configured for the agent, API requests with an authorized `dshRuntime` select that environment's computer. Administrator API requests may explicitly select `dshNode=<node UUID>`; current administrator authority is rechecked. The destination repeats existing browser-session, origin, account and business authorization. A target-node header is checked before its handlers run. The browser uses the center origin throughout.

Existing personal/project selectors and the scope cookie also resolve placement from center metadata. Root HTML, assets, account APIs and runtime HTTP/WebSocket traffic use the selected computer. Scope changes parse their bounded request body before forwarding it to the exact Runtime. An ambiguous owner selector returns409 and requires `dshRuntime`; it never selects the first environment. Account context and workbench catalog responses include `environment: { id, nodeId }` when a directory is composed. Purpose-limited Admin APIs do not require the administrator to own a personal Runtime on the selected computer.

Account preferences, push-device registrations and `GET /account/api/projects` use shared account storage without selecting or contacting a Runtime. The workbench directory uses authorized placement metadata even when the selected allocation belongs to another computer. Project creation retains its explicit computer target. The browser’s SVG icon follows the referring tab’s verified Runtime selection.

The existing Admin shell has a computer selector. `/admin/computers/<node UUID>/...` retains the selected computer across its existing pages, API methods, plugin installation streams and archive exports. Changing computers replaces the document so pending page operations retain their original target. Center identity and one bounded page of registered-computer metadata load independently; node enrollment stays at the center. Failed metadata reads retain the displayed page, and an unavailable selected computer never falls back to the center. The project-settings shortcut resolves the project’s assigned environment and checks the administrator’s own computer use permission.

While owned HTTP borrowers or retiring transports occupy the service limit, new HTTP requests wait for a reusable connection in a bounded queue. The queue permits 256 pending requests and waits up to 60000 ms by default; cancellation and shutdown withdraw pending borrowers without sending their requests. Queued POSTs are forwarded once after acquisition, and destination authorization remains current. Capacity occupied only by unrelated active streams still refuses admission.

HTTP service connections use a bounded idle pool per computer; each connection serves one request at a time. Browser WebSockets keep exclusive outbound streams. Every connection belongs to the enrolled node, connection UUID and lease epoch. The agent authenticates the local Gateway identity and required release when opening a stream, and the primary rechecks the node credential and lease whenever an idle connection is borrowed. Both Gateways retain their per-request account, computer, project and Runtime authorization. Bodies and responses stream with backpressure; binary frames and global/per-node connection capacity remain bounded. Cancelling a request closes its own connection. Revocation, channel replacement and shutdown close affected streams, and detachment drains idle connections before checking active work. Forwarded operations are never replayed. A lost node credential reports service unavailability rather than invalidating the browser login.

New organizations use single-computer mode; primary configuration and explicit attachment follow the [deployment reference](../deployment-topology/README.md). Directory availability labels retain the default execution restriction. An uncertain transport result does not prove that an operation failed or that a process stopped. Existing process ownership, resource drainage, operation receipts and backup coverage retain their owners.

See [browser environments and document locations](browser/README.md) for computer cards, tab isolation, document ownership and the browser document API.

A cancelled bridge retains its node service slot until socket and pipeline cleanup completes. At capacity, each such slot can reserve one successor, which opens no local connection until that cleanup finishes. Active full slots still refuse admission. Cancellation also removes a successor's permission to start, and shutdown waits for both active and reserved work. See [bridge retirement](../../../.agents/notes/implemented/bug-fix/2026-11-01-node-service-retirement-admission.md).

<a id="runtime-isolation"></a>

## Runtime isolation

On Windows, the Gateway signs a validity start one system-clock tick (16 ms) before issuance. The expiration deadline still comes from the actual issuance time and the configured lifetime. The receiving Runtime checks the signature, exact identity, generation and both time boundaries.

Lifecycle queues, private credentials, signed principals, resource registrations and Session execution records retain the allocated Runtime UUID. A credential and principal must agree on that UUID, owner and process generation. PostgreSQL preserves an owner/node generation counter across assignment retirement; generations are monotonic and may skip values. Confirmed-stop cleanup reclaims only the stopped Runtime's registrations. Queued work loses admission when its exact node connection becomes invalid, while active or uncertain occupation remains until owned cleanup is confirmed.

Each computer records its account working directory independently. Existing personal assignments retain `<usersRoot>/<username>/dsh`; an isolated assignment uses `<usersRoot>/<username>/runtimes/<Runtime UUID>/dsh` and a distinct supervisor name. Settings, plugin state and Session data belong to that private directory. Working-directory grants retain their existing account/project rules. Account preferences remain account-wide, including their existing legacy settings migration source.

Model usage reporting credentials belong to the exact Runtime and computer. Starting or refreshing another Runtime does not rotate them. Billing, model access and quotas retain their account/project owner; a reporting credential grants no execution authority. Existing deployed credentials can finish reporting during the coordinated upgrade. Preparing assignments receive no policy-file projection.

Personal documents belong to the account on one computer and remain shared by its local Runtimes. Catalog paths, filesystem incarnations, projection roots, mutations and metrics are computer-scoped. Session metadata and archive commands retain Runtime identity; archive content cleanup belongs to its computer. Retired identities and unassigned historical metadata grant no replacement Runtime access. Released Session JSONL generations remain unchanged.

### Allocation and administration

Existing account creation provisions its first personal space. Administrators allocate additional stopped Runtimes on the selected computer after granting computer use. Organization defaults limit each account to eight assignments across computers and four on one computer; account overrides may replace those limits. Preparing, stopped and running assignments all count. Lowering a limit removes no assignments. Policy writes require the observed `revision`; `limits: null` clears an account override while retaining its revision history.

| API | Request | Result |
|---|---|---|
| `GET/PUT /admin/api/runtime-allocation-policy` | PUT `{ revision, limits: { maxTotal, maxPerNode } }` | Organization policy |
| `GET/PUT /admin/api/users/<id>/runtime-allocation-policy` | Same fields; nullable `limits` | Account override or inherited policy |
| `GET /admin/api/users/<id>/runtimes` | Optional `limit` and `cursor` | Bounded owner directory across computers |
| `POST /admin/api/users/<id>/runtimes?dshNode=<node UUID>` | `{ requestId: <fresh UUID> }` | Original Runtime identity and allocation status |
| `GET /admin/api/runtime-allocations/<request UUID>` | No node contact | `preparing`, `allocated` or `retired` receipt |
| `GET /admin/api/runtimes/<Runtime UUID>` | No node contact | Current assignment metadata |
| `POST /admin/api/runtimes/<Runtime UUID>/start` | `{}` | Existing launcher admission and resulting generation |
| `POST /admin/api/runtimes/<Runtime UUID>/stop`, `/restart`, `/retire` | `{ generation: <reviewed generation> }` | Exact process operation; retire accepts personal assignments |

Allocation reserves its identity and quota in a short transaction, prepares local directories without database locks, then rechecks authority before publishing readiness. Failure leaves a `preparing` receipt and prevents startup. Repeating the original request on the same computer resumes that allocation without another quota slot; the center receipt remains readable while the computer is offline. A reused request for another account or computer returns409. Forwarding never retries the operation automatically.

Stop, restart and retirement reject stale generations before cancelling work. Retirement requires process-owned confirmed quiescence and retains private data, storage history and the allocation receipt; bootstrap repair cannot recreate it. Account deletion requires every computer's assignment to be stopped or protected by a matching confirmed-stop operation. An unavailable computer cannot establish that proof. Account-wide policy changes still reach every local assignment through the existing durable permission monitor. Existing terminal and personal-instance APIs accept `dshRuntime`; purpose-limited Admin management does not require the administrator's own personal assignment on that computer.

Webhook configuration binds its exact Runtime and computer. Same-owner configuration edits retain that binding unless another explicit Runtime is supplied. Public ingress at the center streams to the owning Gateway, which checks the original signature and current endpoint revision before creating a Runtime-bound receipt. Unplaced legacy endpoints are disabled during migration and require explicit rebinding. Backup collection retains separate inventories for retired personal Runtimes; complete database bundles still require the existing single-organization, single-computer coverage proof.

<a id="configuration"></a>

## Configuration

Center settings are validated at startup. Node directory pages share the [Gateway directory limits](../../README.md) for rows and complete UTF-8 response bytes.

| Center variable | Default | Meaning |
|---|---|---|
| `HGW_NODE_ENROLLMENT_TTL_MS` | 600000 | Ticket lifetime in milliseconds |
| `HGW_NODE_AGENT_LEASE_MS` | 30000 | Lease lifetime; at least three heartbeat intervals |
| `HGW_NODE_AGENT_HEARTBEAT_MS` | 5000 | Heartbeat interval returned to agents |
| `HGW_NODE_CONTROL_MAX_INFLIGHT` | 16 | Concurrent admitted control operations; excess requests receive 503 |
| `HGW_NODE_CHANNEL_MAX_CONNECTIONS` | 64 | Connected node control sockets |
| `HGW_NODE_CHANNEL_MAX_INFLIGHT` | 64 | Concurrent probes and lease checks |
| `HGW_NODE_CHANNEL_MAX_PER_NODE` | 4 | Concurrent probes for one node |
| `HGW_NODE_CHANNEL_REQUEST_TIMEOUT_MS` | 10000 | Probe deadline |
| `HGW_NODE_CHANNEL_MAX_FRAME_BYTES` | 16384 | Complete control-message byte limit, within 1024–65536 |
| `HGW_NODE_CHANNEL_MAX_BUFFERED_BYTES` | 65536 | Control socket buffer budget, covering at least one frame |
| `HGW_NODE_SERVICE_FORWARDING` | `off` | Legacy primary initialization only; saved organization policy controls aggregation |
| `HGW_NODE_SERVICE_MAX_CONNECTIONS` | 64 | Pending and active service connections across nodes |
| `HGW_NODE_SERVICE_MAX_PER_NODE` | 16 | Pending and active service connections for one node |
| `HGW_NODE_SERVICE_CONNECT_TIMEOUT_MS` | 10000 | Service connection acquisition deadline |
| `HGW_NODE_SERVICE_HTTP_IDLE_TIMEOUT_MS` | 30000 | Maximum idle lifetime of a reusable HTTP service connection |
| `HGW_NODE_SERVICE_HTTP_MAX_IDLE_CONNECTIONS` | 16 | Global idle HTTP connection limit, bounded by the total service limit |
| `HGW_NODE_SERVICE_HTTP_MAX_IDLE_PER_NODE` | 2 | Per-computer idle HTTP connection limit, bounded by both global idle and per-computer service limits |
| `HGW_NODE_SERVICE_HTTP_MAX_PENDING_REQUESTS` | 256 | Maximum HTTP borrowers waiting for owned connections |
| `HGW_NODE_SERVICE_HTTP_QUEUE_TIMEOUT_MS` | 60000 | Maximum HTTP acquisition queue wait |

Node settings are resolved before file or network acquisition.

| Node variable | Default | Meaning |
|---|---|---|
| `HGW_NODE_CENTER_URL` | Required | HTTPS origin; loopback HTTP is accepted locally |
| `HGW_NODE_CENTER_DIAL_URLS` | `HGW_NODE_CENTER_URL` | Comma-separated ordered origins the agent dials instead; each follows the center-URL rule |
| `HGW_NODE_AGENT_STATE_FILE` | `~/.dsh-node/access.json` | Credential file private to its owning account (mode 0600 on macOS/Linux, an ACL limited to the file owner plus SYSTEM and Administrators on Windows) |
| `HGW_NODE_ENROLLMENT_TOKEN` | Required for a new state file | Administrator ticket; enrolled records use their saved credential |
| `HGW_NODE_AGENT_REQUEST_TIMEOUT_MS` | 10000 | Network request and shutdown-release timeout |
| `HGW_NODE_AGENT_RETRY_MS` | 3000 | Delay between idempotent control retries |
| `HGW_NODE_AGENT_DIAL_PREFERRED_RETRY_MS` | 60000 | After a dial fallback, the first fresh attempt at least this long later re-probes the first dial origin |
| `HGW_NODE_AGENT_CHANNEL_ENABLED` | `1` | `0` disables the control socket; incompatible with a local service bridge |
| `HGW_NODE_AGENT_CHANNEL_MAX_INFLIGHT` | 4 | Concurrent read-only probe handlers |
| `HGW_NODE_AGENT_CHANNEL_MAX_FRAME_BYTES` | 16384 | Complete received/sent control-message byte limit |
| `HGW_NODE_AGENT_CHANNEL_MAX_BUFFERED_BYTES` | 65536 | Outbound control buffer budget |
| `HGW_NODE_LOCAL_GATEWAY_URL` | Unset | Fixed `http://127.0.0.1:<port>` or IPv6 loopback origin for the existing Gateway |
| `HGW_NODE_AGENT_SERVICE_MAX_CONNECTIONS` | 16 | Concurrent local Gateway bridges, independent of probes |

`HGW_NODE_CENTER_DIAL_URLS` names the transport, never the identity. Every listed origin must reach the same center: the credential file still binds `HGW_NODE_CENTER_URL`, and enrollment, identity and state checks do not move. The list covers deployments where the public origin is not the node's best route — an SSH reverse tunnel to loopback (`http://127.0.0.1:<port>`), a LAN address, a mesh overlay, then the public origin last. An attempt that gets no HTTP response — a refused connection, a timeout, a socket that dies before `open` — moves dialing to the next entry; any HTTP response, including a refusal, counts as reaching a center and never triggers failover. An in-flight attempt is never replayed to another origin; only the next fresh attempt sees the change.

<a id="recovery"></a>

## Recovery

Each process generates a connection UUID. PostgreSQL grants one live lease per node and advances its epoch after expiry or release. Repeating acquisition with the same UUID recovers a lost response. Another live process receives 409; delayed heartbeats and releases cannot affect a successor epoch. Expired heartbeats require a new lease. Every request checks credential revocation. Network failures and center capacity refusals retry the same operation and emit degraded diagnostics.

An interrupted successful response retries with the same saved credential and process connection UUID. HTTP 429 and 5xx remain retryable when their error body is unreadable or exceeds the response limit. Malformed or oversized successful responses and mismatched identities remain fatal. A missing response does not extend the center's lease. See [control-response recovery](../../../.agents/notes/implemented/bug-fix/2026-11-01-node-control-response-recovery.md).

A lost enrollment response can be recovered using the saved candidate credential and original ticket while it remains valid. An expired ticket or revoked credential requires administrator reissuance and a new private state-file path; preserve the old file for diagnosis. Origin mismatch, invalid state or unsafe file permissions stop startup. Unconfirmed release reports `stopped-lease-uncertain` and exits with failure; the center expires the lease without further heartbeats.

Connection leases are separate from maintenance writer acknowledgements. Enrolled compute nodes start offline. Connectivity alone never activates runtime routing, releases process allocations or certifies stopped writers. Node metadata mutations honor the center maintenance and restore write-epoch checks; directory reads remain available. Full multi-node backup/restore retains its existing refusal. Metadata reads never contact nodes, enumerate files or start runtimes.

<a id="verification"></a>

## Verification

With `HGW_TEST_DATABASE_URL` selecting a disposable test database, `npm run test:postgres` includes an authenticated Gateway transcript and two independent source node processes. `npm run test:built-node-agent` builds and repeats the process scenario under plain Node. The scenarios cover simultaneous connections, independent stop, credential revocation, the real Admin client’s issue/reissue/revoke flow, and zero runtime launches. Loopback verification does not establish public-ingress, cross-computer or Windows runtime acceptance.

`npm run test:built-node-service` uses two independent compiled Gateway processes, a compiled node-agent process, PostgreSQL and the shipped Web profile. Its recorded transcript verifies one center login, the existing remote Admin API, runtime startup on the selected computer, a real workspace event over the runtime WebSocket, and unavailable-node refusal without a center replacement. It requires built workspace artifacts and the same disposable database setting. Package tests also cover bounded binary transfer, partial HTTP delivery, node identity mismatch, independent control capacity, revocation and cancelled acquisition teardown.

## Dev Note

The [multi-computer design](../../../.agents/notes/proposed/architecture/2026-10-28-multi-computer-personal-runtimes.md) owns routing, environment identity, performance isolation and deferred execution decisions.
