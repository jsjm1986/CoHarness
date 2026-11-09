# Agent Note: Project metadata publication uses current read authority

Status: implemented

English | [中文](2026-11-05-project-read-publication.zh.md)

## Problem

Project metadata preparation and permission reads can finish at different times. A prepared directory retained projects after membership withdrawal, while a login role or previously loaded owner could keep `canManage` true after demotion or ownership transfer. Prepared invitation lists also retained invitations between other accounts after management was withdrawn.

## Decision

After metadata preparation, browser directory, detail and configuration reads obtain current project authority from one PostgreSQL snapshot. It checks account, password requirement, organization membership, project, mount, exact computer permission and Steward qualification without loading node metadata. Publication requires the same computer selected during preparation. Returned ownership, theme and management flags come from that snapshot. Configuration capabilities use the same current authority; reserved Steward spaces never advertise member management.

Prepared computer identifiers are request-owned values even when adapters refresh their cached views during a read. Project invitation lists use the same final project admission. Current managers may see all prepared invitations; other eligible members receive only invitations they sent or received. Reading never consumes pending invitations.

Account-wide invitation history and pending counts require the current browser session after preparation, including session expiry, logout and password qualification. Participant history belongs to the account and survives project membership or computer-use withdrawal. Invitations between other accounts require current project management; current login role also limits implicit administrator authority. The final management read uses control-database facts without loading node metadata. Recipient-only history needs no project read provider.

Usage summaries retain the billing owner and computer selected before preparation. Current browser qualification is required for personal and project summaries; project reads also require current membership and exact-computer authority. Readonly members remain eligible. The final personal-summary check requires account eligibility; initial Runtime selection keeps its existing authority rules. A refused project read never substitutes personal totals. Invalid month input is refused before reading usage.

Withdrawn directory entries are omitted; a withdrawn detail returns HTTP 403. Account qualification withdrawal refuses the directory response. A missing custom read provider returns HTTP 501 and a failed authority lookup returns HTTP 503 without prepared data or database diagnostics. Runtime authorization retains its separate credential and execution rules; browser password qualification does not replace those rules.

## Alternatives considered

**Reload complete project details to authorize publication.** Node metadata loading adds I/O and another interval in which permissions can change. The final authorization read needs only control-database facts.

**Derive capabilities from the login role or prepared owner.** Both values can predate the ownership and membership changes that determine current authority.

## Consequences

Custom collaboration adapters implement `projectReadAuthorities(userId, projectId?)` for browser project reads and manager-visible account invitation history. Project and Session formats remain unchanged. The [project settings decision](../feature/2026-08-28-project-scoped-settings-management.md) continues to own settings presentation and mutation admission.
