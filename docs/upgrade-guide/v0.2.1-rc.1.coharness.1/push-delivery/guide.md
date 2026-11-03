---
kind: upgrade-guide
description: "Completion notifications retain current recipients and retry ownership with bounded provider attempts."
---

# Upgrade completion notification admission

English | [中文](guide.zh.md)

## Change

Device registration and removal require the authenticated account's current active organization and membership. Completion delivery additionally requires current inherited conversation access and device ownership. Withdrawn recipients are skipped. Personal roots and children remain owner-private and require the exact Runtime assignment and source computer use grant; another allowed computer cannot substitute for that grant. Missing or retired Runtime assignments are skipped.

Fresh pending and sent delivery claims suppress another send. Failed claims and expired pending claims may retry. Attempt settlement and invalid-registration deletion preserve newer attempts and transferred devices. FCM initialization can recover after credential repair. Provider work releases the database connection and has a finite deadline.

An unconfigured provider records failure and preserves its registration. A later callback with provider configuration can retry the same completed event; no successful claim is fabricated.

## Migration

1. Upgrade the complete Gateway build. Device API fields and database schemas need no migration. Confirm a personal Session's notification stops after its source computer permission is withdrawn, even when another computer remains allowed; account-wide device registration remains available.
2. Optionally set positive `HGW_PUSH_DELIVERY_TIMEOUT_MS` (default `30000`) and `HGW_PUSH_DELIVERY_LEASE_MS` (default `120000`). The lease must exceed the timeout; invalid values fail startup.
3. Allow for remote acceptance before a lost response: a later retry may duplicate a notification. Failed and expired claims require another callback; no background worker is added. See [delivery ownership](../../../../.agents/notes/implemented/bug-fix/2026-10-29-push-delivery-authority.md).
