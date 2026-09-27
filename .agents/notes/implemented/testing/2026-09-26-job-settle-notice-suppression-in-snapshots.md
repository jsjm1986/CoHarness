# Agent Note: Suppress racing job-completion notices in replay fixtures

Status: implemented

English | [中文](2026-09-26-job-settle-notice-suppression-in-snapshots.zh.md)

## Problem

`missing-sandbox-runner` scripts a background `bash` call whose child dies immediately (the sandbox runner executable is absent), followed by `job_output` with `wait: true`. Two runtime clocks race there: the job registry marks a terminal job `reported` when a waiter is attached at settlement, while `tool-jobs` splices an "unreported" completion notice into the agent inbox. When settlement lands before `job_output` attaches its waiter the notice is injected and delivered; when the waiter wins, the job is reported silently and the notice never exists. macOS observed the first ordering and Linux CI the second, so identical replays produced different durable message counts.

## Decision

Keep the production `reported`/notification semantics — either transcript is correct output of a real run — and make the *fixture* deterministic by removing the race entirely: `tests/fixtures/missing-runner-completion-waiter.ts` registers a `tools/execute` waterfall hook that, on a `run_in_background` `bash` call, installs an `onJobsChanged` listener through the executing agent's own context before delegating. The listener files into the job owner's scope layer, so `jobs-local` reaches it at the registration commit — inside `start()`, before the producer's asynchronous settle can run — and attaches a waiter unconditionally. Settlement then always finds `waiters > 0`, marks the job `reported`, and the completion notice is suppressed on every platform. The scripted `job_output wait=true` read still surfaces the terminal `[status: killed, killed before exit]` record, so the runner-failure evidence is unchanged.

Scope routing is the constraint that dictates the mechanism: `ctx.jobs` contributions are layered by the registering context's scope, `onJobsChanged` reaches a listener only through the owner's scope chain, and the session's registry is invisible to composition-level plugin contexts. The agent's own `ctx.get('jobs')` — obtained inside the dispatch waterfall — is the one registration point guaranteed to be both on-chain and earlier than settlement.

## Alternatives considered

- **Pace the settle with an extra scripted step.** A `todo_write` step between `bash` and `job_output` widened the settle window but left it free-running; the job still settled after the waiter attached on Linux CI. A timing margin is not a barrier — rejected empirically.
- **Guarantee delivery instead.** Pinning the notice at a fixed step requires settlement before a chosen pre-step; the same uncontrolled spawn latency defeats it on the other side of the race.
- **`completionDelivery: 'quiet'`.** Only changes the idle-owner path; a busy owner is still injected, so the race survives.
- **Scripted `job_kill`/`job_output wait=false`.** Their result text differs between the live-job and already-settled branches — the race reappears inside the tool result itself.
- **Change `reported` semantics in `jobs-local`.** The waiter-attachment check exists so a synchronous `job_output` answer is not followed by a redundant inbox notice; suppressing real-run behavior to please one replay would trade product semantics for fixture convenience.
- **Platform-split the fixture or golden.** The transcripts are identical in meaning on both hosts; only the scheduler differs, so splitting would duplicate the scenario to encode a timing accident.

## Consequences

The scenario's session log and stdout golden pin the suppressed branch unconditionally: the notice never exists, so message ordinals are identical under any settle latency. `background-confinement-failure` keeps coverage of the delivered-notice ordering (its refusal settles inside the admission call, deterministic by construction), and `background-job-admission` covers explicit `job_kill` reporting.

## Related

- [ACP snapshot tests](2026-06-19-acp-snapshot-tests.md) owns replay and normalization mechanics.
- [Snapshot session-identity binding order](2026-09-26-snapshot-session-identity-binding-order.md) owns the claim order that makes the delivered-notice token stable.
