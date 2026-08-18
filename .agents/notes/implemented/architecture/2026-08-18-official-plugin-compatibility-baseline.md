# Agent Note: Official rc.7 plugin compatibility baseline

Status: implemented

English | [中文](2026-08-18-official-plugin-compatibility-baseline.zh.md)

## Problem

The rc.7 upstream plugin vocabulary uses `cordis/*` event names, while this fork's rescoped Cordis runtime uses `@deepseek-ai/cordis/*`. Exact Remote subscriptions therefore let one vocabulary reach a Client while silently excluding the other. The Loader already accepts the rc.7 plugin entry forms, but that support needs a real composition guard and an explicit compatibility limit before upstream changes again.

## Decision

The compatibility baseline covers the observed rc.7 plugin and event formats without changing the fork's current runtime vocabulary. It is a narrow exception to the repository-owned single-vocabulary rule in the [naming contract](2026-08-11-repository-naming-contract-and-rename-ledger.md) and extends the [Remote event delivery](2026-08-10-remote-event-delivery.md) mechanism only at its external Cordis event boundary.

- The Host and Remote allowlist declare both prefixes for the six dynamic Cordis events. The Host continues to emit only the existing `@deepseek-ai/cordis/*` names, so one Host notification produces one frame.
- The Client Remote dispatcher treats the six enumerated `cordis/name` and `@deepseek-ai/cordis/name` pairs as one family, merges matching subscriptions in global registration order, calls a listener once when it is registered under both aliases, and preserves repeated registrations under one exact name. Other Cordis names remain exact matches. Listener failures remain isolated.
- A real `boot()` composition covers named ESM function plugins, default-exported class plugins, CommonJS object plugins, injected services, and Standard Schema config normalization. A mixed default export plus named function-plugin metadata is outside the supported target because Loader export unwrapping intentionally makes that boundary explicit.
- This is an rc.7 compatibility baseline, not an automatic promise for future upstream breaking changes. A later upstream format requires a new compatibility decision and coverage.

## Verification

The API Proxy test emits an official Cordis name and observes that exact name and payload on the Host stream. The Gateway Client tests cover both dispatch directions, merged ordering, alias deduplication, exact-name duplicate registration, refusal to fold an unlisted future Cordis family, listener containment, and unknown-event dropping. The app-boot composition test boots all three supported entry forms through a temporary `cordis.yml` and observes normalized injected state.

## Alternatives considered

**Emit both event names from the Host.** Rejected because it would create duplicate wire frames and duplicate side effects for consumers that subscribe to both names; the alias belongs at the Client subscription boundary.

**Make Loader infer mixed default and named exports.** Rejected because the official convention is unambiguous: namespace function plugins use named exports, while Service/class plugins use a default export. Inferring mixed forms would hide malformed package boundaries.

**Track upstream changes automatically.** Rejected because future breaking changes may alter payloads, lifecycle semantics, or export contracts. Compatibility remains an explicit, tested baseline.

## Consequences

Official rc.7 plugins can use canonical Cordis event names through the existing Remote path, while current fork plugins continue to use the rescoped names without migration. The allowlist intentionally contains two names for each supported Cordis event, and payloads are unchanged. Maintainers must extend the baseline only with a documented upstream contract, focused tests, and a new review of the naming exception.
