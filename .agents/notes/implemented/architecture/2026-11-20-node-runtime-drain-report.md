# Agent Note: Confirm every Runtime in an opted-in node drain

Status: implemented

English | [中文](2026-11-20-node-runtime-drain-report.zh.md)

## Problem

A Gateway can stop its own services without verifying whether each managed Runtime closed and persisted its Session log. A bounded node drain also needs to cover several worker batches. One process timeout or stop error can otherwise obscure which other generations completed.

## Decision

Default Gateway shutdown retains Runtime processes while refusing new starts. Opting in with `HGW_DRAIN_RUNTIMES_ON_SHUTDOWN` closes admission, joins pending starts, and inventories the tracked and assigned generations, including supervisor-owned systemd units. The Gateway reuses each generation's process and storage fences for at most eight concurrent stops. The aggregate retains the independent Session receipt through stopped-state accounting. Gateway exit status requires complete inventory, confirmed process and Session outcomes, and completion before the node deadline.

## Alternatives considered

Treating supervision completion as the only result loses the difference between a durable Session and a forced process stop. One short deadline shared with unrelated Gateway cleanup can expire before the later Runtime batches. Keeping the stop deadline independent allows multiple batches while preserving the existing cleanup budgets on each side. Unbounded waiting would leave a Gateway unable to exit after a stalled supervisor or database operation.

## Consequences

The node log reports exact generations where known, marks unfinished discovery and stops on deadline, and preserves a Runtime's checkpoint outcome when stopped-state verification fails. Failed stops retain their existing durable process and accounting fences. Deterministic worker tests cover multiple batches, deadline expiry, and generation replacement. A real Gateway entry using disposable PostgreSQL and synthetic supervisor results checks the JSON report, exit code and durable assignment states for confirmed, incomplete, timed-out and retained shutdowns. See the [Gateway configuration](../../../../gateway/README.md) and the [managed Runtime checkpoint decision](2026-11-20-managed-runtime-session-shutdown.md).
