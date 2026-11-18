---
kind: upgrade-guide
description: "New sessions write format v7; builds older than this release refuse to open them."
---

# Session log format v7

English | [中文](guide.zh.md)

## Change

The Session writer now emits format version 7. The reader migrates every committed earlier generation (v0–v6) forward on open, so existing sessions keep working after the upgrade. The opposite direction refuses: a build older than this release opens a v7 Session file, names it newer than its own writer, and fails with `SessionFormatUnsupportedMigrationError` instead of loading partial state. Older releases' committed session files are never moved, overwritten, or deleted — each generation stays beside its successors.

## Migration

1. Upgrade every deployment and workstation that reads shared Session storage before running this release; after any v7 session exists, older builds can no longer open it.
2. If a rollback is needed, run the older build against session data last written before the upgrade, or export needed content first (session ZIP export) while the new build still opens everything.
3. Confirm a session opens: `dsh session list` renders sessions recorded before and after the upgrade without `SessionFormatUnsupportedMigrationError`.
