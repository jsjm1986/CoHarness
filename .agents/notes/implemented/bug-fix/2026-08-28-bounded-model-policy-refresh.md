# Agent Note: Bound bulk model-policy refreshes

Status: implemented

English | [中文](2026-08-28-bounded-model-policy-refresh.zh.md)

## Problem

Changing an organization model provider, model, credential, or quota refreshed every user and project policy file serially. Each user refresh also looked the user up again, so a large organization held the administrator request or Gateway startup open for one round trip per subject and could retain a long chain of pending filesystem and credential work.

## Decision

The Gateway enumerates users and projects once per full pass, then projects the returned rows with up to four workers per subject class. The refresh path reuses the enumerated rows and the writer resolves current policy at admission. The HTTP listener can bind once authoritative startup checks pass because exact Runtime preparation and forwarding enforce current policy independently of the file scan.

The Gateway starts one owned reconciliation after binding and after maintenance reopens writes. It retries failed Runtime projections using fresh storage and policy reads, with catalog and owner lookup failures tracked at their own scope. The existing write admission checks maintenance again before each projection. Shutdown cancels pending retry delays and drains active work before releasing its services. [Coalesced triggers](2026-10-23-model-policy-refresh-coalescing.md) request another full scan.

## Alternatives considered

**Keep one serial loop.** Rejected because latency grows linearly with every user and project and one slow filesystem operation delays unrelated subjects.

**Use an unbounded `Promise.all`.** Rejected because a large organization would issue one policy, credential, and filesystem operation per subject at once, overwhelming the database pool and host I/O.

**Make every admin mutation wait for a complete background refresh.** Rejected because file projection is an eventually consistent cache; the durable governance revision and runtime lazy check already provide the authoritative recovery path.

## Consequences

Bulk refresh issues up to four concurrent projection operations per class. A full pass still visits every active subject and can take time proportional to catalog size. A damaged policy path can leave one Runtime temporarily unavailable while other Runtimes and the Gateway continue serving. Exhausted retries log the owner or Runtime identity and error code. Individual user and project mutations retain their direct projection path.

The existing administrator performance endpoint reads the node-local reconciliation snapshot. Progress remains visible while a pass waits. The latest settled round exposes the total issue count and a bounded sample of retrying or failed targets. The response and terminal logs use catalog coordinates and an allowlisted error code. Diagnosis reads no Runtime files.

## Verification

Gateway model-governance integration coverage verifies catalog row reuse, HTTP readiness with an outstanding scan, current policy enforcement for a requested Runtime, and isolated recovery after a policy file failure. The fixtures also verify maintenance admission, shutdown drainage, authenticated progress and capped diagnostics that strip private error data.
