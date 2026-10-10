---
description: "Official plugin configuration items on the Plugins page, one page per configurable host-plane namespace"
kind: "package-reference"
---

# dsh-client-ui-settings-plugins

English | [中文](README.zh.md)

The official **configuration items** on the sidebar's Plugins page: one `plugins.item` entry per host-plane settings namespace this package owns. The item's card sits in the page's **Configuration** group with a one-line summary, and opening it shows that plugin's settings form on the item's own page — hand-written controls bound to the namespace, each field marking whether the user overrode it and offering a reset back to the value the deployment composed. Install, removal, and enablement live in the same page's other groups, so the Plugins page is the single user-facing entry for both.

## Summary

Use the sidebar's **Plugins** page to inspect and manage the plugins this deployment ships, and its **Configuration** group to configure the host-plane plugins that expose settings. Each configuration page shows which values the user overrode, lets them reset those to deployment defaults, keeps edits local until save, and drops them when the page is left. If the configuration changed after the page loaded, the save is rejected instead of overwriting the newer values.

## Table of Contents

- [What appears here](#what-appears-here)
- [Extension point](#extension-point)
- [Writes](#writes)
- [Invariants](#invariants)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="what-appears-here"></a>
## What appears here

The Plugins page's Configuration group renders the intersection of two ledgers: the `plugins.item` entries composed clients registered, and the settings namespaces the Host serves. A served namespace no item claims renders nothing — another surface owns it, or this deployment ships no browser half for it — and an item whose namespace this deployment does not serve is filtered out, so an uncomposed plugin leaves no empty shell. Cards follow registration order, which is stable for the items one package installs together and not stable across plugins: apply order between packages is unconstrained.

The items cover the shell executor (`shell`), tool-call parallelism (`agent-loop`), delegation depth and capacity (`subagent`), exact model routes (`subagent-model-selection`), and the DeepSeek search provider (`web-search-deepseek`). Delegation controls retain the upstream integer validation, reset and explanatory help. Depth zero disables tools that inherit this setting; explicit tool depth takes precedence. Capacity counts live descendants of the same root Agent across all depths, excluding the root itself.

In a project scope these pages expose only namespaces whose Host registration declares `owner: project` and `projectWrite: manager`. The project owner and organization administrators can save those shared runtime values; other members see the form and an inline owner explanation but no write request is sent. Account, organization, deployment, and model-provider settings stay on their owning surfaces.

The model-selection form starts disabled, joins live routes with removable saved routes, and saves its switch and allowlist atomically at the draft revision. A changed revision requires discarding the stale draft. Catalog failures preserve choices; reconnects clear target-specific drafts. Settings affect newly composed Sessions and never grant access beyond runtime model governance.

<a id="extension-point"></a>
## Extension point

The package registers one `plugins.item` entry per namespace it owns, keyed on the settings namespace a form edits; the slot belongs to ui-plugin-manager, which asks each item for `view: 'summary'` on the card and `view: 'page'` on the item's own page. A plugin that ships a browser half registers its own item under its own namespace and owns every part of it: controls, copy, and chrome below the page's title. Keying on the namespace is what lets a plugin distributed outside this repository appear here — it registers the namespace on the Host and the item in the browser, and the group pairs the two without learning what the namespace means.

<a id="writes"></a>
## Writes

A form stages what the user types and writes it only when they save. Each control renders staged text, so what is on screen is exactly what a save would store; **Discard** drops the drafts. A reset stages the composed default rather than writing immediately, and a draft the field does not accept blocks the save instead of being dropped.

Saving writes each staged field through the client settings scope, which fences every write with the namespace revision it read. A refusal, lost write access or transport failure stops the remaining writes and retains unacknowledged drafts. Accepted fields clear only the draft submitted by that save; edits made while it was in flight remain unsaved. A multi-field save can partly succeed and does not claim transactional rollback.

A key can also be written from another surface — the Models page addresses the same reference — which changes no settings section, so the form re-reads on the forwarded `credentials/reference-updated` event for the reference it watches.

A field's presence in the raw user layer — not its value — is what marks it overridden; a reset clears that field so it re-inherits the composition layer. Secret-role fields never ride a response, so a key control starts blank, reports only whether one is configured, and writes through the credentials domain rather than the settings section; a blank draft writes nothing and keeps the stored key. A replacement requires its own successful write response: the presence of an older key cannot acknowledge it. Credential reads reject superseded responses even when the reference is unchanged.

<a id="invariants"></a>
## Invariants

**Runtime invariant:** No companion is published. Plugin configuration values live in the Host plugin settings namespaces; the package contributes item registrations and per-field bindings over that remote document.

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side settings surface that registers no model surface.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Only host-plane plugins appear** — a plugin an agent preset mounts carries its configuration inline in that preset's `agent.cordis.yml` and cannot register a settings namespace at all (a second session mounting the same preset would fail on a duplicate registration), so the Configuration group lists nothing for it. Editing those values remains the preset editor's job.
- **An item still needs a browser bundle** — the browser half must be a `dsh.client` package built in the client module system's lazy-CJS factory format, and the `clientBundle` preset that emits it lives in `packages/client/tsdown.client.ts` rather than a published package, so a plugin outside this repository has to reproduce that build itself. The bundle-purity gate also forbids importing this package's form chrome or model as values, so such an item owns its own staging and revision fencing.
- **The served namespaces re-read on two signals only** — the wire announces settings-document commits and connection resets, not registrations, so a namespace whose owner registers after the group's read joins the list on the next document commit or reconnect.
- **The shell item follows the composed executor** — the POSIX and PowerShell executor families share the `bash` namespace because a host composes exactly one of them, so the served schema differs by platform (PowerShell adds `pwshPath`) even though the form edits the same two fields on both, and a deployment composing neither shows no item.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
