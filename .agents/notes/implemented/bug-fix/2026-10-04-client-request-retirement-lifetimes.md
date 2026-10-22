# Agent Note: Separate client request retirement from transport completion

Status: implemented

English | [中文](2026-10-04-client-request-retirement-lifetimes.zh.md)

## Problem

Client state owners need to reject obsolete publication without losing responsibility for unfinished transports. A superseded read can settle after a mutation or permission revocation, and abort-ignoring transports can remain pending after their publication slot is retired. Disposal must also distinguish reads from writes already admitted to transport.

## Decision

Publication eligibility and completion ownership are distinct. `AccountPreferencesMirror` and `ProjectModelsBridge` install their current read before deferred transport admission. They retain aborted and superseded transports until actual settlement, and every asynchronous dispose call joins that retained work.

The account mirror accepts equal- or newer-revision write responses as immediately ready, retires the old request slot, and never regresses its held revision.

An obsolete project GET caller prefers the pending successor, then held full data; without either, it rejects without starting another GET. A current full GET may refresh permissions at an equal revision. Equal- or older-revision partial responses and mutation echoes cannot restore a revoked writable policy.

`ProjectModelsBridge` leaves writes admitted to project transport without a bridge-disposal abort signal so callers receive the real acknowledgement. Reads, credential-description requests, and discovery requests use lifetime aborts and call `requireLive` immediately before transport. Compatibility update/replace calls recheck liveness after the namespace read. Disposed owners suppress publication and follow-up refresh.

Collaboration context loads coalesce only non-forced calls. A forced post-mutation refresh supersedes and aborts the old context read, and neither obsolete success nor failure publishes. The context request slot is assigned before deferred transport runs or subscribers are notified. Conversation-detail forced refresh retains its coalesced trailing-read strategy.

The [web-search settings card](../../../../packages/client/ui-settings-plugins/src/client/web-search-card-controller.ts) owns credential-hint work only after its detailed page first becomes visible. Its summary derives settings without describing credentials, and repeated activation shares the current read. Unchanged settings projections do not invalidate credential metadata. A selected-reference change, credential event, completed write, or connection reset starts a fresh read and fences older successes and failures, even for the same reference. Reset clears the previous target's hint: sharing an older request would retain obsolete credential or write-permission information. Unknown and failed hints remain distinct from an unconfigured key; reopening retries a failed hint. Disposal aborts reads, suppresses publication and follow-up requests, and joins admitted saves without cancelling credential-write acknowledgements.

The independent [Host settings mirror](../architecture/2026-08-17-settings-describe-mirror.md) decision owns read derivation and the startup budget. [Account preference conflict retry](2026-10-03-account-preferences-conflict-retry.md) owns serialized retry-on-fence, and [project settings management](../feature/2026-08-28-project-scoped-settings-management.md) owns project management and credential authority.

## Alternatives considered

**One current slot for publication and completion.** Retiring it loses unfinished transport ownership, so disposal can finish while old work is still running.

**Treat abort as quiescence.** A carrier may ignore its abort signal; only actual settlement establishes completion.

**Cancel every request during disposal.** Cancelling a write already admitted to transport can discard its real acknowledgement even when the mutation commits.

**Treat mutation echoes as fresh permission authority.** Equal or lower revisions do not establish fresh authorization and cannot restore revoked writable policy.

**Read credential hints during plugin registration or reuse them through resets.** Summaries need no credential metadata, while a reset changes the target or authority. Delaying the first read removes unused work; retaining explicit invalidation protects permission freshness.

## Consequences

Teardown may wait for abort-ignoring carriers. Stale work cannot publish, admitted writes keep their acknowledgement, and direct compatibility calls cannot admit new transport after disposal.

## Verification

[Account specifications](../../../../packages/client/ui-settings/tests/account-scope.client.spec.ts), [project specifications](../../../../packages/client/ui-settings-models/tests/project-store.client.spec.ts), and [context specifications](../../../../packages/client/ui-collaboration/tests/collaboration-client.client.spec.ts) pin request ownership, revision and permission publication, disposal admission, and the separate context/detail refresh strategies.

[Web-search lifecycle specifications](../../../../packages/client/ui-settings-plugins/tests/web-search-lifecycle.client.spec.ts) cover deferred activation, three unchanged scope projections, invalidation during an older read, and teardown with unfinished reads or writes. The unopened-page zero-read assertion rejects the unmodified eager controller in an isolated negative control. The [assembled plugin-settings scenario](../../../../apps/web/tests/plugin-config.e2e.ts) records visible pending, unavailable, and recovered hints through the real browser composition and a held RPC response, without model requests.
