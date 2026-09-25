# Agent Note: SSH execution providers

Status: implemented

English | [中文](2026-09-23-ssh-execution-providers.zh.md)

## Problem

Remote workspaces need filesystem identities, process paths, terminals and sandbox policies to refer to the same execution target. A remote pathname must never authorize access to a similarly named Host file. The [portable consumer decision](2026-07-28-portable-execution-world-consumers.md) defines these interfaces.

## Decision

The four [SSH providers](../../../../packages/ssh/README.md) use the upstream alpha.2 implementation. One deployment-owned OpenSSH connection carries administrative RPC and separately authenticated program streams. The preinstalled helper and optional PTC bootstrap must match their configured digests; strict host verification and disabled agent forwarding remain mandatory.

Providers preserve guarded filesystem writes, asynchronous launch, cancellation and managed process cleanup. A disconnected operation has an unknown outcome until independently observed; the connection never reconnects or replays it automatically. Model credentials and Session persistence remain on the Harness host. The remote helper disables debugger activation through SIGUSR1.

The transport service does not grant product access. The Gateway enforcement face ships in `gateway/src/postgres/ssh-target-service.ts` over migration 038: `resolveForRuntime` authorizes the subject and reads the target configuration inside one PostgreSQL transaction, so qualification and configuration cannot diverge; `share` locks the user and membership rows together, so a concurrent role downgrade cannot preserve stale sharing. The runtime-side `GatewaySshAuthorization` in `packages/context/gateway-execution/src/ssh.ts` resolves only through the signed `/internal/runtime/ssh/resolve` route, captures an invalidation revision before each request and rejects a response that arrives after revocation; each resolved target carries an AbortSignal that the owning grant aborts on invalidation. Personal passwords and keys require a credential service and must not become model arguments, command arguments, ordinary environment variables or Session data.

The filesystem adapter carries CoHarness source-version guards and directory enumeration bounds through validated helper requests. Cached preview inputs cannot substitute a changed source, and a small listing does not require enumerating every remote entry. These helper changes require the matching configured artifact digest.

## Alternatives considered

SFTP alone cannot preserve the existing atomic-edit, sandbox and process semantics. Sending program output through administrative framing would require another flow-control protocol; independent SSH channels retain transport-owned backpressure. Moving the entire Harness would also move credentials and Session storage, which is a different deployment model.

## Consequences

Both endpoints require Linux or macOS and a preinstalled helper. Source alignment and protocol tests establish provider behavior; they do not establish live SSH, Gateway authorization or remote Web acceptance. Each consumer must use provider paths, and each UI resource must retain its account, runtime, Session and execution target. The existing workspace resource service remains the Web read owner. Project roots on a filesystem without Host-path projection are resolved and checked by that provider. POSIX file resolution preserves physical parent traversal through symlinks; bounded directory enumeration and version-checked reads remain local extensions.

## Verification

Protocol tests cover malformed input, capacity, cancellation, stream authentication and cleanup. Live acceptance additionally needs actual SSH, the installed helper, sandbox enforcement, file mutations, terminal and PTC traffic, plus disconnect cleanup. Product acceptance must cover credential and qualification revocation and remote previews, diffs and delivery cards; these obligations remain open until exercised through their real entry points.

The portable consumer note remains active. No existing active note is fully superseded by this provider adoption.
