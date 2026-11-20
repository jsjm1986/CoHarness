---
description: "Durable memory browser and settings card: scoped entries the member can read, search, and edit"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-memory

English | [中文](README.zh.md)

Memory browser plugin, browser half: a right-Sidebar `memory` tab type registered through `sidebarRightTabs`, opened from its guide entry, that lists durable memory entries on a day-grouped timeline. The tab reads the `memory/*` Remote API (`ctx.remote.memory`): `memory/scopes` returns the scopes the runtime offers — personal plus non-empty workspace scopes in a personal runtime, the shared project scope in a project runtime — each with a live entry count and a per-caller `writable` flag, and `memory/list` returns the selected scope's entries. On the first catalog load the tab prefers the workspace scope whose `directory` equals the on-screen Session's `cwd`, so the panel opens on the context the Agent writes into; a later manual selection survives catalog refreshes. The service reports `enabled` from the `memory` settings section, so the tab can explain why every `writable` flag is down while stored entries stay inspectable.

Entries group by local update day (newest first) and carry the entry's time, writer source, member id, kind badge, and an expansion that reveals the update timestamp, short revision, and the full Markdown body. The entry disclosure is a keyboard-operable button whose expanded state is exposed to assistive technology. Client-side search filters on key, summary, and content; search and editor controls have programmatic labels, with key and summary hints attached as descriptions. Compact and coarse-pointer controls retain 44px action targets and at least 16px input text. Entry actions and error messages use readable primary text over the expanded card; colored underlines distinguish ordinary and destructive actions. Kind badges pair primary text with their category tint in both themes. Native selectors grow with their text while keeping the system picker. Enabled Kind and Content fields share the Input control’s visible border treatment; disabled fields retain a subdued boundary. A narrow pane places the scope selector above the search and actions so the query remains readable. Short panes keep the selector and search on one row with compact timeline spacing, leaving the first entry visible while retaining the query’s minimum width. The feed retains enough height to show a full entry while extra toolbar or notice content scrolls with the outer pane. Short dock panes scroll the toolbar, editor, and footer together; compact feedback spacing keeps an empty search result visible, and the disabled notice precedes the controls. The content field fits the pane’s available height without resetting its draft. Entries attributed to an agent write link to the source conversation through `uiWorkspace.openSession`, gated by the same Session/Workspace feed membership the Schedule page uses. Create, edit, and delete controls render only while the selected scope reports `writable`; the editor fences edits and deletes on the entry's `revision` so a concurrent change surfaces as `memory_stale`. A refused or failed delete keeps the entry and any editor draft visible, announces the error, and permits a deliberate retry; pending writes disable duplicate actions. Timeline deletion keeps Delete and Cancel together when actions wrap. Cancel returns focus to the entry disclosure; cancelling or toggling the disclosure clears its confirmation and failure message. A `memory/changed` forwarded event and every accepted write re-read the catalog and the open scope; an unsubscribed tab holds no Remote subscription.

A `plugins.item` card binds the `memory` settings namespace through `ctx.settingsScope` and offers the section's only switch, `enabled`, which hides the scopes from agents and refuses every write while the stored entries stay readable. A pending change displays and announces “Saving…”; a refused write retains the saved setting and announces its inline retry message.

The `/client` exports are the plugin body (`apply`/`inject`), the source factory and snapshot types, the card controller, and the injected faces.

## Summary

The Web GUI gains a Memory right-Sidebar tab where a member browses, searches, and — where the service reports the scope writable — edits durable memory in both personal and project spaces, plus a Plugins-page card that switches the whole feature off.

The tab captures its conversation’s Runtime for scope discovery, reads, writes and source-conversation links. Its configuration card keeps the document’s bootstrap settings owner. Another computer’s invalidations cannot retarget the tab.

## Table of Contents

- [Invariants](#invariants)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="invariants"></a>
## Invariants

**Runtime invariant:** No companion is published. Entries, writability, and the enabled flag are owned by the Host's `memory` service and mirrored through Remote reads; the plugin owns no business state.

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser surface over the memory service that adds nothing to a model request; the agent-facing catalog and tools ship with the memory service itself.

#### KV Cache effect

None — the plugin performs no model-visible operation.

## Known Limitations and Deferred Work

- **Client-side search** — the page filters the listed scope's entries locally; a Remote `memory/search` over all scopes is deferred.
- **No pagination** — a scope renders every entry at once, bounded by the service's per-scope entry cap.
- **Editor is single-entry** — there is no bulk edit, import, or export surface.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
