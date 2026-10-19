# Agent Note: Background job ids are random short UUIDs, not per-kind counters

Status: implemented

English | [中文](2026-10-18-job-id-format.zh.md)

## Problem

`LocalJobRegistry` minted each job id from a per-kind counter: the first bash job of a process was always `bash-1`. The counter made ids predictable across registry lifetimes — a restarted registry reissued `bash-1` while callers could still hold references to the previous run's `bash-1` — and it let every consumer test depend on mint order instead of the returned handle. One `JobId` must name one execution in the tool result, the registry record, `JobEvent` payloads, and every control tool; a process-local ordinal cannot promise that once the registry lives longer or shorter than the caller.

## Decision

`LocalJobRegistry.start()` mints `${spec.kind}-${randomUUID().replaceAll('-', '').slice(0, 16)}` and retries while the candidate is already held by the same registry. The counter map is gone. Allocation still happens before the producer starter runs, so a throwing starter leaves nothing registered and capacity rejection precedes allocation. `JobId` remains an opaque branded string; only the mint changed, and the `<kind>-<short-uuid>` shape is documented on the brand, in the `dsh-jobs` contract, and in the [jobs subsystem page](../../../../docs/subsystems/jobs.md).

One `JobId` identifies one execution everywhere it is visible: the `start()` return value, the producer's `JobHandle.id`, `job.id` in `registered`/`settled`/`output` `JobEvent` payloads, `job_list`, `job_output`, `job_kill`, and completion notices. Access stays owner-authorized; the id's randomness is not a secrecy boundary.

Bounded completion notices no longer emit a truncated id. When even `background job <id>\nDone; job_output.` exceeds the producer's `outputLimitBytes`, `dsh-tool-jobs` degrades to `background job ended; use job_list for id.` — or `job_list` alone at smaller budgets — because a partial 16-hex suffix cannot identify a job.

Session identity normalization recognizes `<kind>-<16 hex>` job ids: `redactSessionSnapshotIds` mines job compounds out of literal payloads and collapses them to `{{id:N}}` tokens beside the existing uuid classes, keeping recorded sessions normalization fixed points. Replay sidecars name live ids through `{{fromRequest:(…-[0-9a-f]{16})}}` placeholders; committed session fixtures keep their recorded text untouched.

Live jobs were never resumed from Session history — a reopened session exposes no jobs — and this change introduces no persistence. `jobs.list()` on a fresh registry is empty.

## Alternatives considered

- **Keep per-kind counters** — rejected: restart collisions are unavoidable because the id space resets with the process, and consumer tests had to reproduce the mint order rather than read the returned handle.
- **Full UUIDs** — rejected: a 36-character id inflates every model-visible mention (ack text, `job_id` arguments, notices, `job_list` rows); the 16-hex suffix keeps collision probability negligible while fitting bounded notices.
- **Persist job records into the Session log** — rejected as out of scope: no consumer reconstructs live work from history, so the ids needed restart-unique minting, not durable records.

## Consequences

Tests and consumers can no longer predict ids: they thread the returned `JobId` or copy a `job_id` argument from a start result. Replay-driven session scenarios that script `job_output` or `job_kill` resolve the minted id through `{{fromRequest:…}}` placeholders. The committed `session.v7.jsonl` fixtures under `snapshots/session/background-confinement-failure/` and `snapshots/session/background-job-admission/` still carry recorded `bash-1` text and will mismatch normalized replay output until re-recorded; they were left untouched deliberately. The [v0.2.1-alpha.1 upgrade guide](../../../../docs/upgrade-guide/v0.2.1-alpha.1/job-id-identity/guide.md) carries the user-facing migration.

## Verification

`packages/jobs/jobs-local/tests/jobs.spec.ts` pins the `/^<kind>-[0-9a-f]{16}$/` shape per kind, proves a second registry never reissues the same first id, and drives a forced `randomUUID` collision to show the retry never replaces a live job. Consumer specs capture ids from start results or `jobs.list()`; `packages/test-support/session-snapshot/tests/identity.spec.ts` covers job-compound redaction across structured fields and literal text.

## Related

- [Generic long-running tool runtime](2026-06-20-generic-long-running-tool-runtime.md) — the producer/registry contract this mint serves.
- [Job registry seam](2026-07-26-job-registry-seam.md) — the three-package layout the registry lives in.
