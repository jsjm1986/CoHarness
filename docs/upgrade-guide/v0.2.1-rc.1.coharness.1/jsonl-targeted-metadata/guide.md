---
kind: upgrade-guide
description: "JSONL metadata reads propagate the selected artifact's generation and identity refusals instead of filtering it through a session list."
---

# JSONL single-session metadata refusal

English | [中文](guide.zh.md)

## Change

`dsh-session-persistence-jsonl` implements `readHeader(id)`, `revision(id)`, and `readRevision(id)` through its targeted `stat(id)` operation. These reads previously inherited a full-list fallback that could omit an unsupported artifact. They now propagate the selected artifact's generation, identity, encoding, and decoding errors exactly as `stat` does. A missing session still returns `undefined`; an unsupported highest generation never falls back to an older file. Metadata reads do not inspect event bodies or change committed files.

## Migration

1. Custom persistence consumers must handle rejection from these three methods as they already handle rejection from `stat`. Treat `undefined` as absence, and preserve refusal instead of creating a replacement session over an unreadable artifact.
2. Keep the configured JSONL compression mode matched to its root. If a target uses a newer format, read it with a release that supports that generation; do not rename or delete committed generations to force an older reader.
3. In an isolated copy, confirm that a valid id returns metadata, a missing id returns `undefined`, and an unsupported target rejects without changing its files. No schema migration, configuration change, or log rewrite is required. The [package reference](../../../../packages/session/session-persistence-jsonl/README.md#durability-and-crash-semantics) describes lookup and cancellation.
