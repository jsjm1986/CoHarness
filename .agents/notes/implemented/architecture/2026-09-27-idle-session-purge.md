# Agent Note: Idle Session purge through its lifecycle owner

Status: implemented

English | [中文](2026-09-27-idle-session-purge.zh.md)

## Problem

An Agent can report `idle` while maintenance, parked input or plugin-owned resources remain. Removing its persisted data before its lifecycle owner releases those resources can lose history while execution continues. Archive commands also outlive individual HTTP requests and must retain an explicit failure when a runtime cannot apply them.

## Decision

The Host API retains the factory handles returned for create, resume and fork. Permanent removal reserves every Session identity through `AgentRegistry`; overlapping lifecycle requests refuse the reservation, and new creation, child admission and resource allocation refuse reserved identities. Only the creator's handle can request `tryDisposeIdle()`. It closes input only after the true idle phase, inbox, live children and synchronous `agent/idle-release-check` observers permit release. Resource plugins inspect their own pending or retained work. Ordinary `dispose()` and cancel convergence keep their existing behavior.

Release follows live registry ownership: each selected descendant finishes disposal before its parent is checked. Team journal transactions retain the Lead identity from queue admission through the durability checkpoint. Teammate creation, provisioning recovery, mailbox delivery and asynchronous receipt processing retain their affected root and child identities throughout their awaited work. Goal driver tasks retain their Session through coalesced checkpoints until a round takes over or continuation is abandoned; a paused goal does not retain idle ownership. Every completion, failure or cancellation releases its own reservation. A purge refuses while these operations are pending and leaves their persistent data intact.

Purge requests enter the Gateway command ledger without deleting database contents. Online runtimes probe for pending commands without rescanning idle history. A busy or unowned Session produces a refusal before persistent deletion. Review artifacts are removed before logs. Personal logs are removed from deepest descendant to root, with each archive membership removed first: after interruption, every remaining descendant still has its ancestors for retry discovery. Project data is deleted once in the Gateway acknowledgement transaction. The runtime holds the identity reservation until that acknowledgement settles.

The Gateway locks the archive owner row before its command row, authenticates the runtime, and rejects conflicting acknowledgements. A pending purge cannot race a restore. An ordinary snapshot refresh cannot erase a queued action or recorded failure. Admin status polling reads metadata only; accepted requests remain visibly pending until the runtime confirms them.

## Alternatives considered

A Gateway-only purge cannot inspect runtime-owned resources. Force-cancelling active work during deletion combines cleanup with an execution decision the user must make separately. Requiring manual closure of every idle Session adds a step without proving resource release. The owning factory handle can establish idle release while active resources retain their veto.

## Consequences

Busy refusal preserves persistent data. Storage or network failure after cleanup begins may leave partial removal; the recorded conflict supports retry and does not claim rollback. Offline runtimes keep their commands queued without background startup. Historical reviews survive ordinary Session release and are removed only by explicit permanent purge. A missing review cleanup provider refuses removal when the log declares review records.

Returning bare Agents remains appropriate for reads and routing; it does not transfer disposal authority. Extending the synchronous release check with an asynchronous listener would reopen admission races and is not permitted by its return type.

The [cancel convergence decision](../bug-fix/2026-08-07-cancel-convergence-wake-latch.md) still governs ordinary cancellation. The [bounded runtime work decision](../bug-fix/2026-08-27-bounded-runtime-work-and-teardown-fences.md) owns synchronization budgets and teardown, and the [workspace review decision](2026-09-23-authorized-workspace-review.md) owns immutable review data.
