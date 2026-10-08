# Agent Note: Atomic loopback ports for process-backed Gateway fixtures

Status: implemented

English | [中文](2026-10-08-atomic-fixture-runtime-ports.zh.md)

## Problem

`gateway/tests/instances.spec.ts` and `gateway/tests/apply-grants.spec.ts` gave every fixture a fixed literal `HGW_INSTANCE_PORT_BASE` (43100–43420 and 43300). The allocator wrote the base into the new instance row and the spawned fake-dsh child bound it on `127.0.0.1`. Every literal sits inside the Linux ephemeral port range (default `32768–60999`), so any kernel-assigned loopback port in the same job — a sibling Vitest worker's `listen(0)` relay, an outbound connection's source port — can already hold the literal when the child binds. The child then crashes on `listen EADDRINUSE`, surfacing as a readiness failure far from the cause; pull-request CI hit exactly that signature on `127.0.0.1:43410`.

## Decision

Fixture children bind `listen(0)` and publish the kernel-assigned port to `$DSH_HOME/child-port`; the launcher already injects `DSH_HOME` per runtime identity, so every child owns a private publication file. Each durable instance port — the `instances` row for users, the repository stub for project runtimes — is an OS-assigned [runtimeRelay](../../../../gateway/tests/runtime-relay.ts) port that forwards each accepted connection to the child's currently published listener. `setup()` wraps `users.create` so every created identity claims its own relay and port file, and tests constructing stub repositories claim a relay for the project runtime home. Literal bases remain only as allocator inputs, and literal-port assertions became relational assertions on the row or returned port. Stub repositories whose managers never spawn keep literal ports because those values are data, not bound resources.

## Alternatives considered

- **Probe for a free literal, then have the child bind it.** The probe and the bind are separated by process spawn, so a kernel assignment between them reproduces the same collision class.
- **Disjoint literal ranges per test or file.** Literals stay inside the ephemeral range; the kernel can assign any of them to an unrelated socket, and ranges do not protect against other processes or runner traffic.
- **Serialize the Gateway suite.** File-level serialization cannot protect a host port from other spec files, independent Vitest processes, or jobs sharing the runner, and it taxes every run for one fixture's defect.
- **Retry or extend readiness waits.** The child has already crashed; waiting longer reports the crash later without fixing ownership.

## Testing

Binding `127.0.0.1:43410` before the run reproduces the CI signature under the previous fixture (`listen EADDRINUSE`, reported as `instance for alice failed to become ready on port 43410`); the same held port does not affect the new fixture. Two independent `vitest run tests/instances.spec.ts` processes execute concurrently and both pass, and `tests/apply-grants.spec.ts` passes. `npm run typecheck --prefix gateway` and `npm run build:check --prefix gateway` pass.

## Consequences

No fixture child binds a fixed port, so the kernel cannot hand a fixture's durable port to another socket or vice versa. The relay also resolves stale publications deterministically — a connection against a dead child's port file is destroyed — and cleanup order stays children, then relays, then the database and fixture root. The [instance port allocator](../bug-fix/2026-08-28-reclaimable-instance-port-allocation.md) keeps owning durable assignment semantics; this note only changes which ports the fixtures actually bind.
