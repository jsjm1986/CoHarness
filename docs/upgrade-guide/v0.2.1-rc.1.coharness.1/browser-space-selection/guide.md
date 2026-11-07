---
kind: upgrade-guide
description: Authenticated Gateway pages save the selected conversation separately for each account and Runtime.
---

# Browser space selection

English | [中文](guide.zh.md)

## Change

Authenticated Gateway pages use `dsh.sessions.current.v2.<accountId>.<target>` in browser storage, where `<target>` is `personal` or `project-<projectId>`. The shared `dsh.sessions.current` record remains stored but is not adopted by these pages. On the first visit to each space, the normal history-first selection applies. Standalone pages and explicit transports retain their existing selection key. Session logs, files and Workbench layouts are unaffected.

## Migration

1. Open each personal or project space and select the conversation to restore on future visits.
2. Switch to another space and return. Confirm that each space restores its own selection.

No server data migration or browser-storage cleanup is required.
