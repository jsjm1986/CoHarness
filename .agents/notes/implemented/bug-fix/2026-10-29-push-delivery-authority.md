# Agent Note: Push delivery retains recipient and attempt ownership

Status: implemented

English | [中文](2026-10-29-push-delivery-authority.zh.md)

## Problem

Parallel notification callbacks can both claim a pending delivery. Captured device tokens can change account ownership before sending, while disabled accounts or withdrawn project readers still receive notifications. A late provider failure can overwrite a newer attempt or remove a device now owned by another account. Rejected credential initialization promises can prevent recovery after configuration repair.

## Decision

[Device registration and delivery admission](../../../../gateway/src/push-notifications.ts) retain the [active account](../../../../gateway/src/postgres/account-authority.ts) through their transaction. Claims recheck inherited conversation visibility, active project read access, assigned computer permission and the device's current account, token and provider. Personal roots and children require their owner's identity even for administrators, the exact root Runtime assignment, and that computer's current use grant. Another allowed computer cannot authorize the Session; missing or retired assignments are ineligible. Admission retains the assignment and grant through claim commit, before a conflicting withdrawal commits; network work starts after database release. Device registration and account preferences remain account-wide.

The existing delivery key admits a failed claim or an expired pending claim; a sent or fresh pending claim is skipped. The incremented attempt number fences settlement and invalid-registration cleanup. Cleanup additionally matches the captured account, token and provider, preserving transferred registrations. Provider preparation and HTTP share one configured deadline. The pending lease exceeds that deadline and permits recovery when a process disappears. An uncertain remote acceptance can still cause duplicate delivery after retry.

Only successful FCM credential and client initialization remain cached. A rejected initialization clears its own cached promise, preserving any successor. Repairing configuration allows the same sender to retry. Confirmed provider acceptance remains successful if response-body disposal reports a secondary failure.

An unconfigured provider reports failure without deleting the registration. It cannot establish a sent claim without remote acceptance. A later callback through a configured sender can retry the same event and device.

The [Android shell decision](../feature/2026-08-17-android-remote-web-fcm-notifications.md) retains asynchronous append scheduling and its documented crash window without an outbox worker. [JPush provider selection](../feature/2026-08-18-android-jpush-multi-provider-delivery.md) remains independent of claim ownership.

## Alternatives considered

**Reclaim every pending row.** This permits concurrent senders to duplicate the same completed event.

**Keep account or device locks during provider HTTP.** A slow provider would block revocation and consume database capacity. Admission retains authority only until a claim commits.

**Delete an invalid registration by device id alone.** Device ownership and token values can change while the old attempt is in flight.

## Consequences

Deployment controls the attempt deadline and pending lease through the [Gateway configuration](../../../../gateway/README.md). Existing database columns and device API fields remain sufficient. Sent claims are durable deduplication records; failed and expired claims are retryable when another notification callback occurs. No background retry or remote exactly-once guarantee is added.

## Verification

PostgreSQL barriers exercise duplicate claims, ownership transfer, withdrawn eligibility, retained computer permission, expired claims and stale settlement. A one-connection pool remains usable while the local HTTP provider waits. Runnable Gateway HTTP replay proves committed completed-event delivery, duplicate suppression and non-completed filtering. Its local provider also observes personal root and child delivery, source-grant revocation, deletion, restoration and Runtime retirement while another computer remains allowed. Credential repair tests use synthetic files and local authentication doubles; real cloud delivery requires separate deployment verification.
