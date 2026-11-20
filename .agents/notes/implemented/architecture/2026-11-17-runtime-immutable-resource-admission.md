# Agent Note: Read-only admission for immutable Runtime resources

Status: implemented

English | [中文](2026-11-17-runtime-immutable-resource-admission.zh.md)

## Problem

Revisioned browser modules contain no execution request, but ordinary proxy admission writes Runtime activity and repeats governance reads. A distant governance database multiplies that cost across startup scripts. Removing authorization or trusting a ready row would expose resources after withdrawal or from another process generation.

## Decision

Strict GET/HEAD resource requests use [RuntimeAssets](../../../../gateway/src/runtime-assets.ts). A fresh PostgreSQL statement qualifies the browser session, organization, account, membership, computer/project access, entry topology, exact Runtime assignment, ready/provisioning state, registered generation and managed-node connection. The connected access monitor accepts only that statement's exact authorization revision; a newer local revision rejects the read. No account, placement or eligibility result survives the request. Ordinary browser authentication retains its existing session renewal.

The local lifecycle queue checks the already tracked supervisor before the fresh read and retains a generation-specific reference without writing activity. That reference prevents idle reaping until the response transport closes. Untracked or incompatible generations refuse the resource instead of attaching, starting or replacing a process. Same-version workbench entry remains responsible for ordinary observation and recovery. The [survivor policy](2026-11-11-runtime-survivor-retention.md) still preserves incompatible processes and their accepted work; resource reads never make an unsafe upgrade permissible.

The Gateway signs `runtime-asset` with the exact method, raw resource URL, Runtime identity and generation. The receiving [GatewayRuntime](../../../../packages/context/gateway-runtime/README.md) independently validates the resource protocol and signature before WebServer resource dispatch, retaining Connection's Host/Origin checks. The assertion cannot admit index, API, events, upgrades or execution. Only revisioned plugin combos, published client chunks/maps and hashed assets qualify; arbitrary revision queries and unversioned resources retain their ordinary routes. Release-bundled files still use the [entry-owned release server](2026-11-06-center-serves-release-assets.md).

Remote resources reuse the bounded authenticated node transport and repeat qualification at the owner. Permission withdrawal, monitor disconnection, client cancellation, shutdown and the earliest login/node-lease deadline cancel active delivery. Local forwarding strips browser credentials, response cookies, identity headers and hop-by-hop headers, streams with backpressure, and awaits HTTP closure before releasing the reference. A manually stopped generation returns409; other unavailable generations return503 without lifecycle mutation.

## Alternatives considered

**Retain ordinary execution activity admission.** This keeps activity writes and repeated governance exchanges on immutable reads and lets script downloads postpone on-demand idle release.

**Cache a successful account or ready-generation check.** A cached permission can outlive revocation; a cached port can identify a successor. One request's fresh database result and the receiving process's generation verification retain those checks without cross-request reuse.

**Trust the URL revision or a Gateway-only guard.** A revision selects bytes, not a user or process. The receiving Runtime must check the assertion before a plugin route can publish bytes.

**Start or attach during an asset read.** Hidden recovery gives resource loading lifecycle effects and can replace a generation. Explicit workbench entry owns that behavior.

## Consequences

Resource reads preserve authorization while separating download references from execution activity. The Gateway and receiving Runtime must be upgraded together; incompatible survivors remain unavailable to new forwarding until an administrator confirms a safe restart. No database migration or new configuration is required. This decision partially supersedes resource activity handling in [atomic activity admission](2026-11-01-atomic-runtime-activity-admission.md); ordinary HTTP/WebSocket admission remains there.

The focused PostgreSQL suite covers current authority, generation/lease refusal and live stream cancellation after withdrawal or LISTEN disconnection. Real Loader HTTP tests pin resource signature checks and reversible guard registration. The built Web-profile transcript verifies personal/project GET/HEAD against the advertised bundle, unchanged database activity, manual-stop refusal and compatible Gateway recovery. These local checks do not prove cross-platform deployment, public-network performance or interruption-free Gateway replacement.

The [diagnostic](../../../../gateway/tests/runtime-assets.perf.ts) compares the same compiled Gateway with and without resource admission, using three fresh Node processes per variant and scope, ten warmups, fifty timed 256 KiB responses and a separate fifty-request SQL-count batch. On macOS arm64, Node25.8.1 and local PostgreSQL18.4, direct-browser statements per request fall from10 to3 for personal scope and11 to3 for project scope. Personal median/P95 completion changes from3.08/3.76ms to5.53/7.04ms; project changes from5.19/8.12ms to6.15/7.81ms. Median peak/steady RSS changes from189.59/189.56MiB to192.92/192.94MiB for personal and189.59/189.41MiB to190.67/190.69MiB for project. The diagnostic controls Runtime bytes and the live process handle; it excludes supervisor IPC, browser paint, model latency, WAN delay, database-server memory and concurrent load. Fewer exchanges do not establish a two-second public-network result, and local latency is not claimed to improve.
