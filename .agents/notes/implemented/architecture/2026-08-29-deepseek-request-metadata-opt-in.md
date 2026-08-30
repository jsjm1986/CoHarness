# Agent Note: DeepSeek request metadata uses opt-in extension providers

Status: implemented

English | [中文](2026-08-29-deepseek-request-metadata-opt-in.zh.md)

## Problem

The upstream release adds provider metadata fields for the active plugin package set and an incremental Session-log suffix. Adding those fields directly to the DeepSeek adapter would mix field ownership with HTTP transport and could send workspace or session data without a positive deployment decision.

## Decision

`@deepseek-ai/dsh-deepseek-llm-api-extensions` owns one effect-scoped registry for additive top-level fields on official DeepSeek requests. Contributor packages own field semantics: `@deepseek-ai/dsh-plugin-package-inventory-deepseek` produces `dsh_plugin_packages`, while `@deepseek-ai/dsh-session-log-deepseek` produces `dsh_session_log`. The adapter serializes its base request first, prepares a detached and frozen extension set, rejects field collisions, and runs captured acceptance callbacks only after an HTTP 2xx response. The registry is DeepSeek-specific; the provider-neutral LLM seam and pi-ai adapter do not consume it.

The standalone plugin-package inventory defaults to enabled for callers that mount it deliberately. The shipped base profile overrides it to disabled and enables it only when `COHARNESS_SEND_PLUGIN_METADATA=1` is present. The inventory contains only active Loader package name/version pairs; it excludes paths, configuration, credentials, ordinary dependencies, and loose or in-memory entries. The session-log contributor defaults to disabled and the shipped profile requires `COHARNESS_UPLOAD_SESSION_LOG=1`, an optional endpoint allowlist, and the `COHARNESS_DISABLE_SESSION_LOG_UPLOAD` kill switch. It sends the canonical Session header and the suffix after the greatest durable `delivery-accepted` watermark. A successful response appends that watermark; uncertain delivery is retried at least once after a crash.

Both fields are provider metadata outside messages, the system prompt, and tool schemas, so they add no model-input tokens or cache-prefix changes. The existing [telemetry opt-in decision](../feature/2026-08-10-telemetry-default-off.md) remains authoritative for telemetry feeds; these request extensions are independently gated and audited.

## Alternatives considered

**Send the fields on every official request.** Rejected because a missing configuration is not positive consent to disclose package or Session information.

**Insert the metadata into messages or the system prompt.** Rejected because it would change model-visible history, token accounting, replay requirements, and cache behavior.

**Let each contributor mutate the adapter request directly.** Rejected because contributors would share transport lifecycle, could overwrite base fields, and could not reliably commit acceptance state after the response status is known.

## Consequences

Normal dsh profiles keep the new fields absent and make no new data export. Explicit deployments get deterministic, allowlisted metadata with fail-closed preparation and a request-level kill switch. Extension preparation errors prevent HTTP dispatch; acceptance failures are surfaced as request errors after the provider has accepted the response. Session-log delivery is at-least-once: a crash between server acceptance and durable watermarking can replay a suffix, but never skips an event.
