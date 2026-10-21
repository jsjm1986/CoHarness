---
description: "Shared-project activity feed: member messages and chosen answers in the right Sidebar"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-project-activity

English | [中文](README.zh.md)

Project activity plugin, browser half: a right-Sidebar tab type (`activity`) that answers "what changed in this project" for a returning member. Its default mode renders the human-facing **progress journal** — the Gateway's AI digest over shared-visible member activity, served through `GET /account/api/progress` — as a rolling "current progress" summary plus folded period entries whose `decided` / `done` / `doing` / `blocked` items attribute back to member and conversation; a status line reports undigested activity and offers a manual `POST /account/api/progress/generate` pass whose landing the panel polls. The three raw reading views remain one segment over: `time` folds the `GET /account/api/activity` rows into one collapsible section per day, `conversation` folds each conversation into a digest block whose header line prefers the newest answer, and `member` folds each member into a digest block listing their choices before their messages. The feed itself is newest-first keyset-paginated with a member filter; rows and journal attributions open their conversation through `conversationViewport.reveal(sessionId, seq)` — `replaceActive` when a row carries no anchor — so a member lands on the exact logged event.

The tab type registers only while `projectUiPolicy` reports project scope: the apply body subscribes to the policy snapshot and mounts or disposes the `sidebarRightTabs` definition on each transition, so the guide capsule and any open tab leave with the scope. The keyed `sidebar.right.pane.tab` body and `sidebar.right.pane.tab.title` seats stay mounted permanently — without a live type they dispatch nothing. View state (pages, mode, member filter, journal page) lives in a session-scoped store declared on the body registration; the inject face carries `refresh`, `loadMore(before)`, `generate`, and `reveal` over `ctx`'s viewport service. A `400`/`404` on the progress route renders as a feature-off page rather than a transport failure, so deployments without the journal service degrade quietly. The Host half is inert: the plugin mounts through the Client loader only.

The `/client` exports are the plugin body (`apply`/`inject`), the feed wire types, the store factory and state types, and the injected face.

## Summary

The Web GUI gains a project activity tab that opens on an AI-written progress journal — a rolling summary plus folded weekly entries attributed to members and conversations — with the raw feed of member messages and chosen answers one segment away, grouped by time, conversation, or member, filterable per member, and linked to the exact conversation event. It appears only in the shared-project scope and reads existing Gateway routes — no new data stream is created.

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
- **Journal needs the Postgres deployment and a model route** — where the progress service is unmounted (non-Postgres deployments, the feature flag off, or no managed model credential), the progress mode renders its unavailable page; the raw feed still works.
- **No read position** — a per-member "last seen" marker is deferred; there is no unread state or notification surface.
- **Pre-link answers lack anchors** — answers claimed before `call_id` persistence (migration 056) render without the question text and do not navigate to the result frame.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
