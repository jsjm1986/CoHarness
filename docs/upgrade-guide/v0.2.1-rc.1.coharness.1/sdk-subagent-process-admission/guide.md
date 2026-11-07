---
kind: upgrade-guide
description: "SDK subagents reserve process capacity before launch and join cleanup on provider unload."
---

# Admit and own SDK subagent processes

English | [中文](guide.zh.md)

## Change

The initiating Agent’s Context supplies model policy, resource capacity, LLM middleware and execution identity, including isolated implementations. Provider registration retains lifecycle cleanup ownership.

`subagent-dsh-sdk` acquires a process permit before constructing its SDK client when resource admission is installed. Missing required admission, refusal or queued cancellation prevents launch. Confirmed runtime exit releases the permit; unconfirmed cleanup retains uncertain occupancy. Provider unload and permit withdrawal cancel and join pending starts and published children. One-shot children close automatically; disposal shares cleanup.

`reasoningEffort` defaults accept request overrides.

Resource completion retains pre-publication operations and retries failed acknowledgements before admission or shutdown. Proven quiescence irreversibly releases uncertainty. Uncertain operations count against `maxControlOperations`. Completion messages identify settled registration attempts; consecutive cancellations retire old ids while retaining registered operations.

Model/process admission retries unacknowledged model closures by original id. Cancellation and withdrawal join adapter cleanup; pending admissions, cleanup and final acknowledgements share one shutdown deadline.

Authenticated uploads expire at the body deadline; refusal closes incomplete connections. HTTP concurrency permits two requests per operation.

Workflow/Ralph enter `engine.withForeground(parent, signal, operation)` before startup, collection, disposal and failure transfer. PTC retains original subagent admission. Withdrawal cancels and joins Consumers. Delegation captures the original subagent runtime before child-model preflight; withdrawal cancels and joins metadata transport before child or Job creation. Foreground subagents use `retainFailedCleanup(parent, run)`; workflows use `run.retainFailedCleanup()`. Observe confirmation asynchronously. Raw/background holders keep controls. One-shot Job termination during pending disposal retains one coalesced retry; further cleanup failure stays occupied until another termination request. Records and progress survive tool withdrawal. Retained failures survive runtime replacement. Providers retain unpublished rollback. Parent exit retries adopted cleanup and joins late transfers. A departing parent adds no registration; an unaccepted hand-back retries its original lease.

Startup pins resource and execution owners before asynchronous cleanup. Replacement or withdrawal cannot transfer a start or make it independent. Verification precedes native startup, publication and first-task dispatch. Unused permits return to their original provider; failed rollback stays retained.

## Migration

SSH-bound Sessions need a target-aware backend; local SDK refuses them before process admission.

1. Rebuild matching `dsh-subagent`, `dsh-tool-subagent`, `dsh-workflow`, `dsh-workflow-ptc`, `dsh-tool-workflow` and `dsh-tool-ralph`. Set `profile`, ordered `patches` and an absolute isolated `dshHome`. `dshBin` selects a CLI module; its default is the same-version dependency. Remove `command`, `args` and provider `cwd`; requests supply directories.
2. Keep process occupancy until confirmed cleanup. Never bypass refusal through private launch. After ownership changes, restore the provider and retry delegation.
3. Finish shutdown before unloading provider dependencies. Uncertain occupancy remains incomplete cleanup and unavailable capacity.
4. Use matching parent and child CLI builds supporting private bootstrap and completion registration metadata. Configure model/process capacity and model authorization on the parent; child model calls acquire distinct permits and report actual usage through the parent governance outbox. Keep child adapters and credentials configured in their profile.
5. Keep `controlPollMs < controlRequestTimeoutMs < controlCleanupTimeoutMs` and finish cooperative shutdown within the SDK EOF grace. Verify separate process/model admissions, parent-owned usage, and denied models never contacting providers.
6. Retain failed model/resource acknowledgements; retry original ids after recovery. Handle shutdown failures. Verify physical cleanup returns uncertain capacity without replacement permits.
