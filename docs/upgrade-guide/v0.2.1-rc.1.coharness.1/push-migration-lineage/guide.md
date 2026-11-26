---
kind: upgrade-guide
description: Installations that recorded the push migrations as versions 130 and 131 require a coordinated apply before activation.
---
# PostgreSQL push ledger upgrade

English | [中文](guide.zh.md)

## Change

The push-only release records push receipts and UnifiedPush at versions 130 and 131. The combined release uses versions 144 and 145 for the same SQL. Activation requires the combined ledger. Installations already using the combined sequence can continue with their standard upgrade procedure.

## Migration

1. Use the installed push-only release to enter maintenance and confirm writer convergence. Retain a verified pre-upgrade governance backup and its matching release.
2. In the candidate checkout, run `npm --prefix gateway run pg:deploy -- status` against the same governance database. Confirm `migration_relocations=130->144,131->145` or `migration_relocations=130->144` if only 130 was applied.
3. Run `npm --prefix gateway run pg:deploy -- apply` from the candidate in the same maintenance window. The apply output records the relocated entries separately from the SQL it ran. If the push ledger upgrade fails, keep the deployment in maintenance while investigating.
4. Run status again and confirm that neither pending migrations nor relocations remain. Activate the candidate through the [deployment procedure](../../../../gateway/deploy/README.md) and verify the registered devices and receipt history before reopening traffic. A pre-upgrade archive requires the matching release for recovery. Use the [restore schema checks](../restore-schema-preflight/guide.md) for archive eligibility.
