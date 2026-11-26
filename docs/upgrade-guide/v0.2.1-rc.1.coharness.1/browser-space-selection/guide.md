---
kind: upgrade-guide
description: Authenticated Gateway pages restore only tab-local selections qualified by account and exact Runtime.
---

# Browser space selection

English | [中文](guide.zh.md)

## Change

Authenticated Gateway pages use `dsh.sessions.current.v3.<accountId>.<runtimeId>.<target>` in this tab’s session storage, where `<target>` is `personal` or `project-<projectId>`. Records in local storage under `dsh.sessions.current` or `dsh.sessions.current.v2.<accountId>.<target>` remain stored but are not adopted: they cannot identify which computer or tab selected a raw Session ID. A missing exact Runtime or saved tab record uses normal history-first selection. Standalone pages and explicit transports retain their existing behavior. Session logs, files, drafts and Workbench layouts are unaffected.

## Migration

1. Upgrade Gateway and client assets together so the authenticated document supplies its exact Runtime identity. Select the desired conversation once in each open tab if it has no saved tab record.
2. Select different conversations in two tabs on one Runtime, and open another computer in a third tab. Reload each tab and confirm it retains its own target and conversation.

No server data migration or browser-storage cleanup is required.
