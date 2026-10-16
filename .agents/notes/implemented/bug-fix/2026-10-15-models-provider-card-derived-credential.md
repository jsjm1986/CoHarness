# Agent Note: The provider-card seat's `keyConfigured` follows the reference the page would use

Status: implemented

English | [中文](2026-10-15-models-provider-card-derived-credential.zh.md)

## Problem

The `settings.models.provider-card` seat reported `keyConfigured` only from `ProviderRow.credential` — the join of the profile's named `apiKeyEnv`. A dormant or keyless row names no reference, so the seat always reported false for exactly the rows where the page's own editor would resolve its derived `<ROUTE>_API_KEY` (or the scope-prefixed `DSH_`/`DSH_PROJECT_<id>_` variant). The add-provider draft could therefore tell an extension slot "no key configured" while its own editor displays the conventional credential as configured. Direct `ModelsSection` renders could also compile without `renderSlot`, silently mounting nothing where a child seat belongs.

## Decision

The store's credential describe now covers two reference families in one batched call: every named `apiKeyEnv`, and for each keyless row the derived reference under the ownership scope the directory entry itself declares — `deriveKeyRef(provider, entry.management, entry.projectId)`. `external` routes owe this page no credential and contribute nothing; a project route without its project id contributes nothing either. The join publishes the second family as `ProviderRow.derivedCredential`, present only while the profile names no reference. `keyConfiguredOf` picks the same reference the row's editor resolves — named first, derived otherwise — so the seat, the draft, and the editor can no longer disagree. `ModelsSectionProps` makes `renderSlot` required: the renderer binds it at the render call, and a direct render that forgets it fails to compile instead of mounting nothing.

## Alternatives considered

**Keep describing named references only.** The seat then permanently disagrees with the editor on every dormant and keyless row — the exact rows the add-provider flow exists for.

**Derive credentials at render time.** Rendering knows the page scope but cannot ask the wire; the store must describe a reference before any component can read its state, so the describe and the join belong to the load.

## Consequences

The credential describe may name more references than before — dormant rows each contribute their scope-appropriate derived reference — while remaining one batched call. Rows whose profile names a reference are unchanged: `credential` still tracks `apiKeyEnv`, and the missing-key dot still follows the named fact alone. Extension slots now see the seat fact the page itself acts on, for configured, setup, and add-provider cards alike.

## Verification

`store.client.spec.ts` — the join test asserts one batched describe over named plus scope-derived references (external contributes none), and a dormant row exposes its described `derivedCredential`. `components.client.spec.tsx` — the draft-seat case mounts the real join, opens the add-provider card, and asserts the seat reports `keyConfigured: true` for the dormant route whose derived `<ROUTE>_API_KEY` is configured. Direct-render sites across the component and provider-form specs compile against the required `renderSlot`. 264 package tests, client typecheck, and lint pass.

## Related

- [Models settings extension slots](../architecture/2026-08-30-models-settings-extension-slots.md) — the slot contract note whose `keyConfigured` fact semantics this change updated in place.
