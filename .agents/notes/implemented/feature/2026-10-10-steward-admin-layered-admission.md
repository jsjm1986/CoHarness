# Agent Note: Steward admission layers the grant on administrator membership

Status: implemented

English | [中文](2026-10-10-steward-admin-layered-admission.zh.md)

## Problem

The steward space ships privileges beyond an organization administrator's: a resident runtime, an audited SQL channel into the deployment database, and read access over the deployment tree. Admitting on the qualification lane alone meant the lane — not the role — was the only gate; it also silently produced dead grants, because a qualified non-administrator passed scope admission yet failed execution writes that require a project member row, which the steward space never carries. Steward admission needs to be visibly stronger than administrator status, not just different.

## Decision

One predicate decides every steward entry point: an active organization membership with `role='admin'` **and** an enabled `steward_access_policies` row for the Runtime computer. This reverses the lane-alone decision in [the steward maintenance-space note](2026-10-10-steward-maintenance-space.md).

- **The same predicate covers every path.** Scope admission, conversation read/write, `claimInteraction`, `readableSessionIds`, member-facing document metadata and mutations, and the `steward_query` write-approval responder check all evaluate administrator membership plus the enabled grant, so a direct database write or a stale row cannot elevate anyone. Document transactions recheck qualification after catalog waits; the [document lifecycle decision](../architecture/2026-08-27-document-index-pagination-and-trash-lifecycle.md) owns their rollback limits.
- **Grant writes reject a non-administrator inside the policy transaction.** `ResourceAccess.set` gained a lane hook (`checkEnabledOwner`) invoked after the owner row locks; `StewardAccess` overrides it to require an active administrator membership, returning 409 otherwise. Revocation skips the hook, so a stale or post-downgrade row can always be cleared.
- **Downgrade is revocation.** Read-time role re-evaluation means demoting an administrator to member ends steward admission at once, and the existing access-invalidation broadcast cuts in-flight sessions; the grant row may persist harmlessly as a stale row the admin surface can clear.
- **Migration 052 removes dead rows.** Historical grants for non-administrators were never usable; deleting them keeps the table to grants that can take effect, and each delete fires the access-invalidation trigger.
- **The lane is managed, not hidden.** `GET /admin/api/steward` exposes feature state, space/runtime facts, and every member's grantable/qualified/effective state; the `/admin/steward` page and the per-user qualification card make the layered rule legible — grants are offered only to administrators, while stale rows stay revocable.

Interaction claims and visibility changes recheck the active project, current administrator role and enabled qualification after acquiring the conversation and account locks. Qualification writers hold the account update lock, so the reader’s account share lock preserves that decision until commit. Steward conversation materialization and attributed persistence apply the same administrator-plus-qualification predicate. Lock-controlled HTTP regressions cover qualification revocation and role downgrade without persisting a response or admitting a new conversation.

## Alternatives considered

**Keep the lane alone and open execution to non-members.** Rejected: letting qualified non-administrators write steward sessions would have widened the execution-actor check with a steward exception — more privilege surface for less trust, opposite of the goal.

**A maintainer-style lane independent of administrator role.** Rejected for v1: anyone grantable requires the same non-member execution widening above, and the deployment posture wants stewards to already be administrators.

## Consequences

The steward space is an administrator-only channel by construction. Granting requires promotion first, which the admin UI states in place; a member holding a leftover row reads as an ineffective grant until cleared. Session execution checks the grant for every captured actor after locking the accounts. Signed-principal and Session resource requests use current eligibility when registering and polling for a grant.
