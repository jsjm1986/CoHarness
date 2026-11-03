---
kind: upgrade-guide
description: "Terminal backend disposers now return a promise and cancel unpublished startup on withdrawal."
---

# Await terminal backend withdrawal

English | [中文](guide.zh.md)

## Change

`ctx.terminals.registerBackend()` returns `() => Promise<void>`. Explicit withdrawal cancels that registration's unpublished startup with `NO_BACKEND` and waits for its setup and rollback. Its promise rejects if rollback fails. Previously, withdrawal only removed the backend type and could finish before pending startup published a terminal.

Published sessions keep their original Agent ownership through backend reloads. Replacement registrations have independent cancellation. Pending owner-local names stay reserved until their startup settles.

## Migration

1. Update stored backend disposer types to `() => Promise<void>` and await explicit calls before releasing dependencies. Contributions registered through a plugin context remain owned and awaited by Cordis.
2. Honor the backend spawn signal during unpublished setup. Settle setup only after owned rollback completes, and report cleanup failure through the existing terminal error paths.
3. Verify withdrawal during startup refuses publication, stops its native process and waits for rollback. Also verify an already-published session survives backend reload until its Agent closes it.
