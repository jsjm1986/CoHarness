---
kind: upgrade-guide
description: "Account usage reads refuse withdrawn browser or project authority and reject invalid months."
---

# Upgrade account usage reads

English | [中文](guide.zh.md)

## Change

`GET /account/api/usage` rechecks the browser session after preparing the selected account or project summary. Logout, expiry, required password changes and account or organization withdrawal return403 without usage or quota data.

Project summaries additionally require current project membership, mount, exact computer permission and Steward qualification. Ownership transfer or administrator demotion permits continued reads when ordinary membership remains eligible. Personal summary publication requires current account eligibility; initial Runtime selection retains its existing authorization rules. A refused project read never switches to personal billing data.

An explicit `month` must use four-digit `YYYY-MM` with a month from01 through12. Empty or invalid values return400 with `invalid-month`.

## Migration

Deploy the complete Gateway build. Database schemas, billing totals and request fields remain unchanged.

Custom collaboration adapters provide `projectReadAuthorities(userId, projectId?)` without node metadata I/O. Return the selected project's current authority and preserve its `nodeId` when an organization directory supplies the selected computer. Missing providers return501; failed reads return503 without prepared data or database diagnostics. Personal summaries require no collaboration adapter.

Refresh account or project access after403. Verify that a readonly member can read the project's summary, an account removed during preparation receives no summary, and personal totals remain attributed to that account. See the [Gateway rules](../../../../gateway/README.md).
