---
kind: upgrade-guide
description: "Model policy resolves current account privileges and refreshes effective authorization even when the catalog revision is unchanged."
---

# Refresh model policy after account changes

English | [中文](guide.zh.md)

## Change

Model policy reads current account and membership privileges after admission instead of trusting a cached request role. Withdrawn eligibility refuses projection. Eager and lazy refresh compare effective contents as well as the catalog revision, so account role changes reach the live consumer without a model edit.

Credential-store and file-read errors propagate without rotating the intake bearer or replacing policy. Invalid JSON remains recoverable. Disabled accounts are skipped during refresh; Admin inspection shows no effective access while retaining overrides. Combined role/disable changes stop their Runtime without restarting it.

## Migration

1. Deploy the Gateway using the [existing procedure](../../../../gateway/README.md). No database or Session format migration or new policy JSON field is required.
2. Custom `GatewayModelGovernanceService.policyFor` implementations resolve current eligible account and membership roles. Implement `configurationRevision` for disabled-account inspection; its absence reports503.
3. Keep per-request execution, credential and quota checks. A projected file is not a retained authorization lease.
4. Verify promotion and demotion refresh permissions without changing the model revision, live model calls observe revocation, lookup failure preserves existing policy and intake credentials, and a combined role/disable update stops without starting a replacement. See the [authority decision](../../../../.agents/notes/implemented/bug-fix/2026-10-29-model-policy-authority.md).
