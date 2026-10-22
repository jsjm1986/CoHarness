# Agent Note: Settings pages as companion packages

Status: implemented

English | [中文](2026-09-17-settings-pages-as-companion-packages.zh.md)

## Problem

The four official settings pages — shell, agent loop, Subagent, web search — lived in one client package, `ui-settings-plugins`, beside the Built-in plugins section. Every new built-in page grew that package, and a community bundle that wanted a settings page had no worked example of a page living with the plugin that owns the namespace. Moving each page into the Host package that registers its namespace was considered and does not fit: the shell namespace is registered by the executor families under the sandbox row, the loop package would gain a browser build for one number field, and the Subagent namespaces are registered from a subpath row, which carries no browser half.

## Decision

**A community plugin's settings page lives in its own package's browser half.** It registers into `plugins.bundle.config` or `plugins.row.config`, owns its copy and styles, and reads and writes through `ctx.settingsScope`. Its i18n is the client locale service, as the shipped community bundles already do.

**The shipped built-in cards live in `ui-settings-plugins`.** [The single-entry change](../simplification/2026-10-09-plugins-page-single-entry.md) folded the companion packages back into one, and [the patch-row binding](../feature/2026-10-23-plugins-item-patch-row-binding.md) keys each `plugins.item` entry on the row its feature runs as. Host packages stay free of browser code; the namespace a card edits is spelled as a literal, never imported from the owner.

**The form machinery moves to `ui-primitives`.** `SettingsFormModel` with `settingsNumberField` and `settingsTextField`, `SettingsValueField` and `SettingsSecretField`, and the `SettingsForm` frame are the kit every page renders with; the frame takes its copy as `labels` and the model takes a structural scope, so the baseline package depends on neither a plugin nor its dictionary.

**`settingsScope.whileServed(namespaces, register)` remains the service rule for served-namespace gating.** The service watches the shared describe mirror, runs the registration when a namespace appears, and disposes it when none is served. The shipped cards no longer use it — they register unconditionally under the patch-row binding above.

**`ui-settings-plugins` owns the shipped built-in cards:** six `plugins.item` entries keyed on their patch rows, per the binding note above.

## Alternatives considered

**A schema-driven generic form.** Rejected: a generic renderer covers scalar fields and stops at the first dynamic control — the Subagent page's live model catalogue, its cross-field rule, its one-mutation save — and every exception would become a role the schema is not for. Every page is code; a community plugin that ships no page has none.

**Dual-face Host packages for the built-in pages.** Rejected for the reasons above; the companion keeps the option open for a package that can carry a half.

**Copy for the form frame in one shared dictionary.** Rejected: it would couple every page to another plugin's dictionary keys; each page's dictionary carries the few frame strings.

## Consequences

- The Plugins page lists the built-in feature cards in their declared order from one package; the bound cards' switches and the renamed groups moved the page goldens with them.
- The cookbook [adding a settings page](../../../../docs/cookbook/adding-a-settings-card.md) shows the community path and names the companion template.
- The client module system's rule stands: a browser half rides the Loader row whose specifier is the bare package name, so a bundle split into subpath rows keeps every page it registers on its root row.
- The shell feature's `plugins.item` ids are `bash-sandbox` and `pwsh-sandbox` — the patch rows, not a settings namespace: `subject.id` on an official page is the discriminator `plugins.detail.*` contributions key on, so the id names the row the card switches.

## Testing

`ui-settings-plugins`' `tests/apply.client.spec.ts` pins the six unconditional patch-row registrations and collapses every contribution on teardown; the card and controller specs carry each page's behavior. The settings-form specs in `ui-primitives` pin the kit, and the while-served spec in `ui-settings` pins the service rule the shipped cards no longer use. `apps/web/tests/plugin-config.e2e.ts` exercises the shell and Subagent pages over the real wire.
