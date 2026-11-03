---
kind: upgrade-guide
description: Gateway session cookies use the absolute lifetime for browser retention instead of expiring at the original idle deadline.
---

# Gateway browser session retention

English | [中文](guide.zh.md)

## Change

The `hgw_session` Cookie's `Max-Age` uses `HGW_SESSION_ABS_TTL_MS`, rounded up to whole seconds. `HGW_SESSION_TTL_MS` controls the server's sliding idle deadline. The server also enforces the original absolute deadline on every authentication. Activity can therefore keep a browser session working beyond its first idle interval.

Existing browser cookies retain the expiry they received when issued. Clearing a cookie still emits `Max-Age=0`.

Queued PostgreSQL authentication reads current authority after its session-row wait and rejects either elapsed deadline before renewal. SQLite also refuses tokens exactly at either deadline. Scope cookies round sub-second lifetimes up so a selected project remains available while its login is valid. New logins receive their full configured lifetime after admission; failed-attempt timestamps and lockout windows use the current database clock. Clients use the existing forbidden or unauthorized responses; no database migration is needed for these checks.

## Migration

1. Review `HGW_SESSION_TTL_MS` and `HGW_SESSION_ABS_TTL_MS` in the Gateway environment: their defaults are seven idle days and thirty absolute days.
2. Deploy the updated Gateway. To receive the new browser retention immediately, sign out and sign in again.
3. Confirm that a new `hgw_session` Cookie has the configured absolute retention. An active session can continue beyond its first idle interval; an idle or absolutely expired session must still receive an authentication refusal.
