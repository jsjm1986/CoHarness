# Agent Note: Expose additive Models settings extension slots

Status: implemented

English | [中文](2026-08-30-models-settings-extension-slots.zh.md)

## Problem

Provider-specific sign-in or status controls had to edit the Models section or depend on its editor implementation. That couples independently shipped provider plugins to the page's ACL, credential joins, and layout.

## Decision

`ui-settings-models` declares two additive child slots: keyed `settings.models.provider-card`, keyed by the provider settings namespace and supplied with the redacted provider entry plus configured/keyConfigured facts, and ordered `settings.models.footer`, which carries no mutable page state. The Models section renders these slots for setup, configured, and add-provider cards and after the add controls. The section remains the sole owner of provider identity, authorization, and settings/credential writes; slot owners receive data-only props and register through normal slot effects.

## Alternatives considered

**Let extensions import and wrap `ModelsSection`.** Rejected because wrappers replace page ownership and can duplicate ACL, loading, or write behavior.

**Expose the full settings store to each provider plugin.** Rejected because it would leak redacted joins and mutation authority beyond the page owner.

**Create a separate slot for every provider family.** Rejected because the settings namespace is the stable owner key and keeps the contract open to hand-declared routes.

## Consequences

Provider companions can add controls without a package split or page fork. Missing occupants render nothing, and a disposed Models declaration removes the child seats with it. The slot contract does not grant secret values or write access; extensions must call their owning transport through their own capability seam.

## Testing

Models apply and component tests assert the child declarations, provider owner facts, keyed dispatch for configured rows, and footer dispatch while preserving the existing personal/project settings behavior.
