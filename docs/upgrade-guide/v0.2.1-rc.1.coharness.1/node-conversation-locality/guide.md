---
kind: upgrade-guide
description: "Upgrade managed computers to use versioned conversation admission and node-owned content."
---

# Upgrade conversation admission and storage

English | [中文](guide.zh.md)

## Change

Upgrade the primary, owning Gateways and Web assets together for cold preparation continuation. Custom clients must validate `503 INSTANCE_STARTING`, its exact Runtime header, bounded `preparation: {id, waitMs}` and `Retry-After` before continuing with `x-dsh-prepare-continuation`. Preserve all original request IDs and payload fields. Do not retry a lost response or generic HTTP failure automatically. Validate a cold open beyond one HTTP deadline, revoke access between attempts, and stop/restart the target before reusing a receipt; old receipts must not start or enter another generation. See the [Gateway timing rules](../../../../gateway/README.md#performance-and-runtime-admission).

The Web client uses one owner-qualified preparation request and a durable prompt receipt. Each node returns authorized rows for one Runtime. All spaces also searches authorized conversations already loaded in the tab. Personal directory placement and project content placement are independent. After upgrading, open a conversation on another computer, disconnect it and reload the tab. Confirm that input stays addressed to that computer and that reconnect retrieves the same conversation.

Custom renderers of `ConversationIntent` read `failure` (`denied`, `preset-unavailable` or `unavailable`) instead of the `denied` boolean. Use the original intent ID to correlate preparation, retain the draft, and render localized instructions without exposing server diagnostics. A preset failure requires an administrator check before an explicit retry; it does not authorize automatic continuation.

## Migration

1. Keep the existing release and its matching data backup. Use the same release on the primary and each node. The service bridge checks the release and the enrolled identity.
2. Apply all organization migrations shipped with the same Gateway release on the primary. They register governance tables. Existing projects and personal directories retain their placement.
3. For a node hosting new project data, provision its dedicated [PostgreSQL content volume](../../../../gateway/deploy/node-content/README.md). Verify the volume in Admin. A project can switch only when every required content domain provides an owner check and the source writer is fenced.
4. To move one personal directory, use the administrator operation `POST /admin/api/runtimes/<id>/personal-directory/promote` on its owning computer. The Gateway verifies a complete publication against the local copy before changing ownership. Check pagination with the original account and verify that a revoked computer has become inaccessible.
5. Configure the approved peer backup destination and run an isolated restore with the recovery credential. Check the protected time and coverage gaps for each scope before retiring any predecessor. During [project replacement](../../../../gateway/docs/peer-backup/README.md#takeover), select the destination volume explicitly when several are registered. Rehearse again before reapproving a changed policy, and configure a new backup policy after the replacement becomes the source.
6. Configure the [organization project name key](../../../../gateway/deploy/node-content/README.md) on the primary and activate after every owner has indexed its existing projects. Check duplicate creation, case variants and conflicting renames. Take a new maintenance backup on eligible single-node deployments: restore preflight rejects snapshots lacking the configured keyring or its active and pending fingerprints. Retain independent key custody for multi-computer disaster recovery.

## Rollback

Keep a promoted volume and its writer epoch when rolling back the application. Restore project contents in an isolated location before publishing replacement ownership. A governance backup that would reactivate a retired Runtime, revert a personal directory to centralized writing, or change an existing project writer is refused.
