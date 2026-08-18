# Agent Note: Remove the internal testing notice

Status: implemented

English | [中文](2026-08-18-remove-internal-testing-notice.zh.md)

## Problem

First GUI launch still opened with the versioned 内测声明 modal (`welcome-notice`) before the DeepSeek credential dialog. That interstitial restated that 0.1 is an internal testing build for Harness developers. The product no longer wants that statement on the first-run path.

## Decision

Delete the `welcome-notice` onboarding step from the assembled product. `ui-settings-models` no longer registers it; the component, acknowledgement store, copy owner, locale keys, and dedicated unit, store, and browser tests are gone. The remaining `deepseek-official` step still uses `OnboardingModal` and still appears only when no provider is usable.

Keep the Host `ui-onboarding` namespace and its `welcomeNoticeVersion` field so stored `settings.yaml` documents remain valid. The GUI does not read or write that field. This is the same stored-document reason the earlier [full-viewport notice removal](2026-08-13-remove-first-run-beta-notice.md) kept the registration, and it supersedes the later [shared-modal restoration](../feature/2026-08-13-shared-modal-product-onboarding.md) of a concise testing-stage notice. The Settings shell coordinator in [versioned GUI welcome onboarding](../feature/2026-07-30-versioned-gui-welcome-onboarding.md) is unchanged.

## Alternatives considered

**Reword the notice and keep the modal.** Rejected: the request is complete removal of the declaration, not a copy edit.

**Deregister the `ui-onboarding` namespace as well.** Rejected: existing settings documents already carry the section, and the settings seam validates stored documents against registered namespaces.

**Keep a process-local acknowledgement path with no UI.** Rejected: that would leave dead read/write code for a field no step consumes.

## Consequences

A fresh profile reaches the DeepSeek key dialog only when no provider is usable; otherwise it reaches the app. Values already stored under `welcomeNoticeVersion` are ignored. Remote and loopback browsers no longer differ on this interstitial, because nothing presents it.
