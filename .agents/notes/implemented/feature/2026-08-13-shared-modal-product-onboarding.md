# Agent Note: Shared-modal product onboarding

Status: implemented

English | [中文](2026-08-13-shared-modal-product-onboarding.zh.md)

## Problem

First-run onboarding mixed two interaction models: a viewport takeover for product context and a credential prompt that redirected users into Settings before they could enter a key. That made a short, ordered flow feel like two unrelated surfaces and left onboarding UI ownership split across packages. The product still needs a versioned testing-stage notice before provider setup, but restoring it must not add a second independent overlay or change the Host settings and credential boundaries.

## Decision

**One existing client Cordis plugin owns the shipped onboarding step.** `ui-settings-models` registers `deepseek-official` at order `0` in `settings.onboarding`. The shell continues to mount only the first incomplete entry, so dialogs cannot stack. No additional client package or plugin row is introduced. The earlier `welcome-notice` occupant is absent; [removing the internal testing notice](../simplification/2026-08-18-remove-internal-testing-notice.md) owns that deletion.

**Both the remaining credential step and any future registrant share one modal component.** `OnboardingModal` wraps the existing ui-primitives `Modal`, supplies the common title and content geometry, and owns `#root` inert for exactly the visible lifetime. Escape and mask clicks do not silently complete mandatory onboarding; each step exposes only its explicit actions. A step still loading private facts returns `null`, so it paints and blocks nothing.

**The Host `ui-onboarding` namespace remains registered.** Stored documents may still carry `welcomeNoticeVersion`. No GUI step reads or writes that field; [removing the internal testing notice](../simplification/2026-08-18-remove-internal-testing-notice.md) owns that rule. The Host privileged-method fence still requires a loopback `Host` header. No Host schema, API-proxy allowlist, or persistence implementation changes.

**The credential dialog reuses the existing editor and write boundary.** The Models join still decides whether any provider is usable. When the official DeepSeek reference is writable and missing, `ProviderEditor` renders in credential-only mode inside the shared modal. It validates the key and calls the existing `credentials.set`; it does not mutate provider settings. Save and continue waits for the write and refreshed readiness, while Configure later completes only the current coordinator pass.

## Alternatives considered

**Separate client plugins for the notice and credential steps.** Rejected because the product asks for one client Cordis plugin and the two surfaces share copy, ordering, modal chrome, and invalidation ownership.

**Move acknowledgement or credential logic into a new Host API.** Rejected because both backend contracts already express the required state and writes. A new endpoint would widen scope without changing user capability.

**Keep the credential step as navigation into Models.** Rejected because the key is the only required first-run field, and the existing editor can expose that write safely without sending the user through a second dialog.

**Keep the former full-viewport stage.** Rejected because the requested onboarding is a pair of dialogs over the current app, and the common ui-primitives modal already provides the appropriate portal, mask, and accessibility contract.

## Consequences

A fresh loopback profile sees an inline DeepSeek key dialog only when no provider is usable. Secrets remain write-only in `.credentials.yaml`, and already-ready or unsupported deployments render no onboarding chrome while readiness loads. The Models package owns product-onboarding presentation as well as provider configuration. The concise testing-stage notice this decision restored is absent; [removing the internal testing notice](../simplification/2026-08-18-remove-internal-testing-notice.md) owns that deletion and does not restore the historical telemetry copy or takeover layout from the [full-viewport beta notice removal](../simplification/2026-08-13-remove-first-run-beta-notice.md).
