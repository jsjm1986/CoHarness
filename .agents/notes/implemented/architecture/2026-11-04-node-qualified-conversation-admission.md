# Agent Note: Node-qualified conversation admission

Status: implemented

English | [中文](2026-11-04-node-qualified-conversation-admission.zh.md)

## Problem

Opening a remote conversation or creating one in its default workspace required several browser round trips. A workspace catalog of 20 computers and 1,600 conversations serialized 1,514,969 bytes. A second source of delay was the distance from an executing computer to the organization database.

On Windows, the signer accounts for the interprocess clock difference when selecting the signed start time. Expiry stays anchored to the actual signing instant. The Host keeps its existing signature, issuer, audience, generation, and validity checks.

## Decision

The browser pins the computer, Runtime, account and space to each intent. The target Gateway starts the selected Runtime under its existing admission rules. A versioned Host path combines default workspace registration with Session creation and returns only the selected Session's membership. Ordinary history and active-pane history keep their respective archive visibility.

A visible composer can yield before encoding image bytes. Text and uploaded document references enter admission independently of animation frames, including when the tab is hidden.

A durably accepted prompt has a fingerprint in the event that inserted it into the Session inbox. After flushing, the Host reads that exact sequence from the Session’s committed prefix. A subsequent model event can advance the log while this receipt is being checked. Concurrent retries share admission serialization and reuse the original Session and request identifiers. A tab records an opaque operation ID and salted input proof before submitting. A status lookup uses the authenticated submitter and never dispatches input. Reload can confirm the original input even after the originating Session object has been disposed. A missing write owner cannot produce a positive receipt.

The governance directory exposes authorized allocations. Opening a group requests rows for one Runtime at a time. Project content placement and promoted personal directories are durable routing decisions. An unavailable owner returns an error while the predecessor remains excluded from the directory. A maintenance restore compares destination ownership, retirement and writer epochs before committing. Only a committed navigation writes the tab’s selected Session. Losing its list row during reconnect leaves the original target available to retry. Focus invalidates private directory pages. The visible personal sections can read both first pages in one authorized, byte-bounded node response with independent cursors.

One governance database call records Runtime activity. It acquires the deployment lock before checking the current account, grants, node lease, generation and space. Personal directory and draft reads reuse one SQLite worker per Gateway, opened lazily on account-private local storage. Browsing allocations does not start a user Runtime.

A duplicated tab inherits its recovery pointer. If that pointer names mutable text, an edit in the original tab changes what the duplicate recovers. The node retains a count- and byte-bounded history, and a duplicate saves its pinned revision under its own ID. An expired pointer stays unavailable.

A blank conversation can already belong to a different Runtime from the entry computer. Its preset picker and title share a pending roster read for the same retained Session, Host generation, account and provider. Cordis returns a fresh tracing proxy on each lookup. The controls compare the original provider identity and invoke the traced method in the selected Session.

## Alternatives considered

Caching full directories on the organizational Gateway exposes private metadata to another disk. Joining browser reads in a single all-computers promise lets one unreachable computer delay every pane. Both constraints are addressed by reading bounded pages from the selected owner.

## Consequences

Older Hosts reject the versioned endpoint before mutating a Session. Replaying a confirmed request with changed input is refused. Promoting a personal index first requires its durable local snapshot to contain all active predecessor roots. Once promoted, an old publisher cannot resume central writes.

## Verification

The Host tests exercise distinct creates, replay, active-pane history, and a persisted JSONL input under concurrent resubmission. The PostgreSQL workbench transcript covers pre-existing conversation rows, bounded pagination, personal directory publication and grant revocation. Source restoration, quotas and leases have their own authority checks.
