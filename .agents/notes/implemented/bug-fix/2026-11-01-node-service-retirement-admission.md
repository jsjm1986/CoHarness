# Agent Note: Node service retirement admission

Status: implemented

English | [中文](2026-11-01-node-service-retirement-admission.zh.md)

## Problem

The center can observe a completed HTTP request and close its transport before the node finishes cleaning up the corresponding bridge. With the service budget occupied, a new request reaches the node after cancellation of the old request but before its cleanup completes. Refusing the new request as busy makes a completed exchange produce an avoidable 503, even though the old bridge has no remaining authorized work.

## Decision

The node control client owns a service slot through the bridge's complete socket and pipeline cleanup. A cancelled current owner can reserve one successor in that slot. The successor opens no local connection before the current owner finishes, retains its exact request ID and release requirement, and can be cancelled while waiting. A slot with an active owner cannot reserve a successor. Full active capacity still returns busy.

Each configured slot holds at most one running or cleaning bridge and one reserved request. Reservation neither increases physical connection capacity nor creates an unbounded queue. Probe admission remains independent. Shutdown aborts current and reserved requests and joins their slot workers before reconnecting or returning. The existing center acquisition deadline and cancellation continue to bound abandoned requests; forwarded HTTP operations are never replayed.

## Alternatives considered

**Release a slot when cancellation is requested.** Cancellation does not prove that sockets and pipelines have stopped. Early reuse permits more physical bridges than the configured budget while cleanup remains outstanding.

**Refuse every successor until cleanup completes.** Immediate refusal turns a request completed at the center into a client-visible failure for subsequent work. A reservation preserves the limit while waiting for known cleanup.

**Queue all excess requests.** Queuing behind active long-lived connections hides genuine saturation and needs another independent memory and waiting policy. Only a cancelled owner can reserve one successor.

## Consequences

The configured service limit includes physical cleanup. A cancelled bridge can retain one extra request record, but its successor consumes no socket or local Gateway request until dispatch. Cancelling a reservation prevents dispatch; it cannot undo an already forwarded operation. Lease, credential, release and target-computer checks retain their existing owners.

The protocol, configuration, private credentials and database schema are unchanged. [Control-response recovery](2026-11-01-node-control-response-recovery.md) independently governs retry of enrollment and lease replies. [Shared channel authorization](2026-10-31-node-channel-shared-authorization.md) independently governs database locks. This decision does not establish the cause of every production capacity refusal or public-network delay.

## Verification

Real socket tests retain a node-side close notification after the center releases the old request. A successor remains undispatched while a separate authenticated probe completes, then succeeds after cleanup is released. Cancelling that successor prevents its local request. Other tests retain active-capacity refusal, revocation, binary transfer and consecutive completed-request reuse. Public-network reliability requires separate deployment acceptance.
