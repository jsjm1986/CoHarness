# dsh-client-ui-settings-plugins

English | [中文](README.zh.md)

The **Plugins** settings section and its **Plugin configuration** tab. The section owns the heading and compact tab chrome; feature plugins contribute pages through `settings.plugins.tab`. This package's own tab shows one expandable card per Host plugin whose configuration a user owns. A card shows the plugin's name and what it governs; expanding it in place reveals hand-written controls bound to that plugin's settings namespace, each field marking whether the user overrode it and offering a reset back to the value the deployment composed.

## What appears here

A card renders only when its namespace is both served to the current settings authority and registered under the matching slot key. The tab reads the Host namespace directory and intersects it with the card ledger, so an uncomposed plugin leaves no trace, a namespace owned by another page renders nothing here, and the empty line waits until the first Host answer. Personal scope receives every registered namespace; shared project scope receives only its approved read-only subset.

The cards this package ships cover the shell executor (`shell`), the agent loop's tool-call parallelism (`agent-loop`), and the DeepSeek search provider (`web-search-deepseek`).

## Extension point

The section declares `settings.plugins.tab`, a root list slot whose labels become ordered tabs. It keeps a tab mounted after its first selection, so local drafts and read-only snapshots survive tab switches. The package registers its own `configurable` contribution, which declares `settings.plugin.item` as a slot keyed by the settings namespace each card edits. A plugin that ships a browser half registers its card under its namespace and owns its chrome, controls, and copy; the tab pairs Host namespaces with those keys without interpreting either. Tabs follow their contribution `order`; cards follow registration order. The [settings-card cookbook](../../../docs/cookbook/adding-a-settings-card.md) covers the full extension path.

## Writes

A card stages what the user types and writes it only when they save. Each control renders staged text, so what is on screen is exactly what a save would store; **Discard** drops the drafts, and a card holding unsaved edits says so on its header even while collapsed. A reset stages the composed default rather than writing immediately, and a draft the field does not accept blocks the save instead of being dropped.

Saving writes each staged field through the client settings scope, which fences every write with the namespace revision it read, so a form that has drifted from the document is refused rather than overwriting a concurrent change. The Host is the only authority on whether a value was accepted — its validators own the constraints no schema can express — so the card reads the section back afterwards and reports a save that did not land, keeping those drafts for the user to correct.

A key can also be written from another surface — the Models page addresses the same reference — which changes no settings section, so the card re-reads on the forwarded `credentials/updated` event for the reference it watches.

A field's presence in the raw user layer — not its value — is what marks it overridden; a reset clears that field so it re-inherits the composition layer. Secret-role fields never ride a response, so a key control starts blank, reports only whether one is configured, and writes through the credentials domain rather than the settings section; a blank draft writes nothing and keeps the stored key.

## Model Experience

None, as the section renders a browser configuration UI; the values it writes reach a model only through the plugins that own them, each documenting that effect itself.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Only host-plane plugins appear** — a plugin an agent preset mounts carries its configuration inline in that preset's `agent.cordis.yml` and cannot register a settings namespace at all (a second session mounting the same preset would fail on a duplicate registration), so this section lists nothing for it. Editing those values remains the preset editor's job.
- **External cards are personal-scope configuration** — personal settings serve every registered namespace, while shared project settings expose only an approved read-only subset. A third-party card appears for the personal owner but not for project participants unless the project-visible set explicitly admits its namespace ([rationale](../../../.agents/notes/implemented/architecture/2026-08-12-plugin-owned-settings-surface.md)).
- **A card still needs a browser bundle** — the browser half must be a `dsh.client` package built in the client module system's lazy-CJS factory format. The `clientBundle` preset is not published, and the bundle-purity check forbids importing this package's card chrome or form model as values, so an external card owns its own build, staging, and revision fencing.
- **Namespace registrations have no dedicated invalidation event** — the tab re-reads after settings-document updates and connection resets. A namespace registered after its initial read appears after the next such signal; a card registered late is added immediately from the slot ledger.
- **The shell card follows the composed executor** — the POSIX and PowerShell executor families share the `shell` namespace because a host composes exactly one of them, so the served schema differs by platform (PowerShell adds `pwshPath`) even though the card edits the same two fields on both, and a deployment composing neither shows no card.
