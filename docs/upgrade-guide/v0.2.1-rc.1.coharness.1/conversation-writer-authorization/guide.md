---
kind: upgrade-guide
description: "Conversation persistence rejects revoked writers with HTTP 403 after database lock waits."
---

# Conversation writes require current authority after waits

English | [中文](guide.zh.md)

## Change

Project conversation materialization and attributed message persistence recheck current organization membership and project mode after waiting for database locks. Requests paused during member removal, administrator demotion or read-only downgrade are rejected with HTTP 403. Earlier requests could commit with stale authority or report an internal error. Steward interaction claims and persistence also require the current administrator role and enabled qualification after waiting.

Browser child catalog, prompt and interrupt requests also retain their authorizing collaboration provider. Withdrawal refuses pending reads and delivery before inbox acceptance with `collaboration-forbidden` and reason `gateway-unavailable`; a newly loaded provider authorizes only fresh requests. Already accepted messages continue independently.

## Migration

1. Deploy the Gateway through the existing [deployment procedure](../../../../gateway/README.md). Existing conversations retain their format and data.
2. Custom persistence clients must handle HTTP 403 as a permission denial: refresh scope access before retrying. An uncommitted batch remains absent; its search and contribution rows roll back with its events.
3. Verify that a current writer can persist a message, then confirm a removed or read-only account cannot add events. See the [collaboration decision](../../../../.agents/notes/implemented/feature/2026-08-15-project-collaborative-conversations.md).
