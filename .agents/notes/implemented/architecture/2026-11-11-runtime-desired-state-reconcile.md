# Agent Note: Desired-state Runtime recovery

Status: implemented

English | [中文](2026-11-11-runtime-desired-state-reconcile.zh.md)

## Problem

Foreground activity is not a Runtime's running obligation. A resident plugin or monthly scheduled task can remain necessary after weeks without browser access. Restricting recovery to recent activity leaves these tasks dormant after a process failure.

## Decision

`instances.desired_state` owns the durable running intent. A start sets it to `running`. Infrastructure `shutdown` and `failed` transitions preserve that intent through confirmed termination. Explicit `manual`, `idle` and `access-change` stops set it to `stopped` and take precedence over subsequent infrastructure cleanup. A failed stop retains the observed `stopping` state and occupied capacity until supervision confirms termination.

`InstanceManager.reconcile()` probes existing generations and restarts stopped infrastructure assignments with running intent through ordinary authorization, capacity and process-generation admission. Recently used legacy infrastructure stops remain eligible within `HGW_RECONCILE_WARM_WINDOW_MS` (default seven days). That window does not expire durable running intent. Never-started assignments and explicit or idle stops are excluded.

Warm starts leave foreground activity unchanged. Failure-scoped backoff ranges from `HGW_RECONCILE_BACKOFF_BASE_MS` to `HGW_RECONCILE_BACKOFF_MAX_MS`; sustained readiness for `HGW_RECONCILE_STABLE_MS` clears the failure streak. `HGW_RECONCILE=off` disables automatic recovery. Reconciliation does not terminate live incompatible releases; the [survivor policy](2026-11-11-runtime-survivor-retention.md) owns upgrade admission.

## Alternatives considered

**Start every assigned Runtime.** Rejected because metadata-only directory browsing and unused personal allocations must not consume processes.

**Use only recent foreground activity.** Rejected because background obligations outlive browser activity. The age window remains only for records without preserved running intent.

**Add another persistent resume flag.** Rejected because `desired_state` already names the required durable intent; a second field could disagree with explicit stop decisions.

**Supervisor-only respawn.** Rejected because it bypasses current Gateway authorization, quotas and generation admission.

## Consequences

Resident and scheduled work recover regardless of the last browser visit, provided the Runtime was already started and has not been explicitly stopped or revoked. Schedule still requires a running Host; this does not introduce an external timer service. On-demand Runtimes release through existing authenticated idle checks after their obligations end. Recovery shares bounded start capacity with interactive requests.

SQLite schema 11 gives the legacy test/local store the same desired-state semantics, preserving active rows and leaving stopped allocations stopped. PostgreSQL uses its existing desired-state column. Tests cover old running obligations, unused allocations, failed termination, stop precedence and unchanged activity timestamps.
