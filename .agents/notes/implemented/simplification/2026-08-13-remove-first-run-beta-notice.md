# Agent Note: Remove the first-run beta notice

Status: implemented

English | [中文](2026-08-13-remove-first-run-beta-notice.zh.md)

## Problem

Every GUI first launch opened with a full-viewport internal-test statement (内测声明): internal-beta framing plus instructions for enabling Session Log upload through `DSH_TELEMETRY_MODE`. Session telemetry already resolves to `DISABLED` when its mode is unset ([telemetry default-off](../feature/2026-08-10-telemetry-default-off.md)), so the only onboarding content about telemetry was a prompt explaining how to turn it on, and the internal-test framing itself must not ship in a release build.

## Decision

This decision removed the first-run notice from the assembled product rather than rewording it. `ui-settings-general` seated no `settings.onboarding` step; the notice component, acknowledgement store, copy owner, and locale keys were deleted, while the Host kept the `ui-onboarding` namespace so stored documents remained valid. The later [shared-modal product onboarding](../feature/2026-08-13-shared-modal-product-onboarding.md) restored a concise testing-stage notice in `ui-settings-models`; [removing the internal testing notice](2026-08-18-remove-internal-testing-notice.md) deletes that restoration. Telemetry opt-in remains an explicit deployment environment choice documented in the [CLI reference README](../../../../apps/cli/reference/README.md).

## Alternatives considered

**Keep the notice and only drop its telemetry paragraph.** Rejected: the internal-test framing is what a release must not present, and a mandatory first-run interstitial with no material statement left is pure friction.

**Ask for upload consent instead (a versioned consent step).** Rejected for this release: a first-run question about enabling upload is still a telemetry prompt. A future consent flow can register through the unchanged `settings.onboarding` seam and use a fresh versioned field for re-acknowledgement.

**Deregister the `ui-onboarding` namespace as well.** Rejected: existing settings documents already carry the section, and the settings seam validates stored documents against registered namespaces; keeping the registration keeps those documents valid at no cost.

## Consequences

This removal eliminated the full-viewport notice and its telemetry copy. The later modal restoration is itself absent; [removing the internal testing notice](2026-08-18-remove-internal-testing-notice.md) owns that deletion. The historical telemetry prompt remains absent.
