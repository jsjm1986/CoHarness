# Agent Note: Slot-based Session row actions and the sidebar archive filter

Status: implemented

English | [中文](2026-10-03-sidebar-session-actions-archive-filter.zh.md)

## Problem

The Workspace browser hard-coded its row actions (pin, rename, fork, archive) inside `Rows.tsx` and owned the rename dialog in `WorkspaceBrowser.tsx`; upstream `dsh-v0.2.0-rc.2` moved the same actions to plugin-registered slot occupants and the dialogs/toasts to `shell.overlay`, and folded archived-Session management into the browser's view options. The fork's sidebar lacked the archive filter, the stop-and-archive confirmation, and the third-party action seam, and archived Sessions were restorable only from the Settings page.

## Decision

**Port the upstream session-actions architecture onto the fork's slot injection.**

- `sidebar.workspaces.session.menu.item` and `sidebar.workspaces.session.row.action` are root-scoped list slots declared by the browser's own registration; the shipped rows (pin 100, rename 200, fork 300, archive 400) register under `order`, and independent packages register into the same lists with `priority` for shadowing. Menu items receive the row's open state through `menuOpenStateFactory`, which binds the render-occurrence `hookContext` into each entry's `useMenuOpenState` hook so a selection can close its menu.
- The rename dialog, the archive confirmation, and the row toast are `shell.overlay` occupants backed by plugin-private snapshot stores (`renameRequest`, `archiveRequest`, `rowToast`); the toast shares the browser's view-store instance so its "show archived" action writes the same filter the browser reads.
- `Menu` learned component children (`MenuItemButton` rows with the data-row markup) and decides the post-selection focus return once in a delegated list-level click handler, covering data rows and component rows alike.
- Archive surfaces a three-state `archivedFilter` (`default`/`show`/`only`) in `ViewOptionsMenu`, and the Workspace directory-tree grouping (`groupBy: 'workspace-tree'`) nests Workspaces under their nearest registered ancestor via `owningParentFolder`, with `usePanelInfo` suppressing the current-row highlight while a main panel is active.
- `workspace.archiveSession` accepts `{ stopActivity }`; failures raise `WorkspaceArchiveError`, whose `rpcError.code === 'session-active'` + `details.activity` drives the stop-and-archive confirmation dialog instead of a silent refusal. Consumers match on `name`, not `instanceof`, because client bundles do not share class identity.

## Alternatives considered

- **Retire `ui-settings-unarchive-sessions` with the filter shipped.** Rejected by owner decision: the Settings page stays as a second entry, and the upstream-alignment matrix keeps its `owned` record.
- **Copy upstream's `dsh-api-*-controller` type packages.** Rejected: the fork's `dsh-client-runtime` faces already carry the same contracts, so the port remaps imports instead of vendoring the type packages.
- **Per-item `onSelect` focus return for component rows.** Rejected: a delegated handler on the list observes every row activation in one place and cannot drift from the data-row path.

## Consequences

The sidebar offers archived filtering, undo/stop-and-archive toasts, and a plugin seam for third-party Session actions; the Settings Archived sessions page remains as a second restore surface. The earlier [session-unarchive-restore-surface](2026-09-25-session-unarchive-restore-surface.md) note rejected row-menu unarchive under "no row to hang the action on" — the filter now renders those rows, so that alternative is superseded while its Settings-page decision stays shipped. The `session-active` refusal is no longer silent: it names the running work and offers to stop it.
