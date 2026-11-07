---
kind: upgrade-guide
description: "Document roots and names reject private filesystem aliases and reserve the provider staging pattern."
---

# Document roots and private names

English | [中文](guide.zh.md)

## Change

The local document provider lists ordinary completed `.part` documents. Its `.userdoc-<24 hexadecimal characters>.part` staging pattern is reserved: a new upload with that name receives the normal numeric suffix, and public reads cannot select staging files.

Root maintenance names `.upload-sessions` and `.dsh-trash` are reserved across case and Windows trailing-period/space aliases. Public traversal also refuses another spelling of the actual private directory object. A document root must be a real directory. Newly resolved file and folder names strip trailing ASCII periods and spaces before and after byte truncation. Existing files and Session generations are not renamed or rewritten.

## Migration

1. Stop document writers and retain a backup of the configured `uploadRoot` before renaming existing entries.
2. If `uploadRoot` is a directory link, configure the provider with its real directory and retain the existing contents and filesystem permissions. Keep that directory within the model's authorized filesystem roots.
3. Inspect user-owned root entries that match a maintenance alias, and user files matching `.userdoc-<24 hexadecimal characters>.part`. Rename those user entries to ordinary names through the filesystem. Keep actual upload-session and trash directories intact; preserve unknown temporary files for inspection rather than deleting by suffix.
4. Start the provider and confirm that an ordinary `archive.part` upload appears in both recursive and folder listings and can be read. Confirm that maintenance aliases are refused and that a staging-pattern upload receives a visible suffixed name.

The [private-path decision](../../../../.agents/notes/implemented/architecture/2026-10-26-document-private-paths-and-staging-names.md) records the checks. Durable incarnation and catalog migration remain separate work.
