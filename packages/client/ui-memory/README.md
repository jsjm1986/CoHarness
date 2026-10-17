---
description: "Durable memory browser and settings card: scoped entries the member can read, search, and edit"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-memory

English | [中文](README.zh.md)

Memory browser plugin, browser half: a `main` page reached through a `sidebar.panellist` entry that lists durable memory entries by scope and kind. The page reads the `memory/*` Remote API (`ctx.remote.memory`): `memory/scopes` returns the scopes the runtime offers — personal plus non-empty workspace scopes in a personal runtime, the shared project scope in a project runtime — each with a live entry count and a per-caller `writable` flag, and `memory/list` returns the selected scope's entries. The service reports `enabled` from the `memory` settings section, so the page can explain why every `writable` flag is down while stored entries stay inspectable.

Rows group by `kind` in catalog order (`guidance`, `profile`, `background`, `resource`) and carry the entry's update time, writer source, member id, short revision, and a preview that expands to the full Markdown body. Client-side search filters on key, summary, and content. Entries attributed to an agent write link to the source conversation through `uiWorkspace.openSession`, gated by the same Session/Workspace feed membership the Schedule page uses. Create, edit, and delete controls render only while the selected scope reports `writable`; the editor fences edits and deletes on the entry's `revision` so a concurrent change surfaces as `memory_stale`. A `memory/changed` forwarded event and every accepted write re-read the catalog and the open scope; an unmounted page holds no Remote subscription.

A `plugins.item` card binds the `memory` settings namespace through `ctx.settingsScope` and offers the section's only switch, `enabled`, which hides the scopes from agents and refuses every write while the stored entries stay readable.

The `/client` exports are the plugin body (`apply`/`inject`), the source factory and snapshot types, the card controller, and the injected faces.

## Summary

The Web GUI gains a Memory page where a member browses, searches, and — where the service reports the scope writable — edits durable memory in both personal and project spaces, plus a Plugins-page card that switches the whole feature off.

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
