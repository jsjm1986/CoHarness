---
kind: upgrade-guide
description: "Runtime reporting credentials verify their own Session execution witnesses before account billing."
---

# Upgrade Runtime usage attribution

English | [中文](guide.zh.md)

## Change

A Runtime-specific model reporting credential retains its durable `RuntimeId` through usage validation. Supplied execution witnesses must belong to a Session recorded under that same Runtime. Another Runtime on the same computer or another computer cannot reuse those witnesses, even when both runtimes belong to one account. Event-body identity fields cannot replace the authenticated reporting identity. The usage endpoint returns400 for mismatched execution proof and stores no charge for that report.

Personal bills remain account-wide; project bills and contributor attribution retain their existing owners. Valid delayed usage from the original Runtime remains accepted after account eligibility or computer permission is withdrawn. Legacy owner-only reporting resolves one Runtime from immutable input IDs and rejects mixed Runtime witnesses. PostgreSQL migration 096 includes Runtime identity in Session, input, relay, scope and desktop-confirmation records, allowing equal original Host Session IDs in independent Runtimes. Backfill preserves recorded ownership; unassigned history stays independent. Reporting token files and released Session generations are unchanged.

Resource scope selection also uses the exact authenticated Runtime. An immutable scope created under an equal Host Session ID in another Runtime cannot block a valid legacy accumulated request or its queue polling. A Session with its own immutable scopes still requires its own scope reference; foreign scopes remain refused. This correction requires no further data rewrite.

## Migration

1. Stop every Gateway sharing the database, retain a restore-checked backup, and upgrade all of them together, including managed-computer Gateways. Apply migration 096 with the matching release before accepting traffic; do not run older writers against the migrated database.
2. Keep Runtime-specific reporting token files with their owning Runtime. For a rejected report, inspect its actual Session and the captured input’s source; do not remove proof fields to obtain acceptance.
3. Verify independent registration using the same Host Session ID in two personal Runtimes, ordinary reporting, refusal when one submits the other's witnesses, shared account totals and valid delayed reporting after revocation. See the [Gateway reference](../../../../gateway/README.md).
