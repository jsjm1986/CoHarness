---
description: "Shared-project activity feed: member messages and chosen answers in the right Sidebar"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-project-activity

English | [中文](README.zh.md)

Open Project activity in a project Session to catch up on member messages, answers, and progress. A readable AI journal opens in Progress. The Time view opens when the project has no readable journal. Time, Conversation, and Member group the same activity. The member filter lists current project members even when their events are on older pages. Selecting a member starts a new paginated read for that member.

The tab follows the selected Session’s Runtime. An unqualified standalone Session uses the page’s project policy. Feed pages, journal reads, and generation requests retain the owning Runtime when another browser tab changes the scope cookie. An attributed item opens its source Session and reveals its event when a log anchor is available. The Gateway checks access for each request. View state belongs to the Session. The Host half is inert.

Conversation markers use the shared theme palette to identify conversations; their colors do not indicate task status.

The toolbar wraps within the Sidebar. Touch targets reserve at least 44 CSS pixels per axis, while timestamps and digest status use the readable secondary text token. Pointer hover feedback applies only on devices with hover support.

The `/client` exports are the plugin body (`apply`/`inject`), the feed wire types, the store factory and state types, and the injected face.

## Summary

Use the right Sidebar to read project activity and follow its sources. The AI journal presents current progress and weekly decisions, completions, active work, and blockers. Start with the activity timeline whenever the project has no readable journal.

## Table of Contents

- [Invariants](#invariants)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="invariants"></a>
## Invariants

**Runtime invariant:** No companion is published. The feed is derived by the Gateway route from durable conversation data; the plugin owns a view-state store only.

Grouping uses Session and member IDs. A rename keeps the same group. Changing the member filter starts at its newest page. A superseded read cannot publish results after decoding.

Day sections and conversation recency use the viewer’s local calendar. Yesterday is the previous calendar date, including across daylight-saving transitions. The panel observes a running digest while its body is visible. If observation expires or status cannot be confirmed, Refresh status checks the Gateway again. A temporary read failure leaves the last received journal visible.

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
