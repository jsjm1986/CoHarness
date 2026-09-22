# Agent Note: Auto review execution authority and billing attribution

Status: implemented

English | [中文](2026-09-22-auto-review-execution-attribution.zh.md)

## Problem

A shared runtime can outlive the browser request that supplied an instruction. Its current connection, a display participant in a message, and a restored permission preset cannot establish who authorized an execution. A reviewer can also finish after eligibility was revoked or new input changed the participants. Usage reported after that change still belongs to the request that incurred it.

## Decision

[Auto review](../../../../packages/experimental/auto-review/README.md) consumes the lightweight execution-authority service. A managed call must pass fresh Auto authorization before paying the reviewer and again after its allow decision and downstream guards, before the tool body. The authority checks the full verified participant set. Unverified history, missing primary attribution, an unavailable provider, or a changed revision, input set, or primary actor refuses the pending action. The integration never spends another model call to repair a stale review. Independent local profiles retain the upstream review policy without requiring a Gateway.

The current Session still requires explicit Auto selection; [administrator eligibility](2026-09-22-admin-auto-review-eligibility.md) is only a grant. The `/permission` command awaits deployment authorization before its synchronous preset write and refuses late grants after cancellation or policy removal. Future-session defaults use the existing settings namespace and exclude Auto. A Full default requires live administrator authorization through a write-only `authorizeWrite` hook. Schema and synchronous value validation still own registration and provider reload; request-dependent authority is checked only before in-process persistence. Teardown or an external revision change during that wait rejects the write.

Managed Auto unload returns live Sessions to Workspace write, including after provider loss. Independent local unload retains Full access as defined by the [upstream Auto lifecycle decision](../feature/2026-08-28-auto-review.md). A managed deployment cannot acquire unreviewed Full access merely by removing the reviewer.

Each reviewer request carries its Session and `purpose: auto-review`, plus immutable execution witnesses and one primary actor for managed billing. These fields stay outside the Provider request body and model text. The governance plugin uses an actual initiating Agent or supplied verified witnesses; it never substitutes a current browser or display participant for managed authority. Agentless auxiliary calls remain explicitly unattributed. Several participating users still produce one bill.

The PostgreSQL intake verifies the historical witnesses against the Session, runtime, organization, and primary actor before storing usage. Child Sessions may use ancestor inputs only through their server-recorded witness membership. Revoked or soft-deleted users retain attribution for proven past requests without regaining permission to execute. A project owns its bill and has one activity actor; a personal record uses only its billing owner, with no duplicate activity actor. Invalid proof remains in the outbox and cannot be retried after stripping identity. Proof-free legacy records retain their current-writer check and existing unattributed retry. SQLite refuses proofs it cannot verify.

## Alternatives considered

**Authorize only when the picker is used.** Restored Sessions, delegated work, provider reloads, and revocation during review can all outlive that check. Selection and execution require separate admission.

**Use the latest participant or bill every participant.** Display metadata is not authenticated authority, and participant intersection is an authorization rule rather than multiple model calls. One captured primary attributes one charge.

**Check current eligibility when delayed usage arrives.** That would erase or indefinitely queue legitimate costs after revocation. Historical receipt validation proves attribution without authorizing a new action.

**Make settings validation asynchronous.** The same validation runs during registration and storage reload, when no live request exists. A write-only hook preserves those operations and places fresh authority immediately before persistence.

## Consequences

The execution-authority package carries only verified input references and service methods; LLM packages retain generic generation metadata and no Gateway dependency. Service absence remains an explicit managed failure. Runtime authorization and metering consume the same input identities but answer different questions: whether a call may run and who incurred an already observed cost.

## Testing

A real Loader assembles the Auto integration, permission service, LLM runtime, and ToolRuntime around a controlled authority provider; the tool writes only an owned temporary file. The tests exercise denial before reviewer dispatch, revocation and identity changes during a pending review, cold restoration, cancellation, and managed unload. Real CommandRuntime and settings writes cover asynchronous grant/refusal, cancellation, stale policy removal, teardown, and external revision changes. Governance tests observe actual outbox records and HTTP retries. PostgreSQL tests register and enter real execution inputs, submit usage through the bearer-authenticated intake, and verify delayed project/personal billing, bad proofs, ancestor witnesses, and deduplication. Both DeepSeek serializers exclude billing metadata from Provider bodies.
