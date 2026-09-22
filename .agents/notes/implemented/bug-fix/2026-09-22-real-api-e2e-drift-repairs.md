# Agent Note: Real-API e2e drift repairs (Messages endpoint, mount order, upstream contract ports)

Status: implemented

English | [中文](2026-09-22-real-api-e2e-drift-repairs.zh.md)

## Problem

The required `test:e2e` lane surfaced a wide cluster of failures that decomposed into a small set of drifts:

- Every `messages`-protocol request 404'd: `resolveAdapterOptions` mapped a service-root `DEEPSEEK_BASE_URL` (`https://api.deepseek.com`, `/v1`, or `/anthropic`) to `{base}/v1/messages`, but the public Messages API lives at `https://api.deepseek.com/anthropic/v1/messages`. All real-model e2e failures — headless coding/resume/compaction/full-loop/todo-write/real-model, fs-tools, spawn-in-process, subagent-acp, ACP escalation/hooks, agent-instructions, request-cache, session-title provider, and the pi-ai block-parity test (whose `fromDeepSeek` side returned zero blocks) — share this root cause.
- `AgentLoop.startConfigured` only waits for a pending persistence backend when the configured agent carries an explicit `sessionId`; `agents:` entries without one read `ctx.sessionPersistence` synchronously at create time. Four cordis.yml compositions mounted `session-persistence-jsonl` after agent-spine, silently producing ephemeral sessions.
- The otel loader-composition suite still asserted the removed `FULL` mode and the old `load()`-side interrupted-tail repair; the crash-recovery test had been simplified away from `interruptedTurnClosers`; the jsonrpc keyless smoke spoke chat-completions SSE to a composition that now ships `messages`; the `sdk` profile inherited the fork-added default `tool-str-replace-editor` from `dsh-base`, contradicting its documented opt-in contract; the Python SDK guide lacked the `opt-in-to-str_replace_editor` anchor the keyless smoke reads a patch block from.

## Decision

- `messagesServiceBase` now normalizes every public service-root form to `…/anthropic` before `messagesApiRoot` appends `/v1/messages`; custom gateway bases keep the existing `/v1/messages` route. `DEEPSEEK_BASE_URL` stays the service root everywhere (the temporary workflow edit to `/anthropic` was reverted).
- Moved `session-persistence-jsonl` (and its checkpoint-policy follower) above agent-spine in `session-telemetry-otel.cordis.yml`, `minimal.cordis.yml`, `child.cordis.yml`, and `time-context.cordis.yml`, matching the convention comment the shipped headless profile already carries.
- Ported the upstream contracts verbatim where the fork had drifted: the telemetry fixture now defaults to `FEEDBACK_ONLY` with feedback recorded before a private second turn, the e2e asserts the feedback-authorized-prefix export shape and the new DISABLED warning text, and `FULL` is asserted rejected; `crash-recovery` reads through the open/read handle and appends `interruptedTurnClosers` with `system/message` in the expected event list; the jsonrpc smoke's fake server emits Anthropic SSE with `stop_reason: 'max_tokens'` and asserts messages-format request fields plus the `startup failed: 1 required plugin did not activate` diagnostic.
- `sdk-app`'s patch disables `tool-str-replace-editor`, restoring the documented read/write/edit default; the Python SDK guide gained the anchored opt-in section whose yaml inserts `fs-local` plus the editor for `sdk-minimal` and the editor row alone for `sdk`.
- `fs-local` display-path resolution now preserves the physical spelling of `..` segments (nearest-existing-ancestor `realpath` walk), so traversals through a symlinked session root resolve against the physical parent.

## Alternatives considered

**Pin `DEEPSEEK_BASE_URL` to `/anthropic` in CI.** Rejected: the fork treats the variable as the service root in docs, tests, and chat-completions routing; remapping inside the resolver keeps one meaning.

**Extend `awaitStartupPersistence` to non-`sessionId` configured agents.** Rejected for this repair: upstream carries the identical asymmetric read, the shipped composition comment documents the mount-order requirement, and widening the product wait diverges from upstream without a driving consumer.

## Consequences

- All keyless suites in the repaired cluster pass locally: otel loader-composition 4/4, crash-recovery 2/2, jsonrpc keyless-smoke 4/4, sdk keyless-smoke 9/9, multi-project-sandbox 4/4, time-context 1/1.
- Real-model suites remain credential-gated locally and carry one shared CI-verification hypothesis: every observed failure mode (empty `finalText`, zero `tool/call`, `stopReason 'error'`, `acceptedThrough -1`) is consistent with the Messages 404 and should clear under the remap.
- Related: [the mount-race note](2026-09-21-configured-agent-persistence-mount-race.md) owns the `sessionId`-configured wait this ordering convention complements.
