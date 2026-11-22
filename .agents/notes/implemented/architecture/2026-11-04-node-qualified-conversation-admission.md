# Agent Note: Node-qualified conversation admission

Status: implemented

English | [中文](2026-11-04-node-qualified-conversation-admission.zh.md)

## Problem

Opening a remote conversation or creating one in its default workspace required several browser round trips. A workspace catalog of 20 computers and 1,600 conversations serialized 1,514,969 bytes. A second source of delay was the distance from an executing computer to the organization database.

On Windows, the signer accounts for the interprocess clock difference when selecting the signed start time. Expiry stays anchored to the actual signing instant. The Host keeps its existing signature, issuer, audience, generation, and validity checks.

## Decision

Cold preparation returns after start admission. Continuation retains the original account, computer, Runtime, Session, draft and operation IDs. A process-local receipt identifies that accepted start and its eventual ready generation; it grants no authorization and cannot admit a new generation. The per-Runtime receipt survives readiness only, and a late observation cannot erase a newer receipt. Creation and history preparation continue only after an explicit pending response. Lost responses, generic failures, withdrawal and generation changes during preparation require an explicit user retry. Hot operations keep one request, and cancelling a wait does not cancel accepted startup or running work.

The browser pins the computer, Runtime, account and space to each intent. The authenticated Host description supplies the owning computer from the launch credential on direct entry. The target Gateway starts the selected Runtime under its existing admission rules. A versioned Host path combines default workspace registration with Session creation and returns only the selected Session's membership. Ordinary history and active-pane history keep their respective archive visibility.

A visible composer can yield before encoding image bytes. Text and uploaded document references enter admission independently of animation frames, including when the tab is hidden.

A durably accepted prompt has a fingerprint in the event that inserted it into the Session inbox. After flushing, the Host reads that exact sequence from the Session’s committed prefix. A subsequent model event can advance the log while this receipt is being checked. Concurrent retries share admission serialization and reuse the original Session and request identifiers. A tab records an opaque operation ID and salted input proof before submitting. A status lookup uses the authenticated submitter and never dispatches input. Reload can confirm the original input even after the originating Session object has been disposed. A missing write owner cannot produce a positive receipt. Personal JSONL reads the exact event through one validated current generation. This avoids resolving the same artifact for a separate read handle while preserving the durable check.

The governance directory exposes authorized allocations. Opening a group requests rows for one Runtime at a time. Project content placement and promoted personal directories are durable routing decisions. An unavailable owner returns an error while the predecessor remains excluded from the directory. A maintenance restore compares destination ownership, retirement and writer epochs before committing. Only a committed navigation writes the tab’s selected Session. Losing its list row during reconnect leaves the original target available to retry. Focus invalidates private directory pages. The visible personal sections can read both first pages in one authorized, byte-bounded node response with independent cursors.

One governance database call records Runtime activity. It acquires the deployment lock before checking the current account, grants, node lease, generation and space. Personal directory and draft reads reuse one SQLite worker per Gateway, opened lazily on account-private local storage. Browsing allocations does not start a user Runtime.

A duplicated tab inherits its recovery pointer. If that pointer names mutable text, an edit in the original tab changes what the duplicate recovers. The node retains a count- and byte-bounded history, and a duplicate saves its pinned revision under its own ID. An expired pointer stays unavailable.

Changing deployment mode transfers an open draft between the node writer and the tab’s single-computer recovery record only when the entry computer, verified account, Runtime and Session still match. The current tab value, including a deliberate clear, takes precedence over an older node revision. A draft addressed to a different computer remains with its original owner.

A blank conversation can already belong to a different Runtime from the entry computer. Its preset picker and title share a pending roster read for the same retained Session, Host generation, account and provider. Cordis returns a fresh tracing proxy on each lookup. The controls compare the original provider identity and invoke the traced method in the selected Session.

Failed preparation belongs to the document-owned intent, so its error remains beside the editable draft after the initiating action returns. The intent carries a safe category and its existing operation ID; server messages can contain private paths and are excluded. Invalid or missing presets require configuration repair and an explicit retry, not the cold-start continuation mechanism.

Queued prompt recovery is owned by the tab that submitted the exact input. It waits across temporary transport and verification failures, reads the original receipt, and uses the same request ID if the current owner reports it unknown. Applying the same policy to delayed steering could interrupt a different active turn. That action keeps explicit retry. The Gateway requires a fresh signed on-demand idle decision and the absence of outstanding work before retiring an expired generation automatically. Resident and unconfirmed processes retain their occupation. Receipt reads reuse the configured connection backoff. A freshly verified Host description for the same computer and Runtime can advance the next read without granting admission.

An unsent project draft can outlive its Host as a reservation in the owning content store. The next generation qualifies the original creator against that reservation after ordinary conversation lookup misses. Receipt lookup reads metadata only. Replay reconstructs the same Session and uses the existing admission and persistence path. An expired or released reservation cannot authorize reconstruction, and a materialized conversation uses its existing ACL and event log. This preserves deferred creation and keeps warm sends on their ordinary path.

The reservation keeps the last acknowledged model choice alongside the draft's configuration. The replacement Runtime applies that choice to a newly created Agent and checks current model policy before admitting the original input. Model denial keeps the draft available for reselection. The model identifier and reasoning effort follow the owning content store and stay outside governance rebuilding exports. A verified project backup from before node content migration 018 restores the draft with a null model selection.

## Alternatives considered

Caching full directories on the organizational Gateway exposes private metadata to another disk. Joining browser reads in a single all-computers promise lets one unreachable computer delay every pane. Both constraints are addressed by reading bounded pages from the selected owner.

## Consequences

Older Hosts reject the versioned endpoint before mutating a Session. Replaying a confirmed request with changed input is refused. Promoting a personal index first requires its durable local snapshot to contain all active predecessor roots. Once promoted, an old publisher cannot resume central writes.

## Verification

The keyless `cold-session-preparation` transcript runs the compiled client against two ordinary Node Gateways, their outbound agent and the shipped Web profile. The fixture mints release launch stamps before listening, as the production Gateway does. A held launch exceeds one HTTP deadline, then returns the same Session, its default Workspace and history. A single-attempt carrier refuses the pending response. Stop and restart advance the real PostgreSQL generation. The old continuation remains unusable without another start. Focused tests also cover concurrent receipt publication, withdrawal, cancellation and changed pending responses.

The `queued-prompt-reconnect` transcript replaces the outbound agent lease, checks the new Runtime binding, and reads one durable input and a complete model reply. The Host tests exercise distinct creates, replay, active-pane history, and a persisted JSONL input under concurrent resubmission. The PostgreSQL workbench transcript covers pre-existing conversation rows, bounded pagination, personal directory publication and grant revocation. Source restoration, quotas and leases have their own authority checks.

[Existing-deployment sampling](../../../../scripts/existing-deployment-latency/README.md) separates browser input readiness, received durable acceptance, visible response and driver overhead. It requires an explicit QA target and execution flag, retains failed and unattempted counts, and stops later mutations after an uncertain result. Synthetic delay tests and periodic resource telemetry cannot establish deployed operation percentiles; the manual entrypoint's offline checks do not claim a real-platform performance result.
