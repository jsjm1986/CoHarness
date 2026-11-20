---
kind: upgrade-guide
description: "Disaster recovery requires physical source isolation and reviewed execution; governance reconstruction denies old authority."
---

# Recovery after source loss

English | [中文](guide.zh.md)

## Change

Planned recovery requires source-confirmed stop. Disaster recovery requires recorded whole-computer physical isolation; disconnection is insufficient. It revokes source credentials and leases, permanently quarantines that identity, and preserves each project's identity and separate approval.

Restored schedules and pending messages stay paused; old conversations remain read-only. Stopped-target inspection permits new conversations and individually reviewed components, never uninspectable dynamic code. Inspection does not stop active work. Every disaster needs a new permit. Planned migration carries the original frozen Session set, preserves later conversations and requires fresh destination review. Its point must contain the source review before retirement. Routine upgrades retain existing permits.

Personal and project disaster recovery suspend restored `HGW_*`, `DSH_*`, libpq connection settings and `DATABASE_URL` in the target copy. Admin shows setting names for reconfiguration; encrypted source points retain values. Business settings, ordinary upgrades and planned migrations remain unchanged.

## Migration

1. Apply [governance migrations 130–136](../../../../gateway/deploy/postgres/migrations) before running upgraded Gateways. Upgrade participants together; older workers cannot process these phases. Maintenance restores must preserve current isolation, quarantine, execution holds and approvals.
2. API clients handle `recoveryMode: "planned" | "disaster"` (default `planned`), `preparing`, `externally-fenced` and `disaster-ready`. Display `executionReviewRequired` separately from activation.
3. Independently rehearse the gap-free point before physically isolating its source. Confirm policy revision, point, source identity, process generation and writer epoch; record a credential-free evidence reference. Confirmation cannot reopen the source; the serving primary cannot isolate itself. Members require destination computer access.
4. After activation, inspect the stopped target and approve the exact review in `new-conversations-only` mode. Component approvals bind digests and evidence references, then require reinspection. Verify new conversations and read-only history. Single-computer mode offers local execution review, without remote management or new takeovers.
5. `/admin/api/peer-backups/personal-recoveries` requires verified `native-personal-v3` data. Handle `preparing`, `prepared`, `externally-fenced`, `activating` and `published`, plus separate execution review. Preserve account/Runtime IDs, access, quotas, tab identities and document receipts. Occupied targets cannot be overwritten; partial points or incompatible paths allow isolated rehearsal only.
6. Preserve node-private `recovery-execution` and `governance-rebuild-local` files with independently held recovery keys. Missing or altered files block authority. Legacy governance inventories 1–7 remain partial and restore neither credentials nor writer authority.
7. For organization loss, follow [offline reconstruction](../../../../gateway/docs/peer-backup/README.md#governance-rebuild) into an empty database using `governance-rebuild-v1`. Preserve name keys; use new bootstrap credentials at `/admin/governance-recovery`. Other routes remain closed until account review and release; grants still require explicit configuration. Then bind retained data and review execution at each owning computer's `/admin/governance-recovery/local`. Verify documents and a newly allocated Runtime share the accepted account home after original Runtimes retire. New Runtimes retain independent storage and inherit no execution permit. Missing bindings block allocation; missing retained roots are not recreated. Keep accepted private evidence when retiring Runtimes.

8. Keep the point’s original ciphertext receiver. Every new planned, disaster or personal recovery requires the replacement’s installed scope worker, including when the receiver is the replacement. A separate replacement also requires both Gateways’ recovery protocol, a fresh fingerprint-only read approval, independently escrowed credentials, a drill on that replacement and its verified volume. Handle `repositoryNodeId` separately from `targetNodeId`; do not silently substitute the receiver when the selected replacement is unavailable. Schema-135 reconstruction packages retain their original checksum and field validation when imported into 136; new read grants and protocol heartbeats remain empty.

See [encrypted computer backups](../../../../gateway/docs/peer-backup/README.md) for coverage and recovery limitations.
