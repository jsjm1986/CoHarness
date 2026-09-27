# @deepseek-ai/dsh-client-ui-settings-unarchive-sessions

English | [中文](README.zh.md)

The **Archived sessions** Settings page: the restore point for sessions hidden from Workspace navigation. The browser plugin registers one localized `settings.section` contribution with id `archived-sessions`, ordered last; the Settings shell owns the navigation entry and section chrome. The page lists each archived session with the Workspace that owns it and its last activity, newest archive first, and offers one Unarchive action per row; a search box filters the list by session title or Workspace name.

Rows are derived from the registry-global archive set joined with the loaded Session summaries, so an archive entry whose session record is gone has no row and no action. The page waits for the Session list before rendering rows; an empty archive, an archive whose entries have no loaded Session to restore, and a query matching no row report three different messages. Every restore goes through `ctx.workspaces.unarchiveSession`, whose echoed archive set updates every surface that filters on it, so the session reappears in the sidebar and search as well. A rejected call is logged as a console diagnostic and leaves the row in place for another attempt. The registration uses `ctx.slots.inject()`, so it follows late section declaration, redeclaration, locale changes, and teardown without importing the section owner.

## Summary

The **Archived sessions** Settings page restores sessions hidden from every grouping surface. It lists the archive set newest-first with each session's owning Workspace (or the ungrouped label) and last activity, searches by title or Workspace, and restores one session per row through the shared Workspace command. Restoring a session returns it to its recorded Workspace position, or to the ungrouped sessions when it belongs to none.

## Invariants

**Runtime invariant:** No companion is published. The page registers one localized `settings.section` contribution and its locale namespace; it emits no Cordis events and owns no cross-plugin mutable relation.

## Model Experience

None, as the package is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Archived sessions without a loaded summary are unaddressable** — the page derives its rows by joining the archive set with the Session list, so a member the list does not carry has no row and no Unarchive action even though the archive set still holds it; a set whose members are all in that state reports itself as unrestorable rather than empty.
- **The page lists sessions only; it offers no session deletion** — archives are reversible through this page, while deleting a session record remains a separate capability.
