# Agent Note: Project-scope Remote authorization coverage and catalog-absent services

Status: implemented

English | [中文](2026-10-03-project-remote-authorization-coverage.zh.md)

## Problem

Project collaboration ACLs classify every Typert Remote endpoint before lookup: Session-bearing endpoints declare their argument path in `REMOTE_SESSION_POLICIES`, and identity-free endpoints must land in one of the project-scope sets — process-wide reads, registry-authorized, manager configuration, personal configuration, user terminals, or administrative terminals. Nothing enumerated the full Remote surface, so a service could expose a method that silently fell through to the fail-closed refusal, and a stale policy entry could survive a rename unnoticed. Two concrete gaps had already shipped: `userQuestions/answer` and `userQuestions/attachWait` carry `agentId` but had no policy row, and `workspace.pinSession`/`unpinSession` were never routed through `clientSessionKey` on the Client, so pinned Session identities stayed raw Host ids in the Workspace projection.

## Decision

The endpoint surface is enumerated twice a run and the two listings are reconciled in `packages/host/apiproxy/tests/remote-policy-coverage.spec.ts`. Every `super(ctx, '<key>'[, { namespace }])` binding under `packages/` and `apps/` (tests and `lib` excluded) supplies the service key and its wire namespace — the `namespace` option overrides the key, which is why `terminalController` answers as `terminal` and `speechController` as `speech`. For catalog-listed services the generated `SERVICE_API` signatures supply the `@Remote` wire names; for services the catalog projection does not list (`dynamicCordisRunner`, `sessionFeedback`, `pluginInventory`) the spec recovers `@Remote` names from the binding's own source file. The spec asserts both directions: every discovered endpoint is classified, and every classification entry names a discovered endpoint.

The classification the audit pinned down is now explicit. `userQuestions/answer` and `userQuestions/attachWait` route on `['agentId']`. `speech/catalog` and `speech/follow` join the process-wide reads alongside `permissionPresets/catalog`, `pluginRegistryProbe/fastest`, `speech/catalog`, and `speech/follow`. The new `PROJECT_TYPERT_PROCESS_WIDE_OPERATIONS` set admits the three Session-free voice operations (`speech/prepare`, `speech/cancelPreparation`, `speech/transcribe`) that every participant needs; `speech/configure` lands in `PROJECT_TYPERT_MANAGER_CONFIGURATION` because provider selection is shared mutable state. `terminal/adminList` and `terminal/adminClose` moved from an inline literal into the exported `ADMIN_TERMINAL_ENDPOINTS` set so the coverage spec sees them.

## Alternatives considered

**Trust the generated catalog alone for the endpoint surface.** Rejected: the catalog projection legitimately excludes three bound services, which would read as fourteen stale policy entries and hide real methods; recovering their wire names from each binding file keeps both directions fail-closed.

**Namespace every endpoint from the service key.** Rejected: two services bind a wire namespace that differs from their service key (`terminalController` → `terminal`, `speechController` → `speech`); key-derived names would demand policies for endpoints that do not exist while the real ones stay unclassified.

**Keep `speech/*` unclassified like upstream.** Rejected for this fork's deployment: project-scope voice capture would fail closed for every participant; the split into reads, participant operations, and manager configuration matches the terminal precedent without widening what a non-manager can mutate.

## Consequences

Any new `@Remote` method or namespace change fails the spec until its project-scope classification is decided — an intentional authoring cost that prevents silent fail-closed drift in both directions. Client code pinning Sessions now receives `ClientSessionKey` identities from `workspace.pinnedSessionIds`, consistent with every other Session projection; consumers holding raw Host ids from that field must migrate to the keyed form.

## Testing

The coverage spec itself is the gate: it passes only when both directions reconcile for the whole bound surface. `client-session-routing.spec.ts` pins the `userQuestions` and Schedule routing rows, and `session-api.client.spec.ts` covers the Client-side pin/unpin routing.
