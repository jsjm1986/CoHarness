# Agent Note: Account-qualified permission pickers

Status: implemented

English | [中文](2026-09-22-account-qualified-permission-pickers.zh.md)

## Problem

A process-wide permission catalog describes Host capability, not the current account's qualification. Showing every preset as selectable lets a non-administrator request Full or an ineligible account request Auto, and retained account data can keep those choices visible after refresh failure. A workbench pane must not borrow a different runtime's local-deployment status.

## Decision

The existing collaboration context carries explicit Full and Auto qualifications. Its verification state is withdrawn during refresh and connection replacement; old HTTP responses cannot publish into a newer generation. The existing runtime UI policy publishes only the derived account qualification. Each Session binding carries its own connection description, whose explicit managed marker distinguishes independent local operation from unknown state. The shared selector combines these sources without changing or copying the Host catalog.

The composer, `/permission` popup, and new-session default row disable unavailable choices with localized explanations and recheck before dispatch. A selected but unavailable Auto mode remains selected, with a prompt to choose a standard mode. Auto is session-only: the default schema excludes it and the default UI controller also rejects it. The [Full access consent dialog](../feature/2026-07-31-gui-full-access-confirmation.md) remains necessary for eligible Full selections; consent does not establish authorization.

A popup may subscribe to invalidation of its own option source. It closes when that source changes, releases the subscription on every completion path, and leaves unrelated command popups open. Connection-specific sources keep separately staged targets independent.

## Alternatives considered

**Filter the shared Host catalog by the most recent account request.** Rejected because other accounts and Sessions share the process capability table.

**Infer local authority from an HTTP error or loopback address.** Rejected because Gateway deployments can use loopback and can temporarily return 401, 503, or invalid data. Only the owning Host's explicit standalone marker permits local behavior.

**Silently replace Auto after qualification is lost.** Rejected because it mutates Session policy without a user decision and hides the state the server actually enforces.

## Consequences

Ordinary choices remain available under their existing write policy. Full and Auto may temporarily be unavailable while verification catches up; stale menus cannot submit those choices. The Host and Gateway own final authorization; UI coverage does not establish their default-setting write checks.

Component and source tests cover field decoding, failed refresh, obsolete responses, account qualification, target ownership, stale confirmation, disabled options, and popup cleanup. The combined browser and built-artifact validation remains part of integration closeout; this note does not establish completion of the upstream upgrade.
