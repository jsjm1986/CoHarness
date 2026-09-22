# Agent Note: Verified participants for managed execution

Status: implemented

English | [中文](2026-09-22-verified-execution-participants.zh.md)

## Problem

A shared Agent can execute after its originating HTTP request ends, after another user edits its queue, or after work is delegated and restored. A browser role, display participant, or inherited asynchronous request context cannot prove all the humans whose input caused that execution. Letting the latest administrator replace earlier contributors would let an unprivileged input acquire privilege through an editor, child, or fork.

## Decision

[Execution Authority](../../../../packages/context/execution-authority/README.md) defines input attestation, participant capture, delegation, and current permission checks. [Gateway Execution](../../../../packages/context/gateway-execution/README.md) implements them from Gateway PostgreSQL records. This keeps input and orchestration consumers independent of request transport while preserving the actual [Agent initiator](2026-07-15-agent-initiator-scope.md).

The Gateway attests exact human inputs from live authenticated callers. Their opaque references bind organization, runtime, Session, message, and content; they never grant a role. Queue replacements retain earlier editors. An accepted question answer adds its verified responder; ordinary tool approval expresses consent without adding an execution participant. Display metadata remains useful to the transcript and model but is not an authorization source.

Participant restrictions accumulate for the Session. Before asynchronous child creation or delivery, the sender captures its current verified references. The child records inheritance in its own required-on-read Session event; adjacent relays retain sender restrictions and stable delivery identity. A fork captures the complete source authority independently of the selected history prefix. Cold restoration checks durable references against the Gateway rather than reviving a prior request. Captured references cannot borrow unrelated Sessions or discard unknown history.

Execution checks every retained participant's current access. Privileged operations additionally require every participant's relevant qualification; unknown historical identity prevents Full and Auto execution. Selecting a privileged preset checks the selector as well as existing participants, without inventing a new input. [Auto review and billing](../bug-fix/2026-09-22-auto-review-execution-attribution.md) and [profile management](2026-09-22-gateway-profile-management-authority.md) own their specific admission and attribution rules.

Gateway Runtime marks the application as requiring execution authority. The requirement survives provider removal, and absence refuses managed execution. Its `interactive()` identity exists only during active HTTP handling; inherited request context is not background authority. A disconnected authorization stream invalidates pending grants and cancels active work. Reconnection enables fresh checks without replaying effects. Independent local profiles retain their own operator authority and do not compose the Gateway provider.

## Alternatives considered

**Authorize the latest visible participant.** A later edit or child response would erase earlier restrictions. Accumulation preserves all relevant human contributors.

**Capture an HTTP principal for the whole task.** Requests expire and permissions change while work is queued, delegated, or restored. Durable origin facts and current permission checks answer separate questions.

**Trust inherited references as credentials.** Serialized references can be copied. The Gateway verifies their runtime, Session lineage, immutable input facts, and current access before allowing work.

**Put Gateway transport in every consumer.** It duplicates identity rules and couples local orchestration to deployment details. The lightweight definition carries restrictions while the provider owns their verification.

## Consequences

Privileged shared work is limited by its least-privileged retained contributor. Removing a participant from the visible transcript or selecting a different prefix cannot raise authority. Ordinary modes remain available for unknown history subject to verified current write access. Managed execution depends on a reachable Gateway and a ready authorization stream; transport recovery does not silently resume cancelled work.

The [dynamic model-tool retirement](../simplification/2026-09-22-retire-dynamic-cordis-model-tools.md) removes a Host-code path that could bypass service authorization. The remaining trusted Host plugins still require deployment isolation; participant checks are not an operating-system sandbox.

## Testing

Provider tests reject obsolete revisions, disconnected-stream responses, unsigned input, malformed inheritance, and lost live Agent ownership. Gateway PostgreSQL tests cover immutable input facts, accumulated editors, current eligibility, adjacent transfers, replay deduplication, and permission changes. These checks establish the identity mechanism; they do not constitute complete assembled acceptance of every restored child, Team delivery, and deployed Web entry. Each real transport and executor still needs its own positive path and refusal evidence.
