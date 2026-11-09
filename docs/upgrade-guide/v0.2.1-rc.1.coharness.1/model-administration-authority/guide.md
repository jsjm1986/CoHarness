---
kind: upgrade-guide
description: "Model administration with revoked authority or retired targets rejects instead of committing."
---

# Upgrade model administration authority

English | [中文](guide.zh.md)

## Change

Organization Provider, model, credential, access and quota writes recheck the authenticated administrator inside their transaction. A demoted, disabled or deleted actor cannot commit through an earlier HTTP check. Discovery authorizes preparation before reading company credentials or sending a draft-key probe. Its POST read result rechecks current administrator eligibility after the catalog reply; withdrawal returns403 without model metadata. An already admitted probe may finish. Permission refusals return403 with a failed-attempt audit.

Access and quota writes require a nondeleted account or active project. Disabled accounts remain configurable. SQLite stores accepted numeric account quota ids in canonical decimal form, so a zero-padded id applies to the same account on readback. Organization and project model configuration writers use one consistent organization-first lock order.

Quota replacement, inheritance restoration and account deletion retire that account's old numeric aliases. SQLite imports preserve the previously effective canonical quota and report dormant aliases in `skippedQuotaAliases`. Reimport replaces quotas for source accounts, restoring inheritance when no canonical override exists, while PostgreSQL-only accounts retain their limits. The frozen source remains unchanged.

Digest model reads and pin/clear writes also retain the current administrator. Candidates and validation use the owning organization; foreign-only routes reject, while exact offered model ids remain selectable. Selected model and Provider eligibility is retained through commit, and writes return their accepted view.

Shared management [password qualification](../user-administration-authority/guide.md) also applies after authority waits; complete required password changes before retrying queued management.

## Migration

1. Upgrade the complete Gateway build. No database migration or browser request-field change is required.
2. Custom governance adapters forward the authenticated account id through administrative writes and discovery preparation. Preserve transaction-owned authority and target checks; omitting the governance actor is reserved for trusted internal maintenance. Digest services always require the authenticated actor, and pin/clear return the accepted setting and candidates.
3. After a403, refresh the administrator session and current role before retrying. Confirm that the current administrator can save, while withdrawal before discovery preparation changes no settings and sends no request. Withdrawal during an admitted probe withholds the catalog reply. See the [Gateway model rules](../../../../gateway/README.md).
4. Inspect `skippedQuotaAliases` in an import report. Configure any intended replacement through the administrator quota API and verify its readback; another import restores the frozen source's quota configuration. See the [SQLite import reference](../../../../gateway/deploy/postgres/README.md).
