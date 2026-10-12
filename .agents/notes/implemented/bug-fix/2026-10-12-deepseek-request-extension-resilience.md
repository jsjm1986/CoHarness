# Agent Note: DeepSeek request extensions tolerate per-field failure and bound their size

Status: implemented

English | [中文](2026-10-12-deepseek-request-extension-resilience.zh.md)

## Problem

Every registered DeepSeek request extension shared the fate of the weakest contributor. One provider's `prepare()` exception rejected the whole model request; a contributor's `accept()` failure after HTTP 2xx surfaced as a request failure even though the stream had already succeeded; and repeated failures logged a warning on every request. Separately, `dsh_session_log` serialized the complete pending Session-log suffix into one field with no byte budget, so a long or attach-heavy session could grow every routed request past the provider's limit, and a watermark mismatch across Session format generations could silently resume an upload at a foreign generation's cursor.

## Decision

Port upstream `0aed8de976d`, `7facb1cf65d`, and `193f9ce4130` onto the CoHarness forks of `deepseek-llm-api-extensions`, `llm-deepseek`, and `session-log-deepseek`:

- The registry prepares each provider independently. A throwing or unclonable result omits only that field from the request, logs once per field, and leaves cancellation as the sole rejection path.
- The adapter defers `accept()` until after HTTP 2xx and reports an acceptance failure through `onExtensionsUnaccepted` instead of throwing; host registration deduplicates the degraded-replay, omitted-route, and unaccepted-route warnings once each.
- `session-log-deepseek` gains a `maxBytes` field (default 8 MiB, positive integers only) bounding the complete serialized `dsh_session_log` contribution in UTF-8 bytes. Each request sends the longest pending event prefix that fits; accepted watermarks drain the backlog across requests, and a first event too large to fit omits the field and warns once per blocking event. The acceptance record and the wire envelope both carry `sessionFormatVersion`; records from another generation or with a malformed version are ignored or rejected at the fold.

CoHarness keeps its own gates in front of the ported behavior: `enabled` defaults to `false`, the endpoint allowlist and `COHARNESS_DISABLE_SESSION_LOG_UPLOAD` kill switch still suppress delivery, and audit logging is unchanged.

## Alternatives considered

**Fail the whole request on any extension error.** Rejected: an optional contributor must not be able to take down every routed model call, which is the upstream defect this change fixes.

**Truncate events mid-request instead of prefixing.** Rejected: the acceptance watermark advances only through a contiguous prefix, so an arbitrary cut would either skip sequences or complicate the replay contract.

**Keep `enabled` non-volatile.** Rejected: upstream made the flag volatile so settings writes reach the next request without a reload; matching that shape keeps the port faithful while preserving our default-off posture.

## Consequences

A broken or oversized extension degrades one field, not the request. Long sessions bound their upload to `maxBytes` per request and drain over consecutive accepted requests. Legacy acceptance records without `sessionFormatVersion` read as v0 and are skipped on current-generation sessions, causing one conservative full resend instead of a corrupt cursor.

## Verification

`packages/llm/deepseek-llm-api-extensions/tests/registry.spec.ts` and `packages/llm/llm-deepseek/tests/extensions.spec.ts` cover provider failure, cancellation, warn-once, acceptance failure without stream failure, and serialization fallback (17 tests). `packages/session/session-log-deepseek/tests/upload.spec.ts` covers the default and exact byte limits, UTF-8 measurement, backlog draining through acceptance watermarks, the oversized-first-event warn-once path, and malformed format-version rejection (34 tests). Both packages typecheck clean.

## Related

- [RC2 behavior alignment](../architecture/2026-08-22-rc2-behavior-alignment.md) — the standing rule that upstream release behavior is the compatibility reference while CoHarness product gates remain.
- Upstream commits: `0aed8de976d` (per-field failure isolation), `7facb1cf65d` (warning deduplication), `193f9ce4130` (`maxBytes` bounding).
