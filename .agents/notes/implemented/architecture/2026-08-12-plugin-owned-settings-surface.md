# Agent Note: Plugin-owned settings with project isolation

Status: implemented

English | [中文](2026-08-12-plugin-owned-settings-surface.zh.md)

## Problem

A plugin could register a settings namespace but could not put that configuration on the browser settings page without edits to `packages/host/apiproxy`. The proxy filtered reads and writes through hardcoded namespace lists, so an otherwise valid registration outside those lists answered `settings-not-exposed`.

The Plugins section also registered `settings.plugin.item` as an unkeyed list. A card carried an opaque id rather than the namespace it edited, so the section could not derive which Host registrations had a browser owner, suppress cards for uncomposed plugins before rendering, or compute its empty state from visible cards.

This repository also serves shared project runtimes. A project participant must not gain visibility into arbitrary personal or third-party plugin configuration merely because the Host process registered a namespace. The single-user behavior therefore cannot be applied to every collaboration authority unchanged.

## Decision

**A personal settings registration is exposed to the personal configuration client.** In personal scope, `settings.describe` returns every descriptor from `ctx.settings.describe({ redactSecrets: true })`, and `settings.update`, `replace`, and `mutate` address any registered namespace. The proxy no longer owns `WEB_SETTINGS_NAMESPACES`, a provider-directory admission check, or the `settings-not-exposed` error. Malformed and unregistered names use the settings service's `settings-rejected` response.

**Shared project settings remain read-only and filtered.** In project scope, `settings.describe` returns only registered configurable-provider namespaces, product settings, and the explicit non-model namespaces approved for the shared runtime. Arbitrary third-party namespaces are omitted. `writable` and `hasDocument` are false, while every settings write and document-open operation is rejected by `authorizePersonalConfiguration()`. This preserves plugin-owned configuration for the personal owner without expanding what project members may inspect or mutate.

**The settings service definition carries no browser metadata.** Client visibility and page ownership belong to the consumers. `SettingsRegisterOptions` does not gain page names, labels, or exposure flags.

**`settings.plugin.item` is keyed by settings namespace.** A browser plugin registers its card with `key` equal to the namespace it edits. The Plugins section's configurable tab declares the keyed slot and owns the card list; a card owns its own chrome, controls, copy, staging, and write behavior.

**The tab renders the intersection of two registries.** Its controller reads `settings.describe`, retains the namespaces visible to the current authority, and intersects them with current keyed card registrations. It refreshes after `settings/document-updated`, connection reset, or a card-ledger change. A served namespace without a card belongs to another page or has no browser half and renders nothing; a card whose namespace is not served is never dispatched.

**The tab has no schema-generated fallback.** Absence of a keyed card is the complete rendering decision. The browser does not invent controls, validation, or presentation from a namespace schema it does not own.

## Security properties

All configuration methods retain the carrier's loopback and same-origin restriction. Secret-role fields remain removed from resolved, base, and user values before serialization. Project filtering is an additional multi-user confidentiality rule, not a replacement for transport admission or field redaction.

The project filter is intentionally narrower than personal registration exposure. A deployment that wants a third-party namespace available to project members must make that a reviewed product decision and add it to the project-visible set; registration alone is insufficient.

## Alternatives considered

**Expose every registered namespace in project scope.** Rejected because project participants share a Host runtime but do not own every plugin's personal configuration. Read-only responses would still disclose endpoints, paths, feature flags, or other non-secret fields.

**Add browser exposure metadata to `settings.register()`.** Rejected because page names, labels, and rendering ownership are client concerns. It would also split one namespace registration across validation and presentation responsibilities that evolve independently.

**Add a second exposure registry beside settings registration.** Rejected because the two registrations could drift, leaving a valid settings section inaccessible without any owner able to detect the missing catalog entry locally.

**Generate a generic card from the serialized schema.** Rejected because the schema does not define usable layout, copy, credential handling, staged-save behavior, or every semantic validation rule. A plugin that ships a browser half can provide the correct controls.

**Keep a list slot and add a namespace option.** Rejected because the tab would still enumerate cards rather than visible namespaces, preserving the empty-state error and requiring each unserved card to suppress itself.

## Consequences

An external plugin can become configurable in a personal settings page without a patch to this repository: its Host half registers a namespace and its browser half registers a card under the same key. The [settings-card cookbook](../../../../docs/cookbook/adding-a-settings-card.md) defines the required packaging and verification path.

Project members continue to see only the approved read-only settings subset. The deliberate divergence between personal and project scope is covered in `api-proxy-config.spec.ts`; removing the filter or making project settings writable changes the collaboration security model and requires a new decision.

Cards appear in registration order. Registration order is stable for cards installed together but is not a cross-package ordering guarantee. A namespace registered after the tab's Host read appears after the next settings-document update or reconnect because the wire has no namespace-registration event.

Serving arbitrary personal namespaces increases the importance of fail-closed wire redaction. A secret reachable only through a schema construct the redactor cannot inspect remains a known gap; the proxy must eventually refuse descriptors it cannot prove safe to serialize. An assembled fixture plugin covering Host registration, client-card registration, save, and effective runtime use also remains required beyond the separate unit coverage of both halves.
