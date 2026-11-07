---
kind: upgrade-guide
description: "Project manager writes using revoked authority return403 instead of committing."
---

# Upgrade project management authority

English | [中文](guide.zh.md)

## Change

Project name, theme, Provider and credential mutations authorize the authenticated actor inside their database transaction. Ownership or account changes after an earlier browser check cannot authorize a new write. Already retained database mutations finish before a conflicting role change commits. Model discovery checks credential preparation under the same authority and releases the transaction before its HTTP catalog probe.

Administrator membership overrides also recheck the current active administrator role inside their write transaction. Demotion or account disablement after an earlier HTTP check cannot authorize these overrides, even when the account owns the project. Administrator permission denials return403, preserve project data and record a failed attempt.

## Migration

Upgrade the complete Gateway build, including its PostgreSQL authority helper. Database schemas, project data and browser request fields are unchanged. Custom service consumers pass the authenticated account id to manager mutations, membership overrides and discovery preparation; omitting it is reserved for trusted internal maintenance. A browser-provided actor id does not supply authentication.

Reopen project settings after a403 response to refresh current ownership and capabilities. Verify that the current owner can update the project and that a previous owner cannot change its data or credentials. See the [Gateway management rules](../../../../gateway/README.md).
