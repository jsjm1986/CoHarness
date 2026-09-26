# Agent Note: Pace background-job settle in replay fixtures

Status: implemented

English | [中文](2026-09-26-job-settle-pacing-in-snapshots.zh.md)

## Problem

`missing-sandbox-runner` scripted a background `bash` call whose child dies immediately (the sandbox runner executable is absent), followed one step later by `job_output` with `wait: true`. Two runtime clocks race there: the job registry marks a terminal job `reported` the moment a waiter attaches, while `tool-jobs` splices an "unreported" completion notice into the agent inbox at the next step boundary. When the settle completed before `job_output` attached its waiter the notice was injected and delivered; when the waiter won, the job was reported silently and the notice never existed. macOS observed the first ordering and Linux CI the second, so the identical replay produced different durable message counts and the stdout golden's trailing `{{message:N}}` token alternated.

## Decision

Keep the production `reported`/notification semantics — either transcript is correct output of a real run — and make the *fixture* deterministic: the scripted model now inserts a `todo_write` step between the background `bash` call and `job_output`. An ENOENT spawn settles in microseconds, so with a full intervening step the settle and its inbox splice always complete before `job_output` attaches its waiter; the notice is always injected, delivered, and numbered. Both plausible splice positions (before the `todo_write` step or before `job_output`) assign the same stdout-visible token to the final reply, so the golden holds under either platform timing.

`background-confinement-failure` already proves the sibling ordering — settle inside the call that started the job — and `background-job-admission` avoids the race by keeping its job alive until an explicit `job_kill`. Fixtures that need a settled-and-notified job get this pacing step; fixtures that need the opposite keep the waiter-first order.

## Alternatives considered

- **Change `reported` semantics in `jobs-local`.** The waiter-attachment check exists so a synchronous `job_output` answer is not followed by a redundant inbox notice; suppressing real-run behavior to please one replay would trade product semantics for fixture convenience.
- **Skip the wait and read job output twice.** A `wait: false` read races the settle itself, so the captured output text becomes timing-dependent — worse than the ordering it replaces.
- **Refresh the golden to the Linux ordering.** The drift was scheduling, not a behavior change; committing either ordering leaves the other platform red.
- **Platform-split the fixture or golden.** The transcript semantics are identical on both hosts; only the scheduler differs, so splitting would duplicate the entire scenario to encode a timing accident.

## Consequences

Authored fixtures may script extra steps for pacing; a step that exists only to bound an asynchronous settle is part of the scenario's determinism, not dead weight. Replay keeps no sleeps: the pacing works because the settle owner is a real subprocess whose failure precedes the next scripted call by a full step boundary, not because of wall-clock delay.

## Related

- [ACP snapshot tests](2026-06-19-acp-snapshot-tests.md) owns replay and normalization mechanics.
- [Snapshot session-identity binding order](2026-09-26-snapshot-session-identity-binding-order.md) owns the claim order that makes the delivered-notice token stable.
