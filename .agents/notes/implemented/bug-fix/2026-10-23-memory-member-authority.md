# Agent Note: Memory write authority lifetime

Status: implemented

English | [中文](2026-10-23-memory-member-authority.zh.md)

## Problem

Memory writes queue behind other mutations and await a durable consolidation marker before altering an entry. A participant snapshot, an earlier provider check, or cancellation checked only by the caller can admit a mutation after its authority expires, its provider is replaced, or its operation is cancelled.

## Decision

`MemoryWriter` retains the complete request-captured collaboration authority. Member writes check its expiry and lifetime after queueing and again after the durable consolidation marker, immediately before the entry mutation. Expired principals receive the shared permission refusal; an unloaded provider receives the shared unavailable refusal. Scope discovery reports these authorities as non-writable. Agent writes check their supplied cancellation signal at admission and before the entry mutation. Project writes retain the admitting execution provider and obtain a final permission check after the marker; the returned execution state must equal the original state. Every write rechecks current scope availability after the marker and after the final permission check.

## Alternatives considered

**Capture a new authority when the queue advances.** The initiating request's identity is no longer guaranteed to be current, and a new request cannot confer authority on earlier work.

**Keep only the captured project mode.** A valid scope snapshot has a bounded lifetime; retaining its mode indefinitely loses that limit.

## Consequences

Queueing does not extend a principal's lifetime. Custom member writers retain their complete request authority, while standalone compositions without collaboration keep owner semantics. A refused write can leave a conservative consolidation marker but cannot alter the entry.

Introducing collaboration while an independent member write waits withdraws its absent-authority admission. Provider replacement never borrows the replacement's authority. A final check cannot borrow participants from a later request. Permission checks do not reserve or bill model requests.

## Verification

Deterministic barriers exercise saves and deletes behind another writer and during cursor persistence. Expiry at the exact deadline and provider invalidation both retain the original entry. Active authority still permits deletion.

Agent regressions cancel writes, replace or remove authorization providers, disable the scope, and change participants during marker persistence or the final permission check. Real Gateway update-stream cases revoke user or project qualification, disconnect the stream, and retain unrelated users' access while the writer remains idle. Loader snapshots exercise both operations through actual Agent curation and JSON storage, preserving entries on refusal and reporting the actual tool result to the model. The cancellation snapshot stops curation between marker and entry persistence, retaining no unpublished entry.
