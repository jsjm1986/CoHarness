# Agent Note: SDK run-commands transcreation onto the carrier architecture

Status: implemented

English | [中文](2026-11-15-sdk-run-commands-transcreation.zh.md)

## Problem

Upstream `dsh-v0.2.2-rc.3` ships `sdk-run-commands`: `session/query` routes input either to native command execution or to an ordinary prompt, with `command/run`, `command/done`, and `session.query.completed` lifecycle events, plus `approval/request` and `user-question/ask` server-to-client requests. The alignment review deferred it because upstream's SDK server keys all of this on `AsyncLocalStorage`-scoped runtimes, while the fork's server is a different generation: SDK-owned agents live in `this.sessions` and cross-package context is a carrier-scoped `Scoped<SubagentRuntime>` rather than ambient async-local state. A cherry-pick would import a second ownership model; the feature had to be re-expressed on local primitives.

## Decision

Port the feature as a transcreation: identical wire vocabulary and client-visible behavior, different ownership internals.

- **Protocol** (`packages/sdk/protocol`) carries the vocabulary verbatim: `session/query` request/result kinds, `CommandExecution`/`CommandResult`, `session.query.completed`, `approval/request` with the `allowed-once`/`rejected`/`cancelled` outcome union, `user-question/ask`/`user-question.cancelled`, `capabilities.userQuestions`, and peer-request `AbortSignal` support in the transport.
- **Server** (`packages/sdk/server`) reimplements query-content validation, query-input routing, query-activity tracking, and the user-question bridge on local primitives. Agent ownership is explicit state: a live `this.sessions` entry wins, then `ctx.subagents.rootOf(agent)` claims managed descendants; `SubagentError`/`UNAUTHORIZED` lookups mean "not owned" and every other lookup failure propagates fail-closed. Durable session lineage (`origin: 'subagent'` + `parentSession`) gates `subagent.started` notifications and supplies child-session ownership where upstream used its activation registry. Command attribution uses an interval model — an activity claims the innermost open run — instead of upstream's active-query bookkeeping. Shutdown keeps `initialized` set so late `session/query` calls still receive `SDK server is shutting down` rather than the uninitialized error.
- **TypeScript client** routes `run()` through internal `session/query`, validates command lifecycle and completion fields, exposes `onRequest`/`onUserQuestion`, and advertises `capabilities.userQuestions` during initialize (which now calls `start()` first so the handler is captured in time). Fork-local semantics are kept where upstream diverges: `serializeSessionRun` serializes same-session high-level runs, the client releases completed ancestry edges so a finished child's descendants leave the root tree, `start()` after `close()` stays forbidden, and `normalizeInput` lives in `client.ts`.
- **Python SDK** mirrors the same routing and models (`CommandExecution`, `ApprovalRequestParams`/`Result`, `UserQuestionRequest`/`Answer`), `_serialize_session` per-session locking, and `next_request`/`respond` for peer requests.

## Alternatives considered

- **Cherry-pick the upstream server** — rejected: it would install `AsyncLocalStorage` ownership beside the carrier model, duplicate session identity, and leave the approval/subagent checks answering a different question than `ownsAgent` asks.
- **Drop `serializeSessionRun` to match upstream concurrency** — rejected: same-session run serialization is a deliberate fork contract; the upstream tests were rewritten to assert queuing instead.
- **Skip the Python mirror until the runtime lanes exist** — rejected: the fork keeps both SDKs projecting the same loop per repo convention, and the fake-peer suites run without a built wheel.

## Consequences

- `run()` on both SDKs now executes registered slash commands natively; literal slash text needs the low-level prompt path (documented in `docs/upgrade-guide/v0.2.1-rc.1.coharness.1/sdk-run-commands/`).
- Approval and user-question handling reach SDK callers only through explicit opt-in (`approvalRequests`, `onUserQuestion`/`on_user_question`), and user questions reach only directly SDK-owned agents — managed descendants are not bridged.
- Deferred upstream-only seams, recorded in the alignment matrix rows for `packages/sdk/server`/`client`/`protocol`, `packages/interaction/commands`, and `non-package:python`: `bindSubagentActivation` and manager-resident fixtures, `waitForTreeWork` (the fork keeps `waitForChildren`), the nested `startActivation` parent shape, and the unrelated scheduled-reminder `schedule/resolve-agent` changes.

## Verification

- `npx vitest run packages/sdk/server/tests/` — 263 tests pass (ported approval, commands, query-input, query-activity, user-questions, and parity suites plus the adapted server spec).
- `npx vitest run packages/sdk/client/tests/ packages/sdk/protocol/` — 195 tests pass, including `close-recovery-example.host.spec.ts` exercising `session/query` against the real built runtime.
- `python/sdk/.venv/bin/python -m pytest tests/test_run.py tests/test_approval.py tests/test_user_questions.py` — 70 tests pass.
- `pnpm run verify-export-jsdoc`, `run-oxlint` on touched packages, and `git diff --check` — clean; `pnpm run build` host compiler passes (aggregate typechecks fail on pre-existing, unrelated errors and a host-aggregate OOM on this machine).
