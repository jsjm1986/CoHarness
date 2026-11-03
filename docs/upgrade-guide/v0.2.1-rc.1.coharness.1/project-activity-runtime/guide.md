---
kind: upgrade-guide
description: "Project activity requests and conversation links retain their owning Runtime."
---

# Upgrade project activity Runtime addressing

English | [中文](guide.zh.md)

Project activity and progress use the Runtime of the Session containing the panel. Switching the selected Session or changing another browser tab’s scope cookie cannot redirect that panel’s reads, generation request or conversation links. A project Session offers the activity entry even when the page opened in personal scope. The [activity package](../../../../packages/client/ui-project-activity/README.md) describes current behavior.

Activity grouping retains one conversation or member through renames and keeps distinct IDs separate.

Restart services using the updated deployment payload and reload existing browser pages. Existing Session data and database schemas require no migration. Direct consumers of the source-level fetch helpers pass the owning Runtime explicitly; standalone calls pass `undefined`.
