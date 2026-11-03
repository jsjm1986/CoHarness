# Agent Note: SDK subagent process admission and ownership

Status: implemented

English | [中文](2026-10-24-sdk-subagent-process-ownership.zh.md)

## Problem

The SDK client owns its subprocess outside the Cordis subprocess service. Scrubbing its environment does not provide resource admission. A provider registration can also disappear while its private SDK children remain alive unless the provider owns their pending starts and cleanup.

## Decision

The SDK subagent provider reserves a process permit with the initiating parent's Session and execution origin before constructing its SDK client. A missing required budget refuses startup. The SDK run receives the reservation and releases it only after its SDK cleanup confirms runtime-process exit; failed cleanup reports uncertainty. Construction failure returns the unused reservation.

Startup captures the initiating resource provider, its required-provider flag and execution authority before awaiting unpublished cleanup. These owners stay fixed across permit admission, control-listener startup, native initialization and publication. `SdkRunSpec.assertOwnership` verifies them before native startup and first-turn dispatch. It also rechecks cancellation after caller verification. Changed owners refuse the old attempt without acquiring replacement capacity; a failed rollback retains the original runtime and permit. Initial unmanaged absence cannot silently adopt newly installed admission.

One provider lifetime owns pending starts and published runs. Caller cancellation, permit withdrawal and provider unload stop child work. Unload joins late grants and cleanup. Completed one-shot runs close automatically; explicit disposal shares that same transaction. A failed cleanup remains owned for provider teardown and cannot count as successful release.

Published runtime cleanup preserves retryable completion through the SDK provider, subagent service and shared out-of-process handle. Each owner shares pending or successful disposal and allows another attempt after rejection. A failed permit acknowledgement retains the original run after physical exit; recovery releases that permit without creating another runtime or changing the settled child result.

Failed unpublished starts transfer their original rollback through `SdkStartupCleanupError`. The provider retains these owners after pending-start settlement, retries them before another launch, and joins them on unload beside published runs. Failure to confirm rollback refuses replacement. Cleanup shares pending work and successful acknowledgement; another attempt can retry a rejected report. A failed start publishes no child lifecycle edges, and a reaped process still owns its permit until acknowledged completion.

Both standalone SDKs retain the original subprocess after failed termination or exit confirmation. Closing permanently stops new work independently of cleanup success. TypeScript shares pending and successful attempts and retries rejected attempts; Python serializes attempts and applies its configured timeout to forced exit confirmation. A Python high-level instance clears its initialized state before teardown, so a failed close cannot admit another turn.

The Python SDK assigns stdin to one owned writer thread. Queued and active frames share `max_output_bytes`; callers wait for responses independently of native pipe writes. EOF is queued, and close confirms process exit and writer settlement before releasing its handle. Failed settlement retains that same handle. Per-request timeout validation precedes wire effects. Closing from a reader callback excludes the current thread from joins.

The backend executes locally. An SSH-bound parent Session is refused before admission; an absolute directory cannot substitute for its selected execution target.

Child route defaults are resolved together before startup. Per-request provider, model, reasoning effort and output cap override their configured defaults; omission does not silently discard one configured value.

SDK startup diagnostics finish when their actual stdio settles, including failed spawns that emit `close` without `exit`. Error delivery cannot depend on an unrelated live event-loop handle.

## Alternatives considered

**Release on child-result delivery.** A completed model activity can leave the SDK runtime process alive. Only cleanup establishes process exit.

**Treat unregistering the provider as child cleanup.** A registry disposer stops discovery, while already published children and pending starts retain their own resources.

**Hold one model permit for the entire child runtime.** A child can issue multiple concurrent model requests. One process reservation does not establish model-request admission or propagate model authorization and usage.

**Write stdin on caller threads.** A runtime that stops reading can block both request deadlines and shutdown behind the same pipe lock. A bounded FIFO keeps native I/O away from those control waits.

## Consequences

Independent compositions can omit resource budgets. Managed process admission is owned by the Consumer without changing the SDK wire or the standalone SDK client's launch API. The SDK process permit accounts for the runtime process itself. [Managed child requests](2026-10-24-sdk-managed-model-requests.md) separately enforce model policy, per-request admission and usage attribution.

## Verification

Focused tests cover refusal before construction, queued unload, publication cancellation, startup failure, uncertain cleanup and accounting failure. Real SDK subprocess tests check that the recorded PID has exited before release. A runnable SDK composition drives the real delegation tool and a second complete SDK runtime, proving admitted and refused launches plus configured reasoning in the child. These checks do not establish inherited child model governance, paid inference or complete escaped-descendant containment.

The [resource completion example](../../../../packages/subagent/subagent-dsh-sdk/tests/fixtures/resource-completion.mjs) uses a Loader parent and complete SDK runtime against a local accountant. It rejects the first runtime permit completion after physical exit, retries public disposal, and observes one allocation and one successful acknowledgement for the original runtime.

The [startup recovery example](../../../../packages/subagent/subagent-dsh-sdk/tests/fixtures/startup-recovery.mjs) confirms the failed child's PID is gone before rejecting its first completion report. The same provider acknowledges that original permit before allocating the next runtime; only the successful child publishes lifecycle edges. Unit barriers also cover cancellation during recovery, persistent accounting failure and control initialization rollback. The run driver and admission owner meet the per-file coverage gate.

The [SDK close example](../../../../packages/sdk/client/tests/fixtures/close-recovery.mjs) and its [Python projection](../../../../python/sdk/tests/test_close_recovery_snapshot.py) complete a deterministic model turn, hold plugin disposal open and refuse process termination. Retrying the same client reaps its original runtime while new requests remain refused. Python unit barriers cover admission during shutdown and bounded forced-exit confirmation.

A [complete Python SDK composition](../../../../python/sdk/tests/test_write_deadlines_snapshot.py) completes one model turn, blocks its next request inside the runtime event loop, times out a later prompt and reaps the original process without rescue. Native pipe tests cover output capacity, writer failure, retained writer cleanup, invalid-timeout mutation refusal and close from a notification filter.
