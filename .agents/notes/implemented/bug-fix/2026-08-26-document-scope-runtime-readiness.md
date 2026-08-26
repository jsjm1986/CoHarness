# Agent Note: Document scope runtime readiness and safe provider projections

Status: implemented

English | [中文](2026-08-26-document-scope-runtime-readiness.zh.md)

## Problem

Document manager metadata requests can arrive while a personal or project runtime is cold, restarting, or failing readiness. The Gateway's generic proxy response used an unstructured `instance-starting` error, and the browser converted that response into `Document operation failed.` A runtime provider profile can also retain a non-canonical embedded base URL, causing the runtime policy loader to reject an otherwise valid project before document routes become available.

## Decision

Gateway proxy readiness responses use structured `INSTANCE_STARTING` and `INSTANCE_UNREACHABLE` error codes while retaining `Retry-After` for API callers. The public scope-list broker maps unexpected failures to a structured retryable `DOCUMENT_TRANSFER_UNAVAILABLE` response. The document client retries only idempotent metadata reads (current-scope lists, alternate-scope lists, directory lists, overview, and history) twice, honors the bounded server delay, and never replays upload or copy writes. The Documents manager maps readiness codes to localized scope messages instead of the generic operation error.

PostgreSQL model-policy projections canonicalize an embedded provider profile `baseURL` to the Provider's stored URL before writing runtime policy JSON. This keeps legacy trailing-slash settings compatible with the runtime validator without changing the stored credential or route selection.

## Alternatives considered

**Retry every document request.** Rejected because upload sessions and copy operations are writes; replaying a request after an ambiguous response could duplicate durable work.

**Make the browser wait on every runtime proxy request.** Rejected because a cold runtime can take the full readiness window and would block unrelated page navigation; metadata reads can use a bounded retry while the existing waiting response remains available to other surfaces.

**Relax runtime provider URL validation.** Rejected because the Provider URL and embedded profile URL must describe the same route; normalizing the projection preserves that invariant while accepting legacy formatting.

## Consequences

Cold runtime document views recover without a manual refresh when readiness completes within the retry window. A persistent startup failure now reports a scope-specific localized message and leaves write operations unreplayed. Runtime policy files remain compatible with strict URL equality, and existing database routes and credentials are unchanged.

## Verification

Client tests cover structured readiness errors, `Retry-After` retries, retry exhaustion, and localized Documents manager messaging. Gateway proxy tests cover the structured API readiness response. PostgreSQL integration coverage writes a legacy trailing-slash profile and verifies the projected runtime policy uses the canonical Provider URL.

## Related

- [Gateway-owned document scope listing](2026-08-25-gateway-document-scope-loopback-leak.md) — owns the public Gateway route and runtime-authority isolation.
- [Gateway model governance live policy reload](../feature/2026-08-14-gateway-model-governance-live-policy-reload.md) — owns organization policy projection and live runtime reload semantics.
