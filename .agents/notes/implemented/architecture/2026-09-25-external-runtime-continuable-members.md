# Agent Note: External-runtime continuable members ride one shared adapter turn

Status: implemented

English | [中文](2026-09-25-external-runtime-continuable-members.zh.md)

## Problem

Agent Teams spawn teammates through `ctx.subagents.startContinuable`, and the roster selects the provider by name. Before this change only the in-process `spawn`/`fork` providers advertised `prepareContinuable`; the external providers — `subagent-claude-code` and `subagent-codex` from the [product-backend decision](../feature/2026-08-04-claude-code-and-codex-subagent-backends.md), and `subagent-acp` from the [ACP backend decision](../feature/2026-06-22-acp-subagent-backend.md) — accepted one-shot `start()` calls only, so a Team configured to use them could not create members at all. Implementing each provider's own continuation lifecycle would duplicate durable identity, inbox ordering, activation, cold resume, and disposal inside every provider, and none of their external runtimes expose an Agent handle the harness could own.

## Decision

An external continuable member is an ordinary in-process continuation-managed child Agent; the external runtime serves only as its model backend. The provider marks the capability by implementing `prepareContinuable` (detached data only — no Agent, handle, or prompt-delivery function crosses the boundary), registers an `LlmAdapter` route, and advertises `agentRouteDefaults` so a Team request without explicit `agentOptions` still resolves a valid provider/model. Every member model call maps to one turn on the external runtime's durable session, keyed by the child's harness Session id through `GenerateOptions.sessionId`:

- `subagent-claude-code`: one Agent SDK `query` per call with `persistSession`, `resume` when bound; member-capable whenever the `llm` service is mounted.
- `subagent-codex`: one `codex app-server --stdio` per call; `thread/start` with `ephemeral: false` mints the durable thread, `thread/resume` re-attaches.
- `subagent-acp`: one ACP child process per call; `session/load` attaches the durable session. `session/load` is an optional ACP capability, so `resume: true` is a config gate and the provider probes `loadSession` at member creation — a one-shot-only agent rejects before the durable child exists.

`dsh-subagent/external` holds the shared member machinery rather than per-provider copies: an append-only JSONL binding store (child session ↔ external session, pending prompt, consumed cursor), the trailing-user prompt window over the model-visible message list, and `externalMemberTurn`, the single turn driver every adapter delegates to. An issued prompt is recorded pending; recovery proves its state from the external runtime's own durable transcript — a settled answer replays without resending, a provably absent prompt resends once, and an unprovable outcome drops with `EXTERNAL_TURN_OUTCOME_UNKNOWN` rather than risking a duplicate delivery. A provider without `prepareContinuable` stays one-shot only and continuable starts reject `UNSUPPORTED_CAPABILITY`.

## Alternatives considered

**Let each provider own the whole continuable lifecycle.** The continuation manager would have to delegate identity, inbox, persistence, activation, and restart to three divergent implementations, and the unknown-outcome/no-replay rules would be re-derived per provider with no shared proof.

**Expose the external runtime as a remote Agent.** Neither the Claude SDK session, the Codex thread, nor an ACP session offers an Agent surface the Activation machinery can install; inventing a facade would split ownership of the same child across two lifecycles.

**Retry unknown-outcome turns automatically.** The external transcript cannot always prove whether the prompt was consumed; resending can duplicate the user turn inside a durable external session, so the member reports the unknown outcome instead and the consumed cursor still advances.

## Consequences

A Team member keeps every harness-side guarantee — durable identity, ordered inbox, Activation, cold resume, disposal — while its model calls execute inside the external product's durable session. Each member model call pays one external process spawn and handshake; no pooling keeps ownership per call so teardown stays the subprocess seam's job. Auxiliary model calls (compaction, titles, reviews) reject on member routes because the external session cannot answer them — a member that produces one fails loud instead of silently addressing the wrong session. Crash recovery leans entirely on the external runtime's own durable transcript: the JSONL binding store keys the mapping and the pending prompt, it never replays conversation content. Deployments without the `llm` service (Claude Code, Codex) or without `resume: true` on a `loadSession`-capable ACP agent keep the provider one-shot only and see `UNSUPPORTED_CAPABILITY` on continuable starts rather than a half-capable member.
