---
description: "Settings section administering remote-desktop grants: issue, change level, revoke, and audit."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-remote-desktop-admin

English | [中文](README.zh.md)

## Summary

Adds a **Remote desktop** section to Settings where an administrator issues grants, changes levels, revokes grants, and reviews the capability's audit events. Non-administrators see only their own rows — the controller enforces the same scoping, so the section renders without role checks.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Compose this plugin in the Web profile; it registers a `settings.section` entry ordered after the built-in sections. Open Settings → **Remote desktop** to manage grants.

The issue form takes the target `nodeId` (and optional `desktop`), the principal to authorize, the level, the scope — a durable machine grant or a session grant that requires an expiry — and the recording flag. Each row's actions change its level or revoke it; **Show revoked** lists historical rows. The audit tail renders consent, grant, revoke, level-change, attach, and detach events newest-first.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The section's React-free controller (`admin-store.ts`) owns the snapshot store and calls `ctx.remoteDesktops` with the caller's currently selected Session id — the Remote namespace derives caller identity from that Session's verified creator, so no principal is accepted from the UI. All writes refresh the grant rows afterwards; abort signals cancel reads on unmount. Administrator authority itself is enforced server-side; a non-administrator sees their own rows and `remote-desktop/forbidden` on management writes.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Remote-desktop capability](../../remote-desktop/remote-desktop/README.md)
- [Remote-desktop BFF](../../api/remote-desktop-controller/README.md)
- [Remote-desktop tabs](../ui-remote-desktop/README.md)

<a id="model-experience"></a>
## Model Experience

This package is a human-facing Client UI; it contributes nothing to prompts, tools, or the model context.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Administration binds to the currently selected Session; with no Session selected the section reports that one is required instead of guessing authority.
- The audit tail is not paginated; deployments relying on large durable audit files read them through the capability's tail capacity.
