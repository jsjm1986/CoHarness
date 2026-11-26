---
kind: upgrade-guide
description: The opt-in SQLite Session store refuses creation with a managed SSH target.
---
# Managed SSH targets and SQLite Session storage

English | [中文](guide.zh.md)

## Change

An opt-in SQLite Session store lacks a field for the managed SSH target. Session creation now rejects such a header before making it available for execution or reopening.

## Migration

1. Keep existing SQLite files for their local Sessions. A missing target in an old record cannot identify the original SSH host.
2. Use the deployment’s JSONL or Gateway persistence to create a new SSH-bound Session. Verify the selected SSH target after reopening the Session.
