# Agent Note: Upstream mcp-client generation sync

Status: implemented

English | [中文](2026-11-25-upstream-mcp-client-generation-sync.zh.md)

## Problem

Upstream rc.3 rewrote the mcp-client lifecycle around explicit `McpGeneration` records, per-Fiber status cells, runtime credential templates, and a one-shot probe — but the local tree still ran the older connection supervisor with weaker guarantees: a failed or timed-out generation could still publish tools, a replacement could start while an old managed process range had not confirmed teardown, and dispose threw on cleanup failure which wedged callers instead of recording the outcome. The local tree also owns divergences upstream does not share — `McpProcessOwner` admission, discovery/serving process fencing, resource-budget integration, and the `mcp/tool-call` waterfall — so wholesale file replacement was unsafe.

## Decision

Adopt the upstream generation model as the new base and re-thread the local process-owner and policy divergences through it.

`connection.ts` now runs one `McpGeneration` per transport/client lifetime: template resolution, connect, and initial tool sync execute inside the generation's signal; `syncTools` fetches then swaps atomically through the existing `eligible()` commit check; registration failures throw `McpToolRegistrationError` and close the generation through the `lost()` path. Reconnect supervision, credential-refresh, and notification re-syncs all serialize through `syncChain`/`settling`, so a new generation never overlaps a previous one whose closure is unconfirmed.

`generation.ts` owns the transport lifetime, pending-work tracking, and a `close()` that returns `McpCloseResult { closeConfirmed, cleanupError? }` instead of throwing; `managed-stdio.ts` keeps local admission, env scrubbing, discovery-probe, and process-range cleanup — `McpGeneration` optionally routes stdio connects through `processes.connect(client, transport)`. `status.ts` registers a `McpStatusCell` on `ctx.fiber` that survives HMR reloads, retains the final `McpCloseResult`, detaches observers on final unload, and is read by managers through `connectionStatusOf(fiber)`. `credentials.ts`/`templates.ts` resolve `${credential:REF}` under `expandTemplates`, watch `credentials/reference-updated`, and redact every resolved value — including earlier rotations and URL-encoded forms — from diagnostics, tool errors, and `isError` text. `probe.ts` exposes `probeServer` for one-shot connect-identify-list-close checks that reserve no name and register nothing. `deadline.ts` and `types.ts` complete the shared deadline and client-safe type surface.

The mount contract changes deliberately: `dispose()` always settles within `closeTimeoutMs`; unconfirmed or failed cleanup is recorded in the status cell and logged, and `mountMcpClient` refuses the same Fiber's next mount (`previous connection cleanup is incomplete; restart the Host`) — while the namespace still releases so a fresh Fiber may take the name. While the recorded closure is incomplete, another `dispose()` call retries the process cleanup the stdio `McpProcessOwner` still retains and records the new result; [`browser-use-runtime`](../../../../packages/experimental/browser-use-runtime/src/mcp.ts) reads that closure to keep an exclusive attachment reserved until cleanup is confirmed. Observers are detached inside `mountMcpClient.dispose` when `ctx.fiber.uid === null`, before the supervisor publishes the terminal `closed` state, so watchers survive reloads yet never observe the final transition.

## Consequences

- `startConnection(ctx, config, policy, status)` requires a `McpStatusCell`; direct callers construct one and `apply`/`mountMcpClient` go through `registerStatusCell`.
- `expandTemplates: true` requires a credentials provider at load; missing values enter `waiting-credentials` without consuming reconnect attempts, and only resolved-value changes trigger a controlled rebuild.
- `startupTimeoutMs` carries no schema default; the stdio process owner keeps its own `120,000` admission fallback.
- `Config` accepts `closeTimeoutMs` (default 5000) and `expandTemplates` (default false) on both transports, `processGraceMs`/`processCloseTimeoutMs` on stdio, and exports `ReconnectSchema` plus the `./types` package entry for managers.
- Status observers that dispose the Fiber mid-reload are contained; cleanup still covers the in-flight attempt.

## Alternatives considered

- **Keep the old supervisor and bolt on status/probe** — rejected: the correctness fixes upstream made (generation fencing, bounded closure, credential rebuild) interlock through the same `current`/`settling`/`syncChain` state; a partial port would leave the same races the rewrite removed.
- **Retain dispose-throws-on-cleanup-failure** — rejected: upstream's record-and-block contract covers reload replacement through the retained status cell without wedging Cordis unload, and the namespace release keeps a fresh Fiber able to recover.
- **Drop `mcp/tool-call` waterfall in favor of upstream's direct `client.callTool`** — rejected: local deployment policy (revocation cancellation, per-server admission) rides that event; the upstream signal/timeout changes were merged around it instead.
- **Replace `managed-stdio.ts` with upstream's stdio path** — rejected: local resource-budget admission, discovery/serving process fencing, env scrubbing, and managed-range cleanup have no upstream equivalent; the upstream lifecycle model composes with it through the `McpProcessOwner` injection.

## Verification

- `pnpm exec vitest run packages/mcp` — 236 tests pass across 18 files, including `generation.spec.ts`, `status.spec.ts`, `credentials.spec.ts`, `probe.spec.ts`, `diagnostic.spec.ts`, reconnect/disposal bounds, and managed-stdio admission suites.
- `pnpm exec tsc -b packages/mcp/mcp-client` — clean; `verify-export-jsdoc` — clean; `oxlint` — clean.
- `verify-translation-pairing` — 2182 pairs consistent after the bilingual README rewrite; `gen-config-catalog` regenerated for the new fields.
