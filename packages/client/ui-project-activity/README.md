---
description: "Shared-project activity feed: member messages and chosen answers in the right Sidebar"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-project-activity

English | [中文](README.zh.md)

Project activity plugin, browser half: a right-Sidebar tab type (`activity`) that lists what members of the shared project sent and chose — attributed `user/message` rows and `ask_user_question` answers (question plus the selected option) — read from the account-scoped `GET /account/api/activity` page with same-origin credentials. The feed is newest-first keyset-paginated; the panel switches between three folded reading views through a segmented control — `time` folds rows into one collapsible section per day (today open by default) with single-line summaries that expand an inline detail card, `conversation` folds each conversation into a digest block whose header line prefers the newest answer, and `member` folds each member into a digest block listing their choices before their messages — and offers a member filter plus refresh and load-earlier paging. Rows open their conversation through `conversationViewport.reveal(sessionId, seq)` — `replaceActive` when a row carries no anchor — so a member lands on the exact logged event.

The tab type registers only while `projectUiPolicy` reports project scope: the apply body subscribes to the policy snapshot and mounts or disposes the `sidebarRightTabs` definition on each transition, so the guide capsule and any open tab leave with the scope. The keyed `sidebar.right.pane.tab` body and `sidebar.right.pane.tab.title` seats stay mounted permanently — without a live type they dispatch nothing. View state (pages, grouping, member filter) lives in a session-scoped store declared on the body registration; the inject face carries `refresh`, `loadMore(before)`, and `reveal` over `ctx`'s viewport service. The Host half is inert: the plugin mounts through the Client loader only.

The `/client` exports are the plugin body (`apply`/`inject`), the feed wire types, the store factory and state types, and the injected face.

## Summary

The Web GUI gains a project activity tab showing what each member sent and which answers they picked, grouped by time, conversation, or member, filterable per member, and linked to the exact conversation event. It appears only in the shared-project scope and reads an existing Gateway route — no new data stream is created.

## Table of Contents

- [Invariants](#invariants)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="invariants"></a>
## Invariants

**Runtime invariant:** No companion is published. The feed is derived by the Gateway route from durable conversation data; the plugin owns a view-state store only.

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side read-only projection of member messages and chosen answers that adds nothing to a model request.

#### KV Cache effect

None — the plugin performs no model-visible operation.

## Known Limitations and Deferred Work

- **Human rows only** — the feed lists member messages and picked answers; automatic jobs, webhook turns, permission-mode changes, and approval execution logs are excluded by design. Approval rows need a different reader question and remain deferred.
- **No read position** — a per-member "last seen" marker is deferred; there is no unread state or notification surface.
- **Pre-link answers lack anchors** — answers claimed before `call_id` persistence (migration 056) render without the question text and do not navigate to the result frame.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
