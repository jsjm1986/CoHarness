---
kind: upgrade-guide
description: "Conversation search and progress preserve NUL text through migration100 and versioned query projections."
---

# Upgrade lossless conversation text

English | [中文](guide.zh.md)

## Change

PostgreSQL migration100 adds a lossless NUL representation to live and archive search indexes, plus derived event query fields. Message append, history previews, literal search, shared activity and progress accept NUL without changing original events. Progress requests, request Sessions and digest content use native json. HTTP response fields and released Session formats remain unchanged.

## Migration

1. Stop every Gateway sharing the database and retain a restore-checked backup. Deploy matching Gateway code and migration files together. Startup or `pnpm --dir gateway run pg:migrate` runs the SQL and version-one JavaScript backfill in one transaction; executing the SQL file alone does not complete the migration. Older writers cannot supply the required query fields. Do not run them against the upgraded database or downgrade it.
2. Allow the migration to hold its exclusive table lock until backfill and validation finish. A failed batch rolls back version100 and is safe to retry with the same payload. Original event bytes, legacy Runtime assignments, migration predecessors and ordinary search values remain preserved.
3. Custom SQL index readers reconstruct original content with `harness.conversation_search_text(content,content_nul_parts)`, optionally passing a code-point preview length. `content` alone is a trigram cache for NUL-bearing rows. Custom event writers use the versioned query projection; projection changes require a forward data migration. Read progress JSON directly rather than converting an entire row or request Session to jsonb.
4. Verify a NUL-bearing user, assistant and tool message through append and readback. Search both actual NUL and the distinct literal escape. Confirm that member activity, question context, digest citations and persisted request Sessions retain the original text, usage remains on the owning node, and repeated scans add no model call. See the [Gateway reference](../../../../gateway/README.md) and [decision record](../../../../.agents/notes/implemented/architecture/2026-10-30-conversation-nul-search-and-query-fields.md).
