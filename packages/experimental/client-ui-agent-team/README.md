---
description: "Use and debug the experimental Web Agent Teams mode toggle, roster, shared task board, and teammate navigation panel."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-agent-team

English | [中文](README.zh.md)

## Summary

This package adds an Agent Teams action to the Web conversation header, where a user can enable or disable Team mode for the root Session, inspect the current roster and the shared task board, and navigate into a teammate's conversation. Team state comes from the client `agentTeam` Session projection plus the addressed-subagent member catalog; the only Remote call is `agentTeams/setEnabled`, which flips the durable root Session selection. Choose it through the published experimental Agent Teams Web profile. The browser projection does not extend the stable API Proxy, store Team state, or register model-facing input.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Enable this package through [`@deepseek-ai/dsh-experimental-agent-team-profile`](../agent-team-profile/README.md), which supplies the Team service, tools, and Web UI together. The Web Client loader mounts the `/client` export; the root Host export is inert, and the package has no user configuration fields.

### Inspect and navigate the roster

The panel renders `useProjection('agentTeam')` for mode and tasks, and the direct-child catalog for member rows: durable names and runtime activity, with the Lead pinned as the first row. Selecting a teammate opens the ordinary `{ parentSessionId, childSessionId, mode: 'continuable' }` address. History and later human prompts continue through the stable addressed-subagent conversation path; this package adds no Team-specific address field. The action renders only on root Sessions — addressed or listed child conversations return null.

### Toggle Team mode

The trigger's mode control calls `agentTeams.setEnabled` for the current root Session. Enabling a Session that already ran without Team mode and disabling a Session with live teammates both ask for confirmation, because each flips a durable `team/mode` record that outlives the click. Remote failures surface inside the panel instead of closing it.

### Inspect the task board

The task board shows task identity, owner, blockers, readiness, advisory write scopes, and overlap warnings. It is read-only; agents mutate tasks through the Team tools while the panel renders the resulting view.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Client export mounts the generated `ctx.remote.agentTeams` contribution from [`@deepseek-ai/dsh-experimental-agent-team/remote`](../agent-team/README.md), then registers its locale dictionaries and one conversation-header slot through Cordis effects. Disposing the plugin fiber removes both registrations.

A session switch closes the panel and discards any in-flight mode change for the previous session; the projection and catalog keep every other row current without a panel-level refresh.

The panel renders through a portal anchored to the trigger's right edge by `useAnchoredPosition`, which clamps it inside the viewport on every size. Hover opens it after a short delay with a trigger-to-panel crossing grace, a click pins it, and it dismisses on an outside pointer, Escape, or the toolbar close button; pinning focuses the panel and Escape returns focus to the trigger. When the header container collapses the trigger label to its icon, only click opens. Selecting a roster member navigates to that session; the current member is tagged and inert.

| File | Role |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | Generated Remote, locale, navigation, and slot registrations |
| [`src/client/TeamAction.tsx`](src/client/TeamAction.tsx) | Roster and task-board render state |
| [`src/client/locales.ts`](src/client/locales.ts) | English and Chinese panel copy |
| [`src/index.ts`](src/index.ts) | Inert Host entry |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Agent Teams bundle](../agent-team-profile/README.md) — the published opt-in bundle that mounts this Client plugin.
- [Agent Teams service](../agent-team/README.md) — authoritative roster, task, and Remote behavior.
- [Conversation UI](../../client/ui-conversation/README.md) — the stable header slot and addressed-subagent navigation surface.
- [Experimental packages](../README.md) — incubation status and publication policy.

-----

<a id="model-experience"></a>
## Model Experience

None, as this browser projection registers no model-facing input.

#### KV Cache effect

No direct effect; the Team tools and ordinary conversation submission own any later model-visible use.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Ordinary child continuation** — a human message sent after navigation uses the stable addressed-subagent prompt path; the panel adds no Team-specific message surface.
- **No lifecycle or workspace controls** — the panel cannot spawn, rename, delete, or interrupt teammates, cannot edit tasks, and write scopes remain advisory metadata.
- **Root-only action** — the trigger hides on addressed or listed child Sessions; teammate-side views do not exist.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
