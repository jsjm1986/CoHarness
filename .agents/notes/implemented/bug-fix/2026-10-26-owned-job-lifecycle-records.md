# Agent Note: Owned job lifecycle records

Status: implemented

English | [中文](2026-10-26-owned-job-lifecycle-records.zh.md)

## Problem

A job can finish without a model reading its output. Tool calls and completion notices alone cannot establish its registration time, terminal time, original owner, or whether its producer reported an outcome. The declared job events need a writer that preserves those facts independently of model collection and live browser observation.

## Decision

The local registry appends the existing `job/registered` and `job/settled` events to the exact owner's Session. Both use the same registry-issued job id. Registration follows producer acceptance and precedes synchronous registry observers; settlement records the first terminal outcome before releasing waiters or announcing completion. Unowned work has no owner Session and writes neither record.

The registry captures the creating tool invocation before calling the producer. Bash, one-shot subagents, workflows, and terminal sends supply their exact and root call ids, so nested execution retains its model-requested root. Both lifecycle records retain this attribution even if later work changes the caller's state. The records carry no output bytes and do not consume the model's output cursor.

`producerReported` is true only when `done` fulfills. A rejected promise or forced teardown failure records false. The flag acknowledges a producer report; it does not certify that a broken provider released every resource. First-wins settlement prevents a late completion from replacing a forced failure.

Recording failures are logged with contained exception rendering. Accepted work keeps its cleanup and waiter-release paths, so journal failure cannot orphan a producer by throwing after startup. The Session history can be incomplete after such a failure; absence of a record is not proof that work never ran. These events are historical evidence and grant no permission to resume or control a job.

The event hub reserves each notification's position before publishing its Session record. Synchronous journal and registry observers can produce more events, but all matching subscribers receive the preceding notification first. Terminal state commits before journal observers run, so their cancellation of a pending wait cannot replace the committed outcome with a wait-aborted error. The registry still rejects cancellation while work is live.

## Alternatives considered

- **Use only tool calls and notices.** Direct host registrations and uncollected completions lack a reliable lifecycle pair. Dedicated log-only events retain facts without adding model context.
- **Throw after a journal append fails.** The producer already owns execution resources. Withholding its public id would break the registry's accepted-work cleanup guarantee.
- **Persist output and live controls with the lifecycle.** Output retention and execution ownership have different lifetimes. The [live browser roster](../feature/2026-08-08-web-background-job-display.md) and [generic runtime](../architecture/2026-06-20-generic-long-running-tool-runtime.md) retain their current responsibilities.

## Consequences

Session persistence and forks retain historical execution facts without reviving work. Job controls and output remain process-local. The existing event fields and Session format are unchanged.

## Verification

Registry regressions cover observer order, original attribution, timestamps, unread output, producer acknowledgement, forced failure, late completion, append-failure containment, and cancellation from a terminal journal observer. The real Loader example runs a Bash process and PTC workflow, collects the result, and compares eight lifecycle pairs from the physical JSONL artifact against the live Session. Its journal observer immediately cancels a new job while registry observers append output, establishing registration, stopping and output order across both observer systems.

Snapshot comparison normalizes the service-owned lifecycle clocks while preserving attribution, status, cause, acknowledgement and arbitrary payload text. Timestamp accuracy is verified by the registry tests rather than inferred from a normalized transcript.

The TypeScript SDK records the real SDK child failure through a shipped profile and retains both lifecycle records in its protocol transcript. The Python SDK runs the same composition through the built CLI and checks original ownership, call ids, ordered timestamps and the child-run diagnostic. Source and emitted Node 22/24 SDK replays preserve the child model failure rather than substituting initialization failure.
