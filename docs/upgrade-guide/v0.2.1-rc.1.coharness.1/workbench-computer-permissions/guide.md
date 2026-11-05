---
kind: upgrade-guide
description: "Personal account catalog rows require the computer grant for their own Runtime."
---

# Upgrade workbench computer permissions

English | [中文](guide.zh.md)

## Change

Each personal root in the account workbench catalog requires the current computer use grant for that Session's exact Runtime assignment. Permission on another computer cannot expose its title, working directory or other metadata. This also applies when a personal Runtime cannot list Sessions and the workbench returns database-backed account metadata.

Revoking one computer hides its personal roots while retaining authorized roots on other computers. Other accounts and project conversation rules retain their existing visibility. Unknown or retired Runtime assignments do not establish a current computer grant. An unavailable personal listing keeps its existing incomplete result, so absence is not proof of Session deletion.

All spaces searches the authorized personal and project conversations already loaded in this tab. Choose a specific personal Runtime or project to search further pages. The account Runtime directory accepts `projectId` for a selected project outside the loaded pages. A new workbench pane uses the selected Runtime’s creation receipt and Workspace, while independent selections verify access before opening.

## Migration

1. Upgrade the complete Gateway and Runtime packages together. Apply PostgreSQL migration `104_personal_conversation_catalog.sql`; it adds nullable personal conversation metadata without changing Session generations, files or Runtime identities. Existing running personal Runtimes publish their summaries after restart; stopped Runtimes publish when explicitly started. Reading the chooser never starts them.
2. Confirm that personal roots on two granted computers are visible, revoke one computer and verify that its titles and working directories disappear while the other computer stays usable.
3. Repeat with the personal Runtime unavailable, and verify an independent account's catalog remains isolated. See the [Gateway reference](../../../../gateway/README.md).
