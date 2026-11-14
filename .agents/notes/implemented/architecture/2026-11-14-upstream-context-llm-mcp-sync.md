# Agent Note: Upstream context, LLM, and MCP fixes from v0.2.2-rc.3

Status: implemented

English | [中文](2026-11-14-upstream-context-llm-mcp-sync.zh.md)

## Problem

Upstream `dsh-v0.2.2-rc.2 → dsh-v0.2.2-rc.3` carried context, LLM, and MCP fixes worth backporting selectively; several upstream targets do not exist in this fork or were reverted upstream.

## Decision

Backported fixes:

- `e3a485bd32` llm-deepseek: catalog models now advertise the official `/models` context window (1,048,576) instead of the adapter fallback (1,000,000).
- `032fd5f6d5` mcp-client: connection diagnostics keep the `cause` chain (`describeError`), so `TypeError: fetch failed` now surfaces the real syscall error.
- `5285c6dcc4` mcp-client: tool sync commits only for a still-entitled generation — a listing overtaken by an abandoned attempt or close publishes nothing and leaves prior registrations untouched; give-up unregister is contained per disposer.
- `09570cf383` mcp-client (partial): give-up disposal containment and `resolveReconnectPolicy` re-export. Upstream's probe-abort and async-status-listener parts target `probe.ts`/`status.ts`, which do not exist in this fork (mcp-manager feature batch).
- `321d6362c5` compaction-basic: history compacts against the new model's envelope before a provider/model switch, priced through `tokenMeter.measure(session, header)`; failure aborts the switch with `MODEL_SWITCH_COMPACTION_FAILED`, preserving the prior route.
- `022da17f27` agent-loop/system-prompt: runtime-context snapshot now reads "The following information describes your current session…"; dedup compares snapshot sections (upstream semantics) instead of rendered text so the first→subsequent intro flip does not forge an update. Recorded fixtures and the session-title injected-prefix list were rewritten.

## Consequences

- Restored/legacy `RuntimeContextProjection` entries without stored sections dedup on exact text or raw body; snapshot-form entries dedup by section equality.
- `renderContextSnapshot` emits the first-snapshot intro; `joinContextSections` returns the body only (agent.ts feeds `project()`, which owns the intro).
- Subagent spawn fixtures: `session/created` now legitimately precedes a rolled-back spawn; `agent/created`/`subagent/start` still must not fire.
- Restored-but-unannounced sessions need `ctx.sessions.announce(session)` before appends in fixtures (session-reference, gateway-execution authority).

## Alternatives considered

- `b015d18e81` agent-loop rejected-route diagnostics — the checked structure does not exist in this fork.
- `156dad153d` + `624c3e91a9` llm-deepseek all-deferred placeholder — upstream added then reverted it; net upstream behavior (surface the provider 400) matches our current serializer.
- `ed645016cd` tool-jobs inline output — our tool-jobs generation has no inline-completion-notice path.
- `8b085b7e35` web-search credential order — our web-search-deepseek has no account-route (`deepseekAccount`) path.
- `2676c67f32` prompt-prefix preservation — already backported in the preceding session-lifecycle batch.
- `aa685be0a44` compaction review details — commit not present in rc.3 (superseded).

## Verification

Affected suites: agent-loop+system-prompt 549, compaction 235, mcp-client 149, llm-deepseek 548, session-reference 92, subagent-spawn-in-process + continuation-presets + gateway-execution authority all green.
